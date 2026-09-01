# Phase 5: UI for pools and quotas

"An interface for adding the providers and apis where you can save profiles so you do not need to type or enter the base
url and etc things a second time", plus somewhere to put the per-minute and per-day limits and see whether they are
being hit

## What already exists, and why this phase is small

The add-model form already fans out. `handle_add_model_submit.tsx:29-31,209-218` loops `modelMappings` and issues one
`POST /model/new` per mapping, so ticking the six models a key supports already creates six deployments. `/model/new`
takes one `Deployment` per call with no bulk variant
(litellm/proxy/management_endpoints/model_management_endpoints.py:1725-1728), and the client-side loop is the accepted
way to do it today

Provider profiles also mostly exist. The Credentials feature stores a named, DB-persisted, per-value-encrypted auth bag
in `LiteLLM_CredentialsTable`, referenced from a deployment by `litellm_params.litellm_credential_name`, with CRUD
endpoints and a `CredentialsPanel` and `CredentialModal` already built. So "do not make me type the base url again" is
answered by picking an existing credential, which `ModelInfoEditForm.tsx:630-633` already renders as a dropdown

One hard constraint on that: `credential_info` is **not** encrypted, only `credential_values` is, per value. Nothing
secret may ever be written to `credential_info`

So this phase is three additions and no new plumbing: quota fields on the forms, a pools view over the deployments that
already exist, and a usage column

## Quota fields

`ModelInfoEditForm.tsx:533-534` already renders TPM and RPM through a `numberField` helper, with the shape declared at
:83-84 and :119-120 and the defaults read from `litellm_params` at :214-215. Add RPD the same way, plus a timezone select
for `quota_reset_timezone` defaulting to UTC. Mirror both into the add-model form's advanced settings so a key can be
created with its caps rather than edited afterwards

Label them for what they are. These are per-key caps, and an operator who reads "RPM" as a pool-wide limit will
configure the pool wrong. "Requests per minute (this key)" costs nothing and prevents that

The timezone control should offer the IANA names `zoneinfo` accepts and reject anything else client-side, matching the
server-side validation from phase 1. A silently-wrong timezone means a key resetting at the wrong hour for as long as
nobody notices

## Pools view

A new tab on `models-and-endpoints`, alongside the existing slugs (`page.tsx:30-39` for `ModelTabSlug`, `:43-53` for
labels, `:55-80` for `renderPanel`, `:104-122` for visibility)

It is derived, per the decision already made: no new table, no migration, no new state. Group the deployments the page
already fetches by `model_name` and render one row per pool with its member keys underneath. Each member shows its
provider and api_base, its caps, its live usage, and its cooldown state

`model_name` is the grouping key rather than (provider, api_base, model) because the model group is what the router
actually treats as a pool, per the topology decision in the README. A pool spanning two providers has to render as one
row, otherwise the per-minute roll-up below would report two half-pools and understate the capacity an operator is
asking about. Provider and api_base stay per-member, which is all the prefill needs

The two actions worth having:

"Add another key to this pool" opens the add-model form prefilled from a sibling member, with every field carried over
except the secret. That is the literal answer to not typing the base url twice, and it costs one prefill object because
the form already accepts initial values

"Add a model to this key" opens the same form prefilled with the key's existing configuration and the model list
pre-ticked, so extending coverage does not mean re-entering the credential

One warning has to be surfaced in the edit path, not buried in docs. `generate_model_id` is a sha256 over the model group
plus resolved litellm params (router.py:8107), so changing a key's `api_key` in place changes its deployment id and
orphans its cooldown state, its affinity pins, and its spend history. Rotating a secret and adding a key are different
operations with different consequences, and the UI is where that distinction has to be legible

## Usage column

Per member: requests used this minute against the cap, requests used today against the cap, and whether the key is
currently skipped. Phase 6 adds the endpoint this reads

A key's usage is per credential, not per deployment, so one key that serves several model names shows the same numbers in
every pool it appears in, and traffic sent to one of those pools moves the bar in all of them. Say so in the column
header, because an operator watching a bar climb while their pool sits idle will otherwise read it as a bug

Keep it honest about staleness. These counters move every second and a table that looks live but is thirty seconds
stale is worse than one that shows its age, so render the fetch time. Poll on an interval through TanStack Query rather
than pushing, since there is no stream for this and adding one is not worth it

Show a pool-level roll-up too: combined capacity per minute against combined usage. That single number is what tells an
operator whether the pool can carry the offered load, which is the actual question behind the whole feature

## Files

| File | Change |
|---|---|
| `models-and-endpoints/page.tsx` | New tab slug, label, panel, visibility |
| `components/model_pools/PoolsPanel.tsx` | New. The derived pools table |
| `components/model_pools/groupDeploymentsIntoPools.ts` | New. Pure grouping and ranking, unit-tested on its own |
| `components/ModelInfoEditForm.tsx` | RPD and timezone fields, schema entries, defaults |
| `components/add_model/advanced_settings.tsx` | Same two fields on create |
| `components/add_model/handle_add_model_submit.tsx` | Pass the new params through |
| `src/lib/http/schema.d.ts` | Regenerated, never hand-edited |

After the phase 6 endpoint lands, run `npm run gen:api` and commit the result. CI's `Check UI API Types Sync` enforces
it

## Tests

Follow the three-tier split in `ui/litellm-dashboard/CLAUDE.md`, and put the logic where it can be tested cheaply

`groupDeploymentsIntoPools.test.ts` is where the real coverage goes, as a unit test with no rendering. Deployments
sharing a `model_name` group into one pool. A pool spanning two providers stays one pool with both members labelled by
their own provider, which is the assertion that fails if grouping regresses to keying on api_base. Two different
`model_name` values never merge. Ranking is stable so the table does not reshuffle between polls. Ratio maths is right,
including a member with no configured cap and a member at exactly its cap

`PoolsPanel.integration.test.tsx` earns its seconds only for wiring a unit test cannot reach: the network boundary is
stubbed, a pool renders with its members, and "add another key to this pool" opens the form with the sibling's api_base
prefilled and the api_key field empty. That last assertion is the requirement, so it belongs in a real render

`ModelInfoEditForm` gets one case asserting RPD reaches `litellm_params.rpd` in the submitted payload, and one asserting
an invalid timezone blocks submission. If the payload building is worth more than that, extract it the way
`createServerPayload.ts` was extracted and unit-test it there

Use `fireEvent.change` for fields that just need a value. `user.type` re-renders the form per keystroke and is only
worth it where typing itself is the behaviour. Pass plain strings to `toHaveTextContent`, never a constructed RegExp.
Run only the paths you touch; never the bare suite
