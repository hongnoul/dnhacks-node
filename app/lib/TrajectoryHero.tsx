"use client";

import styles from "./TrajectoryHero.module.css";

const tracks = [
  { id: "01", color: "#000000", path: "M -40 650 C 100 650 120 180 350 155 S 660 270 810 105 S 1150 120 1460 30", duration: "32s", delay: "-9s", x: 350, y: 155 },
  { id: "02", color: "#000000", path: "M 1480 640 C 1150 780 1180 340 1030 240 S 820 40 660 90 S 450 220 250 -40", duration: "39s", delay: "-18s", x: 1030, y: 240 },
  { id: "03", color: "#000000", path: "M -80 320 C 160 280 200 740 450 715 S 780 500 1000 650 S 1250 780 1470 410", duration: "36s", delay: "-25s", x: 450, y: 715 },
  { id: "04", color: "#000000", path: "M 100 -60 C 20 220 370 300 170 530 S 470 920 700 820 S 1050 700 1370 850", duration: "43s", delay: "-13s", x: 170, y: 530 },
];

export function TrajectoryHero() {
  return <>
    <div className={styles.scene} aria-hidden="true" data-trajectory-hero>
      <svg className={styles.map} viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice">
        <defs>
          <pattern id="trajectory-grid" width="60" height="60" patternUnits="userSpaceOnUse">
            <path d="M60 0H0V60" fill="none" stroke="#777" strokeWidth="1" />
          </pattern>
        </defs>

        <g fill="none" stroke="#777" strokeWidth="1">
          <circle cx="720" cy="450" r="240" /><circle cx="720" cy="450" r="400" />
          <path d="M720 0V900M0 450H1440" strokeDasharray="4 12" />
        </g>
        {tracks.map(track => <g key={track.id} style={{ color: track.color }}>
          <path d={track.path} fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.25" />
          <path d={track.path} fill="none" stroke="currentColor" strokeWidth="5" opacity="0.025" />
          <g transform={`translate(${track.x} ${track.y})`}>
            <circle r="5" fill="#c0c0c0" stroke="currentColor" strokeWidth="2" />
            <path d="M-12 0H12M0-12V12" stroke="currentColor" />
          </g>
          <g data-drone={track.id} className={styles.drone} style={{ offsetPath: `path('${track.path}')`, animationDuration: track.duration, animationDelay: track.delay }}>
            <circle r="15" fill="currentColor" opacity="0.14" />
            <path d="M-7-7L7 7M-7 7L7-7" stroke="currentColor" strokeWidth="2" />
            <circle r="3" fill="#000" />
            <g fill="none" stroke="currentColor"><circle cx="-7" cy="-7" r="3"/><circle cx="7" cy="7" r="3"/><circle cx="-7" cy="7" r="3"/><circle cx="7" cy="-7" r="3"/></g>
          </g>
        </g>)}
      </svg>
    </div>

  </>;
}
