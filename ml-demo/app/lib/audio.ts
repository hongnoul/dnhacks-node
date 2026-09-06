// audio.ts — mic capture + 2s WAV clip encoding.
// iOS Safari notes:
//  - getUserMedia requires HTTPS and a user gesture.
//  - Actual sample rate is whatever the hardware gives (typically 48 kHz); we report it, server resamples.
//  - Disable voice processing or iOS mangles drone audio.

/** Legacy loudness-gate metrics (analyser removed — kept for type compat). */
export interface AudioFrame {
  /** RMS loudness 0..1 over the last analysis window */
  loudness: number;
  /** RMS restricted to ~80–2000 Hz (drone band) 0..1 */
  bandLoudness: number;
  /** Harmonic peakiness: max/mean power in the drone band.
   *  Drone props produce strong harmonic peaks (ratio ~30+ on DADS audio);
   *  voice/noise is flatter (~6). Cheap on-device pre-filter before the
   *  server CRNN verdict — cuts voice false alarms without shipping audio. */
  peakiness: number;
}

export interface ClipResult {
  wav: Blob;
  /** epoch seconds of clip start */
  t0: number;
  sampleRate: number;
  durationS: number;
}

const CLIP_SECONDS = 2.0;
const RING_SECONDS = 4.0; // keep 4s so a clip can include 1s of pre-trigger audio

export class MicCapture {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private proc: ScriptProcessorNode | null = null;
  private ring: Float32Array<ArrayBuffer> = new Float32Array(0);
  private ringWrite = 0;
  private ringFilled = 0;
  // Scratch snapshot reused by samplesInto() so the 4 Hz tick allocates
  // nothing in steady state (same sample rate → same buffer, zero GC churn).
  private scratch: Float32Array<ArrayBuffer> = new Float32Array(0);
  public sampleRate = 48000;

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
    this.ctx = new AudioContext({ latencyHint: "interactive" });
    // latencyHint interactive asks the OS for the smallest mic→callback
    // path (often 128-256 frames vs 512+ balanced). Falls back harmlessly
    // where unsupported (older Safari ignores the hint).
    // iOS starts AudioContext suspended until a gesture-driven resume
    if (this.ctx.state === "suspended") await this.ctx.resume();
    this.sampleRate = this.ctx.sampleRate;
    this.ring = new Float32Array(Math.ceil(RING_SECONDS * this.sampleRate));

    const src = this.ctx.createMediaStreamSource(this.stream);

    // No AnalyserNode: the old loudness-gate FFT ran a 2048-point FFT on
    // every capture with zero consumers (the scan loop scores raw 1 s
    // snapshots via the CRNN). Skipping it removes per-callback FFT work.

    // ScriptProcessor is deprecated but still the most reliable cross-Safari way
    // to get raw samples without an AudioWorklet module fetch (which needs same-origin HTTPS anyway).
    // 2048-sample buffer (~43 ms at 48 kHz): fresher audio per tick than the
    // old 4096 (~85 ms), still a low callback rate. Smaller sizes risk
    // dropouts on mobile Safari; 2048 is the safe floor.
    this.proc = this.ctx.createScriptProcessor(2048, 1, 1);
    src.connect(this.proc);
    // Safari requires the processor to be connected to destination to fire.
    // Route through a zero-gain node so nothing is audible.
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.proc.connect(mute);
    mute.connect(this.ctx.destination);
    this.proc.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      // Block copy (wraps at most once) — no per-sample modulo in the
      // real-time callback.
      const first = Math.min(input.length, this.ring.length - this.ringWrite);
      this.ring.set(input.subarray(0, first), this.ringWrite);
      if (first < input.length) {
        this.ring.set(input.subarray(first), 0);
      }
      this.ringWrite = (this.ringWrite + input.length) % this.ring.length;
      this.ringFilled = Math.min(this.ringFilled + input.length, this.ring.length);
    };
  }

  /** Last `seconds` of raw mono samples from the ring (for on-device scoring).
   *  Returns null until enough audio has been captured.
   *  Allocating variant — prefer samplesInto() in the hot tick loop. */
  samples(seconds: number): Float32Array | null {
    const want = Math.floor(seconds * this.sampleRate);
    if (this.ringFilled < want) return null;
    const out = new Float32Array(want);
    // Two contiguous block copies instead of a per-sample modulo loop —
    // the snapshot wraps the ring boundary at most once.
    const start = (this.ringWrite - want + this.ring.length) % this.ring.length;
    const first = Math.min(want, this.ring.length - start);
    out.set(this.ring.subarray(start, start + first), 0);
    if (first < want) out.set(this.ring.subarray(0, want - first), first);
    return out;
  }

  /** Zero-alloc snapshot: copies the last `seconds` into a reused scratch
   *  buffer and returns a view. The view is only valid until the next call —
   *  the scorer must consume it synchronously (resample/score do).
   *  Returns whatever is buffered when warm (< `seconds` right after Start)
   *  so the first verdict lands in ~0.5 s instead of a full second; the
   *  scorer pads short input to one window. Null only when the ring
   *  is completely empty. */
  samplesInto(seconds: number): Float32Array | null {
    const want = Math.floor(seconds * this.sampleRate);
    const have = Math.min(this.ringFilled, want);
    if (have === 0) return null;
    if (this.scratch.length !== want) this.scratch = new Float32Array(want);
    const start = (this.ringWrite - have + this.ring.length) % this.ring.length;
    const first = Math.min(have, this.ring.length - start);
    this.scratch.set(this.ring.subarray(start, start + first), 0);
    if (first < have) this.scratch.set(this.ring.subarray(0, have - first), first);
    return this.scratch.subarray(0, have);
  }

  /** Snapshot the most recent CLIP_SECONDS from the ring buffer as a 16-bit PCM WAV.
   *  Returns null until a full clip's worth of audio has been captured. */
  clip(): ClipResult | null {
    const want = Math.floor(CLIP_SECONDS * this.sampleRate);
    if (this.ringFilled < want) return null; // don't ship short first clips
    const n = want;
    const out = new Float32Array(n);
    // last n samples ending at ringWrite (wraps at most once)
    const start = (this.ringWrite - n + this.ring.length) % this.ring.length;
    const first = Math.min(n, this.ring.length - start);
    out.set(this.ring.subarray(start, start + first), 0);
    if (first < n) out.set(this.ring.subarray(0, n - first), first);
    return {
      wav: encodeWav(out, this.sampleRate),
      t0: Date.now() / 1000 - n / this.sampleRate,
      sampleRate: this.sampleRate,
      durationS: n / this.sampleRate,
    };
  }

  stop(): void {
    this.proc?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close();
    this.ctx = null;
    this.stream = null;
  }
}

export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  writeStr(36, "data");
  v.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}
