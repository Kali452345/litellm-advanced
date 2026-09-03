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
   three lines are all it needs:

```bash
printf 'LITELLM_MASTER_KEY=sk-%s\nLITELLM_SALT_KEY=sk-%s\nPOSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" > .env
```

   `LITELLM_SALT_KEY` encrypts the provider keys the dashboard stores in the database.
   Once the first key is saved, changing it makes every stored key undecryptable, so keep
   it wherever you keep the backups. A `DATABASE_URL` in `.env` is ignored here, since the
   compose file sets it explicitly to the `db` service

3. Build and start it. The first build takes several minutes and boot then applies every
   migration before the port answers:

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

4. Watch it come up:

```bash
docker compose -f docker-compose.prod.yml logs -f litellm
```

5. Check that it serves and that it reached the database:

```bash
curl -s http://127.0.0.1:4000/health/readiness
```

`{"status":"healthy","db":"connected"}` means the stack is up

## Reaching the dashboard and pointing a harness at it

The proxy is published on the server's loopback only, so nothing is reachable from the
internet yet. The master key is the only thing guarding it, and plain HTTP would put that
key and every prompt on the wire, so either tunnel over the ssh you already have or put a
TLS reverse proxy in front

```bash
ssh -N -L 4000:127.0.0.1:4000 you@server
```

With that open, http://127.0.0.1:4000/ui/ is the dashboard, signing in as `admin` with the
master key as the password, and a harness on your laptop points at the tunnel exactly the
way it pointed at the local proxy:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:4000 && export ANTHROPIC_AUTH_TOKEN=$LITELLM_MASTER_KEY
```

For harnesses running somewhere else, give it a hostname and let Caddy hold the
certificate, which is two lines in a `Caddyfile` on the server:

```
litellm.example.com {
    reverse_proxy 127.0.0.1:4000
}
```

Publish port 4000 to the world only behind TLS, and only with a master key you generated
rather than one you typed

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


