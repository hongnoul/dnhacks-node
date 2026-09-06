// audio.ts — mic capture, loudness gate, 2s WAV clip encoding.
// iOS Safari notes:
//  - getUserMedia requires HTTPS and a user gesture.
//  - Actual sample rate is whatever the hardware gives (typically 48 kHz); we report it, server resamples.
//  - Disable voice processing or iOS mangles drone audio.

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
  private analyser: AnalyserNode | null = null;
  private proc: ScriptProcessorNode | null = null;
  private ring: Float32Array<ArrayBuffer> = new Float32Array(0);
  private ringWrite = 0;
  private ringFilled = 0;
  private freqBuf: Float32Array<ArrayBuffer> = new Float32Array(0);
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
    this.ctx = new AudioContext();
    // iOS starts AudioContext suspended until a gesture-driven resume
    if (this.ctx.state === "suspended") await this.ctx.resume();
    this.sampleRate = this.ctx.sampleRate;
    this.ring = new Float32Array(Math.ceil(RING_SECONDS * this.sampleRate));

    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.freqBuf = new Float32Array(this.analyser.frequencyBinCount);
    src.connect(this.analyser);

    // ScriptProcessor is deprecated but still the most reliable cross-Safari way
    // to get raw samples without an AudioWorklet module fetch (which needs same-origin HTTPS anyway).
    this.proc = this.ctx.createScriptProcessor(4096, 1, 1);
    src.connect(this.proc);
    // Safari requires the processor to be connected to destination to fire.
    // Route through a zero-gain node so nothing is audible.
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.proc.connect(mute);
    mute.connect(this.ctx.destination);
    this.proc.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      for (let i = 0; i < input.length; i++) {
        this.ring[this.ringWrite] = input[i];
        this.ringWrite = (this.ringWrite + 1) % this.ring.length;
      }
      this.ringFilled = Math.min(this.ringFilled + input.length, this.ring.length);
    };
  }

  /** Current loudness metrics from the analyser (cheap, call at ~4 Hz). */
  frame(): AudioFrame {
    if (!this.analyser || !this.ctx) return { loudness: 0, bandLoudness: 0, peakiness: 0 };
    this.analyser.getFloatFrequencyData(this.freqBuf);
    const nyquist = this.ctx.sampleRate / 2;
    const binHz = nyquist / this.freqBuf.length;
    let total = 0;
    let band = 0;
    let bandCount = 0;
    let bandMax = 0;
    for (let i = 0; i < this.freqBuf.length; i++) {
      // dB (-Infinity..0) → linear power
      const p = Math.pow(10, this.freqBuf[i] / 10);
      total += p;
      const hz = i * binHz;
      if (hz >= 80 && hz <= 2000) {
        band += p;
        bandCount++;
        if (p > bandMax) bandMax = p;
      }
    }
    const loudness = Math.min(1, Math.sqrt(total / this.freqBuf.length) * 30);
    const bandLoudness = bandCount ? Math.min(1, Math.sqrt(band / bandCount) * 30) : 0;
    const peakiness = bandCount && band > 0 ? bandMax / (band / bandCount) : 0;
    return { loudness, bandLoudness, peakiness };
  }

  /** Last `seconds` of raw mono samples from the ring (for on-device scoring).
   *  Returns null until enough audio has been captured. */
  samples(seconds: number): Float32Array | null {
    const want = Math.floor(seconds * this.sampleRate);
    if (this.ringFilled < want) return null;
    const out = new Float32Array(want);
    let idx = (this.ringWrite - want + this.ring.length) % this.ring.length;
    for (let i = 0; i < want; i++) {
      out[i] = this.ring[idx];
      idx = (idx + 1) % this.ring.length;
    }
    return out;
  }

  /** Snapshot the most recent CLIP_SECONDS from the ring buffer as a 16-bit PCM WAV.
   *  Returns null until a full clip's worth of audio has been captured. */
  clip(): ClipResult | null {
    const want = Math.floor(CLIP_SECONDS * this.sampleRate);
    if (this.ringFilled < want) return null; // don't ship short first clips
    const n = want;
    const out = new Float32Array(n);
    // last n samples ending at ringWrite
    let idx = (this.ringWrite - n + this.ring.length) % this.ring.length;
    for (let i = 0; i < n; i++) {
      out[i] = this.ring[idx];
      idx = (idx + 1) % this.ring.length;
    }
    return {
      wav: encodeWav(out, this.sampleRate),
      t0: Date.now() / 1000 - n / this.sampleRate,
      sampleRate: this.sampleRate,
      durationS: n / this.sampleRate,
    };
  }

  stop(): void {
    this.proc?.disconnect();
    this.analyser?.disconnect();
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
