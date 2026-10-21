#!/usr/bin/env node
// OpenAI-compatible proxy for the OpenCode free tier.
//
// It owns the client fingerprint (headers + harness prompt + stream:true) so
// any OpenAI client can point at it. Outbound requests walk a pool of free
// proxies; a 429 parks that egress IP and the request retries on the next one.
//
//   node serve.mjs [--port 8788] [--host 127.0.0.1] [--key K]
//                  [--proxy URL ...] [--proxy-file FILE] [--free-proxies]
//                  [--no-direct] [--max-attempts N] [--account]
//                  [--sticky] [--log FILE] [--model M ...]
import http from "node:http"
import net from "node:net"
import crypto from "node:crypto"
import { execFileSync, spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import fs from "node:fs"
import { ProxyPool } from "./pool.mjs"
import { sendUpstream, probe, agentPrompt, baseTools, titlePrompt, DEFAULT_MODELS, PROMPT_START } from "./upstream.mjs"

const opts = {
  port: Number(process.env.OC_PORT || process.env.PORT || 8788),
  host: process.env.OC_HOST || "127.0.0.1",
  key: process.env.OC_KEY || null,
  proxies: [],
  proxyFile: null,
  staticFile: process.env.OC_STATIC_FILE || null,
  freeProxies: false,
  noDirect: false,
  maxAttempts: Number(process.env.OC_MAX_ATTEMPTS || 5),
  account: false,
  connectAllow: (process.env.OC_CONNECT_ALLOW || "opencode.ai:443").split(",").map((v) => v.trim()).filter(Boolean),
  sticky: false,
  log: null,
  maxBody: 16 * 1024 * 1024,
  timeoutMs: Number(process.env.OC_TIMEOUT_MS || 600_000),
  proxyFirstByteMs: Number(process.env.OC_PROXY_FIRST_BYTE_MS || 25_000),
  directFirstByteMs: Number(process.env.OC_DIRECT_FIRST_BYTE_MS || 120_000),
  streamIdleMs: Number(process.env.OC_STREAM_IDLE_MS || 90_000),
  models: [],
}

const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  const next = () => {
    const v = argv[++i]
    if (v === undefined) fail(`missing value for ${a}`)
    return v
  }
  if (a === "--port") opts.port = Number(next())
  else if (a === "--host") opts.host = next()
  else if (a === "--key") opts.key = next()
  else if (a === "--proxy") opts.proxies.push(next())
  else if (a === "--proxy-file") opts.proxyFile = next()
  else if (a === "--static-file") opts.staticFile = next()
  else if (a === "--free-proxies") opts.freeProxies = true
  else if (a === "--no-direct") opts.noDirect = true
  else if (a === "--max-attempts") opts.maxAttempts = Number(next())
  else if (a === "--account") opts.account = true
  else if (a === "--sticky") opts.sticky = true
  else if (a === "--log") opts.log = next()
  else if (a === "--model") opts.models.push(next())
  else if (a === "-h" || a === "--help") {
    console.log(
      "usage: node serve.mjs [--port N] [--host H] [--key K] [--proxy URL]... [--proxy-file F] [--free-proxies] [--no-direct] [--account] [--sticky] [--log FILE]",
    )
    process.exit(0)
  } else fail(`unknown argument: ${a}`)
}
if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) fail("bad --port")
if (!Number.isInteger(opts.maxAttempts) || opts.maxAttempts < 1) fail("bad --max-attempts")
if (!opts.models.length) {
  const envModels = (process.env.OC_MODELS || "").split(",").map((m) => m.trim()).filter(Boolean)
  opts.models = envModels.length ? envModels : DEFAULT_MODELS
}

function fail(msg) {
  console.error("serve: " + msg)
  process.exit(2)
}

const version =
  process.env.OPENCODE_VERSION ||
  (() => {
    try {
      return execFileSync(process.env.OPENCODE_BIN || "opencode", ["--version"], { encoding: "utf8" })
        .trim()
        .replace(/^opencode v/, "")
    } catch {
      return "2.0.29"
    }
  })()
process.env.OPENCODE_VERSION = version

function log(obj) {
  if (!opts.log) return
  try {
    fs.appendFileSync(opts.log, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n")
  } catch {}
}

// Account credentials are optional; on a server there is usually no CLI, so
// OC_TOKEN/OC_ORG are the practical path.
let token = process.env.OC_TOKEN || ""
let org = process.env.OC_ORG || ""
if (opts.account && !token) {
  try {
    const list = JSON.parse(execFileSync(process.env.OPENCODE_BIN || "opencode", ["auth", "export"], { encoding: "utf8" }))
    const c = list.find((x) => x.active) || list[0]
    token = c?.value?.access || ""
    org = c?.value?.metadata?.organizationID || c?.value?.metadata?.orgID || ""
    if (!token) throw new Error("no token")
    log({ event: "account", email: c?.value?.metadata?.email || null, org })
  } catch {
    console.error("serve: --account requested but no usable credential; continuing anonymous")
  }
}

const proxyFile = opts.proxyFile || (fs.existsSync("proxies.txt") ? "proxies.txt" : null)
const pool = new ProxyPool({
  staticProxies: opts.proxies,
  staticFile: opts.staticFile,
  file: proxyFile,
  limitedMs: Number(process.env.OC_LIMITED_MS || 6 * 3600_000),
  log,
})
if (proxyFile) console.log(`proxy pool file: ${proxyFile} (${pool.size()} entries)`)
if (opts.staticFile) console.log(`static egress file: ${opts.staticFile}`)

let poolChild = null
if (opts.freeProxies) {
  const file = proxyFile || "proxies.txt"
  pool.file ||= file
  poolChild = spawn(process.execPath, [fileURLToPath(new URL("./proxy-pool.mjs", import.meta.url)), "--out", file], {
    stdio: ["ignore", "inherit", "inherit"],
  })
  poolChild.on("exit", (code) => log({ event: "pool-exit", code }))
  console.log(`spawned proxy harvester -> ${file}`)
}

const agentPromptStarts = PROMPT_START
let stickySid = null
function sessionIDOnce() {
  if (!stickySid) stickySid = sessionID()
  return stickySid
}
function sessionID() {
  return (
    "ses_" +
    crypto.randomBytes(6).toString("hex") +
    Array.from(
      crypto.randomBytes(14),
      (b) => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[b % 62],
    ).join("")
  )
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let len = 0
    const chunks = []
    req.on("data", (c) => {
      len += c.length
      if (len > opts.maxBody) {
        req.destroy()
        reject(Object.assign(new Error("body too large"), { status: 413 }))
        return
      }
      chunks.push(c)
    })
    req.on("end", () => resolve(Buffer.concat(chunks)))
    req.on("error", reject)
  })
}

function sendJSON(res, status, obj, extra = {}) {
  const body = Buffer.from(JSON.stringify(obj))
  res.writeHead(status, { "content-type": "application/json", "content-length": body.length, ...extra })
  res.end(body)
}

function parseSSEChunk(chunk, state) {
  for (const line of chunk.split("\n")) {
    const t = line.trim()
    if (!t.startsWith("data:")) continue
    const data = t.slice(5).trim()
    if (data === "[DONE]") {
      state.done = true
      continue
    }
    let j
    try {
      j = JSON.parse(data)
    } catch {
      continue
    }
    state.id ||= j.id
    state.created ||= j.created
    state.model ||= j.model
    if (j.usage) state.usage = j.usage
    for (const ch of j.choices || []) {
      if (ch.finish_reason) state.finish = ch.finish_reason
      const d = ch.delta || {}
      if (d.content) state.content += d.content
      if (d.reasoning_content) state.reasoning += d.reasoning_content
      for (const tc of d.tool_calls || []) {
        const i = tc.index ?? 0
        const slot = (state.tool[i] ||= { id: "", type: "function", function: { name: "", arguments: "" } })
        if (tc.id) slot.id = tc.id
        if (tc.type) slot.type = tc.type
        if (tc.function?.name) slot.function.name += tc.function.name
        if (tc.function?.arguments) slot.function.arguments += tc.function.arguments
      }
    }
  }
}


// A proxy can accept the request and then go silent forever. Wait for the
// first byte before telling the client anything, so a stall can still fail
// over to another route. Returns the first chunk, or null on clean end.
function firstByte(upstream, ms) {
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (fn, v) => {
      if (settled) return
      settled = true
      upstream.removeListener("data", onData)
      upstream.removeListener("end", onEnd)
      upstream.removeListener("error", onErr)
      upstream.removeListener("aborted", onAbort)
      upstream.setTimeout(0)
      fn(v)
    }
    const onData = (c) => done(resolve, c)
    const onEnd = () => done(resolve, null)
    const onErr = (e) => done(reject, e)
    const onAbort = () => done(reject, new Error("upstream aborted before first byte"))
    upstream.once("data", onData)
    upstream.once("end", onEnd)
    upstream.once("error", onErr)
    upstream.once("aborted", onAbort)
    upstream.setTimeout(ms, () => {
      const err = new Error("no first byte from upstream")
      upstream.destroy(err)
      done(reject, err)
    })
  })
}

function routeAttempts() {
  const usable = pool.size()
  if (!usable) return 1
  const proxyBudget = Math.max(1, Math.min(opts.maxAttempts, pool.healthy() || usable))
  return proxyBudget + (opts.noDirect ? 0 : 1)
}

// Direct egress is much faster than public proxies, so it is the default
// route. A 429/403 parks it and proxies take over until it recovers.
let directPausedUntil = 0
function pauseDirect(ms) {
  directPausedUntil = Math.max(directPausedUntil, Date.now() + ms)
}

async function handleChat(req, res) {
  let payload
  try {
    payload = JSON.parse((await readBody(req)).toString("utf8") || "{}")
  } catch (e) {
    return sendJSON(res, e.status || 400, { error: { message: e.message, type: "invalid_request_error" } })
  }
  if (!Array.isArray(payload.messages) || !payload.messages.length) {
    return sendJSON(res, 400, { error: { message: "messages is required", type: "invalid_request_error" } })
  }
  if (!payload.model) return sendJSON(res, 400, { error: { message: "model is required", type: "invalid_request_error" } })

  const wantsStream = payload.stream === true
  const sid = opts.sticky ? sessionIDOnce() : sessionID()

  // Two accepted shapes: harness prompt + tools, or title prompt alone. Pick
  // per request so OpenCode's own title-generator call still passes.
  const first = payload.messages[0]
  const isTitle = first?.role === "system" && String(first.content || "").startsWith("You are a title generator")
  if (!(first?.role === "system" && String(first.content || "").startsWith(agentPromptStarts)) && !isTitle) {
    payload.messages.unshift({ role: "system", content: agentPrompt })
  }
  const callerTools = Array.isArray(payload.tools) ? payload.tools : []
  if (isTitle) {
    if (!callerTools.length) delete payload.tools
  } else {
    const names = new Set(callerTools.map((t) => t?.function?.name))
    payload.tools = [...callerTools, ...baseTools.filter((t) => !names.has(t.function.name))]
  }
  log({ event: "request", model: payload.model, messages: payload.messages.length, tools: (payload.tools || []).length, title: isTitle, stream: wantsStream })
  payload.stream = true
  if (!wantsStream) payload.stream_options = { ...(payload.stream_options || {}), include_usage: true }

  const attempts = routeAttempts()
  const tried = new Set()
  let lastErr = null
  let directTried = false
  const directPaused = () => Date.now() < directPausedUntil

  for (let attempt = 0; attempt < attempts; attempt++) {
    let entry = null
    if (attempt === 0) {
      // direct first unless it is parked or explicitly disabled
      if (opts.noDirect || directPaused()) entry = pool.pick(tried)
      else directTried = true
    } else {
      entry = pool.pick(tried)
      if (!entry && !opts.noDirect && !directTried) directTried = true
    }
    if (entry) tried.add(entry.key)
    if (!entry && opts.noDirect) {
      lastErr = new Error("no proxy available")
      break
    }
    // at most one direct attempt; after it, proxies are the only remaining route
    if (!entry && directTried && attempt > 0) break
    if (entry) pool.begin(entry.key)
    const started = Date.now()
    let upstream
    try {
      upstream = await sendUpstream(payload, {
        proxy: entry ? entry.dial || entry.url : null,
        token,
        org,
        timeoutMs: opts.timeoutMs,
      })
    } catch (e) {
      lastErr = e
      if (entry) pool.report(entry.key, "transport", Date.now() - started)
      log({ event: "transport", proxy: entry?.url || "direct", err: e.message, attempt })
      continue
    } finally {
      if (entry) pool.end(entry.key)
    }

    const status = upstream.statusCode || 502
    const retryAfter = upstream.headers["retry-after"]
    log({ event: "upstream", status, model: payload.model, proxy: entry?.url || "direct", stream: wantsStream, attempt })

    if (entry) {
      if (status === 200) pool.report(entry.key, "ok", Date.now() - started)
      else if (status === 429) pool.report(entry.key, "limited")
      else if (status === 403) pool.report(entry.key, "reject")
      else if (status >= 500) pool.report(entry.key, "transport")
    } else {
      if (status === 200) directPausedUntil = 0
      else if (status === 429) pauseDirect(retryAfter ? Number(retryAfter) * 1000 : 10 * 60_000)
      else if (status === 403) pauseDirect(30 * 60_000)
      else if (status >= 500) pauseDirect(60_000)
    }

    const retryable = status === 429 || status === 403 || status >= 500
    if (retryable && attempt + 1 < attempts) {
      upstream.resume()
      lastErr = Object.assign(new Error(`upstream ${status}`), { status, retryAfter })
      continue
    }

    if (status !== 200) {
      const chunks = []
      for await (const c of upstream) chunks.push(c)
      const body = Buffer.concat(chunks)
      const headers = { "content-type": upstream.headers["content-type"] || "application/json" }
      if (retryAfter) headers["retry-after"] = retryAfter
      res.writeHead(status, headers)
      return res.end(body)
    }

    const ctype = upstream.headers["content-type"] || ""

    if (wantsStream) {
      // hold headers until bytes flow, so a silent proxy is still retryable
      let first
      try {
        first = await firstByte(upstream, entry ? opts.proxyFirstByteMs : opts.directFirstByteMs)
      } catch (e) {
        lastErr = e
        if (entry) pool.report(entry.key, "transport")
        log({ event: "first-byte", proxy: entry?.url || "direct", err: e.message, attempt })
        upstream.destroy()
        continue
      }
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      })
      if (first) res.write(first)
      if (first === null) {
        res.end()
        return
      }
      // keep the client alive while the model thinks, and finish cleanly if the
      // upstream really dies mid-stream instead of hanging to LiteLLM's timeout
      let closed = false
      const beat = setInterval(() => {
        if (!closed) res.write(": ping\n\n")
      }, 10_000)
      const finish = (aborted) => {
        if (closed) return
        closed = true
        clearInterval(beat)
        if (aborted) {
          log({ event: "stream-abort", proxy: entry?.url || "direct" })
          try {
            res.write("\ndata: [DONE]\n\n")
          } catch {}
        } else {
          log({ event: "stream-end", proxy: entry?.url || "direct" })
        }
        res.end()
      }
      upstream.setTimeout(opts.streamIdleMs, () => {
        upstream.destroy(new Error("stream idle"))
        finish(true)
      })
      upstream.on("data", () => upstream.setTimeout(opts.streamIdleMs))
      upstream.on("end", () => finish(false))
      upstream.on("error", () => finish(true))
      req.on("close", () => {
        closed = true
        clearInterval(beat)
        upstream.destroy()
      })
      upstream.pipe(res, { end: false })
      return
    }

    // non-stream caller: also require a first byte so stalls fail over
    let first
    try {
      first = await firstByte(upstream, entry ? opts.proxyFirstByteMs : opts.directFirstByteMs)
    } catch (e) {
      lastErr = e
      if (entry) pool.report(entry.key, "transport")
      log({ event: "first-byte", proxy: entry?.url || "direct", err: e.message, attempt })
      upstream.destroy()
      continue
    }
    if (first === null) {
      // empty 200: fall through with no body
    } else {
      upstream.pause()
      upstream.unshift(first)
      upstream.resume()
    }
    upstream.setTimeout(opts.streamIdleMs, () => upstream.destroy(new Error("stream idle")))
    upstream.on("data", () => upstream.setTimeout(opts.streamIdleMs))

    // Non-stream caller: buffer the SSE and hand back one completion object.
    const state = { id: "", created: 0, model: payload.model, content: "", reasoning: "", tool: {}, finish: null, usage: null, done: false }
    upstream.setEncoding("utf8")
    let buf = ""
    for await (const chunk of upstream) {
      buf += chunk
      const cut = buf.lastIndexOf("\n")
      if (cut === -1) continue
      parseSSEChunk(buf.slice(0, cut), state)
      buf = buf.slice(cut + 1)
    }
    if (buf) parseSSEChunk(buf, state)

    const message = { role: "assistant", content: state.content || null }
    if (state.reasoning) message.reasoning_content = state.reasoning
    const tools = Object.keys(state.tool)
      .sort((a, b) => a - b)
      .map((k) => state.tool[k])
    if (tools.length) message.tool_calls = tools

    return sendJSON(res, 200, {
      id: state.id || "chatcmpl-" + crypto.randomUUID(),
      object: "chat.completion",
      created: state.created || Math.floor(Date.now() / 1000),
      model: state.model || payload.model,
      choices: [{ index: 0, message, finish_reason: state.finish || "stop" }],
      usage: state.usage || undefined,
    })
  }

  const status = lastErr?.status || 502
  const extra = lastErr?.retryAfter ? { "retry-after": lastErr.retryAfter } : {}
  return sendJSON(res, status, { error: { message: `upstream unavailable: ${lastErr?.message || "unknown"}`, type: "proxy_error" } }, extra)
}

// Static egress (VPNs, ssh tunnels) may be hand-added; verify it once on boot so
// a request does not discover a dead tunnel the hard way.
setTimeout(async () => {
  const pending = [...pool.state.values()].filter((s) => s.origin === "static" && s.status === "new")
  if (!pending.length) return
  console.log(`validating ${pending.length} static egress entr${pending.length === 1 ? "y" : "ies"}`)
  for (const s of pending) {
    try {
      const r = await probe({ url: s.url, dial: s.dial }, { timeoutMs: 15_000 })
      if (r.status === 200) pool.report(s.key, "ok")
      else if (r.status === 429) pool.report(s.key, "limited")
      else pool.report(s.key, "reject")
      log({ event: "static-probe", proxy: s.url, status: r.status })
    } catch {
      pool.report(s.key, "transport")
    }
  }
}, 1500)

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost")
  const path = url.pathname.replace(/\/+$/, "")

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization,content-type",
      "access-control-allow-methods": "GET,POST,OPTIONS",
    })
    return res.end()
  }

  // platform health probes (Render etc.) cannot send the bearer
  const isHealth = req.method === "GET" && (path === "/healthz" || path === "/health")
  if (opts.key && !isHealth) {
    const got = (req.headers.authorization || "").replace(/^Bearer\s+/i, "")
    if (got !== opts.key) return sendJSON(res, 401, { error: { message: "bad api key", type: "authentication_error" } })
  }

  try {
    if (req.method === "GET" && (path === "/healthz" || path === "/health")) {
      return sendJSON(res, 200, {
        ok: true,
        anonymous: !token,
        proxies: pool.size(),
        healthy: pool.healthy(),
        directPausedFor: Math.max(0, Math.round((directPausedUntil - Date.now()) / 1000)),
        uptime: Math.round(process.uptime()),
      })
    }
    if (req.method === "GET" && path === "/pool") {
      return sendJSON(res, 200, {
        size: pool.size(),
        healthy: pool.healthy(),
        entries: pool.snapshot().sort((a, b) => b.ok - a.ok).slice(0, 200),
      })
    }
    if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
      return sendJSON(res, 200, { object: "list", data: opts.models.map((id) => ({ id, object: "model", owned_by: "opencode" })) })
    }
    if (req.method === "POST" && ["/v1/chat/completions", "/chat/completions"].includes(path)) return handleChat(req, res)
    return sendJSON(res, 404, { error: { message: `no route for ${req.method} ${path}`, type: "not_found" } })
  } catch (e) {
    log({ event: "handler-error", err: e.message })
    if (!res.headersSent) sendJSON(res, 500, { error: { message: e.message, type: "proxy_error" } })
    else res.end()
  }
})

server.headersTimeout = 0
server.requestTimeout = 0

// CONNECT relay so this instance can be used as a plain egress proxy (egress.txt
// entry) instead of only as an OpenAI endpoint. It relays raw bytes; the caller
// still builds the fingerprint, so the relay stays dumb and portable.
server.on("connect", (req, client, head) => {
  const fail = (code, msg) => {
    if (!client.writable) return
    client.end("HTTP/1.1 " + code + " " + msg + "\r\n\r\n")
  }
  if (opts.key) {
    const basic = (req.headers["proxy-authorization"] || "").replace(/^Basic\s+/i, "")
    const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "")
    // accept the key as either half of user:pass, so `--proxy http://KEY:x@host`
    // and `--proxy http://x:KEY@host` both work
    const pair = basic ? Buffer.from(basic, "base64").toString("utf8") : ""
    const [u = "", p = ""] = pair.split(":")
    if (u !== opts.key && p !== opts.key && bearer !== opts.key) return fail(407, "Proxy Authentication Required")
  }
  const [host, portRaw] = String(req.url || "").split(":")
  const port = Number(portRaw || 443)
  if (!host || !Number.isInteger(port)) return fail(400, "Bad Request")
  const allowed = opts.connectAllow.some((a) => a === host + ":" + port || a === host)
  if (!allowed) return fail(403, "Forbidden")
  client.on("error", () => client.destroy())
  const up = net.connect(port, host)
  const timer = setTimeout(() => up.destroy(new Error("connect timeout")), 15_000)
  up.once("connect", () => {
    clearTimeout(timer)
    log({ event: "connect", target: host + ":" + port })
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
    if (head?.length) up.write(head)
    up.pipe(client)
    client.pipe(up)
  })
  up.on("error", (e) => {
    clearTimeout(timer)
    log({ event: "connect-fail", target: host + ":" + port, err: e.message })
    fail(502, "Bad Gateway")
    client.destroy()
  })
  up.on("close", () => client.destroy())
  client.on("close", () => up.destroy())
})

server.listen(opts.port, opts.host, () => {
  const base = `http://${opts.host}:${opts.port}/v1`
  console.log(`opencode free proxy listening on ${base}`)
  console.log(
    `mode: ${token ? "account " + (org || "?") : "anonymous (egress IP)"}${pool.size() ? `, pool of ${pool.size()} (${pool.healthy()} usable)` : ", direct egress"}${opts.noDirect ? ", direct disabled" : ""}`,
  )
  console.log(`try: curl -s ${base}/chat/completions -H 'content-type: application/json' -d '{"model":"big-pickle","messages":[{"role":"user","content":"hi"}]}'`)
  log({ event: "listen", port: opts.port, host: opts.host })
})

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log("\nshutting down")
    pool.close()
    poolChild?.kill()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000)
  })
}
