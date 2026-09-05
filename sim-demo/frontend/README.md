# sim-demo/frontend — map dashboard (Avery owns the stack)

Greenfield. Design authority: **Avery** — framework and rendering stack.

Planned contents: a map dashboard showing nodes on real-world terrain,
drone tracks, and alert propagation, fed by the world simulation in
`../backend/`.

Reference implementation (Leaflet live map with nodes, error
ellipse, health table, alert feed): `./map.html` (moved here from
Demo 1 — currently fetches a `/state` JSON endpoint; repoint/adapt it
to the sim backend contract below).
