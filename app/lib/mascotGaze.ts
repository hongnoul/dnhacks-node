export interface Box { left: number; top: number; right: number; bottom: number; }
export interface DroneBox { id: string; box: Box; }
export type Gaze = "open" | "left" | "right" | "up" | "down" | "upLeft" | "upRight" | "downLeft" | "downRight";
const intersects = (a: Box, b: Box) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/** Use rendered screen coordinates, not SVG path coordinates. Partly obscured drones are excluded too. */
export function nearestVisibleDrone(eye: { x: number; y: number }, drones: DroneBox[], panel: Box, viewport: Box): { id: string; gaze: Gaze } | null {
  let best: { id: string; gaze: Gaze } | null = null;
  let distance = Infinity;
  for (const { id, box } of drones) {
    if (box.right <= box.left || box.bottom <= box.top || !intersects(box, viewport) || intersects(box, panel)) continue;
    const x = (box.left + box.right) / 2, y = (box.top + box.bottom) / 2;
    // Ignore clipped-off centers even if a rotor still touches the viewport.
    if (x < viewport.left || x > viewport.right || y < viewport.top || y > viewport.bottom) continue;
    const dx = x - eye.x, dy = y - eye.y, d = dx * dx + dy * dy;
    if (d >= distance) continue;
    distance = d;
    const angle = Math.atan2(dy, dx);
    const directions: Gaze[] = ["right", "downRight", "down", "downLeft", "left", "upLeft", "up", "upRight"];
    const direction = (Math.round(angle / (Math.PI / 4)) + 8) % 8;
    best = { id, gaze: d < 16 ? "open" : directions[direction] };
  }
  return best;
}
