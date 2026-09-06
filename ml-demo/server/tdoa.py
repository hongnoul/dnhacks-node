# tdoa.py — GCC-PHAT time-difference-of-arrival + least-squares multilateration.
#
# Given >=4 near-concurrent clips of the same drone from GPS-known nodes,
# estimate the source position more precisely than the loudness centroid.
#
# Method:
#   1. GCC-PHAT cross-correlation of each clip pair → inter-node delay (s).
#      PHAT whitening makes the correlation robust to the drone's broadband hum.
#   2. Each delay d_ij constrains: |x - p_i| - |x - p_j| = c * d_ij (hyperbola).
#   3. Gauss-Newton least squares over all pairs, seeded at the centroid.
#
# Realism notes:
#   - Node clocks are NOT synchronized; we rely on clip *content* alignment,
#     which works when clips overlap in time (the gate fires on the same event
#     within ~1s across nodes). Absolute clip-start offsets shift all delays
#     for a pair equally, so we compensate using the recorded t0 difference
#     (coarse, ±0.5s) and cap the GCC search window to ±max_delay.
#   - Phone GPS is ±10-20m, which bounds achievable accuracy regardless of
#     timing precision.

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

C_SOUND = 343.0  # m/s


@dataclass
class TdoaClip:
    node_id: str
    lat: float
    lon: float
    t0: float          # clip start, epoch seconds (coarse)
    samples: np.ndarray  # float32 mono
    rate: int


def _to_xy(lat: float, lon: float, lat0: float, lon0: float) -> tuple[float, float]:
    """Local flat-earth meters relative to (lat0, lon0)."""
    return (
        111_320.0 * math.cos(math.radians(lat0)) * (lon - lon0),
        111_320.0 * (lat - lat0),
    )


def _to_latlon(x: float, y: float, lat0: float, lon0: float) -> tuple[float, float]:
    return (
        lat0 + y / 111_320.0,
        lon0 + x / (111_320.0 * math.cos(math.radians(lat0))),
    )


def gcc_phat(a: np.ndarray, b: np.ndarray, rate: int, max_delay_s: float = 1.5) -> float:
    """Delay of b relative to a in seconds (positive = b lags a)."""
    n = int(2 ** np.ceil(np.log2(len(a) + len(b))))
    A = np.fft.rfft(a, n)
    B = np.fft.rfft(b, n)
    R = np.conj(A) * B  # peak at +lag when b lags a
    R /= np.abs(R) + 1e-12  # PHAT whitening
    cc = np.fft.irfft(R, n)
    max_shift = min(int(max_delay_s * rate), n // 2 - 1)
    cc = np.concatenate((cc[-max_shift:], cc[: max_shift + 1]))
    return float(np.argmax(np.abs(cc)) - max_shift) / rate


def multilaterate(clips: list[TdoaClip], seed_lat: float, seed_lon: float,
                  iterations: int = 25) -> dict | None:
    """Least-squares position from pairwise GCC-PHAT delays. Returns dict or None."""
    if len(clips) < 4:
        return None
    rate = clips[0].rate
    if any(c.rate != rate for c in clips):
        # resample not handled here; caller normalizes
        return None

    lat0, lon0 = seed_lat, seed_lon
    pos = {c.node_id: _to_xy(c.lat, c.lon, lat0, lon0) for c in clips}

    # pairwise measured TDOA, compensating coarse clip-start offsets
    pairs = []
    for i in range(len(clips)):
        for j in range(i + 1, len(clips)):
            ci, cj = clips[i], clips[j]
            nmin = min(len(ci.samples), len(cj.samples))
            if nmin < rate // 2:
                continue
            d_content = gcc_phat(ci.samples[:nmin], cj.samples[:nmin], rate)
            # content delay includes clip-start misalignment: true acoustic
            # delay = content delay + (t0_i - t0_j)
            d = d_content + (ci.t0 - cj.t0)
            # sanity: acoustic delay can't exceed inter-node distance / c
            xi, yi = pos[ci.node_id]
            xj, yj = pos[cj.node_id]
            d_max = math.hypot(xi - xj, yi - yj) / C_SOUND + 0.05
            if abs(d) > d_max:
                continue
            pairs.append((ci.node_id, cj.node_id, d))
    if len(pairs) < 3:
        return None

    # Gauss-Newton from the seed (centroid)
    x, y = 0.0, 0.0
    for _ in range(iterations):
        J, r = [], []
        for ni, nj, d in pairs:
            xi, yi = pos[ni]
            xj, yj = pos[nj]
            ri = math.hypot(x - xi, y - yi) + 1e-6
            rj = math.hypot(x - xj, y - yj) + 1e-6
            pred = (ri - rj) / C_SOUND
            r.append(d - pred)
            J.append([
                ((x - xi) / ri - (x - xj) / rj) / C_SOUND,
                ((y - yi) / ri - (y - yj) / rj) / C_SOUND,
            ])
        J = np.array(J)
        r = np.array(r)
        try:
            step, *_ = np.linalg.lstsq(J, r, rcond=None)
        except np.linalg.LinAlgError:
            return None
        x += step[0]
        y += step[1]
        if np.hypot(*step) < 0.5:
            break

    residual = float(np.sqrt(np.mean(r ** 2))) * C_SOUND  # meters
    lat, lon = _to_latlon(x, y, lat0, lon0)
    return {
        "lat": round(lat, 6),
        "lon": round(lon, 6),
        "residual_m": round(residual, 1),
        "n_pairs": len(pairs),
    }
