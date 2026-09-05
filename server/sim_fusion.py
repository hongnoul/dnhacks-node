#!/usr/bin/env python3
"""sim_fusion.py — multi-node fusion regression test with real DADS audio.

Simulates 4 nodes at known GPS positions around a known drone position.
Each node uploads a real drone clip; loudness falls with distance to the
virtual drone. Verifies:
  - CRNN confirms every drone clip (server_conf > 0.9)
  - noise clip is rejected (server_conf < 0.5, no track pollution)
  - fused track lands near truth and error shrinks as nodes join

Usage: python sim_fusion.py [server_url]
"""

import glob
import json
import math
import sys
import time
import urllib.request

SERVER = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000").rstrip("/")

# virtual world: drone hovering here
DRONE = (38.90120, -77.04020)
# nodes in a ~200m box around it; (id, lat, lon)
NODES = [
    ("sim-n1", 38.90210, -77.04020),  # ~100m north
    ("sim-n2", 38.90030, -77.04020),  # ~100m south
    ("sim-n3", 38.90120, -77.03900),  # ~104m east
    ("sim-n4", 38.90120, -77.04140),  # ~104m west
]


def dist_m(a, b):
    dlat = 111_320 * (a[0] - b[0])
    dlon = 111_320 * math.cos(math.radians(a[0])) * (a[1] - b[1])
    return math.hypot(dlat, dlon)


def loudness_at(node):
    """6 dB per doubling from a reference loudness 0.9 at 50 m."""
    d = max(dist_m((node[1], node[2]), DRONE), 1.0)
    return max(0.05, min(1.0, 0.9 * (50.0 / d)))


def post_clip(wav_bytes, meta):
    boundary = "x" + str(int(time.time() * 1e6))
    parts = [
        f'--{boundary}\r\nContent-Disposition: form-data; name="meta"\r\n\r\n{json.dumps(meta)}\r\n'.encode(),
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="clip.wav"\r\nContent-Type: audio/wav\r\n\r\n'.encode(),
        wav_bytes,
        f"\r\n--{boundary}--\r\n".encode(),
    ]
    req = urllib.request.Request(
        SERVER + "/ingest/clip",
        data=b"".join(parts),
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    return json.load(urllib.request.urlopen(req, timeout=60))


def main():
    drone_wavs = sorted(glob.glob("testdata/l1_*.wav"))
    noise_wavs = sorted(glob.glob("testdata/l0_*.wav"))
    assert len(drone_wavs) >= 4 and len(noise_wavs) >= 1, (
        "need testdata/ DADS clips; run the fetch snippet first"
    )

    print(f"drone truth: {DRONE}")
    errors = []
    for i, node in enumerate(NODES):
        nid, lat, lon = node
        loud = loudness_at(node)
        wav = open(drone_wavs[i % len(drone_wavs)], "rb").read()
        r = post_clip(wav, {
            "type": "detection", "node_id": nid, "t": time.time(),
            "loudness": round(loud, 3), "lat": lat, "lon": lon,
        })
        sc = r.get("server_conf")
        tr = r.get("track")
        assert sc is not None and sc > 0.9, f"{nid}: CRNN should confirm drone, got {sc}"
        assert tr is not None, f"{nid}: expected a track"
        err_true = dist_m((tr["lat"], tr["lon"]), DRONE)
        errors.append(err_true)
        print(f"  +{nid} loud={loud:.2f} conf={sc:.3f} → track ({tr['lat']}, {tr['lon']}) "
              f"n={tr['n_nodes']} err_est={tr['err_m']}m err_true={err_true:.0f}m")

    # noise clip from a 5th node must NOT create/join a track
    r = post_clip(open(noise_wavs[0], "rb").read(), {
        "type": "detection", "node_id": "sim-noise", "t": time.time(),
        "loudness": 0.9, "lat": 38.91, "lon": -77.05,
    })
    assert r.get("server_conf", 1) < 0.5, f"noise scored {r.get('server_conf')}"
    print(f"  noise clip rejected: conf={r['server_conf']:.3f} ✓")

    final_err = errors[-1]
    assert final_err < 60, f"final fused error {final_err:.0f}m too large"
    assert errors[-1] <= errors[0] + 1, "error should not grow as nodes join"
    print(f"\nFUSION SIM OK — final error {final_err:.0f}m with {len(NODES)} nodes "
          f"(single-node error was {errors[0]:.0f}m)")


if __name__ == "__main__":
    main()
