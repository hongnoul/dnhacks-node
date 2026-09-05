# SkyMesh — Crowd-Sourced Drone Detection Net

> Every phone and laptop in a crowd becomes a drone-detection sensor. Open a URL, and your mic + GPS join a mesh that detects, identifies, and triangulates nearby drones on a live map.

**DNHacks 2026 — Defense track (Second Front Systems).** Counter-UAS, drone detection, edge compute, distributed sensing, command and control.

Dedicated counter-UAS radar costs $100k+ per site and doesn't scale to every school, base gate, or public event. SkyMesh's marginal sensor cost is **$0** — the sensors are already in everyone's pocket. Coverage scales with the number of people present. Accuracy improves with every node that joins.

## The 3-minute demo

1. Judge scans a **QR code** → their phone joins as a node, appears on the live map. No install.
2. Drone spins up → phones light up with detections → fused track appears with an error ellipse.
3. A 5th and 6th node join → ellipse visibly tightens: *"4 nodes, ±25 m. 6 nodes, ±9 m."*
4. Operator page shows track history, alert log, and RemoteID identity when captured — including the punchline: *"This one is under 250 g and broadcasts nothing — we hear it anyway."*
5. Close: attritable, massively distributed sensing with zero marginal hardware cost. Roadmap: hardened fixed nodes for base perimeters, integration into existing C2.

Fallbacks: flying banned → phone speaker playing recorded drone audio at a known position (stated honestly, sensing math is identical). Venue too loud → pre-recorded live-run video + replay dataset animating the real map UI.

## How it works

**Topology: distributed sensing, centralized fusion.** Edge detection on-device, centralized fusion server. No P2P mesh, no consensus — all nodes are trusted volunteers contributing *measurements*, not conflicting state, so there is nothing to vote on. GCC-PHAT fusion needs all clips in one place anyway. Bad-mic outliers are handled statistically at fusion time. This mirrors real C2 doctrine: distributed sensing, centralized fusion.

```mermaid
flowchart LR
    subgraph Nodes["Sensor nodes (PWA, zero-install)"]
        P1["Phone mic + GPS\non-device CNN"]
        P2["Phone mic + GPS\non-device CNN"]
        L1["Laptop + USB mic\nanchor node"]
        R1["RemoteID sidecar\nAndroid / BT dongle"]
    end
    subgraph Server["Fusion server (FastAPI + WebSocket)"]
        ING["Ingest → JSONL event log"]
        CENT["Loudness-weighted centroid\n+ covariance ellipse (always)"]
        TDOA["GCC-PHAT + multilateration\n(≥4 concurrent clips)"]
    end
    subgraph UI["Consumers of the event stream"]
        MAP["Live Leaflet map"]
        OPS["Operator C2 page"]
        REP["/replay endpoint"]
    end
    P1 -->|heartbeat 1Hz, detection + 2s clip| ING
    P2 -->|heartbeat 1Hz, detection + 2s clip| ING
    L1 -->|heartbeat, detection + clip| ING
    R1 -->|drone ID + broadcast GPS| ING
    ING --> CENT --> UI
    ING --> TDOA --> UI
```

**Event-stream schema first.** Everything is a producer/consumer of three JSONL event types:

```jsonc
// heartbeat (1 Hz when no detection)
{"type":"heartbeat","node_id":"abc123","t":1725550000.0,"lat":38.9,"lon":-77.04,"loudness":0.12}
// detection (threshold > 0.7)
{"type":"detection","node_id":"abc123","t":1725550001.5,"conf":0.91,"clip_ref":"/clips/abc123_1725550001.wav","lat":38.9,"lon":-77.04,"loudness":0.83}
// fused track (server output)
{"type":"track","t":1725550002.0,"lat":38.9001,"lon":-77.0401,"err_m":9.2,"n_nodes":6}
```

Log view, replay, and any later UI are interchangeable frontends over this stream. Early in the build the primary interface is the terminal (`tail -f` on the event stream); the Leaflet map + operator page are late-stage consumers built only after fusion works end-to-end.

## Repo layout

This repo is the **sensor node PWA**. The fusion server lives alongside it (same repo under `server/`, or a sibling repo — decided at kickoff).

```
dnhacks-node/          # this repo: sensor node PWA (Next.js, deploy to Vercel)
  app/
    page.tsx           # join screen: one tap → listening
    listen/            # mic loop, classifier, heartbeat/detection sender
    lib/
      audio.ts         # getUserMedia → WebAudio → mel-spectrogram
      model.ts         # TF.js classifier (YAMNet embeddings + head, or compact CNN)
      geo.ts           # geolocation + loudness
  public/
    manifest.webmanifest
server/                # fusion server (FastAPI + WebSocket) — see server/README
  app.py               # ingest, centroid + ellipse, GCC-PHAT multilateration, /replay
  events.jsonl         # append-only event log
```

## Node details (iPhone-first, zero-install)

- Runs as a **plain Safari tab** (not Add-to-Home-Screen — standalone-mode mic is flaky on iOS).
- Request mic with `echoCancellation: false, noiseSuppression: false, autoGainControl: false` — iOS voice processing mangles drone audio.
- Acquire **Screen Wake Lock** (iOS 16.4+) and show a visible "listening" animation so nodes stay foregrounded — screen lock/backgrounding kills the mic.
- Pipeline: `getUserMedia → WebAudio → mel-spectrogram → tiny in-browser classifier (TF.js)`.
- On detection with confidence > 0.7: send 2 s WAV chunk + coarse timestamp + GPS + loudness to server. Otherwise send 1 Hz heartbeat (loudness + position).
- Privacy: inference is on-device; raw audio leaves the phone only as 2 s detection clips, opt-in. No continuous streaming.

## Fusion server details

- **Stack:** FastAPI + WebSocket, single box. Ingest all events → append to JSONL log.
- **CRNN judge (built):** every uploaded clip is scored by the pretrained CRNN ([AntoineNaccache/drone-audio-detector](https://huggingface.co/AntoineNaccache/drone-audio-detector), aug_mixed) → `server_conf`. Validated: DADS drone clips score 1.000, negatives ≤0.002. Note: checkpoint keys need remapping (`encoder.*`/`classifier.fc.*`) — `server/model.py` does this with `strict=True`.
- **Always on (built):** loudness×confidence weighted centroid; `err_m` = standard error (spread/√n), so the circle visibly tightens as nodes join (sim: 150→71→55→51 m).
- **Live C2 map (built):** `/map` — nodes, fused track, error circle, contribution lines, alert feed with CRNN verdicts + clip playback. Polls `/state` at 1 Hz.
- **`/replay` (built):** `POST /replay/save?session=X` snapshots the log; `POST /replay/start?session=X&speed=2` re-emits with rebased timing so the map reanimates. Demo insurance.
- **Stretch:** when ≥4 concurrent clips, GCC-PHAT cross-correlation for pairwise delays → least-squares multilateration. Coarse 500 ms trigger alignment only — precise delay comes from correlation, so no clock-sync rabbit hole.
- **RemoteID sidecar (bonus node type):** one Android phone running the open-source OpenDroneID app, or a laptop + BT dongle, feeds drone ID + broadcast GPS into the same track. Never the critical path.

### Test suite (all runnable without hardware)

| Test | What it proves |
|---|---|
| `server/fake_node.py [url]` | transport: heartbeat + clip round-trip byte-identical |
| `server/sim_fusion.py` | CRNN separation on real DADS audio, fusion accuracy vs known truth, ellipse tightening, noise rejection |
| `server/e2e-browser.mjs` | deployed Vercel page in real Chromium: mic → gate → 2s clips reach server intact |
| `server/e2e-map.mjs` | map renders nodes/track/alerts with zero JS errors |
| `server/e2e-map-tunnel.mjs` | same through the public tunnel (judge's-eye view) |

## Quickstart

**One command:** `./demo.sh` starts the server + public tunnel and prints all URLs (add `--replay demo1` to animate the recorded session). Manual steps below.

### Fusion server (run first)

```bash
cd server
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app:app --host 0.0.0.0 --port 8000
# expose publicly (phones need HTTPS):
cloudflared tunnel --url http://localhost:8000   # prints https://<random>.trycloudflare.com
# verify the whole pipe with zero phones:
.venv/bin/python fake_node.py https://<tunnel>.trycloudflare.com
# watch events: tail -f server/events.jsonl · listen to clips: open https://<tunnel>/clips/<name>.wav
```

### Node PWA

```bash
npm install
npm run dev   # local dev; mic works on http://localhost only
# prod deploy with the server URL baked in:
vercel deploy --prod --yes --team <team> \
  --build-env NEXT_PUBLIC_SERVER_URL=https://<tunnel>.trycloudflare.com
```

Live now: **https://dnhacks-node.vercel.app** (points at the current tunnel; redeploy with a new `--build-env` when the tunnel URL changes, or override per-phone with `?server=https://...`).

Open the URL on a phone, tap **Join the mesh**, allow mic + location. The page shows a live drone-band meter; when the loudness gate trips it uploads a 2 s WAV, check `server/clips/`.

### Anchor nodes (recommended)

2× laptops with cheap USB mics (~$20 ea) beat phone AGC and carry detection while phones contribute geometry. Bring battery packs and charge everything beforehand.

## Training data

Prepared in advance (data prep, no code): HuggingFace `geronimobasso/drone-audio-detection-samples` (DADS, largest public drone-audio set) + ESC-50 negatives. Pretrained compact CNN / YAMNet-head is data prep but verified against the event AI policy at kickoff; fallback is training from DADS on Colab at the event (~20 min).

## Operator (C2) view

One-page operator view: track history, per-node health, alert log, RemoteID identity when captured. This is what makes it command and control, not a demo toy.

## Roadmap

- Hardened fixed nodes for base perimeters and critical infrastructure.
- Same fusion bus accepts new modalities: camera bearing nodes, RF sniffers.
- Any node promotable to fusion server (stateless over the event stream) — Byzantine-tolerant sensing is the adversary-resistance roadmap, not a weekend build.

## Built at DNHacks 2026

Defense track presented by Second Front Systems. Team roles: ML/audio (browser classifier, threshold tuning, GCC-PHAT), frontend (PWA node UX, Leaflet map, ellipse-shrink moment), backend (ingest, fusion, operator page), float/lead (drone ops, RemoteID sidecar, story, video, submission).
