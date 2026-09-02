# Multi-key rotation, in phases

The goal: several keys per provider and several providers behind one model name, rotating between
them, failing over on error, and never sending a request to a key whose minute or day allowance is
spent. None of that visible to the agent harness driving the proxy, which sees one model

Everything lands on `litellm_quota_foundation`, off `litellm_internal_staging`. Later phases commit
to that branch rather than stacking new ones

## Phase 1, credential-scoped counters: done

`window.py`, `scope.py` and `counter.py` in this package, plus the `rpd`, `quota_reset_timezone`,
`quota_scope` and `quota_scope_id` deployment params

Counters key on the credential, not on the deployment, because `generate_model_id` hashes the model
group into the deployment id: one key serving six model groups yields six ids, so a 5/min free tier
would have been enforced as 5/min per group. The window label lives inside the counter key, so a
window resets because the key changed, and the TTL is only garbage collection

## Phase 2, enforcement in async routing: done

`enable_quota_routing=True` on the Router turns `rpm` and `rpd` into hard caps. `enforcement.py`
holds an advisory pre-`order` filter that drops spent credentials, an authoritative reservation on
the deployment selection landed on, a refund for the requests that never reached the provider, and
a bounded hold when the whole pool is out but the window rolls over in seconds

Deliberately not enforced, and worth saying out loud in the PR: the sync `get_available_deployment`,
`async_get_available_deployment_for_pass_through`, the `specific_deployment` and
`_encrypted_content_affinity_pinned` early returns, and the top-level `usage-based-routing` v1 and
`lar1` strategies, which select through the sync path and log a startup warning

Two deviations from the original plan. Enforcement lives in the router behind one flag instead of an
`enforce_request_quotas` pre-call check, because a pre-call check cannot drop a candidate before
`order` filtering runs. And rotation is sticky first-fit through `order` rather than least-used-first
or random, because round-robin cold-misses the provider's prompt cache on every request

## Phase 3, stickiness and ranking: done

The quota filter moved above `async_callback_filter_deployments`, so a spent credential never reaches
the affinity and prompt-caching filters. Those narrow a group to one deployment, so a pin landing on
a spent key used to be dropped right after and empty the group, failing a request the other keys had
room for. `QuotaEnforcer.most_spent_first` then ranks what survives, scored on the worst window a
candidate has, and the `simple-shuffle` branch takes the head of that ranking instead of a weighted
random pick. Unmetered deployments score below every metered one and sort last, so they stay the
overflow the pool spills into

Two reversals from the phase-2 plan. Ranking is most-spent-first, not least-used-first: least-used is
round robin, which moves a conversation to a cold key on every request and cold-misses the provider's
prompt cache, and a free pool is exactly where that hurts most. And the affinity pin is deliberately
left alone when its deployment is filtered out. `_claim_pin` is set-if-absent, so the pin outlives a
spent window and hits the same key again once the window rolls over, which is the stickiness this
whole phase is for. Clearing it would repin somewhere cold, and the hook cannot tell a deleted
deployment from a temporarily spent one

Costs, both accepted. Ranking adds one batched counter read per request on top of the filter's, and
no strategy member or module was added, so the `simple-shuffle` guard in `_maybe_run_weighted_failover`
is untouched. Against `origin/litellm_internal_staging`, `litellm/router.py` gains one
`reportUnknownArgumentType` and three `reportUnknownVariableType`: `healthy_deployments` there is
typed `list[dict]`, so every local derived from it is partially unknown, and LIT010 requires those
locals rather than rebinding. Offset by importing `_get_excluded_filtered_deployments` instead of
reaching through `litellm.utils`, which drops one `reportPrivateUsage` and two
`reportUnknownMemberType`

## Phase 4, failover across keys and providers: done

A request records the key it reserved a slot on, and selection drops the keys the request has already
recorded. So an error on one key re-dispatches to the next key in the pool, and on into the next
provider once that provider's keys are gone, inside the same call. The harness sees one answer

The marker shares weighted failover's `_failover_excluded_ids` metadata key, so both walks read one
accumulator: a key burned by a retry stays skipped when the request escalates into weighted failover,
and the other way round. It is written at reservation time, in `_reserved_within_quota`, next to the
refund stamp, so there is one write site and the generic retry machinery is untouched. Retries,
weighted failover and cross-group fallbacks all read the same list

A deviation from this phase's own plan, which said to make weighted failover the default for a quota
pool. That would not have fixed the actual defect. Weighted failover only runs after retries are
exhausted, and the retry loop was the thing re-picking the key that just failed: it re-selects with
the same kwargs, and most-spent-first hands back the fullest key, which is the one whose slot the
failed attempt just spent. A 500, a connection error or a timeout does not cool that key down either,
since `_should_cooldown_deployment` wants half the minute's requests failed over at least five of
them. Recording the attempt fixes the retry loop, weighted failover and fallbacks at once, and does
not inherit `max_fallbacks`

Two properties worth keeping straight. Quota exhaustion stays a hard filter, because a spent key must
never be sent to. Already-tried is soft: when every key in the pool has been tried, the pool comes
back whole and the caller gets the provider's own error instead of a no-deployments error. And keys
walked per request is `num_retries + 1`, 3 by default, so a pool bigger than that is walked by raising
the existing `num_retries`. No new knob for it

Costs, accepted. One more batched counter read per request, at reservation time, which the reservation
already paid for. And `litellm/router.py` gains one `reportUnknownVariableType` and one
`reportUnknownArgumentType`, the same cause as phase 3: `healthy_deployments` and `request_kwargs`
there are typed `list[dict]` and `dict | None`, so anything derived from them or handed a typed
parameter is partially unknown. Declaring the local does not help, because pyright narrows to the
assigned type and reports the narrowed one, and folding the filter into a helper only moves the
diagnostic from the local onto the pool argument

## Phase 5, the setup interface: done

`GET /provider/profiles` and `POST /provider/keys` in
`litellm/proxy/management_endpoints/provider_profile_endpoints.py`. The first reports what each
provider is already set up with, the second puts another key behind it in one call, so the base url,
the api version, the models that provider serves and the per-minute and per-day caps are typed once

A profile is derived from `llm_router.model_list`, grouped by provider and base url, so there is no
new table, nothing that can go stale against the deployments it describes, and no secret written to
`credential_info`, which is not encrypted. Every field is what all of that provider's deployments
agree on, and a disagreement reports null rather than whichever deployment happened to be first,
because guessing here would silently cap a new key at another key's allowance. The caps hang off each
model entry instead of the profile, since one key's allowance differs per model. Key count is a count
and never an id: scope ids are salted digests of the key itself, and `scope.py` says they are never
logged or returned

`POST /provider/keys` copies the profile onto one deployment per model the provider serves and hands
each one to `POST /model/new` rather than writing rows itself, so encryption at rest, the permission
check, the audit log and the router reload keep a single implementation. Writes go one at a time
because each one reloads the router from the database. What the response reports is read off the plan
before the first write, because `_add_model_to_db` encrypts `litellm_params` in place on the
deployment it is handed. A model the provider rejects costs only that model: each create returns its
own outcome and the response names the failure per model

`quota_scope_id` is deliberately never copied. That param is an operator saying two deployments spend
from one account, so copying it onto a new key would count that key against the old key's counter and
give the pool half of what it has. `rpm`, `rpd` and `api_base` can be overridden per request, and a
provider that is already reached at more than one base url refuses to guess and asks which one the new
key uses

Costs, accepted. Two `reportUnknown*` against the two untyped things upstream, `Router.model_list`
being a bare `list` and `add_new_model` having no return annotation. Both are validated with a
Pydantic adapter on the spot rather than typed with `Any`, so the unknown stops at the boundary. The
router-level `tags` needs one `# mutable-ok`, since FastAPI types that parameter as `list`

The dashboard half is a Provider Keys tab on Models + Endpoints, one row per provider and base url,
reporting how many keys it already has, the caps its models agree on, and whether a cap is counted per
model or shared across the key. Add key opens a form where the only field to fill in is the key
itself: the base url, the models and the caps arrive prefilled from the profile, so the second key is
a paste rather than a retype. Per-model selection is there for a key that a provider has not enabled
every model on. The response is reported per model, so a partial success names the model the provider
refused instead of reading as a clean success, and a total failure leaves the form open with the key
still in it

Add Model grows first-class Requests Per Minute and Requests Per Day inputs, next to the LiteLLM
Params textarea that was previously the only way to set them. The first deployment of a provider is
what a profile is derived from, so caps typed there are what every later key inherits. They post as
numbers rather than the strings the inputs hold, since a cap stored as `"5"` in `litellm_params` is
JSON that the counter cannot compare against

Pure logic lives in `providerKeyPayload.ts` with millisecond unit tests, per the dashboard's own rule
that logic worth asserting must not be reachable only through a render. The panel and the modal keep
the cases that prove a form field reaches the right payload key

## Phase 6, visibility: done

`GET /model/quota/usage` in `litellm/proxy/management_endpoints/model_quota_endpoints.py`,
admin-view-only, reporting one entry per model name with every key behind it and what each key
has spent of each window it meters. Plus `README.md` in this package, the operator-facing
writeup of the whole feature: how to turn it on, what each deployment param means, what a
request actually does, and the gaps

The read lives on the enforcer, as `QuotaEnforcer.usage`, not in the endpoint.
`_descriptors_for_view` already owns cap precedence and scope resolution, and an endpoint that
rebuilt counter keys itself would be a second copy of both, free to drift from what routing
enforces. `availability` is now derived from `usage` rather than reading the counters itself, so
the rule that a reset time is reported only when the whole pool is spent exists in one place.
The 43 enforcement tests that predate this phase are what pinned that refactor as
behavior-preserving

Deliberately not shipped: a requests-remaining number per pool. Two deployments can share one
counter, through `quota_scope_id` or through the same key being added twice, so a total would
double count them, and a wrong number in an observability endpoint is worse than no number. Each
pool reports exhaustion instead, an AND over its keys, which is dedupe-immune and is exactly
what routing itself acts on

Nothing derived from a key reaches the wire. A key is identified by its deployment id, its model
string and its base url, never by the quota scope id, which is a salted digest of the key. When
the router was built without `enable_quota_routing` the response says `enforced: false` and the
counters are read through an enforcer built on the spot, so an operator still sees the caps they
configured and learns why every count is zero, instead of an empty answer that reads as nothing
being configured

Docs are in-repo rather than a docs-site page, because this fork tracks no `docs/` directory at
all. No dashboard consumer this phase either: the Provider Keys tab covers setup, and a live
usage panel is its own piece of work rather than a footnote to this one

Costs, accepted. `usage` returns a row per deployment, including the unmetered ones, so a caller
can zip the rows back onto its own list; that means the endpoint groups by model name itself
rather than getting groups back. One batched counter read per call, which is the same read
`availability` was already doing. And one `reportUnknownMemberType`, from reading
`Router.model_list`, which is a bare `list` upstream, the same cost and the same Pydantic
adapter at the boundary as phase 5
