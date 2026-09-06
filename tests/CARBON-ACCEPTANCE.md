# Carbon adoption acceptance evidence

Scope: commit `245fb72`, checked 2026-09-06. Concurrent subsequent workspace changes are not covered by this report.

| Requirement / changed output | Concrete check | Observed result |
| --- | --- | --- |
| Adopt IBM Carbon rather than only emulate its appearance | Inspect package manifest and rendered controls | `@carbon/react` and `@carbon/styles` installed. Console rendered 17 Carbon buttons and zero native-only buttons in the checked empty-session state. |
| Dark g100 design system | `tests/carbon-ui.mjs` document class and computed label color assertions | Passed. Document has `cds--g100`, labels are rgb(198,198,198). Initial missing CSS theme class was corrected. |
| Carbon operations header | Browser role lookup and computed foreground | SkyMesh banner visible, foreground rgb(244,244,244). |
| Carbon status tags | Browser locators and source inspection | Distributed sensing and Demo tags rendered. Relay and simulation labels use Carbon Tag with explicit state text. |
| Rectilinear panels and Plex typography | Computed styles in browser | Panel radius 0px. Body font stack begins IBM Plex Sans. |
| Primary, tertiary and danger action hierarchy | Inspect ActionButton implementation and production type check | Native handlers forwarded unchanged. Existing primary/danger class inputs map to Carbon kinds. Type check passed. Not every data-dependent action was exercised live. |
| Desktop panel selector | Select all six always-available panels in UI regression | Passed: confidence, topology, scenario, activity, links, nodes each became visible. |
| Scenario button behavior | Click simulate drone, then reset drone | Passed in repeatable UI regression. |
| Audio-selector migration | Click wind and inspect existing SOUNDS configuration | Wind remains an embedded external player, not a local play-wind button. An exploratory assertion expecting play-wind timed out because that expectation was incorrect. External playback was not verified. |
| Phone enrollment control | Carbon class and bounding-box checks | Passed. Enrollment button is Carbon, at least 44px high, and retains original join handler. Physical microphone permissions not re-tested. |
| Responsive console and phone | Overflow assertions at 1440, 1024, 768, 390px | Passed on both routes. |
| Reduced-motion styling | Source rule inspection and computed transition probe | Rule exists at carbon.css line 63. Existing preview returned 0.07s transitions after a rebuild without preview restart. Final rule's rendered behavior remains unverified, rather than treated as passed. |
| Preserve map, graph, mesh and detector behavior | Diff inspection, existing regression suite | No detector, mesh, map or graph implementation changed. All 45 tests passed, including fusion, relay, gossip and scenario suites. Physical multi-phone acceptance remains unverified. |
| Production compatibility | `npm run build` | Passed compilation, type checking and page generation after final migration edits. |
| No browser runtime regressions | Playwright pageerror collection | No errors in repeatable UI regression. |
| Document the integration | README design-system section | Documents document CSS theme, React context, components, token bridge and UI test invocation. |
| Preserve user's work | Commit scope and git status | demo-public.sh excluded from commit. Later concurrent UI edits were not altered by this verification. |

Dependency audit reported existing Next.js/PostCSS advisories. No breaking dependency upgrade was applied as part of the visual migration.
