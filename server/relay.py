# SkyMesh mesh relay — emulates the radio links between nodes.
#
# This is NOT a fusion server. It holds no picture, and it never opens a gossip
# payload: it checks whether two nodes are adjacent, applies simulated latency
# and loss, and forwards opaque bytes. Every node keeps its own replica and
# computes its own estimate. See ARCHITECTURE.md §4.
#
# Two channels share one socket (§3 of IMPLEMENTATION.md):
#   {"ctrl": ...}                 relay's own control plane — the relay parses this
#   {"to": "n03", "payload": ...} routed blind — the relay must never parse this
#
# Run:  uvicorn relay:app --host 0.0.0.0 --port 8001

import asyncio
import json
import math
import random
import time
import uuid
from dataclasses import dataclass, field
from typing import Optional

from pathlib import Path

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

app = FastAPI(title="SkyMesh mesh relay")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

DEFAULT_LATENCY_MS = 50
DEFAULT_LOSS = 0.0
SIMULATION_TTL_MS = 120_000
SIMULATION_HISTORY_LIMIT = 40


@dataclass
class LinkState:
    up: bool = True
    latency_ms: int = DEFAULT_LATENCY_MS
    loss: float = DEFAULT_LOSS


@dataclass
class Node:
    node_id: str
    ws: WebSocket
    admitted: bool = False


@dataclass
class Session:
    session_id: str
    nodes: dict[str, Node] = field(default_factory=dict)
    admins: set[WebSocket] = field(default_factory=set)
    topology: dict[str, list[str]] = field(default_factory=dict)
    links: dict[tuple[str, str], LinkState] = field(default_factory=dict)
    counter: int = 0
    # Ephemeral demo notices, never gossip records or fusion evidence.
    simulation_alerts: list[dict] = field(default_factory=list)

    def next_id(self) -> str:
        self.counter += 1
        return f"n{self.counter:02d}"

    def link(self, a: str, b: str) -> LinkState:
        # Links are undirected: key on the sorted pair so both directions share state.
        key = (a, b) if a < b else (b, a)
        if key not in self.links:
            self.links[key] = LinkState()
        return self.links[key]

    def adjacent(self, a: str, b: str) -> bool:
        return b in self.topology.get(a, [])

    def neighbours(self, node_id: str) -> list[str]:
        return list(self.topology.get(node_id, []))

    def snapshot(self) -> dict:
        return {
            "session": self.session_id,
            "nodes": [
                {"node": n.node_id, "admitted": n.admitted}
                for n in self.nodes.values()
            ],
            "topology": self.topology,
            "links": [
                {"a": a, "b": b, "up": s.up, "latency_ms": s.latency_ms, "loss": s.loss}
                for (a, b), s in self.links.items()
            ],
        }


SESSIONS: dict[str, Session] = {}


def get_session(session_id: str) -> Session:
    if session_id not in SESSIONS:
        SESSIONS[session_id] = Session(session_id=session_id)
    return SESSIONS[session_id]


async def send_json(ws: WebSocket, obj: dict) -> None:
    try:
        await ws.send_text(json.dumps(obj))
    except Exception:
        pass  # peer vanished mid-send; the disconnect handler will clean up


async def notify_admins(sess: Session, obj: dict) -> None:
    for ws in list(sess.admins):
        await send_json(ws, obj)


async def push_state(sess: Session) -> None:
    await notify_admins(sess, {"ctrl": "state", **sess.snapshot()})


async def push_neighbours(sess: Session, node_id: str) -> None:
    node = sess.nodes.get(node_id)
    if node and node.admitted:
        await send_json(
            node.ws, {"ctrl": "neighbours", "neighbours": sess.neighbours(node_id)}
        )


def recent_simulations(sess: Session) -> list[dict]:
    now = int(time.time() * 1000)
    sess.simulation_alerts = [a for a in sess.simulation_alerts if a["expiresAt"] > now][-SIMULATION_HISTORY_LIMIT:]
    return sess.simulation_alerts


def simulation_notice(value) -> Optional[dict]:
    """Whitelist demo metadata. Sender cannot set IDs, recipients or ACKs."""
    if not isinstance(value, dict):
        return None
    if value.get("kind") not in ("impact", "drone", "interference", "isolation"):
        return None
    if value.get("phase") not in ("started", "contact", "completed", "cancelled", "restored"):
        return None
    for key, limit in (("runId", 128), ("message", 500)):
        if not isinstance(value.get(key), str) or not 0 < len(value[key]) <= limit:
            return None
    ids = value.get("affectedNodes")
    if not isinstance(ids, list) or len(ids) > 1024 or any(not isinstance(n, str) or not 0 < len(n) <= 128 for n in ids):
        return None
    notice = {key: value[key] for key in ("runId", "kind", "phase", "message")}
    notice["affectedNodes"] = list(dict.fromkeys(ids))
    if "position" in value:
        p = value["position"]
        if not isinstance(p, dict) or any(type(p.get(k)) not in (int, float) or not math.isfinite(p[k]) for k in ("x", "y")):
            return None
        notice["position"] = {"x": p["x"], "y": p["y"]}
    return notice


async def broadcast_simulation(sess: Session, alert: dict) -> None:
    # Intentionally out-of-band: even a node whose simulated radio links were
    # cut can see what the operator did. This is NOT successful mesh delivery.
    envelope = {"ctrl": "simulation", "alert": alert}
    await notify_admins(sess, envelope)
    for node_id in alert["recipients"]:
        node = sess.nodes.get(node_id)
        if node and node.admitted:
            await send_json(node.ws, envelope)


async def publish_simulation(sess: Session, value) -> None:
    notice = simulation_notice(value)
    if notice is None:
        return
    now = int(time.time() * 1000)
    alert = {
        **notice, "id": uuid.uuid4().hex, "createdAt": now,
        "expiresAt": now + SIMULATION_TTL_MS,
        "recipients": [n.node_id for n in sess.nodes.values() if n.admitted and n.node_id != "admin"],
        "acknowledgedBy": [],
    }
    recent_simulations(sess).append(alert)
    sess.simulation_alerts = sess.simulation_alerts[-SIMULATION_HISTORY_LIMIT:]
    await broadcast_simulation(sess, alert)


async def deliver(sess: Session, src: str, dst: str, payload) -> None:
    """Forward one opaque payload after link latency. Never parses payload."""
    link = sess.link(src, dst)
    if link.latency_ms:
        await asyncio.sleep(link.latency_ms / 1000.0)
    node = sess.nodes.get(dst)
    if node and node.admitted:
        await send_json(node.ws, {"from": src, "payload": payload})


async def route(sess: Session, src: str, dst: str, payload) -> None:
    """Adjacency + link policy. Drops are silent to the sender, by design:
    a radio link that is down does not send you an error."""
    reason = None
    if not sess.adjacent(src, dst):
        reason = "not_adjacent"
    else:
        link = sess.link(src, dst)
        if not link.up:
            reason = "link_down"
        elif link.loss and random.random() < link.loss:
            reason = "loss"

    await notify_admins(
        sess,
        {"ctrl": "forward", "from": src, "to": dst, "dropped": reason, "t": time.time()},
    )
    if reason:
        return
    # Fire-and-forget so per-link latency does not serialise the whole relay.
    asyncio.create_task(deliver(sess, src, dst, payload))


@app.get("/health")
def health():
    return {"ok": True, "sessions": list(SESSIONS)}


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    sess: Session | None = None
    node_id: str | None = None
    is_admin = False

    try:
        while True:
            msg = json.loads(await ws.receive_text())

            # ---- routed traffic: opaque, never parsed ----
            if "to" in msg:
                if sess and node_id:
                    await route(sess, node_id, msg["to"], msg.get("payload"))
                continue

            # ---- control plane ----
            ctrl = msg.get("ctrl")

            if ctrl == "join":
                sess = get_session(msg.get("session", "default"))
                # Requested id lets multi-tab testing pin identities (?node=n03).
                node_id = msg.get("node") or sess.next_id()
                sess.nodes[node_id] = Node(node_id=node_id, ws=ws)
                await send_json(ws, {"ctrl": "pending", "node": node_id})
                await push_state(sess)

            elif ctrl == "admin":
                sess = get_session(msg.get("session", "default"))
                sess.admins.add(ws)
                is_admin = True
                await send_json(ws, {"ctrl": "state", **sess.snapshot()})
                for alert in recent_simulations(sess):
                    await send_json(ws, {"ctrl": "simulation", "alert": alert})

            elif ctrl == "admit" and is_admin and sess:
                target = sess.nodes.get(msg["node"])
                if target:
                    target.admitted = True
                    await send_json(
                        target.ws,
                        {
                            "ctrl": "admitted",
                            "node": target.node_id,
                            "neighbours": sess.neighbours(target.node_id),
                        },
                    )
                    await push_state(sess)
                    # Replay only to original recipients after re-admission,
                    # not to new participants joining an already finished demo.
                    for alert in recent_simulations(sess):
                        if target.node_id in alert["recipients"]:
                            await send_json(target.ws, {"ctrl": "simulation", "alert": alert})

            elif ctrl == "simulation" and is_admin and sess:
                await publish_simulation(sess, msg.get("notice"))

            elif ctrl == "simulation_ack" and sess and node_id:
                node = sess.nodes.get(node_id)
                if node and node.ws is ws and node.admitted:
                    for alert in recent_simulations(sess):
                        if alert["id"] == msg.get("id") and node_id in alert["recipients"]:
                            if node_id not in alert["acknowledgedBy"]:
                                alert["acknowledgedBy"].append(node_id)
                            await broadcast_simulation(sess, alert)
                            break

            elif ctrl == "set_topology" and is_admin and sess:
                sess.topology = {k: list(v) for k, v in msg["edges"].items()}
                # Drop link state for edges the new topology does not contain.
                # Keeping it meant a link cut under one preset stayed silently
                # down after switching to another that re-created the same pair.
                wanted = {
                    (a, b) if a < b else (b, a)
                    for a, ns in sess.topology.items()
                    for b in ns
                }
                for key in list(sess.links):
                    if key not in wanted:
                        del sess.links[key]
                # Instantiate link state up front. Creating it lazily on first
                # forward would leave the operator with nothing to cut until
                # traffic happened to flow, which is exactly backwards.
                for a, ns in sess.topology.items():
                    for b in ns:
                        sess.link(a, b)
                for nid in list(sess.nodes):
                    await push_neighbours(sess, nid)
                await push_state(sess)

            elif ctrl == "set_link" and is_admin and sess:
                link = sess.link(msg["a"], msg["b"])
                if "up" in msg:
                    link.up = bool(msg["up"])
                if "latency_ms" in msg:
                    link.latency_ms = int(msg["latency_ms"])
                if "loss" in msg:
                    link.loss = float(msg["loss"])
                await push_state(sess)

    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        if sess:
            if is_admin:
                sess.admins.discard(ws)
            if node_id and sess.nodes.get(node_id) and sess.nodes[node_id].ws is ws:
                del sess.nodes[node_id]
                await push_state(sess)


# Serve the static export from the same origin as /ws, when one has been built
# (`npm run build:static`). This is what makes phones work: getUserMedia requires
# HTTPS, and an https:// page cannot open a ws:// socket to a different host — so
# one origin means one certificate and one tunnel instead of two of each.
# Mounted last so it never shadows /ws or /health.
_STATIC = Path(__file__).parent.parent / "out"

# HTML entry points carry no-cache so browsers always fetch the current bundle
# manifest after a deploy. Hashed JS/CSS under /_next/static keep their long
# cache lifetime: the filename changes with the content, so a fresh HTML file
# always points at fresh assets.
_NO_CACHE = {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
}


def _index_for(path: Path) -> Optional[Path]:
    """Resolve a directory URL to its index.html, if one exists."""
    if path.is_dir():
        candidate = path / "index.html"
        if candidate.is_file():
            return candidate
    return None


if _STATIC.is_dir():

    @app.get("/", include_in_schema=False)
    async def _root_index():
        target = _index_for(_STATIC)
        if target is None:
            return FileResponse(_STATIC, status_code=404)
        return FileResponse(target, headers=_NO_CACHE)

    # Explicit per-route entries beat the static mount for HTML documents.
    # The trailingSlash export writes admin/index.html style directories,
    # so both /station and /station/ must resolve with no-cache headers.
    for _route_dir in sorted(p for p in _STATIC.iterdir() if p.is_dir()):
        _index = _index_for(_route_dir)
        if _index is None:
            continue

        async def _route_index(_index: Path = _index):
            return FileResponse(_index, headers=_NO_CACHE)

        app.add_api_route(
            f"/{_route_dir.name}",
            _route_index,
            methods=["GET"],
            include_in_schema=False,
        )
        app.add_api_route(
            f"/{_route_dir.name}/",
            _route_index,
            methods=["GET"],
            include_in_schema=False,
        )

    # One middleware covers deep paths (404.html, future nested routes) and
    # guarantees nested index files also go out with no-cache.
    @app.middleware("http")
    async def _no_cache_html(request: Request, call_next):
        response = await call_next(request)
        ctype = response.headers.get("content-type", "")
        if ctype.startswith("text/html"):
            for key, value in _NO_CACHE.items():
                response.headers[key] = value
        return response

    app.mount("/", StaticFiles(directory=str(_STATIC), html=True), name="app")
