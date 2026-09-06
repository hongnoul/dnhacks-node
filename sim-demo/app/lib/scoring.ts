// scoring.ts — microphone to drone verdict, on-device.
//
// Wraps ml-demo's pipeline unchanged: MicCapture → TS mel front end → CRNN via
// ONNX Runtime Web, then ml-demo's own hysteresis latch (detection.ts). Nothing
// here re-implements or second-guesses the detector.
//
// What this module adds is the *level channel* the mesh needs.
//
// WHY THE SCORE IS NOT ENOUGH
//
// The detector peak-normalises every 1 s window before the mel front end
// (NORM_PEAK / peak, mirroring model.py) so room playback 20–30 dB below file
// level still lands in the CRNN's training range. Right for detection — and it
// means the score carries *no level information by construction*. Measured at
// 1.00 from across a room.
//
// Fusion localises by comparing levels between nodes (ARCHITECTURE.md §6.2,
// §10), so range has to come from the raw signal before that normalisation.
// ml-demo used to expose `bandLoudness`, but the AnalyserNode was removed for
// latency, so we take RMS over the same window we hand the detector — the true
// pre-normalisation level, one pass over an array we already have.
//
// The CRNN answers "is it a drone"; the level answers "how close". Drop the
// second and the mesh detects perfectly and localises not at all.

import { MicCapture } from "./vendor/audio.ts";
import { DroneDetector } from "./vendor/detector.ts";
import { DetectionLatch, SCORE_INTERVAL_MS } from "./detection.ts";

export interface Score {
  /** Raw CRNN score. Fusion's input — smoothing would lag the evidence. */
  p: number;
  /** Smoothed + peak-held, for display only. */
  display: number;
  /** ml-demo's latched verdict. Stateful, so it travels on the wire. */
  detecting: boolean;
  /** log(p/(1−p)) — dynamic range where p saturates. */
  logit: number;
  /** Window level above the tracked noise floor. The range channel. */
  snrDb: number | null;
}

export const SILENT: Score = {
  p: 0,
  display: 0,
  detecting: false,
  logit: -10,
  snrDb: null,
};

const WINDOW_S = 1.0;
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
  private latch = new DetectionLatch();
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
    this.latch.reset();
    this.floorDb = FLOOR_INIT_DB;
    this.loaded = true;
    this.timer = setInterval(() => void this.tick(), SCORE_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.mic.stop();
    void this.detector.dispose();
    this.latch.reset();
    this.loaded = false;
    this.score = SILENT;
  }

  latest(): Score {
    return this.score;
  }

  private async tick(): Promise<void> {
    // wasm inference can outrun a 250 ms tick on a slow phone; skip rather than
    // queue, so the reported score stays the most recent one.
    if (this.busy || !this.loaded) return;
    this.busy = true;
    try {
      const samples = this.mic.samplesInto(WINDOW_S);
      if (!samples) return;

      // Level from the raw window, before the detector normalises it away.
      let sq = 0;
      for (let i = 0; i < samples.length; i++) sq += samples[i] * samples[i];
      const rms = Math.sqrt(sq / Math.max(samples.length, 1));
      const levelDb = 20 * Math.log10(Math.max(rms, 1e-6));

      const raw = await this.detector.score(samples, this.mic.sampleRate);
      const v = this.latch.push(raw);

      this.floorDb =
        levelDb < this.floorDb
          ? this.floorDb + (levelDb - this.floorDb) * FLOOR_FALL
          : this.floorDb + FLOOR_RISE;

      const clamped = Math.min(Math.max(raw, 1e-6), 1 - 1e-6);
      this.score = {
        p: v.raw,
        display: v.display,
        detecting: v.detecting,
        logit: Math.log(clamped / (1 - clamped)),
        snrDb: levelDb - this.floorDb,
      };
    } catch {
      // A failed window is not a detection. Keep the last score rather than
      // publishing a spurious zero.
    } finally {
      this.busy = false;
    }
  }
}
