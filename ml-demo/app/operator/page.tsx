"use client";

import "leaflet/dist/leaflet.css";
import dynamic from "next/dynamic";

const OperatorMap = dynamic(() => import("./OperatorMap"), { ssr: false });

export default function OperatorPage() {
  return <OperatorMap />;
}