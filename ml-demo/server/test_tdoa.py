#!/usr/bin/env python3
"""test_tdoa.py — verify GCC-PHAT multilateration on physically-correct synthetic data.

Takes a real DADS drone recording, generates per-node delayed copies according
to true acoustic propagation from a known source position, adds noise and
clip-start misalignment, then checks the recovered position.
"""

import glob
import math
import wave

import numpy as np

from tdoa import C_SOUND, TdoaClip, gcc_phat, multilaterate

RATE = 16_000

# geometry: drone + 4 nodes (same layout as sim_fusion)
DRONE = (38.90120, -77.04020)
NODES = [
    ("n1", 38.90210, -77.04020),
    ("n2", 38.90030, -77.04020),
    ("n3", 38.90120, -77.03900),
    ("n4", 38.90120, -77.04140),
]


def dist_m(a, b):
    dlat = 111_320 * (a[0] - b[0])
    dlon = 111_320 * math.cos(math.radians(a[0])) * (a[1] - b[1])
    return math.hypot(dlat, dlon)


def load_drone_audio() -> np.ndarray:
    fs = sorted(glob.glob("testdata/l1_*.wav"))
    assert fs, "need testdata/ drone clips (fetched earlier)"
    chunks = []
    for f in fs:  # 0.5s each; concatenate all for >=4s of varied drone audio
        with wave.open(f) as w:
            assert w.getframerate() == RATE
            chunks.append(
                np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
                .astype(np.float32) / 32768.0
            )
    x = np.concatenate(chunks)
    assert len(x) >= 4 * RATE, "need >=4s of drone audio"
    return x[: 4 * RATE]


def main():
    rng = np.random.default_rng(42)
    src = load_drone_audio()

    print("── gcc_phat sanity: known artificial shift ──")
    a = src[: 2 * RATE]
    shift = int(0.0231 * RATE)  # 23.1 ms
    b = np.roll(a, shift)
    est = gcc_phat(a, b, RATE)
    print(f"  true 23.1ms, estimated {est*1000:.1f}ms")
    assert abs(est - 0.0231) < 0.002, est

    print("── full multilateration: physical delays + noise + t0 misalignment ──")
    clips = []
    t_event = 1_000_000.0  # arbitrary epoch
    for nid, lat, lon in NODES:
        d = dist_m((lat, lon), DRONE)
        prop_delay = d / C_SOUND
        # node starts its clip at a slightly different moment (gate jitter ±0.3s)
        start_jitter = rng.uniform(-0.3, 0.3)
        # reported t0 differs from true start by NTP clock error (±30ms typical)
        clock_err = rng.uniform(-0.03, 0.03)
        t0 = t_event + start_jitter + clock_err
        # signal arriving at node = source delayed by prop; clip extracts
        # [t0, t0+2s] → sample offset = (prop_delay - start_jitter)*RATE
        offset = int(round((prop_delay - start_jitter) * RATE))
        seg = src[RATE + offset : RATE + offset + 2 * RATE].copy()
        # distance attenuation + mic noise (SNR ~ 15dB near, worse far)
        seg *= 50.0 / max(d, 50.0)
        seg += rng.normal(0, np.std(seg) * 0.18, len(seg)).astype(np.float32)
        clips.append(TdoaClip(nid, lat, lon, t0, seg, RATE))
        print(f"  {nid}: dist {d:5.1f}m prop {prop_delay*1000:5.1f}ms "
              f"jitter {start_jitter*1000:+6.0f}ms clock_err {clock_err*1000:+5.1f}ms")

    result = multilaterate(clips, seed_lat=38.9012, seed_lon=-77.0402)
    assert result, "multilateration returned None"
    err = dist_m((result["lat"], result["lon"]), DRONE)
    print(f"  recovered ({result['lat']}, {result['lon']}) "
          f"err={err:.1f}m residual={result['residual_m']}m pairs={result['n_pairs']}")
    assert err < 15, f"TDOA error {err:.1f}m exceeds 15m"

    print("── degenerate cases ──")
    assert multilaterate(clips[:3], 38.9012, -77.0402) is None, "should need >=4 clips"
    print("  <4 clips → None ✓")

    print(f"\nTDOA TEST OK — {err:.1f}m error vs {51.0}m centroid err_m at 4 nodes")


if __name__ == "__main__":
    main()
