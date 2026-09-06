// identity.ts — who this node is, and why reloading cannot corrupt the log.
//
// The failure this prevents: a node that reloads and restarts `seq` at 1 writes
// a *different record under an existing key*. Two conflicting values under one
// key breaks the CRDT permanently and silently — anti-entropy never repairs it,
// because both sides believe they have already converged (ARCHITECTURE.md §7.8).
//
// Fix: `boot` increments on every load and is part of every key, so a reload
// starts a fresh stream instead of overwriting an old one. `nodeId` and `boot`
// live in the same storage, so clearing storage yields a new node id too — there
// is no path where an old key can be reused with new content.

export interface Identity {
  nodeId: string;
  boot: number;
}

const NODE_KEY = "skymesh:node";
const BOOT_KEY = "skymesh:boot";

function randomId(): string {
  return "n" + Math.random().toString(36).slice(2, 7);
}

/**
 * `requestedId` pins identity for multi-tab testing (`?node=n03`). When set we
 * use sessionStorage, which is per-tab: localStorage is shared across tabs of
 * the same origin, so six test tabs would otherwise all claim one node id and
 * the result looks exactly like a replication bug (IMPLEMENTATION.md §6).
 */
export function loadIdentity(requestedId?: string | null): Identity {
  const store =
    requestedId && typeof sessionStorage !== "undefined"
      ? sessionStorage
      : localStorage;

  let nodeId = requestedId || store.getItem(NODE_KEY);
  if (!nodeId) {
    nodeId = randomId();
    store.setItem(NODE_KEY, nodeId);
  }
  if (requestedId) store.setItem(NODE_KEY, nodeId);

  const boot = Number(store.getItem(`${BOOT_KEY}:${nodeId}`) ?? "0") + 1;
  store.setItem(`${BOOT_KEY}:${nodeId}`, String(boot));

  return { nodeId, boot };
}
