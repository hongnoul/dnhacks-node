"use client";

import HardwareLauncher from "../hardware/HardwareLauncher";
import { Tag } from "@carbon/react";
import { JoinCard } from "../lib/JoinCard.tsx";
import { DroneStage } from "../lib/DroneStage.tsx";
import { AdminDashboard } from "../lib/AdminDashboard.tsx";

export default function StationPage() {
  return <>
    <main className="unified-console retro-console">
      <header className="retro-console-header">
        <h1>SkyMesh <span>/ Operations</span></h1>
        <nav aria-label="Workspace sections">
          <a href="#participant-map">Map</a>
          <a href="#participants">Participants</a>
          <a href="#scenarios">Scenarios</a>
          <a href="#simulation">Simulation</a>
          <HardwareLauncher />
        </nav>
      </header>
      <AdminDashboard onboarding={<>
        <div className="join-card"><JoinCard compact /></div>
        <details className="audio-card"><summary>Drone audio test</summary>
          <p className="dim">Play near a participant phone to exercise its real microphone detector.</p>
          <DroneStage height={180} />
        </details>
      </>} />
      {/* The way through to the planning sandbox. Deliberately the last
          section and deliberately labelled synthetic: everything above it is
          live participants with real microphones, and the one thing this page
          must never do is let the two be mistaken for each other. */}
      <section className="panel simulation-portal" id="simulation" tabIndex={-1} aria-label="Simulation sandbox">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
          <h2 style={{ margin: 0 }}>Network simulation <Tag type="purple" size="sm">Synthetic</Tag></h2>
          <span className="dim" style={{ fontSize: 12 }}>no microphones · no relay</span>
        </div>
        <p className="dim" style={{ margin: "8px 0 0", fontSize: 13, lineHeight: 1.5 }}>
          Plan an array against a drone that does not exist. Place synthetic sensors, draw an
          ingress a threat would really fly, and watch a timed mesh acquire it and gossip the
          contact outward — per-node replicas, 50&nbsp;ms links, packet loss and all. Nothing here
          touches a participant phone or the relay.
        </p>
        <ul className="simulation-portal-points">
          <li>See what fraction of a route the array would actually hear, and where it is blind.</li>
          <li>Ask where the next sensor should go, for the area or for a specific ingress.</li>
          <li>Open any node and redraw the map from its replica, to watch two nodes disagree.</li>
        </ul>
        <a className="simulation-portal-action" href="/simulation/">◈ Open the simulation</a>
      </section>
    </main>
  </>;
}
