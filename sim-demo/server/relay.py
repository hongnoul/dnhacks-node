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
import random
import time
from dataclasses import dataclass, field

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="SkyMesh mesh relay")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

DEFAULT_LATENCY_MS = 50
DEFAULT_LOSS = 0.0


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

            elif ctrl == "set_topology" and is_admin and sess:
                sess.topology = {k: list(v) for k, v in msg["edges"].items()}
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
