# Apex mobile acceptance evidence

Implementation: `bc6a23c`. Checked against the production Next.js server on 2026-09-06.

## Requirement-to-observation map

| Requirement / changed output | Concrete check | Observed result |
| --- | --- | --- |
| Compact onboarding with reachable microphone action | `apex-mobile-ui.mjs`: 320x568, 390x844, 844x390, horizontal overflow and button visibility checks | Pass. Additional measurement at 320x568: button x=30, y=319.84, width=260, height=48. Entire action is visible without scrolling. |
| Sensor first, not below desktop launchers | Mobile suite: sensor top <30px and QR launcher below sensor at five viewport sizes | Pass. Measured sensor top is 12px at heights 390, 568, and 844. Previous source reserved 412px of mobile top padding. This is a source-to-runtime comparison, not an executed baseline build. |
| Dynamic viewport shell that can grow and scroll | Production browser measurement at width 390 with heights 568, 844, 390 | Computed main min-height follows exactly: 568px, 844px, 390px. Document width remains 390px. Content remains scrollable. |
| Responsive chart with sharp backing canvas, not CSS stretching | Production browser measures canvas CSS and backing heights after each viewport resize | CSS/backing heights match: 170/170, 240/240, 140/140 at DPR 1. |
| Native touch scrolling instead of window dragging | Mobile suite sends Chromium touchStart/touchMove/touchEnd on title bar | Pass. scrollY increases, sensor translate remains `none`, title touch-action is `auto`. |
| In-flow compact launchers, accessible restore | Mobile suite checks launcher below sensor and taps minimize/restore | Pass. Sensor returns with unchanged node identity. Screenshot reviewed at 390px. |
| All sensor tabs fit narrow screens | Mobile suite at 320x568, 390x664, 390x844, 844x390, 800x900, plus existing sensor suite at 1440/800/390/320 | Pass for Monitor, Mesh, Diagnostics. No horizontal document overflow. |
| Bounded QR dialog and focus restoration | Mobile suite opens/closes QR at all five sizes | Pass. Dialog remains within viewport, close returns focus to launcher. QR link preserves `session=mobile-acceptance`. |
| Video dialog and external launch behavior retained | `sensor-ui.mjs` and `desktop-drag-ui.mjs` open video, inspect link, close viewer, and drag launchers | Pass. Video URL, target, open/close, and drag suppression remain correct. Additional 844x390 touch-browser check passed: video dialog x=62, y=12, width=720, height=366, fully within viewport, close action works. |
| Desktop interaction preserved | `desktop-drag-ui.mjs` real mouse drags, boundary clamps, resize reset, animations, keyboard and reduced motion | Pass. Sensor moved 100x50, QR icon -160x60, QR dialog 110x40, video icon 170x80, video dialog -90x-30. Dragging does not activate files. |
| Sensor runtime independent of presentation | `sensor-ui.mjs`: real ONNX model with fake microphone, tabs/resizes, minimize/restore, close/reopen | Pass. One live microphone stream, unchanged socket count, records continue publishing while minimized. Reload requires explicit resume. |
| Failure remains a usable relay, not false confidence | Both sensor and mobile suites abort model request and join through the public action | Pass. Detector unavailable warning, N/A readout, sensor tabs and launchers remain usable. |
| Admin excluded and session routing preserved | Mobile suite navigates `/admin/?session=mobile-acceptance`; scoped git diff | Pass. Redirect reaches `/station` with matching session. No admin, station, global stylesheet, or root-layout changes. |
| Safe-area padding | Chromium `Emulation.setSafeAreaInsetsOverride`, added to mobile suite | Pass. Join and sensor use top44/bottom34 padding. Landscape uses left44/right44/bottom21. QR dialog x242/y22.5/w360/h345 respects available dimensions. This verifies nonzero CSS environment handling, not physical Safari behavior. |
| Real mobile browser toolbar and standalone mode | Proposed device acceptance checks | NOT RUN. Resizing a headless viewport is not equivalent to Safari toolbar expansion, physical notches, or installed standalone behavior. |
| Zoom / enlarged text | Chromium CDP pageScaleFactor=2 at 390x844, then reset and minimize/restore | Emulated pinch scale reached 2 with visualViewport width195 and layout width390. Reset and touch minimize/restore passed. This does not verify interactions while zoomed, enlarged text, or physical iOS zoom. |

## Commands and scope

- `npm run build`: pass, including TypeScript checks and all route generation.
- `npm test`: 113 passing tests, supplementary rather than a substitute for the mapped browser checks.
- `UI_BASE_URL=http://localhost:3198 node tests/apex-mobile-ui.mjs`: pass.
- `UI_BASE_URL=http://localhost:3198 node tests/sensor-ui.mjs`: pass.
- `UI_BASE_URL=http://localhost:3198 node tests/desktop-drag-ui.mjs`: pass.
- `git diff --check`: pass.

All three browser suites were rerun after the implementation commit and passed. A later measurement attempt was interrupted by the server reload, which stopped the local server. Restarting the server and repeating the measurements produced the results above.

Automated acceptance covers the main workflows and integration boundaries. Traceability remains partial for the physical-device and zoom checks explicitly listed as not run. Do not describe this as complete iOS acceptance.

Safe-area follow-up: the initial CDP method name was incorrect. The supported `Emulation.setSafeAreaInsetsOverride` succeeded and is now covered by the committed suite.
