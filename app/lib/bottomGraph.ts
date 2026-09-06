import { GRAPH_WINDOW_MS } from './detection.ts';

/** Rasterize onto terminal-sized dot cells, rather than drawing smooth paths. */
export function terminalDots(history: { t: number; p: number }[], now: number, columns: number, rows: number) {
  const points = history.filter(p => Number.isFinite(p.t) && Number.isFinite(p.p) && p.t >= now - GRAPH_WINDOW_MS && p.t <= now).sort((a, b) => a.t - b.t);
  const dots = new Map<string, [number, number]>();
  const cell = (p: { t: number; p: number }): [number, number] => [
    Math.round((p.t - now + GRAPH_WINDOW_MS) / GRAPH_WINDOW_MS * (columns - 1)),
    Math.round((1 - Math.max(0, Math.min(1, p.p))) * (rows - 1)),
  ];
  for (let i = 0; i < points.length; i++) {
    const b = cell(points[i]);
    // Missing readings remain blank instead of suggesting continuous measurement.
    const a = i && points[i].t - points[i - 1].t <= 2000 ? cell(points[i - 1]) : b;
    const steps = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), 1);
    for (let s = 0; s <= steps; s++) {
      const x = Math.round(a[0] + (b[0] - a[0]) * s / steps);
      const y = Math.round(a[1] + (b[1] - a[1]) * s / steps);
      dots.set(`${x},${y}`, [x, y]);
    }
  }
  return [...dots.values()];
}

export function drawBottomGraph(ctx: CanvasRenderingContext2D, history: { t: number; p: number }[], now: number, width: number, height: number) {
  ctx.fillStyle = '#101216';
  ctx.fillRect(0, 0, width, height);
  if (width < 90 || height < 60) return;
  const left = 38, right = width - 6, top = 12, bottom = height - 28;
  ctx.font = "12px Menlo, Consolas, monospace";
  ctx.fillStyle = '#dedee3';
  ctx.textAlign = 'right';
  ctx.fillText('100%', left - 5, top + 4);
  ctx.fillText('0%', left - 5, bottom - 6);
  ctx.fillText('0s', right, height - 6);
  ctx.textAlign = 'left';
  ctx.fillText('60s', left - 18, height - 6);
  ctx.strokeStyle = '#dedee3';
  ctx.lineWidth = 1;
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
  ctx.beginPath();
  ctx.moveTo(left + 0.5, top - 6);
  ctx.lineTo(left + 0.5, bottom + 0.5);
  ctx.lineTo(right, bottom + 0.5);
  ctx.stroke();
  const columns = Math.max(2, Math.floor((right - left - 5) / 4));
  const rows = Math.max(2, Math.floor((bottom - top - 8) / 4));
  ctx.fillStyle = '#dcb0f2';
  for (const [x, y] of terminalDots(history, now, columns, rows)) {
    ctx.fillRect(left + 4 + x * 4, top + y * 4, 2, 2);
  }
}
