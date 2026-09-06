#!/bin/sh
# demo-public.sh — one-command public demo: static build + relay + tunnel.
#
# Serves the static export from the relay itself, so the page and /ws share
# one origin (and one tunnel). Opens and prints the station URL once the
# tunnel is up; phones should scan the QR from that station page.
# Kill with Ctrl-C; the relay and tunnel both stop.
#
# Usage: npm run demo:public   (runs from repo root)

set -e
cd "$(dirname "$0")"

PORT="${PORT:-8001}"
TUNNEL_PID=""
TAIL_PID=""
LOG="$(mktemp -t skymesh-cloudflared.XXXXXX.log)"

cleanup() {
  [ -n "$TAIL_PID" ] && kill "$TAIL_PID" 2>/dev/null || true
  [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null || true
  kill "$RELAY_PID" 2>/dev/null || true
  rm -f "$LOG"
}

if [ ! -x ./server/.venv/bin/uvicorn ]; then
  echo "Missing server/.venv/bin/uvicorn. Run:"
  echo "  python3 -m venv server/.venv && ./server/.venv/bin/pip install -r server/requirements.txt"
  exit 1
fi

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "Missing cloudflared. Install it first, e.g.: brew install cloudflared"
  exit 1
fi

echo "==> building static export"
STATIC=1 NEXT_PUBLIC_RELAY_URL=/ws npx next build >/dev/null

echo "==> starting relay on :$PORT"
./server/.venv/bin/uvicorn relay:app --app-dir server --host 127.0.0.1 --port "$PORT" &
RELAY_PID=$!
trap cleanup EXIT INT TERM

# wait for /health
for _ in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
if ! curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  echo "Relay did not become healthy on :$PORT"
  exit 1
fi

echo "==> opening quick tunnel"
cloudflared tunnel --url "http://localhost:$PORT" >"$LOG" 2>&1 &
TUNNEL_PID=$!
tail -f "$LOG" &
TAIL_PID=$!

# quick tunnels print the trycloudflare URL asynchronously; parse it and open /station/.
URL=""
for _ in $(seq 1 90); do
  URL="$(grep -Eo 'https://[-a-zA-Z0-9.]+\.trycloudflare\.com' "$LOG" | head -n 1 || true)"
  if [ -n "$URL" ]; then break; fi
  sleep 1
done

if [ -n "$URL" ]; then
  STATION_URL="$URL/station/"
  echo ""
  echo "============================================================"
  echo "Open station: $STATION_URL"
  echo "Scan the QR on that page. It points phones back to this tunnel."
  echo "============================================================"
  if command -v open >/dev/null 2>&1; then
    open "$STATION_URL" >/dev/null 2>&1 || true
  fi
else
  echo ""
  echo "Could not parse the trycloudflare URL. Check cloudflared output above."
fi

wait "$TUNNEL_PID"
