// Health-aware outbound proxy pool. Free proxies die constantly and a 429
// means the OpenCode bucket behind that egress IP is spent, so every proxy
// carries a state and a cooldown instead of being retried blindly.
import fs from "node:fs"
import { parseProxy } from "./connect.mjs"

export class ProxyPool {
  constructor({
    staticProxies = [],
    staticFile = null,
    file = null,
    limitedMs = 6 * 3600_000,
    deadFails = 3,
    // how soon a parked egress may be re-probed, so a recovered IP comes back
    // without waiting out the whole park window
    reviveMs = Number(process.env.OC_REVIVE_MS || 120_000),
    log = () => {},
  } = {}) {
    this.reviveMs = reviveMs
    this.file = file
    this.staticFile = staticFile
    this.limitedMs = limitedMs
    this.deadFails = deadFails
    this.log = log
    // key of the most recent egress that actually served a request; it is
    // preferred while idle so a working IP keeps the traffic instead of being
    // re-rolled on every turn (which also burns five IPs' quota per request).
    this.lastGood = null
    this.state = new Map()
    this.order = []
    this.mtime = 0
    this.staticMtime = 0
    this.inFlight = new Map()
    for (const raw of staticProxies) this.add(raw, "static")
    this.reload()
    this.reloadStatic()
    this.timer = setInterval(() => {
      this.reload()
      this.reloadStatic()
    }, 5000)
    this.timer.unref?.()
  }

  add(raw, origin = "file") {
    const p = parseProxy(raw)
    if (!p) return null
    if (this.state.has(p.key)) return null
    this.state.set(p.key, {
      key: p.key,
      url: p.url,
      dial: p.dial,
      origin,
      status: "new",
      fails: 0,
      reviveAt: 0,
      okCount: 0,
      lastUsed: 0,
      lastOk: 0,
      until: 0,
      latency: 0,
    })
    this.order.push(p.key)
    return p.key
  }

  reload() {
    if (!this.file) return
    let st
    try {
      st = fs.statSync(this.file)
    } catch {
      return
    }
    if (st.mtimeMs === this.mtime) return
    this.mtime = st.mtimeMs
    this.reloadInto(this.file, "file")
  }

  // Private, fast egress (ssh -D tunnels, VPN local proxies) lives in its own
  // file and is never dropped by a harvest publish.
  reloadStatic() {
    if (!this.staticFile) return
    let st
    try {
      st = fs.statSync(this.staticFile)
    } catch {
      return
    }
    if (st.mtimeMs === this.staticMtime) return
    this.staticMtime = st.mtimeMs
    this.reloadInto(this.staticFile, "static")
  }

  reloadInto(file, origin) {
    let text
    try {
      text = fs.readFileSync(file, "utf8")
    } catch {
      return
    }
    const seen = new Set()
    for (const line of text.split("\n")) {
      const p = parseProxy(line)
      if (!p) continue
      seen.add(p.key)
      const added = this.add(line, origin)
      // the harvester already gate-probed file entries
      if (added && origin === "file") {
        const st = this.state.get(added)
        st.status = "ok"
        st.lastOk = Date.now()
      }
    }
    for (const [key, s] of this.state) {
      if (s.origin === origin && !seen.has(key)) {
        this.state.delete(key)
        this.order = this.order.filter((k) => k !== key)
      }
    }
    const usable = this.snapshot().filter((s) => s.status === "ok").length
    this.log({ event: "pool-file", file, origin, total: this.size(), usable })
  }

  size() {
    return this.state.size
  }

  healthy() {
    const now = Date.now()
    let n = 0
    for (const s of this.state.values()) if ((s.status === "ok" || s.status === "new") && s.until <= now) n++
    return n
  }

  candidates() {
    const now = Date.now()
    return [...this.state.values()].filter((s) => s.status !== "dead" && s.until <= now)
  }

  // Highest-scoring, least-busy proxy; random within the top slice so parallel
  // requests spread instead of hammering one IP into a 429.
  pick(exclude = new Set()) {
    // sticky: keep using the last egress that worked, but only while it is idle
    // and not parked -- so parallel requests still spread and a 429 hands over.
    const sticky = this.lastGood && !exclude.has(this.lastGood) ? this.state.get(this.lastGood) : null
    if (sticky && sticky.status !== "dead" && sticky.until <= Date.now() && !this.inFlight.get(sticky.key)) {
      return sticky
    }
    const ranked = this.candidates()
      .filter((s) => !exclude.has(s.key))
      .map((s) => {
        const busy = this.inFlight.get(s.key) || 0
        const statusRank = s.status === "ok" ? 3 : s.status === "new" ? 2 : 1
        const score = statusRank * 1000 + Math.min(s.okCount, 50) * 5 - s.fails * 40 - busy * 120 - (s.latency || 0) / 100
        return { s, score }
      })
      .sort((a, b) => b.score - a.score)
    if (!ranked.length) {
      // Everything is quota-parked. A park is only a hint, and the gateway hands
      // out ~13h Retry-After windows that are far longer than the real refill, so
      // giving up here would strand the whole pool behind a single direct try.
      // Retry the soonest-due parked entry instead.
      const parked = [...this.state.values()]
        .filter((s) => s.status !== "dead" && !exclude.has(s.key))
        .sort((a, b) => a.until - b.until)
      return parked.length ? parked[0] : null
    }
    const slice = ranked.slice(0, Math.min(5, ranked.length))
    return slice[Math.floor(Math.random() * slice.length)].s
  }

  begin(key) {
    this.inFlight.set(key, (this.inFlight.get(key) || 0) + 1)
    const s = this.state.get(key)
    if (s) s.lastUsed = Date.now()
  }

  end(key) {
    const n = (this.inFlight.get(key) || 1) - 1
    if (n <= 0) this.inFlight.delete(key)
    else this.inFlight.set(key, n)
  }

  report(key, outcome, latency = 0) {
    const s = this.state.get(key)
    if (!s) return
    const now = Date.now()
    if (outcome === "ok") {
      s.status = "ok"
      s.fails = 0
      s.okCount++
      s.lastOk = now
      s.until = 0
      s.reviveAt = 0
      s.latency = s.latency ? Math.round(s.latency * 0.7 + latency * 0.3) : latency
      this.lastGood = key
      return
    }
    if (outcome === "limited") {
      s.status = "ok" // still reachable, just out of bucket
      s.fails = 0
      s.until = now + this.limitedMs
      // a quota park is not permanent: re-check it well before the window ends
      s.reviveAt = now + this.reviveMs
      return
    }
    if (outcome === "reject") {
      // 403 is usually "abusive network" for a shared datacenter IP; it can
      // clear, so park it rather than dropping it for good.
      s.fails++
      s.status = "new"
      s.until = now + 30 * 60_000
      s.reviveAt = now + this.reviveMs * 5
      return
    }
    // transport failure
    s.fails++
    s.status = s.fails >= this.deadFails ? "dead" : "new"
    const backoff = Math.min(15 * 60_000, 30_000 * 2 ** Math.max(0, s.fails - 1))
    s.until = now + backoff
    s.reviveAt = now + Math.min(backoff, this.reviveMs)
  }

  // Parked entries whose revive window elapsed. Only these are re-probed, so a
  // healthy pool costs nothing and a recovered IP returns on its own.
  dueForRevive() {
    const now = Date.now()
    return [...this.state.values()].filter(
      (s) => s.until > now && s.reviveAt && s.reviveAt <= now && !this.inFlight.get(s.key),
    )
  }

  markAllLimited(ms = this.limitedMs) {
    const now = Date.now()
    for (const s of this.state.values()) {
      if (s.status !== "dead") {
        s.status = "ok"
        s.until = now + ms
      }
    }
  }

  snapshot() {
    const now = Date.now()
    return [...this.state.values()].map((s) => ({
      proxy: s.url,
      status: s.until > now ? "cooldown" : s.status,
      fails: s.fails,
      ok: s.okCount,
      latency: s.latency,
      until: s.until ? new Date(s.until).toISOString() : null,
    }))
  }

  close() {
    if (this.timer) clearInterval(this.timer)
  }
}
