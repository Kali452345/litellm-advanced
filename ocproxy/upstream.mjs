// Shared gateway fingerprint. Both the health probe and the serving path use
// these exact shapes, so a proxy that probes OK is usable by the proxy.
import fs from "node:fs"
import https from "node:https"
import crypto from "node:crypto"
import { connectVia, tlsOver } from "./connect.mjs"

export const HOST = "opencode.ai"
export const PATH = "/inference/openai/v1/chat/completions"
export const DEFAULT_MODELS = [
  "big-pickle",
  "deepseek-v4.1-flash-free",
  "glm-5.3-flash-free",
  "space-bunny-free",
  "beam-free",
  "ll-alpha-free",
  "longcat-2.5-preview-free",
  "exo-free",
  "mimo-v2.6-flash-free",
  "mimo-v2.5-free",
  "nemotron-3-ultra-free",
  "nemotron-3.5-lightning-free",
]

export const VERSION = process.env.OPENCODE_VERSION || "2.0.29"
export const PROMPT_START = "You are an AI agent running in OpenCode"
export const titlePrompt = fs.readFileSync(new URL("./fingerprint-prompt.txt", import.meta.url), "utf8")
export const agentPrompt = fs.readFileSync(new URL("./agent-prompt.txt", import.meta.url), "utf8")
export const baseTools = JSON.parse(fs.readFileSync(new URL("./agent-tools.json", import.meta.url), "utf8"))

const project = crypto.createHash("sha1").update(process.cwd()).digest("hex")

// ses_ + 12 lowercase hex + 14 alnum is the only accepted shape.
export function sessionID() {
  return (
    "ses_" +
    crypto.randomBytes(6).toString("hex") +
    Array.from(
      crypto.randomBytes(14),
      (b) => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[b % 62],
    ).join("")
  )
}

export function fingerprintHeaders(sid, { token = "", org = "" } = {}) {
  const h = {
    "content-type": "application/json",
    "user-agent": `opencode/latest/${VERSION}/cli`,
    "x-opencode-client": "cli",
    "x-opencode-project": project,
    "x-opencode-session": sid,
    "x-opencode-session-id": sid,
    "x-session-id": sid,
    "x-session-affinity": sid,
    accept: "text/event-stream",
    "accept-encoding": "identity",
  }
  if (token) h.authorization = `Bearer ${token}`
  if (org) h["x-opencode-org-id"] = org
  return h
}

// Sends a request upstream, optionally through a pool entry. Resolves with the
// IncomingMessage; the caller owns the socket lifecycle after that.
export function sendUpstream(payload, { proxy = null, token = "", org = "", timeoutMs = 120_000 } = {}) {
  const body = Buffer.from(JSON.stringify(payload))
  const headers = { ...fingerprintHeaders(sessionID(), { token, org }), "content-length": String(body.length) }
  return new Promise((resolve, reject) => {
    const go = (sock) => {
      const req = https.request(
        {
          host: HOST,
          path: PATH,
          method: "POST",
          headers,
          ...(sock ? { createConnection: () => sock } : {}),
        },
        resolve,
      )
      req.setTimeout(timeoutMs, () => req.destroy(new Error("upstream timeout")))
      req.on("error", (e) => {
        sock?.destroy()
        reject(e)
      })
      req.end(body)
    }
    if (!proxy) return go(null)
    ;(async () => {
      const raw = await connectVia(proxy.dial || proxy.url || proxy, HOST, 443, Math.min(timeoutMs, 5000))
      let tlsSock
      try {
        tlsSock = await tlsOver(raw, HOST, 5000)
      } catch (e) {
        raw.destroy()
        throw e
      }
      go(tlsSock)
    })().catch(reject)
  })
}

// One cheap gate probe. Returns { status, retryAfter }. Any 2xx/429 means the
// proxy tunnel works; 403 means the fingerprint path is broken.
export async function probe(proxy, { model = DEFAULT_MODELS[0], timeoutMs = 12_000 } = {}) {
  const payload = {
    model,
    messages: [
      { role: "system", content: titlePrompt },
      { role: "user", content: "hi" },
    ],
    stream: true,
    max_tokens: 1,
  }
  const res = await sendUpstream(payload, { proxy, timeoutMs })
  const status = res.statusCode || 0
  const retryAfter = res.headers["retry-after"] || null
  // Free proxies often allow only one tunnel at a time. Do not wait for the
  // stream to end: status is all the probe needs, so tear the socket down now.
  res.destroy()
  return { status, retryAfter }
}
