# SkyMesh fusion server — ingest slice.
# Receives heartbeats + 2s WAV detection clips from nodes, appends every event
# to events.jsonl, stores clips in clips/. Fusion/CRNN hang off this later.
#
# Run:  uvicorn app:app --host 0.0.0.0 --port 8000
# Watch: tail -f events.jsonl

import json
import time
from pathlib import Path

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

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
    log_event(ev)
    # TODO: score with CRNN here → ev["server_conf"], then feed fusion
    return {"ok": True, "clip_ref": ev["clip_ref"], "bytes": len(data)}


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


# Serve stored clips so you can listen to them in a browser
app.mount("/clips", StaticFiles(directory=CLIPS), name="clips")
