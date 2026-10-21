// Outbound connection helper: HTTP CONNECT (with optional Basic auth) and
// SOCKS5/SOCKS4 (with optional user/pass). Returns the raw tunnel socket.
import net from "node:net"
import tls from "node:tls"

export function parseProxy(raw) {
  let s = String(raw || "").trim()
  if (!s || s.startsWith("#")) return null
  if (!/^[a-z0-9+.-]+:\/\//i.test(s)) s = "http://" + s
  let u
  try {
    u = new URL(s)
  } catch {
    return null
  }
  const proto = u.protocol.replace(":", "").toLowerCase()
  if (!["http", "https", "socks5", "socks5h", "socks4", "socks4a"].includes(proto)) return null
  if (!u.hostname || !u.port) return null
  const port = Number(u.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  const hostPort = `${u.hostname}:${port}`
  const auth = u.username ? `${encodeURIComponent(u.username)}:${encodeURIComponent(u.password)}@` : ""
  return {
    // url stays credential-free for logs; dial carries auth for the connect path
    url: `${proto}://${hostPort}`,
    dial: `${proto}://${auth}${hostPort}`,
    protocol: proto === "socks4a" ? "socks4" : proto === "socks5h" ? "socks5" : proto,
    host: u.hostname,
    port,
    user: u.username ? decodeURIComponent(u.username) : "",
    pass: u.password ? decodeURIComponent(u.password) : "",
    key: `${proto === "socks5h" ? "socks5" : proto === "socks4a" ? "socks4" : proto}://${u.hostname}:${port}`,
  }
}

function dial(p, timeoutMs) {
  const sock = net.connect(p.port, p.host)
  const timer = setTimeout(() => sock.destroy(new Error("proxy connect timeout")), timeoutMs)
  const clear = () => clearTimeout(timer)
  sock.once("close", clear)
  sock.once("error", clear)
  return new Promise((resolve, reject) => {
    sock.once("connect", () => resolve(sock))
    sock.once("error", reject)
  })
}

function waitEvent(sock, event) {
  return new Promise((resolve, reject) => {
    const onErr = (e) => {
      cleanup()
      reject(e)
    }
    const onOk = () => {
      cleanup()
      resolve()
    }
    const cleanup = () => {
      sock.removeListener("error", onErr)
      sock.removeListener(event, onOk)
    }
    sock.once("error", onErr)
    sock.once(event, onOk)
  })
}

function reader(sock) {
  let buf = Buffer.alloc(0)
  let want = 0
  let waiter = null
  let ended = false
  const wake = () => {
    if (waiter) {
      const w = waiter
      waiter = null
      w()
    }
  }
  const onData = (c) => {
    buf = Buffer.concat([buf, c])
    if (waiter && buf.length >= want) wake()
  }
  const onEnd = () => {
    ended = true
    wake()
  }
  sock.on("data", onData)
  sock.once("end", onEnd)
  sock.once("close", onEnd)
  return async function readExactly(n) {
    want = n
    while (buf.length < n && !ended) await new Promise((resolve) => (waiter = resolve))
    want = 0
    const out = buf.subarray(0, n)
    buf = buf.subarray(n)
    return out
  }
}

function readHead(sock, marker) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0)
    const cleanup = () => {
      sock.removeListener("data", onData)
      sock.removeListener("error", onErr)
      sock.removeListener("end", onEnd)
    }
    const onData = (c) => {
      buf = Buffer.concat([buf, c])
      if (buf.includes(marker)) {
        cleanup()
        resolve(buf.toString("latin1"))
      } else if (buf.length > 8192) {
        cleanup()
        reject(new Error("proxy response too large"))
      }
    }
    const onErr = (e) => {
      cleanup()
      reject(e)
    }
    const onEnd = () => {
      cleanup()
      reject(new Error("proxy closed before response"))
    }
    sock.on("data", onData)
    sock.once("error", onErr)
    sock.once("end", onEnd)
  })
}

function connectHead(p, host, port) {
  let head = `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n`
  if (p.user) {
    const cred = Buffer.from(`${p.user}:${p.pass}`).toString("base64")
    head += `Proxy-Authorization: Basic ${cred}\r\n`
  }
  return head + "\r\n"
}

async function connectHttp(p, host, port, timeoutMs) {
  let sock = await dial(p, timeoutMs)
  if (p.protocol === "https") {
    const s = tls.connect({ socket: sock, servername: p.host })
    const timer = setTimeout(() => s.destroy(new Error("proxy tls timeout")), timeoutMs)
    try {
      await waitEvent(s, "secureConnect")
    } finally {
      clearTimeout(timer)
    }
    sock = s
  }
  sock.write(connectHead(p, host, port))
  const res = await readHead(sock, "\r\n\r\n")
  if (!/^HTTP\/1\.[01] 2\d\d/.test(res)) {
    sock.destroy()
    throw new Error("proxy refused: " + res.split("\r\n")[0])
  }
  return sock
}

async function connectSocks5(p, host, port, timeoutMs) {
  const sock = await dial(p, timeoutMs)
  try {
    const read = reader(sock)
    sock.write(Buffer.from(p.user ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]))
    let head = await read(2)
    if (head[0] !== 0x05) throw new Error("bad socks5 greeting")
    if (head[1] === 0x02) {
      const u = Buffer.from(p.user, "utf8")
      const pw = Buffer.from(p.pass, "utf8")
      sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([pw.length]), pw]))
      head = await read(2)
      if (head[1] !== 0x00) throw new Error("socks5 auth failed")
    } else if (head[1] !== 0x00) throw new Error("socks5 auth method rejected")

    const hb = Buffer.from(host, "utf8")
    sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hb.length]), hb, Buffer.from([port >> 8, port & 0xff])]))
    head = await read(4)
    if (head[0] !== 0x05) throw new Error("bad socks5 reply")
    if (head[1] !== 0x00) throw new Error("socks5 connect failed code " + head[1])
    const atyp = head[3]
    const len = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : (await read(1))[0]
    await read(len + 2)
    return sock
  } catch (e) {
    sock.destroy()
    throw e
  }
}

async function connectSocks4(p, host, port, timeoutMs) {
  const sock = await dial(p, timeoutMs)
  try {
    const parts = [Buffer.from([0x04, 0x01, port >> 8, port & 0xff]), Buffer.from(host, "utf8"), Buffer.from([0x00])]
    if (p.user) parts.push(Buffer.from(p.user, "utf8"), Buffer.from([0x00]))
    sock.write(Buffer.concat(parts))
    const read = reader(sock)
    const head = await read(8)
    if (head[1] !== 0x5a) throw new Error("socks4 connect failed")
    return sock
  } catch (e) {
    sock.destroy()
    throw e
  }
}

// Opens a TCP tunnel to host:port through `proxy`. TLS to the destination is
// the caller's job.
export async function connectVia(proxy, host, port, timeoutMs = 10_000) {
  const p = typeof proxy === "string" ? parseProxy(proxy) : proxy
  if (!p) throw new Error("invalid proxy " + proxy)
  if (p.protocol === "http" || p.protocol === "https") return connectHttp(p, host, port, timeoutMs)
  if (p.protocol === "socks5") return connectSocks5(p, host, port, timeoutMs)
  if (p.protocol === "socks4") return connectSocks4(p, host, port, timeoutMs)
  throw new Error("unsupported proxy protocol " + p.protocol)
}

export function tlsOver(sock, host, timeoutMs = 10_000) {
  const s = tls.connect({ socket: sock, servername: host })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => s.destroy(new Error("tls timeout")), timeoutMs)
    const cleanup = () => clearTimeout(timer)
    s.once("secureConnect", () => {
      cleanup()
      resolve(s)
    })
    s.once("error", (e) => {
      cleanup()
      reject(e)
    })
  })
}
