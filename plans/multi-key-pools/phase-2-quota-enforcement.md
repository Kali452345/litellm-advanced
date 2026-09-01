# Phase 2: quota enforcement and holding for capacity

Make the counters from phase 1 actually gate traffic: skip a key with no headroom before it is ever selected, reserve
race-safely once it is, give the slot back when the call never reached the provider, and hold the request rather than
letting a 429 escape to the harness when the whole pool is out but the reset is seconds away

## The new check

One `CustomLogger` in `litellm/router_utils/pre_call_checks/quota_check.py`, enabled by adding `enforce_request_quotas`
to the `OptionalPreCallChecks` literal (litellm/types/router.py:867-878) and a branch in
`Router.add_optional_pre_call_checks` (router.py:1989-2074), instantiated with the router's `DualCache` the same way
`ModelRateLimitingCheck(dual_cache=self.cache)` is

```yaml
router_settings:
  optional_pre_call_checks: ["enforce_request_quotas"]
  quota_max_wait_seconds: 75
```

It implements four hooks, and which hook does what is the entire design

## `async_filter_deployments` is the primary gate

This runs at router.py:11893, before selection, and has no cooldown side effect. It calls `peek` on every candidate's
minute and day counters and returns only the ones with headroom. It writes nothing

Filtering here rather than rejecting later is what makes the feature work. Today an over-limit deployment gets selected,
then rejected by `async_pre_call_check`, then cooled down, and the request burns a whole selection round to learn
something that was knowable before it started. Filtering also means the exhausted key is invisible to the stickiness
checks that run in the same pass, which is what lets a pin fall through cleanly instead of pinning to a dead key

Because the filter re-reads the counter on every request, a key that comes back at the minute boundary is simply
eligible again on the next call. There is no cooldown to expire and no state to clear, which sidesteps the five-second
cooldown problem in finding 3 of the README entirely

## `async_pre_call_check` is the race-safe backstop

The filter is a read, so two concurrent requests can both see headroom of one and both proceed. `async_pre_call_check`
runs inside the router's per-deployment semaphore and calls `reserve`, which is the atomic all-or-nothing operation. On
`ReserveBlocked` it raises `litellm.RateLimitError` with `num_retries=0` and a `retry-after` header set to the blocked
window's real `resets_in_seconds`, matching the shape `model_rate_limit_check.py:271-294` already uses

That raise does trigger `_set_cooldown_deployments` with `time_to_cooldown=self.cooldown_time`
(router.py:8025-8031), which as finding 3 explains ignores the header and cools the key for five seconds. For the
backstop that is tolerable, because it only fires on a genuine race that the filter already narrowed to near-zero, and
five seconds of unnecessary cooldown on one key in a pool of many costs almost nothing. It is worth fixing anyway:
change that call to prefer `_get_retry_after_from_exception_header(...)` over `self.cooldown_time`, which is the same
precedence `deployment_callback_on_failure` already applies (router.py:7738-7754). That is a two-line change and it
makes every quota-shaped 429 in the codebase cool down for the right duration instead of five seconds

Do not set a static `cooldown_time` on a quota-managed deployment. Deployment config wins over the response header in
that precedence chain, so a static value silently clobbers every window-aligned cooldown

## Refunds

A reservation that never became a provider call has to be given back, or the counter drifts up until the window rolls.
At a limit of 5 a handful of connection errors eats the budget

`async_log_failure_event` refunds, gated on the failure class. Refund on `APIConnectionError` and `Timeout`, where the
request demonstrably never landed. Do not refund on a provider-side 429, 4xx or 5xx, because the provider counted it and
counting less than they do means overshooting the real cap. This is the recommendation in the README's open questions
and it is the one place where being wrong is cheap to reverse: it is a single predicate

`Timeout` is the imprecise edge and the implementation should not pretend otherwise. A connect timeout never reached the
provider and is a clean refund; a read timeout means the provider is already generating and will count the request, so
refunding it undercounts. Inspect the underlying `httpx` exception where it survives the wrap and only refund the connect
case. Where it does not survive, charge rather than refund, since a small idle margin beats a hard rejection the pool
believed was impossible

Mirror the existing io-token pattern for how the refund finds its keys. `ModelRateLimitingCheck` stashes a marker in
metadata (`ITPM_RESERVED_KEY`, checked in both `slo_metadata` and `kwargs_metadata` at
model_rate_limit_check.py:320-322) so the refund works off kwargs alone and does not need the deployment dict back.
Copy that, and copy the `contextlib.suppress(Exception)` wrapper at :371 too, because a refund bug must never take down
the logging pipeline

## Holding for capacity

When the filter finds every candidate exhausted, the choice is hold or 429. Holding is what "it should know to wait a
minute and reuse it later" asks for, and it is the only option that keeps the harness unaware

Do it inside `async_filter_deployments`, which is the only place that already knows every candidate's reset time. If the
soonest boundary across the filtered-out set is within `quota_max_wait_seconds`, sleep until just past it and re-peek,
then return whatever is now eligible. Otherwise return the empty list and let the router raise

Bounds that matter. Sleep to the boundary plus a small jitter, never a fixed poll interval, so a minute of waiting is
one sleep rather than 20000 cache reads. Cap total held time at `quota_max_wait_seconds`, default 75, so a minute window
resolves and a day window does not. Cap it again at the client's own remaining timeout when that is sooner, since
sleeping past the point the caller gives up burns a slot another request could have used. Honour cancellation, since a
client that hangs up must not leave the coroutine sleeping. And do not hold inside the semaphore, which is another reason
this belongs in the filter rather than the pre-call check

`Scheduler` is not used, for the three reasons in README finding 4

## When it does give up

Returning an empty list produces `RouterRateLimitError` (router.py:11948-11954), a plain `ValueError` the proxy
string-matches into a 429 and stamps with `retry-after` from `e.cooldown_time`, which is a cooldown default and has
nothing to do with quota. Since this is the one failure the harness can see, make the number true: have the filter
publish the soonest reset onto `request_kwargs`, and have `async_raise_no_deployment_exception` prefer it over
`get_min_cooldown` when present. Small change, and it is the difference between telling a client to retry in 5 seconds
and telling it the truth

## Files

| File | Change |
|---|---|
| `litellm/router_utils/pre_call_checks/quota_check.py` | New. The check |
| `litellm/types/router.py` | `enforce_request_quotas` in `OptionalPreCallChecks` |
| `litellm/router.py` | Branch in `add_optional_pre_call_checks`; `quota_max_wait_seconds` setting; retry-after precedence at :8025-8031; soonest-reset in the no-deployment error |
| `litellm/router_utils/handle_error.py` | `async_raise_no_deployment_exception` prefers a published reset |

## Tests

`tests/test_litellm/test_router_utils/test_pre_call_checks/test_quota_check.py`

Skip before select. A pool of two keys at limits of 1, one already at its limit. Assert the exhausted key is absent from
the filter output and that the request succeeds on the other. Remove the filter and this still passes via the backstop,
so also assert the exhausted key was never selected, which is the part that fails

Self-heal at the boundary. Exhaust a key's minute, assert it is filtered, advance past the boundary, assert it is
eligible again with no cooldown clearing in between

Day outlives minute. Exhaust `rpd`, advance ten minutes so the minute window has rolled several times, assert still
filtered. Key the day counter on `%H-%M` by mistake and this fails

Concurrency through the real path. Two concurrent callers against one key with `rpm: 1`. Exactly one provider call
happens. This is the test that fails if the backstop is dropped and only the filter remains

No inflation on rejection. Reject via the backstop, then assert the minute counter is back where it started. This is the
refund-symmetry mutation at the router level

Refund predicate. `APIConnectionError` refunds; a provider 429 does not. Two cases, and inverting the predicate has to
fail both

Holding. Every key exhausted with 2 seconds to the boundary and `quota_max_wait_seconds: 75`: assert the call returns a
real response and no 429 is raised. Then a day-exhausted pool: assert a 429 with a `retry-after` matching seconds to
local midnight, not 5. Then assert cancellation during a hold does not leave a pending task

Transparency. The whole feature's acceptance test: drive a pool whose combined per-minute capacity is below the offered
load and assert that across the run the client saw zero 429s while the counters show the caps were respected
