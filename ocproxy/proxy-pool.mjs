#!/usr/bin/env node
// Harvests public free proxies, keeps only ones that survive a real
// through-the-tunnel gate probe, and atomically publishes them to a file that
// serve.mjs watches.
//
//   node proxy-pool.mjs [--out proxies.txt] [--once] [--interval 1800]
//                       [--concurrency 50] [--max-candidates 800]
//                       [--max-per-source 300] [--sources file]
//
// A proxy is written only on HTTP 200. 429 proxies are reachable but their
// egress bucket is spent, so they are not published.
import fs from "node:fs"
import path from "node:path"
import { parseProxy } from "./connect.mjs"
import { probe, DEFAULT_MODELS } from "./upstream.mjs"

const SOURCES = [
  { url: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt", proto: "http", max: 400 },
  { url: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt", proto: "socks5", max: 300 },
  { url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt", proto: "http", max: 300 },
  { url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt", proto: "socks5", max: 200 },
  {
    url: "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=protocolipport&format=text",
    proto: "http",
    max: 300,
  },
  {
    url: "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=socks5&proxy_format=protocolipport&format=text",
    proto: "socks5",
    max: 200,
  },
  { url: "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/all/data.txt", proto: null, max: 4000 },
  { url: "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/https/data.txt", proto: "https", max: 500 },
  { url: "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt", proto: "http", max: 800 },
  { url: "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/socks5/data.txt", proto: "socks5", max: 1200 },
  { url: "https://raw.githubusercontent.com/relayglass/free-proxy-list/main/all.csv", csv: true, max: 800 },
  { url: "https://raw.githubusercontent.com/relayglass/free-proxy-list/main/protocol/https/https.txt", proto: "http", max: 150 },
  { url: "https://raw.githubusercontent.com/relayglass/free-proxy-list/main/protocol/socks5/socks5.txt", proto: "socks5", max: 150 },
  { url: "https://raw.githubusercontent.com/stormsia/proxy-list/main/http.txt", proto: "http", max: 350 },
  { url: "https://raw.githubusercontent.com/stormsia/proxy-list/main/socks5.txt", proto: "socks5", max: 120 },
  { url: "https://raw.githubusercontent.com/Jakee8718/Free-Proxies/main/proxy/http.txt", proto: "http", max: 800 },
  { url: "https://raw.githubusercontent.com/Jakee8718/Free-Proxies/main/proxy/socks/socks5.txt", proto: "socks5", max: 400 },
  { url: "https://raw.githubusercontent.com/mzyui/proxy-list/main/http.txt", proto: "http", max: 1000 },
  { url: "https://raw.githubusercontent.com/mzyui/proxy-list/main/socks5.txt", proto: "socks5", max: 800 },
  { url: "https://raw.githubusercontent.com/TuanMinPay/live-proxy/master/http.txt", proto: "http", max: 800 },
  { url: "https://raw.githubusercontent.com/TuanMinPay/live-proxy/master/socks5.txt", proto: "socks5", max: 800 },
  { url: "https://raw.githubusercontent.com/proxy4parsing/proxy-list/main/http.txt", proto: "http", max: 800 },
  { url: "https://raw.githubusercontent.com/zloi-user/hideip.me/main/http.txt", proto: "http", max: 200 },
  { url: "https://raw.githubusercontent.com/zloi-user/hideip.me/main/socks5.txt", proto: "socks5", max: 150 },
  { url: "https://www.proxy-list.download/api/v1/get?type=http", proto: "http", max: 200 },
  { url: "https://www.proxy-list.download/api/v1/get?type=socks5", proto: "socks5", max: 150 },
  { url: "https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt", proto: "http", max: 300 },
  { url: "https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt", proto: "socks5", max: 1000 },
  { url: "https://raw.githubusercontent.com/shiftyTR/proxy-list/master/proxy.txt", proto: "http", max: 300 },
  { url: "https://openproxylist.xyz/http.txt", proto: "http", max: 400 },
  { url: "https://proxyspace.pro/http.txt", proto: "http", max: 400 },
]

const argv = process.argv.slice(2)
function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const v = argv[i + 1]
  if (v === undefined) die(`missing value for --${name}`)
  return v
}
function flag(name) {
  return argv.includes(`--${name}`)
}
function die(msg) {
  console.error("proxy-pool: " + msg)
  process.exit(2)
}

const out = arg("out", process.env.OC_PROXY_FILE || "proxies.txt")
const once = flag("once")
const interval = Number(arg("interval", process.env.OC_POOL_INTERVAL || 1800))
const concurrency = Number(arg("concurrency", process.env.OC_POOL_CONCURRENCY || 200))
const maxCandidates = Number(arg("max-candidates", process.env.OC_POOL_MAX_CANDIDATES || 6000))
const target = Number(arg("target", process.env.OC_POOL_TARGET || 25))
const maxPerSource = Number(arg("max-per-source", 400))
const model = arg("model", process.env.OC_PROBE_MODEL || DEFAULT_MODELS[0])
const timeoutMs = Number(arg("timeout", 8000))
const sourcesFile = arg("sources", process.env.OC_PROXY_SOURCES || "")

if (!Number.isInteger(interval) || interval < 60) die("bad --interval")
if (!Number.isInteger(concurrency) || concurrency < 1) die("bad --concurrency")

let sources = SOURCES
if (sourcesFile) {
  sources = fs
    .readFileSync(sourcesFile, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => (l.includes("://") ? { url: l, proto: null, max: maxPerSource } : { url: l, proto: "http", max: maxPerSource }))
}

function log(obj) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...obj }))
}

function normalize(line, proto) {
  let s = String(line || "").trim()
  if (!s || s.startsWith("#")) return null
  // proxyscrape protocolipport emits "http://1.2.3.4:80" already
  if (!/^[a-z0-9+.-]+:\/\//i.test(s)) {
    if (!proto) return null
    s = proto + "://" + s
  }
  const p = parseProxy(s)
  return p ? p.url : null
}

// The gateway answers 403 "abusive traffic" for hosting/cloud ranges far more
// often than for consumer ISPs. relayglass publishes org/asn, so bias the
// candidate order toward lines that look residential.
const HOSTING =
  /amazon|aws|google|microsoft|azure|digitalocean|hetzner|ovh|contabo|alibaba|aliyun|tencent|oracle|linode|akamai|cloudflare|vultr|choopa|leaseweb|m247|datacamp|hostinger|godaddy|ionos|1&1|scaleway|upcloud|kamatera|interserver|colocrossing|psychz|quadranet|hivelocity|equinix|datacenter|data center|hosting|vps|colo|server|cloud/i
const RESIDENTIAL =
  /comcast|verizon|at&t|charter|spectrum|cox|centurylink|frontier|bt group|sky broadband|virgin media|talktalk|vodafone|orange|sfr|free sas|telstra|optus|jio|airtel|bsnl|chinanet|china unicom|china telecom|china mobile|kddi|softbank|telecom|broadband|cable|dsl|fiber|mobile|wireless|cellular|t-mobile|telefonica|deutsche telekom|kpn|ziggo|tele2/i

function orgScore(org) {
  const s = String(org || "")
  if (!s) return 0
  if (RESIDENTIAL.test(s) && !HOSTING.test(s)) return 3
  if (RESIDENTIAL.test(s)) return 1
  if (HOSTING.test(s)) return -3
  return 0
}

function latencyScore(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return 0
  if (n < 500) return 2
  if (n < 1500) return 1
  if (n > 4000) return -1
  return 0
}

function parseCsv(text) {
  const rows = []
  let row = []
  let field = ""
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ",") {
      row.push(field)
      field = ""
    } else if (c === "\n") {
      row.push(field.replace(/\r$/, ""))
      rows.push(row)
      row = []
      field = ""
    } else field += c
  }
  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

function parseCsvProxies(text, src) {
  const rows = parseCsv(text)
  if (!rows.length) return []
  const head = rows[0].map((h) => h.trim().toLowerCase())
  const idx = (name) => head.indexOf(name)
  const iIp = idx("ip")
  const iPort = idx("port")
  const iProto = idx("protocol")
  if (iIp < 0 || iPort < 0) return []
  const iOrg = idx("org")
  const iMs = idx("response_ms")
  const out = []
  for (const r of rows.slice(1)) {
    const protoRaw = iProto >= 0 ? r[iProto].toLowerCase() : "http"
    const proto = protoRaw === "https" ? "http" : protoRaw
    const url = normalize(`${r[iIp]}:${r[iPort]}`, proto)
    if (!url) continue
    const score = (iOrg >= 0 ? orgScore(r[iOrg]) : 0) + (iMs >= 0 ? latencyScore(r[iMs]) : 0)
    out.push({ url, score })
    if (out.length >= 25_000) break
  }
  return out
}

async function fetchSource(src) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 30_000)
  try {
    const res = await fetch(src.url, {
      signal: ctrl.signal,
      headers: { "user-agent": "ocproxy-pool/1.0 (+free proxy harvest)", accept: "text/plain,*/*" },
    })
    if (!res.ok) throw new Error("HTTP " + res.status)
    const text = await res.text()
    const found = src.csv ? parseCsvProxies(text, src) : []
    if (!src.csv) {
      for (const l of text.split(/\r?\n/)) {
        const n = normalize(l, src.proto)
        if (n) found.push({ url: n, score: 0 })
        if (found.length >= 25_000) break
      }
    }
    // Lists have a stable order, so taking the prefix would re-probe the same
    // addresses forever. Sample across the whole source instead.
    const sample = shuffle(found.slice()).slice(0, src.max || maxPerSource)
    log({ event: "source", url: src.url, count: sample.length, total: found.length })
    return sample
  } catch (e) {
    log({ event: "source-error", url: src.url, error: e.message })
    return []
  } finally {
    clearTimeout(timer)
  }
}

async function readPrior() {
  try {
    return fs
      .readFileSync(out, "utf8")
      .split("\n")
      .map((l) => normalize(l, null))
      .filter(Boolean)
      .map((url) => ({ url, score: 0 }))
  } catch {
    return []
  }
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

async function validate(list) {
  const good = []
  let i = 0
  let done = 0
  const started = Date.now()
  async function worker() {
    while (i < list.length) {
      const url = list[i++]
      let result
      const t0 = Date.now()
      try {
        result = await probe(url, { model, timeoutMs })
      } catch (e) {
        result = { status: 0, error: e.message }
      }
      done++
      const ms = Date.now() - t0
      if (result.status === 200) {
        good.push({ url, latency: ms })
        log({ event: "good", proxy: url, ms })
      } else if (result.status === 429) {
        log({ event: "limited", proxy: url, ms, retryAfter: result.retryAfter })
      } else {
        log({ event: "bad", proxy: url, status: result.status, error: result.error, ms })
      }
      if (done % 50 === 0) log({ event: "progress", done, total: list.length, good: good.length })
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker))
  log({ event: "validated", checked: list.length, good: good.length, ms: Date.now() - started })
  return good
}

function publish(good) {
  good.sort((a, b) => a.latency - b.latency)
  const body = [
    `# ocproxy pool, generated ${new Date().toISOString()} — ${good.length} live proxies`,
    ...good.map((g) => g.url),
    "",
  ].join("\n")
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
  const tmp = out + ".tmp"
  fs.writeFileSync(tmp, body)
  fs.renameSync(tmp, out)
  log({ event: "published", out: path.resolve(out), count: good.length })
}

async function cycle() {
  const fetched = (await Promise.all(sources.map(fetchSource))).flat()
  const prior = await readPrior()
  const seen = new Set()
  const candidates = []
  // prior survivors first: they already passed, and re-probing keeps them honest
  for (const item of [...prior, ...shuffle(fetched)]) {
    if (seen.has(item.url)) continue
    seen.add(item.url)
    candidates.push(item)
    if (candidates.length >= maxCandidates) break
  }
  // residential-looking entries first, stable within a score band thanks to the
  // shuffle above
  candidates.sort((a, b) => b.score - a.score)
  log({ event: "candidates", count: candidates.length, prior: prior.length, fetched: fetched.length })
  if (!candidates.length) {
    log({ event: "empty-cycle" })
    return 0
  }
  const good = await validate(candidates.map((c) => c.url))
  // Keep a floor of prior entries only when they still validate; publish empty
  // is honest (serve falls back to direct egress).
  publish(good)
  return good.length
}

let lastGood = 0
lastGood = await cycle()
if (!once) {
  const jitter = () => interval * (0.85 + Math.random() * 0.3)
  for (;;) {
    // until the pool has a working reserve, retry quickly instead of waiting
    // out the full interval with an empty file
    const wait = lastGood < target ? 60 : jitter()
    log({ event: "sleep", seconds: Math.round(wait), good: lastGood, target })
    await new Promise((r) => setTimeout(r, wait * 1000))
    try {
      lastGood = await cycle()
    } catch (e) {
      log({ event: "cycle-error", error: e.message })
    }
  }
}
