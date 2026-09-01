# Phase 1: quota foundation

Add the vocabulary and the counting primitive. Nothing changes behaviour at the end of this phase, which is the point:
it can land and sit in production doing nothing while the pieces that use it are reviewed separately

## What gets added

A `rpd` litellm param alongside the existing `rpm` and `tpm`, a `quota_reset_timezone` param, and one atomic
window-counter helper that phases 2 and 3 both call. `rpd` appears nowhere in `litellm/` today, so the name is free

## Files

| File | Change |
|---|---|
| `litellm/types/router.py` | `rpd: int \| None` and `quota_reset_timezone: str \| None` on `GenericLiteLLMParams` (:287-302) and `LiteLLMParamsTypedDict` (:443-511), both `ReadOnly[...]` per LIT012 |
| `litellm/router_utils/quota/window.py` | New. Window identity, key derivation, TTL-to-boundary |
| `litellm/router_utils/quota/counter.py` | New. `AtomicWindowCounter`: reserve, refund, peek |
| `litellm/router_utils/quota/__init__.py` | New. Public surface, nothing else |
| `litellm/constants.py` | `DEFAULT_QUOTA_MAX_WAIT_SECONDS`, `QUOTA_COUNTER_KEY_PREFIX` |

`GenericLiteLLMParams` is the correct home rather than `model_info`, because membership there is what stops a field
being forwarded to the provider as an unknown kwarg. Note the deliberate contrast with `cooldown_time`, which
`cooldown_handlers.py:90-110` reads from `model_info` only: that convention exists because `litellm_params` leaks into
the provider call for params the SDK does not recognise, and adding `rpd` to `GenericLiteLLMParams` is exactly what makes
it recognised. Read it with the same three-way lookup `_get_deployment_limits` already uses (top level, then
`litellm_params`, then `model_info`) so an operator who puts it in the wrong place is not silently ignored

## Window identity

Two window kinds, one shape. A window is (kind, boundary timestamp, seconds until boundary)

The minute window keeps the existing `%H-%M` convention so it stays readable next to the counters already in the cache,
with a 60s TTL. The day window is `{YYYY-MM-DD}` in the key's own timezone with a TTL of the seconds remaining until
the next local midnight, so the key expires exactly when the quota resets and there is no stale-counter case to reason
about

```
{model_id}:{litellm_model}:rpm:{%H-%M}
{model_id}:{litellm_model}:rpd:{YYYY-MM-DD}:{tz}
```

The timezone is in the day key on purpose. Change a key's `quota_reset_timezone` and it starts counting in a fresh
namespace rather than inheriting a count that was accumulated against a different midnight. The cost is that the change
grants a fresh day's allowance once, which is the right trade for a setting nobody flips casually

Resolve the timezone with `zoneinfo.ZoneInfo` from the standard library. An unknown name must fail loudly at deployment
add time rather than falling back to UTC at request time, because a silent fallback means a key quietly resetting at the
wrong hour for as long as nobody notices

## The counter

`AtomicWindowCounter` takes a `DualCache` by constructor injection and exposes three operations:

`peek(keys) -> Mapping[str, int]` reads current counts without writing. This is what the filter in phase 2 calls, so it
must never mutate and must tolerate a missing key as zero

`reserve(descriptors) -> ReserveResult` is all-or-nothing across the descriptors it is handed, where a descriptor is
(key, limit, ttl, window_size). Either every counter is incremented or none is, and the failure carries which
descriptor blocked plus its window boundary so the caller can report a truthful retry-after. Modelled as a tagged union
returned as a value, per the repo's no-throw convention: `ReserveGranted(counts)` or `ReserveBlocked(key, current,
limit, resets_in_seconds)`

`refund(descriptors)` decrements. Refunds need no atomicity guarantee, so this is a plain decrement and is allowed to
be best-effort

## Why this is not just `async_increment_cache`

For a single counter it nearly is. `DualCache.async_increment_cache` returns the real post-increment value from Redis
`INCRBYFLOAT` or from the in-memory cache (dual_cache.py:371-411), so increment-then-compare is already race-free, and
`model_rate_limit_check.py:271-294` is correct today for that reason

Two things force a real primitive. First, minute and day have to be checked together: a request that has minute
headroom but no day headroom must not consume the minute slot, and increment-both-then-compare-both leaves the minute
counter inflated on every rejected request for the rest of the day. Second, the same inflation applies to a single
counter whenever the request is rejected, and at a limit of 5 with two concurrent harnesses that overshoot is a large
fraction of the budget rather than noise

Do not reuse `base_routing_strategy.py`'s write-behind Redis sync. Its roughly 100ms flush window is a rounding error
at a limit of 10000 and an entire request at a limit of 5

## Redis path

Lift `CHECK_AND_INCREMENT_BY_N_SCRIPT` (parallel_request_limiter_v3.py:117-210) rather than writing new Lua. It is
already two-pass all-or-nothing, already reads `redis.call('TIME')` so replicas with skewed clocks cannot reopen the
TOCTOU window, and already handles the window-expired reset and the `TTL == -1` repair

It cannot be imported from where it lives. `litellm/proxy/hooks/` importing into `litellm/router_utils/` inverts the
dependency, and the Router has to work standalone in the SDK with no proxy installed. Move the script constant into
`litellm/router_utils/quota/counter.py` and have `parallel_request_limiter_v3.py` import it from there, so there is one
copy and the proxy keeps working unchanged. Register with `redis_cache.async_register_script`
(redis_cache.py:619-694), which namespaces keys for you and binds per event loop

Keep the `{key:value}` hash-tag co-location the v3 payload builder uses (`_build_descriptor_atomic_payload`:1725) so a
single Lua call never spans Redis Cluster slots, and keep its refund-on-rollback for the cross-descriptor case

## In-memory path

When no Redis is configured, the same two-pass check runs under one `asyncio.Lock` held across both passes. This is a
real correctness path and not a degraded mode: the single-process proxy is the likely deployment for this feature, and
two concurrent harnesses on one process race exactly as hard as two processes do

## Tests

`tests/test_litellm/test_router_utils/test_quota/test_counter.py` and `test_window.py`, new files following the mirror
convention in `tests/test_litellm/readme.md`

The tests that have to fail if the code is mutated:

Concurrency. Fire 50 concurrent `reserve` calls at a limit of 5 and assert exactly 5 are granted. Run it against both
backends: `fakeredis` for the Lua path and a Redis-less `DualCache` for the lock path. Drop the lock or make the Lua
single-pass and this fails

All-or-nothing. Reserve against a descriptor pair where minute has headroom and day does not, then assert the minute
counter is still at its pre-call value. This is the mutation that a naive implementation ships with

Refund symmetry. Reserve, refund, peek, assert zero. Then refund a key that was never reserved and assert it does not
go negative

Day boundary in a real timezone. Freeze time at 23:59:30 in `America/Los_Angeles`, reserve, assert the TTL is 30 and
the key carries that date, advance 31 seconds, assert a fresh key with a full allowance. Do the same at a UTC boundary
to prove the two do not collide. Hardcode UTC anywhere and this fails

Timezone validation. An unknown `quota_reset_timezone` raises at construction and does not silently become UTC

Do not assert that a function exists, that a constant has a particular value, or that a key is formatted a certain way
in isolation. Assert the counting behaviour those things produce
