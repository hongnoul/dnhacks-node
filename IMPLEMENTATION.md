# SkyMesh — Implementation Plan

Companion to `ARCHITECTURE.md`. Section refs (§n) point there.

**Owner:** Mark (mesh + relay + admin). Handoff points to ML and frontend are marked ⇄.

Time estimates are rough and assume one person. Total ≈ 20 h, which is tight — the cut
list (§8) is not optional reading.

---

## 1. Stack

Reuse what `justin-draft` already has rather than introducing anything.

| | Choice | Why |
|---|---|---|
| Relay | **FastAPI + `websockets`** (`server/`) | Already in the repo, already has WS |
| Node client | **Next.js + TypeScript** (`app/`) | Already in the repo |
| Admin | Another Next.js page | Same app, same protocol code |
| Store | In-memory + IndexedDB | Volumes are trivial (§6.3) |
| Fake nodes | Python, extend `server/fake_node.py` | Already exists |

## 2. Layout

```
server/
  relay.py          # WS endpoint: admission, ctrl channel, adjacency routing, latency/loss
  session.py        # session state: nodes, pending queue, topology, link states
  fake_node.py      # headless synthetic node (extend existing)
app/
  lib/
    protocol.ts     # message types, encode/decode          ← §7.3
    link.ts         # Link interface + RelayedLink           ← §4.1
    log.ts          # record store, version vector, seq      ← §7.5
    gossip.ts       # eager push, dedupe, anti-entropy       ← §7.4
    clock.ts        # coarse NTP offset                      ← §8
    fusion.ts       # occupancy grid                         ← §10
    scoring.ts      # mic → p  ⇄ ML                          ← §9
  join/page.tsx     # QR landing → permissions → active      ← §11
  node/page.tsx     # listening view, own replica, own estimate
  admin/page.tsx    # control plane                          ← §3
```

## 3. Two channels on one socket

The relay must route payloads it cannot parse (§4.2), but it also needs a topology to
route *against*. Resolve by splitting the socket, not by letting the relay read gossip:

```jsonc
{"ctrl":"set_topology","edges":{…}}      // relay parses this — its own control plane
{"to":"n03","payload":"<opaque>"}        // relay routes this, never opens it
```

- **Topology and link state** are relay control state. Admin → relay only.
- **Positions and node config** are gossip records (§3.3). Admin → mesh, relay just forwards.

Same admin, two channels. Keeps payload opacity a real invariant rather than a promise —
and makes it testable: the relay's tests should pass with random bytes as payload.

## 4. Core data structures

```ts
type Record = {                      // immutable, append-only
  type: 'reading' | 'node_config'
  origin: string                     // node id
  seq: number                        // per-origin, monotonic, PERSISTED (§7.8)
  boot: number                       // increments per page load — see below
  t: number                          // mesh time, ms
  [k: string]: unknown
}

type Key = string                    // `${origin}:${boot}:${seq}`
type VersionVector = Record<string, number>   // origin → highest contiguous seq

class Log {
  records: Map<Key, Record>
  vv: VersionVector
  add(r): boolean                    // false if already held — this IS the dedupe
  missing(theirVV): Key[]
  since(vv): Record[]
}
```

**The `boot` field is load-bearing.** A phone that reloads and restarts `seq` at 1 would
write a *different record under an existing key*, which breaks the CRDT permanently and
silently. Persisting `seq` in `localStorage` works; adding `boot` is belt-and-braces and
costs one integer. Do both. This is the single worst bug available in this design.

## 5. Phases

**Status:** all phases complete. 24 tests passing (`npm test`) plus a browser smoke
test (`node tests/ui-smoke.mjs`, needs the relay and `next dev` running).

    npm run relay     # FastAPI relay on :8001
    npm run dev       # node at /, operator console at /admin
    npm test          # 24 unit + integration tests

Each phase ends in something demonstrable. Stop anywhere and you still have a demo.

### Phase 0 — Relay + Link ✅ done

- `relay.py`: session, join → pending, admit, `ctrl` channel, adjacency routing
- `protocol.ts`, `link.ts`: message types + `RelayedLink`
- Hardcode a topology to start; admin comes later

**Done when:** two browser tabs exchange `hello` through the relay, and a message to a
non-adjacent node is dropped.

### Phase 1 — Replicated log + push ✅ done

- `log.ts` with persisted `seq` + `boot` (§4)
- `gossip.ts`: on new record, forward to all neighbours except sender; drop duplicates

**Done when:** tab A creates a record and tab C receives it *via* tab B. Duplicate arrivals
at a node with two paths are dropped. Verify with a diameter-3 topology, not a triangle.

### Phase 2 — Anti-entropy ✅ done

- `digest` / `want` exchange every 5 s per neighbour
- Reconnect path: `hello` → `digest` → pull delta

**Done when:** disconnect a tab for 30 s, reconnect, it backfills everything it missed. A
tab opened fresh mid-session pulls the whole history.

This phase *is* the partition-and-heal demo (§12). Do not skip it.

### Phase 3 — Admin console ✅ done

- Pending queue + admit
- Room map (plain SVG over an optional floor-plan image), drag to place → emits
  `node_config` records
- Topology editor → `ctrl:set_topology`
- Link up/down toggles; latency and loss dials

**Done when:** a 6-node topology can be configured from scratch, and cutting an
articulation point visibly splits the mesh.

### Phase 4 — Readings + clock ✅ done

- `clock.ts`: ping/pong offset, min-RTT sample, ±50 ms is plenty (§8)
- `scoring.ts`: mic → `p`. **Start with band-energy over 50–5500 Hz** ⇄ ML swaps in behind
  the same signature
- Emit a reading every second regardless of value (§6.1); include `logit` and `snr_db` (§6.2)

**Done when:** a real mic drives `p`, and readings propagate across the mesh at 1 Hz.

### Phase 5 — Fusion ✅ done

- `fusion.ts`: occupancy grid over the room, 0.25 m cells
- `P_d(d)` from a config curve initially; calibrate in Phase 6
- Render posterior heatmap; show MAP cell + credible region
- Display `n_reports` / `n_silent` and "fused from N of M"

**Done when:** each tab renders its *own* estimate from its *own* replica, and they agree
once gossip settles.

### Phase 6 — Demo ✅ done

- Sensor-model calibration: speaker at marked distances, fit `P_d(d)` (§8.1)
- Failure-demo controls wired to the three beats (§12)
- Ripple visualisation: relay logs every forward, admin animates hop by hop (§4.4)

**Done when:** all three beats run end to end, twice in a row, without a restart.

## 6. Testing a distributed system without six phones

Non-negotiable — you cannot hand-test this.

**Multi-tab on one laptop.** Watch out: `localStorage` is shared across tabs of the same
origin, so every tab would claim the same `node_id`. Override per tab via `?node=n03` and
keep identity in **`sessionStorage`**, which is per-tab. Getting this wrong looks exactly
like a replication bug and will cost you an hour.

**Headless fake nodes.** Extend `server/fake_node.py` to speak the gossip protocol and emit
scripted readings. Lets you run a 20-node mesh on a laptop and is the only practical way to
test topology and partition behaviour.

**Deterministic replay.** Feed a fixed reading sequence, assert the fused output. Fusion
sorts by record key first (§10), so this is stable and catches accidental
iteration-order dependence.

**Tests worth writing, in priority order:**

1. Reload a node → assert no key reuse (`boot`/`seq`). *The bug that corrupts everything.*
2. Relay routes with random bytes as payload → payload opacity is real (§3).
3. Partition, diverge, reconnect → both sides converge to the union.
4. Duplicate delivery via two paths → single record stored.
5. Late joiner → full backfill.

## 7. Handoffs ⇄

| To | Contract |
|---|---|
| **ML** | ✅ **landed.** ml-demo's CRNN runs in-browser via ONNX Runtime Web; vendored by `sim-demo/vendor-detector.mjs`. The band-energy stub is gone |
| **Frontend** | Room map + heatmap render from `fusion.ts` output. Admin page owns topology and link controls |

Both can proceed against the stub. Neither blocks the mesh.

## 8. Cut list

If behind, drop in this order:

1. **Ripple visualisation** — best visual, but purely additive
2. **Latency/loss dials** — keep link up/down, drop the sliders
3. **Occupancy grid → loudness-weighted centroid** — worse, but ~10 lines. Loses negative
   information and honest uncertainty; say so if you fall back to it
4. **Calibration** — ship a hand-tuned `P_d(d)` and state that it is hand-tuned
5. **IndexedDB** — in-memory only, accept that reload loses history

**Never cut:** persisted `seq`/`boot` (§4), anti-entropy (§Phase 2 — it *is* the partition
demo), or emitting readings at 1 Hz regardless of value (§6.1 — silent nodes are evidence).

## 9. Order of risk

What to prove earliest, because being wrong here is expensive:

1. **Phase 0–1.** If gossip over the relay does not work, nothing else matters.
2. **Model saturation** (§6.2). Measure `P_d(d)` in the actual room *before* Phase 5 is
   finished. If `p` pins at 1.0 across the room, fusion has no information and you need
   `snr_db` — better to learn that on day one than during rehearsal.
3. **In-browser scoring.** If the ML port slips, the band-energy stub must be good enough
   to demo. Confirm that early rather than assuming.

---

## 10. What implementation changed

Five things the plan got wrong, found by building it. All are reflected in
`ARCHITECTURE.md`.

1. **`p` alone cannot localise — `snr_db` is load-bearing.** The first fusion pass used
   only the detection likelihood and failed its own tests: spread barely moved from 2
   nodes to 6. Binary detect/don't-detect evidence is a fuzzy disk, not a range, and when
   `p` is well calibrated the per-node likelihood `P_d²+(1−P_d)²` is *minimised* at 0.5 —
   so a source at the true half-detection radius is actively penalised. Fusion now uses a
   Gaussian range likelihood on SNR with a censored tail below the noise floor, and both
   paths are tested so nobody drops `snr_db` from the wire. This is §6.2, measured.

2. **Reconciliation is two messages, not three.** `want` was dropped: it only gave the
   requester control over pull size, which chunking already provides.

3. **Version vectors key on `origin:boot`, not `origin`.** Better than persisting `seq` —
   a reload starts a fresh *stream*, so reload-safety is structural rather than a
   discipline. Tested directly.

4. **The admin observer needs a passive mode.** Attaching it to every node for visibility
   would otherwise let it relay records across a cut and silently repair the partition it
   is meant to demonstrate. It publishes and observes but never forwards or answers a
   digest. It is also excluded from being the clock root, or it would anchor mesh time
   purely because "admin" sorts before "n01" — and the mesh would re-root whenever the
   operator closed the tab.

5. **Silence is not a track.** With every node quiet the posterior is well defined — it
   points away from all of them — but rendering that as a fix claims a detection nobody
   made. The UI reports "nothing heard" instead.

### Test infrastructure notes

- `node --test` runs files **concurrently**, so a fixed relay port made two suites fight
  over one relay and one file's `after()` killed the other's. The harness now binds an
  ephemeral port per file.
- The anti-entropy interval is a constructor argument: 5 s shipping, 400 ms in tests, so
  convergence assertions measure the protocol rather than the timer.

---

## 11. Detector integration

The stub is retired: `sim-demo` now runs ml-demo's CRNN unchanged, vendored at
`npm install` (`vendor-detector.mjs` copies `mel.ts`, `detector.ts`, `audio.ts`,
`drone_crnn.onnx` and the ORT wasm). Copying rather than re-implementing keeps one
source of truth; copying rather than cross-importing keeps sim-demo a standalone
Next app. Re-run `npm run vendor` after ml-demo changes.

**Their normalisation makes the level channel mandatory.** `detector.ts` peak-normalises
every 1 s window before the mel front end (`NORM_PEAK / peak`, mirroring `model.py`) so
room playback 20–30 dB below file level still lands in the CRNN's training range. That is
right for detection — and it means the returned probability carries *no level information
by construction*.

Measured end to end with Chromium synthesising the mic from `drone-demo.wav`
(`tests/detector-smoke.mjs`): **p = 1.00, snr = 53.6 dB.** Fully saturated, which is
exactly the §6.2 failure mode — with p alone, fusion would have had nothing to localise
with. `scoring.ts` therefore reports `bandLoudness` in dB against a tracked noise floor,
taken from the raw frame *before* normalisation. The CRNN answers "is it a drone"; the
level answers "how close".

One behavioural change that followed: a node whose detector fails to start now publishes
**nothing at all**, rather than a stream of `p = 0`. Fusion treats a low reading as
positive evidence of quiet (§6.1), so a broken node must be absent rather than
confidently reporting silence it never measured.
