#!/bin/bash
# demo.sh — one-command SkyMesh startup.
# Starts fusion server + public tunnel, prints the URLs to point phones at.
# Usage: ./demo.sh [--replay demo1]
set -euo pipefail
cd "$(dirname "$0")/server"

# QR mode: ./demo.sh --qr lat,lon [lat,lon ...] — prints terminal QR codes
# (pip install qrcode) plus the plain URLs, one per pinned anchor spot.
if [ "${1:-}" = "--qr" ]; then
  shift
  TUNNEL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' tunnel.log 2>/dev/null | head -1 || true)
  [ -z "${TUNNEL:-}" ] && { echo "no tunnel running; run ./demo.sh first"; exit 1; }
  if ! python3 -c "import qrcode" 2>/dev/null && ! .venv/bin/python -c "import qrcode" 2>/dev/null; then
    echo "(install once: pip install qrcode — printing URLs only)"
  fi
  i=0
  for spot in "$@"; do
    i=$((i + 1))
    lat=$(echo "$spot" | cut -d, -f1); lon=$(echo "$spot" | cut -d, -f2)
    URL="https://dnhacks-node.vercel.app?server=$TUNNEL&lat=$lat&lon=$lon&acc=3"
    echo ""
    echo "── anchor $i ($lat, $lon) ──"
    echo "$URL"
    (python3 -c "import qrcode, sys; q=qrcode.QRCode(border=1); q.add_data(sys.argv[1]); q.print_ascii()" "$URL" 2>/dev/null || \
     .venv/bin/python -c "import qrcode, sys; q=qrcode.QRCode(border=1); q.add_data(sys.argv[1]); q.print_ascii()" "$URL" 2>/dev/null || true)
  done
  exit 0
fi

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
[ -z "${TUNNEL:-}" ] && { echo "tunnel failed; see ml-demo/server/tunnel.log"; exit 1; }
echo "  tunnel: $TUNNEL"

if [ "${1:-}" = "--replay" ]; then
  SESSION="${2:-demo1}"
  echo "→ replaying session $SESSION"
  curl -sf -X POST "localhost:8000/replay/start?session=$SESSION&speed=2" > /dev/null
fi

cat <<EOF

──────────────────────────────────────────────────
  Node page:        https://dnhacks-node.vercel.app?server=$TUNNEL
                    (QR-encode that URL for judges)
  Pinned anchors:   append &lat=..&lon=..&acc=3 per surveyed spot, e.g.
                    https://dnhacks-node.vercel.app?server=$TUNNEL&lat=38.90120&lon=-77.04020&acc=3
                    (do this — indoor phone GPS is ±30m+; see README)
  Event stream:     tail -f ml-demo/server/events.jsonl
  Save a session:   curl -X POST 'localhost:8000/replay/save?session=demo1'
  QR codes:         ./demo.sh --qr 38.90120,-77.04020 38.90030,-77.04020 [...]
──────────────────────────────────────────────────
NOTE: if the tunnel URL changed since the last Vercel deploy, either use the
?server= link above (works immediately) or redeploy:
  vercel deploy --prod --yes --team <team> --build-env NEXT_PUBLIC_SERVER_URL=$TUNNEL
EOF
