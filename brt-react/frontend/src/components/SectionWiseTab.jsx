import React, { useEffect, useState } from "react";
import { api } from "../api";
import { mmss, pct } from "../utils";
import LegChart from "./LegChart";
import ConfidencePill from "./ConfidencePill";
import StatCards from "./StatCards";

const METRIC_FIELDS = ["existing", "raw", "accel", "decel", "accel_mean", "decel_mean", "net_brt", "round_ad"];
const METRIC_LABELS = ["Exist.", "Raw", "Accel", "Decel", "AccelM", "DecelM", "Net", "Round"];

export default function SectionWiseTab() {
  const [sections, setSections] = useState([]);
  const [selected, setSelected] = useState("");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [openLeg, setOpenLeg] = useState(null);
  const [legChart, setLegChart] = useState(null);
  const [legChartLoading, setLegChartLoading] = useState(false);
  const [speedFilter, setSpeedFilter] = useState(""); // always a real speed once data loads

  useEffect(() => {
    api.sections().then((r) => setSections(r.sections)).catch((e) => setError(e.message));
  }, []);

  const analyze = async () => {
    if (!selected) return;
    setLoading(true);
    setError(null);
    setOpenLeg(null);
    try {
      const result = await api.sectionWiseBRT(selected);
      setData(result);
      setSpeedFilter(result.speed_classes?.[0] || "");
    } catch (e) {
      setError(e.message);
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  const toggleLeg = async (i, leg) => {
    if (openLeg === i) {
      setOpenLeg(null);
      return;
    }
    setOpenLeg(i);
    setLegChart(null);
    setLegChartLoading(true);
    try {
      const speedTrains = speedFilter ? leg.speed_classes?.[speedFilter]?.trains : null;
      const trainList = speedTrains && speedTrains.length ? speedTrains : leg.trains.map(String);
      const chart = await api.sectionLegChart(leg.station, leg.next_station, trainList);
      setLegChart(chart);
    } catch (e) {
      setError(e.message);
    } finally {
      setLegChartLoading(false);
    }
  };

  const renderCell = (mps, field, metrics) => {
    if (!metrics) return <td key={mps + field}>-</td>;

    if (field === "round_ad") {
      return (
        <td key={mps + field}>
          <span className="cell-with-pill">
            {mmss(metrics[field])}
            <ConfidencePill value={metrics.confidence} lowConfidence={metrics.low_confidence} />
          </span>
        </td>
      );
    }
    return <td key={mps + field}>{mmss(metrics[field])}</td>;
  };

  return (
    <div>
      <div className="controls">
        <select value={selected} onChange={(e) => setSelected(e.target.value)}>
          <option value="">Select a section...</option>
          {sections.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <button className="primary" onClick={analyze} disabled={!selected || loading}>
          {loading ? "Analyzing..." : "Analyze"}
        </button>
      </div>

      {error && <div className="error-box">{error}</div>}
      {loading && <div className="loading">Analyzing section…</div>}

      {data && (() => {
        const shownSpeeds = speedFilter ? [speedFilter] : data.speed_classes;
        const shownTrains = speedFilter
          ? data.trains_summary.filter(
              (t) => t.mps !== null && t.mps !== undefined && Math.round(t.mps) === Math.round(parseFloat(speedFilter))
            )
          : data.trains_summary;

        return (
          <>
            <h3 className="section-name">{data.section}</h3>

            <div className="controls" style={{ marginBottom: 10 }}>
              <label className="data-label" style={{ marginRight: 4 }}>Speed:</label>
              <select
                value={speedFilter}
                onChange={(e) => {
                  setSpeedFilter(e.target.value);
                  setOpenLeg(null);
                  setLegChart(null);
                }}
              >
                {data.speed_classes.map((mps) => (
                  <option key={mps} value={mps}>{Math.round(parseFloat(mps))} MPS</option>
                ))}
              </select>
            </div>

            {shownTrains.length > 0 && (
              <div className="caption">
                Trains on this section{speedFilter ? ` at ${Math.round(parseFloat(speedFilter))} MPS` : ""}: {shownTrains.map((t) => `${t.train} (${t.mps ? `${Math.round(t.mps)} MPS` : "no MPS"})`).join(", ")}
              </div>
            )}

            {speedFilter && (
              <StatCards
                items={[
                  { label: "Existing (sum)", value: data.counts[speedFilter]?.existing > 0 ? mmss(data.totals[speedFilter]?.existing) : "-" },
                  { label: "Net BRT (sum)", value: data.counts[speedFilter]?.net_brt > 0 ? mmss(data.totals[speedFilter]?.net_brt) : "-" },
                  { label: "Rounded Est. (sum)", value: data.counts[speedFilter]?.round_ad > 0 ? mmss(data.totals[speedFilter]?.round_ad) : "-" },
                  {
                    label: "Variance",
                    value: data.variance_pct[speedFilter] !== null && data.variance_pct[speedFilter] !== undefined
                      ? pct(data.variance_pct[speedFilter]) : "-",
                    tone: data.variance_pct[speedFilter] < 0 ? "down" : data.variance_pct[speedFilter] > 0 ? "up" : "neutral",
                    hint: "Net BRT vs existing runtime",
                  },
                ]}
              />
            )}

            <div style={{ overflowX: "auto" }}>
              <table>
                <thead>
                  <tr>
                    <th></th>
                    {shownSpeeds.map((mps) => (
                      <th key={mps} colSpan={METRIC_FIELDS.length}>{Math.round(parseFloat(mps))} MPS</th>
                    ))}
                  </tr>
                  <tr>
                    <th>Block Set</th>
                    {shownSpeeds.map((mps) =>
                      METRIC_LABELS.map((label) => <th key={mps + label} style={{ fontSize: "0.72rem" }}>{label}</th>)
                    )}
                  </tr>
                </thead>
                <tbody>
                  {data.legs.map((leg, i) => (
                    <React.Fragment key={i}>
                      <tr>
                        <td>
                          <button className="ghost" onClick={() => toggleLeg(i, leg)}>
                            {openLeg === i ? "−" : "+"} {leg.station} → {leg.next_station}
                          </button>
                        </td>
                        {shownSpeeds.map((mps) =>
                          METRIC_FIELDS.map((f) => renderCell(mps, f, leg.speed_classes[mps]))
                        )}
                      </tr>
                      {openLeg === i && (
                        <tr className="chart-row">
                          <td colSpan={1 + shownSpeeds.length * METRIC_FIELDS.length}>
                            {legChartLoading && <div className="loading">Loading block charts…</div>}
                            {legChart && (() => {
                              let xDomain, yDomain;
                              let validPoints = [];
                              if (legChart.pooled?.points?.length > 0) {
                                validPoints = legChart.pooled.points.filter(p => p != null && p.minutes != null && !isNaN(p.minutes) && p.date != null);
                                if (validPoints.length > 0) {
                                  const xs = validPoints.map(p => new Date(p.date).getTime());
                                  const ys = validPoints.map(p => p.minutes);
                                  const minX = Math.min(...xs);
                                  const maxX = Math.max(...xs);
                                  const minY = Math.min(...ys);
                                  const maxY = Math.max(...ys);
                                  const xPad = (maxX - minX) * 0.05 || 86400000;
                                  const yPad = (maxY - minY) * 0.05 || 1;
                                  xDomain = [minX - xPad, maxX + xPad];
                                  yDomain = [Math.max(0, minY - yPad), maxY + yPad];
                                }
                              }
                              return (
                                <div className="chart-grid chart-row-anim">
                                  <LegChart
                                    title={`All Samples — ${leg.station} → ${leg.next_station}`}
                                    subtitle={`Samples = ${legChart.pooled?.samples ?? 0}`}
                                    points={legChart.pooled?.points}
                                    mode="raw"
                                    xDomain={xDomain}
                                    yDomain={yDomain}
                                  />
                                  <LegChart
                                    title="Outlier Removal (Median Absolute Deviation)"
                                    subtitle={`kept ${legChart.kept_count ?? 0}, outliers ${legChart.outlier_count ?? 0}`}
                                    points={legChart.pooled?.points}
                                    mode="outlier"
                                    xDomain={xDomain}
                                    yDomain={yDomain}
                                  />
                                  <LegChart
                                    title="Journey Profile"
                                    points={legChart.combo_points || []}
                                    mode="combo"
                                    xDomain={xDomain}
                                    yDomain={yDomain}
                                  />
                                  <LegChart
                                    title={`KMeans Clusters (k=3) & majority combo: ${legChart.dominant_combo || "N/A"}`}
                                    points={legChart.cluster_points || []}
                                    mode="cluster3"
                                    xDomain={xDomain}
                                    yDomain={yDomain}
                                  />
                                </div>
                              );
                            })()}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                  <tr className="total-row">
                    <td>TOTAL (sum of legs with data)</td>
                    {shownSpeeds.map((mps) =>
                      METRIC_FIELDS.map((f) => (
                        <td key={mps + f}>
                          {data.counts[mps]?.[f] > 0 ? mmss(data.totals[mps]?.[f]) : "-"}
                        </td>
                      ))
                    )}
                  </tr>
                  <tr>
                    <td><strong>Variance: Net BRT vs Existing</strong></td>
                    {shownSpeeds.map((mps) =>
                      METRIC_FIELDS.map((f, fi) => (
                        <td key={mps + f}>
                          {fi === METRIC_FIELDS.length - 1
                            ? (data.variance_pct[mps] !== null ? <strong>{pct(data.variance_pct[mps])}</strong> : "-")
                            : ""}
                        </td>
                      ))
                    )}
                  </tr>
                </tbody>
              </table>
            </div>
          </>
        );
      })()}
    </div>
  );
}
