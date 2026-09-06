// Display-only georeferencing of the live room frame. Never a GPS measurement.
export interface MapAnchor { lat: number; lon: number }
export const DEFAULT_MAP_ANCHOR: MapAnchor = { lat: 38.9012, lon: -77.0402 };
const METRES_PER_DEGREE = 111_320;
export function validAnchor(anchor: MapAnchor): boolean {
  return Number.isFinite(anchor.lat) && Number.isFinite(anchor.lon)
    && Math.abs(anchor.lat) <= 85 && Math.abs(anchor.lon) <= 180;
}
/** Room x increases east, y increases south. Anchor is the room centre. */
export function roomLatLon(anchor: MapAnchor, room: { w: number; h: number }, x: number, y: number): [number, number] {
  if (!validAnchor(anchor)) throw new Error('Invalid map anchor');
  return [anchor.lat + (room.h / 2 - y) / METRES_PER_DEGREE,
    anchor.lon + (x - room.w / 2) / (METRES_PER_DEGREE * Math.cos(anchor.lat * Math.PI / 180))];
}
