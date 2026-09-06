"use client";

import { useEffect, useRef, useState } from "react";
import { MapContainer, TileLayer, useMapEvents } from "react-leaflet";
import { DomEvent, type LatLngBoundsExpression } from "leaflet";
import "leaflet/dist/leaflet.css";
import { RoomMap, type RoomMapProps } from "./RoomMap";
import { ActionButton } from "./DesignSystem";
import { DEFAULT_MAP_ANCHOR, roomLatLon, validAnchor, type MapAnchor } from "./mapCoordinates";
import { sessionId } from "./config";

/** Reuse the live renderer: no duplicate sensor state, synthetic mesh or estimator. */
function ParticipantOverlay({ anchor, fitSequence, overviewSequence, ...props }: RoomMapProps & { anchor: MapAnchor; fitSequence: number; overviewSequence: number }) {
  const [, update] = useState(0);
  const map = useMapEvents({ move: () => update(n => n + 1), zoom: () => update(n => n + 1), resize: () => update(n => n + 1) });
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const bounds: LatLngBoundsExpression = [roomLatLon(anchor, props.room, 0, 0), roomLatLon(anchor, props.room, props.room.w, props.room.h)];
    if (fitSequence === 0) map.setView([anchor.lat, anchor.lon], 18, { animate: false });
    else map.fitBounds(bounds, { padding: [16, 16], maxZoom: 22, animate: false });
  }, [map, anchor, props.room.w, props.room.h, fitSequence, overviewSequence]);
  useEffect(() => {
    const observer = new ResizeObserver(() => map.invalidateSize({ animate: false }));
    observer.observe(map.getContainer());
    return () => observer.disconnect();
  }, [map]);
  useEffect(() => {
    if (root.current) {
      DomEvent.disableClickPropagation(root.current);
      DomEvent.disableScrollPropagation(root.current);
    }
  }, []);
  const nw = map.latLngToContainerPoint(roomLatLon(anchor, props.room, 0, 0));
  const se = map.latLngToContainerPoint(roomLatLon(anchor, props.room, props.room.w, props.room.h));
  return <div ref={root} className="geographic-room-overlay" style={{ left: nw.x, top: nw.y, width: se.x - nw.x }}>
    <RoomMap {...props} width={Math.max(1, se.x - nw.x)} geographic />
  </div>;
}

export default function GeographicMap(props: RoomMapProps) {
  const [anchor, setAnchor] = useState<MapAnchor>(DEFAULT_MAP_ANCHOR);
  const [lat, setLat] = useState(String(DEFAULT_MAP_ANCHOR.lat));
  const [lon, setLon] = useState(String(DEFAULT_MAP_ANCHOR.lon));
  const [configured, setConfigured] = useState(false);
  const [error, setError] = useState("");
  const [tileError, setTileError] = useState(false);
  const [fitSequence, setFitSequence] = useState(0);
  const [overviewSequence, setOverviewSequence] = useState(0);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(`skymesh-map-anchor:${sessionId()}`) ?? "null");
      if (saved && validAnchor(saved)) {
        setAnchor(saved); setLat(String(saved.lat)); setLon(String(saved.lon)); setConfigured(true);
      }
    } catch { /* Storage is optional. Live mesh state is never stored here. */ }
  }, []);
  function applyAnchor() {
    const next = { lat: Number(lat), lon: Number(lon) };
    if (!lat.trim() || !lon.trim() || !validAnchor(next)) {
      setError("Enter latitude from −85 to 85 and longitude from −180 to 180.");
      return;
    }
    setAnchor(next); setConfigured(true); setError("");
    try { localStorage.setItem(`skymesh-map-anchor:${sessionId()}`, JSON.stringify(next)); } catch { /* Optional display preference. */ }
  }
  return <div className="geographic-map-shell">
    <div className="geographic-tools">
      <ActionButton onClick={() => setFitSequence(n => n + 1)}>Fit participant area</ActionButton>
      <ActionButton onClick={() => { setFitSequence(0); setOverviewSequence(n => n + 1); }}>Street overview</ActionButton>
      <details><summary>Set map anchor</summary>
        <div className="anchor-fields">
          <label>Latitude<input aria-label="Map anchor latitude" type="number" step="any" min="-85" max="85" value={lat} onChange={e => setLat(e.target.value)} /></label>
          <label>Longitude<input aria-label="Map anchor longitude" type="number" step="any" min="-180" max="180" value={lon} onChange={e => setLon(e.target.value)} /></label>
          <ActionButton onClick={applyAnchor}>Apply map anchor</ActionButton>
        </div>
        {error && <p role="alert">{error}</p>}
      </details>
    </div>
    <p className="map-anchor-note">{configured ? "Operator-set map anchor" : "Illustrative map anchor · Washington, DC"}. Participant coordinates are room-relative, not phone GPS. Pan outside the outlined participant area.</p>
    <div className="geographic-map" style={{ height: Math.max(220, Math.min(620, (props.width ?? 720) * 2 / 3 - 100)) }}>
      <MapContainer center={[anchor.lat, anchor.lon]} zoom={18} minZoom={3} maxZoom={22} scrollWheelZoom className="live-geographic-map" attributionControl>
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' maxNativeZoom={19} maxZoom={22} eventHandlers={{ tileerror: () => setTileError(true) }} />
        <ParticipantOverlay {...props} anchor={anchor} fitSequence={fitSequence} overviewSequence={overviewSequence} />
      </MapContainer>
      {tileError && <p className="map-tile-warning" role="status">Basemap tiles unavailable. Participant positions and scenario controls still work. Check network access to OpenStreetMap.</p>}
    </div>
  </div>;
}
