// detector.ts — on-device CRNN drone detection via onnxruntime-web.
// The phone IS the node: mic → mel-spectrogram (mel.ts) → CRNN (drone_crnn.onnx)
// → drone confidence. No server, no network, no location. Airplane mode works
// once the page + model are cached.

import * as ort from "onnxruntime-web";
import {
  HOP,
  N_MELS,
  SR,
  WINDOW_HOP,
  WINDOW_SAMPLES,
  logMelSpectrogram,
  resampleTo16k,
} from "./mel";

// Serve the ORT wasm from our own origin so the PWA works offline.
// copy-ort-wasm.mjs vendors dist/*.wasm into public/ort/ at postinstall.
// NOTE: onnxruntime-web is pinned to 1.18.0 — the last version shipping a
// single-threaded SIMD build. 1.19+ is threaded-only and its wasm dies on
// iOS Safari with "no available backend found / RangeError: Out of memory".
if (typeof window !== "undefined") {
  ort.env.wasm.wasmPaths = "/ort/";
  ort.env.wasm.numThreads = 1; // no cross-origin-isolation on Vercel by default
  ort.env.wasm.proxy = false; // run on the main thread, no proxy worker
}

export class DroneDetector {
  private session: ort.InferenceSession | null = null;

  /** Fetch + compile the model. ~10 MB wasm + 6 MB model, cached after first load. */
  async load(): Promise<void> {
    if (this.session) return;
    this.session = await ort.InferenceSession.create("/drone_crnn.onnx", {
      executionProviders: ["wasm"],
    });
    // Warm up: first run compiles wasm kernels (~200-500 ms on phones).
    // Doing it here keeps the first live tick fast so the first drone
    // window scores in ~50 ms instead of stalling the scan loop.
    const warm = new Float32Array(N_MELS * FRAMES_PER_WINDOW);
    const tensor = new ort.Tensor("float32", warm, [1, 1, N_MELS, FRAMES_PER_WINDOW]);
    try {
      await this.session.run({ log_mel: tensor });
    } catch {
      /* warmup is best-effort — real ticks will compile on demand */
    }
  }

  get ready(): boolean {
    return this.session !== null;
  }

  /** Release the wasm session (e.g. on Stop) so a restart starts clean. */
  async dispose(): Promise<void> {
    const s = this.session;
    this.session = null;
    if (s) {
      try {
        await s.release();
      } catch {
        /* already released */
      }
    }
  }

  /**
   * Score audio at any sample rate. Returns max drone probability over
   * 1 s windows at 500 ms hop — mirrors model.py score_waveform().
   */
  async score(samples: Float32Array, sampleRate: number): Promise<number> {
    if (!this.session) throw new Error("model not loaded");
    // Fast silence gate BEFORE resample+mel: scan every 4th sample for any
    // peak above the floor. Digital silence skips ~9 ms of frontend work and
    // returns 0 in microseconds — quiet rooms cost nothing. Any real audio
    // (peak >> floor even at -60 dBFS) falls through to the exact path.
    // Stride 4 cannot miss: a peak above floor spans many samples.
    let gate = 0;
    for (let i = 0; i < samples.length; i += 4) {
      const a = Math.abs(samples[i]);
      if (a > gate) {
        gate = a;
        if (gate >= PEAK_FLOOR) break;
      }
    }
    if (gate < PEAK_FLOOR) return 0;
    let wave = resampleTo16k(samples, sampleRate);
    if (wave.length < WINDOW_SAMPLES) {
      const padded = new Float32Array(WINDOW_SAMPLES);
      padded.set(wave);
      wave = padded;
    }
    let best = 0;
    for (let start = 0; start + WINDOW_SAMPLES <= wave.length; start += WINDOW_HOP) {
      const raw = wave.subarray(start, start + WINDOW_SAMPLES);
      let peak = 0;
      for (let i = 0; i < raw.length; i++) {
        const a = Math.abs(raw[i]);
        if (a > peak) peak = a;
      }
      if (peak < PEAK_FLOOR) continue; // digital silence — don't amplify noise
      const g = NORM_PEAK / peak;
      const chunk = new Float32Array(raw.length);
      for (let i = 0; i < raw.length; i++) chunk[i] = raw[i] * g;
      const { data, frames } = logMelSpectrogram(chunk);
      const tensor = new ort.Tensor("float32", data, [1, 1, N_MELS, frames]);
      const out = await this.session.run({ log_mel: tensor });
      const logit = (out.logit.data as Float32Array)[0];
      const prob = 1 / (1 + Math.exp(-logit));
      if (prob > best) best = prob;
    }
    return best;
  }
}

// Scoring gain normalization (mirrors model.py): peak-normalize each 1s
// window before the mel front end. Room playback lands 20-30 dB below file
// level and the fixed (dB+40)/40 norm shifts quiet audio out of the CRNN's
// training range. Windows below PEAK_FLOOR are digital silence — score 0.
// PEAK_FLOOR = 0.001 (-60 dBFS): lab sweep shows the CRNN still recovers
// 1.0 on drone audio down to -50 dB after norm, with noise clips staying
// <0.002. The old 0.005 floor gated drone audio quieter than -35 dB.
export const NORM_PEAK = 0.9;
export const PEAK_FLOOR = 0.001;

// Expected mel frame count for a 1 s window: center padding adds n_fft, so
// frames = 1 + ((SR + N_FFT) - N_FFT) / HOP = 1 + SR/HOP = 101
export const FRAMES_PER_WINDOW = 1 + SR / HOP;
