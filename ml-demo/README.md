# ml-demo — on-device drone detection (Demo 1)

Phone mics detect drone audio **entirely on-device**: mic → TypeScript
mel-spectrogram → CRNN via ONNX Runtime Web → drone confidence on-screen.
Demo 1 strictly showcases one thing: **confidence in the existence of a
drone.** No server, no location, no network after first load. Localization
and the operator map belong to Demo 2 (`../sim-demo/`); see the repo root
`README.md` for the two-demo story.

## Why fully on-device

The product story is a flat mesh of identical, self-contained sensor nodes
with no privileged box to destroy. A phones→server architecture would
contradict that. Here the phone IS the node: it runs the exact Detect
pipeline each simulated Demo 2 node "runs". Airplane-mode detection is the
proof — kill the network and the node keeps working.

## The node (`app/` — Next.js PWA, iPhone-first, zero-install)

- Plain Safari tab (not Add-to-Home-Screen — standalone-mode mic is flaky).
- Mic with `echoCancellation/noiseSuppression/autoGainControl: false`,
  Screen Wake Lock, visible listening animation.
- Pipeline: `getUserMedia → ring buffer → mel.ts (16 kHz, 64-mel,
  n_fft=512, hop=160, 50–5500 Hz, (dB+40)/40) → drone_crnn.onnx via
  onnxruntime-web (wasm) → sigmoid → confidence`, scored every 500 ms
  on 1 s windows — the same window/hop contract as the Python reference.
- UI (dead simple, white): big confidence percentage, clear / red
  DRONE DETECTED pill ≥ 0.5, infinite scrolling canvas graph of the last
  60 s with a dashed 50% threshold line — segments above turn red with
  light-red fill plus top-edge crossing ticks. Detection counter appears
  after the first detection. Vibration on detection.
- Only permission requested: **microphone**. Audio never leaves the phone.
- Offline: page + 6 MB model cache after first load; works in airplane mode.

## Model provenance + export

- Checkpoint: [AntoineNaccache/drone-audio-detector](https://huggingface.co/AntoineNaccache/drone-audio-detector)
  (`aug_mixed`). `server/model.py` remaps the multi-task checkpoint onto a
  classifier-only module (encoder + GRU + head; separator branch dropped).
- `server/export_onnx.py` exports it to `public/drone_crnn.onnx` (6 MB,
  opset 17, GRU as native ONNX op). ONNX↔PyTorch logit parity: 7e-11.
- `copy-ort-wasm.mjs` (postinstall/prebuild) vendors the ORT wasm runtime
  into `public/ort/` so everything serves same-origin (offline requirement).

## Test suite

| Test | What it proves |
|---|---|
| `test-parity.mjs` (`npm run test:parity`) | browser pipeline (mel.ts + ONNX in wasm) matches PyTorch `model.py` on real DADS clips — 15/15, worst diff 5e-8; drones 1.000, negatives ≤0.002 |
| `server/e2e-browser.mjs` | real Chromium + fake mic tone: model loads, confidence hits 1.00 on-device, **asserts zero geolocation calls** |
| `server/sim_fusion.py`, `server/test_tdoa.py` | roadmap prototypes (fusion/TDOA — Demo 2 material), kept runnable |

`server/` is a dev/test harness only — the PyTorch reference for parity,
the ONNX exporter, and prototypes. Nothing in the demo path talks to it.
`drone_tone.wav` (fake-mic fixture) regenerates on first e2e run.
`testdata/` (DADS clips) and `models/` (checkpoint) are gitignored runtime
data; refetch via HF dataset `geronimobasso/drone-audio-detection-samples`
and `hf_hub_download(AntoineNaccache/drone-audio-detector)`.

## Quickstart

**One command:** `./demo.sh` starts local dev; `./demo.sh --qr` prints the
prod QR for judges; `./demo.sh --test` runs parity + browser e2e.

```bash
npm install     # vendors ORT wasm into public/ort/
npm run dev     # mic works on http://localhost — open :3000, allow mic
```

```bash
# regenerate the ONNX model (only after retraining/changing the checkpoint)
cd server && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python export_onnx.py

# verify browser/Python parity
cd .. && npm run test:parity

# full browser e2e (needs `npm run dev` running)
node server/e2e-browser.mjs
```

Deploy: `vercel deploy --prod --yes` → **https://dnhacks-node.vercel.app**.
Judges scan a QR, tap once, allow mic — that's the whole setup.

## Verifying with a MacBook speaker (`/tone`)

No drone handy: open `/tone` on a MacBook, hit **Play drone audio**
(`public/drone-demo.wav` — real DADS `l1` clips looped to 10 s, 48 kHz
mono), volume to max, hold the iPhone 10–30 cm from the speaker. The node
confidence slams to ~100% within a second, the graph line crosses above
the dashed 50% threshold, and the red DRONE DETECTED pill appears. The
sine-stack button leaves the graph flat near 0 — the CRNN scores pure
tones ~0.001. Drone audio: DADS (MIT;
aggregates CC-BY sources, see the dataset card).
