#!/usr/bin/env bash
# Keeps one or more Render egress relays awake and maintains their egress.txt
# entries. Run from the litellm host's crontab every few minutes:
#
#   */5 * * * * OC_RENDER_HOSTS=/etc/ocproxy/render-hosts ~/litellm-advanced/ocproxy/render-keepalive.sh >> /var/log/render-keepalive.log 2>&1
#
# /etc/ocproxy/render-hosts holds one line per relay:  <host> <key>
# A relay that answers /healthz 200 is added to egress.txt; after FAILS_BEFORE_DROP
# consecutive failures it is removed again. Render free instances spin down after
# 15 minutes without inbound traffic, and a cold start takes about a minute, so the
# drop is deliberately slow.
set -uo pipefail

HOSTS_FILE="${OC_RENDER_HOSTS:-$HOME/.config/ocproxy/render-hosts}"
EGRESS_FILE="${OC_EGRESS_FILE:-$(cd "$(dirname "$0")" && pwd)/../egress.txt}"
STATE_DIR="${OC_RENDER_STATE:-$HOME/.local/state/ocproxy}"
FAILS_BEFORE_DROP="${FAILS_BEFORE_DROP:-3}"
TIMEOUT="${TIMEOUT:-90}"
MARKER="render-relay"

mkdir -p "$STATE_DIR"
[ -f "$HOSTS_FILE" ] || { echo "$(date -Is) no host file at $HOSTS_FILE"; exit 0; }

# serialise runs so two overlapping crons cannot fight over egress.txt
if command -v flock >/dev/null; then
  exec 9>"$STATE_DIR/lock"
  flock -n 9 || exit 0
fi

touch "$EGRESS_FILE"

# remove the entry and its comment marker, so repeated add/drop cycles do not
# leave orphaned comments behind
drop_line() {
  local pattern="$1"
  local marker_line="# $MARKER $2"
  # grep -v exits 1 when the file becomes empty, so do not chain with &&
  { grep -vF -- "$pattern" "$EGRESS_FILE" | grep -vxF -- "$marker_line"; } > "$EGRESS_FILE.tmp"
  mv "$EGRESS_FILE.tmp" "$EGRESS_FILE"
}

while read -r host key; do
  [ -n "${host:-}" ] && [ -n "${key:-}" ] || continue
  case "$host" in \#*) continue ;; esac
  host="${host#https://}"; host="${host%/}"

  # the URL form ocproxy dials: https://KEY:x@host:443
  line="https://${key}:x@${host}:443"
  fails_file="$STATE_DIR/$(printf '%s' "$host" | tr -c 'a-z0-9.-' '_').fails"
  fails=0
  [ -f "$fails_file" ] && fails="$(cat "$fails_file")"

  code="$(curl -s -o /dev/null -m "$TIMEOUT" -w '%{http_code}' "https://${host}/healthz" || echo 000)"

  if [ "$code" = "200" ]; then
    echo 0 > "$fails_file"
    grep -qF -- "$line" "$EGRESS_FILE" || {
      printf '# %s %s\n%s\n' "$MARKER" "$host" "$line" >> "$EGRESS_FILE"
      echo "$(date -Is) $(printf '%q' "$host") awake -> added to egress"
    }
  else
    fails=$((fails + 1))
    echo "$fails" > "$fails_file"
    echo "$(date -Is) $(printf '%q' "$host") health $code (fail $fails/$FAILS_BEFORE_DROP)"
    if [ "$fails" -ge "$FAILS_BEFORE_DROP" ]; then
      drop_line "$line" "$host"
      echo "$(date -Is) $(printf '%q' "$host") dropped from egress"
    fi
  fi
done < "$HOSTS_FILE"
