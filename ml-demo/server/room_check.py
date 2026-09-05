#!/usr/bin/env python3
"""room_check.py — prove room playback level loss with real measurements.

Records from the MacBook mic while drone-demo.wav plays through the speakers
(simulates the iPhone position), then scores:
  1. the original file (expect ~1.0)
  2. the room recording (expect low if level loss is real)
  3. the room recording peak-normalized (expect recovery if fix works)
  4. attenuated file copies (-10/-20/-30 dB) for the level curve

Usage:
  .venv/bin/python room_check.py            # score file + attenuation curve only
  .venv/bin/python room_check.py --record   # also record room via mic (needs ffmpeg)

Room recording: place mic where the phone was, play ../public/drone-demo.wav
at max volume during the 12s capture.
"""
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
FILE_WAV = HERE.parent / "public" / "drone-demo.wav"

try:
    from model import score_wav
except ImportError:
    sys.exit("run from server/ with .venv active")


def read_wav(path):
    with wave.open(str(path), "rb") as w:
        params, sr, n = w.getparams(), w.getframerate(), w.getnframes()
        raw = w.readframes(n)
    s = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if w.getnchannels() > 1 if hasattr(w, "getnchannels") else params.nchannels > 1:
        s = s.reshape(-1, params.nchannels).mean(1)
    return s, sr, params


def write_wav(path, s, sr):
    s = np.clip(s, -1, 1)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((s * 32767).astype(np.int16).tobytes())


def rms_db(s):
    return 20 * np.log10(float(np.sqrt((s ** 2).mean())) + 1e-12)


def peak_norm(s, peak=0.9):
    m = float(np.abs(s).max())
    return s * (peak / m) if m > 1e-6 else s


def record_room(dur_s=12, out="room_capture.wav"):
    print(f"→ recording {dur_s}s from default mic — PLAY drone-demo.wav NOW at max volume")
    r = subprocess.run(
        ["ffmpeg", "-y", "-f", "avfoundation", "-i", ":0",
         "-t", str(dur_s), "-ar", "48000", "-ac", "1", out],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        print("ffmpeg failed. List devices with: ffmpeg -f avfoundation -list_devices true -i ''")
        print(r.stderr[-2000:])
        sys.exit(1)
    print(f"  saved {out}")
    return out


def main():
    do_record = "--record" in sys.argv
    s_file, sr_file, _ = read_wav(FILE_WAV)
    print(f"file: rms {rms_db(s_file):.1f} dBFS, peak {np.abs(s_file).max():.3f}")
    print(f"  score(file) = {score_wav(FILE_WAV):.4f}")

    print("\nlevel curve (attenuated file copies):")
    with tempfile.TemporaryDirectory() as td:
        for db in [0, -10, -20, -30, -40]:
            g = 10 ** (db / 20)
            p = Path(td) / f"att{db}.wav"
            write_wav(p, s_file * g, sr_file)
            print(f"  {db:4d} dB -> {score_wav(p):.4f}")

    if not do_record:
        print("\n(run with --record to capture live room audio)")
        return

    room = record_room(out=str(HERE / "room_capture.wav"))
    s_room, sr_room, _ = read_wav(room)
    print(f"room: rms {rms_db(s_room):.1f} dBFS, peak {np.abs(s_room).max():.3f}")
    print(f"  delta vs file: {rms_db(s_room) - rms_db(s_file):+.1f} dB")
    print(f"  score(room) = {score_wav(room):.4f}")

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        norm_path = f.name
    write_wav(norm_path, peak_norm(s_room), sr_room)
    print(f"  score(room peak-normalized) = {score_wav(norm_path):.4f}")
    Path(norm_path).unlink()


if __name__ == "__main__":
    main()
