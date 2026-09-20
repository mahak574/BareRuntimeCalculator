import React, { useState, useRef, useEffect, useCallback } from 'react';

// ─── Constants ─────────────────────────────────────────────────────────────────

const TRACK_OPTIONS = [
  { label: 'Single Line', value: 1 },
  { label: 'Double Line', value: 2 },
  { label: 'Triple Line', value: 3 },
  { label: 'Quadruple Line', value: 4 }
];

const SECTION_SPEED_OPTIONS = [
  { label: '30 Kmph', value: 30 },
  { label: '45 Kmph', value: 45 },
  { label: '50 Kmph', value: 50 },
  { label: '60 Kmph', value: 60 },
  { label: '75 Kmph', value: 75 },
  { label: '90 Kmph', value: 90 },
  { label: '100 Kmph', value: 100 },
  { label: '110 Kmph', value: 110 },
  { label: '130 Kmph', value: 130 },
  { label: '160 Kmph', value: 160 }
];

const FIRST_LOOP_OPTIONS = [
  { label: '15 Kmph', value: 15 },
  { label: '30 Kmph', value: 30 },
  { label: '45 Kmph', value: 45 },
  { label: '50 Kmph', value: 50 }
];
const COMMON_LOOP_OPTIONS = FIRST_LOOP_OPTIONS;
const OTHER_LOOP_OPTIONS = FIRST_LOOP_OPTIONS;

const SOW_OPTIONS = [
  { label: 'Absolute Block System', value: 'AB' },
  { label: 'Automatic Block System', value: 'AUTO' }
];

const BLOCK_TIME_OPTIONS = [
  { label: '3 min', value: 3 },
  { label: '4 min', value: 4 },
  { label: '5 min', value: 5 },
  { label: '6 min', value: 6 },
  { label: '7 min', value: 7 },
  { label: '8 min', value: 8 }
];

const DEFAULT_CONFIG = {
  tracks: 2,
  sectionSpeed: 110,
  sow: 'AB',
  blockTime: 5,
  firstLoop: 30,
  commonLoop: 15,
  otherLoop: 15
};

// ─── Param Row ─────────────────────────────────────────────────────────────────

function ParamRow({ label, value, options, onChange }) {
  return (
    <div className="cfg2-row">
      <label className="cfg2-label">{label}</label>
      <select
        className="cfg2-select"
        value={value}
        onChange={e => {
          const raw = e.target.value;
          onChange(isNaN(Number(raw)) || raw === '' ? raw : Number(raw));
        }}
      >
        {options.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

// ─── Confirm All Modal ─────────────────────────────────────────────────────────

function ConfirmAllModal({ nodes, config, data, onModifyLayout, onClose }) {
  const [applied, setApplied] = useState(false);

  const handleApplyAll = () => {
    const blockSections = nodes.filter(n => n.type === 'block').map(n => n.code);
    const stations = nodes.filter(n => n.type === 'station').map(n => n.code);
    onModifyLayout('block', 'bulk-block-config', null, { blockSections, stations, config });
    setApplied(true);
    setTimeout(onClose, 1400);
  };

  return (
    <div className="cfg2-overlay" onClick={onClose}>
      <div className="cfg2-modal" onClick={e => e.stopPropagation()}>
        <div className="cfg2-modal-header">
          <span>🗺️ Apply to Entire Layout</span>
          <button className="cfg2-modal-close" onClick={onClose}>✕</button>
        </div>
        <p className="cfg2-modal-hint">
          This will apply Tracks/Speed to all <strong>{nodes.filter(n => n.type === 'block').length}</strong> block sections, and Loop Speeds to all <strong>{nodes.filter(n => n.type === 'station').length}</strong> stations.
          You can undo this afterwards.
        </p>

        <div className="cfg2-confirm-preview">
          {[
            { label: 'Tracks', val: TRACK_OPTIONS.find(o => o.value === config.tracks)?.label },
            { label: 'Section Speed', val: `${config.sectionSpeed} Kmph` },
            { label: 'System of Working', val: SOW_OPTIONS.find(o => o.value === config.sow)?.label },
            { label: 'Block Op. Time', val: `${config.blockTime} min` },
            { label: 'First Loop Speed', val: `${config.firstLoop} Kmph` },
            { label: 'Common Loop Speed', val: `${config.commonLoop} Kmph` },
            { label: 'Other Loop Speed', val: `${config.otherLoop} Kmph` },
          ].map(item => (
            <div key={item.label} className="cfg2-preview-row">
              <span className="cfg2-preview-label">{item.label}</span>
              <span className="cfg2-preview-val">{item.val}</span>
            </div>
          ))}
        </div>

        {applied ? (
          <div className="cfg2-flash success">✓ Applied to all {nodes.filter(n => n.type === 'block').length} block sections and {nodes.filter(n => n.type === 'station').length} stations</div>
        ) : (
          <div className="cfg2-modal-actions">
            <button className="cfg2-btn-cancel" onClick={onClose}>Cancel</button>
            <button className="cfg2-btn-apply-all" onClick={handleApplyAll}>
              Apply to All Nodes
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main Export ───────────────────────────────────────────────────────────────

export default function TrackConfigButton({ generatedLayout, data, onModifyLayout }) {
  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState({ ...DEFAULT_CONFIG });
  const [showConfirmAll, setShowConfirmAll] = useState(false);
  const panelRef = useRef(null);
  const btnRef = useRef(null);

  // Collect nodes
  const layoutNodes = generatedLayout ? generatedLayout.sequence.filter(s => s.type === 'block' || s.type === 'station').map(s => ({ type: s.type, code: s.code })) : [];
  const blockCount = layoutNodes.filter(n => n.type === 'block').length;

  useEffect(() => {
    if (!open) return;
    const handle = (e) => {
      if (
        panelRef.current && !panelRef.current.contains(e.target) &&
        btnRef.current && !btnRef.current.contains(e.target)
      ) setOpen(false);
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);

  const set = useCallback((field) => (value) => {
    setConfig(prev => ({ ...prev, [field]: value }));
  }, []);

  if (!generatedLayout) return null;

  return (
    <>
      <button
        ref={btnRef}
        id="track-config-btn"
        className={`btn-primary cfg2-trigger-btn ${open ? 'active' : ''}`}
        onClick={() => setOpen(v => !v)}
        title="Configure track parameters"
      >
        ⚙️ Track Configuration
        <span className={`cfg2-chevron ${open ? 'open' : ''}`}>▾</span>
      </button>

      {open && (
        <div ref={panelRef} className="cfg2-panel card">
          <div className="cfg2-panel-header">
            <span className="cfg2-panel-title">🛤️ Track Configuration</span>
            <button className="cfg2-panel-close" onClick={() => setOpen(false)}>✕</button>
          </div>

          <div className="cfg2-params">
            <div className="cfg2-section-heading">Track & Speed</div>
            <ParamRow label="Tracks" value={config.tracks} options={TRACK_OPTIONS} onChange={set('tracks')} />
            <ParamRow label="Section Speed" value={config.sectionSpeed} options={SECTION_SPEED_OPTIONS} onChange={set('sectionSpeed')} />
            <ParamRow label="System of Working" value={config.sow} options={SOW_OPTIONS} onChange={set('sow')} />
            <ParamRow label="Block Op. Time" value={config.blockTime} options={BLOCK_TIME_OPTIONS} onChange={set('blockTime')} />

            <div className="cfg2-divider" />
            <div className="cfg2-section-heading">Loop Speeds</div>
            <ParamRow label="First Loop Speed" value={config.firstLoop} options={FIRST_LOOP_OPTIONS} onChange={set('firstLoop')} />
            <ParamRow label="Common Loop Speed" value={config.commonLoop} options={COMMON_LOOP_OPTIONS} onChange={set('commonLoop')} />
            <ParamRow label="Other Loop Speed" value={config.otherLoop} options={OTHER_LOOP_OPTIONS} onChange={set('otherLoop')} />
          </div>

          <div className="cfg2-divider" />

          <div className="cfg2-actions" style={{ justifyContent: 'center' }}>
            <button
              id="cfg2-entire-btn"
              className="cfg2-btn-entire"
              style={{ width: '100%' }}
              onClick={() => { setShowConfirmAll(true); setOpen(false); }}
            >
              🗺️ Apply to Entire Layout
              <span className="cfg2-count-badge">{blockCount}</span>
            </button>
          </div>
        </div>
      )}

      {showConfirmAll && (
        <ConfirmAllModal
          nodes={layoutNodes}
          config={config}
          data={data}
          onModifyLayout={onModifyLayout}
          onClose={() => setShowConfirmAll(false)}
        />
      )}
    </>
  );
}
