import React, { useState, useRef } from "react";
import { api } from "../api";
import Papa from "papaparse";
import * as XLSX from "xlsx";

/**
 * Parse a File (CSV or Excel) and return normalized row objects
 * matching the column format expected by goodsSpeedCalculator:
 * cavtrainnumb, cavtraintype, cavblcksctnname, canrunningtime, cavdrtn
 */
async function parseSpeedFile(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  return new Promise((resolve, reject) => {
    if (ext === "csv") {
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: (result) => {
          const rows = result.data.map(normalizeSpeedRow);
          resolve(rows);
        },
        error: (err) => reject(err),
      });
    } else if (ext === "xlsx" || ext === "xls") {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const workbook = XLSX.read(e.target.result, { type: "array" });
          let allRows = [];
          workbook.SheetNames.forEach((sheetName) => {
            const ws = workbook.Sheets[sheetName];
            const raw = XLSX.utils.sheet_to_json(ws, { defval: "" });
            allRows = allRows.concat(raw.map(normalizeSpeedRow));
          });
          resolve(allRows);
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = (err) => reject(err);
      reader.readAsArrayBuffer(file);
    } else {
      reject(new Error(`Unsupported file type: .${ext}`));
    }
  });
}

function normalizeSpeedRow(raw) {
  const keyMap = {};
  Object.entries(raw).forEach(([k, v]) => {
    keyMap[k.toLowerCase().replace(/[\s_]/g, "")] = v;
  });

  const get = (...aliases) => {
    for (const a of aliases) {
      if (keyMap[a] !== undefined && keyMap[a] !== "") return keyMap[a];
    }
    return "";
  };

  return {
    cavtrainnumb: String(get("cavtrainnumb", "trainnumb", "trainno", "train")).trim(),
    cavtraintype: String(get("cavtraintype", "traintype", "type")).trim(),
    cavblcksctnname: String(get("cavblcksctnname", "blcksctnname", "blocksection", "section")).trim().toUpperCase(),
    canrunningtime: Number(get("canrunningtime", "runningtime", "runtime")),
    cavdrtn: String(get("cavdrtn", "drtn", "direction", "dir")).trim().toUpperCase(),
  };
}

/**
 * Aggregate raw speed rows into a compact config object keyed by
 * `${dir}_${blockCode}_${loadType}` → median runtime.
 * This is tiny compared to raw rows and fits in localStorage easily.
 */
function aggregateSpeedRows(rows) {
  const buckets = {};
  rows.forEach((r) => {
    const block = r.cavblcksctnname;
    const rt = r.canrunningtime;
    if (!block || isNaN(rt) || rt <= 0) return;

    // Determine loadType
    let loadType = null;
    const trainNumb = r.cavtrainnumb || "";
    const trainType = (r.cavtraintype || "").toUpperCase();
    if (!trainNumb) {
      const fc = trainType.charAt(0);
      if (fc === "L") loadType = "LOADED";
      else if (fc === "E") loadType = "EMPTY";
    } else {
      loadType = "COACHING";
    }
    if (!loadType) return;

    // Direction
    const dirRaw = (r.cavdrtn || "").toUpperCase();
    let dir = null;
    if (dirRaw === "DN" || dirRaw === "FORWARD" || dirRaw === "DOWN") dir = "forward";
    else if (dirRaw === "UP" || dirRaw === "BACKWARD") dir = "backward";
    if (!dir) return;

    const key = `${dir}_${block}_${loadType}`;
    if (!buckets[key]) buckets[key] = [];
    buckets[key].push(rt);
  });

  // Compute median for each bucket
  const config = {};
  Object.entries(buckets).forEach(([key, vals]) => {
    if (vals.length === 0) return;
    const sorted = [...vals].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
    // Round to nearest 0.25 min (same as goodsSpeedCalculator)
    config[key] = Math.max(0.25, Math.round((median / 60) * 4) / 4); // convert sec→min
  });
  return config;
}

export default function DataTab() {
  const [movementFile, setMovementFile] = useState(null);
  const [masterFile, setMasterFile] = useState(null);
  const [routeFile, setRouteFile] = useState(null);
  const [scheduleFile, setScheduleFile] = useState(null);
  const [speedFiles, setSpeedFiles] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [processingSpeed, setProcessingSpeed] = useState(false);
  const [status, setStatus] = useState(null);
  const [speedStatus, setSpeedStatus] = useState(null);
  const speedInputRef = useRef(null);

  const getStoredCount = () => {
    try {
      const s = localStorage.getItem("SPEED_DATA_CONFIG");
      if (!s) return 0;
      return Object.keys(JSON.parse(s)).length;
    } catch {
      return 0;
    }
  };

  const [speedRowCount, setSpeedRowCount] = useState(getStoredCount);

  const upload = async () => {
    if (!movementFile && !masterFile && !routeFile && !scheduleFile) {
      setStatus({ type: "error", text: "Choose at least one file to upload." });
      return;
    }
    setUploading(true);
    setStatus(null);
    try {
      const res = await api.uploadData(movementFile, masterFile, routeFile, scheduleFile);
      const isTrainDataChanged = res.uploaded.some(f =>
        f === (movementFile?.name) || f === (masterFile?.name)
      );
      const isLayoutChanged = routeFile || scheduleFile;
      const trainMsg = isTrainDataChanged ? ` — ${res.trains} trains found` : '';
      setStatus({
        type: "ok",
        text: `Uploaded: ${res.uploaded.join(", ")}. Reloaded in ${res.load_time_sec?.toFixed(2)}s${trainMsg}${isLayoutChanged ? ' — Station Layout will refresh automatically.' : ''}`,
      });
      // Notify StationLayoutTab to re-fetch fresh layout data
      if (isLayoutChanged) {
        sessionStorage.setItem('layoutRefreshPending', '1');
        window.dispatchEvent(new Event("layoutDataUpdated"));
      }
      setMovementFile(null);
      setMasterFile(null);
      setRouteFile(null);
      setScheduleFile(null);
    } catch (e) {
      setStatus({ type: "error", text: e.message });
    } finally {
      setUploading(false);
    }
  };

  const handleSpeedFilesChange = (e) => {
    const files = Array.from(e.target.files || []);
    setSpeedFiles((prev) => {
      const existing = new Set(prev.map((f) => f.name));
      const newOnes = files.filter((f) => !existing.has(f.name));
      return [...prev, ...newOnes];
    });
    // Reset input so same file can be re-added after removal
    if (speedInputRef.current) speedInputRef.current.value = "";
  };

  const removeSpeedFile = (name) => {
    setSpeedFiles((prev) => prev.filter((f) => f.name !== name));
  };

  const processSpeedFiles = async () => {
    if (speedFiles.length === 0) {
      setSpeedStatus({ type: "error", text: "Add at least one speed data file." });
      return;
    }
    setProcessingSpeed(true);
    setSpeedStatus(null);
    try {
      let allRows = [];
      for (const file of speedFiles) {
        const rows = await parseSpeedFile(file);
        allRows = allRows.concat(rows);
      }
      const validRows = allRows.filter(
        (r) => r.cavblcksctnname && !isNaN(r.canrunningtime) && r.canrunningtime > 0
      );
      // Aggregate into compact config (tiny size) instead of storing raw rows
      const compactConfig = aggregateSpeedRows(validRows);
      const sectionCount = Object.keys(compactConfig).length;
      localStorage.setItem("SPEED_DATA_CONFIG", JSON.stringify(compactConfig));
      window.dispatchEvent(new Event("speedDataUpdated"));
      setSpeedRowCount(sectionCount);
      setSpeedStatus({
        type: "ok",
        text: `✅ Processed ${speedFiles.length} file(s) — ${validRows.length.toLocaleString()} rows → ${sectionCount} section/direction/load combinations saved. Simulation will now use this data for Default Goods / Coaching speed.`,
      });
    } catch (e) {
      setSpeedStatus({ type: "error", text: `Failed to parse files: ${e.message}` });
    } finally {
      setProcessingSpeed(false);
    }
  };

  const clearSpeedData = () => {
    localStorage.removeItem("SPEED_DATA_CONFIG");
    setSpeedFiles([]);
    setSpeedRowCount(0);
    setSpeedStatus({ type: "ok", text: "Speed data cleared. Simulation will fall back to built-in parquet data." });
  };

  return (
    <div className="data-tab">
      <div className="data-header">
        <h3 className="section-name">Data Management Hub</h3>
        <p className="caption">
          Upload any format (CSV or XLSX). Files are automatically converted and instantly processed.
        </p>
      </div>

      {/* ─── Main Data Files ─── */}
      <div className="upload-grid">
        <label className={`upload-card ${movementFile ? "selected" : ""}`}>
          <input type="file" accept=".csv,.xlsx,.xls" onChange={(e) => setMovementFile(e.target.files?.[0] || null)} />
          <div className="upload-icon">{movementFile ? "✅" : "🚆"}</div>
          <h4>Movement Data</h4>
          <span className="file-name">{movementFile ? movementFile.name : "Click to select file"}</span>
        </label>

        <label className={`upload-card ${masterFile ? "selected" : ""}`}>
          <input type="file" accept=".csv,.xlsx,.xls" onChange={(e) => setMasterFile(e.target.files?.[0] || null)} />
          <div className="upload-icon">{masterFile ? "✅" : "📊"}</div>
          <h4>Master Config</h4>
          <span className="file-name">{masterFile ? masterFile.name : "Click to select file"}</span>
        </label>

        <label className={`upload-card ${routeFile ? "selected" : ""}`}>
          <input type="file" accept=".csv,.xlsx,.xls" onChange={(e) => setRouteFile(e.target.files?.[0] || null)} />
          <div className="upload-icon">{routeFile ? "✅" : "🗺️"}</div>
          <h4>Route File</h4>
          <span className="file-name">{routeFile ? routeFile.name : "Click to select file"}</span>
        </label>

        <label className={`upload-card ${scheduleFile ? "selected" : ""}`}>
          <input type="file" accept=".csv,.xlsx,.xls" onChange={(e) => setScheduleFile(e.target.files?.[0] || null)} />
          <div className="upload-icon">{scheduleFile ? "✅" : "🗓️"}</div>
          <h4>Schedule File</h4>
          <span className="file-name">{scheduleFile ? scheduleFile.name : "Click to select file"}</span>
        </label>
      </div>

      <div className="upload-actions">
        <button className="primary mega-btn" onClick={upload} disabled={uploading}>
          {uploading ? "Syncing Data..." : "Upload & Sync Workspace"}
        </button>
      </div>

      {status && (
        <div className={status.type === "ok" ? "success-box" : "error-box"}>{status.text}</div>
      )}

      {/* ─── Goods / Coaching Speed Data ─── */}
      <div style={{ marginTop: "32px", borderTop: "2px dashed #cbd5e1", paddingTop: "24px" }}>
        <div className="data-header" style={{ marginBottom: "12px" }}>
          <h3 className="section-name">🚅 Goods / Coaching Speed Data</h3>
          <p className="caption">
            Upload one or more CSV / Excel files containing historical running times. All files are
            merged together and used to compute default speeds in simulation (Default Goods / Default Coaching speed options).
            {speedRowCount > 0 && (
              <span style={{ marginLeft: "8px", color: "#16a34a", fontWeight: "bold" }}>
                ({speedRowCount.toLocaleString()} rows currently loaded)
              </span>
            )}
          </p>
        </div>

        {/* Multi-file zone */}
        <div
          style={{
            border: "2px dashed #94a3b8",
            borderRadius: "12px",
            padding: "20px",
            background: "#f8fafc",
            display: "flex",
            flexDirection: "column",
            gap: "12px",
          }}
        >
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "10px",
              cursor: "pointer",
              color: "#3b82f6",
              fontWeight: "600",
              fontSize: "14px",
            }}
          >
            <span style={{ fontSize: "28px" }}>📂</span>
            Click to add CSV / Excel speed files (multiple allowed)
            <input
              ref={speedInputRef}
              type="file"
              accept=".csv,.xlsx,.xls"
              multiple
              style={{ display: "none" }}
              onChange={handleSpeedFilesChange}
            />
          </label>

          {speedFiles.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
              {speedFiles.map((f) => (
                <div
                  key={f.name}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                    background: "#dbeafe",
                    border: "1px solid #93c5fd",
                    borderRadius: "8px",
                    padding: "4px 10px",
                    fontSize: "13px",
                    color: "#1e40af",
                    fontWeight: "600",
                  }}
                >
                  📄 {f.name}
                  <button
                    onClick={() => removeSpeedFile(f.name)}
                    style={{
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      color: "#ef4444",
                      fontSize: "16px",
                      lineHeight: 1,
                      padding: 0,
                    }}
                    title="Remove"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ display: "flex", gap: "12px", marginTop: "12px", flexWrap: "wrap" }}>
          <button
            className="primary mega-btn"
            onClick={processSpeedFiles}
            disabled={processingSpeed || speedFiles.length === 0}
            style={{ flex: 1, minWidth: "200px" }}
          >
            {processingSpeed ? "Processing..." : "Process & Save Speed Data"}
          </button>
          {speedRowCount > 0 && (
            <button
              onClick={clearSpeedData}
              style={{
                padding: "10px 20px",
                background: "#fef2f2",
                border: "1px solid #fca5a5",
                borderRadius: "8px",
                color: "#b91c1c",
                fontWeight: "600",
                cursor: "pointer",
                fontSize: "13px",
              }}
            >
              🗑️ Clear Speed Data
            </button>
          )}
        </div>

        {speedStatus && (
          <div
            style={{ marginTop: "12px" }}
            className={speedStatus.type === "ok" ? "success-box" : "error-box"}
          >
            {speedStatus.text}
          </div>
        )}
      </div>
    </div>
  );
}
