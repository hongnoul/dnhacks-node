# SkyMesh fusion server — ingest slice.
# Receives heartbeats + 2s WAV detection clips from nodes, appends every event
# to events.jsonl, stores clips in clips/. Fusion/CRNN hang off this later.
#
# Run:  uvicorn app:app --host 0.0.0.0 --port 8000
# Watch: tail -f events.jsonl

import json
import math
import time
from collections import deque
from pathlib import Path

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

try:
    from model import score_wav  # CRNN drone classifier (optional heavy dep)
    HAVE_MODEL = True
except Exception as _e:  # torch not installed → ingest still works
    HAVE_MODEL = False
    _model_err = str(_e)

try:
    from tdoa import TdoaClip, multilaterate
    import numpy as _np
    HAVE_TDOA = True
except Exception:
    HAVE_TDOA = False

ROOT = Path(__file__).parent
CLIPS = ROOT / "clips"
CLIPS.mkdir(exist_ok=True)
EVENTS = ROOT / "events.jsonl"

app = FastAPI(title="SkyMesh fusion server")

# Nodes may call us cross-origin (Vercel page → tunnel URL)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def log_event(ev: dict) -> None:
    ev["server_t"] = time.time()
    with EVENTS.open("a") as f:
        f.write(json.dumps(ev) + "\n")


@app.get("/health")
def health():
    return {"ok": True, "t": time.time()}


@app.post("/ingest/heartbeat")
async def ingest_heartbeat(body: dict):
    log_event(body)
    return {"ok": True}


@app.post("/ingest/remoteid")
async def ingest_remoteid(body: dict):
    """RemoteID sidecar (bonus node type): an Android phone running OpenDroneID
    or a laptop + BT dongle POSTs drone ID + broadcast GPS here. Logged as a
    `remoteid` event alongside the acoustic track. Never the critical path:
    sub-250g drones broadcast nothing — that's why acoustic matters."""
    ev = {
        "type": "remoteid",
        "node_id": str(body.get("node_id", "remoteid-1"))[:32],
        "t": body.get("t", time.time()),
        "drone_id": str(body.get("drone_id", "unknown"))[:64],
        "lat": body.get("lat"),
        "lon": body.get("lon"),
        "alt_m": body.get("alt_m"),
        "speed_mps": body.get("speed_mps"),
    }
    log_event(ev)
    return {"ok": True}


@app.post("/ingest/clip")
async def ingest_clip(file: UploadFile = File(...), meta: str = Form(...)):
    ev = json.loads(meta)
    node_id = str(ev.get("node_id", "unknown"))[:16]
    t = ev.get("t", time.time())
    clip_name = f"{node_id}_{t:.3f}.wav"
    clip_path = CLIPS / clip_name
    data = await file.read()
    clip_path.write_bytes(data)
    ev["clip_ref"] = f"/clips/{clip_name}"
    ev["clip_bytes"] = len(data)

    # CRNN verdict: replaces node-side gate confidence for fusion
    if HAVE_MODEL:
        try:
            ev["server_conf"] = round(
                await run_in_threadpool(score_wav, clip_path), 4
            )
        except Exception as e:
            ev["server_conf_error"] = str(e)

    log_event(ev)
    track = fuse(ev)
    if track:
        log_event(track)
    return {
        "ok": True,
        "clip_ref": ev["clip_ref"],
        "bytes": len(data),
        "server_conf": ev.get("server_conf"),
        "track": track,
    }


# ── Fusion: loudness×confidence weighted centroid over a sliding window ──────

FUSE_WINDOW_S = 4.0      # detections within this window fuse into one estimate
CONF_THRESHOLD = 0.35     # CRNN verdict below this → not a drone, don't fuse
recent_detections: deque = deque(maxlen=64)


def fuse(ev: dict):
    """Called per confirmed detection. Returns a track event or None."""
    conf = ev.get("server_conf")
    if conf is None:  # model unavailable → fall back to node loudness gate
        conf = ev.get("loudness", 0)
    if conf < CONF_THRESHOLD or ev.get("lat") is None:
        return None
    recent_detections.append(ev)

    now = time.time()
    window = [
        d for d in recent_detections
        if now - d.get("server_t", d.get("t", 0)) <= FUSE_WINDOW_S
        and d.get("lat") is not None
    ]
    # one detection per node (latest wins)
    by_node = {}
    for d in window:
        by_node[d["node_id"]] = d
    dets = list(by_node.values())
    if not dets:
        return None

    # weight = confidence × loudness (loudness ∝ proximity)
    # × GPS trust: phones reporting ±30m+ indoors get downweighted so one
    # bad fix can't drag the centroid. Pinned anchors (±3m) dominate.
    ws, lats, lons = [], [], []
    for d in dets:
        c = d.get("server_conf") if d.get("server_conf") is not None else d.get("loudness", 0)
        acc = d.get("gps_accuracy_m")
        gps_w = 1.0 if acc is None else max(3.0 / max(float(acc), 3.0), 0.08)
        w = max(c, 1e-3) * max(d.get("loudness", 0.1), 0.05) * gps_w
        ws.append(w)
        lats.append(d["lat"])
        lons.append(d["lon"])
    W = sum(ws)
    lat = sum(w * x for w, x in zip(ws, lats)) / W
    lon = sum(w * x for w, x in zip(ws, lons)) / W

    # Error radius = standard error of the weighted centroid: spread/√n.
    # This is what makes the demo ellipse visibly tighten as nodes join.
    # Floor is the mean GPS accuracy (min 12m): bad phone fixes widen the
    # ellipse honestly instead of pretending TDOA precision we lack.
    if len(dets) >= 2:
        var = sum(
            w * ((111_320 * (la - lat)) ** 2 +
                 (111_320 * math.cos(math.radians(lat)) * (lo - lon)) ** 2)
            for w, la, lo in zip(ws, lats, lons)
        ) / W
        accs = [d.get("gps_accuracy_m") for d in dets if d.get("gps_accuracy_m") is not None]
        gps_floor = max(sum(accs) / len(accs), 12.0) if accs else 12.0
        err_m = max(math.sqrt(var) / math.sqrt(len(dets)), gps_floor)
    else:
        err_m = 150.0

    return {
        "type": "track",
        "t": now,
        "lat": round(lat, 6),
        "lon": round(lon, 6),
        "err_m": round(err_m, 1),
        "n_nodes": len(dets),
        "confidence": round(max(
            (d.get("server_conf") or d.get("loudness", 0)) for d in dets
        ), 3),
        **_tdoa_refine(dets, lat, lon),
    }


def _tdoa_refine(dets: list, seed_lat: float, seed_lon: float) -> dict:
    """Stretch goal: with >=4 concurrent confirmed clips, GCC-PHAT
    multilateration refines the centroid. Returns extra track fields."""
    if not HAVE_TDOA or len(dets) < 4:
        return {}
    try:
        import wave as wave_mod

        clips = []
        for d in dets:
            ref = d.get("clip_ref")
            if not ref:
                continue
            path = CLIPS / ref.split("/")[-1]
            if not path.exists():
                continue
            with wave_mod.open(str(path), "rb") as w:
                rate = w.getframerate()
                raw = w.readframes(w.getnframes())
            samples = _np.frombuffer(raw, dtype=_np.int16).astype(_np.float32) / 32768.0
            clips.append(TdoaClip(
                node_id=d["node_id"], lat=d["lat"], lon=d["lon"],
                t0=d.get("t", 0.0), samples=samples, rate=rate,
            ))
        if len(clips) < 4 or len({c.rate for c in clips}) != 1:
            return {}
        r = multilaterate(clips, seed_lat, seed_lon)
        if r is None:
            return {}
        return {"tdoa": r}
    except Exception:
        return {}


@app.get("/events")
def get_events(limit: int = 100):
    """Last N events — quick debugging view."""
    if not EVENTS.exists():
        return JSONResponse([])
    lines = EVENTS.read_text().strip().splitlines()[-limit:]
    return JSONResponse([json.loads(l) for l in lines])


@app.get("/nodes")
def get_nodes():
    """Latest heartbeat per node — who is alive."""
    nodes = {}
    if EVENTS.exists():
        for line in EVENTS.read_text().strip().splitlines():
            ev = json.loads(line)
            if ev.get("type") == "heartbeat":
                nodes[ev.get("node_id")] = ev
    now = time.time()
    return {
        nid: {**ev, "age_s": round(now - ev.get("server_t", now), 1)}
        for nid, ev in nodes.items()
    }



# ── Replay: demo insurance ───────────────────────────────────────────────────
# POST /replay/save?session=demo1   snapshot current events.jsonl
# POST /replay/start?session=demo1&speed=2   re-emit into the live log with
#   original relative timing (rebased to now).
# GET  /replay/sessions              list saved snapshots

SESSIONS = ROOT / "sessions"
SESSIONS.mkdir(exist_ok=True)
_replay_state = {"running": False, "session": None, "progress": 0}


@app.post("/replay/save")
def replay_save(session: str = "demo1"):
    if not EVENTS.exists():
        return JSONResponse({"ok": False, "error": "no events yet"}, status_code=400)
    dst = SESSIONS / f"{session}.jsonl"
    dst.write_text(EVENTS.read_text())
    n = len(dst.read_text().strip().splitlines())
    return {"ok": True, "session": session, "events": n}


@app.get("/replay/sessions")
def replay_sessions():
    return {
        p.stem: len(p.read_text().strip().splitlines())
        for p in SESSIONS.glob("*.jsonl")
    }


@app.post("/replay/start")
async def replay_start(session: str = "demo1", speed: float = 1.0):
    import asyncio

    src = SESSIONS / f"{session}.jsonl"
    if not src.exists():
        return JSONResponse({"ok": False, "error": f"no session {session}"}, status_code=404)
    if _replay_state["running"]:
        return JSONResponse({"ok": False, "error": "replay already running"}, status_code=409)

    events = [json.loads(l) for l in src.read_text().strip().splitlines()]
    if not events:
        return JSONResponse({"ok": False, "error": "empty session"}, status_code=400)

    async def run():
        _replay_state.update(running=True, session=session, progress=0)
        try:
            t_base = events[0].get("server_t", 0)
            start = time.time()
            for i, ev in enumerate(events):
                delay = (ev.get("server_t", t_base) - t_base) / max(speed, 0.1)
                sleep_for = start + delay - time.time()
                if sleep_for > 0:
                    await asyncio.sleep(sleep_for)
                ev = dict(ev)
                ev["replayed"] = True
                # rebase timestamps so consumers' freshness windows accept them
                ev["server_t"] = time.time()
                if "t" in ev:
                    ev["t"] = time.time()
                with EVENTS.open("a") as f:
                    f.write(json.dumps(ev) + "\n")
                _replay_state["progress"] = i + 1
        finally:
            _replay_state["running"] = False

    asyncio.get_event_loop().create_task(run())
    return {"ok": True, "session": session, "events": len(events), "speed": speed}


@app.get("/replay/status")
def replay_status():
    return _replay_state


# Serve stored clips so you can listen to them in a browser
app.mount("/clips", StaticFiles(directory=CLIPS), name="clips")
