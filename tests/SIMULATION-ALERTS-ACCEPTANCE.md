# Simulation alert acceptance evidence

Verified 2026-09-06 against the actual static production build and an updated local relay at `http://127.0.0.1:8139`.

## Reproduce

```sh
npm run build:static
# Run the updated relay, then:
APP_URL=http://127.0.0.1:8139 node tests/simulation-alerts-ui.mjs
npm test
```

The browser test uses the real dashboard controls and two independent sensor browser contexts in one isolated session. It does not inject simulation events or replace the relay. One node has an unavailable microphone. The other runs the real audio, mel, and ONNX pipeline against a deterministic silent WAV through Chromium's fake microphone. This checks channel separation, not field accuracy of the neural network.

## Observed results

| Requirement | Concrete observation |
| --- | --- |
| Admin actions now produce visible node interactivity | The node went from **0 simulation notices before execution to 13 distinct notices** across the exercised scenarios. |
| Blast reaches nodes, including a partitioned node | Clicking the real impact control/map delivered `impact:started` to both nodes. The impacted node showed `AFFECTS YOUR NODE`; the other showed `SESSION ONLY`. Actual relay state confirmed both `admin ↔ n01` and `n01 ↔ n02` were down during notification and restored afterward. |
| Interactive node-to-admin response | Clicking **Acknowledge** changed the node button to **Acknowledged** after the relay echo. The dashboard displayed `Blast impact · started / 1/2 acknowledged · n01`. |
| Restoration updates the node | `impact:restored` arrived after eight seconds. The node displayed one latest blast row, not a stale started row plus a new row. |
| Drone lifecycle | Manual start, proximity contact, cancellation, replay, and natural completion all arrived through the real relay. Replay produced exactly two contact events and affected `n01` and `n02`. |
| Other dashboard simulations | Both `interference:started/restored` and `isolation:started/restored` arrived and rendered. |
| Simulations do not create microphone evidence | The microphone-unavailable node produced **zero** local reading records across all scenarios. Its detector displayed `N/A` and zero detections. |
| Live detector continues independently during simulations | The live ONNX node advanced from **3 to 97 unique locally originated readings** during the workflow. All 97 verdicts were false under silent input. Its detection count stayed **0 → 0**. The simulation notices did not create a positive verdict or stop inference. |
| Visibility and mobile interaction | Drone notices rendered while the sensor window was minimized. Panel bounds and document overflow checks passed at **1440, 390, and 320 px**. Keyboard expand/collapse and reduced-motion checks passed. |
| Runtime health | **Zero browser page errors**. |

The observed phase set was:

```text
impact:started, impact:restored
drone:started, drone:contact, drone:cancelled, drone:completed
interference:started, interference:restored
isolation:started, isolation:restored
```

The script prints `OBSERVED_ACCEPTANCE` with measurements on every run. When `JCODE_SCRATCH_DIR` is set, it also writes `simulation-acceptance-observations.json` and viewport screenshots there. Counts of real readings can vary with machine speed; assertions require continued inference and no fabricated positives rather than a fixed count.

Additional validation passed: **136 unit/real-relay tests**, production static build/type checking, and the existing live sensor browser regression (four sizes, three tabs, microphone continuity, reload/resume, and detector failure). Protocol tests independently cover session/admission isolation, malformed notices, spoofed acknowledgement attribution, bounded history, expiry, deduplication, and re-admission replay.

## Operating boundary

Simulation notifications intentionally use the control channel and bypass simulated radio-link cuts. An acknowledgement confirms that a participant saw a demo, not that a mesh route succeeded. Existing relay processes must restart to load the server change, and existing pages must reload. The local verified preview uses the new relay; no remote deployment is claimed.
