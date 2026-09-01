# Multi-key provider pools

Run one logical model name backed by many API keys spread across many providers, most of them free tiers with
request caps in the 5 to 8 per minute range, and have two agent harnesses hammer it concurrently without either
of them learning that any of this is happening. No 429 reaches the client while any key still has headroom, a key
that runs out of its minute is skipped and picked back up when the window rolls, and a key that runs out of its day
is skipped for the rest of that day in its own timezone

Requirements, in the words they were given: multiple keys per provider across several providers, rotation between
them, immediate failover on error to another key or another provider without disturbing the one that was working,
a UI for adding providers and keys that remembers what you already typed, and optional per-minute and per-day try
limits that are actually tracked and enforced before a call goes out

## What the fork already does

Most of this is composition. Only two capabilities are genuinely missing

| Requirement | Today |
|---|---|
| Many keys per provider | Works. One `model_list` entry per (key, model); entries sharing `model_name` form a group |
| Rotation | Partial. `simple-shuffle` is weighted-random, so it is neither fair nor quota-aware |
| Instant failover excluding the failed key | Mostly. `enable_weighted_failover` does this, but only for `simple-shuffle`, only async, only at the fallback layer |
| Saved provider profiles plus UI | Mostly. The Credentials feature plus `CredentialsPanel` and `CredentialModal` already store and reuse per-provider auth |
| Per-minute cap | Three overlapping implementations, all `%H-%M` keys with 60s TTL. Enforcement is select-then-reject-then-cooldown rather than skip |
| Per-day cap | Missing. `rpd` does not appear anywhere in `litellm/` |
| Stickiness so prompt caches keep hitting | `DeploymentAffinityCheck` and `PromptCachingDeploymentCheck` both exist. The affinity pin never moves off a dead key |
| Live quota usage in the UI | Missing. No column, no endpoint |
| Wait for capacity instead of 429 | Missing. `Scheduler` looks like it, and is not it (see finding 4) |

## Six findings that shaped the plan

**1. The response cache already survives key rotation; the provider prompt cache does not.**
`Cache._get_model_param_value` (litellm/caching/caching.py:391) keys on `metadata["model_group"]`, and `api_key` and
`api_base` are in `all_litellm_params` so they are excluded from the key entirely. A LiteLLM exact-match cache hit is
therefore indifferent to which key served the original request, and `caching_groups` will even share one cache across
model groups. Provider-side prompt caching is the opposite: the cached prefix lives with the account behind the key, so
every rotation is a cold prefix. That split is what makes stickiness worth building and makes response caching cheap
to turn on

**2. `DualCache.async_increment_cache` is genuinely atomic, but nothing refunds a rejected request.**
It returns the Redis `INCRBYFLOAT` result when Redis is configured and the in-memory result otherwise
(litellm/caching/dual_cache.py:371-411), so increment-first-then-compare has no TOCTOU hole in either deployment shape.
The `rpm` path in `model_rate_limit_check.py:271-294` relies on exactly that. What it does not do is give the slot back
when it rejects, which is invisible at a limit of 10000 and ruinous at a limit of 5. A daily counter with the same bug
inflates past its cap and stays there until midnight. Every increment this plan adds needs a matching refund

**3. One 429 cools a deployment down immediately, for five seconds.**
`_should_cooldown_deployment` returns True on a single 429 as soon as the group has more than one member
(litellm/router_utils/cooldown_handlers.py:386-387), and `DEFAULT_COOLDOWN_TIME_SECONDS` is 5. Worse,
`async_routing_strategy_pre_call_checks` passes `time_to_cooldown=self.cooldown_time` explicitly (router.py:8025-8031),
so a quota rejection raised from `async_pre_call_check` ignores its own `retry-after` header. A key that is out of daily
quota would be retried every five seconds for the rest of the day. Cooldowns are the wrong mechanism for quota, which
is why enforcement below lands primarily in `async_filter_deployments`, where there is no cooldown side effect and the
counter is re-read on every request

**4. `Scheduler` is a priority queue, not a capacity waiter.**
`router_settings.default_priority` does route every request through `_schedule_factory` (router.py:2352, 3872-3933)
with no client change, and it does sleep in a loop until capacity appears, which reads like exactly the feature wanted.
It is not, for three reasons. Its wait condition is `len(healthy_deployments) == 0`, and it gets that list from
`_async_get_healthy_deployments` (router.py:7943-7971), which applies only the cooldown and blocked filters and never
runs `async_callback_filter_deployments`, so a quota-exhausted key still counts as healthy and the loop never waits.
It polls every 3ms, which is 20000 iterations of cooldown-cache reads per minute of waiting, each a Redis round trip
when Redis is configured. And when it does decide to proceed it calls straight through to the same key that is out of
quota. The bounded wait in phase 2 lives in the quota check instead, where the reset time is already known

**5. The 429 the client would see carries a retry-after that only the quota layer can make truthful.**
`RouterRateLimitError` is a plain `ValueError` (litellm/types/router.py:803-816) with no `status_code` and no response
headers. `ProxyException` string-matches "No deployments available" and rewrites the code to 429
(litellm/proxy/_types.py:3749-3750), and `_apply_router_cooldown_retry_after` copies `e.cooldown_time` into the
`retry-after` header (litellm/proxy/common_request_processing.py:3285-3287). That value comes from
`cooldown_cache.get_min_cooldown`, which knows nothing about quota windows. If all keys are out for the day, the number
the harness gets told to wait is a cooldown default. Phase 2 publishes the real earliest-reset so the one 429 that can
still escape is at least honest

**6. The add-model UI already creates one deployment per selected model.**
`handle_add_model_submit.tsx:29-31,209-218` loops `modelMappings` and issues one `POST /model/new` per mapping, and
`/model/new` accepts exactly one `Deployment` per call with no bulk variant
(litellm/proxy/management_endpoints/model_management_endpoints.py:1725-1728). So "enter a key, tick the six models it
supports" already fans out into six deployments today. Phase 5 is therefore mostly quota fields, a prefill affordance,
and a usage view, not a new creation pipeline

## Decisions already settled

Rotation is least-used-first: among eligible keys, prefer the one with the most remaining headroom by lowest
used-over-limit ratio, so a 5/min key and a 60/min key in the same pool get load in proportion to what they can take

Profiles are derived rather than stored. No new table and no migration. The UI groups the deployments that already
exist by `model_name` into pools and offers "add another key to this pool", prefilling every field from a sibling.
The Credentials feature stays the place where a reusable auth bag lives, because it already exists, is
already encrypted per value, and already has CRUD plus UI

The day window resets on a per-key timezone, defaulting to UTC, because free tiers reset on the provider's local
midnight and not everyone's provider is in the same place. An optional `quota_reset_timezone` on the deployment shapes
the counter key as `{id}:{model}:rpd:{YYYY-MM-DD}:{tz}` with a TTL of the seconds remaining until the next local
midnight

## The one place the requirements contradict each other

Least-used-first and "keep using that rather than rotating randomly which will cache miss all the time" cannot both be
true per request. Least-used-first applied to every request is a rotation: after each call the key you just used has
the highest ratio in the pool, so the next call goes somewhere else, and the prefix cache you just paid to warm is
abandoned. That is the exact failure mode the second requirement is about

The resolution this plan takes, and the thing most worth pushing back on if it is wrong, is **sticky until exhausted**.
A conversation keeps hitting the same key until that key errors, gets cooled down, or runs out of its minute or day.
Least-used-first is not the per-request rotation policy; it is the tie-break that decides which key a conversation
lands on when it has no valid pin. So the ratio still spreads new conversations toward keys with headroom, and an
in-flight conversation still gets prefix hits

The existing filter order in `async_get_healthy_deployments` supports this without reordering anything. Quota exclusion
runs inside `async_callback_filter_deployments` (router.py:11893), and both stickiness checks run in that same pass and
already degrade correctly when their pinned deployment is absent from the list they are handed:
`PromptCachingDeploymentCheck.async_filter_deployments` scans for its cached `model_id` and returns the untouched list
when it is gone (prompt_caching_deployment_check.py:96-102), and `DeploymentAffinityCheck` logs and returns the full
list on the same condition (deployment_affinity_check.py:496-500, 526-531). Exhaust the pinned key and the pin simply
stops applying, which is the desired behaviour handed to us for free

One gap has to be closed for that to hold. `DeploymentAffinityCheck._claim_pin` is first-writer-wins
(deployment_affinity_check.py:344-402), so while the pin falls through harmlessly it also never moves. Every request for
the rest of the pin's hour re-picks from scratch, which is the random rotation we were trying to avoid. The prompt-cache
check has no such problem because `async_add_model_id` overwrites on every success with a fresh 300s TTL, so its pin
follows the traffic on its own. Phase 3 gives affinity the same self-healing

## Request path once all phases land

1. Request arrives. Session id is already extracted from `x-claude-code-session-id`, Codex's bare `session-id`, or
   Anthropic `metadata.user_id`, with no client configuration (litellm_pre_call_utils.py:666-715)
2. Response cache lookup. Keyed on model group, so any key's earlier answer counts as a hit
3. Cooldown and blocked filters drop keys that are hard-failing
4. Quota filter drops keys with no minute or day headroom left, reading counters, writing nothing
5. Stickiness pins the key this conversation was already using, if it survived step 4
6. If nothing is pinned, least-used-first picks the key with the most headroom
7. Race-safe reserve inside the semaphore, refunded if the call never reaches the provider
8. On error, immediate re-pick excluding the key that just failed, across keys and then across providers
9. If every key in the pool is out and the soonest reset is close, hold the request and retry rather than answering 429

## Deliberately out of scope

No new database table and no migration. No new provider integrations. No change to how virtual keys, teams, or budgets
work. No attempt to make provider prompt caches survive rotation, which is not possible from this side. No client-side
configuration of any kind, since the whole point is that the harnesses cannot tell

## Three decisions taken on the inferred points

These three were never explicitly chosen, so they are recorded with their reasoning. Each one is cheap to reverse

**A pool is a model group, and moving between models is a separate mechanism.**
One `model_name` per logical model, with every key that supports that model contributing one deployment to it. A key
supporting six models produces six deployments across six groups, which is exactly what the add-model form already does
when six models are ticked. A key that does not support a model simply has no deployment in that group, so per-key model
lists need no representation of their own and nothing has to store them

That makes the group the unit everything else here operates on: quota filtering, stickiness, least-used ranking and
intra-pool failover all happen within one group. "Move to a different model if that fails" is the existing cross-group
`fallbacks` chain and stays outside the pool, because a fallback to a different model returns a different answer to the
client and must not be reachable by accident just because a key is busy. Pool first, then fallback:

```yaml
router_settings:
  fallbacks: [{ "strong-model": ["cheap-model"] }]
```

The alternative was one flat pool holding every key of every provider behind a single name. Rejected because the harness
would then get an arbitrary model per request with no way to ask for a specific one, and because a per-minute capacity
roll-up would be summing keys for models that are not interchangeable

This decision has one consequence that has to be handled in phase 1 rather than discovered later. Six deployments built
from one key have six different `model_info.id` values, because `generate_model_id` hashes the model group in, so a quota
counter keyed on the deployment id would enforce a 5/min key at 5/min six separate times. The counters are therefore
scoped to the credential, not the deployment

**A failed request keeps its quota charge when the provider saw it.**
Refund on `APIConnectionError` and `Timeout`, where the request demonstrably never landed. Keep the charge on a
provider-side 429, 4xx or 5xx, because the provider counted it against the account, and counting less than they do means
the pool overshoots the real cap and starts collecting hard rejections it believes are impossible. This is the same
predicate phase 2 implements as its refund gate, so there is one definition rather than two that can drift

Being wrong here is bounded in both directions. Too generous and a key idles on quota it could have spent; too strict and
it eats a real 429 from the provider. It is one predicate to flip either way

**Hold for a minute, never for a day.**
One knob, `quota_max_wait_seconds`, defaulting to 75. When every key is exhausted and the soonest window rolls inside
that, the request is held: one sleep to the boundary, a re-peek, then service. Anything further out gets an immediate 429
carrying a `retry-after` that names the real reset

75 sits just above a 60 second window and far below any daily one, so a minute cap resolves invisibly while a day cap
never parks a connection for hours. There is no separate daily knob because there is no useful value for one: a request
cannot wait until midnight. The hold is additionally capped by the client's own remaining timeout, whichever is sooner,
since sleeping past the point the caller gives up burns a slot the pool could have given to someone else

## Phases

Each phase is independently shippable and independently testable, and each one names its own regression tests

1. [Quota foundation](phase-1-quota-foundation.md). The `rpd` param, `quota_reset_timezone`, and one shared atomic
   window-counter primitive. No behaviour change
2. [Quota enforcement](phase-2-quota-enforcement.md). Skip exhausted keys before selection, reserve race-safely inside
   the semaphore, refund on failure, and hold instead of leaking a 429
3. [Selection](phase-3-selection.md). Sticky-until-exhausted, least-used-first as the tie-break, and the affinity
   re-pin fix
4. [Failover](phase-4-failover.md). Immediate failover across keys and providers without disturbing the working one
5. [UI](phase-5-ui.md). Pools view derived from existing deployments, add-key-with-prefill, quota fields, live usage
6. [Observability and proof](phase-6-observability.md). A usage read endpoint, docs, and the live-proxy curl script
   that stands in for test output
