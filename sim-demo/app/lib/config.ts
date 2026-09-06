// config.ts — where the relay lives.

export const DEFAULT_SESSION = "default";

/** Single source of truth for session id — the ctrl channel and the mesh node
 *  must agree, or the operator ends up watching an empty session. */
export function sessionId(): string {
  if (typeof window === "undefined") return DEFAULT_SESSION;
  return new URLSearchParams(window.location.search).get("session") ?? DEFAULT_SESSION;
}

export function relayUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_RELAY_URL;
  if (explicit) return explicit;
  if (typeof window === "undefined") return "ws://localhost:8001/ws";
  // Default to the relay beside the page, on its own port. Must be wss:// when
  // the page is https:// — mixed content is blocked (ARCHITECTURE.md §4.5).
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.hostname}:8001/ws`;
}
