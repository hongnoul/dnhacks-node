// PlacementLayer.tsx — the advisor, drawn on the map.
//
// Two marks, deliberately different in kind:
//
//   the field       a diffuse wash showing localisation quality — bright where a
//                   source could be pinned down, transparent where the array is
//                   blind. Magnitude, so one hue light-to-dark (never a rainbow).
//   the suggestions white dashed rings with a rank numeral.
//
// The suggestions are white rather than a new hue on purpose. Every mark on this
// map already carries meaning by colour — green/amber/red is node status, cyan is
// a link, purple the command post, gold a detection — and the one hue family
// still free (magenta) is indistinguishable from the purples under deuteranopia
// and protanopia. So identity here is carried by *shape and label* instead:
// a dashed ring is not a filled dot, and the numeral says which is which.

"use client";

import { useMemo } from "react";
import { Circle, ImageOverlay, Marker, Polyline, Tooltip } from "react-leaflet";
import { divIcon } from "leaflet";
import {
  CRLB_CAP_M,
  CRLB_FLOOR_M,
  MIN_NODE_DISTANCE_M,
  type QualityGrid,
  type SensorSite,
  type Suggestion,
} from "./placement";
import styles from "./operator.module.css";

/**
 * Sequential ramp for localisation quality: one hue, light to dark.
 *
 * Lightness is monotonic across the stops (OKLab L 0.385 → 0.611 → 0.728 →
 * 0.898), which is the only property a sequential ramp has to hold. Cyan is the
 * map's existing "infrastructure" hue, and it cannot be confused with the link
 * strokes that share it because the marks differ: links are 2 px opaque lines,
 * this is a translucent field.
 */
const RAMP: [number, number, number][] = [
  [14, 74, 99], // #0e4a63
  [16, 128, 168], // #1080a8
  [63, 182, 224], // #3fb6e0
  [168, 233, 255], // #a8e9ff
];

/** Peak opacity of the wash. The basemap has to stay readable underneath. */
const MAX_ALPHA = 150;

const LOG_SPAN = Math.log(CRLB_CAP_M / CRLB_FLOOR_M);

/** Position error → 0..1 quality. Log, because the error spans well over a decade. */
export function quality(radiusM: number): number {
  const t = Math.log(CRLB_CAP_M / Math.max(radiusM, 1e-6)) / LOG_SPAN;
  return Math.min(1, Math.max(0, t));
}

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

/**
 * Render the grid to a PNG data URL for Leaflet's ImageOverlay.
 *
 * Drawn at grid resolution (48x48 is ~3 KB) and scaled by the browser, the same
 * trick sim-demo's RoomMap uses for its posterior heatmap.
 *
 * Row order flips: grid row 0 is the *south* edge, but an ImageData row 0 is the
 * top of the image, which Leaflet anchors to the *north* bound.
 */
function gridToDataUrl(grid: QualityGrid): string {
  const canvas = document.createElement("canvas");
  canvas.width = grid.nx;
  canvas.height = grid.ny;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  const img = ctx.createImageData(grid.nx, grid.ny);
  for (let iy = 0; iy < grid.ny; iy++) {
    const srcRow = grid.ny - 1 - iy;
    for (let ix = 0; ix < grid.nx; ix++) {
      const t = quality(grid.radiusM[srcRow * grid.nx + ix]);
      const [r, g, b] = ramp(t);
      const o = (iy * grid.nx + ix) * 4;
      img.data[o] = r;
      img.data[o + 1] = g;
      img.data[o + 2] = b;
      img.data[o + 3] = Math.round(MAX_ALPHA * t);
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
}

export interface PlacementLayerProps {
  grid: QualityGrid | null;
  suggestions: Suggestion[];
  nodes: SensorSite[];
  showField: boolean;
  onAccept?: (suggestion: Suggestion) => void;
}

export function PlacementLayer({
  grid,
  suggestions,
  nodes,
  showField,
  onAccept,
}: PlacementLayerProps) {
  const fieldUrl = useMemo(() => (grid && showField ? gridToDataUrl(grid) : ""), [grid, showField]);

  const icons = useMemo(
    () =>
      suggestions.map((s) =>
        divIcon({
          className: styles.suggestionMarker,
          html: `<span class="${styles.suggestionGlyph}">${s.rank}</span>`,
          iconSize: [30, 30],
          iconAnchor: [15, 15],
        })
      ),
    [suggestions]
  );

  return (
    <>
      {grid && showField && fieldUrl && (
        <ImageOverlay
          url={fieldUrl}
          bounds={[
            [grid.area.south, grid.area.west],
            [grid.area.north, grid.area.east],
          ]}
          opacity={1}
          zIndex={300}
        />
      )}

      {suggestions.map((s) => (
        <Circle
          key={`spacing-${s.rank}`}
          center={[s.lat, s.lon]}
          radius={MIN_NODE_DISTANCE_M}
          pathOptions={{
            className: styles.mapDecoration,
            interactive: false,
            color: "#ffffff",
            fillColor: "#ffffff",
            fillOpacity: 0.04,
            weight: 1,
            opacity: 0.35,
            dashArray: "3 7",
          }}
        />
      ))}

      {suggestions.flatMap((s) =>
        s.neighbours.map((id) => {
          const n = nodes.find((node) => node.id === id);
          if (!n) return null;
          return (
            <Polyline
              key={`link-${s.rank}-${id}`}
              positions={[
                [s.lat, s.lon],
                [n.lat, n.lon],
              ]}
              pathOptions={{
                className: styles.mapDecoration,
                interactive: false,
                color: "#ffffff",
                dashArray: "2 7",
                opacity: 0.5,
                weight: 1,
              }}
            />
          );
        })
      )}

      {suggestions.map((s, i) => (
        <Marker
          key={`suggestion-${s.rank}`}
          position={[s.lat, s.lon]}
          icon={icons[i]}
          eventHandlers={onAccept ? { click: () => onAccept(s) } : undefined}
        >
          <Tooltip direction="top" offset={[0, -18]}>
            <b>Suggested position {s.rank}</b>
            <br />
            {Math.round(s.meanRadiusM)} m mean error (−{Math.round(s.improvementM)} m)
            <br />
            {s.neighbours.length} link{s.neighbours.length === 1 ? "" : "s"} ·{" "}
            {Math.round(s.coverage * 100)}% covered
            <br />
            {onAccept ? "Click to place a sensor here" : ""}
          </Tooltip>
        </Marker>
      ))}
    </>
  );
}
