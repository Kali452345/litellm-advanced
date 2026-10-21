# Render as extra egress

Anonymous free-tier quota is keyed to the egress IP, so one server IP is one
allowance. A Render Free web service gives you another IP for $0. This page sets
that up without touching the LiteLLM config: the instance runs `ocproxy` in
`--no-direct` relay mode, and the litellm host adds it to `egress.txt` like any
other tunnel.

Two things to know before you start:

- Render Free web services **spin down after 15 minutes with no inbound traffic**
  and take about a minute to come back. The cron job below is what keeps it awake.
- Render's egress is a shared cloud range. Some datacenter ranges get `403
  FreeTierError` from the gateway. **Test step 4 before building more of these.**

Each service stays inside the 750 free instance-hours per month only if it runs
alone (744 h). A second always-awake relay needs a paid plan or a part-time
schedule on one of them.

## 1. Put the repo on GitHub

Render builds from git. Push this project (the `ocproxy/` directory is all that
gets built, via `dockerContext`).

## 2. Create the Blueprint

Render dashboard → **New → Blueprint** → pick the repo → Blueprint Path
`ocproxy/render.yaml` → apply.

`OC_KEY` is asked for and left blank in git. Generate it on the litellm host:

```bash
openssl rand -hex 24
```

Paste it into the Render env var field. Keep it; the cron needs the same value.

Region matters: put the service in the region closest to you, not to the
litellm host — the relay hops add to every request.

## 3. Register the host and the cron

On the litellm host:

```bash
install -d ~/.config/ocproxy
printf 'ocproxy-egress-1.onrender.com %s\n' '<the OC_KEY you pasted>' >> ~/.config/ocproxy/render-hosts
chmod 600 ~/.config/ocproxy/render-hosts
crontab -e
```

```cron
*/5 * * * * OC_RENDER_HOSTS=$HOME/.config/ocproxy/render-hosts $HOME/litellm-advanced/ocproxy/render-keepalive.sh >> $HOME/render-keepalive.log 2>&1
```

Five minutes is safely inside the 15-minute spin-down window. The script pings
`/healthz` (unauthenticated on purpose), appends the relay to `egress.txt` when
it is healthy, and removes it after three consecutive failures — slow enough to
ride out a cold start.

`egress.txt` is hot-reloaded by the running `ocproxy`, so no restart is needed.
Check it took:

```bash
tail -3 ~/litellm-advanced/egress.txt
docker exec litellm-advanced-ocproxy-1 sh -c 'wget -qO- --header="authorization: Bearer $OC_KEY" http://127.0.0.1:8788/healthz'
```

`proxies` should now be at least 1.

## 4. Verify the egress is actually usable

A tunnel that connects is not the same as an IP the gateway accepts:

```bash
docker compose -f ~/litellm-advanced/docker-compose.prod.yml exec ocproxy \
  sh -c 'grep -i "static-probe\|connect" /data/ocproxy.jsonl | tail -5'
```

- `static-probe status 200` → the Render IP works, keep it.
- `403` → that IP is on a blocked range. Recreate the service (new IP) or move
  region, then re-check.
- `429` → it works but is already spent; still useful once it resets.

## Notes

- Requests still try the server IP first. The relay is only used after the server
  IP returns 429/403, so it does not add latency to normal calls.
- `OC_CONNECT_ALLOW` keeps the relay closed: only `opencode.ai:443` is tunnelled.
- `--no-direct` is implicit in that setup — the instance would otherwise spend the
  Render central IP instead of its own.
- Tear down with Blueprint → delete, then remove the line from `render-hosts`; the
  cron drops it from `egress.txt` on the next run.
