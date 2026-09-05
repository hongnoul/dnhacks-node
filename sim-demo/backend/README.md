# sim-demo/backend — distributed node sim (Mark owns the comms model)

Greenfield. Design authority: **Mark** — propagation, adjacency, failure handling.

Planned contents:

- `sim.py` — world simulation: node positions, drone flight paths,
  acoustic detection ranges, node-to-node message passing (adjacent only).
- `requirements.txt` — backend deps.

Contract with the frontend: serve the live picture (node health, contact
reports propagating, fused drone tracks) for the map dashboard in
`../frontend/`. The per-node detection model is the Demo 1 pipeline in
`../../ml-demo/` (see `ml-demo/server/model.py`, `tdoa.py`, fusion in
`ml-demo/server/app.py`).
