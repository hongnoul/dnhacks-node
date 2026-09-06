// scoring.ts — microphone to drone likelihood, on-device.
//
// Wraps ml-demo's pipeline unchanged: MicCapture → TS mel front end → CRNN via
// ONNX Runtime Web. That detector is bit-parity with the PyTorch reference and
// its ORT pin (1.18.0, single-threaded SIMD) is the only build that survives iOS
// Safari, so nothing here re-implements or second-guesses it.
//
// What this module adds is the *second* channel the mesh needs.
//
// WHY p IS NOT ENOUGH
//
// The detector peak-normalises every 1 s window before the mel front end
// (NORM_PEAK / peak, mirroring model.py) so that room playback 20–30 dB below
// file level still lands in the CRNN's training range. Excellent for detection —
// and it means the returned probability carries *no level information by
// construction*. Two nodes at 3 m and 12 m both report ~1.0.
//
// Fusion localises by comparing levels between nodes (ARCHITECTURE.md §6.2,
// §10), so range has to come from the raw signal before that normalisation.
// `bandLoudness` — RMS restricted to the drone band — is exactly that, measured
// against a tracked noise floor. The CRNN answers "is it a drone"; the level
// answers "how close". Drop the second and the mesh detects perfectly and
// localises not at all.

import { MicCapture } from "./vendor/audio.ts";
import { DroneDetector } from "./vendor/detector.ts";

export interface Score {
  /** CRNN drone probability for the latest 1 s window. */
  p: number;
  /** log(p/(1−p)), reconstructed — keeps dynamic range where p saturates. */
  logit: number;
  /** Band-limited level above the tracked noise floor. The range channel. */
  snrDb: number | null;
}

export const SILENT: Score = { p: 0, logit: -10, snrDb: null };

/** Scored window length and cadence, matching the model's own hop. */
const WINDOW_S = 1.0;
const HOP_MS = 500;

const FLOOR_INIT_DB = -75;
const FLOOR_FALL = 0.25; // track down to quiet quickly
const FLOOR_RISE = 0.01; // creep up slowly, so a sustained drone is not absorbed

export interface Scorer {
  start(): Promise<void>;
  stop(): void;
  latest(): Score;
  readonly ready: boolean;
}

export class MicScorer implements Scorer {
  private mic = new MicCapture();
  private detector = new DroneDetector();
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private floorDb = FLOOR_INIT_DB;
  private score: Score = SILENT;
  private loaded = false;

  get ready(): boolean {
    return this.loaded;
  }

  async start(): Promise<void> {
    // Model first: a node that cannot score should fail before it holds the mic.
    await this.detector.load();
    await this.mic.start();
    this.loaded = true;
    this.timer = setInterval(() => void this.tick(), HOP_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.mic.stop();
    void this.detector.dispose();
    this.loaded = false;
    this.score = SILENT;
  }

  latest(): Score {
    return this.score;
  }

  private async tick(): Promise<void> {
    // wasm inference can outrun a 500 ms tick on a slow phone; skip rather than
    // queue, so the reported score stays the most recent one.
    if (this.busy || !this.loaded) return;
    this.busy = true;
    try {
      const samples = this.mic.samples(WINDOW_S);
      if (!samples) return;

      const p = await this.detector.score(samples, this.mic.sampleRate);

      // Level from the raw frame, before the detector's peak normalisation.
      const band = this.mic.frame().bandLoudness;
      const bandDb = 20 * Math.log10(Math.max(band, 1e-6));
      this.floorDb =
        bandDb < this.floorDb
          ? this.floorDb + (bandDb - this.floorDb) * FLOOR_FALL
          : this.floorDb + FLOOR_RISE;

      const clamped = Math.min(Math.max(p, 1e-6), 1 - 1e-6);
      this.score = {
        p,
        logit: Math.log(clamped / (1 - clamped)),
        snrDb: bandDb - this.floorDb,
      };
    } catch {
      // A failed window is not a detection. Keep the last score rather than
      // publishing a spurious zero.
    } finally {
      this.busy = false;
    }
  }
}
