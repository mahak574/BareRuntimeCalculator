import React, { useState } from "react";
import TrainWiseTab from "./components/TrainWiseTab";
import SectionWiseTab from "./components/SectionWiseTab";
import DataTab from "./components/DataTab";
import StationLayoutTab from "./components/StationLayoutTab";
import { api } from "./api";

export default function App() {
  const [tab, setTab] = useState("train");
  const [reloading, setReloading] = useState(false);

  const reload = async () => {
    setReloading(true);
    try {
      await api.reload();
      window.location.reload();
    } catch (e) {
      alert(e.message);
    } finally {
      setReloading(false);
    }
  };

  return (
    <div className="app">
      <div className="app-header">
        <h1>BRT Analyzer</h1>
        <div className="tabs">
          <button className={`tab-btn ${tab === "train" ? "active" : ""}`} onClick={() => setTab("train")}>
            Train Wise BRT
          </button>
          <button className={`tab-btn ${tab === "section" ? "active" : ""}`} onClick={() => setTab("section")}>
            Section Wise BRT
          </button>
          <button className={`tab-btn ${tab === "layout" ? "active" : ""}`} onClick={() => setTab("layout")}>
            Station Layout
          </button>
          <button className={`tab-btn ${tab === "data" ? "active" : ""}`} onClick={() => setTab("data")}>
            Data Hub
          </button>
        </div>

        <div id="navbar-portal-target" style={{ flex: 1, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', paddingRight: '12px' }}></div>

        <button className="ghost icon-btn" onClick={reload} disabled={reloading} title="Clear Cache & Reload">
          🔄
        </button>
      </div>

      <div className="tab-content fade-in">
        {tab === "train" && <TrainWiseTab />}
        {tab === "section" && <SectionWiseTab />}
        {tab === "layout" && <StationLayoutTab />}
        {tab === "data" && <DataTab />}
      </div>
    </div>
  );
}
