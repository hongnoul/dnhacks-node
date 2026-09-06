// admin/page.tsx — redirect to the operator console.
//
// /station now hosts the sidebar (join QR + drone) and the dashboard together,
// so this route only preserves old bookmarks: forward ?session to /station.

"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { sessionId } from "../lib/config.ts";

export default function AdminRedirect() {
  const router = useRouter();
  const [session, setSession] = useState("");
  useEffect(() => {
    const s = sessionId();
    setSession(s);
    router.replace(`/station/?session=${s}`);
  }, [router]);
  return (
    <main style={{ padding: 24 }}>
      <p className="dim">
        The operator console moved to{" "}
        <a href={session ? `/station/?session=${session}` : "/station/"} style={{ color: "var(--accent)" }}>/station</a> — redirecting…
      </p>
    </main>
  );
}
