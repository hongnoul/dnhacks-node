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
  if (typeof window === "undefined") return explicit || "ws://localhost:8001/ws";
  const proto = window.location.protocol === "https:" ? "wss" : "ws";

  // A leading slash means same-origin: the relay is serving this page too, so
  // one host (and one tunnel) covers both the app and the socket. This is the
  // shape that works from a phone, where getUserMedia demands HTTPS and an
  // https:// page may not open a ws:// socket to some other host.
  if (explicit?.startsWith("/")) {
    return `${proto}://${window.location.host}${explicit}`;
  }
  if (explicit) return explicit;

  // Dev default: Next on :3000, relay beside it on :8001.
  return `${proto}://${window.location.hostname}:8001/ws`;
}
