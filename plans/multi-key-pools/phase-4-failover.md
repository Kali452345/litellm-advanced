# Phase 4: immediate failover across keys and providers

"When there is an error it just immediately, without affecting the primary api, resends the request either to a new api
or different provider." Two halves: the failed key must not be retried, and the key that was working must not be
disturbed on the way past

## What already works

`enable_weighted_failover` does the hard part. On a retryable failure it collects the failed deployment id, unions it
with anything already excluded for this request, subtracts the cooldown set, and re-runs the group with
`_excluded_deployment_ids` set so selection cannot land on the same key again (router.py:6713-6788). Exclusions
accumulate across hops through `meta["_failover_excluded_ids"]`, and it deliberately copies kwargs so the exclusion does
not leak into the cross-group fallback that may follow (:6769-6777). Cross-provider failover then comes free, because a
second provider in the same pool is just another deployment in the group, and a different pool is an ordinary fallback

Latency is already right. `_time_to_sleep_before_retry` returns 0 as soon as any healthy deployment remains in the group
(router.py:7506-7507), so a re-pick does not sit through a backoff. A check that raises with `num_retries=0` on the
exception short-circuits the retry loop entirely (:7193-7200), which is how a quota rejection skips straight to the
re-pick rather than hammering the group

## Four restrictions to lift

**Strategy.** `_maybe_run_weighted_failover` returns `None` unless the strategy is exactly `simple-shuffle`
(:6723-6725). Phase 3 adds a strategy, so leaving this in place means the new strategy silently has no immediate
failover. Widen the guard to an allow-list containing `simple-shuffle` and least-used. This is the ordering dependency
between the two phases: either land this first or ship them together

**The retry loop does not exclude anything.** Weighted failover runs at the fallback layer, which is reached only after
`num_retries` attempts on the group. Those attempts re-pick without any exclusion set, relying entirely on the cooldown
to keep them off the failed key. That holds for a 429, 401 or 404, which cool down on the first failure once the group
has more than one member (cooldown_handlers.py:386-387). It does not hold for a transient 500 or a timeout, which go
through the percent-fails path and may well leave the key selectable, so the first retry can hit the key that just
failed. Thread the same `_excluded_deployment_ids` mechanism into the retry loop so a re-pick within `num_retries`
excludes the deployment that raised. This is the change that actually delivers "immediately resends to a new api" for
the common transient-error case, and the existing `_get_excluded_filtered_deployments` hook at router.py:11943 means the
filter side already exists

**`max_fallbacks` bounds the traversal at 5.** Immediate failover recurses through `run_async_fallback`, which stops at
`fallback_depth >= max_fallbacks` (fallback_event_handlers.py:370), defaulting to `ROUTER_MAX_FALLBACKS` of 5. With a
pool of eight to twelve free-tier keys, a bad patch of five leaves the request failing while healthy keys sit unused.
Do not raise the global default, which would change cross-group fallback behaviour for everyone. Give intra-pool
re-picks their own bound derived from the pool size, so traversal can cover the pool without letting cross-group chains
grow

**Async only.** `router.completion()` falls through to ordinary fallback with no exclusion (documented at
router.py:677). Sync is not on the path either harness uses, so the recommendation is to leave it and say so in the
docs rather than duplicating the logic. Worth a decision rather than a silent gap

## Not disturbing the working key

The second half of the requirement is the part with no code today, and it is mostly about what must not happen

A failure on one key must not cool down, decrement, or unpin any other key. The one real hazard is the
client-side-credential case that `_stamp_failed_deployment_id_with_effective_model_info` already guards
(router.py:3349-3357): stamping the shared static deployment id instead of the per-request dynamic one would let one
caller's bad credentials cool down a deployment every other caller relies on. Any new stamping site has to go through
that helper rather than `_set_failed_deployment_id_on_exception` directly

Quota interacts here too. A key that fails must not silently keep the reservation that phase 2 took for it, and a key
that was never called must not be charged for the attempt. Phase 2's refund predicate covers this, and the test below
pins it at the failover level

Note that `_set_failed_deployment_id_on_exception` is deliberately idempotent and keeps the first id in a chain
(:3339-3341). Per hop that is correct, since each hop raises its own exception. It becomes wrong the moment anything
re-raises the same exception object across hops, so the multi-hop test below exists to catch that

## Files

| File | Change |
|---|---|
| `litellm/router.py` | Strategy allow-list at :6723-6725; exclusion set threaded into `async_function_with_retries`; pool-sized intra-group bound |
| `litellm/router_utils/fallback_event_handlers.py` | Separate depth bound for intra-group re-picks |

## Tests

Extend the existing weighted-failover tests rather than adding a file, since most of this is fixing an existing feature

The failed key is never retried. A three-key pool where key A raises a 500 with no cooldown triggered, and assert the
next attempt goes to B or C. Against today's retry loop this fails, which makes it the regression test for the second
restriction

Multi-hop exhaustion. A pool of eight keys where the first six fail, and assert the seventh is tried and the request
succeeds. This fails at five today, which is the regression test for `max_fallbacks`

Cross-provider. A pool spanning two providers where every key of the first provider fails, and assert the request
completes on the second with no client-visible error

The working key is untouched. Fail key A repeatedly while B serves traffic, and assert B is never cooled down, its
counters match its own call count exactly, and its pin is intact

Exclusions do not leak. After intra-pool failover falls through to a cross-group fallback, assert the fallback group
sees no `_excluded_deployment_ids` from the pool it left. The comment at :6769-6777 says this is deliberate, so it
deserves an assertion

Refund on failover. Key A reserves, fails with `APIConnectionError`, request succeeds on B, and assert A's counter is
back to its pre-call value while B's is incremented by one

No backoff. Assert the elapsed time across a three-hop failover stays under a small threshold, so a future change that
reintroduces a sleep between re-picks is caught. Assert against a measured bound rather than a mocked sleep, since the
behaviour under test is that no wait happens

Strategy parity. Run the same first test under both `simple-shuffle` and least-used, and assert identical failover
behaviour. Leave the guard at :6724 as-is and the least-used case fails
