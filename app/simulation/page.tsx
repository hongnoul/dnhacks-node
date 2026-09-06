// simulation/page.tsx — the planning sandbox, in the operations shell.
//
// Its own route rather than a panel inside /station, because the two make
// different claims about the same map: /station shows live participants with
// real microphones, this shows synthetic sensors and a drone that does not
// exist. Putting them in one view is how a demo ends up implying a simulated
// contact was heard by a real phone.
//
// The chrome is /station's, so crossing between them does not feel like
// leaving the product, and the title bar says which one you are in.

"use client";

import "leaflet/dist/leaflet.css";
import dynamic from "next/dynamic";

// Leaflet reaches for `window` at module scope, so it cannot be server
// rendered — the same reason the old /operator route loaded it this way.
const OperatorMap = dynamic(() => import("../operator/OperatorMap"), { ssr: false });

export default function SimulationPage() {
  // Deliberately not wrapped in `.retro-console`: that class is a light-theme
  // variable block (--text, --dim, --panel), and the simulation shell below is
  // dark with its own palette — applying it to the page washes out every
  // element that reads var(--dim). The title bar styles itself from the global
  // retro tokens, so it needs no theme wrapper.
  return (
    <div className="simulation-console">
      <header className="retro-console-header">
        <h1>SkyMesh <span>/ Simulation</span></h1>
        <nav aria-label="Workspace sections">
          <a href="/station/">← Live operations</a>
        </nav>
      </header>
      <OperatorMap />
    </div>
  );
}
