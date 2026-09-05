#!/bin/bash
# demo.sh — one-command SkyMesh startup.
# Starts fusion server + public tunnel, prints the URLs to point phones at.
# Usage: ./demo.sh [--replay demo1]
set -euo pipefail
cd "$(dirname "$0")/server"

if [ ! -d .venv ]; then
  echo "→ creating venv + installing deps (first run only)"
  python3 -m venv .venv
  .venv/bin/pip install -q -r requirements.txt
fi

echo "→ starting fusion server on :8000"
pkill -f 'uvicorn app:app' 2>/dev/null || true
sleep 1
(.venv/bin/uvicorn app:app --host 0.0.0.0 --port 8000 > uvicorn.log 2>&1 &)
sleep 3
curl -sf localhost:8000/health > /dev/null && echo "  server up"

echo "→ starting cloudflared tunnel"
pkill -f 'cloudflared tunnel' 2>/dev/null || true
(cloudflared tunnel --url http://localhost:8000 > tunnel.log 2>&1 &)
for i in $(seq 1 30); do
  TUNNEL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' tunnel.log | head -1 || true)
  [ -n "${TUNNEL:-}" ] && break
  sleep 1
done
[ -z "${TUNNEL:-}" ] && { echo "tunnel failed; see server/tunnel.log"; exit 1; }
echo "  tunnel: $TUNNEL"

if [ "${1:-}" = "--replay" ]; then
  SESSION="${2:-demo1}"
  echo "→ replaying session $SESSION"
  curl -sf -X POST "localhost:8000/replay/start?session=$SESSION&speed=2" > /dev/null
fi

cat <<EOF

──────────────────────────────────────────────────
  C2 map (local):   http://localhost:8000/map
  C2 map (public):  $TUNNEL/map
  Node page:        https://dnhacks-node.vercel.app?server=$TUNNEL
                    (QR-encode that URL for judges)
  Pinned anchors:   append &lat=..&lon=..&acc=3 per surveyed spot, e.g.
                    https://dnhacks-node.vercel.app?server=$TUNNEL&lat=38.90120&lon=-77.04020&acc=3
                    (do this — indoor phone GPS is ±30m+; see README)
  Event stream:     tail -f server/events.jsonl
  Save a session:   curl -X POST 'localhost:8000/replay/save?session=demo1'
──────────────────────────────────────────────────
NOTE: if the tunnel URL changed since the last Vercel deploy, either use the
?server= link above (works immediately) or redeploy:
  vercel deploy --prod --yes --team <team> --build-env NEXT_PUBLIC_SERVER_URL=$TUNNEL
EOF
