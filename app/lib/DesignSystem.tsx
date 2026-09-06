"use client";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Button, GlobalTheme, Header, HeaderName, Tag } from "@carbon/react";
export function DesignSystem({ children }: { children: ReactNode }) {
  return <GlobalTheme theme="g100">{children}</GlobalTheme>;
}
/** Keep native event handlers while centralizing Carbon action hierarchy. */
export function ActionButton({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  const classes = className.split(/\s+/);
  const kind = classes.includes("danger") ? "danger--tertiary" : classes.includes("primary") ? "primary" : "tertiary";
  return <Button {...props} type={props.type ?? "button"} size="md" kind={kind}
    className={classes.filter(c => c !== "primary" && c !== "danger").join(" ")} />;
}
export function OperationsHeader() {
  const simulation = usePathname().startsWith("/operator");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const session = new URLSearchParams(window.location.search).get("session");
    setSearch(session ? `?session=${encodeURIComponent(session)}` : "");
  }, []);
  return <Header aria-label="SkyMesh" className="operations-shell">
    <HeaderName prefix="">SkyMesh <span className="shell-product">/ Operations</span></HeaderName>
    <nav className="operations-nav" aria-label="Operations mode">
      <a href={`/station/${search}`} aria-current={!simulation ? "page" : undefined}>Live sensors</a>
      <a href={`/operator/${search}`} aria-current={simulation ? "page" : undefined}>Simulation</a>
    </nav>
    <div className="shell-meta"><Tag type={simulation ? "purple" : "blue"} size="sm">{simulation ? "Synthetic data" : "Distributed sensing"}</Tag></div>
  </Header>;
}
