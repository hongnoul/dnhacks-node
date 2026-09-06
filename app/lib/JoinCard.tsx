// JoinCard.tsx — the QR that puts a phone on this session as a sensor node.
//
// Extracted from station/page.tsx. The QR is built client-side because it has
// to carry this origin (whatever the phone can actually reach — a tunnel,
// usually) and this session. It points at the site root, not at /station:
// a mesh node lands in the session, not on the console page.

"use client";

import { useEffect, useState } from "react";
import QRCode from "react-qr-code";
import { sessionId } from "./config.ts";

export function JoinCard({ compact = false }: { compact?: boolean }) {
  const [joinUrl, setJoinUrl] = useState("");
  const [session, setSession] = useState("");
  const qrSize = compact ? 140 : 190;

  // Built client-side: the QR has to carry this origin and session, and the
  // origin is whatever the phone can actually reach (a tunnel, usually).
  useEffect(() => {
    const s = sessionId();
    setSession(s);
    const u = new URL(window.location.origin);
    u.searchParams.set("session", s);
    setJoinUrl(u.toString());
  }, []);

  return (
    <div style={{ display: "grid", gap: compact ? 8 : 16 }}>
      <div>
        <h1 style={{ fontSize: compact ? 16 : 20 }}>Join the mesh</h1>
        <p className="dim" style={{ fontSize: 13, marginTop: 4, marginBottom: 0 }}>
          Scan to turn your phone into a sensor node. Detection runs on the device —
          audio never leaves it.
        </p>
      </div>

      <div style={{ background: "#fff", padding: compact ? 10 : 14, borderRadius: 10, alignSelf: "flex-start" }}>
        {joinUrl ? (
          <QRCode value={joinUrl} size={qrSize} />
        ) : (
          <div style={{ width: qrSize, height: qrSize }} />
        )}
      </div>

      <div className="dim" style={{ fontSize: 11, wordBreak: "break-all" }}>
        {joinUrl || "…"}
      </div>
      <div className="dim" style={{ fontSize: 12 }}>
        session <b style={{ color: "var(--text)" }}>{session || "…"}</b>
      </div>
    </div>
  );
}
