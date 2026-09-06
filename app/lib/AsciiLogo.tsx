"use client";

import { useEffect, useRef, useState } from "react";
import { nearestVisibleDrone, type Gaze } from "./mascotGaze";
import { mascotFrame, sequences, type EyeFrame, type MascotMood } from "./mascotFrames";

export function AsciiLogo({ className, mood = "idle" }: { className?: string; mood?: MascotMood }) {
  const artRef = useRef<HTMLPreElement>(null);
  const [target, setTarget] = useState<{ id: string; gaze: Gaze } | null>(null);
  const [reduced, setReduced] = useState(false);
  const [frame, setFrame] = useState<EyeFrame>("open");
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const restart = () => {
      clearTimeout(timer);
      setReduced(media.matches);
      const steps = sequences[mood];
      let index = 0;
      const tick = () => {
        const [next, duration] = steps[index];
        setFrame(next);
        index = (index + 1) % steps.length;
        if (!media.matches && mood !== "happy") timer = setTimeout(tick, duration);
      };
      tick();
    };
    restart();
    media.addEventListener("change", restart);
    return () => { clearTimeout(timer); media.removeEventListener("change", restart); };
  }, [mood]);
  useEffect(() => {
    if (reduced || mood !== "idle") { setTarget(null); return; }
    const track = () => {
      const art = artRef.current;
      const panel = document.querySelector<HTMLElement>("[data-join-panel]");
      if (!art || !panel || document.hidden) return;
      const a = art.getBoundingClientRect();
      const drones = Array.from(document.querySelectorAll<SVGGraphicsElement>("[data-drone]"))
        .filter(e => getComputedStyle(e).display !== "none" && getComputedStyle(e).visibility !== "hidden")
        .map(e => ({ id: e.dataset.drone!, box: e.getBoundingClientRect() }));
      const next = nearestVisibleDrone({ x: a.left + a.width / 2, y: a.top + a.height / 2 }, drones,
        panel.getBoundingClientRect(), { left: 0, top: 0, right: innerWidth, bottom: innerHeight });
      setTarget(old => old?.id === next?.id && old?.gaze === next?.gaze ? old : next);
    };
    track();
    const timer = setInterval(track, 150);
    return () => clearInterval(timer);
  }, [mood, reduced]);
  const displayedFrame = mood === "idle" && !reduced && frame === "open" ? target?.gaze ?? "open" : frame;
  return <pre ref={artRef} className={className} role="img" aria-label="SkyMesh robot logo in ASCII art" data-reduced-motion={reduced} data-mood={mood} data-eye-frame={displayedFrame} data-blink-frame={frame} data-target-drone={target?.id ?? ""}>{mascotFrame(displayedFrame)}</pre>;
}
