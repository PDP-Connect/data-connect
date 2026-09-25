#!/usr/bin/env bash
# Reset the live DR demo: wipe every grant and record on the PDPP app,
# re-seed the fictitious data, and restart the portal so it re-registers.
#
#   OWNER_PASSWORD=… scripts/demo-dr/reset-live.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PDPP_APP="${PDPP_APP:-pdpp-demo-rd}"
PORTAL_APP="${PORTAL_APP:-proactivos-demo-rd}"
ORIGIN="https://${PDPP_APP}.fly.dev"
DB_FILES="/var/lib/pdpp/pdpp.sqlite /var/lib/pdpp/pdpp.sqlite-shm /var/lib/pdpp/pdpp.sqlite-wal"

if [ -z "${OWNER_PASSWORD:-}" ]; then
  echo "Set OWNER_PASSWORD." >&2
  exit 1
fi

wait_ready() {
  local url="$1" tries=40
  until [ "$(curl -s -o /dev/null -w '%{http_code}' "$url")" = 200 ]; do
    tries=$((tries - 1))
    [ "$tries" -le 0 ] && { echo "timed out waiting for $url" >&2; exit 1; }
    sleep 5
  done
}

echo "Wiping $PDPP_APP data…"
fly ssh console -a "$PDPP_APP" -C "rm -f $DB_FILES"
fly apps restart "$PDPP_APP"
wait_ready "$ORIGIN/.well-known/oauth-protected-resource/mcp"

echo "Seeding…"
(cd "$ROOT" && ORIGIN="$ORIGIN" node --import tsx scripts/demo-dr/seed-remote.ts)

echo "Restarting ${PORTAL_APP}…"
fly apps restart "$PORTAL_APP"
wait_ready "https://${PORTAL_APP}.fly.dev/healthz"
echo "Reset done."
