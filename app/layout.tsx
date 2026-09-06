import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "@carbon/styles/css/styles.css";
import "./globals.css";
import "./carbon.css";
import "./retro-tokens.css";
import "./station/retro.css";
import { DesignSystem } from "./lib/DesignSystem";

const description = "Turn phones into a drone-sensing mesh. On-device detection — audio never leaves the phone.";

// Absolute OG image URLs: link unfurlers fetch them without a page context.
// Defaults to the tunnel-friendly env var; falls back to localhost for dev.
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: "SkyMesh", template: "%s — SkyMesh" },
  description,
  applicationName: "SkyMesh",
  manifest: "/site.webmanifest",
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/favicon.ico", sizes: "16x16 32x32 48x48" },
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: [{ url: "/icon-180.png", sizes: "180x180", type: "image/png" }],
  },
  openGraph: {
    type: "website",
    siteName: "SkyMesh",
    title: "SkyMesh",
    description,
    images: [{ url: "/opengraph-image.png", width: 1200, height: 630, alt: "SkyMesh mascot — turn phones into a drone-sensing mesh" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "SkyMesh",
    description,
    images: ["/opengraph-image.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0b0f14",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="cds--g100">
      <body><DesignSystem>{children}</DesignSystem></body>
    </html>
  );
}
