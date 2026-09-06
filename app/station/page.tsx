"use client";

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
        </nav>
      </header>
      <AdminDashboard onboarding={<>
        <div className="join-card"><JoinCard compact /></div>
        <details className="audio-card"><summary>Drone audio test</summary>
          <p className="dim">Play near a participant phone to exercise its real microphone detector.</p>
          <DroneStage height={180} />
        </details>
      </>} />
    </main>
  </>;
}
