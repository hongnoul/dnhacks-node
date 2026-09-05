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
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

try:
    from model import score_wav  # CRNN drone classifier (optional heavy dep)
    HAVE_MODEL = True
except Exception as _e:  # torch not installed → ingest still works
    HAVE_MODEL = False
    _model_err = str(_e)

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
CONF_THRESHOLD = 0.5     # CRNN verdict below this → not a drone, don't fuse
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
    ws, lats, lons = [], [], []
    for d in dets:
        c = d.get("server_conf") if d.get("server_conf") is not None else d.get("loudness", 0)
        w = max(c, 1e-3) * max(d.get("loudness", 0.1), 0.05)
        ws.append(w)
        lats.append(d["lat"])
        lons.append(d["lon"])
    W = sum(ws)
    lat = sum(w * x for w, x in zip(ws, lats)) / W
    lon = sum(w * x for w, x in zip(ws, lons)) / W

    # crude error radius: weighted std of node offsets (meters), floored by
    # single-node case at 150m (audible range, no geometry)
    if len(dets) >= 2:
        var = sum(
            w * ((111_320 * (la - lat)) ** 2 +
                 (111_320 * math.cos(math.radians(lat)) * (lo - lon)) ** 2)
            for w, la, lo in zip(ws, lats, lons)
        ) / W
        err_m = max(math.sqrt(var), 15.0)
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
    }


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


@app.get("/state")
def get_state():
    """Everything the map needs in one poll: live nodes, latest track, recent alerts."""
    now = time.time()
    nodes, tracks, alerts = {}, [], []
    if EVENTS.exists():
        for line in EVENTS.read_text().strip().splitlines():
            ev = json.loads(line)
            typ = ev.get("type")
            if typ == "heartbeat":
                nodes[ev.get("node_id")] = ev
            elif typ == "track":
                tracks.append(ev)
            elif typ == "detection":
                alerts.append(ev)
    live_nodes = {
        nid: {
            "lat": ev.get("lat"), "lon": ev.get("lon"),
            "loudness": ev.get("loudness", 0),
            "age_s": round(now - ev.get("server_t", now), 1),
        }
        for nid, ev in nodes.items()
        if ev.get("lat") is not None and now - ev.get("server_t", 0) < 30
    }
    return {
        "t": now,
        "nodes": live_nodes,
        "track": tracks[-1] if tracks and now - tracks[-1]["t"] < 15 else None,
        "track_history": tracks[-50:],
        "alerts": [
            {
                "node_id": a.get("node_id"), "t": a.get("server_t"),
                "server_conf": a.get("server_conf"), "loudness": a.get("loudness"),
                "clip_ref": a.get("clip_ref"),
            }
            for a in alerts[-12:]
        ][::-1],
        "model_loaded": HAVE_MODEL,
    }


@app.get("/map")
def map_page():
    return FileResponse(ROOT / "map.html")


# ── Replay: demo insurance ───────────────────────────────────────────────────
# POST /replay/save?session=demo1   snapshot current events.jsonl
# POST /replay/start?session=demo1&speed=2   re-emit into the live log with
#   original relative timing (rebased to now), so the map animates it again.
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
                # rebase timestamps so the map's freshness windows accept them
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
