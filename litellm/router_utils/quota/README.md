# Several API keys behind one model name

A provider's free tier is metered per account, so the way to get more throughput out of
free tiers is to hold several keys and rotate between them. This package makes that a
routing concern rather than something the caller has to know about: keys are pooled
under one model name, a key with no allowance left in the current minute or day is never
sent to, and an error on one key re-dispatches to the next key inside the same call. A
harness driving the proxy asks for one model and gets one answer

## Turning it on

`rpm` and `rpd` on a deployment become hard caps only when the router is built with
`enable_quota_routing`. Without it, `rpm` keeps its older meaning as a simple-shuffle
weight, and the proxy logs a warning at startup if any deployment declares quota params
while the flag is off

```yaml
router_settings:
  enable_quota_routing: true
  quota_max_wait_seconds: 75

model_list:
  - model_name: fast
    litellm_params:
      model: gemini/gemini-2.5-flash
      api_key: os.environ/GEMINI_KEY_ONE
      rpm: 10
      rpd: 250
  - model_name: fast
    litellm_params:
      model: gemini/gemini-2.5-flash
      api_key: os.environ/GEMINI_KEY_TWO
      rpm: 10
      rpd: 250
  - model_name: fast
    litellm_params:
      model: groq/llama-3.3-70b-versatile
      api_key: os.environ/GROQ_KEY_ONE
      rpm: 30
      rpd: 1000
```

Three deployments, one public name. Requests go to the first pool member with room, and
once every Gemini key is spent for the minute the same name keeps working through Groq

## The deployment params

| Param | What it does |
| --- | --- |
| `rpm` | Requests one credential may make per minute. Also readable from `model_info.rpm` or the top-level `rpm` |
| `rpd` | Requests one credential may make per calendar day |
| `quota_reset_timezone` | Which zone's midnight ends the day window, as an IANA name like `America/Los_Angeles`. Defaults to UTC. Minute windows ignore it, since every offset in use is a whole number of minutes |
| `quota_scope` | `credential_model` (the default) meters each model of a key separately, which is what a provider that publishes a per-model limit does. `credential` meters a key's whole allowance across every model it serves |
| `quota_scope_id` | Says two deployments spend from one account, so they share one counter. Set it when the same key reaches a provider at two base urls, or when two keys belong to one metered account |

Counters key on the credential rather than the deployment, because a deployment id hashes
the model group into itself: one key serving six model groups yields six ids, and a 5/min
key would otherwise be enforced as 5/min six times over. `quota_scope_id` is the escape
hatch for the reverse case, where two deployments look like two credentials but are one

The salted digest that identifies a credential is derived from `LITELLM_SALT_KEY`, falling
back to `LITELLM_MASTER_KEY`. It is never logged and never returned by an API, so a Redis
key name cannot be used to confirm a guessed API key

## What a request does

Selection reads every candidate's counters in one batched round trip and drops the
credentials whose minute or day allowance is spent. That happens before the affinity and
prompt-caching filters, because those narrow a group down to one deployment, and a pin
landing on a spent key would otherwise empty the group and fail a request the other keys
had room for

What survives is ranked most-spent-first. That is stickiness rather than fairness: a pool
drains one credential before it touches the next, so a conversation keeps landing on the
same key and the provider's prompt cache keeps hitting. Round robin would cold-miss that
cache on every request. Deployments with no cap configured rank last, which leaves them as
the overflow a spent pool spills into

The pick is then reserved atomically, so two concurrent requests cannot both take the last
slot: the loser falls forward to another candidate instead of failing. A request that
never reaches the provider gets its slot refunded against the window it charged, and a
request that fails at one key records that key and re-dispatches to the next one, on into
the next provider once the first provider's keys are gone. Keys walked per request is
`num_retries + 1`, so a pool deeper than that is walked by raising `num_retries`

When every key is spent and a minute window rolls over within `quota_max_wait_seconds`,
the request is held rather than failed. A day cap never resolves inside that budget, so it
falls straight through and the caller fails fast

With Redis, reservations run as one Lua script per request and the pool is shared across
proxy instances. Without it, the same logic runs against the in-memory cache under a lock,
which enforces caps per process. That is the normal SDK case, not a degraded mode

## Seeing what a pool has left

`GET /model/quota/usage` reports every pool, every key in it, and what each key has spent
against each window it meters

```bash
curl -s -X GET 'http://0.0.0.0:4000/model/quota/usage' -H "Authorization: Bearer $LITELLM_MASTER_KEY"
```

```json
{
  "enforced": true,
  "pools": [
    {
      "model_name": "fast",
      "exhausted": false,
      "seconds_until_room": null,
      "keys": [
        {
          "model_id": "3f2c...",
          "litellm_model": "gemini/gemini-2.5-flash",
          "api_base": null,
          "exhausted": true,
          "seconds_until_room": 24,
          "windows": [
            { "kind": "rpm", "limit": 10, "used": 10, "remaining": 0, "seconds_until_reset": 24, "timezone": "UTC" },
            { "kind": "rpd", "limit": 250, "used": 31, "remaining": 219, "seconds_until_reset": 40125, "timezone": "UTC" }
          ]
        },
        {
          "model_id": "8ab1...",
          "litellm_model": "gemini/gemini-2.5-flash",
          "api_base": null,
          "exhausted": false,
          "seconds_until_room": null,
          "windows": [
            { "kind": "rpm", "limit": 10, "used": 3, "remaining": 7, "seconds_until_reset": 24, "timezone": "UTC" },
            { "kind": "rpd", "limit": 250, "used": 3, "remaining": 247, "seconds_until_reset": 40125, "timezone": "UTC" }
          ]
        }
      ]
    }
  ]
}
```

The first key is spent for this minute and the pool is not, because the second key has
room, which is the rotation working rather than a failure. A pool reports `exhausted` only
when every key in it is spent, which is the state where a request actually fails, and
`seconds_until_room` only then, since that is the only point where waiting is honest. A key
with no cap reports no windows, and keeps its pool alive. `enforced: false` means the
router was built without `enable_quota_routing`, so the caps below it are what is
configured while nothing counts against them

There is deliberately no requests-remaining total per pool. Two deployments can share one
counter, through `quota_scope_id` or through the same key added twice, and a total would
double count them. An exhaustion flag is dedupe-immune and is what routing itself acts on

## Adding the keys

`GET /provider/profiles` reports what each provider is already set up with, and
`POST /provider/keys` puts another key behind it in one call, creating one deployment per
model that provider serves so the new key joins the pools the old ones rotate through. The
base url, the api version, the models and the caps are copied from the deployments that
already exist, so the second key is a paste rather than a retype. `quota_scope_id` is never
copied, because copying it would count the new key against the old key's allowance

In the Admin UI the same thing is the Provider Keys tab under Models + Endpoints. Requests
Per Minute and Requests Per Day are first-class fields on Add Model, and the first
deployment of a provider is what later keys inherit their caps from

## Known gaps

Enforcement is async-only. The sync `get_available_deployment`,
`async_get_available_deployment_for_pass_through`, the `specific_deployment` and
encrypted-content-affinity early returns, and the `usage-based-routing` v1 and `lar1`
strategies all select through paths with no reservation step. The last two log a warning at
startup when quota routing is on

Reads are advisory. `GET /model/quota/usage` and the pre-routing filter can be a request
stale by the time they are acted on, which is why the reservation on the way into the
provider call is the authority on whether a request fits
