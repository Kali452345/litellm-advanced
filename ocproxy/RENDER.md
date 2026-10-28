# Render as extra egress

Anonymous free-tier quota is keyed to the egress IP, so one server IP is one
allowance. A Render Free web service gives you another IP for $0: the instance
runs `ocproxy` and the router treats it as a second deployment of the same model.

Render sits behind Cloudflare, which answers `CONNECT` with `400`, so a Render
instance is **not** a raw proxy — it is used as a plain OpenAI endpoint, and
`egress.txt` is not involved. Hosts that do speak `CONNECT` (another VPS via
`tunnels.sh`) still go through `egress.txt` instead.

Three constraints before you start:

- Free web services **spin down after 15 minutes with no inbound traffic** and
  take about a minute to return. The cron below keeps the instance awake.
- Render egress is a shared cloud range. Some ranges get `403 FreeTierError`.
  **Check step 4 before adding more.**
- 750 free instance-hours per month, per workspace. One always-awake service is
  ~744 h, so keep exactly one and suspend the rest.

## 1. Deploy

Blueprint (needs a card on file in some workspaces):

```
https://dashboard.render.com/blueprint/new?repo=https://github.com/Kali452345/litellm-advanced
```

Set **Blueprint Path** to `ocproxy/render.yaml`. `OC_KEY` is `sync: false`, so
Render prompts for it. Generate one on the litellm host:

```bash
openssl rand -hex 24
```

The CLI path used for this deployment bypassed the card gate:

```bash
render services create --type web_service --name ocproxy-egress-1 --runtime docker \
  --plan free --region frankfurt --repo https://github.com/Kali452345/litellm-advanced \
  --branch litellm_quota_foundation --root-directory ocproxy \
  --health-check-path /healthz --env-var "OC_KEY=<key>" --confirm
```

Afterwards set the start command, because the CLI cannot pass it for Docker:

```bash
MSYS_NO_PATHCONV=1 render services update <srv-id> --health-check-path /healthz
curl -X PATCH -H "authorization: Bearer <token>" -H 'content-type: application/json' \
  -d '{"serviceDetails":{"envSpecificDetails":{"dockerCommand":"node serve.mjs --host 0.0.0.0"}}}' \
  https://api.render.com/v1/services/<srv-id>
```

## 2. Register it as a deployment

`config.yaml` carries the second entry; only the key is environment-specific:

```yaml
  - model_name: deepseek-v4.1-flash-free
    litellm_params:
      model: openai/deepseek-v4.1-flash-free
      api_base: https://<service>.onrender.com/v1
      api_key: os.environ/RENDER_OC_KEY
```

`RENDER_OC_KEY` goes in the litellm host's `.env`, next to `OC_KEY`. Set
`STORE_MODEL_IN_DB=False` or the DB copy of the model list wins over the file.

## 3. Keep it awake

```bash
install -d ~/.config/ocproxy
printf '%s %s ping\n' <service>.onrender.com <key> >> ~/.config/ocproxy/render-hosts
chmod 600 ~/.config/ocproxy/render-hosts
crontab -e
```

```cron
*/5 * * * * OC_RENDER_HOSTS=$HOME/.config/ocproxy/render-hosts $HOME/litellm-advanced/ocproxy/render-keepalive.sh >> $HOME/render-keepalive.log 2>&1
```

`ping` mode only keeps the instance warm. Use `egress` mode (third column) for a
host that speaks `CONNECT`; that mode also writes the entry to `egress.txt` and
drops it after three consecutive failures.

## 4. Verify

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://<service>.onrender.com/healthz
curl -s https://<service>.onrender.com/v1/chat/completions \
  -H "authorization: Bearer <key>" -H 'content-type: application/json' \
  -d '{"model":"deepseek-v4.1-flash-free","messages":[{"role":"user","content":"hi"}],"max_tokens":4}'
```

A `200` with real content means that IP is accepted. `403` means the range is
refused — recreate the service (new IP) or change region. `429
FreeUsageLimitError` means it works but its allowance is spent.

## Tear down

Delete the Blueprint/service, remove its `model_list` entry, drop the line from
`render-hosts`, and remove `RENDER_OC_KEY` from `.env`.
