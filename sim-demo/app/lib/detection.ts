// detection.ts — detection semantics, kept in step with ml-demo.
//
// These are ml-demo's node page constants, not new ones. The mesh must agree
// with the standalone demo about what counts as a detection, or the same audio
// reads as a hit on one screen and a miss on the other.

/** ml-demo/app/page.tsx: DETECT_THRESHOLD */
export const DETECT_THRESHOLD = 0.5;

/** ml-demo/app/page.tsx: SCORE_INTERVAL_MS — the CRNN's own 500 ms hop. */
export const SCORE_INTERVAL_MS = 500;

/** Visible history window on the confidence graph. */
export const GRAPH_WINDOW_MS = 60_000;

// ml-demo's palette, so a node's graph reads identically in either app.
export const GREEN = "#3ddc97";
export const RED = "#ff6b4a";
export const RED_FILL = "rgba(255,107,74,0.14)";
export const GRID = "#243244";
export const MUTED = "#7d8fa6";
