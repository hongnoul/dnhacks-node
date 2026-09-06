"use client";

// /tone — demo station: QR to the apex node page + drone flying sound
// effect video (YouTube embed). Play the video at full volume near the
// listening phone so the on-device CRNN verdict slams to ~100%.
//
// Usage: MacBook shows this page. iPhone scans the QR, opens the apex node
// page, Start listening. Play the drone video, volume 100%, hold the MacBook
// speaker 10-30 cm from the iPhone mic. Expect 🚨 DRONE DETECTED in ~1 s.
//
// Audio credit: Drone Audio Detection Samples (DADS, MIT),
// https://huggingface.co/datasets/geronimobasso/drone-audio-detection-samples
// Video: "Drone Flying Sound Effect", https://www.youtube.com/watch?v=t4FoCnVLgag

import QRCode from "react-qr-code";

// Apex = production node page the phone opens.
const APEX_URL = "https://dnhacks-node.vercel.app";

// Drone flying sound effect video.
const DRONE_YT_WATCH = "https://www.youtube.com/watch?v=t4FoCnVLgag";
const DRONE_YT_EMBED = "https://www.youtube.com/embed/t4FoCnVLgag";

// Wind + music sound externality demos (false-positive stress tests).
const WIND_YT_EMBED = "https://www.youtube.com/embed/sT5f1jBJHng";
const MUSIC_YT_EMBED = "https://www.youtube.com/embed/kRqCxuF2bms";

export default function TonePage() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "row",
        alignItems: "stretch",
        fontFamily: "-apple-system, sans-serif",
      }}
    >
      <aside
        data-testid="side-panel"
        style={{
          flex: "0 0 25%",
          minWidth: 220,
          maxWidth: 320,
          borderRight: "1px solid #e5e7eb",
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 20,
          alignItems: "stretch",
        }}
      >
        <QRCode value={APEX_URL} size={180} data-testid="apex-qr" />

        <iframe
          data-testid="drone-video"
          width="100%"
          height="180"
          style={{ borderRadius: 12, border: "1px solid #e5e7eb" }}
          src={DRONE_YT_EMBED}
          title="Drone flying sound effect"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
        />
        <a
          href={DRONE_YT_WATCH}
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontSize: 13, color: "#2563eb" }}
        >
          Open drone video on YouTube
        </a>

        <iframe
          data-testid="wind-embed"
          width="100%"
          height="180"
          style={{ borderRadius: 12, border: "1px solid #e5e7eb" }}
          src={WIND_YT_EMBED}
          title="Wind sound externality demo"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
        />

        <iframe
          data-testid="music-embed"
          width="100%"
          height="180"
          style={{ borderRadius: 12, border: "1px solid #e5e7eb" }}
          src={MUSIC_YT_EMBED}
          title="Music sound externality demo"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
        />

      </aside>

      <div style={{ flex: 1 }} />
    </main>
  );
}
