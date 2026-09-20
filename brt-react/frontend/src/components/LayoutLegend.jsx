import React from 'react';

export default function LayoutLegend() {
  return (
    <div className="layout-legend" style={{ padding: '8px 12px', display: 'flex', gap: '10px', flexWrap: 'nowrap', overflowX: 'auto', alignItems: 'center', fontSize: '10.5px', whiteSpace: 'nowrap', marginLeft: 'auto' }}>
      <h4 style={{ margin: 0, marginRight: '6px', fontSize: '11.5px' }}>Legend:</h4>
      <div className="legend-item" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
        <div style={{ color: '#2563eb', fontWeight: 'bold' }}>→</div>
        <div className="legend-swatch" style={{ width: '16px', background: 'transparent', borderTop: '2.5px solid #2563eb', height: '0px' }}></div>
        <span>Forward Conn.</span>
      </div>
      <div className="legend-item" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
        <div style={{ color: '#ea580c', fontWeight: 'bold' }}>←</div>
        <div className="legend-swatch" style={{ width: '16px', background: 'transparent', borderTop: '2.5px solid #ea580c', height: '0px' }}></div>
        <span>Reverse Conn.</span>
      </div>
    </div>
  );
}
