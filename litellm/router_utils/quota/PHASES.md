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

## Phase 3, stickiness and ranking: next

Move the quota filter above `async_callback_filter_deployments` so a spent credential never reaches
the affinity and prompt-caching checks, clear the affinity pin when the pinned deployment is gone,
then add least-used-first ranking scored on the worst window ratio so a pool drains evenly once
stickiness has nothing left to protect

## Phase 4, failover across keys and providers: not started

An error on one key must re-dispatch to the next key, then to the next provider, inside the same
request, without the harness seeing the failure. Weighted failover already carries the exclusion
list; this phase makes it the default for a quota pool

## Phase 5, the setup interface: not started

Saving a profile per provider and per key: base url, key, the models that key serves, and optional
per-minute and per-day limits, so none of it is retyped for the next key. Profiles come from
existing deployments, no new table. `credential_info` in `LiteLLM_CredentialsTable` is not
encrypted, only `credential_values` is, so no secret may ever be written there

## Phase 6, visibility: not started

`GET /model/quota/usage` for what each pool has left, docs, and a live-proxy curl proof against real
provider keys
