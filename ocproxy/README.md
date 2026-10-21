# ocproxy — OpenCode free tier behind a rotating egress pool

`ocproxy` is the bridge between LiteLLM and `opencode.ai`'s free models. It does two
things OpenCode's gateway requires and a plain OpenAI proxy cannot do on its own:

1. It sends the client fingerprint OpenCode itself sends (`user-agent:
   opencode/latest/<ver>/cli`, the `ses_`+12-hex+14-alnum session family, the harness
   system prompt with the canonical tool set, and `stream: true`).
2. It meters its own egress: the host's own IP is tried first because it is fast, a
   429/403 parks it, and requests then walk a pool of egress IPs. A proxy that answers
   429 is parked for six hours. Anonymous quota is keyed to the egress IP, so a new
   IP is a new bucket.

LiteLLM sees one ordinary OpenAI-compatible endpoint at `http://ocproxy:8788/v1`.

## Read this first: free proxies are mostly rejected

The gateway answers **403 `FreeTierError`** — "we've detected abusive traffic from
this IP" — for most datacenter ranges. Observed yield is **0.03–0.5 %** depending on
the day: 6000 candidates produced 2 usable proxies on one pass, 400 produced 2 on
another. That is normal, not a bug in the harvester. Public lists are shared, so many
of their addresses have already been burned by other OpenCode users.

Consequences for running this:

- The pool must be deep before serving is reliable. The harvester keeps retrying
  every 60 s until it has `OC_POOL_TARGET` working proxies, and accumulates them
  across passes.
- Every proxy dies eventually — often within a minute, sometimes after accepting the
  request and going silent. The host IP is the default route; when it is rate-limited,
  requests use the freshest, highest-scoring proxies and retry across them. A proxy
  that produces no first byte is abandoned after 25 s, and an idle stream is closed
  after 90 s with `[DONE]` instead of hanging the client. `--no-direct` makes proxies
  the only route.
- The first minutes after boot will mostly run on the host IP. That is expected.

- 200 — usable, published.
- 429 — reachable; this IP's free bucket is spent. Not published (the harvester only
  publishes 200s), but the serving pool parks it and retries elsewhere.
- 403 — abusive-network block. The pool parks it for 30 minutes; the next harvest
  re-tests it.

Candidates are scored from relayglass CSV metadata: lines whose `org` looks like a
consumer ISP rank above unknown orgs, hosting/cloud orgs rank last, and fast
`response_ms` values rank above slow ones. Validation still decides; the score only
changes what gets probed first.

If the pool is empty, `serve.mjs` uses the host's own IP only. Pass `--no-direct` to
serve only through proxies.

## Layout

| File | Role |
| --- | --- |
| `serve.mjs` | OpenAI-compatible server, owns the fingerprint and the pool |
| `pool.mjs` | proxy health state, cooldowns, least-busy picking |
| `connect.mjs` | HTTP CONNECT / SOCKS5 / SOCKS4 tunnels with auth |
| `upstream.mjs` | shared session/header builder and gate probe |
| `proxy-pool.mjs` | harvests public lists, gate-probes each proxy, atomically publishes |
| `tunnels.sh` | turns SSH hosts into validated static SOCKS tunnels |
| `agent-prompt.txt`, `agent-tools.json`, `fingerprint-prompt.txt` | captured gate shapes |

## Run it

The deployed setup is **direct-only**: it uses the host's own IP and does not
harvest. That is the fastest and most stable mode. Static egress (other VPS
tunnels, VPN sidecars) is still read and validated on boot:

```bash
node serve.mjs --port 8788 --key "$OC_KEY" --static-file egress.txt
```

Any instance also speaks `CONNECT` (Basic auth with the key as either half of
`user:pass`), so one host can be another's egress proxy via `egress.txt` as
`https://KEY:x@host:443`. Hosts behind a CDN that drops `CONNECT` (Render,
Cloudflare) are used as plain OpenAI endpoints instead and registered as extra
litellm deployments. `RENDER.md` covers that.

To add the free public pool as a backstop, harvest and pass the harvested file:

```bash
node proxy-pool.mjs --out proxies.txt --max-candidates 6000 --concurrency 200
node serve.mjs --port 8788 --key "$OC_KEY" --static-file egress.txt --proxy-file proxies.txt
```

Or let the server keep that pool fresh itself with `--free-proxies`. Remove
`--proxy-file`/`--free-proxies` to go back to direct-only.

`--free-proxies` spawns `proxy-pool.mjs` as a child and re-harvests every
`OC_POOL_INTERVAL` seconds (default 1800, ±15 % jitter), or every 60 seconds while
the pool is below `OC_POOL_TARGET`. It writes only after a full validation pass, and
`serve.mjs` hot-reloads the file on mtime, so a refresh never leaves the pool
half-written. The previous good proxies are re-probed first and retained if they
still answer 200.

Probes cost one `max_tokens: 1` request each. At 200 concurrency a 6000-candidate
pass takes several minutes. Sources are sampled randomly across the whole list, so
successive passes test different addresses instead of the same prefix.

## Fast egress: use your own hosts (`--static-file`)

Harvested public proxies are the slowest part of this setup. Anything reachable over
HTTP CONNECT or SOCKS can instead be placed in a static file, which is validated once
on boot and is never removed by a harvest. That is the path for fast egress.

`tunnels.sh` turns SSH hosts into validated SOCKS tunnels:

```bash
cp egress-hosts.txt.example egress-hosts.txt
$EDITOR egress-hosts.txt          # one [user@]host[:port] per line
./tunnels.sh start                # starts, probes, publishes only 200s
./tunnels.sh status
./tunnels.sh stop
```

Only tunnels that the gateway answers 200 for are published. Each host is a fresh IP,
so every extra VPS is another bucket. Latency is a few hundred ms instead of seconds.
Cheap ARM/x86 VPSs are the cheapest reliable route; a single fresh VPS IP often passes
outright.

The compose file mounts `./egress.txt` read-only and treats `host.docker.internal` as
the host, so tunnels bound on the host are reachable from the container. Free-form
lines in `egress.txt` (for example `http://vpn1:8888`) are preserved by `tunnels.sh`.

## VPNs: what works and what does not

The block is **ASN-based**, not proxy-based. A VPN changes your IP but usually to
another datacenter range, and free VPN exits are shared by thousands of people:

| egress | speed | verdict |
| --- | --- | --- |
| Your own VPS (direct) | fastest | often 200 on a fresh IP; one bucket per server |
| Your own VPS via `ssh -D` | fast | same, and lets one box front several servers |
| Free VPN (ProtonVPN, Windscribe, …) | fast | often 403; some free servers pass — test per server |
| Psiphon | medium | tested: 1 of 11 probes passed, tunnel drops after minutes |
| Tor | slow | tested: every exit returned 403 |
| Public free proxies | slow | ~0.03–0.5 % pass, dies in minutes |

Free VPN accounts are usually limited to one or two devices, so a VPN gives you a
handful of IPs, not a pool. Multi-server WireGuard configs from one free account can
often be connected one at a time only.

### gluetun sidecar (WireGuard)

Gluetun can run a VPN and serve an HTTP proxy from the same container. Add one service
per tunnel to a compose overlay, using WireGuard config values from the provider's
dashboard (ProtonVPN: Downloads → WireGuard configuration):

```yaml
services:
  vpn1:
    image: qmcgaw/gluetun
    restart: unless-stopped
    cap_add: [NET_ADMIN]
    devices: ["/dev/net/tun:/dev/net/tun"]
    environment:
      VPN_SERVICE_PROVIDER: custom
      VPN_TYPE: wireguard
      WIREGUARD_PRIVATE_KEY: "..."
      WIREGUARD_ADDRESSES: "10.2.0.2/32"
      WIREGUARD_PUBLIC_KEY: "..."
      WIREGUARD_ENDPOINT_IP: "203.0.113.5"
      WIREGUARD_ENDPOINT_PORT: "51820"
      WIREGUARD_ALLOWED_IPS: "0.0.0.0/0,::/0"
      HTTPPROXY: "on"
      HTTPPROXY_LISTENING_ADDRESS: ":8888"
```

Then add `http://vpn1:8888` to `egress.txt`. The container is on the compose network,
so `ocproxy` can resolve `vpn1` without publishing a port. Repeat `vpn2`, `vpn3`, and
so on. `docker compose -f docker-compose.prod.yml -f vpn.yml up -d` merges the files.

### Psiphon

Psiphon's network includes volunteer/residential exits, so it can occasionally pass,
but the tested build was unstable: one probe out of eleven returned 200 and the tunnel
dropped after a few minutes. Run `psiphon-tunnel-core` or the desktop client and point
`--proxy http://127.0.0.1:8080` (or its SOCKS listener) at it. The listener binds
loopback, so expose it with `socat TCP-LISTEN:10981,fork,reuseaddr TCP:127.0.0.1:1081`
and add `socks5://host.docker.internal:10981` to `egress.txt`.

On an arm64 server, build the console client natively (`go build ./ConsoleClient`);
the amd64 release binary crashes under qemu user emulation.

## Endpoints

| Route | Purpose |
| --- | --- |
| `POST /v1/chat/completions` | chat, streaming and non-streaming |
| `GET /v1/models` | configured free models |
| `GET /healthz` | liveness + pool size |
| `GET /pool` | per-proxy state (`ok`, `cooldown`, `new`, `dead`) |

All routes require `Authorization: Bearer $OC_KEY` when `--key`/`OC_KEY` is set.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `OC_KEY` | — | shared bearer; compose requires it |
| `OC_MAX_ATTEMPTS` | `6` | proxies tried per request once the host IP is parked |
| `OC_LIMITED_MS` | `21600000` | cooldown after a 429 (6 h) |
| `OC_POOL_INTERVAL` | `1800` | seconds between harvests |
| `OC_POOL_CONCURRENCY` | `200` | parallel probes |
| `OC_POOL_MAX_CANDIDATES` | `6000` | candidates per harvest |
| `OC_POOL_TARGET` | `25` | working proxies to aim for; below it the harvester retries every 60 s |
| `OC_TIMEOUT_MS` | `600000` | upstream request timeout |
| `OC_PROXY_FIRST_BYTE_MS` | `25000` | fail over if a proxy sends no byte after connecting |
| `OC_DIRECT_FIRST_BYTE_MS` | `120000` | same for the host IP |
| `OC_STREAM_IDLE_MS` | `90000` | close a stream cleanly after this much upstream silence |
| `OC_CONNECT_ALLOW` | `opencode.ai:443` | targets the CONNECT relay may reach |
| `OC_MODELS` | built-in list | comma-separated models served by `/v1/models` |
| `OC_TOKEN`, `OC_ORG` | — | optional account mode without the CLI |
| `OC_PROXY_SOURCES` | built-in list | file of extra source URLs, one per line |
| `OC_STATIC_FILE` | `egress.txt` in compose | validated-on-boot private egress |

Model names rotate upstream. If one starts failing, refresh them from a working
unauthenticated `GET https://opencode.ai/inference/openai/v1/models` (through a
passing proxy) and set `OC_MODELS`.

## Operational notes

- The pool file is disposable. Delete `proxies.txt` to force a clean slate; the
  harvester rebuilds it.
- `GET /pool` leaks proxy addresses but not credentials for HTTP proxies without
  auth. Pin `--key` before exposing the port.
- One request may legitimately touch several proxies (429/403/5xx). LiteLLM's
  `num_retries` is kept low so a single client retry does not multiply into dozens
  of upstream calls.
- Account mode (`--account`, or `OC_TOKEN`/`OC_ORG`) moves quota to the account
  bucket. It does **not** remove the abusive-network block, since that is IP-based.
- Free proxies can MITM TLS. We verify certificates against the system store and do
  not disable verification; a MITM proxy simply fails to connect and is dropped.
