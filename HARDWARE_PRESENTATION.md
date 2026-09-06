# Hardware presentation strategy

## Scope
Present the supplied SkyMesh hardware concept on the Apex marketing page and connect it to the working phone demo. The initial design proposal is now partially implemented as a standalone hardware explorer. This does not confirm that hardware specifications have been achieved. No dedicated Apex page was located in this repository.

## Recommended experience
Place a hardware section after the network explanation and before the demo CTA. Show an isolated perspective view alongside the headline “A small node. Part of a larger picture.” Use three primary callouts: microphone array, local processing, and radio links.

Proposed copy: “SkyMesh’s proposed acoustic sensor combines local detection, radio communication, and solar-assisted power in a compact enclosure. Each node contributes observations to a shared picture.”

Use the blueprint blue as an accent within the existing design. Do not shrink the full technical sheet into an unreadable inline image. Provide Exterior, Inside, and Full blueprint views. Use the interactive 3D exterior concept model, with a static illustration fallback. Mobile annotations must be stacked and accessible without hover.

## Product boundary
The phone-facing product currently identifies itself as SkyMesh P2P. Preserve its existing controlled-release positioning. Add an optional “Explore the hardware concept” link beside the hardware disclaimer, without competing with microphone onboarding or placing marketing content in the operator workspace.

| Proposed hardware | Current browser demonstration |
| --- | --- |
| MEMS microphone array | Phone microphone |
| Embedded inference target | Browser-local ONNX inference |
| Direct radio links | WebSocket relay transport |
| Autonomous power system | Phone battery and an open screen |

Bridge copy: “Try the sensing and distributed software today using your phone.” The demo does not establish radio range, embedded inference compatibility, or hardware endurance.

## Specification guardrails
Label the design “Hardware concept / Target specifications.” Treat weight, IP67, temperature tolerance, endurance, and MCU suitability as targets until independently verified. Distinguish radio communication range from acoustic detection range. The drawing's 3.7 V, 4 Ah battery implies approximately 14.8 Wh, or 7–15 hours at continuous 1–2 W before losses. Claims of weeks require a validated duty cycle and solar energy budget. Do not reproduce a “scale 1:1” claim for a responsive web image.

## Implementation acceptance checklist
- Locate and confirm the actual Apex source before making marketing-page changes.
- Obtain the original image asset and permission to use any derived crops. Keep the full sheet available at readable resolution.
- Hardware section appears between network explanation and demo CTA.
- Hardware is visibly labeled as a concept, including in the full-blueprint viewer.
- Exterior and cutaway views explain the same components as the supplied reference.
- Full-blueprint viewer supports keyboard dismissal, appropriate focus management, descriptive alternative text, and a direct image link.
- At phone widths, annotations remain legible and do not require hover or horizontal page scrolling.
- Optional hardware exploration does not request microphone permission, start the detector, or join a session.
- Returning to onboarding preserves session URL parameters and the primary join action.
- Existing microphone join, sensor runtime, and station workflows still pass their existing browser checks after implementation.
- Browser relay transport is not relabeled as direct radio or LoRa connectivity.
- No unverified specification is presented as a tested result.

## Initial strategy validation (before implementation)
The proposal was checked against `app/page.tsx`, `app/lib/TrajectoryHero.tsx`, and the architecture and product flow in `README.md`, together with the supplied hardware drawing. These confirm the disclaimer placement, phone-local detection, and browser relay boundary. At the initial strategy stage there was no new rendered interface to exercise. The later implementation and validation results are recorded below. The separate Apex integration remains unimplemented.


## Implemented hardware explorer
- Route: `/hardware/`, linked from onboarding in a new tab so the original session and microphone flow remain untouched.
- Model: `public/models/skymesh-node.glb` (approximately 374 KiB), generated with `node scripts/build-hardware-model.mjs`.
- Exterior geometry includes dome, solar cap and cell seams, four protective ribs, antenna, chassis, mounting feet, and illustrative service port. Materials are procedural and require no external textures.
- Drag/pinch/scroll controls, keyboard-operable component viewpoint buttons, reset, downloadable GLB, and static SVG loading/error fallback.
- No automatic animation or continuous render loop. The viewer redraws on interaction and resize, including for reduced-motion users.
- The original blueprint asset has not been imported. A blueprint viewer and internal cutaway remain future work, not implemented features. No dedicated Apex source was found, so the standalone route is the integration destination rather than a modification to an unknown marketing page.
- The GLB is an illustrative exterior, not dimensionally validated CAD. It does not represent functional electronics, a tested acoustic array, or manufacturing-ready construction.

### Validation commands
`npm run build`, `npm test`, and `APP_URL=http://localhost:3017 node tests/hardware-ui.mjs`.
The browser test checks rendered viewpoint changes, orbit/zoom/reset, keyboard selection, GLB download headers, 390px/320px layouts, onboarding session preservation, no microphone requests, and missing-model fallback. It runs against a real built application. Existing unit/integration tests pass separately. Physical-device touch and hardware performance are not validated by these checks.

Both production build and static export passed the browser acceptance test. The existing regression suite passed all 128 tests. Desktop and 320px mobile screenshots were visually reviewed. WebGL-unavailable fallback was also exercised.


## Dashboard integration
The sensor desktop now includes a `skymesh-node.glb` file launcher. Operations exposes “Hardware reference” in its navigation. Both open `HardwareLauncher`, a shared native dialog with navy title bar, gray beveled surfaces, component controls, Perspective/Front/Top/Base presets, Save GLB, and an explicit “Not connected hardware” status. `/hardware/` uses the same retro palette.

The viewer module is lazy-loaded on opening and unmounted on closing. Escape and the close button return focus to the launcher. On narrow screens the sensor icon joins the existing desktop icon grid rather than overlapping the sensor window. The modal temporarily blocks dashboard input, but does not unmount the sensor runtime or alter the session URL.

Validation: `APP_URL=http://127.0.0.1:3018 node tests/hardware-dashboard-ui.mjs` against the static export checks both entry points, deferred model request, theme color, viewpoints, close/reopen, focus restoration, canvas removal, mobile overflow, and continued sensor diagnostics. The sensor integration check deliberately uses the detector-unavailable path, not a live microphone. Live microphone continuity is not claimed as tested. Existing hardware browser checks also pass after the restyle.

### Retro viewer and desktop file refinement
The model grid has no text overlays, including while loading or displaying a fallback. Loading/error messages remain accessible in the inspector. Compact raised view buttons, a navy selected component row, recessed list and detail group boxes, dotted keyboard focus, and an inset status bar replace the oversized presentation-style controls. At narrow widths the controls retain touch-sized targets and the dialog scrolls without horizontal overflow.

The GLB launcher shares the existing video-file frame, filename label, responsive artwork sizes (146px desktop / 80px compact), and `useDesktopDrag` behavior. It supports bounded pointer dragging, suppresses opening after a drag, opens with click or keyboard, and returns focus when the viewer closes. Compact/touch layouts retain native scrolling instead of desktop dragging.

Acceptance: `APP_URL=http://127.0.0.1:3027 node tests/hardware-retro-ui.mjs`, the existing hardware and dashboard suites, and `UI_BASE_URL=http://127.0.0.1:3027 node tests/desktop-drag-ui.mjs` passed against the production static build. Checks exercise all three viewer contexts, an observed 110px/45px icon move without accidental opening, bounds, keyboard and focus behavior, 320px/390px layouts, and inherited style isolation. The static build and all 130 unit/integration tests passed. Desktop and mobile screenshots were reviewed.
