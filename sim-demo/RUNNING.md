# Running the mesh

    npm install
    (cd server && python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt)

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
3. Play drone audio near a phone — its likelihood rises and the posterior concentrates.
4. **Kill a node**: close a tab. Its records survive on every other phone.
5. **Partition**: cut `n03–n04`. Both halves keep working on their own picture.
6. **Heal**: restore it. Union of grow-only sets — nothing to reconcile.
7. **Degrade all (500 ms, 20%)**: push suffers, anti-entropy still converges.

What to say honestly: state and computation are distributed — no fused picture exists
anywhere but on the phones. Delivery is not; the relay carries every message, and in a real
deployment those hops are radio links (ARCHITECTURE.md §4.0).

## Tests

    npm test                    # 24 unit + integration
    node tests/ui-smoke.mjs     # browser smoke; relay + dev must be running
