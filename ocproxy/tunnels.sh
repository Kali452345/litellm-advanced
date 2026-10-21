#!/usr/bin/env bash
# Fast private egress for ocproxy: one SOCKS tunnel per SSH host, validated
# against the gateway and published to egress.txt. Entries there are static in
# the pool and survive every free-proxy harvest.
#
#   ./tunnels.sh start      start + validate every host in egress-hosts.txt
#   ./tunnels.sh check      re-validate live tunnels
#   ./tunnels.sh status     show pid and last verdict per host
#   ./tunnels.sh stop       kill everything and empty egress.txt
#
# egress-hosts.txt, one per line:  [user@]host[:port]
# Uses your normal ssh config/keys. No autossh needed.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
HOSTS="${EGRESS_HOSTS:-$DIR/egress-hosts.txt}"
OUT="${EGRESS_OUT:-$DIR/egress.txt}"
STATE="${EGRESS_STATE:-$DIR/.tunnels}"
BASE="${EGRESS_PORT_BASE:-10900}"
BIND="${EGRESS_BIND:-0.0.0.0}"
TARGET="${EGRESS_TARGET:-host.docker.internal}"

mkdir -p "$STATE"
[[ -f "$HOSTS" ]] || { echo "missing $HOSTS (one [user@]host[:port] per line)" >&2; exit 2; }

mapfile -t HOSTLIST < <(grep -vE '^\s*(#|$)' "$HOSTS")
[[ ${#HOSTLIST[@]} -gt 0 ]] || { echo "no hosts in $HOSTS" >&2; exit 2; }

probe() {
  local port="$1"
  ( cd "$DIR" && node -e '
    import("./upstream.mjs").then(async ({ probe }) => {
      try {
        const r = await probe("socks5://127.0.0.1:" + process.argv[1], { timeoutMs: 12000 })
        console.log(r.status)
        process.exit(r.status === 200 ? 0 : 1)
      } catch (e) { console.log("0 " + e.message); process.exit(1) }
    })' "$port" )
}

publish() {
  local tmp="$OUT.tmp"
  : > "$tmp"
  # keep hand-managed lines (VPN sidecars) that are not in our port range
  [[ -f "$OUT" ]] && awk -v p="socks5://$TARGET:$BASE" 'index($0,p) != 1' "$OUT" >> "$tmp"
  for ((i = 0; i < ${#HOSTLIST[@]}; i++)); do
    [[ -f "$STATE/$i.ok" ]] && echo "socks5://$TARGET:$((BASE + i))" >> "$tmp"
  done
  mv "$tmp" "$OUT"
  echo "published $(grep -c . "$OUT" 2>/dev/null) tunnel(s) to $OUT"
}

start_one() {
  local i="$1" host="${HOSTLIST[$1]}" port=$((BASE + i))
  if [[ -f "$STATE/$i.pid" ]] && kill -0 "$(cat "$STATE/$i.pid")" 2>/dev/null; then
    return
  fi
  local dest="$host"
  [[ "$dest" == *:* ]] && dest="${dest%:*}"
  ssh -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=20 \
      -o ServerAliveCountMax=3 -o StrictHostKeyChecking=accept-new \
      -N -D "$BIND:$port" "$dest" </dev/null >"$STATE/$i.log" 2>&1 &
  echo $! > "$STATE/$i.pid"
  for _ in $(seq 1 20); do
    sleep 0.5
    kill -0 "$(cat "$STATE/$i.pid")" 2>/dev/null || break
    ss -ltn 2>/dev/null | grep -q ":$port " && break
  done
}

cmd_start() {
  local ok=0
  rm -f "$STATE"/*.ok
  for i in "${!HOSTLIST[@]}"; do
    echo "tunnel $i -> ${HOSTLIST[$i]} (port $((BASE + i)))"
    start_one "$i"
    local status
    status="$(probe $((BASE + i)))"
    if [[ "$status" == "200" ]]; then
      touch "$STATE/$i.ok"; ok=$((ok + 1)); echo "  ok"
    else
      echo "  rejected (gateway status $status) — left running, not published"
    fi
  done
  publish
  echo "usable: $ok/${#HOSTLIST[@]}"
}

cmd_check() {
  for i in "${!HOSTLIST[@]}"; do
    local status
    status="$(probe $((BASE + i)))"
    if [[ "$status" == "200" ]]; then touch "$STATE/$i.ok"; else rm -f "$STATE/$i.ok"; fi
    echo "$i ${HOSTLIST[$i]}: $status"
  done
  publish
}

cmd_status() {
  for i in "${!HOSTLIST[@]}"; do
    local pid="" alive="down"
    [[ -f "$STATE/$i.pid" ]] && pid="$(cat "$STATE/$i.pid")" && kill -0 "$pid" 2>/dev/null && alive="up"
    echo "$i ${HOSTLIST[$i]}: $alive pid=${pid:-none} published=$([[ -f "$STATE/$i.ok" ]] && echo yes || echo no)"
  done
}

cmd_stop() {
  for f in "$STATE"/*.pid; do
    [[ -f "$f" ]] && kill "$(cat "$f")" 2>/dev/null
    rm -f "$f"
  done
  rm -f "$STATE"/*.ok
  : > "$OUT"
  echo "stopped"
}

case "${1:-start}" in
  start) cmd_start ;;
  check) cmd_check ;;
  status) cmd_status ;;
  stop) cmd_stop ;;
  *) echo "usage: $0 {start|check|status|stop}"; exit 1 ;;
esac
