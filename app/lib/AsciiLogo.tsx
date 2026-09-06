"use client";

import { useEffect, useState } from "react";
import { mascotFrame, sequences, type EyeFrame, type MascotMood } from "./mascotFrames";

export function AsciiLogo({ className, mood = "idle" }: { className?: string; mood?: MascotMood }) {
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
  return <pre className={className} role="img" aria-label="SkyMesh robot logo in ASCII art" data-reduced-motion={reduced} data-mood={mood} data-eye-frame={frame}>{mascotFrame(frame)}</pre>;
}
