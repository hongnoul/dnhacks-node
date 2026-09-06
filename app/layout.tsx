import type { ReactNode } from "react";
import "@carbon/styles/css/styles.css";
import "./globals.css";
import "./carbon.css";
import "./retro-tokens.css";
import "./station/retro.css";
import { DesignSystem } from "./lib/DesignSystem";

export const metadata = { title: "SkyMesh" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="cds--g100">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      </head>
      <body><DesignSystem>{children}</DesignSystem></body>
    </html>
  );
}
