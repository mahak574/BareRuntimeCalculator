import React from "react";

export default function StatCards({ items }) {
  return (
    <div className="stat-cards">
      {items.map((it, i) => (
        <div key={i} className={`stat-card ${it.tone ? `stat-${it.tone}` : ""}`}>
          <div className="stat-label">{it.label}</div>
          <div className="stat-value">{it.value}</div>
          {it.hint && <div className="stat-hint">{it.hint}</div>}
        </div>
      ))}
    </div>
  );
}
