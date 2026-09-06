# SkyMesh — Phone Mesh Architecture

**Owner:** Mark. **Scope:** Demo 1 — real phones, in real browsers, talking to *each
other*, set up and controlled from an admin console.

Two planes, and the distinction runs through the whole design:

- **Control plane** — one admin browser. Admits nodes, places them on a room map, draws
  the topology, triggers calibration, runs the failure demos. Not a sensor.
- **Data plane** — the phones. Sense, gossip, store, fuse. Never depends on the admin
  once configured.

| | State |
|---|---|
| CRNN classifier, Leaflet map, e2e tests | **Built** (`justin-draft`), client/server |
| Phone-to-phone mesh + admin console | **This document.** Not built |

`justin-draft`'s TDOA/multilateration path (and its 8.7 m simulation result) does **not**
carry over: this design ships only scalar likelihoods, never audio, so there is nothing to
cross-correlate (§10.2). The mesh below is design, not measurement.

---

## 1. The claim

> Every phone holds the whole picture, every phone computes it independently, and no
> phone's loss degrades it.

Three demos prove it: **kill a node** and the picture survives on every other phone;
**partition the mesh** and both halves keep working, then converge on reconnect; **two
phones on a direct link** run the same protocol with no server in the path at all (§4.3).

Note what the claim does *not* say. On the default relay transport the server is a real
single point of failure for message *delivery* (§4.2), and "kill the server and everything
keeps running" is not available. What is genuinely distributed is **state and
computation**: no fused picture exists anywhere but on the phones, each of which derives
it independently. Do not overclaim the first to sell the second — the second is the
stronger claim anyway, and it is true.

## 2. What one node is

One browser tab on one phone. All nodes are identical — no coordinator, no leader, no
privileged peer. Each one:

- **Listens** — mic → mel-spectrogram → on-device classifier → detection (§9)
- **Scores** — emits a likelihood record every second, whatever the value (§6)
- **Gossips** — floods records to neighbours, reconciles by version vector (§7)
- **Stores** — every record ever made by any node (§6)
- **Fuses** — computes tracks locally from its own replica (§10)
- **Serves** — renders the full picture on its own screen

Identity is a `node_id` in `localStorage`. Reload rejoins as the same node; otherwise the
map fills with ghosts mid-demo and the node count becomes a lie.

## 3. The admin console

A separate browser page. **It has no microphone, no position, and never appears in
`n_nodes`.** It exists to configure the mesh and then get out of the way.

### 3.1 What it does

| | |
|---|---|
| **Admit** | Nodes that scan the QR land in a pending queue; admin approves them in |
| **Place** | Drag each node onto a room map to set its position (§13) |
| **Wire** | Draw the adjacency graph, or auto-generate it from a radius (§5) |
| **Calibrate** | Trigger the sync chirp and show resulting per-node clock offsets (§8) |
| **Demo** | Disable nodes, cut links, partition the mesh — the demo remote control (§12) |
| **Observe** | Live map, per-node health, replication lag, tracks |

That last row makes the admin the operator view, which means it is also the screen the
room is watching. Which drives the next decision.

### 3.2 The admin should peer into the mesh, not read from the server

Two ways for the admin to know what is happening:

- **Read privileged state from the server.** Simple, and wrong: the admin would then show
  a picture no phone can see, built by a path no node uses. Every bug in replication
  becomes invisible on the one screen the room is watching.
- **Attach as a display-only peer**, holding its own replica and deriving its own view
  through the same code path as any node. What is on the big screen is then literally what
  a node sees.

Take the second. It reuses the replication code with `caps: ["display"]`, and it is not a
sensor node in any way that matters: no mic, no position, contributes nothing to geometry,
excluded from `n_nodes` and from fusion inputs. It only *reads*.

This also keeps the admin honest as a diagnostic: when nodes disagree, the admin is one
more opinion rather than an oracle, and "fused from 4 of 6" (§10) means something on it.

### 3.3 Config is a record type, with exactly one writer

Node positions and topology have to reach the phones. Rather than a separate config
channel, the admin **injects config records into the same gossip stream**:

```jsonc
{"type":"node_config","origin":"admin","seq":17,"node":"n04",
 "pos":{"x":3.2,"y":1.8},"enabled":true}
{"type":"topology","origin":"admin","seq":18,
 "edges":{"n01":["n02","n03"],"n02":["n01","n04"]}}
```

Config is semantically mutable — you can drag a node twice — which would normally break a
grow-only set. It does not here, because **the admin is the only writer**: records stay
append-only, nodes take the highest `seq` from `origin:"admin"`, and last-writer-wins with
a single writer needs no conflict resolution at all.

The payoff: config propagates by gossip like everything else, so **a node that reconnects
after the server is dead still learns the current topology** from its neighbours.

## 4. Transport: WebSockets

Every node holds **one WSS connection** to a relay. That is the whole transport.

### 4.0 Why a server is unavoidable

A browser cannot accept an incoming connection. It cannot listen on a port, cannot be a
server, and cannot be found by another browser. So browser-to-browser communication has
exactly two shapes:

| | Server's role | Cost |
|---|---|---|
| **WebRTC** | Introduces peers, then leaves the data path | ICE/STUN/TURN, and dies on venue WiFi policy — client isolation, blocked multicast, symmetric NAT |
| **WebSocket relay** | Carries every message, permanently | Delivery is structurally centralized |

**There is no third option.** WebTransport is also client-only; Service Workers cannot
accept external connections; BroadcastChannel and SharedWorker are same-device; Web
Bluetooth does not exist on iOS Safari. The complete list of browser-to-browser transports
is WebRTC. So the server cannot be removed from a browser mesh — only moved out of the
*data path*, which is exactly what this design trades away in exchange for working on any
network.

### 4.0.1 The relay is a browser artifact, not an architectural one

WebSocket is client-server only *in a browser*, because the browser exposes
`new WebSocket(url)` and no way to listen. Outside one, any process that can bind a port is
both server and client: two Raspberry Pis with mics gossip directly over plain WebSockets,
no relay and no WebRTC.

This matters for how the design is described. Nothing in the protocol — `hello` /
`digest` / `want` / `records` / `ping`, version vectors, push plus anti-entropy — assumes a
relay exists. On real hardware each node listens and connects straight to its neighbours,
running the identical protocol.

> Real nodes listen and connect directly to their neighbours: plain sockets, no relay.
> Browsers cannot listen, so the demo relays what would otherwise be a direct link. The
> protocol above the link is identical either way.

Which makes the hardware roadmap a `Link` swap (§4.1) rather than a rewrite — and makes the
relay a property of the demo's *substrate*, not a compromise in the design.

Note what dropping signaling did and did not do. Signaling existed to introduce peers so
they could talk directly. It is gone because nobody talks directly — not because the
server is.

**So: do not claim "no server," "fully decentralized," or "no single point of failure."**
Any judge who asks how two phones reach each other will catch it, and it will cost
credibility on the claims that *are* true (§4.3). The accurate sentence is: *the fused
picture exists nowhere but on the phones; the server routes messages it cannot read; and
in a real deployment those hops are radio links, not WiFi.*

### 4.1 Links are logical

A "link" is not a connection. It is an entry in the adjacency table (§5) plus a `{to:…}`
envelope on the socket that is already open:

```jsonc
{"to":"n03","m":"records","r":[{…}]}
```

The relay checks whether the sender may talk to the destination, applies simulated
latency and loss, and forwards. Consequences: **one socket per node instead of N−1**,
reconnection is a single socket, and none of ICE, STUN, TURN, signaling, offer/answer
glare, mDNS candidate obfuscation, client isolation, symmetric NAT or blocked UDP exists
in this design. Outbound WSS on 443 traverses essentially any network policy that lets the
page load at all — including phones on cellular, which a peer-to-peer transport could
never accommodate.

Keep the transport behind a one-line interface anyway, since it costs nothing and makes
the independence explicit:

```ts
interface Link { send(msg): void; onMessage(cb): void; onClose(cb): void }
```

Nothing above this line — gossip, version vectors, dedupe, fusion — knows or cares how
bytes move.

### 4.2 The relay is a network emulator, not a coordinator

It **does not fuse and holds no picture.** Every phone keeps its own replica, its own
version vector, and computes its own estimate. The relay decides only which messages reach
whom:

```
on {from: n05, to: n03, payload}:
    adjacency[n05] contains n03 ?   else drop
    link up ?                       else drop
    apply simulated latency + loss
    forward to n03
```

~40 lines. A dumb pipe with an adjacency table.

**The honesty discipline: the relay must be able to route payloads it cannot parse.**
Treat them as opaque bytes — a testable constraint, not a promise. *Stretch:* encrypt
under a session key carried by the QR, and "the server does not fuse" becomes "the server
routes ciphertext and could not fuse if it wanted to."

### 4.3 The question a judge will ask

> "So it is a client-server app with extra steps?"

One test answers it: **delete the server's memory and see what is lost.** The adjacency
table. Nothing else — no fused picture, no track history, no node state. All of that lives
on the phones, replicated, each computing independently. A conventional client-server
design would fuse centrally and broadcast the answer; this one cannot, because the server
does not parse what it carries.

State and computation are **distributed**. Delivery is **centralized**. Say both halves —
the first is the interesting claim and it survives scrutiny precisely because you conceded
the second.

What is genuinely real, not emulated: replication across phones, independent per-node
fusion, survivable node loss, CRDT partition-and-heal convergence.

What is emulated: which pairs can talk, and with what latency and loss (§5).

### 4.4 What the relay buys beyond convenience

- **You can see the traffic.** With peer-to-peer links, messages between phones are
  effectively invisible — instrumenting them means pulling logs off six devices. The relay
  observes everything, so the admin page can animate records **rippling hop by hop across
  the topology in real time**. That is the single best visualisation available to this
  project, and it exists only because delivery is centralized.
- **Repeatable failures.** Cutting a link is an admin click, rehearsable fifty times,
  rather than an awkward physical act.
- **Conditions no WiFi could show.** 500 ms latency, 20% loss, range-limited connectivity —
  what a tactical radio mesh actually looks like (§12).
- **Scales further than peer-to-peer would.** A browser mesh tops out around 8–15 peers on
  Safari; a relay handles dozens.

**Cost:** phone→server→phone is ~2× your RTT to the relay, so 50–100 ms per hop against a
public host. Since latency is being injected deliberately anyway, it disappears into the
budget — subtract measured RTT from the target.

### 4.5 The one network requirement that remains

`getUserMedia` needs a secure context, so the page must be HTTPS and the socket WSS with a
valid certificate. Deploy the relay publicly (fly.io / Railway) rather than on a laptop —
Safari does not treat plain HTTP on a private IP as secure, and self-signed certificates
mean installing a trust profile on every iPhone.

Captive portals remain the only venue policy that can still bite: devices must
authenticate before any traffic flows, and portal sessions expire. Everything else in the
old peer-to-peer risk list is gone.

## 5. Adjacency is admin-defined — and you must say so

Six phones in one room are all within range of each other. A "real" mesh among them is
**fully connected**: every node is one hop from every other, nothing is ever routed, and
killing one proves nothing.

So the admin draws the neighbour graph explicitly, and the relay refuses to forward
between nodes that are not adjacent (§4.1). Present this plainly as a deliberate stand-in for the radio
range that would constrain a real deployment — it is what makes multi-hop propagation and
partition healing *observable* on six phones in a room.

Pick a topology with **diameter ≥ 3 and at least one articulation point** you can cut on
purpose (§12).

Design rule for the pitch: in a real deployment coverage is set by node count and
resilience by node **degree**, with degree set by spacing versus radio range — so you tune
resilience independently of how much ground you cover. Connectivity in a random geometric
graph needs average degree ≳ log n (Penrose; Gupta & Kumar): ~3–4 at n=20, ~4–6 at n=50.

## 6. What crosses the wire

**One record type.** Every node emits a reading every second, always, regardless of
value:

```jsonc
{"type":"reading","origin":"n07","seq":413,"t":1725550001.5,
 "p":0.91,"logit":2.31,"snr_db":14.2}
```

`p` is the model's drone likelihood for that window. **No audio ever leaves a phone.**

### 6.1 There is no "detection event"

A node reporting `p=0.02` is a heartbeat. A node reporting `p=0.94` is a detection. They
are the same record, and collapsing them matters for two reasons:

- **Silent nodes carry information.** "n04 hears nothing" sharply constrains where the
  source can be (§10). If quiet nodes stayed quiet on the wire, that evidence would be
  thrown away.
- **Thresholds become a display concern, not a protocol concern.** Nothing on the wire
  depends on a tuned constant, so retuning the alert threshold never touches the mesh.

### 6.2 Send the logit, not just the probability

The main risk in scalar-only fusion: **a classifier probability is trained to saturate.**
A drone at 3 m and at 12 m may both produce `p = 0.99`. If every node in a room saturates,
fusion has *zero* information to localize with — detection still works, localization
silently collapses to "somewhere in here."

Two cheap defences, both worth carrying:

- **`logit = log(p/(1−p))`** — preserves dynamic range exactly where `p` has none.
- **`snr_db`** — a calibrated loudness figure, one extra float, and a far better range
  proxy than any probability because it is not trained to be confident.

Calibrate so the operating point stays *sensitive across room scale* rather than pinned
at 1.0. If the model saturates everywhere, §10 degrades to a coverage map and you should
say so rather than showing a confident dot.

**This is measured, not predicted.** The first implementation fused on `p` alone and
failed its own tests: credible-region spread barely improved from 2 nodes to 6, because
detect/don't-detect evidence is a fuzzy disk rather than a range. Worse, with well
calibrated `p` the per-node likelihood is `p·P_d + (1−p)(1−P_d) = P_d² + (1−P_d)²`, which
is *minimised* at `P_d = 0.5` — a source at the true half-detection radius is actively
penalised. Fusion now runs a Gaussian range likelihood on SNR, with a censored tail below
the noise floor so silence stays informative. Both paths are covered by
`tests/fusion.test.ts` specifically so nobody quietly drops `snr_db` from the wire.

### 6.3 Volume

~80 B per record, 1 Hz per node. At 10 nodes that is **~3 MB/hour** — so every node
holding every record any node ever made is trivially affordable, with no eviction policy,
no content-addressing, and no pull protocol. Keep it in memory plus IndexedDB.

The audio-shipping design this replaces would have been ~460 MB/hour per phone and ~4
GB/hour mesh-wide. Not sending audio is the single largest simplification in the design.

## 7. The gossip protocol

### 7.1 Why there is no consensus

Records are immutable, append-only, independently generated and order-independent —
fusion is a function of a *set* of readings in a time window, not a sequence. The shared
state is a **grow-only set: an op-based CRDT**, and merge is set union — idempotent,
commutative, associative.

**So there is no consensus problem.** No Raft, no Paxos, no leader election, no quorum, no
split-brain. Two nodes that disagree have not finished gossiping. Worth stating out loud:
"distributed" normally implies consensus and its costs, and this design avoids all of it
through a property of the data rather than a shortcut.

### 7.2 The stack

```
 application ── gossip protocol      ← five message types, below
 transport ──── one WSS per node     ← {to:…} envelopes, relay routes by adjacency
 network ────── anything outbound    ← WiFi or cellular, 443, no policy problems
```

WebSockets give ordered reliable delivery per connection — more than needed, since merge
is commutative and an out-of-order record is not a problem requiring a solution. Take it;
it is free, and it demotes anti-entropy to a repair mechanism rather than the primary one.

Note that ordering is *per socket*, not global: two records taking different paths through
the topology still arrive in any order. The CRDT is what makes that a non-issue.

### 7.3 Message types

```jsonc
{"m":"hello",  "node":"n07","boot":3,"proto":1}
{"m":"digest", "vv":{"n01:3":412,"n03:1":88,"admin:1":18}}
{"m":"records","r":[{…},{…}]}
{"m":"ping"/"pong","id":7,"t1":…,"t2":…,"t3":…}
```

That is the entire protocol. Everything else is policy on top of these four.

**Version-vector keys are `origin:boot`, not `origin`.** A reload starts a fresh
*stream* rather than reusing sequence numbers, which is what makes reload-safety
structural instead of a discipline (§7.8).

**Reconciliation is two messages, not three.** An earlier draft had `digest` → `want` →
`records`. The `want` round trip only buys the requester control over pull size, which
chunking already provides, so it was dropped during implementation: a peer that receives a
`digest` replies with `records` directly.

### 7.4 Eager push + lazy pull

Both are required; each covers the other's failure.

**Push — for latency.** On creating or first receiving a record, forward immediately to
every neighbour *except* the sender. Drop anything already held, keyed `(origin, seq)`.
Reaches the mesh in ≈ diameter × hop latency — ~150 ms across a 3-hop graph.

**Pull — for completeness.** Every ~5 s send a `digest` to each neighbour; whoever receives
one replies with whatever the sender lacks. Both sides digest on the same timer, so both
directions heal. Repairs whatever push lost, backfills late joiners, mends partitions.

A `hello` also triggers an immediate digest, so a newly adjacent or reconnecting peer
reconciles at once instead of waiting up to a full interval.

Push alone is lossy — a phone that misses a packet misses it forever. Pull alone is slow —
5 s to learn about a drone. Together: fast *and* eventually complete. This is the standard
eager-push / lazy-pull epidemic pattern.

### 7.5 Version vectors

Each node keeps `vv[origin:boot] = highest contiguous seq received`. Records above the mark
are still stored; the mark advances as gaps fill. A peer receiving a digest returns every
record whose `seq` exceeds the sender's mark for that stream.

This over-requests slightly after out-of-order delivery — you re-receive records you
already hold and drop them by key. Harmless at ~80 B/record, self-healing, and about 30
lines. Interval sets are the precise refinement if it ever matters; it will not here.

A 50-entry version vector is ~600 B, exchanged every 5 s per neighbour. Negligible.

### 7.6 Worked example

Topology `n01–n02, n01–n03, n02–n04, n03–n04, n03–n05, n04–n06, n05–n06`:

```
t+0ms    n05 scores p=0.94 → record (n05,220) → log, vv[n05]=220
t+0ms    n05 ──► n03, n06
t+50ms   n03 new → store → ──► n01, n04      (never back to n05)
         n06 new → store → ──► n04
t+100ms  n04 receives twice → first stored, second dropped as duplicate
         n01 new → store → ──► n02
t+150ms  n02 new → store → ──► n04 → dropped
         all six nodes hold the record
```

Each edge carries it at most once per direction: ≤ 2|E| = 14 transmissions. The duplicate
arrivals are not waste to optimise away — they are the redundancy that makes node loss
survivable (§12).

### 7.7 Connection setup

**Relay path (default):**

```
1. phone → WSS → server: {join, session}
2. server: queue as pending; admin sees it (§3.1)
3. admin approves → server → phone: {admitted, node_id, neighbours:[…]}
4. links are live immediately — the WSS connection already exists
5. hello → digest → backfill → ping burst (§8)
```

There is no step 4 to speak of: the relay routes by adjacency table, so a `Link` is just
a `{to: …}` envelope on the socket already open.

No peering handshake exists: once admitted, a node can address any neighbour immediately
over the socket it already holds.

### 7.8 Four things that will bite

- **Persist the sequence counter.** If a phone reloads and restarts `seq` at 1, it emits a
  *different record under a key that already exists*. Two conflicting values under one key
  breaks the CRDT outright and silently, and no amount of anti-entropy will repair it —
  this is the one bug here that causes permanent divergence rather than delay. Persist
  `seq` in `localStorage`, or key on `(node, boot, seq)` with a boot counter.
- **Backpressure.** A late joiner pulling full history can blow the SCTP send buffer.
  Check `ws.bufferedAmount` before sending; pause above ~256 KB. Keep batches under 16 KB.
- **Window boundaries.** Coarse ±50 ms sync against 500 ms windows means readings near a
  boundary can land in the wrong bin. Fuse at `window_end + 1 s` to let propagation
  settle, and re-fuse if late readings arrive.
- **Reconnect resets nothing.** A node whose socket drops keeps its whole replica in
  memory. On reconnect it sends `hello` + `digest` and pulls only the delta — so a phone
  that was away for a minute rejoins in one round trip, not a full resync.

## 8. Time — coarse is enough

Because no audio crosses the wire, there is **no cross-correlation, no TDOA, and
therefore no millisecond clock-sync requirement.** This removes what would otherwise be
the hardest problem in the system.

All that is needed is enough alignment to bin readings into common time windows:

- **Window size 500 ms**, snapped to a grid so independent nodes produce identical window
  IDs.
- **Required accuracy ±50 ms**, which ordinary NTP-style exchange over the socket clears
  easily — a burst of ~15 round-trips on connect, one every 30 s,
  `offset = ((t2−t1)+(t3−t4))/2`, keep the min-RTT sample.

For context on what was avoided: TDOA needs the true relative start times of two clips,
so clock skew lands directly in the estimate — at 343 m/s, 10 ms of skew is 3.4 m, and in
a 10 m room the entire TDOA range is only 29 ms. The README's "no clock sync needed" claim
was wrong for TDOA but is **correct for this design**, because there is no correlation to
align.

### 8.1 The chirp survives, with a different job

Play a known sound from known positions and record what each node reports. That is not
clock calibration any more — it is how you **fit the sensor model** `P(p | distance)` that
§10 depends on, and there is no substitute for measuring it. Walk a speaker to 3–4 marked
spots, play drone audio, log every node's `p` and `snr_db` against known distance.

Do this before trusting any fused position. It is also the moment you find out whether
the model saturates across room scale (§6.2), which is better learned in rehearsal than
on stage.

## 9. Detection on-device — the interface

The model is out of scope here (owned elsewhere). What the mesh requires of it is a
contract, not an architecture:

```
mic → 16 kHz mono → 64-mel, 50–5500 Hz → model → p ∈ [0,1] per 1 s window, 500 ms hop
```

Three requirements the mesh depends on:

1. **It runs on the phone.** Scoring server-side would mean the mesh shares detections it
   cannot make alone — **do not pair that with the kill-the-server beat** (§12). This is
   the one hard constraint. Today's CRNN lives in `server/model.py` in Python, so browser
   inference (ONNX Runtime Web or TF.js) is a real port, and it is the largest hidden
   dependency in this design.
2. **It emits every window, not just confident ones.** Silent readings are evidence (§6.1).
3. **It is not saturated across room scale.** Also expose `logit`, and `snr_db` if
   available — §6.2 explains why a probability alone may carry no position information at
   all, and §8.1 is how you find out.

Until browser inference lands, a band-energy ratio over 50–5500 Hz is a few hours of work
and satisfies all three, letting the mesh be built and demoed end to end while the model
is swapped in behind the same interface.

## 10. Fusion: a Bayesian occupancy grid

Every node has every reading, so every node fuses independently. Same inputs → same
output, provided fusion **sorts by record key first** so iteration order cannot leak in.

### 10.1 The algorithm

Weighted centroid is the obvious choice and the wrong one: it is biased toward wherever
nodes happen to be clustered, it cannot use silent nodes, and it produces a confident dot
with no honest uncertainty.

Instead, discretize the room into a grid (say 0.25 m cells — 12×8 m is ~1500 cells, which
is nothing) and compute a posterior over cells:

```
L(cell) = Π_i [ p_i · P_d(‖cell − x_i‖) + (1 − p_i) · (1 − P_d(‖cell − x_i‖)) ]
```

where `P_d(d)` is the calibrated probability that a node at distance `d` reports a
detection (§8.1). Roughly twenty lines of code, and it gets you a great deal:

- **Silent nodes constrain the answer automatically.** A node with `p_i ≈ 0` drives
  `(1 − P_d)` toward zero for every cell near it. Negative information falls out of the
  formula rather than needing special handling.
- **Saturation degrades gracefully.** If every node reports 1.0, the posterior spreads
  into a broad region instead of a confidently wrong point — the map tells the truth.
- **It is the demo beat.** The posterior heatmap visibly concentrates as nodes join. Same
  moment as the shrinking ellipse, and it works with scalars.
- **Honest uncertainty for free.** Report the MAP cell plus the 90% credible region area.

**Estimates are local and are not gossiped.** A fused position is a deterministic
function of evidence every node already holds, so replicating it would duplicate the
whole mesh's conclusions N times over for no information gain. **Replicate evidence,
derive conclusions.** Each node renders its own estimate from its own replica; if they
differ, that is real information about replication lag, and §10's "fused from 4 of 6"
display is exactly how to show it.

### 10.2 What to expect, honestly

This is **coarser than multilateration**, and the doc should not imply otherwise. The
8.7 m vs 51 m figure came from TDOA and no longer applies — accuracy here is set entirely
by how sharply `P_d` falls with distance. A steep falloff across room scale gives ~1–2 m
in a small room; a saturated model gives you a coverage map and nothing more.

That is a fair trade for what it buys: no audio on the wire, no clock sync, no clip
protocol, no ring buffer, and privacy by construction — **raw audio never leaves the
phone at all**, which is a stronger claim than "we only send 2 s clips."

- No fusion leader to elect, lose, or defend.
- Duplicate estimates from different fusing nodes collapse by content hash.
- Nodes disagree transiently while gossip is in flight. Show it — **"fused from 4 of 6
  nodes"** makes divergence a legible property rather than a bug.
- **Report `n_reports` and `n_silent`.** Both are evidence. A picture built from 4
  detections and 2 silences is better constrained than one from 4 detections alone, and
  saying so is what makes the negative-information argument visible.

## 11. Joining

```
QR  →  LANDING       session name, live peer count, ONE big Join button
                     (mic requires a user gesture on iOS)
    →  PERMISSIONS   mic only — no geolocation needed, the admin sets position
    →  SIGNALING     WebSocket to server, register → lands in admin's pending queue
    →  ADMITTED      admin approves, drags the phone onto the room map, assigns neighbours
    →  NEIGHBOURS    relay begins forwarding to and from assigned neighbours
    →  SYNC          coarse clock offset over each link, ±50 ms is plenty (§8)
    →  ACTIVE        wake lock, listening animation, local map from local replica
```

QR URL: `https://<host>/j/<session_id>`. The join token is advisory — if it fails to
validate, **warn, do not block**; a token check failing on stage is a demo failure and
these are trusted volunteers.

**Physical correspondence is the admin's job.** The map position only means something if
the phone is actually there. Tape numbered marks on the floor, have people stand on them,
and let the admin match node → mark. A phone that wanders off is now *confidently* mislocated,
which is worse than not knowing — so the admin screen should show placement age and let
mislocated nodes be flagged out of geometry.

Late joiners are the normal case: a judge scanning mid-demo is admitted, exchanges version
vectors, and pulls the whole session history. That backfill *is* the anti-entropy path, so
it gets exercised constantly.

## 12. The failure demos

| Beat | Action | What it proves |
|---|---|---|
| **Kill a node** | Admin disables it, or close the tab | Its records survive on every other phone; coverage drops, the picture does not |
| **Partition and heal** | Admin cuts an articulation point, halves see different drones, reconnect | The strongest: union of grow-only sets, so no conflict is *possible* and nothing needs reconciling. A centralized design cannot do this at all |
| **Degrade the links** | Admin dials latency to 500 ms and loss to 20% | What a tactical radio mesh actually looks like. Push degrades, anti-entropy still converges — and real WiFi could never have shown this |
| **Watch it ripple** | Admin animates records propagating hop by hop (§4.4) | Multi-hop gossip is real, not a diagram. The best visual available, and only possible because delivery is centralized |

Emulated links make the first three *repeatable* — an admin click, rehearsable fifty
times, rather than an awkward physical act (§4.2).

Propagation over diameter D at per-hop latency L converges in ≈ D·L — a diameter-4 graph
at ~50 ms/hop is ~200 ms — and anti-entropy bounds worst case at one round (~5 s) even if
every flood is lost.

## 13. Room coordinates

No GPS. Positions are **metres in a room frame**, set by the admin.

```jsonc
"room": {"w_m": 12.0, "h_m": 8.0, "plan": "/floorplan.png"},
"pos":  {"x": 3.2, "y": 1.8, "sigma_m": 0.3, "source": "admin", "set_at": …}
```

Origin at one corner, x/y in metres, an optional floor-plan image behind it. Everything —
the occupancy grid, distances, the sensor model — works unchanged in this frame; only the
display projection differs from lat/lon.

This is *better* than GPS for the demo, not a downgrade:

- **Only relative geometry matters.** A uniform offset in all sensor
  positions translates the solution without inflating the ellipse — and a room frame has
  no absolute error at all, by construction.
- Phone GNSS is 3–10 m outdoors and far worse indoors. A tape measure across a room is
  ~0.1 m. The room frame is one to two orders of magnitude better than anything a phone
  could self-report.
- It removes the entire GNSS tier system, permission prompt, and convergence wait from the
  join flow.

Record `sigma_m` honestly: ~0.1 m if marks were measured with a tape, ~0.5–1 m if placed by
eye against a floor plan. It feeds fusion weighting.

### 13.1 Indoor caveats

- **Reverberation flattens the sensor model.** A hard-surfaced room with RT60 ~0.5–1 s
  keeps sound energy up everywhere, so `P_d(d)` falls off far more gently indoors than
  the inverse-square intuition suggests — which is precisely the saturation failure of
  §6.2. Measure the curve in the actual room (§8.1); do not assume it.
- **Sensor placement still dominates.** The posterior is sharp only where node distances
  differ. Phones bunched along one wall see nearly the same distance to every cell and
  produce a smeared blob; phones around the perimeter produce a tight one. Spread them.
  This is also the honest explanation of the concentrating-heatmap beat — partly more
  reports, mostly better spatial diversity.
- **2D only.** All phones sit at roughly table height, so source altitude is badly
  conditioned. Report 2D and say so; do not let the ellipse imply 3D precision.

## 14. Honest limits

State these before a judge finds them.

- **Adjacency is imposed by the admin** (§5). The phones could all reach each other.
- **The relay is a single point of failure for delivery** (§4.0). State and computation
  are distributed; message transport is not. Say so.
  Degradation is graceful rather than total: with the relay down, every phone keeps its
  full replica, keeps scoring its own mic, and keeps rendering its own picture. You get N
  isolated working nodes, not N dead ones — a real property, but not "the mesh keeps
  running."
- **Radio links are emulated**, including latency, loss and which pairs can talk (§5).
- **Captive portals** remain the one venue policy that can still bite (§4.5).
- **The admin is a trusted single writer** for config. No authentication beyond the QR.
- **Byzantine nodes are out of scope.** A malicious peer can inject false detections and
  the mesh will fuse them. Outlier rejection handles bad mics, not coordinated lies. The
  answer is signed records plus reputation weighting — designed for, not built.
- **Model saturation kills localization** (§6.2). If every node reports ~1.0 across the
  room, detection still works and position does not. Measure `P_d(d)` before believing
  any fused dot.
- **Coarser than multilateration.** Scalar fusion cannot match TDOA; the 8.7 m figure
  does not carry over (§10.2).
- **iOS backgrounding kills everything** — mic, socket, timers. Hence the wake lock
  and the visible listening animation.
- **Mesh ceiling ~8–15 peers** in Safari (§4.3).
- **Positions are only as true as the phones are stationary** (§11).
- **None of the mesh is measured.** It is design.

## 15. Build order

Risk-first. Stop at any point and you still have something demonstrable.

1. **`Link` interface + `RelayedLink`** (§4.1–4.2). WSS to a relay that routes by
   adjacency. Unblocks everything and depends on no venue network.
2. **Two phones exchanging `hello` + readings** over the relay, end to end.
3. **Admin page:** pending queue, room map, drag-to-place, draw topology, link up/down
   plus latency and loss dials. Config records (§3.3).
4. **Eager push + dedupe** over the admin-defined topology (§7.4). Persist `seq` from the
   start — retrofitting it after a reload corrupts the log is a bad afternoon (§7.8).
5. **Version-vector anti-entropy** (§7.5); demo a late joiner backfilling.
6. **Sensor-model calibration** — speaker at marked distances, fit `P_d(d)` (§8.1). Do
   this before trusting any fused position; it is also how you find out whether the model
   saturates (§6.2).
7. **On-device scoring** — model emits `p` per window; 1 Hz readings onto the wire (§9).
8. **Occupancy-grid fusion on each phone**, rendering from its own replica (§10).
9. **Failure demos** (§12): node kill, partition-and-heal, degraded links.
10. *Stretch:* **ripple visualisation** on the admin page (§4.4) — records animating hop
    by hop across the topology.
11. *Stretch:* **opaque/encrypted payloads** (§4.2), so the relay provably cannot fuse.

---

# Appendix — Outdoor positioning

Superseded for this demo by the room frame (§13); retained because it is the answer to
"how would this work in a real deployment," which a judge will ask.

Position becomes a **claim with provenance and uncertainty**, not a sensor reading, and
nodes are weighted rather than rejected:

```
Tier A  σ ≤ 5 m      surveyed / location-tagged QR / pinned  → full geometry weight
Tier B  σ 5–30 m     GNSS fix                                 → geometry, weight 1/σ²
Tier C  σ 30–200 m   WiFi positioning                         → centroid + loudness only
Tier D  σ > 200 m    IP / unknown                             → detection vote only
```

### Which devices actually have GNSS

`navigator.geolocation` exists everywhere and means nothing. What is behind it:

| Device | Real GNSS chip | What you actually get |
|---|---|---|
| iPhone / Android phone | yes | 3–10 m open sky, 10–50 m urban |
| iPad **Cellular** | yes | GNSS fix |
| iPad **WiFi-only** | **no** | WiFi positioning |
| MacBook (any) | **no** | Apple WiFi positioning |
| Windows laptop (typical) | **no** | WiFi |
| Windows laptop + WWAN | sometimes | GNSS via cellular modem |
| Chromebook | **no** | WiFi |
| Desktop on ethernet | **no** | IP geolocation |

**The irony to design around:** laptops have the best microphones and the worst
positioning. Anchors must therefore *never* self-position via `navigator.geolocation`
— they use the surveyed path.

Runtime discrimination — do **not** branch on API availability:

- `coords.altitude !== null` is the cleanest GNSS signal. WiFi/IP providers return
  null altitude, heading and speed.
- `coords.accuracy` (95% radius, m) assigns the tier: `<20` GNSS, `20–100` WiFi or bad
  indoor GNSS, `>100` WiFi/cell, `>1000` IP.
- `enableHighAccuracy: true` powers the GNSS chip on a phone and does nothing on a
  laptop.
- First GNSS fix is often ~50 m and converges to ~8 m over ~30 s. Do not lock on the
  first callback; watch until `accuracy` plateaus, then freeze if `mobility: static`.

Adding GNSS to a device that lacks it: USB u-blox dongle ($15–40) read via Web Serial
(Chrome/Edge desktop only) or a helper script POSTing NMEA; Pi + GNSS HAT (~$25);
RTK ZED-F9P + NTRIP (~$200, centimetre — roadmap only).

**Location-tagged join QR** — print one QR per surveyed spot, `…?anchor=p3`, taped to that
spot. The position claim travels through *physical presence*: one scan, no permission
prompt, no UI. σ equals your survey quality, and it lies the moment the node moves.

**Acoustic self-survey** — with no GNSS *and* no human to place nodes, chirps from three
surveyed points localize every node: differences of arrival cancel each node's clock
offset, so three surveyed points replace N surveyed nodes. This needs raw audio and
millisecond timing, so it belongs to a TDOA design rather than this one — it is the answer
if the scalar-only approach is later traded back for accuracy.

---

# Appendix — What WebRTC would require

**Decision: not being built.** The WebSocket relay (§4) is the transport, including for the
demo's peer-to-peer story. This appendix exists so the option is *costed* rather than
guessed at — and because "why not real peer-to-peer?" is a question worth answering with
numbers instead of a shrug.

The short answer: on a network you control WebRTC is straightforward; it is only hard on
networks you do not. Since the relay removes the network as a variable entirely, and since
everything above the link layer is identical either way (§4.0.1), the direct path buys a
transport-level claim at the cost of a day's work and a venue-dependent failure mode.

## Five requirements

| | Requirement | Why |
|---|---|---|
| 1 | **Client isolation off** | The AP must forward frames between associated clients, or there is no direct path at all |
| 2 | **Multicast / mDNS permitted** | Browsers publish `.local` hostnames rather than real IPs; peers must resolve them |
| 3 | **All devices on one subnet** | Host candidates are then directly routable. One phone on cellular breaks this |
| 4 | **UDP allowed** | WebRTC is SCTP over DTLS over UDP |
| 5 | **HTTPS, valid certificate** | `getUserMedia` requires a secure context |

## Why that is cheaper than it sounds

**With 1–4 satisfied, STUN and TURN are unnecessary.** Host candidates on a shared subnet
connect directly: no TURN server to run or pay for, no NAT traversal, no relay-fallback
logic. Every genuinely painful part of WebRTC exists to cross networks you do not control.

What remains: signaling (offer/answer/ICE over the WebSocket already in place), a glare
tie-break by `node_id`, reconnection. Roughly a day.

## Kit

A **travel router** (GL.iNet, ~$25–40) rather than a phone hotspot — you can see and set
the client-isolation flag, and hotspots vary in whether they permit client-to-client
traffic at all. Test before depending on it.

5 GHz to avoid venue 2.4 GHz congestion. Every phone on it, none on cellular. WAN uplink
by cellular tether, venue ethernet, or venue WiFi in repeater mode.

## The annoying part: certificates

Requirement 5 is what forces the uplink — Safari does not treat plain HTTP on a private IP
as a secure context.

- **Public host + local DataChannels** — serve page and signaling from Vercel/fly.io; the
  AP needs internet, everything else just works. Take this one.
- **Self-signed** — a trust profile installed on every iPhone. ~2 min each, fiddly.
- **Real cert for a domain resolving to a private IP** — Let's Encrypt via DNS-01 pointed
  at `192.168.x.x`. Works offline, but needs DNS prepared in advance and local resolution.

## Verify, do not assume

Read `RTCPeerConnection.getStats()` for the nominated candidate pair:

```
host    direct on the local subnet     ← what you want
srflx   direct, traversed NAT          ← fine
relay   TURN — you are centralized     ← disclose or fix
```

Check also whether candidate addresses arrive as `.local` hostnames, which reveals whether
requirement 2 actually holds.

**Request mic permission before creating the `RTCPeerConnection`.** Browsers relax mDNS
obfuscation and expose real local IPs once the page holds media permissions, so ordering
directly determines whether host candidates appear.

## If it were ever revisited

The minimum viable version is a **two-phone side proof on an owned router** — same
protocol, `host` candidates, no server in the data path — with the relay still carrying the
full demo. An iPhone hotspot is sufficient for two devices (it caps near 5 clients, and
supplies its own cellular uplink so the certificate requirement resolves itself); the only
unknown is whether it isolates clients, which a laptop running `python3 -m http.server`
and a phone loading it answers in two minutes.

Not planned. Recorded so the decision is a decision, not an omission.
