# Running the mesh

    cd sim-demo
    npm install          # also vendors the detector + ONNX model from ml-demo
    python3 -m venv server/.venv && ./server/.venv/bin/pip install -r server/requirements.txt

Two processes:

    npm run relay     # FastAPI relay, :8001
    npm run dev       # Next.js, :3000

Then:

- **`/admin`** — operator console. Admit nodes, place them, draw the topology, cut links.
- **`/`** — a sensor node. One tap to join; needs mic permission.

Multi-tab testing: `?node=n03` pins identity per tab. `localStorage` is shared across tabs
of one origin, so without it every tab claims the same node id and the result looks exactly
like a replication bug. `?session=<id>` isolates a run.

## Demo script

1. `/admin`, then open `/?node=n01` … `/?node=n06` and admit each.
2. **two clusters + bridge**, then **auto-place**. The bridge is the cut edge.
3. Play drone audio near a phone (`public/drone-demo.wav` works) — the on-device CRNN
   fires and the posterior concentrates.
4. **Kill a node**: close a tab. Its records survive on every other phone.
5. **Partition**: cut `n03–n04`. Both halves keep working on their own picture.
6. **Heal**: restore it. Union of grow-only sets — nothing to reconcile.
7. **Degrade all (500 ms, 20%)**: push suffers, anti-entropy still converges.

What to say honestly: state and computation are distributed — no fused picture exists
anywhere but on the phones. Delivery is not; the relay carries every message, and in a real
deployment those hops are radio links (ARCHITECTURE.md §4.0).

## Tests

    npm test                        # 24 unit + integration
    node tests/ui-smoke.mjs         # browser smoke; relay + dev must be running
    node tests/detector-smoke.mjs   # CRNN fires on synthesised drone audio

## Detection

Detection is ml-demo's, not a re-implementation: `npm install` vendors `mel.ts`,
`detector.ts`, `audio.ts` and `drone_crnn.onnx` from `../ml-demo` via
`vendor-detector.mjs`, so the CRNN and its bit-parity mel front end stay a single
source of truth. Re-run `npm run vendor` after ml-demo changes.

`scoring.ts` adds one thing on top: a **level channel**. The detector peak-normalises
every window before the mel front end, so its probability carries no distance
information — measured at p = 1.00 from across a room. Fusion localises by comparing
levels between nodes, so range comes from `bandLoudness` (RMS in the drone band, taken
before that normalisation) against a tracked noise floor. The CRNN answers "is it a
drone"; the level answers "how close".
