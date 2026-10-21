# Deploying to a server

Everything ships in one image built from this checkout, so the dashboard the server hands
out is this fork's trimmed one rather than upstream's, and the quota routing is the code on
your branch. The Prisma CLI and its query engines are baked in as well, so the first boot
applies all the migrations without reaching npm or the network. On the server you install
Docker and nothing else

## Do you have to download Postgres

No. `docker-compose.prod.yml` runs `postgres:16-alpine` next to the proxy on a private
network, with a named volume for the data and no port published to the host, so `docker
compose up` is the whole database install

Postgres itself is not optional. Provider keys, the model pools, virtual keys, spend and
the rotation settings all live in the database, the Admin UI login needs it, and SQLite is
not supported. To point at a Postgres you already run, or a managed one, delete the `db`
service along with the `depends_on` block and set `DATABASE_URL` to that server

## What the server needs

Docker Engine with the Compose plugin, a few GB of free disk for the images and the build
cache, and a couple of GB of RAM free while the image builds, since the build compiles a
Next.js static export and a handful of wheels. On a 1 GB box, add swap first or the
dashboard build gets killed part way through

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
```

A server too small to build at all can take the image from a machine that can:

```bash
docker save litellm-advanced:local | ssh you@server 'docker load'
```

After that `docker compose -f docker-compose.prod.yml up -d` uses the loaded tag as it is,
because compose only builds when the image is missing or `--build` is passed

## First deploy

1. Clone the fork and check out the branch you want to serve:

```bash
git clone https://github.com/Kali452345/litellm-advanced.git && cd litellm-advanced && git checkout litellm_quota_foundation
```

2. Write `.env` next to the compose file. Compose reads it for interpolation, and these
   four lines are all it needs:

```bash
printf 'LITELLM_MASTER_KEY=sk-%s\nLITELLM_SALT_KEY=sk-%s\nPOSTGRES_PASSWORD=%s\nOC_KEY=sk-oc-%s\n' "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" > .env
```

   `LITELLM_SALT_KEY` encrypts the provider keys the dashboard stores in the database.
   Once the first key is saved, changing it makes every stored key undecryptable, so keep
   it wherever you keep the backups. A `DATABASE_URL` in `.env` is ignored here, since the
   compose file sets it explicitly to the `db` service

   Signing in to the dashboard means typing the master key as the password, since that is
   the default. To sign in with something typeable instead, add the pair you want:

```bash
printf 'UI_USERNAME=%s\nUI_PASSWORD=%s\n' "someone" "$(openssl rand -base64 18)" >> .env
```

   That password reaches admin on the whole proxy, so treat a short one as a decision to
   keep the port off the internet. Changing either line takes effect on the next
   `up -d`, and the master key keeps working as the API credential either way

3. Write the `config.yaml` the compose file mounts. It is gitignored, so a fresh clone does
   not carry one, and Docker turns a missing bind source into a directory rather than
   telling you. The checkout deliberately ships the version below (it wires the free
   OpenCode models to the `ocproxy` sidecar), so copy it rather than retyping:

```bash
cp config.yaml.example config.yaml   # when the checkout has no config.yaml
```

   If you are building the file from scratch, the minimum that carries the free models is:

```yaml
general_settings:
  store_model_in_db: true
router_settings:
  enable_quota_routing: true
  quota_max_wait_seconds: 75
  num_retries: 2
litellm_settings:
  drop_params: true
model_list:
  - model_name: big-pickle
    litellm_params:
      model: openai/big-pickle
      api_base: http://ocproxy:8788/v1
      api_key: os.environ/OC_KEY
      timeout: 600
```

   `num_retries` bounds how many keys one request may walk. The free models go through a
   proxy pool that does its own retrying (see `ocproxy/README.md`), so keep it shallow.
   Everything else, the paid providers, their keys and the per-minute and per-day caps, is
   added through the dashboard and lives in the database

4. Build and start it. The first build takes several minutes and boot then applies every
   migration before the port answers:

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

5. Watch it come up:


```bash
docker compose -f docker-compose.prod.yml logs -f litellm
```

6. Check that it serves and that it reached the database:

```bash
curl -s http://127.0.0.1:4000/health/readiness
```

`{"status":"healthy","db":"connected"}` means the stack is up

## The free OpenCode pool (`ocproxy`)

The `ocproxy` service is built from `./ocproxy` and started by `docker compose up`
next to Postgres. It never publishes a port; only the litellm container reaches it
over the compose network. It supplies the client fingerprint and uses the server's
own egress IP, which is the fastest and most stable option

`egress.txt` is read on boot and every proxy line in it is gate-probed; only 200s are
used. That is where extra VPS tunnels (`ocproxy/tunnels.sh`) or VPN sidecars go when
you add them. Entries are static and hot-reloaded, so the running service picks them
up without a restart. While `egress.txt` is empty, everything uses the server IP

`ocproxy/RENDER.md` covers putting relays on Render's free tier with the
`render-keepalive.sh` cron, for extra egress IPs without another VPS.

The free public harvest is optional and off by default because of its low yield: most
public proxies are datacenter ranges the gateway returns 403 for. To switch it back
on, add `--proxy-file /data/proxies.txt --free-proxies` to the `ocproxy` command.
The README covers the measured results and tuning knobs

```bash
docker compose -f docker-compose.prod.yml logs -f ocproxy
docker compose -f docker-compose.prod.yml exec ocproxy node -e \
  "fetch('http://127.0.0.1:8788/pool',{headers:{authorization:'Bearer '+process.env.OC_KEY}}).then(r=>r.json()).then(j=>console.log(j.size,j.healthy))"
```

Useful knobs live in `.env`: `OC_POOL_INTERVAL` (default 1800 s), `OC_MAX_ATTEMPTS`
(default 6), `OC_LIMITED_MS` (429 cooldown, default 6 h), `OC_POOL_MAX_CANDIDATES`,
and `OC_POOL_TARGET` (default 25 working proxies; below it the harvester retries
every 60 s instead of every 30 min).
A bigger `OC_POOL_MAX_CANDIDATES` costs more probe traffic and finds more working IPs

To publish the free models through LiteLLM, create a virtual key in the dashboard
whose model list includes them. The master key reaches them directly:

```bash
curl -s http://127.0.0.1:4000/v1/chat/completions \
  -H "authorization: Bearer $LITELLM_MASTER_KEY" \
  -H 'content-type: application/json' \
  -d '{"model":"big-pickle","messages":[{"role":"user","content":"hi"}]}'
```

`ocproxy` is anonymous by default: no OpenCode account is involved and no token is
sent. To bill an account instead, set `OC_TOKEN` and `OC_ORG` on the service; the
account bucket is still gated by the egress IP's abusive-traffic verdict

The pool data lives in the `litellm_advanced_ocproxy_data` volume and is
disposable. `docker compose -f docker-compose.prod.yml down` leaves it intact

## Reaching the dashboard and pointing a harness at it

The proxy is published on the server's loopback only, so nothing is reachable from the
internet yet. The master key is the only thing guarding it, and plain HTTP would put that
key and every prompt on the wire, so either tunnel over the ssh you already have or put a
TLS reverse proxy in front

```bash
ssh -N -L 4000:127.0.0.1:4000 you@server
```

With that open, http://127.0.0.1:4000/ui/ is the dashboard, signing in with the
`UI_USERNAME` and `UI_PASSWORD` pair from `.env` or, when you set neither, as `admin` with
the master key as the password. A harness on your laptop points at the tunnel exactly the
way it pointed at the local proxy:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:4000 && export ANTHROPIC_AUTH_TOKEN=$LITELLM_MASTER_KEY
```

For harnesses running somewhere else, or a dashboard you want to open from any browser,
the compose file carries a Caddy service that holds the certificate and forwards to the
proxy over the private network. It sits behind a profile, so it starts only when asked:

```bash
cp Caddyfile.example Caddyfile && docker compose -f docker-compose.prod.yml --profile tls up -d
```

Edit the addresses in that copy first. A hostname pointed at the server gets a publicly
trusted certificate on its own, and a bare IP gets one Caddy signs itself, which encrypts
the same way while every browser warns once about the unknown issuer. A bare IP also needs
`default_sni` naming it in the global block, because a browser sends no SNI for an address
and Caddy then has nothing to pick a certificate by. Ports 80 and 443 have to be open on
the host firewall and in whatever the provider puts in front of it, and 4000 stays on
loopback either way, so the only way in is through Caddy

A provider firewall that is still closed does not announce itself. An outside request just
times out, which reads like a listener that never came up, and Caddy's log repeats
`Timeout during connect (likely firewall problem)` while it retries the certificate for up
to 30 days. Checking from the server settles nothing either, because a public address the
provider translates at the edge is usually unreachable from inside the instance. Point curl
at loopback and keep the public name in the request:

```bash
curl -sk --resolve YOUR.PUBLIC.IP:443:127.0.0.1 https://YOUR.PUBLIC.IP/health/readiness
```

Once the rule is in, restarting Caddy retries issuance right away instead of waiting out a
backoff that grows to 20 minutes:

```bash
docker compose -f docker-compose.prod.yml restart caddy
```

One line in `.env` goes with it, or the proxy reads every forwarded request as plain http
and sends the browser to an `http://` dashboard right after it signs in:

```bash
echo 'FORWARDED_ALLOW_IPS=172.16.0.0/12' >> .env
```

That range is where Docker puts its bridge networks, so it trusts the forwarded scheme
from the Caddy container and from nothing on the internet

Publish it to the world only behind TLS, and only with a master key you generated rather
than one you typed

## Bringing over the keys you already added

For a handful of keys the quickest path is to add them again through Models and Endpoints,
Provider Keys on the new instance, which also lets you re-measure each cap on the server

To carry the whole local database instead, dump it, restore it into the container's
Postgres, and copy the same `LITELLM_SALT_KEY` into the server's `.env` before the first
boot, or the stored keys decrypt to nothing:

```bash
pg_dump "$DATABASE_URL" | gzip > litellm.sql.gz && scp litellm.sql.gz you@server:~/
```

```bash
gunzip -c litellm.sql.gz | docker compose -f docker-compose.prod.yml exec -T db psql -U litellm -d litellm
```

## Updating, logs and backups

Deploying a new commit is a pull and an up. Migrations run on boot, so nothing else is
needed for a schema change:

```bash
git pull && docker compose -f docker-compose.prod.yml up -d --build
```

```bash
docker compose -f docker-compose.prod.yml exec -T db pg_dump -U litellm litellm | gzip > "litellm-$(date +%F).sql.gz"
```

That dump is the only state worth backing up, next to `.env` for the salt key. The images
rebuild from the repo

## When a day cap rolls over

Per-day allowances end at midnight UTC whatever the server's own clock says, and neither Add
Model nor Add Key sets a zone, so put `quota_reset_timezone` on the deployment to move that
boundary. A key added later copies the zone from the keys already behind that provider, so
stating it once covers the pool:

```yaml
model_list:
  - model_name: fast
    litellm_params:
      model: gemini/gemini-2.5-flash
      api_key: os.environ/GEMINI_API_KEY
      quota_reset_timezone: America/Los_Angeles
```

Per-minute allowances ignore it, since every offset in use is a whole number of minutes

## Serving more at once

One worker is the default, and the quota counters then live in that process, which is
correct for a single container. Raising `--num_workers` or running a second container
splits the counters, so each process would hand out the full per-minute allowance of every
key. Give them a shared Redis first, and the counters become one Lua script per request
against it:

```yaml
router_settings:
  redis_host: redis
  redis_port: 6379
```


