// EstimateLayer.tsx — one node's belief about where the drone is.
//
// Drawn from whichever replica the viewpoint selects, so switching nodes really
// does redraw the picture. Same sequential-ramp discipline as the placement
// field: one hue, light to dark, never a rainbow — but a different hue, because
// this answers a different question and the two are on screen together.

"use client";

import { useMemo } from "react";
import { Circle, CircleMarker, ImageOverlay, Tooltip } from "react-leaflet";
import type { NodeEstimate } from "./sim/estimate";
import styles from "./operator.module.css";

/** Amber, light→dark. Distinct from the advisor's cyan field. */
const RAMP: [number, number, number][] = [
  [74, 48, 12],
  [150, 96, 20],
  [222, 158, 52],
  [255, 226, 160],
];
const MAX_ALPHA = 165;
/**
 * Fraction of the peak below which the posterior is painted as nothing.
 *
 * The grid is deliberately wider than the array so the distribution is not
 * sliced off by its own boundary, which means most cells now sit far out in a
 * tail worth ~0. Drawn with the square-root stretch that tail still tints, and
 * a warm haze over the entire map reads as "the mesh thinks the drone is
 * everywhere" — the opposite of what a peaked posterior means. The colour ramp
 * keeps the full stretch; only the opacity is floored.
 */
const ALPHA_FLOOR = 0.18;
/**
 * Fraction of the grid over which the image fades out at its own edges.
 *
 * A posterior built from censored (silent) observations has no compact
 * support — it keeps rising away from the sensors — so there is no grid wide
 * enough to contain it, and painting it as a rectangle draws a hard border
 * that is an artefact of the box rather than anything the mesh believes. The
 * vignette says "continues past here" instead of "ends here".
 */
const EDGE_FADE = 0.18;

function ramp(t: number): [number, number, number] {
  const x = t * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(x));
  const f = x - i;
  const a = RAMP[i];
  const b = RAMP[i + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

function toDataUrl(est: NodeEstimate): string {
  const canvas = document.createElement("canvas");
  canvas.width = est.nx;
  canvas.height = est.ny;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  const img = ctx.createImageData(est.nx, est.ny);
  let peak = 0;
  for (const v of est.posterior) if (v > peak) peak = v;
  // A diffuse posterior should *look* diffuse. At full strength an unconstrained
  // belief paints the whole map and reads as confidence, which is the opposite
  // of what it means.
  const alpha = est.localised ? MAX_ALPHA : Math.round(MAX_ALPHA * 0.4);
  for (let iy = 0; iy < est.ny; iy++) {
    // Grid row 0 is the south edge; ImageData row 0 is the top, which Leaflet
    // anchors to the north bound.
    const src = est.ny - 1 - iy;
    for (let ix = 0; ix < est.nx; ix++) {
      // Square-root stretch: the tail carries the shape of the uncertainty and
      // a linear ramp hides all of it.
      const t = peak > 0 ? Math.sqrt(est.posterior[src * est.nx + ix] / peak) : 0;
      const [r, g, b] = ramp(t);
      // Ramps from nothing at ALPHA_FLOOR to full at the peak, so the drawn
      // extent is the part of the belief worth looking at rather than the
      // whole grid it was solved on.
      const shown = t <= ALPHA_FLOOR ? 0 : (t - ALPHA_FLOOR) / (1 - ALPHA_FLOOR);
      const fx = Math.min(ix, est.nx - 1 - ix) / (est.nx * EDGE_FADE);
      const fy = Math.min(src, est.ny - 1 - src) / (est.ny * EDGE_FADE);
      const vignette = Math.min(1, fx, fy);
      const o = (iy * est.nx + ix) * 4;
      img.data[o] = r;
      img.data[o + 1] = g;
      img.data[o + 2] = b;
      img.data[o + 3] = Math.round(alpha * shown * vignette);
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
}

export function EstimateLayer({ estimate }: { estimate: NodeEstimate }) {
  const url = useMemo(() => toDataUrl(estimate), [estimate]);
  if (!url) return null;
  return (
    <>
      <ImageOverlay
        url={url}
        bounds={[
          [estimate.area.south, estimate.area.west],
          [estimate.area.north, estimate.area.east],
        ]}
        opacity={1}
        zIndex={310}
      />
      {/* The marker only appears when the fix survives its own goodness-of-fit
          test. Drawing it otherwise claims precision that does not exist. */}
      {estimate.localised && (
        <>
          <Circle center={[estimate.lat, estimate.lon]} radius={estimate.spreadM}
            pathOptions={{ className: styles.mapDecoration, interactive: false, color: "#ffe2a0", fillColor: "#ffe2a0", fillOpacity: .06, weight: 1, dashArray: "4 6" }} />
          <CircleMarker center={[estimate.lat, estimate.lon]} radius={6}
            pathOptions={{ className: styles.mapDecoration, interactive: false, color: "#ffe2a0", fillColor: "#0a0f1a", fillOpacity: .9, weight: 3 }}>
            {/* Says what it is. Unlabelled, this glyph is indistinguishable
                from a route waypoint, and the dashed ring around it from the
                drone's audible footprint — three amber-on-dark shapes meaning
                three unrelated things. */}
            <Tooltip permanent direction="right" offset={[9, 0]} className={styles.fixLabel}>
              fused fix · ±{Math.round(estimate.spreadM)} m
            </Tooltip>
          </CircleMarker>
        </>
      )}
    </>
  );
}
