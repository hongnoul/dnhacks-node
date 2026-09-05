# ml-demo — live-mic drone detection (Demo 1)

Port of the working `justin-draft` branch: phone/laptop mics detect drone
audio on-device, a FastAPI server fuses detections into a live track on a
Leaflet C2 map. All e2e-tested. See the repo root `README.md` for the
two-demo story.

## How it works

**Topology: distributed sensing, centralized fusion.** Edge pre-filtering
on-device, centralized fusion server. Nodes are trusted volunteers
contributing *measurements*, not conflicting state, so there is nothing to
vote on. GCC-PHAT fusion needs all clips in one place anyway. Bad-mic
outliers are handled statistically at fusion time.

**Event-stream schema.** Everything is a producer/consumer of JSONL events:

```jsonc
// heartbeat (1 Hz when no detection)
{"type":"heartbeat","node_id":"abc123","t":1725550000.0,"lat":38.9,"lon":-77.04,"loudness":0.12}
// detection (gate trip → 2 s clip shipped)
{"type":"detection","node_id":"abc123","t":1725550001.5,"loudness":0.83,"clip_ref":"/clips/abc123_1725550001.wav","lat":38.9,"lon":-77.04}
// fused track (server output)
{"type":"track","t":1725550002.0,"lat":38.9001,"lon":-77.0401,"err_m":9.2,"n_nodes":6}
// RemoteID sidecar (bonus node type, optional)
{"type":"remoteid","node_id":"sidecar-1","drone_id":"DJI-MINI4K-AB12","lat":38.90125,"lon":-77.04015}
```

## Node client (`app/` — Next.js PWA, iPhone-first, zero-install)

- Plain Safari tab (not Add-to-Home-Screen — standalone-mode mic is flaky).
- Mic with `echoCancellation/noiseSuppression/autoGainControl: false`,
  Screen Wake Lock, visible listening animation.
- Pipeline: `getUserMedia → WebAudio analyser FFT → dual on-device gate`.
  No TF.js model ships: the node runs a harmonic pre-filter, the server
  CRNN (which scores every clip) is the classifier.
- **Dual gate** (`app/page.tsx`): drone-band (80–2000 Hz) RMS > `0.25`
  **and** harmonic peakiness (max/mean band power) > `10`, 3 s refractory.
  Measured: drone ~36, noise ~6, synthetic tone ~280/8408. The node page
  shows both meters (`39%` + `27.6× prop-like` vs `flat`).
- Server override: `?server=https://…` (used by QR codes, e2e, tunnel
  rotation). Pinned anchors: `?lat=…&lon=…&acc=3` locks position for the
  demo — indoor phone GPS (±30 m+) feeds straight into the centroid.
- Privacy: pre-filtering is on-device; raw audio leaves the phone only as
  2 s detection clips, opt-in. No continuous streaming.

## Fusion server (`server/` — FastAPI, single box)

- Ingest heartbeats + clips → append to `events.jsonl`, clips in `clips/`.
- **CRNN judge:** every clip scored by
  [AntoineNaccache/drone-audio-detector](https://huggingface.co/AntoineNaccache/drone-audio-detector)
  (`aug_mixed`) → `server_conf`. DADS drone clips score 1.000, negatives
  ≤0.002. Checkpoint keys need remapping — `model.py` handles it.
- **Always on:** loudness×confidence weighted centroid over a 4 s window
  (`CONF_THRESHOLD 0.5`), GPS-trust weighting (bad fixes downweighted),
  `err_m` = standard error (spread/√n, floor = mean GPS accuracy, min 12 m)
  so the ellipse visibly tightens as nodes join (sim: 150→71→55→51 m).
- **Stretch (built):** ≥4 concurrent clips → GCC-PHAT pairwise delays
  (`tdoa.py`) → least-squares multilateration seeded at the centroid.
  Physical sim: **8.7 m error vs 51 m centroid**. Coarse trigger alignment
  only — no clock-sync rabbit hole.
- **RemoteID sidecar (built):** `POST /ingest/remoteid
  {node_id, drone_id, lat, lon, alt_m?, speed_mps?}` → `remoteid` event →
  `/state.remoteid` (30 s freshness) → badge on the map. Feed from
  OpenDroneID or a BT dongle. Never the critical path: sub-250 g drones
  broadcast nothing — that's why acoustic matters.
- **`/map` (operator C2 view):** nodes + GPS accuracy discs, fused track +
  error circle + contribution lines, per-node health table (accuracy,
  loudness, staleness), track history (last 8), alert feed with CRNN
  verdicts + clip playback, RemoteID badge (or the no-broadcast punchline).
  Polls `/state` at 1 Hz.
- **`/replay` (demo insurance):** `POST /replay/save?session=X` snapshots
  the log; `POST /replay/start?session=X&speed=2` re-emits with rebased
  timing so the map reanimates.

### Test suite (all runnable without hardware)

| Test | What it proves |
|---|---|
| `fake_node.py [url]` | transport: heartbeat + clip round-trip byte-identical |
| `sim_fusion.py` | CRNN separation on real DADS audio, fusion accuracy vs truth, ellipse tightening, noise rejection |
| `test_tdoa.py` | GCC-PHAT recovers a known 23.1 ms shift; physical sim 8.7 m vs 51 m centroid |
| `e2e-browser.mjs` | prod page in real Chromium (fake mic + GPS): join → gate → clips reach the live server via `?server=` override; asserts its own node id |
| `e2e-map.mjs` | self-seeding: map renders nodes/track/alerts/health/history, zero JS errors |
| `e2e-map-tunnel.mjs` | same through the live public tunnel (judge's-eye view) |

`drone_tone.wav` (fake-mic fixture) regenerates on first `e2e-browser.mjs`
run — never committed. `testdata/` (DADS clips) and `models/` (CRNN
checkpoint) are gitignored runtime data; refetch via the HF dataset
`geronimobasso/drone-audio-detection-samples` and
`hf_hub_download(AntoineNaccache/drone-audio-detector)`.

## Quickstart

**One command:** `./demo.sh` starts the server + tunnel and prints all URLs
(`--replay demo1` animates the recorded session;
`--qr lat,lon [...]` prints terminal QR codes per pinned anchor).

```bash
cd ml-demo/server
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app:app --host 0.0.0.0 --port 8000
cloudflared tunnel --url http://localhost:8000   # phones need HTTPS
.venv/bin/python fake_node.py https://<tunnel>.trycloudflare.com
# watch: tail -f events.jsonl · clips: open https://<tunnel>/clips/<name>.wav
```

```bash
cd ml-demo
npm install && npm run dev   # mic works on http://localhost only
vercel deploy --prod --yes   # see ../../vercel.json (builds ml-demo/)
```

Live: **https://dnhacks-node.vercel.app** (override per-phone with
`?server=https://…` when the tunnel rotates; pinned anchors append
`&lat=…&lon=…&acc=3`).
