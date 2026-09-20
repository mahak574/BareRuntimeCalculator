import React from "react";
import { confidenceBand } from "../utils";

export default function ConfidencePill({ value, lowConfidence }) {
  if (value === null || value === undefined) return <span className="conf-pill conf-unknown">—</span>;

  const band = confidenceBand(value);
  const pct = Math.round(value * 100);
  const title = lowConfidence
    ? `${pct}% confidence — accel/decel had to fall back to pooled data`
    : `${pct}% confidence`;

  return (
    <span className={`conf-pill conf-${band}`} title={title}>
      <span className="conf-dot" />
    </span>
  );
}
