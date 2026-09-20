import React, { useEffect, useState } from "react";
import { api } from "../api";
import { mmss, pct } from "../utils";
import LegChart from "./LegChart";
import ConfidencePill from "./ConfidencePill";
import StatCards from "./StatCards";

export default function TrainWiseTab() {
  const [trains, setTrains] = useState([]);
  const [selected, setSelected] = useState("");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [openLeg, setOpenLeg] = useState(null); // index of expanded row
  const [legChart, setLegChart] = useState(null);
  const [legChartLoading, setLegChartLoading] = useState(false);

  useEffect(() => {
    api.trains().then((r) => setTrains(r.trains)).catch((e) => setError(e.message));
  }, []);

  const analyze = async () => {
    if (!selected) return;
    setLoading(true);
    setError(null);
    setOpenLeg(null);
    try {
      const result = await api.trainWiseBRT(selected);
      setData(result);
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
      const chart = await api.trainLegChart(selected, leg.station, leg.next_station);
      setLegChart(chart);
    } catch (e) {
      setError(e.message);
    } finally {
      setLegChartLoading(false);
    }
  };

  const [chartBounds, setChartBounds] = useState(null);

  useEffect(() => {
    api.trains().then((r) => setTrains(r.trains)).catch((e) => setError(e.message));
    api.chartBounds().then(setChartBounds).catch(() => { });
  }, []);
  return (
    <div>
      <div className="controls">
        <select value={selected} onChange={(e) => setSelected(e.target.value)}>
          <option value="">Select a train number...</option>
          {trains.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <button className="primary" onClick={analyze} disabled={!selected || loading}>
          {loading ? "Analyzing..." : "Analyze"}
        </button>
      </div>

      {error && <div className="error-box">{error}</div>}
      {loading && <div className="loading">Analyzing route…</div>}

      {data && (
        <>
          <h3 className="section-name">Route Details for Train {data.train}</h3>

          <StatCards
            items={[
              { label: "Existing Runtime (sum)", value: mmss(data.totals.existing_sum) },
              { label: "Net BRT (sum)", value: mmss(data.totals.net_sum) },
              { label: "Rounded Est. (sum)", value: mmss(data.totals.rounded_sum) },
              {
                label: "Variance",
                value: data.totals.variance_pct !== null ? pct(data.totals.variance_pct, 2) : "-",
                tone: data.totals.variance_pct < 0 ? "down" : data.totals.variance_pct > 0 ? "up" : "neutral",
                hint: data.totals.variance_pct !== null ? "Net BRT vs existing runtime" : "Insufficient paired data",
              },
            ]}
          />

          <table>
            <thead>
              <tr>
                <th></th>
                <th>Route</th>
                <th>Flag</th>
                <th>Existing Runtime</th>
                <th>Samples</th>
                <th>Raw BRT</th>
                <th>Accel</th>
                <th>Decel</th>
                <th title="Route-wide mean of Accel across legs (used only when this leg's own Accel is missing and its case needs one)">Accel Mean</th>
                <th title="Route-wide mean of Decel across legs (used only when this leg's own Decel is missing and its case needs one)">Decel Mean</th>
                <th title="T-T: Raw · T-A: Raw−Decel · D-T: Raw−Accel · D-A: Raw−Accel−Decel">Net BRT</th>
                <th>Rounded Est. Runtime</th>
              </tr>
            </thead>
            <tbody>
              {data.legs.map((leg, i) => (
                <React.Fragment key={i}>
                  <tr>
                    <td>
                      <button className="icon-btn" onClick={() => toggleLeg(i, leg)}>
                        {openLeg === i ? "−" : "+"}
                      </button>
                    </td>
                    <td>{leg.station} → {leg.next_station}</td>
                    <td>{leg.flag}</td>
                    <td>{mmss(leg.existing_runtime)}</td>
                    <td>{leg.samples}</td>
                    <td>{mmss(leg.raw_brt)}</td>
                    <td>{mmss(leg.accel)}</td>
                    <td>{mmss(leg.decel)}</td>
                    <td>{mmss(leg.accel_mean)}</td>
                    <td>{mmss(leg.decel_mean)}</td>
                    <td>{mmss(leg.net_brt)}</td>
                    <td>
                      <span className="cell-with-pill">
                        {mmss(leg.rounded_estimate)}
                        <ConfidencePill value={leg.confidence} lowConfidence={leg.low_confidence} />
                      </span>
                    </td>
                  </tr>
                  {openLeg === i && (
                    <tr className="chart-row">
                      <td colSpan={12}>
                        {legChartLoading && <div className="loading">Loading charts…</div>}
                        {legChart && (() => {
                          let xDomain, yDomain;
                          let validPoints = [];
                          if (legChart.points?.length > 0) {
                            validPoints = legChart.points.filter(p => p != null && p.minutes != null && !isNaN(p.minutes) && p.date != null);
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
                                points={legChart.points}
                                mode="raw"
                                xDomain={xDomain}
                                yDomain={yDomain}
                              />
                              <LegChart
                                title="Outlier Removal (MAD)"
                                points={legChart.points}
                                mode="outlier"
                                xDomain={xDomain}
                                yDomain={yDomain}
                              />
                              <LegChart
                                title="KMeans Clusters (k=3)"
                                points={legChart.points ? legChart.points.filter(p => !p.is_outlier) : []}
                                mode="cluster"
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
                <td></td>
                <td>TOTAL</td>
                <td></td>
                <td>{mmss(data.totals.existing_sum)}</td>
                <td></td>
                <td></td>
                <td></td>
                <td></td>
                <td></td>
                <td></td>
                <td>{mmss(data.totals.net_sum)}</td>
                <td>{mmss(data.totals.rounded_sum)}</td>
              </tr>
            </tbody>
          </table>
          <div className="variance-line">
            Variance: {data.totals.variance_pct !== null ? pct(data.totals.variance_pct, 2) : "- (insufficient paired data)"}
          </div>
        </>
      )}
    </div>
  );
}
