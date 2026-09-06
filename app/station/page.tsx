"use client";

import { OperationsHeader } from "../lib/DesignSystem";
import { JoinCard } from "../lib/JoinCard.tsx";
import { DroneStage } from "../lib/DroneStage.tsx";
import { AdminDashboard } from "../lib/AdminDashboard.tsx";

export default function StationPage() {
  return <>
    <OperationsHeader />
    <main className="unified-console">
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
