// station/page.tsx — the operator console, for the laptop screen.
//
// One page: the join QR and clickable 3D drone live in the left sidebar, the
// admin dashboard (admission, map, topology, link health) fills the right.
// Previously these were two pages (/station + /admin); combining them means
// the demo runs from a single laptop screen with no tab switching.
//
// The QR points at the site root plus ?session, not at this page: a mesh node
// lands in the session, not on the console.
// /admin redirects here, preserving ?session, for old bookmarks.
//
// Audio credit: Drone Audio Detection Samples (DADS, MIT).
// 3D credit: "Drone" by Silly Fear, CC-BY 3.0 via Poly Pizza.

"use client";

import { JoinCard } from "../lib/JoinCard.tsx";
import { DroneStage } from "../lib/DroneStage.tsx";
import { AdminDashboard } from "../lib/AdminDashboard.tsx";

export default function StationPage() {
  return (
    <>
      <style>{`@media (max-width: 900px) {
        .console { flex-direction: column; overflow-y: auto !important; }
        .console-sidebar { width: 100% !important; flex: none !important; border-right: 0 !important; border-bottom: 1px solid var(--line); overflow-y: visible !important; }
        .console-main { overflow-y: visible !important; }
      }`}</style>
    <main className="console" style={{ display: "flex", height: "100dvh", overflow: "hidden" }}>
      <aside
        className="console-sidebar"
        style={{
          width: 340,
          flex: "0 0 340px",
          padding: 20,
          borderRight: "1px solid var(--line)",
          display: "flex",
          flexDirection: "column",
          gap: 16,
          overflowY: "auto",
        }}
      >
        <JoinCard compact />
        <hr style={{ border: 0, borderTop: "1px solid var(--line)", margin: 0 }} />
        <DroneStage height={240} />
      </aside>

      <div
        className="console-main"
        style={{
          flex: 1,
          minWidth: 0, // flex children default to min-content; without this the
          overflowY: "auto", // map can push the layout instead of fitting it
          padding: 16,
        }}
      >
        <AdminDashboard />
      </div>
    </main>
    </>
  );
}
