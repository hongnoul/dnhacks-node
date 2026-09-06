# Approved UI acceptance evidence

Verified 2026-09-06 against the production Next server on :3107 and a real local relay on :8001.

Run:
- `npm run build && npm test`
- `UI_BASE_URL=http://127.0.0.1:3107 node tests/ui-design-smoke.mjs`
- `APP_URL=http://127.0.0.1:3107 node tests/ui-smoke.mjs`

| Requirement / changed output | Public-interface observation | Result |
| --- | --- | --- |
| Tactical dark design | Browser computed background rgb(8,15,23), sans-serif body and monospace metric values | Pass at 1440/1024/390/320px |
| Balanced dashboard cards | Browser grid has two columns at 1440px, one at narrower widths; four summary metrics render | Pass |
| QR and drone remain visible, not behind a disclosure | Sidebar QR SVG and drone canvas visible without opening a panel; demo heading present | Pass at all four widths |
| QR still points to the correct session | Displayed join URL equals current origin plus `?session=ui-review` | Pass; physical camera scan not tested |
| Judge-facing overview and live/simulation separation | Operations title, four metrics and explicit Simulation badge render; real relay connects | Pass |
| Phone onboarding | Three ordered instructions, privacy copy, enabled join button and keyboard focus outline | Pass at all four widths |
| Join/admit remains functional | Three browser nodes join and are admitted through operator buttons | Pass with real relay |
| Post-join phone presentation | Own mesh picture and replica info render; accessible confidence canvas and room map fit 320/390px without document overflow | Pass |
| Responsive map preserves interaction | Map clicks place drone start/destination; flight starts | Pass after fixing legacy test to scroll target into view |
| Larger controls / keyboard access | Every operator button has height >=44px; join button has visible solid focus outline | Pass |
| Renamed topology, sensor directory and confidence panels preserve workflow | Three admitted node rows, auto-placement, confidence canvases, replica convergence | Pass |
| Link controls and scenario activity remain usable | Expand, cut link, arm placement, arm impact, run flight and complete replay | Pass |
| Build / integration regression | Production build and existing 45 tests | Pass |

Concrete improvements: small-phone post-join charts and maps now fit the viewport, operator controls provide measured 44px targets, setup explains all three steps, and simulation is explicitly labeled. These are observed usability properties, not a claim that user preference or task completion speed has been measured. Visual screenshot review corroborated the layout but is not the sole evidence.

Audit correction: the first UI commit unintentionally replaced the existing smoke test. The follow-up restores it with updated text selectors and viewport-safe map clicks. Design-specific assertions now live separately in ui-design-smoke.mjs.

Limits: no physical phone camera scan, real microphone drone classification, audio playback listening, participant study, or subjective aesthetic preference testing. All requirements have evidence above, but comprehensive verification of every visual state and human usability remains partial.

## Output-level traceability supplement

Additional assertions in `ui-design-smoke.mjs` passed at all four viewport widths:
- Station brand: `SkyMesh` text and raw-audio privacy note.
- Join card: heading, session URL, visible QR, and QR SVG accessible title.
- Dashboard headings: Mesh overview, Sensor confidence, Network topology, Scenario activity, Sensor directory.
- Summary outputs: Admitted sensors, Listening now, Detecting nodes, Replicated records.
- Map/source labels: Room coordinates and Live readings.
- Empty state: Your mesh starts with one phone.

Changed-file mapping:
- `globals.css`: computed palette/font assertions, grid columns, minimum target heights, focus outline and document overflow assertions.
- `station/page.tsx`: brand/privacy assertions, QR/demo visibility, responsive grid assertions.
- `JoinCard.tsx`: accessible title, QR visibility, session URL assertions.
- `AdminDashboard.tsx`: all new heading/metric/source-label/empty-state assertions plus real relay and scenario smoke.
- `page.tsx`: onboarding heading/steps/button/privacy/focus assertions plus actual join, own mesh picture and replica convergence.
- `RoomMap.tsx`: visible dimensions, post-join small-phone fit, actual start/destination pointer interactions.
- `ConfidenceGraph.tsx`: accessible label and small-phone fit, rendered per-node canvases in admitted session.

For the approved UI-change scope, requirement-to-check mapping is complete. This does not expand the claim to physical audio accuracy, participant preference, performance benchmarking, or every possible combination of application state. Those are outside this UI acceptance result.

## Full-viewport console revision

The station now uses a 100dvh desktop shell at widths >=1000px and heights >=650px. The map measures both available width and height. A labeled native panel selector keeps every secondary control reachable without stacking all panels vertically. Sensor, pending-admission, link and event lists paginate instead of growing indefinitely. Narrower or shorter viewports retain the usable stacked/scrolling layout.

Observed acceptance on the final build:
- `ui-viewport-smoke.mjs`: all six console panels passed exact zero document overflow and visible-control bounds at 1440x900, 1366x768, 1280x720, 1024x768 and 1000x650.
- `ui-smoke.mjs`: four real browser nodes admitted, fourth node reachable through Next sensors, all six populated panels fit at 1366x768 and 1000x650. Placement, map pointer interaction, flight, link cuts and replay passed through the panel selector.
- `ui-design-smoke.mjs`: QR/drone visibility, palette, fonts, labels, keyboard focus, button targets and mobile layout passed at 1440/1024/390/320px.
- Production build and all 45 unit/integration tests passed.

The checks exposed and resolved sidebar text overflow, populated scenario overflow, and long activity-message overflow. No overflow-hidden rule is applied to the console to conceal offscreen controls. The long textual join URL is intentionally ellipsized in compact mode; its QR retains the full URL. This revision has not been deployed.
