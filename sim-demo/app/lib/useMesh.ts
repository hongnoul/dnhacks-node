// useMesh.ts — React binding for the Mesh.

"use client";

import { useEffect, useRef, useState } from "react";
import { Mesh, type MeshView } from "./mesh.ts";
import { relayUrl, sessionId } from "./config.ts";

export function useMesh(
  opts: { passive?: boolean; enabled?: boolean; forceId?: string } = {}
) {
  const { passive = false, enabled = true, forceId } = opts;
  const meshRef = useRef<Mesh | null>(null);
  const [view, setView] = useState<MeshView | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const params = new URLSearchParams(window.location.search);
    const mesh = new Mesh({
      url: relayUrl(),
      session: sessionId(),
      // forceId pins the admin observer to a known id so the console can tell
      // its own passive node apart from real sensors.
      requestedId: forceId ?? params.get("node"),
      passive,
    });
    meshRef.current = mesh;
    mesh.start();

    const update = () => setView(mesh.view());
    const unsub = mesh.subscribe(update);
    // Readings expire on a timer, so refresh even when nothing arrives.
    const tick = setInterval(update, 500);
    update();

    return () => {
      unsub();
      clearInterval(tick);
      mesh.stop();
      meshRef.current = null;
    };
  }, [passive, enabled, forceId]);

  return { mesh: meshRef.current, view };
}
