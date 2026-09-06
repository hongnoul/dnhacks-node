# Hardware presentation strategy

## Scope
Present the supplied SkyMesh hardware concept on the Apex marketing page and connect it to the working phone demo. This is a design proposal, not an implementation or confirmation that hardware specifications have been achieved. No dedicated Apex page was located in this repository.

## Recommended experience
Place a hardware section after the network explanation and before the demo CTA. Show an isolated perspective view alongside the headline “A small node. Part of a larger picture.” Use three primary callouts: microphone array, local processing, and radio links.

Proposed copy: “SkyMesh’s proposed acoustic sensor combines local detection, radio communication, and solar-assisted power in a compact enclosure. Each node contributes observations to a shared picture.”

Use the blueprint blue as an accent within the existing design. Do not shrink the full technical sheet into an unreadable inline image. Provide Exterior, Inside, and Full blueprint views. Start with static images rather than a new 3D model. Mobile annotations must be stacked and accessible without hover.

## Product boundary
The phone-facing product is SkyMesh Client. Preserve its existing controlled-release positioning. Add an optional “Explore the hardware concept” link beside the hardware disclaimer, without competing with microphone onboarding or placing marketing content in the operator workspace.

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

## Current validation and remaining boundary
The proposal was checked against `app/page.tsx`, `app/lib/TrajectoryHero.tsx`, and the architecture and product flow in `README.md`, together with the supplied hardware drawing. These confirm the disclaimer placement, phone-local detection, and browser relay boundary. The current task produces a strategy document, so there is no new rendered interface to exercise. Apex layout, responsive behavior, image interactions, and end-to-end onboarding regression checks remain implementation acceptance criteria, not completed tests.
