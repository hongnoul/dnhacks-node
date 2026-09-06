#!/bin/sh
# demo-public.sh — one-command public demo: static build + relay + tunnel.
#
# Serves the static export from the relay itself, so the page and /ws share
# one origin (and one tunnel). Prints the station URL once the tunnel is up.
# Kill with Ctrl-C; the relay and tunnel both stop.
#
# Usage: npm run demo:public   (runs from repo root)

set -e
cd "$(dirname "$0")"

PORT="${PORT:-8001}"

echo "==> building static export"
STATIC=1 NEXT_PUBLIC_RELAY_URL=/ws npx next build >/dev/null

echo "==> starting relay on :$PORT"
./server/.venv/bin/uvicorn relay:app --app-dir server --host 127.0.0.1 --port "$PORT" &
RELAY_PID=$!
trap 'kill $RELAY_PID 2>/dev/null; kill $TUNNEL_PID 2>/dev/null' EXIT INT TERM

# wait for /health
for _ in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi
  sleep 1
done

echo "==> opening quick tunnel"
cloudflared tunnel --url "http://localhost:$PORT" 2>&1 &
TUNNEL_PID=$!

# quick tunnels print the trycloudflare URL on stderr; wait and surface it
sleep 8
echo ""
echo "Open the station URL above (append /station/), or find it with:"
echo "  ps aux | grep cloudflared   # check the log line with trycloudflare.com"
wait $TUNNEL_PID
