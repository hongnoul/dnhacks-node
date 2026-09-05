#!/usr/bin/env python3
"""Fake node — e2e pipe test without any phone.

Sends heartbeats + one synthetic 2s WAV clip (150 Hz + harmonics, drone-ish)
to the server, then verifies the clip landed and is byte-identical.

Usage: python fake_node.py [server_url]   (default http://localhost:8000)
"""

import io
import json
import math
import struct
import sys
import time
import urllib.request

SERVER = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000").rstrip("/")
NODE_ID = "fake01"
LAT, LON = 38.9001, -77.0402


def make_wav(seconds=2.0, rate=16000):
    n = int(seconds * rate)
    samples = []
    for i in range(n):
        t = i / rate
        # propeller-ish harmonic stack at 150 Hz
        s = sum(math.sin(2 * math.pi * 150 * h * t) / h for h in range(1, 6)) * 0.2
        samples.append(int(max(-1, min(1, s)) * 32767))
    body = struct.pack(f"<{n}h", *samples)
    hdr = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF", 36 + len(body), b"WAVE", b"fmt ", 16, 1, 1,
        rate, rate * 2, 2, 16, b"data", len(body),
    )
    return hdr + body


def post_json(path, obj):
    req = urllib.request.Request(
        SERVER + path,
        data=json.dumps(obj).encode(),
        headers={"Content-Type": "application/json"},
    )
    return json.load(urllib.request.urlopen(req, timeout=10))


def post_clip(path, wav_bytes, meta):
    boundary = "x" + str(int(time.time() * 1000))
    parts = []
    parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"meta\"\r\n\r\n{json.dumps(meta)}\r\n".encode())
    parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"clip.wav\"\r\nContent-Type: audio/wav\r\n\r\n".encode())
    parts.append(wav_bytes)
    parts.append(f"\r\n--{boundary}--\r\n".encode())
    body = b"".join(parts)
    req = urllib.request.Request(
        SERVER + path, data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    return json.load(urllib.request.urlopen(req, timeout=30))


def main():
    print(f"→ health check {SERVER}")
    print(" ", json.load(urllib.request.urlopen(SERVER + "/health", timeout=10)))

    print("→ 3 heartbeats")
    for _ in range(3):
        r = post_json("/ingest/heartbeat", {
            "type": "heartbeat", "node_id": NODE_ID, "t": time.time(),
            "lat": LAT, "lon": LON, "loudness": 0.12,
        })
        assert r["ok"], r
        time.sleep(0.3)
    print("  ok")

    print("→ detection clip (2s synthetic drone hum)")
    wav = make_wav()
    r = post_clip("/ingest/clip", wav, {
        "type": "detection", "node_id": NODE_ID, "t": time.time(),
        "sample_rate": 16000, "duration_s": 2.0, "loudness": 0.83,
        "lat": LAT, "lon": LON,
    })
    assert r["ok"], r
    print(f"  stored {r['clip_ref']} ({r['bytes']} bytes)")

    print("→ verify round-trip: download clip, compare bytes")
    got = urllib.request.urlopen(SERVER + r["clip_ref"], timeout=10).read()
    assert got == wav, f"clip corrupted: sent {len(wav)}B got {len(got)}B"
    print("  byte-identical ✓")

    print("→ /nodes")
    nodes = json.load(urllib.request.urlopen(SERVER + "/nodes", timeout=10))
    assert NODE_ID in nodes, nodes
    print(f"  {NODE_ID} alive, age {nodes[NODE_ID]['age_s']}s ✓")

    print("\nE2E PIPE OK")


if __name__ == "__main__":
    main()
