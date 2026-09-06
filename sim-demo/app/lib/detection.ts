// detection.ts — detection semantics, mirrored from ml-demo.
//
// These constants and the latch below are ml-demo/app/page.tsx's, not new ones.
// Detection is a *stateful* verdict now, not a threshold on the latest score, so
// the mesh cannot just compare p to a number and expect to agree with the
// standalone demo. Re-check this file whenever ml-demo's tuning changes.

/** ml-demo: SCORE_INTERVAL_MS — 4 Hz. */
export const SCORE_INTERVAL_MS = 250;

/** Trip point. */
export const DETECT_THRESHOLD = 0.35;

/** Release below the trip point, so a flickering 0.30/0.40 signal does not chatter. */
export const RELEASE_THRESHOLD = 0.25;

/** A distant drone can sit here forever and never reach the trip point. */
export const MARGINAL_FLOOR = 0.22;
export const MARGINAL_TICKS = 3;

/** Display smoothing: fast attack, damps single-window flicker. */
export const DISPLAY_ALPHA = 0.6;

/** Hold a brief spike so one 1 s window sliding past a drone stays visible. */
export const PEAK_HOLD_MS = 1500;

/** Visible history window on the confidence graph. */
export const GRAPH_WINDOW_MS = 60_000;

// ml-demo's palette, so a node reads the same in either app.
export const GREEN = "#3ddc97";
export const RED = "#ff6b4a";
export const RED_FILL = "rgba(255,107,74,0.14)";
export const GRID = "#243244";
export const MUTED = "#7d8fa6";

export interface Verdict {
  /** Raw CRNN score. What fusion uses — smoothing would lag the evidence. */
  raw: number;
  /** Smoothed + peak-held, for display only. */
  display: number;
  /** Latched detection state. What "is this node detecting" means. */
  detecting: boolean;
}

/**
 * ml-demo's detection state machine.
 *
 * Detection uses the raw score with hysteresis so smoothing never delays the
 * verdict; display uses an EMA plus max-hold so the number is readable. Kept as
 * a class because the verdict depends on history — which is exactly why the
 * mesh has to put it on the wire rather than recompute it from p (§6.1).
 */
export class DetectionLatch {
  private smooth: number | null = null;
  private peak: { p: number; t: number } | null = null;
  private marginal = 0;
  private was = false;

  reset(): void {
    this.smooth = null;
    this.peak = null;
    this.marginal = 0;
    this.was = false;
  }

  push(raw: number, t: number = Date.now()): Verdict {
    const prev = this.smooth;
    const smooth = prev == null ? raw : prev + DISPLAY_ALPHA * (raw - prev);
    this.smooth = smooth;

    const held = this.peak;
    const display = held && t - held.t < PEAK_HOLD_MS ? Math.max(smooth, held.p) : smooth;
    if (!held || smooth >= held.p || t - held.t >= PEAK_HOLD_MS) {
      this.peak = { p: smooth, t };
    }

    this.marginal = raw >= MARGINAL_FLOOR ? this.marginal + 1 : 0;
    const detecting = this.was
      ? raw >= RELEASE_THRESHOLD || raw >= MARGINAL_FLOOR
      : raw >= DETECT_THRESHOLD || this.marginal >= MARGINAL_TICKS;
    this.was = detecting;

    return { raw, display, detecting };
  }
}
