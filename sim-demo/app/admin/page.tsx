// admin/page.tsx — redirect to the operator console.
//
// /station now hosts the sidebar (join QR + drone) and the dashboard together,
// so this route only preserves old bookmarks: forward ?session to /station.

"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { sessionId } from "../lib/config.ts";

export default function AdminRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace(`/station/?session=${sessionId()}`);
  }, [router]);
  return (
    <main style={{ padding: 24 }}>
      <p className="dim">
        The operator console moved to{" "}
        <a href="/station/" style={{ color: "var(--accent)" }}>/station</a> — redirecting…
      </p>
    </main>
  );
}
