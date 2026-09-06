#!/bin/bash
# demo.sh — one-command SkyMesh Demo 1 startup (fully on-device).
# No server, no tunnel: the CRNN runs in each phone's browser.
# Usage:
#   ./demo.sh            start local dev server (mic works on localhost)
#   ./demo.sh --qr       print QR code(s) for the prod URL — judges scan & tap
#   ./demo.sh --test     run the full verification suite (parity + browser e2e)
set -euo pipefail
cd "$(dirname "$0")"

PROD_URL="https://dnhacks-node.vercel.app"

if [ "${1:-}" = "--qr" ]; then
  echo "── SkyMesh node — scan, tap, allow mic ──"
  echo "$PROD_URL"
  (python3 -c "import qrcode, sys; q=qrcode.QRCode(border=1); q.add_data(sys.argv[1]); q.print_ascii()" "$PROD_URL" 2>/dev/null || \
   server/.venv/bin/python -c "import qrcode, sys; q=qrcode.QRCode(border=1); q.add_data(sys.argv[1]); q.print_ascii()" "$PROD_URL" 2>/dev/null || \
   echo "(pip install qrcode for a terminal QR — URL above works as-is)")
  exit 0
fi

if [ "${1:-}" = "--test" ]; then
  echo "→ parity: browser pipeline vs PyTorch reference"
  npm run test:parity
  echo "→ browser e2e (starts next dev if not running)"
  if ! curl -sf -o /dev/null http://localhost:3000; then
    (npm run dev > /tmp/skymesh-dev.log 2>&1 &)
    for i in $(seq 1 30); do curl -sf -o /dev/null http://localhost:3000 && break; sleep 1; done
  fi
  node server/e2e-browser.mjs
  exit 0
fi

[ -d node_modules ] || { echo "→ npm install (first run only)"; npm install; }

cat <<EOF
──────────────────────────────────────────────────
  Prod (judges):    $PROD_URL
                    ./demo.sh --qr  prints a scannable code
  Local dev:        http://localhost:3000  (starting now…)
  Verify:           ./demo.sh --test

  The demo: tap Start listening, allow mic, play drone audio
  (/tone page on a second device works). Confidence → ~100%.
  Kicker: airplane mode ON — it still detects. No server anywhere.
──────────────────────────────────────────────────
EOF
exec npm run dev
