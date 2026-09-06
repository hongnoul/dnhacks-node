"use client";
import type { ButtonHTMLAttributes, ReactNode } from "react";
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
  return <Header aria-label="SkyMesh" className="operations-shell">
    <HeaderName prefix="">SkyMesh <span className="shell-product">/ Operations</span></HeaderName>
    <nav className="operations-nav" aria-label="Workspace sections">
      <a href="#participant-map">Map</a>
      <a href="#participants">Participants</a>
      <a href="#scenarios">Scenarios</a>
    </nav>
    <div className="shell-meta"><Tag type="blue" size="sm">Live participant mesh</Tag></div>
  </Header>;
}
