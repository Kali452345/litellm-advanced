# Phase 3: selection, stickiness, and rotation

Decide which key a request lands on. This phase resolves the contradiction described in the README: a conversation
stays on one key so provider prompt caches keep hitting, and least-used-first only decides where a conversation starts

## What each mechanism is for

Three separate caches are involved and conflating them is the main way this goes wrong

The LiteLLM response cache is an exact-match cache keyed on the model group (caching.py:391-404), so it is already
indifferent to which key served the original request and rotation cannot miss it. Turn it on and it absorbs duplicate
work across the whole pool for free

The provider prompt cache is a prefix cache living inside the provider account behind one specific key. Nothing this
codebase does can share it across keys. Stickiness exists solely to protect it

The prompt-caching deployment check is the index that maps a cacheable prefix back to the key that warmed it
(`PromptCachingCache.get_prompt_caching_cache_key` hashes the prefix up to and including the last `cache_control`
block, prompt_caching_cache.py:142-176, stored 300s against `model_id`)

## Stickiness: use what exists

Both existing checks already do the right thing, including the part that is easy to get wrong, so this is mostly wiring

`prompt_caching` is the better primary for an agent harness. It is keyed on the cacheable prefix rather than on identity,
so it survives across sessions, across restarts, and across two harnesses that happen to share a system prompt. It falls
through correctly: `async_filter_deployments` scans `healthy_deployments` for its cached `model_id` and returns the list
untouched when it is gone (prompt_caching_deployment_check.py:96-102). And it self-heals, because
`async_add_model_id` overwrites on every success with a fresh 300s TTL, so the pin follows traffic without any help

`session_affinity` is the useful complement, and the reason it needs no client changes is worth being explicit about:
`get_chain_id_from_headers` already reads `x-litellm-trace-id`, then `x-litellm-session-id`, then any
`x-<vendor>-session-id` including `x-claude-code-session-id`, then Codex's bare `session-id`, `thread-id` and
`conversation_id` (litellm_pre_call_utils.py:666-691), and `_get_anthropic_session_id_from_metadata` pulls a session id
out of Anthropic `metadata.user_id` (:694-715). Two concurrent harnesses therefore get distinct pins automatically. If
they ever do not, giving each harness its own virtual key achieves the same thing, since `deployment_affinity` keys on
`metadata["user_api_key_hash"]` (deployment_affinity_check.py:257-263)

Enable them together:

```yaml
router_settings:
  optional_pre_call_checks: ["enforce_request_quotas", "prompt_caching", "session_affinity"]
```

Order within the pass does not need changing. Quota filtering removes exhausted keys before either stickiness check
looks at the list, so a pin can never resolve to a key with no headroom

## The affinity re-pin fix

`DeploymentAffinityCheck._claim_pin` is first-writer-wins by construction: `_CLAIM_PIN_SCRIPT` sets the key only when it
is absent and otherwise refreshes the TTL and returns the incumbent (deployment_affinity_check.py:63-73, 344-402)

The consequence is subtle because nothing breaks. When the pinned key is exhausted the filter returns the full list and
the request is served (:496-500, :526-531), so behaviour looks correct. But the pin stays, so every request for the rest
of the hour re-picks from scratch, which is the random rotation the whole phase exists to prevent, and the TTL refresh
keeps the dead pin alive for as long as traffic keeps arriving

The fix is to make the fall-through path clear the pin, so the next request re-pins to whatever it lands on. Delete the
key at exactly the point where `_find_deployment_by_model_id` returns `None` for a pin that was found. Do not add a
re-pin heuristic anywhere else: the existing graceful-degradation branch is already the precise signal, and clearing
there gives affinity the same self-healing the prompt-cache check gets from overwriting

Watch the deployment-id coupling. `generate_model_id` is a sha256 over model group plus resolved litellm params
(router.py:8107), so editing a key's `api_key` changes its deployment id and orphans its pins, cooldown state, and spend
rows. That is existing behaviour and this phase does not fix it, but it needs saying in the UI phase: rotating a key's
secret in place is not the same operation as adding a key

## Least-used-first

This is the tie-break for a request with no valid pin, and it is a small amount of code because the eligible set has
already been narrowed by quota filtering

Rank the survivors by highest remaining headroom, computed as the lowest `used / limit` ratio across the key's
configured windows, taking the worst window as the key's score so a key with day headroom but no minute headroom does
not outrank one with room in both. A key with no configured limit has infinite headroom and sorts first. Break exact ties
with the existing weighted shuffle rather than by list order, so two identical keys still share load

Ratio rather than absolute remaining is the point of the decision already made: a 5/min key and a 60/min key in one pool
should receive load in proportion to what they can absorb, and absolute remaining would starve the small one

Where it goes is a real fork in the road. A new `RoutingStrategy` value is the honest home, and it is what the existing
strategy files model. The cost is `_maybe_run_weighted_failover` bailing unless the strategy is exactly `simple-shuffle`
(router.py:6884, 6713-6788), so a new strategy silently loses immediate failover. Phase 4 lifts that restriction, which
makes the ordering between these two phases matter: either land phase 4 first, or accept that the two must ship
together. Doing it as a reordering pass inside the quota check instead would avoid the restriction but hides selection
policy inside a check named for enforcement, and hidden policy is worse than a sequencing constraint

## Files

| File | Change |
|---|---|
| `litellm/router_strategy/least_used.py` | New. Ranking over the already-filtered set |
| `litellm/types/router.py` | `RoutingStrategy` member (:831-837) |
| `litellm/router.py` | Strategy dispatch; lift the `simple-shuffle` guard at :6884 with phase 4 |
| `litellm/router_utils/pre_call_checks/deployment_affinity_check.py` | Clear the pin on fall-through |

## Tests

`tests/test_litellm/test_router_strategy/test_least_used.py` and an addition to the existing affinity test file rather
than a new one, since the re-pin is a bug fix

Stickiness under load. Twenty sequential requests sharing a cacheable prefix against a three-key pool with ample
quota, and assert all twenty hit the same key. Replace the selection with a shuffle and this fails, which is the whole
requirement in one assertion

Sticky until exhausted, then move, then come back. Same pool at `rpm: 3`. Requests one to three hit key A, four to six
hit a different key, and after the boundary a fresh prefix can land on A again. This is the sticky-until-exhausted
contract and it fails under both a pure-rotation and a pure-pin implementation

Re-pin. Pin a session to a key, exhaust that key, drive a request, and assert the pin now names the key actually used.
Against today's first-writer-wins code this fails, which makes it the regression test for the bug

Proportional spread. One key at `rpm: 5` and one at `rpm: 60`, sixty-five new conversations, and assert the split is
near 5/60 rather than near even. Rank by absolute remaining instead of ratio and this fails

Worst-window scoring. A key with day headroom but no minute headroom must not outrank a key with room in both

Response cache survives rotation. Same request twice, forcing different keys, and assert the second is a cache hit. This
guards finding 1 against a future change that adds `api_key` to the cache key

Two harnesses stay separated. Two distinct session ids interleaved against a two-key pool, and assert each stays on its
own key. Then the same test with the session headers removed and distinct virtual keys, to prove the fallback path
