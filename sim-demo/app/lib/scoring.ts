// scoring.ts — microphone to drone likelihood, on-device.
//
// Placeholder for the ML model, behind the interface the mesh actually depends
// on (ARCHITECTURE.md §9): score every window, expose `logit` and `snr_db`
// alongside `p`, and run in the browser. Swapping in the CRNN means replacing
// `score()` and nothing else.
//
// Band-energy over 50–5500 Hz against a tracked noise floor. Deliberately NOT a
// trained classifier's probability: those saturate, and a saturated p carries no
// position information at all (§6.2). SNR keeps dynamic range across room scale.

export interface Score {
  p: number;
  logit: number;
  snrDb: number | null;
}

export const SILENT: Score = { p: 0, logit: -10, snrDb: null };

const LO_HZ = 50;
const HI_HZ = 5500;
const SNR_MID_DB = 8; // p = 0.5 here
const SNR_SCALE_DB = 4;

export interface Scorer {
  start(): Promise<void>;
  stop(): void;
  latest(): Score;
}

export class MicScorer implements Scorer {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private stream: MediaStream | null = null;
  private buf: Float32Array | null = null;
  private floorDb = -80;
  private score: Score = SILENT;
  private timer: ReturnType<typeof setInterval> | null = null;

  async start(): Promise<void> {
    // iOS voice processing mangles drone audio — all three must be off.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    const ctx = new AudioContext({ sampleRate: 16000 });
    this.ctx = ctx;
    const src = ctx.createMediaStreamSource(this.stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.3;
    src.connect(analyser);
    this.analyser = analyser;
    this.buf = new Float32Array(analyser.frequencyBinCount);

    // 500 ms hop, matching the fusion window.
    this.timer = setInterval(() => this.sample(), 500);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.ctx = null;
    this.score = SILENT;
  }

  latest(): Score {
    return this.score;
  }

  private sample(): void {
    const analyser = this.analyser;
    const buf = this.buf;
    const ctx = this.ctx;
    if (!analyser || !buf || !ctx) return;

    analyser.getFloatFrequencyData(buf as never);
    const nyquist = ctx.sampleRate / 2;
    const perBin = nyquist / buf.length;
    const lo = Math.floor(LO_HZ / perBin);
    const hi = Math.min(buf.length - 1, Math.ceil(HI_HZ / perBin));

    // Mean power in band, in dB.
    let acc = 0;
    let n = 0;
    for (let i = lo; i <= hi; i++) {
      const db = Number.isFinite(buf[i]) ? buf[i] : -140;
      acc += Math.pow(10, db / 10);
      n++;
    }
    const bandDb = 10 * Math.log10(Math.max(acc / Math.max(n, 1), 1e-14));

    // Asymmetric floor tracking: fall fast to quiet, rise slowly, so a sustained
    // drone does not get absorbed into the floor within a demo.
    this.floorDb =
      bandDb < this.floorDb
        ? this.floorDb + (bandDb - this.floorDb) * 0.25
        : this.floorDb + 0.01;

    const snrDb = bandDb - this.floorDb;
    const logit = (snrDb - SNR_MID_DB) / SNR_SCALE_DB;
    const p = 1 / (1 + Math.exp(-logit));
    this.score = { p, logit, snrDb };
  }
}
