export function mmss(minutes) {
  if (minutes === null || minutes === undefined || Number.isNaN(minutes)) return "-";
  const totalSeconds = Math.round(minutes * 60);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function pct(v, digits = 1) {
  if (v === null || v === undefined || Number.isNaN(v)) return "-";
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(digits)}%`;
}

export function confidenceBand(c) {
  if (c === null || c === undefined || Number.isNaN(c)) return "unknown";
  if (c >= 0.7) return "high";
  if (c >= 0.4) return "mid";
  return "low";
}

const SOURCE_LABELS = {
  local: "this leg's own data",
  block_mps: "same block, same speed class",
  distance_mps: "similar-distance blocks, same section & speed class",
  train_mps: "same train, same speed class (all blocks)",
  mps: "fleet average, same speed class",
  tt_fallback: "T-T mean (no D/A samples)",
  physics_formula: "distance ÷ speed",
  none: "no data available",
};

export function sourceLabel(src) {
  if (!src) return null;
  return SOURCE_LABELS[src] || src;
}

const SOURCE_SHORT = {
  local: "leg",
  block_mps: "block",
  distance_mps: "section",
  train_mps: "train",
  mps: "fleet",
  tt_fallback: "T-T",
  physics_formula: "physics",
  none: "—",
};

export function sourceShort(src) {
  if (!src) return null;
  return SOURCE_SHORT[src] || src;
}
