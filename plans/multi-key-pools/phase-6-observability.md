# Phase 6: observability, docs, and proof against a live proxy

The endpoint the UI reads, the docs, and the artefact that actually demonstrates the feature works. This repo does not
accept pytest output as proof, so the deliverable here is a short list of curl commands against a real proxy hitting
real provider APIs

## The usage endpoint

`GET /model/quota/usage` returning, per deployment: model id, model group, provider, minute used and cap, day used and
cap with its timezone, whether the key is currently skipped, and when its next window resets. Reads through the same
`peek` from phase 1, so there is exactly one definition of what the counters mean and no second copy to drift

Read-only and never returns a secret. Deployment id, provider and api_base are fine. The key itself, and any masked
form of it that could confirm a guess, are not. That includes phase 1's `scope` value: it is an HMAC of the key, so
returning it would let anyone holding a guessed key check the guess against the response

Because counters are credential-scoped, several deployments in the response will legitimately report identical usage
numbers, which is correct rather than a bug: one key serving six models has one minute budget. Group the response by
scope so the UI can render one usage bar per key instead of six copies of the same one, keyed by an opaque per-response
index rather than by the scope value itself

Auth on it should match `/model/info` rather than being more permissive, since knowing which of an operator's keys are
exhausted is operationally sensitive

`/model/metrics` already exists in `schema.d.ts` and is unused by the dashboard. Worth five minutes checking whether it
can carry this before adding a route, since one fewer endpoint is better than a tidier name

After the route lands, run `npm run gen:api` in `ui/litellm-dashboard` and commit the regenerated `schema.d.ts`. CI's
`Check UI API Types Sync` will fail otherwise, and the file is generated so it must never be hand-edited

## Docs

One page under `docs/my-website/docs/` covering the pool shape, the three settings, and the two things that will
otherwise be learned the hard way: that a static `cooldown_time` on a quota-managed deployment clobbers the
window-aligned cooldown, and that changing a key's secret in place changes its deployment id and orphans its state

Include the whole config in one block, because that is what gets copied:

```yaml
router_settings:
  routing_strategy: least-used
  optional_pre_call_checks: ["enforce_request_quotas", "prompt_caching", "session_affinity"]
  enable_weighted_failover: true
  quota_max_wait_seconds: 75
  num_retries: 2

litellm_settings:
  cache: true
  cache_params:
    type: redis

model_list:
  - model_name: pool
    litellm_params:
      model: provider-a/some-model
      api_key: os.environ/PROVIDER_A_KEY_1
      rpm: 5
      rpd: 200
      quota_reset_timezone: America/Los_Angeles
```

Say plainly that `rpm` and `rpd` are per-key caps rather than pool-wide, since that is the single most likely
misconfiguration

Also document why Redis is optional but recommended: without it the counters are per-process, so two proxy workers each
enforce their own copy of a 5/min cap and the real ceiling is 10

## Proof against a live proxy

Per the repo's rules, this is curl against `localhost:4000` hitting real provider APIs and costing real money, not a
test script and not mocks. Start the proxy with:

```bash
python litellm/proxy/proxy_cli.py --config litellm/proxy/dev_config.yaml --detailed_debug --reload --use_v2_migration_resolver 2>&1 | tee litellm.log
```

Six things to demonstrate, in order, each one a command whose output is the evidence:

1. Pool is assembled. `GET /model/info` shows N deployments sharing one `model_name`
2. Caps are visible. `GET /model/quota/usage` shows every key at zero with its configured caps
3. Stickiness holds. A `for` loop of ten identical requests carrying one `x-litellm-session-id`, then
   `GET /model/quota/usage` showing all ten landed on one key. This is the assertion behind "keep using that rather than
   rotating randomly"
4. Exhaustion skips and self-heals. Drive a key past its `rpm` and show the usage endpoint marking it skipped, then show
   traffic continuing on siblings, then show it eligible again after the minute rolls. Zero 429s in the client output
   throughout, which is the "without the agent harnesses knowing" requirement
5. Failover is immediate. Point one key at a deliberately broken api_base, send a request, and show a 200 back plus the
   response header naming a different deployment. The timing in the output is the evidence there was no backoff
6. Daily cap holds across minutes. Set `rpd` low, exhaust it, wait past a minute boundary, and show the key still
   skipped. This is the one that fails if the day counter is keyed on the minute

For the UI, list the URLs and the clicks rather than describing screenshots: `http://localhost:4000/ui/` for the pools
tab with the usage column mid-load, and the add-model form opened via "add another key to this pool" showing api_base
prefilled and api_key empty

## Gates before opening the PR

`make check` holds one of two machine-wide slots and can queue behind other sessions. Give it a long timeout and let it
wait; killing and retrying it just puts you back in the queue. Its full output goes to a log file in `.git` whose path
it prints first and last, so inspect that log rather than re-running the multi-minute checks to see a different slice

If any fix lands against `ruff-strict-budget.json`, `type-discipline-budget.json`, or `basedpyright-code-budget.json`,
run `make lint-budget-update` with exactly the fixes being committed in the tree and commit the lowered ceilings

New code has to satisfy the conventions the phases assume: `Final` on every variable (LIT010), no parameter rebinding
(LIT011), `ReadOnly[...]` on every TypedDict field (LIT012), no mutable accumulation (LIT001/LIT002), and no bare
`Any`. Where an external shape is genuinely untyped, validate it in the caller with a Pydantic model or `TypeAdapter`
and pass the typed value in, rather than widening a signature and pushing `reportAny` toward its ceiling

`# type: ignore` is banned and does nothing, since `enableTypeIgnoreComments` is false. Every suppression names its rule
in brackets and carries a reason

## PR

Read `.github/pull_request_template.md` from disk before writing the body. Harnesses strip HTML comments from injected
copies, and the comments in that file are rules rather than layout. Base the branch on `litellm_internal_staging`,
prefix it `litellm_`, no slashes, conventional-commit title, and no Claude attribution anywhere in the commits or the
description
