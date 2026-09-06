// useSimulation.ts — drives SimWorld from the browser's frame clock.
//
// The world knows nothing about React or wall-clock time: it exposes tick(),
// and time is whatever this hook has advanced it to. Everything real-time lives
// here, which is why the simulation itself is testable.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { NodeConnection, OperatorNode } from "./types";
import { SimWorld, TICK_MS, type SimEvent, type SimSnapshot } from "./sim/world";
import type { Waypoint } from "./attackRoute";

export const SPEEDS = [1, 4, 16] as const;
export type Speed = (typeof SPEEDS)[number];

/**
 * Ceiling on ticks advanced in one frame.
 *
 * A backgrounded tab hands back a multi-second delta on return; without a cap
 * that becomes tens of thousands of ticks in one frame and the page locks up.
 * Dropping simulated time is the right trade — the alternative is a freeze.
 */
const MAX_TICKS_PER_FRAME = 400;

export function useSimulation(
  nodes: OperatorNode[],
  connections: NodeConnection[],
  route: Waypoint[],
  onEvents: (events: SimEvent[]) => void
) {
  const worldRef = useRef<SimWorld | null>(null);
  if (!worldRef.current) worldRef.current = new SimWorld({ seed: 1 });
  const world = worldRef.current;

  const [snapshot, setSnapshot] = useState<SimSnapshot>(() => world.snapshot(false));
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState<Speed>(4);

  // onEvents is rebuilt every render by the caller; hold it in a ref so the
  // animation effect does not tear down and restart on every frame.
  const eventsRef = useRef(onEvents);
  eventsRef.current = onEvents;

  // Topology follows the map. Nodes that persist keep their replica, so moving
  // or linking a sensor mid-run does not wipe what it already knows.
  useEffect(() => {
    world.setTopology(
      nodes.map((n) => ({ id: n.id, lat: n.lat, lon: n.lon })),
      connections.map((c) => ({ a: c.sourceId, b: c.targetId }))
    );
    setSnapshot(world.snapshot(running));
    // `running` deliberately absent: this syncs topology, it must not re-run on
    // every play/pause.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world, nodes, connections]);

  useEffect(() => {
    world.setRoute(route);
    setSnapshot(world.snapshot(running));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world, route]);

  useEffect(() => {
    if (!running) return;
    let raf = 0;
    let last = performance.now();
    let carry = 0;

    const frame = (now: number) => {
      const dt = Math.min(500, now - last);
      last = now;
      carry += dt * speed;
      let steps = 0;
      while (carry >= TICK_MS && steps < MAX_TICKS_PER_FRAME) {
        world.tick();
        carry -= TICK_MS;
        steps++;
      }
      if (steps > 0) {
        const events = world.drainEvents();
        if (events.length) eventsRef.current(events);
      }
      const next = world.snapshot(true);
      setSnapshot(next);
      // The run ends when the threat reaches its target; the mesh does not need
      // to keep scoring an empty sky.
      if (next.done) {
        setRunning(false);
        return;
      }
      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [world, running, speed]);

  const play = useCallback(() => setRunning(true), []);
  const pause = useCallback(() => setRunning(false), []);
  const reset = useCallback(() => {
    setRunning(false);
    world.reset();
    setSnapshot(world.snapshot(false));
  }, [world]);

  return { world, snapshot, running, speed, setSpeed, play, pause, reset };
}
