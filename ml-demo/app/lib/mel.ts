// mel.ts — TypeScript port of the model.py audio front end.
// Contract (model card): 16 kHz mono → mel spectrogram (n_fft=512, hop=160,
// n_mels=64, f_min=50, f_max=5500, power=2, HTK mel scale, no filterbank norm)
// → AmplitudeToDB (10·log10, amin=1e-10) → (dB + 40) / 40.
// Matches torchaudio defaults: periodic hann window, center=true with
// reflect padding. Verified against model.py in test-parity.mjs.

export const SR = 16_000;
export const N_FFT = 512;
export const HOP = 160;
export const N_MELS = 64;
export const F_MIN = 50;
export const F_MAX = 5_500;
export const WINDOW_SAMPLES = SR; // 1 s scoring window
export const WINDOW_HOP = SR / 2; // 500 ms

// ---------- FFT (iterative radix-2, complex) ----------

const _revTables = new Map<number, Uint32Array>();
function bitReverseTable(n: number): Uint32Array {
  let t = _revTables.get(n);
  if (t) return t;
  t = new Uint32Array(n);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    t[i] = r;
  }
  _revTables.set(n, t);
  return t;
}

/** In-place complex FFT. re/im length must be a power of two. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  const rev = bitReverseTable(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
      tmp = im[i]; im[i] = im[j]; im[j] = tmp;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const a = i + k;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

// ---------- mel filterbank (torchaudio melscale_fbanks, htk, norm=None) ----------

function hzToMel(f: number): number {
  return 2595 * Math.log10(1 + f / 700);
}
function melToHz(m: number): number {
  return 700 * (Math.pow(10, m / 2595) - 1);
}

let _fbank: Float64Array | null = null; // [N_MELS][nFreqs] row-major

export function melFilterbank(): Float64Array {
  if (_fbank) return _fbank;
  const nFreqs = N_FFT / 2 + 1; // 257
  const allFreqs = new Float64Array(nFreqs);
  for (let i = 0; i < nFreqs; i++) allFreqs[i] = (i * (SR / 2)) / (nFreqs - 1);
  const mMin = hzToMel(F_MIN);
  const mMax = hzToMel(F_MAX);
  const fPts = new Float64Array(N_MELS + 2);
  for (let i = 0; i < N_MELS + 2; i++) {
    fPts[i] = melToHz(mMin + ((mMax - mMin) * i) / (N_MELS + 1));
  }
  const fb = new Float64Array(N_MELS * nFreqs);
  for (let m = 0; m < N_MELS; m++) {
    const f0 = fPts[m];
    const f1 = fPts[m + 1];
    const f2 = fPts[m + 2];
    for (let k = 0; k < nFreqs; k++) {
      const up = (allFreqs[k] - f0) / (f1 - f0);
      const down = (f2 - allFreqs[k]) / (f2 - f1);
      fb[m * nFreqs + k] = Math.max(0, Math.min(up, down));
    }
  }
  _fbank = fb;
  return fb;
}

// ---------- hann window (periodic, torchaudio default) ----------

let _hann: Float64Array | null = null;
function hannWindow(): Float64Array {
  if (_hann) return _hann;
  const w = new Float64Array(N_FFT);
  for (let i = 0; i < N_FFT; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / N_FFT));
  }
  _hann = w;
  return w;
}

/**
 * Normalized log-mel spectrogram of a 16 kHz mono signal.
 * Returns { data, frames }: data is Float32Array [N_MELS * frames] laid out
 * row-major (mel × time) — matches the ONNX input [1, 1, 64, T].
 */
export function logMelSpectrogram(samples: Float32Array): {
  data: Float32Array;
  frames: number;
} {
  const pad = N_FFT / 2; // center=true reflect padding
  const n = samples.length;
  const padded = new Float64Array(n + 2 * pad);
  for (let i = 0; i < n; i++) padded[pad + i] = samples[i];
  for (let i = 0; i < pad; i++) {
    padded[pad - 1 - i] = samples[Math.min(i + 1, n - 1)]; // reflect left
    padded[pad + n + i] = samples[Math.max(n - 2 - i, 0)]; // reflect right
  }

  const frames = 1 + Math.floor((padded.length - N_FFT) / HOP);
  const nFreqs = N_FFT / 2 + 1;
  const win = hannWindow();
  const fb = melFilterbank();
  const power = new Float64Array(nFreqs);
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  const out = new Float32Array(N_MELS * frames);

  for (let t = 0; t < frames; t++) {
    const off = t * HOP;
    for (let i = 0; i < N_FFT; i++) {
      re[i] = padded[off + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < nFreqs; k++) power[k] = re[k] * re[k] + im[k] * im[k];
    for (let m = 0; m < N_MELS; m++) {
      let acc = 0;
      const row = m * nFreqs;
      for (let k = 0; k < nFreqs; k++) acc += fb[row + k] * power[k];
      // AmplitudeToDB(power): 10·log10(max(x, 1e-10)), then (dB+40)/40
      const db = 10 * Math.log10(Math.max(acc, 1e-10));
      out[m * frames + t] = (db + 40) / 40;
    }
  }
  return { data: out, frames };
}

// ---------- resampling (windowed-sinc, for 48 kHz browser audio → 16 kHz) ----------

/** Resample mono audio to 16 kHz. Identity if already 16 kHz. */
export function resampleTo16k(samples: Float32Array, fromRate: number): Float32Array {
  if (fromRate === SR) return samples;
  const ratio = SR / fromRate;
  const outLen = Math.floor(samples.length * ratio);
  const out = new Float32Array(outLen);
  // Windowed-sinc interpolation with anti-aliasing (cutoff at the lower nyquist)
  const cutoff = Math.min(1, ratio); // normalized to fromRate nyquist
  const width = 12; // taps each side
  for (let i = 0; i < outLen; i++) {
    const center = i / ratio;
    const start = Math.max(0, Math.ceil(center - width));
    const end = Math.min(samples.length - 1, Math.floor(center + width));
    let acc = 0;
    let norm = 0;
    for (let j = start; j <= end; j++) {
      const x = (j - center) * cutoff;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const w = 0.5 * (1 + Math.cos((Math.PI * (j - center)) / width)); // hann taper
      const h = sinc * w * cutoff;
      acc += samples[j] * h;
      norm += h;
    }
    out[i] = norm > 1e-9 ? acc / norm : acc; // normalize taps → unity DC gain
  }
  return out;
}
