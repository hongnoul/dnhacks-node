import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { AdminChannel } from "../app/lib/admin.ts";
import { Mesh } from "../app/lib/mesh.ts";
import {
  currentSimulationAlerts, isSimulationAlert, mergeSimulationAlert,
  SIMULATION_HISTORY_LIMIT, SIMULATION_TTL_MS, type SimulationAlert, type SimulationNotice,
} from "../app/lib/simulationChannel.ts";
import { relayWs, startRelay, waitFor } from "./harness.ts";

const notice: SimulationNotice = {
  runId: "flight-1", kind: "drone", phase: "started", message: "Simulated flight started", affectedNodes: ["n01"],
};
const alert = (id = "a", createdAt = 1000): SimulationAlert => ({
  ...notice, id, createdAt, expiresAt: createdAt + SIMULATION_TTL_MS,
  recipients: ["n01", "n02"], acknowledgedBy: [],
});

test("simulation payload validation rejects malformed and reading-shaped messages", () => {
  assert.ok(isSimulationAlert(alert()));
  for (const invalid of [null, {}, { type: "reading", p: 1, d: true },
    { ...alert(), kind: "reading" }, { ...alert(), phase: "detected" },
    { ...alert(), affectedNodes: [123] }, { ...alert(), acknowledgedBy: "n01" },
    { ...alert(), position: { x: Infinity, y: 2 } }, { ...alert(), expiresAt: Infinity },
    { ...alert(), expiresAt: 1000 + SIMULATION_TTL_MS + 1 }, { ...alert(), message: "x".repeat(501) },
  ]) assert.equal(isSimulationAlert(invalid), false);
});

test("history is bounded, expiring and deduplicated; ACKs preserve event order", () => {
  let history: SimulationAlert[] = [];
  for (let i = 0; i < 50; i++) history = mergeSimulationAlert(history, alert(String(i), 1000 + i), 1100);
  assert.equal(history.length, SIMULATION_HISTORY_LIMIT);
  assert.equal(history[0].id, "49");
  history = mergeSimulationAlert(history, { ...history[5], acknowledgedBy: ["n01"] }, 1100);
  assert.equal(history.length, SIMULATION_HISTORY_LIMIT);
  assert.equal(history[0].id, "49");
  assert.deepEqual(history[5].acknowledgedBy, ["n01"]);
  assert.deepEqual(mergeSimulationAlert(history, alert(), 200_000), []);
});

test("completion and cancellation supersede earlier phases without reviving old unread alerts", () => {
  const start = alert("start");
  const contact = { ...alert("contact", 1100), phase: "contact" as const };
  const cancel = { ...alert("cancel", 1200), phase: "cancelled" as const, acknowledgedBy: ["n01"] };
  const impact = { ...alert("impact", 1300), runId: "impact-1", kind: "impact" as const };
  assert.deepEqual(currentSimulationAlerts([impact, cancel, contact, start], 1400).map(a => a.id), ["impact", "cancel"]);
  assert.deepEqual(currentSimulationAlerts([impact, cancel, contact, start], 200_000), []);
});

let relay: ChildProcess;
const storage = new Map<string, string>();
before(async () => {
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  } });
  relay = await startRelay();
});
after(() => { relay?.kill(); Reflect.deleteProperty(globalThis, "sessionStorage"); });

async function register(admin: AdminChannel, mesh: Mesh, admit = true) {
  mesh.start();
  await waitFor(() => admin.state.nodes.some(n => n.node === mesh.id.nodeId));
  if (admit) {
    admin.admit(mesh.id.nodeId);
    await waitFor(() => mesh.view().status.state === "active");
  }
}

async function rawNode(session: string, node: string) {
  const ws = new WebSocket(relayWs());
  const messages: any[] = [];
  ws.onmessage = e => messages.push(JSON.parse(String(e.data)));
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = reject; });
  const send = (value: unknown) => ws.send(JSON.stringify(value));
  send({ ctrl: "join", session, node });
  await waitFor(() => messages.some(m => m.ctrl === "pending"));
  return { ws, messages, send };
}

test("real admin → relay → Mesh notices and ACKs work across cut links without becoming detections", async t => {
  const session = "simulation-isolation";
  const admin = new AdminChannel(relayWs(), session);
  const node = new Mesh({ url: relayWs(), session, requestedId: "n01" });
  const pending = new Mesh({ url: relayWs(), session, requestedId: "pending" });
  const outsiderAdmin = new AdminChannel(relayWs(), "other-session");
  const outsider = new Mesh({ url: relayWs(), session: "other-session", requestedId: "n01" });
  t.after(() => { node.stop(); pending.stop(); outsider.stop(); admin.close(); outsiderAdmin.close(); });
  await register(admin, node);
  await register(admin, pending, false);
  await register(outsiderAdmin, outsider);
  admin.setTopology({ n01: ["admin"], admin: ["n01"] });
  admin.setLink("n01", "admin", { up: false, loss: 1 });
  await waitFor(() => admin.state.links.some(l => !l.up));
  node.publishPosition("n01", 2, 3);
  node.publishReading({ p: 0, display: 0, detecting: false, logit: -10, snrDb: null });
  const before = node.view();
  const beforeHistory = node.history("n01");
  assert.ok(admin.publishSimulation({ ...notice, kind: "impact", message: "Simulated blast", position: { x: 2, y: 3 } }));
  await waitFor(() => node.view().simulationAlerts.length === 1);
  const received = node.view().simulationAlerts[0];
  assert.deepEqual(received.recipients, ["n01"]);
  assert.deepEqual(received.affectedNodes, ["n01"]);
  assert.equal(received.expiresAt - received.createdAt, SIMULATION_TTL_MS);
  assert.equal(pending.view().simulationAlerts.length, 0);
  assert.equal(outsider.view().simulationAlerts.length, 0);
  assert.equal(node.view().records, before.records);
  assert.deepEqual(node.history("n01"), beforeHistory);
  assert.deepEqual(node.detecting(), []);
  assert.equal(node.view().estimate, null);
  assert.equal(node.view().stats.received, before.stats.received);
  assert.ok(node.acknowledgeSimulation(received.id));
  await waitFor(() => admin.simulationAlerts[0]?.acknowledgedBy.includes("n01"));
  await waitFor(() => node.view().simulationAlerts[0]?.acknowledgedBy.includes("n01"));
  node.acknowledgeSimulation(received.id);
  await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(admin.simulationAlerts[0].acknowledgedBy, ["n01"]);
  assert.equal(node.view().simulationAlerts.length, 1);
  assert.equal(node.view().records, before.records);
});

test("relay rejects node-origin simulations, pending ACKs, invalid payloads and forged attribution", async t => {
  const session = "simulation-validation";
  const admin = new AdminChannel(relayWs(), session);
  const node = await rawNode(session, "n01");
  const pending = await rawNode(session, "pending");
  const control = new WebSocket(relayWs());
  t.after(() => { node.ws.close(); pending.ws.close(); admin.close(); control.close(); });
  await new Promise<void>(resolve => { control.onopen = () => resolve(); });
  control.send(JSON.stringify({ ctrl: "admin", session }));
  admin.admit("n01");
  await waitFor(() => node.messages.some(m => m.ctrl === "admitted"));
  node.send({ ctrl: "simulation", notice });
  for (const invalid of [null, { ...notice, kind: "reading" }, { ...notice, position: { x: "2", y: 3 } }, { ...notice, affectedNodes: [true] }]) {
    control.send(JSON.stringify({ ctrl: "simulation", notice: invalid }));
  }
  await new Promise(r => setTimeout(r, 100));
  assert.equal(admin.simulationAlerts.length, 0);
  control.send(JSON.stringify({ ctrl: "simulation", notice: { ...notice, id: "forged", recipients: ["pending"], acknowledgedBy: ["fake"] } }));
  await waitFor(() => admin.simulationAlerts.length === 1);
  const received = admin.simulationAlerts[0];
  assert.notEqual(received.id, "forged");
  assert.deepEqual(received.recipients, ["n01"]);
  assert.deepEqual(received.acknowledgedBy, []);
  pending.send({ ctrl: "simulation_ack", id: received.id, node: "n01" });
  node.send({ ctrl: "simulation_ack", id: "missing" });
  await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(admin.simulationAlerts[0].acknowledgedBy, []);
  node.send({ ctrl: "simulation_ack", id: received.id, node: "someone-else" });
  await waitFor(() => admin.simulationAlerts[0].acknowledgedBy.length === 1);
  assert.deepEqual(admin.simulationAlerts[0].acknowledgedBy, ["n01"]);
});

test("re-admission replays bounded recent notices only to original recipients and preserves ACKs", async t => {
  const session = "simulation-rejoin";
  const admin = new AdminChannel(relayWs(), session);
  const first = new Mesh({ url: relayWs(), session, requestedId: "n01" });
  let rejoined: Mesh | undefined;
  let newcomer: Mesh | undefined;
  let nextAdmin: AdminChannel | undefined;
  t.after(() => { first.stop(); rejoined?.stop(); newcomer?.stop(); admin.close(); nextAdmin?.close(); });
  await register(admin, first);
  for (let i = 0; i < 45; i++) admin.publishSimulation({ ...notice, runId: `run-${i}` });
  await waitFor(() => first.view().simulationAlerts.length === SIMULATION_HISTORY_LIMIT && admin.simulationAlerts[0]?.runId === "run-44");
  const latest = first.view().simulationAlerts[0];
  first.acknowledgeSimulation(latest.id);
  await waitFor(() => admin.simulationAlerts[0].acknowledgedBy.includes("n01"));
  first.stop();
  await waitFor(() => !admin.state.nodes.some(n => n.node === "n01"));
  rejoined = new Mesh({ url: relayWs(), session, requestedId: "n01" });
  await register(admin, rejoined);
  await waitFor(() => rejoined!.view().simulationAlerts.length === SIMULATION_HISTORY_LIMIT);
  assert.equal(rejoined.view().simulationAlerts[0].id, latest.id);
  assert.deepEqual(rejoined.view().simulationAlerts[0].acknowledgedBy, ["n01"]);
  newcomer = new Mesh({ url: relayWs(), session, requestedId: "n02" });
  await register(admin, newcomer);
  assert.deepEqual(newcomer.view().simulationAlerts, []);
  nextAdmin = new AdminChannel(relayWs(), session);
  await waitFor(() => nextAdmin!.simulationAlerts.length === SIMULATION_HISTORY_LIMIT);
  assert.equal(nextAdmin.simulationAlerts[0].id, latest.id);
  assert.equal(rejoined.view().records, 0);
});
