# Running the mesh

    cd sim-demo
    npm install          # also vendors the detector + ONNX model from ml-demo
    python3 -m venv server/.venv && ./server/.venv/bin/pip install -r server/requirements.txt

Two processes:

    npm run relay     # FastAPI relay, :8001
    npm run dev       # Next.js, :3000

Then:

- **`/station`** — the operator console (laptop screen). Left sidebar: QR to put
  phones on this session, a clickable 3D drone playing real DADS audio, and
  wind/music selections as false-positive stress tests: play those loud and
  detection should stay quiet, which is more convincing than only ever showing
  it succeed. Right: the dashboard — admit nodes, place them, draw the
  topology, cut links. (`/admin` redirects here for old bookmarks.)
- **`/`** — a sensor node. One tap to join; needs mic permission.

Multi-tab testing: `?node=n03` pins identity per tab. `localStorage` is shared across tabs
of one origin, so without it every tab claims the same node id and the result looks exactly
like a replication bug. `?session=<id>` isolates a run.

## Phones

`getUserMedia` needs HTTPS — on Android too, not just iOS; only `localhost` is exempt, so
a LAN IP will not work. Serve the static build from the relay so the page and the socket
share one origin, then tunnel that one port:

    npm run demo:public     # build + serve + quick tunnel; prints the station URL
    # or step by step:
    npm run build:static      # static export; relay serves it beside /ws
    npm run serve             # relay on :8001, app included
    cloudflared tunnel --url http://localhost:8001

Open `<tunnel>/station/` on the laptop and have phones scan the QR. Because it is one
origin, `wss://` resolves to the same host and no second tunnel is needed.

Note the static build is a *build*: re-run `npm run build:static` after code changes.
`npm run dev` on :3000 is still there for iterating.

## Demo script

1. `/station`, then open `/?node=n01` … `/?node=n06` and admit each.
2. **two clusters + bridge**, then **auto-place**. The bridge is the cut edge.
3. Click the drone on `/station` (or play `public/drone-demo.wav`) — the on-device CRNN
   fires, the DRONE DETECTED banner lights, and the console's per-node confidence graphs
   spike.

   With every node on one laptop mic they all hear the same thing at the same level,
   which constrains nothing: the console will say **"detecting, but not localised"**
   and draw no marker. That is correct. Localisation needs real separation between
   devices — spatial diversity matters more than node count (ARCHITECTURE.md §13.1).
4. **Kill a node**: close a tab. Its records survive on every other phone.
5. **Partition**: cut `n03–n04`. Both halves keep working on their own picture.
6. **Heal**: restore it. Union of grow-only sets — nothing to reconcile.
7. **Degrade all (500 ms, 20%)**: push suffers, anti-entropy still converges.

What to say honestly: state and computation are distributed — no fused picture exists
anywhere but on the phones. Delivery is not; the relay carries every message, and in a real
deployment those hops are radio links (ARCHITECTURE.md §4.0).

## Tests

    npm test                        # unit + integration (scenario, fusion, mesh, integration)
    node tests/ui-smoke.mjs         # browser smoke; relay + dev must be running
    node tests/detector-smoke.mjs   # CRNN fires on synthesised drone audio

## What the console shows

**detections** — each node's CRNN confidence over the last 60 s, at ml-demo's 0.5
threshold. Drawn from records that gossiped here, so the graph is both the detection
picture and evidence that replication works.

**topology** — the adjacency graph. Imposed, standing in for radio range.

**link emulation** (collapsed) — latency, loss, and cutting links. Network conditions,
not detection: what phones would face in the field but never see on one WiFi.

**scenario controls** — the demo layer, ported from `avery/frontend-map`'s operator
map and rewired from mock state to live mesh primitives:

- **place node** — hover previews placement constraints (1.2 m min separation,
  6 m link range, 2 neighbours). Clicking a valid spot logs it; no mock node is
  created — a real phone is still admitted and placed via gossip records.
- **simulate drone** — click a start and destination, then start flight. The ✦
  marker and halo are a visual hint only, never a record; nodes inside the halo
  trigger an alert routed hop-by-hop to the command post (this console).
- **simulate impact** — click the map to cut every link touching nodes in the
  3 m blast radius; links restore after 8 s. Real partition, not a mock flag.
- **disable random node** — isolates one node for 6 s, then it rejoins.
- **simulate interference** — toggles 500 ms + 20% loss on all links; the badge
  reads elevated while on. Click again to restore nominal.
- **replay scenario** — one-click demo: interference on, a drone flight across
  the room while links are degraded, then restore. Fixed west-to-east path, so
  there is nothing to aim.
- **health + connectivity** — share of admitted nodes with fresh readings, and
  whether the sensor graph is connected over links that are up.

**activity** — scenario events (placement, flights, routing, outages), newest
first, capped at six. Repeat halo detections dedupe to one line per node.

Clicking a node opens an **inspector**: heartbeat (fresh readings vs silent),
position, confidence, and per-link up/cut state.

## Detection

Detection is ml-demo's, not a re-implementation, and it is **stateful**: hysteresis
(trip 0.35, release 0.25) plus a marginal trip (3 straight ticks ≥ 0.22, for a distant
drone that never reaches the trip point), scored at 4 Hz. `detection.ts` mirrors that
latch, and the verdict travels on the wire as `d` — a peer cannot recover it by comparing
`p` to a threshold, and if it tried, the mesh and the standalone demo would disagree about
the same audio.

Re-check `detection.ts` whenever ml-demo retunes.

The vendoring: `npm install` vendors `mel.ts`,
`detector.ts`, `audio.ts` and `drone_crnn.onnx` from `../ml-demo` via
`vendor-detector.mjs`, so the CRNN and its bit-parity mel front end stay a single
source of truth. Re-run `npm run vendor` after ml-demo changes.

`scoring.ts` adds one thing on top: a **level channel**. The detector peak-normalises
every window before the mel front end, so its probability carries no distance
information — measured at p = 1.00 from across a room. Fusion localises by comparing
levels between nodes, so range comes from `bandLoudness` (RMS in the drone band, taken
before that normalisation) against a tracked noise floor. The CRNN answers "is it a
drone"; the level answers "how close".
