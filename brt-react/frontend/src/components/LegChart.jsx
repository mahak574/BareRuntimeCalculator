import React from "react";
import {
  ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ReferenceLine, ResponsiveContainer, Cell,
} from "recharts";
import { mmss } from "../utils";

const CLUSTER_COLORS = ["#ff9d4d", "#4f7cff", "#4dd68c", "#c88fff", "#d9a066"];
const KEPT_COLOR = "#1fa971";
const OUTLIER_COLOR = "#e5484d";
const RAW_COLOR = "#4f7cff";
const LOWER_CLUSTER_COLOR = "#4f7cff";
const COMBO_COLORS = { "T-T": "#4f7cff", "D-T": "#ff9d4d", "T-A": "#2ca02c", "D-A": "#e5484d" };
const COMBO_ORDER = ["T-T", "D-T", "T-A", "D-A"];


export default function LegChart({ title, subtitle, points, mode, xDomain, yDomain }) {
  if (!points || points.length === 0) {
    return (
      <div className="chart-card">
        <div className="chart-title">{title}</div>
        <div className="loading">Not enough data</div>
      </div>
    );
  }

  const data = points.map((p) => ({
    x: new Date(p.date).getTime(),
    y: p.minutes,
    is_outlier: p.is_outlier,
    cluster: p.cluster,
    is_lower_cluster: p.is_lower_cluster,
    combo: p.combo,
  }));

  const colorFor = (d) => {
    if (mode === "outlier") return d.is_outlier ? OUTLIER_COLOR : KEPT_COLOR;
    if (mode === "cluster3" || mode === "cluster") {
      if (d.cluster === null || d.cluster === undefined) return "#9aa0b4";
      return CLUSTER_COLORS[d.cluster % CLUSTER_COLORS.length];
    }
    if (mode === "combo") return COMBO_COLORS[d.combo] || "#9aa0b4";
    return RAW_COLOR;
  };

  let legendPayload = [{ value: "Travel Time", type: "circle", color: RAW_COLOR }];
  let meanLines = [];

  if (mode === "outlier") {
    legendPayload = [
      { value: "Kept", type: "circle", color: KEPT_COLOR },
      { value: "Outlier", type: "circle", color: OUTLIER_COLOR },
    ];
  }

  if (mode === "cluster") {
    const clusterKeys = [...new Set(data.map((d) => d.cluster))].filter((c) => c !== null && c !== undefined);
    legendPayload = clusterKeys.map((c) => {
      const isLower = data.some((d) => d.cluster === c && d.is_lower_cluster);
      const color = CLUSTER_COLORS[c % CLUSTER_COLORS.length];
      const ys = data.filter((d) => d.cluster === c).map((d) => d.y);
      const mean = ys.reduce((a, b) => a + b, 0) / ys.length;
      meanLines.push({ y: mean, stroke: color });
      return { value: isLower ? `Lower (Raw): ${mmss(mean)}` : `C${c}: ${mmss(mean)}`, type: "circle", color };
    });
  }

  if (mode === "cluster3") {
    const clusterKeys = [...new Set(data.map((d) => d.cluster))]
      .filter((c) => c !== null && c !== undefined)
      .sort((a, b) => a - b);
    legendPayload = clusterKeys.map((c) => {
      const isLower = data.some((d) => d.cluster === c && d.is_lower_cluster);
      const color = CLUSTER_COLORS[c % CLUSTER_COLORS.length];
      const ys = data.filter((d) => d.cluster === c).map((d) => d.y);
      const mean = ys.reduce((a, b) => a + b, 0) / ys.length;
      meanLines.push({ y: mean, stroke: color });
      return { value: isLower ? `C${c} Lower: ${mmss(mean)}` : `C${c}: ${mmss(mean)}`, type: "circle", color };
    });
  }

  if (mode === "combo") {
    const combosPresent = COMBO_ORDER.filter((c) => data.some((d) => d.combo === c));
    legendPayload = combosPresent.map((c) => {
      const ys = data.filter((d) => d.combo === c).map((d) => d.y);
      const mean = ys.reduce((a, b) => a + b, 0) / ys.length;
      meanLines.push({ y: mean, stroke: COMBO_COLORS[c] });
      return { value: `${c} (${mmss(mean)})`, type: "circle", color: COMBO_COLORS[c] };
    });
  }

  return (
    <div className="chart-card">
      <div className="chart-title">{title}</div>
      {subtitle && <div className="chart-subtitle">{subtitle}</div>}
      <ResponsiveContainer width="100%" height={260}>
        <ScatterChart margin={{ top: 15, right: 15, bottom: 25, left: 0 }}>
          <CartesianGrid stroke="#e3e6f0" />
          <XAxis
            height={40}
            label={{ value: 'Date', position: 'insideBottom', offset: -10 }}
            dataKey="x"
            type="number"
            domain={xDomain || ["dataMin", "dataMax"]}
            tickFormatter={(v) => new Date(v).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
            tick={{ fontSize: 10, fill: "#6b7189" }}
            stroke="#c7cbdb"
          />
          <YAxis
            dataKey="y"
            domain={yDomain || ["auto", "auto"]}
            tickFormatter={(v) => typeof v === 'number' ? Number(v.toFixed(2)) : v}
            tick={{ fontSize: 10, fill: "#6b7189" }}
            stroke="#c7cbdb"
            label={{ value: "min", angle: -90, position: "insideLeft", fontSize: 10, fill: "#6b7189" }}
          />
          <Tooltip
            contentStyle={{ background: "#ffffff", border: "1px solid #dfe2ee", fontSize: 11, borderRadius: 6 }}
            labelFormatter={(v) => new Date(v).toLocaleDateString()}
            formatter={(value, _name, item) => [
              `${value.toFixed(2)} min${item?.payload?.combo ? ` (${item.payload.combo})` : ""}`,
              "Travel Time",
            ]}
          />
          <Legend
            payload={legendPayload}
            wrapperStyle={{
              position: "absolute",
              width: "288px",
              height: "auto",
              left: "-15px",
              bottom: "0",
              fontSize: "11px",
              paddingTop: "12px",
              right: "0px"
            }}
          />

          <Scatter data={data} fill={RAW_COLOR}>
            {data.map((d, i) => (
              <Cell key={i} fill={colorFor(d)} fillOpacity={mode === "cluster" && d.is_lower_cluster ? 1 : 0.75} />
            ))}
          </Scatter>
          {meanLines.map((ml, i) => (
            <ReferenceLine key={`ml-${i}`} y={ml.y} stroke={ml.stroke} strokeDasharray="4 4" strokeWidth={1.5} />
          ))}
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}
