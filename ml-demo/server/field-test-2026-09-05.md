# Field test 2026-09-05 — real drone at ~30 cm (pre-norm bundle)

First real-drone capture through the phone UI: iPhone on the apex prod URL,
real drone hovering ~30 cm from the mic. Six screenshots 18:40–18:42
(`IMG_8393`–`IMG_8398`). Timing overlaps the peak-norm deploy, so these
readouts are most likely the **pre-fix** bundle — retest on a hard refresh
to confirm the fix moves these numbers.

## Raw readouts

| file | time | drone confidence | band | harmonics | peak |
|---|---|---|---|---|---|
| IMG_8393 | 18:40 | 0% clear | 0% | 11.1× prop-like | 7% |
| IMG_8394 | 18:41 | 0% clear | 0% | 5.3× flat | 7% |
| IMG_8395 | 18:41 | 0% clear | 0% | 9.3× flat | 7% |
| IMG_8396 | 18:41 | 0% clear | 0% | 6.8× flat | 45% |
| IMG_8397 | 18:41 | 0% clear | 0% | 8.1× flat | 45% |
| IMG_8398 | 18:42 | 0% clear | 0% | 7.1× flat | 45% |

Detections: 0 in all six. Inference 44–46 ms on-device (model running fine).

## What it proves

1. **Level was the blocker.** Real drone at 30 cm reached 45% peak vs 8%
   on MacBook-speaker playback — same model, louder signal. Matches the
   lab finding that the CRNN collapses below −20 dB (1.0 → 0.25 → 0.06).
2. **45% is one threshold-step away.** Just under the 0.5 DRONE DETECTED
   line, so 0 detections despite genuine drone audio. Peak-norm
   (recovering 1.0 down to −40 dB in lab) should push this over.
3. **Band meter is not a success metric.** 0% in all six captures even at
   30 cm — the ×30 analyser scale is tuned for file levels, not mic levels.
   Use CRNN peak confidence, not the band %.
4. **File-derived harmonic thresholds don't transfer.** Mic audio gives
   5–9× (prop-like tripped once at 11.1×), not the ~30+ seen on DADS
   files. The CRNN verdict, not the gate heuristic, is the detector.
5. **Pipeline is healthy.** Sub-50 ms inference, confidence moves with
   real audio (7% → 45%), no stuck state.

## Follow-up

Hard-refresh prod (post-norm bundle) and repeat the 30 cm hover.
Expect peak ≥ 90% and DRONE DETECTED within a second. Screenshots live in
the operator's `~/Downloads/IMG_839[3-8].png` (not committed).
