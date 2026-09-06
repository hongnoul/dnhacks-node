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
    <main className="console">
      <aside className="console-sidebar" aria-label="Join and demonstrate">
        <div className="brand"><span className="brand-mark">S</span><div><strong>SkyMesh</strong><div className="eyebrow">Distributed detection</div></div></div>
        <section className="panel join-card"><JoinCard compact /></section>
        <section className="panel audio-card">
          <div className="card-heading"><h2>Drone audio demo</h2><span className="badge simulation">Demo</span></div>
          <p className="dim">Play a sample near a joined phone to test on-device detection.</p>
          <DroneStage height={220} />
        </section>
        <p className="sidebar-note">Local intelligence. Shared awareness.<br />Raw microphone audio stays on each phone.</p>
      </aside>
      <div className="console-main"><AdminDashboard /></div>
    </main>
  );
}
