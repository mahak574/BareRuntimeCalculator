import React, { useState, useMemo, useEffect } from 'react';

const TrackToggle = ({ state, side, onClick }) => {
  const isLeft = side === 'left';
  const isConnected = !!state;
  
  let color = '#cbd5e1';
  let bgColor = '#f8fafc';
  let borderColor = '#e2e8f0';
  let symbol = '';

  if (isConnected) {
    if (state === 'B') {
      color = '#10b981'; // Green
      bgColor = '#d1fae5';
      borderColor = '#6ee7b7';
      symbol = '↔';
    } else {
      // For Left Station: S = Send (->), R = Receive (<-)
      // For Right Station: S = Send (<-), R = Receive (->)
      const isLeftToRight = (isLeft && state === 'S') || (!isLeft && state === 'R');

      color = isLeftToRight ? '#2563eb' : '#ea580c'; // Blue for LTR, Orange for RTL
      bgColor = isLeftToRight ? '#dbeafe' : '#ffedd5';
      borderColor = isLeftToRight ? '#93c5fd' : '#fdba74';

      symbol = isLeftToRight ? '→' : '←';
    }
  }

  const tooltip = !state ? "Click to connect (Send)" 
                : state === 'S' ? "Click to change to Receive"
                : state === 'R' ? "Click to change to Both Directions"
                : "Click to disconnect";

  return (
    <div 
      onClick={onClick}
      style={{
         cursor: 'pointer',
         height: '28px', width: '48px',
         display: 'flex', alignItems: 'center', justifyContent: 'center',
         backgroundColor: bgColor,
         border: `1px solid ${borderColor}`,
         borderRadius: '4px',
         margin: '0 auto',
         transition: 'all 0.2s',
         position: 'relative'
      }}
      title={tooltip}
    >
      <div style={{ 
        position: 'absolute',
        width: '100%', 
        height: '4px', 
        backgroundColor: color,
        borderTopRightRadius: isLeft ? '2px' : '0px',
        borderBottomRightRadius: isLeft ? '2px' : '0px',
        borderTopLeftRadius: !isLeft ? '2px' : '0px',
        borderBottomLeftRadius: !isLeft ? '2px' : '0px',
      }} />
      {symbol && (
        <div style={{
          position: 'absolute',
          backgroundColor: bgColor,
          padding: '0 2px',
          color: color,
          fontWeight: 'bold',
          fontSize: '18px',
          lineHeight: '18px'
        }}>
          {symbol}
        </div>
      )}
    </div>
  );
};

export default function ConnectionTableModal({ layout, data, onClose, onSave }) {
  const [selectedStation, setSelectedStation] = useState('');
  
  const [pendingConnections, setPendingConnections] = useState([]);

  useEffect(() => {
    setPendingConnections([...(data?.sheets?.Connections || [])]);
  }, [data]);

  // Extract all stations from the layout sequence
  const stations = useMemo(() => {
    if (!layout || !layout.sequence) return [];
    return layout.sequence.filter(item => item.type === 'station');
  }, [layout]);

  // Determine left and right block sections based on the selected station
  const { leftBlockSection, rightBlockSection } = useMemo(() => {
    if (!selectedStation || !layout || !layout.sequence) return { leftBlockSection: null, rightBlockSection: null };
    const idx = layout.sequence.findIndex(s => s.code === selectedStation && s.type === 'station');
    if (idx === -1) return { leftBlockSection: null, rightBlockSection: null };
    
    let leftBS = null;
    let rightBS = null;
    if (idx > 0 && layout.sequence[idx - 1].type === 'block') {
      leftBS = layout.sequence[idx - 1].code;
    }
    if (idx < layout.sequence.length - 1 && layout.sequence[idx + 1].type === 'block') {
      rightBS = layout.sequence[idx + 1].code;
    }
    return { leftBlockSection: leftBS, rightBlockSection: rightBS };
  }, [selectedStation, layout]);

  // Get lines for the selected station
  const stationLines = useMemo(() => {
    if (!selectedStation || !layout || !layout.stations[selectedStation]) return [];
    return layout.stations[selectedStation].lines || [];
  }, [selectedStation, layout]);

  const leftBSLines = useMemo(() => {
    if (!leftBlockSection || !layout || !layout.blockSections[leftBlockSection]) return [];
    return layout.blockSections[leftBlockSection].lines || [];
  }, [leftBlockSection, layout]);

  const rightBSLines = useMemo(() => {
    if (!rightBlockSection || !layout || !layout.blockSections[rightBlockSection]) return [];
    return layout.blockSections[rightBlockSection].lines || [];
  }, [rightBlockSection, layout]);

  // Find existing connection state between the selected station and a block section
  const getExistingConnectionState = (stnCode, stnLine, bsCode, bsLine) => {
    if (!bsCode) return null;
    const stnLineNum = parseFloat(stnLine.MANSEQNUMB) || parseFloat(stnLine.MAVLINENUMB);
    const bsLineNum = parseFloat(bsLine.MANSEQNUMB) || parseFloat(bsLine.MAVLINENUMB);
    
    const conn = pendingConnections.find(c => {
      const matchStn = String(c.MAVSTTNCODE).trim() === stnCode;
      const matchBs = String(c.MAVBLCKSCTN).trim() === bsCode || String(c.MAVBLCKSCTN).trim() === bsCode.split('-').reverse().join('-');
      
      const cStnLine = parseFloat(c.MANSTTNLINENUMB);
      const cBsLine = parseFloat(c.MANBSLINENUMB);
      
      return matchStn && matchBs && cStnLine === stnLineNum && cBsLine === bsLineNum;
    });

    return conn ? conn.MACRECVSENDFLAG : null;
  };

  const handleToggleConnection = (stnCode, stnLine, bsCode, bsLine) => {
    if (!bsCode) return;
    const stnLineNum = parseFloat(stnLine.MANSEQNUMB) || parseFloat(stnLine.MAVLINENUMB);
    const bsLineNum = parseFloat(bsLine.MANSEQNUMB) || parseFloat(bsLine.MAVLINENUMB);

    const existingIndex = pendingConnections.findIndex(c => {
      const matchStn = String(c.MAVSTTNCODE).trim() === stnCode;
      const matchBs = String(c.MAVBLCKSCTN).trim() === bsCode || String(c.MAVBLCKSCTN).trim() === bsCode.split('-').reverse().join('-');
      const cStnLine = parseFloat(c.MANSTTNLINENUMB);
      const cBsLine = parseFloat(c.MANBSLINENUMB);
      return matchStn && matchBs && cStnLine === stnLineNum && cBsLine === bsLineNum;
    });

    let connsArray = [...pendingConnections];
    let nextState = 'S'; // Default first click

    if (existingIndex !== -1) {
       const currState = connsArray[existingIndex].MACRECVSENDFLAG;
       if (currState === 'S') nextState = 'R';
       else if (currState === 'R') nextState = 'B';
       else nextState = null; // Disconnect directly after B
       
       connsArray.splice(existingIndex, 1);
    }

    if (nextState) {
      connsArray.push({
        MAVSTTNCODE: stnCode,
        MAVBLCKSCTN: bsCode,
        MANSTTNLINENUMB: String(stnLineNum),
        MANBSLINENUMB: String(bsLineNum),
        MACRECVSENDFLAG: nextState
      });
    }

    setPendingConnections(connsArray);
  };

  const handleApply = () => {
    const newData = { ...data, sheets: { ...data.sheets } };
    newData.sheets.Connections = pendingConnections;
    onSave(newData);
  };

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 10000,
      display: 'flex', justifyContent: 'center', alignItems: 'center'
    }}>
      <div className="card glass" style={{ width: '1000px', maxWidth: '95vw', maxHeight: '90vh', display: 'flex', flexDirection: 'column', backgroundColor: '#fff', borderRadius: '8px', overflow: 'hidden', boxShadow: '0 20px 40px rgba(0,0,0,0.2)' }}>
        
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#f8fafc' }}>
          <h3 style={{ margin: 0, color: '#1e293b', fontSize: '18px' }}>Manage Connections</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer', color: '#64748b' }}>&times;</button>
        </div>

        <div style={{ padding: '20px', overflowY: 'auto', flex: 1 }}>
          <div style={{ display: 'flex', gap: '20px', marginBottom: '20px', alignItems: 'flex-end' }}>
            <div style={{ flex: 1, maxWidth: '400px' }}>
              <label style={{ display: 'block', marginBottom: '8px', fontWeight: 'bold', color: '#475569' }}>Select Station</label>
              <select 
                value={selectedStation} 
                onChange={e => setSelectedStation(e.target.value)}
                style={{ width: '100%', padding: '10px', borderRadius: '4px', border: '1px solid #cbd5e1', fontSize: '14px' }}
              >
                <option value="">-- Choose a Station --</option>
                {stations.map(s => (
                  <option key={s.code} value={s.code}>{s.code}</option>
                ))}
              </select>
            </div>
            {selectedStation && (
              <div style={{ color: '#64748b', fontSize: '13px', paddingBottom: '10px' }}>
                Click on the tracks to connect or disconnect the station lines with adjacent block sections.
              </div>
            )}
          </div>

          {selectedStation ? (
            <div style={{ marginTop: '20px' }}>
              <div style={{ overflowX: 'auto', border: '1px solid #e2e8f0', borderRadius: '8px', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.05)' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'center' }}>
                  <thead style={{ backgroundColor: '#f8fafc' }}>
                    <tr>
                      {/* Left Block Section Headers */}
                      {leftBSLines.map((bLine, idx) => {
                        const bLineName = bLine.MAVLINENUMB || bLine.MANSEQNUMB || `Line ${idx+1}`;
                        return (
                          <th key={`lbs-header-${idx}`} style={{ padding: '12px', borderBottom: '2px solid #cbd5e1', borderRight: '1px dashed #e2e8f0', backgroundColor: '#fff7ed', color: '#c2410c', minWidth: '100px' }}>
                            <div style={{ fontSize: '11px', color: '#ea580c', fontWeight: '600', marginBottom: '4px' }}>{leftBlockSection}</div>
                            <div style={{ fontWeight: 'bold', fontSize: '13px' }}>BS Line {bLineName}</div>
                          </th>
                        );
                      })}

                      {/* Station Header */}
                      <th style={{ padding: '12px', borderBottom: '2px solid #cbd5e1', borderRight: rightBSLines.length > 0 ? '1px dashed #e2e8f0' : 'none', borderLeft: leftBSLines.length > 0 ? '2px solid #cbd5e1' : 'none', backgroundColor: '#f1f5f9', color: '#1e293b', width: '200px' }}>
                        <div style={{ fontSize: '11px', color: '#64748b', fontWeight: '600', marginBottom: '4px' }}>STATION</div>
                        <div style={{ fontWeight: 'bold', fontSize: '14px' }}>{selectedStation} LINES</div>
                      </th>

                      {/* Right Block Section Headers */}
                      {rightBSLines.map((bLine, idx) => {
                        const bLineName = bLine.MAVLINENUMB || bLine.MANSEQNUMB || `Line ${idx+1}`;
                        return (
                          <th key={`rbs-header-${idx}`} style={{ padding: '12px', borderBottom: '2px solid #cbd5e1', borderRight: idx === rightBSLines.length - 1 ? 'none' : '1px dashed #e2e8f0', borderLeft: idx === 0 ? '2px solid #cbd5e1' : 'none', backgroundColor: '#eff6ff', color: '#1d4ed8', minWidth: '100px' }}>
                            <div style={{ fontSize: '11px', color: '#3b82f6', fontWeight: '600', marginBottom: '4px' }}>{rightBlockSection}</div>
                            <div style={{ fontWeight: 'bold', fontSize: '13px' }}>BS Line {bLineName}</div>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  
                  <tbody>
                    {stationLines.length > 0 ? stationLines.map((sLine, sIdx) => {
                      const sLineName = sLine.MAVLINENUMB || sLine.MANSEQNUMB || `Line ${sIdx+1}`;
                      return (
                        <tr key={`stnLine-${sIdx}`} style={{ backgroundColor: '#fff' }}>
                          
                          {/* Left Block Section Toggles */}
                          {leftBSLines.map((bLine, bIdx) => {
                            const state = getExistingConnectionState(selectedStation, sLine, leftBlockSection, bLine);
                            return (
                              <td key={`lCell-${bIdx}`} style={{ padding: '12px 8px', borderBottom: '1px solid #e2e8f0', borderRight: '1px dashed #e2e8f0', backgroundColor: '#fff' }}>
                                <TrackToggle 
                                  state={state} 
                                  side="right" 
                                  onClick={() => handleToggleConnection(selectedStation, sLine, leftBlockSection, bLine)}
                                />
                              </td>
                            );
                          })}

                          {/* Station Line Name (Middle) */}
                          <td style={{ padding: '12px', borderBottom: '1px solid #e2e8f0', borderRight: rightBSLines.length > 0 ? '2px solid #cbd5e1' : 'none', borderLeft: leftBSLines.length > 0 ? '2px solid #cbd5e1' : 'none', backgroundColor: '#f8fafc', fontWeight: '600', color: '#0f172a' }}>
                            Line {sLineName}
                            <div style={{ fontSize: '11px', color: '#64748b', fontWeight: 'normal', marginTop: '4px' }}>{sLine.MACLINECATEGORY || 'Line'}</div>
                          </td>

                          {/* Right Block Section Toggles */}
                          {rightBSLines.map((bLine, bIdx) => {
                            const state = getExistingConnectionState(selectedStation, sLine, rightBlockSection, bLine);
                            return (
                              <td key={`rCell-${bIdx}`} style={{ padding: '12px 8px', borderBottom: '1px solid #e2e8f0', borderRight: bIdx === rightBSLines.length - 1 ? 'none' : '1px dashed #e2e8f0', backgroundColor: '#fff' }}>
                                <TrackToggle 
                                  state={state} 
                                  side="left" 
                                  onClick={() => handleToggleConnection(selectedStation, sLine, rightBlockSection, bLine)}
                                />
                              </td>
                            );
                          })}

                        </tr>
                      );
                    }) : (
                      <tr>
                        <td colSpan={(leftBSLines.length || 0) + 1 + (rightBSLines.length || 0)} style={{ padding: '20px', color: '#64748b' }}>
                          No lines found for {selectedStation}.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div style={{ marginTop: '20px', display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
                <button 
                  onClick={onClose}
                  style={{ padding: '10px 20px', borderRadius: '6px', border: '1px solid #cbd5e1', backgroundColor: '#fff', cursor: 'pointer', fontWeight: '500', color: '#475569' }}
                >
                  Cancel
                </button>
                <button 
                  onClick={handleApply}
                  className="btn-primary"
                  style={{ padding: '10px 24px', borderRadius: '6px', border: 'none', backgroundColor: '#10b981', color: '#fff', cursor: 'pointer', fontWeight: 'bold', boxShadow: '0 4px 6px -1px rgba(16, 185, 129, 0.2)' }}
                >
                  Apply Connections
                </button>
              </div>
            </div>
          ) : (
            <div style={{ padding: '60px 40px', textAlign: 'center', color: '#94a3b8', border: '2px dashed #cbd5e1', borderRadius: '8px', marginTop: '20px', backgroundColor: '#f8fafc' }}>
              <div style={{ fontSize: '18px', marginBottom: '8px', color: '#64748b' }}>No Station Selected</div>
              Please select a Station from the dropdown above to view and manage its connections.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
