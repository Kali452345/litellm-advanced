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

The same form is reachable from a deployment, not only from the provider row. Every row on the models
table carries an Add another key button that resolves the profile behind that deployment and
preselects only the model that was clicked, so a second key for one model is a paste rather than a
second walk through Add Model. Matching is on `litellm_params.model` plus the base url, never on the
provider name the table shows, because that name falls back to `openai` whenever the cost map does not
know the model and would attach the key to the wrong pool. A deployment no profile covers, a caller
who is not a proxy admin, and a profile list still loading each disable the button and say which one
it is, so the row never opens a form the proxy would reject

`api_base` on `POST /provider/keys` is a tri-state: omitted inherits the provider's, an explicit null
means the provider's own default url, and a string is that url. Without the null case a provider
reached at both a custom url and its own default could not receive a key at the default at all, since
resolution refuses to guess between two base urls and 400s. Clearing the prefilled base url in the
form is what sends null, so keeping it, changing it and clearing it are three different requests

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
usage panel is its own piece of work rather than a footnote to this one. It arrived with the
dashboard trim, as the Key Rotation page

Costs, accepted. `usage` returns a row per deployment, including the unmetered ones, so a caller
can zip the rows back onto its own list; that means the endpoint groups by model name itself
rather than getting groups back. One batched counter read per call, which is the same read
`availability` was already doing. And one `reportUnknownMemberType`, from reading
`Router.model_list`, which is a bare `list` upstream, the same cost and the same Pydantic
adapter at the boundary as phase 5

## Phase 7, the flag survives a router built from the database: done

`QuotaRoutingSettings` in `enforcement.py`, resolved at the end of `Router.update_settings`, so
`enable_quota_routing` and `quota_max_wait_seconds` land on a router that is already built

Which is the whole point of phase 5's interface. A proxy whose config has no `model_list` builds
its router from the models in the database, in `_update_llm_router`, with none of the quota kwargs,
and then applies the config-file and database `router_settings` to it through `update_settings`,
whose allow-list dropped both names. So a pool set up entirely in the Provider Keys tab rotated
with nothing enforced and `/model/quota/usage` reported `enforced: false`, while the identical
pool written into a config file was enforced

Settings that mention neither field leave the enforcer exactly as it is, so an unrelated settings
save cannot quietly switch enforcement off, and a wait on its own never turns it on. Re-sending
the flag alone keeps the enforcer already in use rather than rebuilding it at the default wait. A
changed wait rides onto that same enforcer through `with_max_wait`, which shares the counter, the
clock and the sleep, because `_add_router_settings_from_db_config` runs on every pass of the
add-deployment loop and rebuilding there would drop the lock the in-memory reservation holds
across its read and its increment. A rebuild that does happen runs on the router's own cache, so
what a pool has already spent this minute survives one

Reading is lenient and per field. What arrives here is the whole combined `router_settings`
mapping, which can hold `redis_password`, so only these two keys are ever looked at, a value that
cannot be read is logged by field name and never by value, and a malformed database row costs that
one setting instead of failing proxy boot. Per field rather than per mapping because a wait typed
as `75s` would otherwise take the flag down with it, and the flag is what decides whether a pool
is capped at all. Deliberately not added to `_allowed_settings` or `get_settings`: neither name is
a plain attribute on the router, and the enforcer is the state they resolve to

One cost, and no new type diagnostics. `update_settings` takes `**kwargs` untyped, so the mapping
is validated through a `TypeAdapter` at the call site rather than passed straight in, which trades
a copy of about ten keys per settings apply for the `reportUnknownArgumentType` that phases 3 and 4
had to accept. Declaring a local instead makes it worse, since pyright reports the narrowed type

## Phase 8, the switch itself: done

`enable_quota_routing` and `quota_max_wait_seconds` reach a running proxy from the Key Rotation
page through `POST /config/update`, so turning rotation on involves no config file and no restart

Which is what phase 7 left unfinished. It made both settings survive a router built from the
database, and the only writer was still a text editor. Phase 5's interface covers adding keys but
not switching on the thing that makes their caps mean anything

`UpdateRouterConfig` gained both fields, since that is what `/config/update` validates a
`router_settings` body against and what its per-key merge writes into the row. The merge is
`{**existing, **payload.dict(exclude_none=True)}`, and that exposed a defect worth its own
regression test: `model_group_alias` defaulted to `{}` rather than `None` on that model, so every
partial write of any router setting, from any panel, was quietly resetting whatever aliases were
stored

Both keys always go together on the wire. `QuotaRoutingSettings.enforcer` reads a missing flag as
leave enforcement alone, so a budget sent on its own would land on a router with enforcement off
and read back as a number nobody asked for

The read side had to be honest about that. `quota_usage_of` builds a throwaway enforcer when the
router has none, which is how the caps still come back while the flag is off, and that enforcer
carries the default budget, so a budget saved while enforcement is off could never be shown as
the one in force. `ModelQuotaUsageResponse` now reports `max_wait_seconds` off whichever enforcer
answered, and the page disables the budget field while the draft has enforcement off. The form
logic ignores that field's text entirely in that state, so a half-typed number can never trap an
operator into being unable to switch enforcement off

The logic is a module rather than a component. `quotaSettingsForm.ts` is a tagged union over
loading, unchanged, invalid and ready, with the payload a save would send carried on the ready
arm, covered by 19 unit tests that run in 18ms. The integration test keeps only the five cases
that prove a field reaches the right payload key, which is the dashboard's own rule about logic
reachable only through a render

Deliberately not shipped: the rest of `router_settings`. This page is Key Rotation, and every
other field would need the same read-back argument settled before a switch for it could be
trusted. Also no optimistic update. The save awaits the refetch and the local draft is cleared
after it, so the field never flicks back through the old value on its way to the new one

No new type diagnostics on either side. `QuotaSettingsUpdate` derives both of its field types from
the generated schema, as `NonNullable<RouterSettings["..."]>`, so a rename in the OpenAPI contract
fails compilation. A hand-written interface would not catch it: the body is passed as a variable,
and excess-property checking only applies to an object literal

## Phase 9, measuring a cap the provider will not publish: done

`POST /provider/rate_limit/probe` in
`litellm/proxy/management_endpoints/provider_rate_limit_endpoints.py`, proxy-admin only, and a Test
the limit card under the two cap fields in the Add another key form. It sends requests to one key
until the provider refuses one, and reports how many it accepted before that

Which is what phases 5 and 8 both assumed away. A profile copies the caps the keys already there
were given, Add Model takes a figure typed in, and the Key Rotation page enforces whatever those two
produced, so every path to an `rpm` traces back to a number the provider published. Plenty of free
tiers never publish one, and a guess is either throughput left on the table or the 429 storm the
pool was built to avoid

It calls `acompletion` directly with the key rather than going through the router. The router would
reserve quota for each of these requests and would fail the measurement over onto a different key at
exactly the point the refusal was about to arrive, so the reading would be of the pool rather than of
the key. The walk also has to fit inside one minute, since a minute rolling over refills the
allowance and no refusal would ever come: waves of 4 against a 50 second deadline, one character of
prompt and `max_tokens=1`, so a reading costs about as little as real requests can

Five outcomes, and only one of them licenses a number. `rate_limited` is the cap. `already_limited`
is a key that refused the very first wave, so nothing was measured, and it is the one worth being
careful about: its accepted count is 0, and a 0 read as a cap would write `rpm: 0` and take the key
out of the pool for good. `ceiling_reached` and `deadline_reached` are floors, `refused` is any other
provider failure with the probed key redacted out of the message, and none of those four offers a
number to type in. Two more fields decide which field a number belongs in when there is one:
`tokens` or `concurrent_requests` says the ceiling that was hit is not counting requests per minute,
and a retry-after longer than a minute says the count is the per-day cap rather than the per-minute
one

The walk is a pure recursion over an injected attempt and an injected clock, so its 16 tests measure
a fake provider at a fake time instead of sleeping or reaching a network. The dashboard half splits
the same way: `planRateLimitProbe` refuses to spend anything without a key and a model the provider
actually serves, `readRateLimitProbe` turns an outcome into a headline, a detail and a nullable fill,
and the two carry 22 unit tests that run in 11ms. `RateLimitTester.tsx` holds only the note, and
reads the form through an injected thunk at click time rather than watching it, so typing the key
does not re-render the modal on every keystroke

Deliberately not shipped: writing the measured number straight onto the deployment. The button fills
the form field and the operator still presses Add Key, because three of the five outcomes report a
floor and one reports nothing, so a probe that quietly set a cap would be setting a wrong one most of
the time it ran. Also no sweep across a provider's models or across a pool's keys. A per-minute cap
is counted per key at one model, and a sweep would multiply real spend by the size of the pool to
learn the same figure

Costs, accepted. The probe spends the key's allowance and real money, which is why it is admin-only
and why the card says so above the button. One `# mutable-ok` for the messages list litellm types as
`list`, one `reportUnknownVariableType` ignore on the `acompletion` import for that same bare list,
and one broad `except Exception` with a `noqa`, since every way a provider can fail is a reading here
rather than a crash

## Phase 10, keeping the refusals and reading the caps out of them: done

`litellm/proxy/spend_tracking/deployment_error_logs.py` writes one row per failed provider attempt,
`observed_rate_limits.py` reads the caps back out of them, `GET /provider/rate_limit/observed` serves
that, and the Key Rotation page says it per key next to the cap in force

Phase 9 measures a cap by spending money on purpose. This one gets the same figure for free, off
traffic already paid for, and keeps getting it as a provider moves a cap under a key. What makes it
possible is that a rotating pool hides its failures by design: the request a spent key refused is
retried on another one and the caller sees a success, so the refusal is gone the moment the retry
lands unless something writes it down

Rows land in `LiteLLM_ErrorLogs`, a table the proxy already reads in three places and has never
written, so there is no migration and the exception panels that were reading an empty table light up
as a side effect. `request_kwargs` carries what the table has no column for: whether quota routing
was enforcing, and how much of each window the refused key had spent. Nothing derived from an api key
goes in, so a key is identified the way the rest of the quota surface identifies one, by deployment
id and base url

Two things make that count trustworthy. It is read at the instant of the failure, which
`litellm.utils` awaits inline before the router retries, so the counter still holds this attempt's own
increment. And the row records whether enforcement was on, because a count of zero from a pool with
enforcement off means nothing was counting rather than that the provider refused the first request.
The write itself is buffered and drained by one debounced task, since that same inline await is on the
failover path and an insert there would slow every retry the pool makes

The reading is `min(used) - 1`: a refusal recorded at a count of six proves the provider accepted
five. Many refusals give many bounds and the tightest wins, and the lowest and highest counts are
both reported, since a spread says the ceiling moves while one repeated number says it is a hard cap.
Two readings prove nothing and are set aside rather than averaged in, a refusal logged with
enforcement off and a count of zero from a window that rolled over, and `unmetered_refusals` reports
how many, which is what tells "every cap is right" apart from "nothing was measuring"

The page judges each window against the cap the router is enforcing now, not the one that was
configured when the refusal landed, because raising that cap is exactly what the view is read to do.
A verdict of `nothing_fits` is its own case: the first request of a window was refused, so no
per-window cap sits under that ceiling and rotation is the only way out

Deliberately not shipped: applying the reading. The page names the gap and an operator still edits
the cap, for the same reason phase 9's button only fills a field. Nothing prunes the rows either,
which is a real gap and the follow-up worth doing first

