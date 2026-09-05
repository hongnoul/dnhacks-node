// net.ts — server transport: heartbeats + clip upload over HTTP POST.
// HTTP (not WebSocket) for the ingest path: simpler retries, works through
// every proxy/tunnel, and 1 Hz heartbeats don't need a socket.

import type { Fix } from "./geo";

export interface NetStats {
  heartbeatsSent: number;
  clipsSent: number;
  clipsFailed: number;
  lastServerAck: string | null;
  lastError: string | null;
}

export class ServerLink {
  public stats: NetStats = {
    heartbeatsSent: 0,
    clipsSent: 0,
    clipsFailed: 0,
    lastServerAck: null,
    lastError: null,
  };

  constructor(
    public baseUrl: string,
    public nodeId: string
  ) {}

  async heartbeat(fix: Fix | null, loudness: number): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}/ingest/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "heartbeat",
          node_id: this.nodeId,
          t: Date.now() / 1000,
          lat: fix?.lat ?? null,
          lon: fix?.lon ?? null,
          gps_accuracy_m: fix?.accuracyM ?? null,
          loudness,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.stats.heartbeatsSent++;
      this.stats.lastServerAck = new Date().toLocaleTimeString();
      this.stats.lastError = null;
    } catch (e) {
      this.stats.lastError = `heartbeat: ${String(e)}`;
    }
  }

  async sendClip(
    wav: Blob,
    meta: {
      t0: number;
      sampleRate: number;
      durationS: number;
      loudness: number;
      fix: Fix | null;
    }
  ): Promise<boolean> {
    const form = new FormData();
    form.append("file", wav, "clip.wav");
    form.append(
      "meta",
      JSON.stringify({
        type: "detection",
        node_id: this.nodeId,
        t: meta.t0,
        sample_rate: meta.sampleRate,
        duration_s: meta.durationS,
        loudness: meta.loudness,
        lat: meta.fix?.lat ?? null,
        lon: meta.fix?.lon ?? null,
        gps_accuracy_m: meta.fix?.accuracyM ?? null,
      })
    );
    try {
      const res = await fetch(`${this.baseUrl}/ingest/clip`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.stats.clipsSent++;
      this.stats.lastServerAck = new Date().toLocaleTimeString();
      this.stats.lastError = null;
      return true;
    } catch (e) {
      this.stats.clipsFailed++;
      this.stats.lastError = `clip: ${String(e)}`;
      return false;
    }
  }
}

export function randomNodeId(): string {
  return Math.random().toString(36).slice(2, 8);
}
