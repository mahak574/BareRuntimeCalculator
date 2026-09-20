import React, { useState } from "react";
import { api } from "../api";

export default function DataTab() {
  const [movementFile, setMovementFile] = useState(null);
  const [masterFile, setMasterFile] = useState(null);
  const [routeFile, setRouteFile] = useState(null);
  const [scheduleFile, setScheduleFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState(null); // { type: "ok" | "error", text }

  const upload = async () => {
    if (!movementFile && !masterFile && !routeFile && !scheduleFile) {
      setStatus({ type: "error", text: "Choose at least one file to upload." });
      return;
    }
    setUploading(true);
    setStatus(null);
    try {
      const res = await api.uploadData(movementFile, masterFile, routeFile, scheduleFile);
      setStatus({
        type: "ok",
        text: `Uploaded ${res.uploaded.join(", ")}. Reloaded in ${res.load_time_sec?.toFixed(2)}s — ${res.trains} trains found.`,
      });
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

  return (
    <div className="data-tab">
      <div className="data-header">
        <h3 className="section-name">Data Management Hub</h3>
        <p className="caption">
          Upload any format (CSV or XLSX). Files are automatically converted and instantly processed.
        </p>
      </div>

      <div className="upload-grid">
        <label className={`upload-card ${movementFile ? "selected" : ""}`}>
          <input
            type="file"
            accept=".csv,.xlsx,.xls"
            onChange={(e) => setMovementFile(e.target.files?.[0] || null)}
          />
          <div className="upload-icon">
            {movementFile ? "✅" : "🚆"}
          </div>
          <h4>Movement Data</h4>
          <span className="file-name">{movementFile ? movementFile.name : "Click to select file"}</span>
        </label>

        <label className={`upload-card ${masterFile ? "selected" : ""}`}>
          <input
            type="file"
            accept=".csv,.xlsx,.xls"
            onChange={(e) => setMasterFile(e.target.files?.[0] || null)}
          />
          <div className="upload-icon">
            {masterFile ? "✅" : "📊"}
          </div>
          <h4>Master Config</h4>
          <span className="file-name">{masterFile ? masterFile.name : "Click to select file"}</span>
        </label>

        <label className={`upload-card ${routeFile ? "selected" : ""}`}>
          <input
            type="file"
            accept=".csv,.xlsx,.xls"
            onChange={(e) => setRouteFile(e.target.files?.[0] || null)}
          />
          <div className="upload-icon">
            {routeFile ? "✅" : "🗺️"}
          </div>
          <h4>Route File</h4>
          <span className="file-name">{routeFile ? routeFile.name : "Click to select file"}</span>
        </label>

        <label className={`upload-card ${scheduleFile ? "selected" : ""}`}>
          <input
            type="file"
            accept=".csv,.xlsx,.xls"
            onChange={(e) => setScheduleFile(e.target.files?.[0] || null)}
          />
          <div className="upload-icon">
            {scheduleFile ? "✅" : "🗓️"}
          </div>
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
    </div>
  );
}
