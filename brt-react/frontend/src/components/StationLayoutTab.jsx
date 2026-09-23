import React, { useState, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import StationLayout from './StationLayout';
import ErrorBoundary from './ErrorBoundary';
import LayoutLegend from './LayoutLegend';
import TimeDistanceGraph from './TimeDistanceGraph';
import ConnectionTableModal from './ConnectionTableModal';
import TrackConfigButton from './SectionConfigPanel';

/**
 * StationLayoutTab is the main container component for the physical track layout 
 * and time-distance graph. It fetches the Excel layout data from the backend 
 * and processes it into a structured format for rendering.
 */
export default function StationLayoutTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [viewType, setViewType] = useState('route');
  const [selectedValue, setSelectedValue] = useState('');
  const [generatedLayout, setGeneratedLayout] = useState(null);
  const [appliedLayout, setAppliedLayout] = useState(null);

  useEffect(() => {
    setAppliedLayout(null);
  }, [selectedValue]);
  const [navDropdownVal, setNavDropdownVal] = useState('');
  const [navTrigger, setNavTrigger] = useState(0);
  const [warnings, setWarnings] = useState([]);
  const [showBigLayout, setShowBigLayout] = useState(true);
  const [showConnectionsModal, setShowConnectionsModal] = useState(false);
  const [showSimulationModal, setShowSimulationModal] = useState(false);
  const [history, setHistory] = useState([]);

  // Helper to deep clone sheets state
  const cloneSheets = (sheets) => {
    return JSON.parse(JSON.stringify(sheets || {}));
  };

  useEffect(() => {
    api.layoutData()
      .then(res => {
        if (res && res.sheets && res.sheets.StationLine) {
          const stnGroups = {};
          res.sheets.StationLine.forEach(l => {
            const code = String(l.MAVSTTNCODE).trim();
            if (!stnGroups[code]) stnGroups[code] = [];
            stnGroups[code].push(l);
          });

          const processedLines = [];
          Object.values(stnGroups).forEach(lines => {
            const mainSeqs = lines
              .filter(l => { const cat = String(l.MACLINECATEGORY || '').trim().toUpperCase(); return cat === 'M' || cat === 'MAIN'; })
              .map(l => parseFloat(l.MANSEQNUMB) || 0);

            lines.forEach(l => {
              if (!l.MAVSPEED) {
                const cat = String(l.MACLINECATEGORY || '').trim().toUpperCase();
                if (cat === 'M' || cat === 'MAIN') {
                  l.MAVSPEED = 110;
                } else {
                  const seq = parseFloat(l.MANSEQNUMB) || 0;
                  let minDiff = Infinity;
                  for (let mSeq of mainSeqs) {
                    const diff = Math.abs(seq - mSeq);
                    if (diff < minDiff) minDiff = diff;
                  }
                  l.MAVSPEED = minDiff <= 1 ? 30 : 15;
                }
              }
              processedLines.push(l);
            });
          });
          res.sheets.StationLine = processedLines;
        }

        if (res && res.sheets && res.sheets.BlockSctnLine) {
          res.sheets.BlockSctnLine.forEach(l => {
            if (!l.MAVSPEED) l.MAVSPEED = 110;
            if (!l.MAVSIGNALLING) l.MAVSIGNALLING = 'AB';
            if (!l.MANBLOCKTIMEMINS) l.MANBLOCKTIMEMINS = 5;
            if (!l.MACNBOFTRKS) l.MACNBOFTRKS = 2;
          });
        }

        setData(res);
        setLoading(false);
      })
      .catch(err => { setError(err.message); setLoading(false); });
  }, []);

  const options = useMemo(() => {
    if (!data) return [];
    if (viewType === 'route') return ["Full Route"];
    const routeInfo = data.sheets?.RouteInfo || [];
    const bsSet = new Set();
    routeInfo.forEach(row => {
      if (row.BLOCK_SECTION) bsSet.add(row.BLOCK_SECTION.toString().trim());
      if (row.REVERSE_BLOCK_SECTION) bsSet.add(row.REVERSE_BLOCK_SECTION.toString().trim());
    });
    return Array.from(bsSet).sort();
  }, [data, viewType]);

  useEffect(() => {
    setSelectedValue(options.length > 0 ? options[0] : '');
  }, [options, viewType]);

  const handleGenerate = (val, targetData = data) => {
    if (!targetData || !val) return;
    const warns = [];
    const layout = { type: viewType, mainValue: val, sequence: [], stations: {}, blockSections: {}, connections: [] };
    const sheets = targetData.sheets;

    const getVal = (obj, key) => {
      const k = Object.keys(obj).find(x => String(x).trim().toLowerCase() === String(key).trim().toLowerCase());
      return k ? obj[k] : '';
    };

    const getStationLines = (stnCode) => {
      let lines = (sheets.StationLine || []).filter(r => r.MAVSTTNCODE === stnCode);
      if (lines.length === 0) warns.push({ msg: `No lines found for station ${stnCode}`, type: 'warn' });
      lines = lines.sort((a, b) => (parseFloat(a.MANSEQNUMB) || 0) - (parseFloat(b.MANSEQNUMB) || 0));
      const platforms = (sheets.Platform || []).filter(r => r.MAVSTTNCODE === stnCode);
      const stationSheetKey = Object.keys(sheets).find(k => { const tk = String(k).trim().toLowerCase(); return tk === 'stations' || tk === 'station'; });
      const stationSheet = stationSheetKey ? sheets[stationSheetKey] : [];
      const cleanCode = String(stnCode).trim();
      const stnRow = stationSheet.find(r => String(getVal(r, 'MAVSTTNCODE')).trim() === cleanCode || String(getVal(r, 'STATION CODE')).trim() === cleanCode) || {};
      return {
        code: stnCode,
        name: getVal(stnRow, 'STATION NAME') || getVal(stnRow, 'MAVSTTNNAME') || getVal(stnRow, 'STATION_NAME'),
        lines, platforms,
        macclassflag: getVal(stnRow, 'MACCLASSFLAG'),
        MAVDVSNCODE: getVal(stnRow, 'MAVDVSNCODE'),
        MANMILEPOSTKM_I: getVal(stnRow, 'MANMILEPOSTKM_I'),
        MANMILEPOSTSUBKM_I: getVal(stnRow, 'MANMILEPOSTSUBKM_I'),
        MAVREFSTTN_I: getVal(stnRow, 'MAVREFSTTN_I')
      };
    };

    const getBSLines = (bsCode) => {
      let lines = (sheets.BlockSctnLine || []).filter(r => r.MAVBLCKSCTN === bsCode);
      if (lines.length === 0) warns.push({ msg: `No lines found for block section ${bsCode}`, type: 'warn' });
      lines = lines.sort((a, b) => (parseFloat(a.MANSEQNUMB) || 0) - (parseFloat(b.MANSEQNUMB) || 0));
      return { code: bsCode, lines };
    };

    const getBlockDistance = (bsCode) => {
      let reversedBsCode = '';
      if (bsCode && bsCode.includes('-')) { const [l, r] = bsCode.split('-'); reversedBsCode = `${r}-${l}`; }
      const row = (sheets.RouteInfo || []).find(r => r.BLOCK_SECTION === bsCode || r.BLOCK_SECTION === reversedBsCode);
      if (row && row.DISTANCE) { let parsed = parseFloat(row.DISTANCE); if (!isNaN(parsed)) return parsed.toFixed(2); }
      return '';
    };

    if (viewType === 'route') {
      const routeRows = (sheets.RouteInfo || []).sort((a, b) => (a.SEQ_NO || 0) - (b.SEQ_NO || 0));
      if (routeRows.length === 0) warns.push({ msg: 'No data in RouteInfo sheet.', type: 'warn' });
      routeRows.forEach(row => {
        const stnCode = row.STATION_CODE;
        const stnName = row.STATION_NAME || stnCode;
        const bsCode = row.BLOCK_SECTION;
        const distance = bsCode ? getBlockDistance(bsCode) : '';
        if (stnCode) { layout.stations[stnCode] = getStationLines(stnCode); layout.sequence.push({ type: 'station', code: stnCode, name: stnName }); }
        if (bsCode) { layout.blockSections[bsCode] = getBSLines(bsCode); layout.sequence.push({ type: 'block', code: bsCode, distance }); }
      });
      layout.connections = sheets.Connections || [];
    } else {
      const bsCode = val;
      layout.blockSections[bsCode] = getBSLines(bsCode);
      const connectedConns = (sheets.Connections || []).filter(r => r.MAVBLCKSCTN === bsCode);
      let stnSet = Array.from(new Set(connectedConns.map(r => r.MAVSTTNCODE).filter(Boolean)));
      if (bsCode.includes('-')) { const [leftStn, rightStn] = bsCode.split('-'); stnSet = [leftStn, rightStn]; }
      stnSet.forEach(stnCode => { layout.stations[stnCode] = getStationLines(stnCode); });
      layout.connections = connectedConns;
      if (stnSet.length > 0) layout.sequence.push({ type: 'station', code: stnSet[0], name: stnSet[0] });
      layout.sequence.push({ type: 'block', code: bsCode, distance: getBlockDistance(bsCode) });
      if (stnSet.length > 1) layout.sequence.push({ type: 'station', code: stnSet[1], name: stnSet[1] });
    }

    setWarnings(warns);
    setGeneratedLayout(layout);
  };

  const prevSelectedValue = useRef('');
  useEffect(() => {
    if (selectedValue && data) {
      if (selectedValue !== prevSelectedValue.current || !generatedLayout) {
        handleGenerate(selectedValue, data);
        prevSelectedValue.current = selectedValue;
      }
    }
  }, [selectedValue, data, generatedLayout]);

  const handleModifyLayout = (type, action, lineData, options) => {
    if (!data || !data.sheets) return;

    // Save previous state to history using a deep clone
    const previousSheets = cloneSheets(data.sheets);
    setHistory(prev => [...prev, previousSheets]);

    // Create an immutable copy of the overall data and its sheets container
    const newData = { ...data, sheets: { ...data.sheets } };

    if (type === 'block') {
      const bsCode = lineData ? (typeof lineData === 'string' ? lineData : (lineData.bsCode || lineData.code)) : null;
      const originalLine = lineData && typeof lineData !== 'string' ? (lineData.originalLine || (bsCode && generatedLayout?.blockSections[bsCode]?.lines[0])) : (bsCode && generatedLayout?.blockSections[bsCode]?.lines[0]);
      const linesArray = [...(newData.sheets.BlockSctnLine || [])];

      if (action === 'delete') {
        const idx = linesArray.findIndex(l => l.MANBSLINENUMB === originalLine.MANBSLINENUMB);
        if (idx !== -1) {
          linesArray.splice(idx, 1);
        }

        if (newData.sheets.Connections) {
          const bsLineNum = parseInt(originalLine.MANBSLINENUMB);
          const cleanBsCode = String(originalLine.MAVBLCKSCTN || bsCode || '').trim();
          const reversedBsCode = cleanBsCode.split('-').reverse().join('-');

          // Deep clone connections array before mutating
          newData.sheets.Connections = [...newData.sheets.Connections].filter(c => {
            const cleanC = String(c.MAVBLCKSCTN || '').trim();
            const matchesCode = cleanC === cleanBsCode || cleanC === reversedBsCode;
            const cNum = parseInt(c.MANBSLINENUMB);
            const matchesLine = !isNaN(bsLineNum) && !isNaN(cNum) && cNum === bsLineNum;
            return !(matchesCode && matchesLine);
          });
        }
      } else if (action === 'add') {
        const cleanBsCode = String(bsCode || '').trim();
        const reversedBsCode = cleanBsCode.split('-').reverse().join('-');
        const blockLines = linesArray.filter(l => {
          const code = String(l.MAVBLCKSCTN || '').trim();
          return code === cleanBsCode || code === reversedBsCode;
        });
        // Use Number.isFinite to correctly handle MANSEQNUMB=0 and negative values —
        // the old `parseFloat(x) || fallback` pattern treats 0 as falsy, which causes
        // a second "add at top" to compute the same seq number as the first (both get 0).
        const parsedSeqs = blockLines
          .map(l => parseFloat(l.MANSEQNUMB))
          .filter(n => Number.isFinite(n));
        const maxSeq = parsedSeqs.length > 0 ? Math.max(...parsedSeqs) : 0;
        const minSeq = parsedSeqs.length > 0 ? Math.min(...parsedSeqs) : 1;

        let newSeq = maxSeq + 1;
        if (options && options.position === 'top') {
          newSeq = minSeq - 1;
        }

        const templateLine = blockLines.length > 0
          ? blockLines[0]
          : { MAVBLCKSCTN: cleanBsCode };

        const maxBsId = linesArray.reduce(
          (max, l) => Math.max(max, parseInt(l.MANBSLINENUMB) || 0),
          0
        );

        // A newly added, unconnected Block Section Line must never become
        // an automatic end-to-end Main Line merely because of its category.
        const templateCategory = String(
          templateLine.MACLINECATEGORY || ''
        ).trim().toUpperCase();
        const safeCategory =
          (options && options.lineCategory)
            ? options.lineCategory
            : (templateCategory === 'M' || templateCategory === 'MAIN'
              ? ''
              : templateCategory);

        const newLine = {
          ...templateLine,
          MAVBLCKSCTN: cleanBsCode,
          MACLINECATEGORY: safeCategory,
          MANSEQNUMB: String(newSeq),
          MAVDRTN: (options && options.direction)
            ? options.direction
            : (templateLine.MAVDRTN || 'BOTH'),
          MAVLINENUMB: options?.lineName !== undefined
            ? options.lineName
            : '',
          MANBSLINENUMB: String(Math.max(100, maxBsId + 1))
        };
        linesArray.push(newLine);
      } else if (action === 'speed') {
        const cleanBsCode = String(bsCode).trim();
        const reversedBsCode = cleanBsCode.split('-').reverse().join('-');
        linesArray.forEach((l, i) => {
          const cleanL = String(l.MAVBLCKSCTN).trim();
          // Update ALL lines in the block section — the right-click Speed menu applies
          // the speed to the entire block section, not just MAIN-category lines.
          // Previously, LOOP-category (and newly-added) lines were silently skipped.
          if (cleanL === cleanBsCode || cleanL === reversedBsCode) {
            linesArray[i] = { ...l, MAVSPEED: options.speed };
          }
        });
      } else if (action === 'signalling') {
        const cleanBsCode = String(bsCode).trim();
        const reversedBsCode = cleanBsCode.split('-').reverse().join('-');

        linesArray.forEach((l, i) => {
          const cleanL = String(l.MAVBLCKSCTN).trim();

          if (cleanL === cleanBsCode || cleanL === reversedBsCode) {
            linesArray[i] = {
              ...l,
              MAVSIGNALLING: options.signalling
            };
          }
        });

        newData.sheets.BlockSctnLine = linesArray;

      } else if (action === 'blocktime') {
        const cleanBsCode = String(bsCode).trim();
        const reversedBsCode = cleanBsCode.split('-').reverse().join('-');
        linesArray.forEach((l, i) => {
          const cleanL = String(l.MAVBLCKSCTN).trim();
          if (cleanL === cleanBsCode || cleanL === reversedBsCode) {
            linesArray[i] = { ...l, MANBLOCKTIMEMINS: options.blockTime };
          }
        });
      } else if (action === 'tracks') {
        // Store the number-of-tracks flag on every line in this block section
        const cleanBsCode = String(bsCode).trim();
        const reversedBsCode = cleanBsCode.split('-').reverse().join('-');
        linesArray.forEach((l, i) => {
          const cleanL = String(l.MAVBLCKSCTN).trim();
          if (cleanL === cleanBsCode || cleanL === reversedBsCode) {
            linesArray[i] = { ...l, MACNBOFTRKS: options.tracks };
          }
        });
      } else if (action === 'loopspeed') {
        // Update a specific loop line's speed by ID reference
        const targetLine = lineData.originalLine;
        if (targetLine) {
          const idx = linesArray.findIndex(l => l.MANBSLINENUMB === targetLine.MANBSLINENUMB);
          if (idx !== -1) {
            linesArray[idx] = { ...linesArray[idx], MAVSPEED: options.speed };
          }
        }
      } else if (action === 'bulk-block-config') {
        const { blockSections, stations, config } = options;

        // Phase 1: Update Block Sections (Tracks, Speed, SOW, Block Time)
        let blockLinesArray = [...(newData.sheets.BlockSctnLine || [])];
        if (blockSections && blockSections.length > 0) {
          const bsCodes = new Set(blockSections.flatMap(bs => [bs.trim(), bs.split('-').reverse().join('-')]));
          const sectionSpeed = Number(config.sectionSpeed);
          let updatedCount = 0;
          blockLinesArray.forEach((l, i) => {
            const cleanL = String(l.MAVBLCKSCTN).trim();
            if (bsCodes.has(cleanL)) {
              let updatedLine = { ...l };
              if (Number.isFinite(sectionSpeed)) {
                updatedLine.MAVSPEED = sectionSpeed;
              }
              if (config.sow !== undefined) updatedLine.MAVSIGNALLING = config.sow;
              if (config.blockTime !== undefined) updatedLine.MANBLOCKTIMEMINS = config.blockTime;
              if (config.tracks !== undefined) updatedLine.MACNBOFTRKS = config.tracks;

              blockLinesArray[i] = updatedLine;
              updatedCount++;
            }
          });

          if (Number.isFinite(sectionSpeed)) {
            console.log('[TrackConfig] Section Speed applied:', sectionSpeed);
            console.log('[TrackConfig] BlockSctnLine count:', updatedCount);
          }
        }
        newData.sheets.BlockSctnLine = blockLinesArray;

        // Phase 2: Update Station Loops (First, Common, Other Loop Speeds) & Main Lines (Section Speed)
        let stationLinesArray = [...(newData.sheets.StationLine || [])];
        if (stations && stations.length > 0 && (config.sectionSpeed !== undefined || config.firstLoop !== undefined || config.otherLoop !== undefined || config.commonLoop !== undefined)) {
          let updatedMainLinesCount = 0;
          const sectionSpeed = Number(config.sectionSpeed);

          stations.forEach(stnCode => {
            const cleanStn = String(stnCode).trim();
            const allLines = [];

            stationLinesArray.forEach((l, i) => {
              const c = String(l.MAVSTTNCODE).trim();
              if (c === cleanStn || String(l['STATION CODE']).trim() === cleanStn) {
                const cat = String(l.MACLINECATEGORY || '').trim().toUpperCase();
                const isMain = cat === 'M' || cat === 'MAIN';
                allLines.push({ index: i, seq: parseFloat(l.MANSEQNUMB) || 0, isMain });
              }
            });

            allLines.sort((a, b) => a.seq - b.seq);

            const firstLoopIndices = [];
            const commonLoopIndices = [];
            const otherLoopIndices = [];

            const mainLineIndexes = [];
            allLines.forEach((l, i) => { if (l.isMain) mainLineIndexes.push(i); });

            if (mainLineIndexes.length > 0) {
              const firstMainIdx = mainLineIndexes[0];
              const lastMainIdx = mainLineIndexes[mainLineIndexes.length - 1];

              // Apply Section Speed to all Main Lines in this station
              if (Number.isFinite(sectionSpeed)) {
                mainLineIndexes.forEach(idx => {
                  const globalIdx = allLines[idx].index;
                  stationLinesArray[globalIdx] = { ...stationLinesArray[globalIdx], MAVSPEED: sectionSpeed };
                  updatedMainLinesCount++;
                });
              }

              // Upwards (indices < firstMainIdx)
              let dist = 1;
              for (let i = firstMainIdx - 1; i >= 0; i--) {
                if (dist === 1) firstLoopIndices.push(allLines[i].index);
                else if (dist === 2) commonLoopIndices.push(allLines[i].index);
                else otherLoopIndices.push(allLines[i].index);
                dist++;
              }

              // Downwards (indices > lastMainIdx)
              dist = 1;
              for (let i = lastMainIdx + 1; i < allLines.length; i++) {
                if (dist === 1) firstLoopIndices.push(allLines[i].index);
                else if (dist === 2) commonLoopIndices.push(allLines[i].index);
                else otherLoopIndices.push(allLines[i].index);
                dist++;
              }
            } else {
              console.warn(`[Track Config] Skipped loop & main line speed assignment for station ${cleanStn} because no Main Line was found.`);
            }

            firstLoopIndices.forEach(idx => {
              if (config.firstLoop !== undefined) stationLinesArray[idx] = { ...stationLinesArray[idx], MAVSPEED: config.firstLoop };
            });
            commonLoopIndices.forEach(idx => {
              if (config.commonLoop !== undefined) stationLinesArray[idx] = { ...stationLinesArray[idx], MAVSPEED: config.commonLoop };
            });
            otherLoopIndices.forEach(idx => {
              if (config.otherLoop !== undefined) stationLinesArray[idx] = { ...stationLinesArray[idx], MAVSPEED: config.otherLoop };
            });
          });

          if (Number.isFinite(sectionSpeed)) {
            console.log('[TrackConfig] Main Line StationLine records updated:', updatedMainLinesCount);
          }
        }
        newData.sheets.StationLine = stationLinesArray;
      }

      // Write the modified linesArray back for all block actions except
      // bulk-block-config (which uses its own blockLinesArray and assigns it separately).
      if (action !== 'bulk-block-config') {
        newData.sheets.BlockSctnLine = linesArray;
      }
    } else if (type === 'station') {
      const stnCode = lineData.stnCode || lineData.code;
      const originalLine = lineData.originalLine;
      const linesArray = [...(newData.sheets.StationLine || [])];

      if (action === 'delete') {
        const idx = linesArray.findIndex(l => l.MANSTTNLINENUMB === originalLine.MANSTTNLINENUMB);
        if (idx !== -1) {
          linesArray.splice(idx, 1);
        }

        // Also remove connections that reference this station line
        if (newData.sheets.Connections) {
          const stnLineNum = parseInt(originalLine.MANSTTNLINENUMB);
          const seqNum = parseFloat(originalLine.MANSEQNUMB);
          const labelNum = String(originalLine.MAVLINENUMB).trim();
          const cleanStnCode = String(stnCode).trim();
          newData.sheets.Connections = [...newData.sheets.Connections].filter(c => {
            const matchesCode = String(c.MAVSTTNCODE).trim() === cleanStnCode;
            const cNumRaw = String(c.MANSTTNLINENUMB).trim();
            const cNum = parseInt(cNumRaw);
            const matchesLine = (!isNaN(cNum) && (cNum === stnLineNum || cNum === seqNum)) || (labelNum && cNumRaw === labelNum);
            return !(matchesCode && matchesLine);
          });
        }
      } else if (action === 'add') {
        const stnLines = linesArray.filter(l => l.MAVSTTNCODE === stnCode);
        const maxSeq = Math.max(...stnLines.map(l => parseFloat(l.MANSEQNUMB) || 0), 0);
        const minSeq = Math.min(...stnLines.map(l => parseFloat(l.MANSEQNUMB) || 999), 999);

        let newSeq = maxSeq + 1;
        if (options && options.targetSeq !== undefined) {
          const tSeq = parseFloat(options.targetSeq);
          newSeq = options.position === 'up' ? tSeq - 0.5 : tSeq + 0.5;
        } else if (options && options.position === 'top') {
          newSeq = (minSeq === 999 ? 1 : minSeq) - 1;
        }

        const templateLine = stnLines.length > 0 ? stnLines[0] : { MAVSTTNCODE: stnCode };

        const maxStnId = linesArray.reduce((max, l) => Math.max(max, parseInt(l.MANSTTNLINENUMB) || 0), 0);
        const newLine = {
          ...templateLine,
          MAVSTTNCODE: stnCode,
          MACLINECATEGORY: 'LOOP',
          MANSEQNUMB: String(newSeq),
          MAVDRTN: (options && options.direction) ? options.direction : 'BOTH',
          MAVLINENUMB: options?.lineName !== undefined ? options.lineName : String(newSeq),
          MANSTTNLINENUMB: String(Math.max(100, maxStnId + 1))
        };
        linesArray.push(newLine);
      } else if (action === 'speed') {
        const idx = linesArray.indexOf(originalLine);
        if (idx !== -1) {
          linesArray[idx] = { ...linesArray[idx], MAVSPEED: options.speed };
        }
      } else if (action === 'add-platform') {
        const originalLine = lineData.originalLine;
        const platformsArray = [...(newData.sheets.Platform || [])];
        const newPf = {
          MAVSTTNCODE: originalLine.MAVSTTNCODE,
          MANSEQNUMB: originalLine.MANSEQNUMB,
          MAVPLATFORMNUMB: options.platformName,
          MAVPFVPOSITION: options.vPos,
          MAVPFHPOSITION: options.hPos
        };
        platformsArray.push(newPf);
        newData.sheets.Platform = platformsArray;
      } else if (action === 'delete-platform') {
        const platformToDelete = options.platform;
        if (newData.sheets.Platform) {
          // Identify EXACT platform based on code, seq, num, position
          newData.sheets.Platform = newData.sheets.Platform.filter(p =>
            !(p.MAVSTTNCODE === platformToDelete.MAVSTTNCODE &&
              p.MANSEQNUMB === platformToDelete.MANSEQNUMB &&
              p.MAVPLATFORMNUMB === platformToDelete.MAVPLATFORMNUMB &&
              p.MAVPFVPOSITION === platformToDelete.MAVPFVPOSITION &&
              p.MAVPFHPOSITION === platformToDelete.MAVPFHPOSITION)
          );
        }
      } else if (action === 'update-platform') {
        const targetPlatform = options.platform;
        if (newData.sheets.Platform) {
          newData.sheets.Platform = newData.sheets.Platform.map(p => {
            if (p.MAVSTTNCODE === targetPlatform.MAVSTTNCODE &&
              p.MANSEQNUMB === targetPlatform.MANSEQNUMB &&
              p.MAVPLATFORMNUMB === targetPlatform.MAVPLATFORMNUMB &&
              p.MAVPFVPOSITION === targetPlatform.MAVPFVPOSITION &&
              p.MAVPFHPOSITION === targetPlatform.MAVPFHPOSITION) {
              return { ...p, MAVPFHPOSITION: options.newHPos };
            }
            return p;
          });
        }
      }
      newData.sheets.StationLine = linesArray;
    } else if (type === 'connection') {
      if (action === 'delete') {
        const connsArray = [...(newData.sheets.Connections || [])];
        const idx = connsArray.indexOf(lineData);
        if (idx !== -1) {
          connsArray.splice(idx, 1);
          newData.sheets.Connections = connsArray;
        }
      } else if (action === 'add-connection') {
        const { source, target } = options;

        let stnSource = null, bsSource = null;
        let isSend = true;

        if (source.type === 'station' && target.type === 'block') {
          stnSource = source.lineData;
          bsSource = target.lineData;
          isSend = true;
        } else if (source.type === 'block' && target.type === 'station') {
          stnSource = target.lineData;
          bsSource = source.lineData;
          isSend = false;
        }

        if (stnSource && bsSource) {
          const connsArray = [...(newData.sheets.Connections || [])];

          const newConnection = {
            MAVSTTNCODE: stnSource.stnCode || stnSource.originalLine?.MAVSTTNCODE,
            MAVBLCKSCTN: bsSource.bsCode || bsSource.originalLine?.MAVBLCKSCTN,
            MANSTTNLINENUMB: stnSource.originalLine?.MANSEQNUMB || stnSource.originalLine?.MAVLINENUMB,
            MANBSLINENUMB: bsSource.originalLine?.MANSEQNUMB || bsSource.originalLine?.MAVLINENUMB,
            MACRECVSENDFLAG: isSend ? 'S' : 'R'
          };

          connsArray.push(newConnection);
          newData.sheets.Connections = connsArray;
        }
      }
    }

    if (action === 'bulk-block-config') {
      setAppliedLayout(null);
    }
    setData(newData);

    const isStructural = ['add', 'delete', 'add-connection', 'delete-connection', 'add-platform', 'delete-platform', 'update-platform', 'bulk-block-config'].includes(action);
    if (isStructural) {
      handleGenerate(selectedValue, newData);
      setAppliedLayout(null);
    } else {
      // Non-structural updates (speed, signalling) only require localized attribute updates.
      // We directly mutate the active layout models to skip expensive layout parsing and geometry regeneration.
      setGeneratedLayout(prev => {
        if (!prev) return prev;
        const next = { ...prev, blockSections: { ...prev.blockSections }, stations: { ...prev.stations } };

        if (type === 'block') {
          const bsCode = lineData ? (typeof lineData === 'string' ? lineData : (lineData.bsCode || lineData.code)) : null;
          if (bsCode) {
            const cleanBsCode = String(bsCode).trim();
            const reversedBsCode = cleanBsCode.split('-').reverse().join('-');
            [cleanBsCode, reversedBsCode].forEach(code => {
              if (next.blockSections[code]) {
                const updatedLines = next.blockSections[code].lines.map(l => {
                  if (action === 'speed') return { ...l, MAVSPEED: options.speed };
                  if (action === 'loopspeed' && lineData.originalLine && l.MANBSLINENUMB === lineData.originalLine.MANBSLINENUMB) return { ...l, MAVSPEED: options.speed };
                  if (action === 'signalling') return { ...l, MAVSIGNALLING: options.signalling };
                  if (action === 'blocktime') return { ...l, MANBLOCKTIMEMINS: options.blockTime };
                  if (action === 'tracks') return { ...l, MACNBOFTRKS: options.tracks };
                  return l;
                });
                next.blockSections[code] = { ...next.blockSections[code], lines: updatedLines };
              }
            });
          }
        } else if (type === 'station') {
          const stnCode = lineData ? (lineData.stnCode || lineData.code) : null;
          if (stnCode) {
            const cleanStnCode = String(stnCode).trim();
            if (next.stations[cleanStnCode]) {
              const updatedLines = next.stations[cleanStnCode].lines.map(l => {
                if (action === 'speed') return { ...l, MAVSPEED: options.speed };
                return l;
              });
              next.stations[cleanStnCode] = { ...next.stations[cleanStnCode], lines: updatedLines };
            }
          }
        }
        setAppliedLayout(next); // Keep appliedLayout in sync
        return next;
      });
    }
  };

  const handleResetLayout = () => {
    setLoading(true);
    api.layoutData()
      .then(res => {
        setData({ ...res });
        setHistory([]);
        setAppliedLayout(null);
        handleGenerate(selectedValue, res);
        setLoading(false);
      })
      .catch(err => {
        setError(err.message);
        setLoading(false);
      });
  };

  const handleUndo = () => {
    if (history.length === 0) return;
    const previousSheets = cloneSheets(history[history.length - 1]);

    setHistory(prev => prev.slice(0, -1));

    const restoredData = { ...data, sheets: previousSheets };
    setData(restoredData);
    handleGenerate(selectedValue, restoredData);
    setAppliedLayout(null);
  };

  if (loading) return <div className="layout-tab card">Loading data...</div>;
  if (error) return <div className="layout-tab card error">Error: {error}</div>;

  return (
    <div className="layout-tab">
      {data && data.available.length < 5 && (
        <div className="missing-data-alert card glass" style={{ margin: '0 0 4px 0', padding: '4px 8px', fontSize: '0.85rem', width: 'fit-content' }}>
          Missing: {["RouteInfo", "StationLine", "BlockSctnLine", "Connections", "Platform"].filter(s => !data.available.includes(s)).join(', ')}
        </div>
      )}

      {generatedLayout && document.getElementById('navbar-portal-target') && createPortal(
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <label style={{ margin: 0, fontSize: '0.9rem', fontWeight: 'bold' }}>Select Station:</label>
          <select
            className="btn-primary"
            value={navDropdownVal}
            onChange={(e) => { setNavDropdownVal(e.target.value); if (e.target.value) setNavTrigger(t => t + 1); }}
            style={{ margin: 0, padding: '4px 8px', borderRadius: '4px', cursor: 'pointer', border: 'none', fontWeight: 'bold', fontSize: '0.85rem' }}
          >
            <option value="" style={{ background: '#fff', color: '#000' }}>Select Station</option>
            {generatedLayout.sequence.filter(n => n.type === 'station').map(stn => (
              <option key={stn.code} value={stn.code} style={{ background: '#fff', color: '#000' }}>{stn.code}</option>
            ))}
          </select>
        </div>,
        document.getElementById('navbar-portal-target')
      )}

      {warnings.length > 0 && (
        <div className="layout-warnings card glass" style={{ padding: '4px', marginBottom: '4px' }}>
          <h4 style={{ margin: 0, fontSize: '0.9rem' }}>Diagnostics</h4>
          <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '0.85rem' }}>
            {warnings.map((w, i) => (
              <li key={i} className={`warn-item ${w.type}`}>{w.type === 'warn' ? 'Warning: ' : 'Info: '}{w.msg}</li>
            ))}
          </ul>
        </div>
      )}



      {generatedLayout && (
        <ErrorBoundary key={selectedValue}>
          <div style={{ marginBottom: '8px', display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={() => setShowConnectionsModal(true)}
                className="btn-primary"
                style={{ padding: '5px 12px', fontSize: '0.82rem', borderRadius: '4px', cursor: 'pointer', border: 'none', fontWeight: 'bold', backgroundColor: '#8b5cf6', color: '#fff' }}
              >
                Connections
              </button>
              <div style={{ position: 'relative' }}>
                <TrackConfigButton
                  generatedLayout={generatedLayout}
                  data={data}
                  onModifyLayout={handleModifyLayout}
                />
              </div>
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={handleUndo}
                disabled={history.length === 0}
                className="btn-primary"
                style={{ padding: '5px 12px', fontSize: '0.82rem', borderRadius: '4px', cursor: history.length === 0 ? 'not-allowed' : 'pointer', border: 'none', fontWeight: 'bold', backgroundColor: history.length === 0 ? '#94a3b8' : '#eab308', color: history.length === 0 ? '#cbd5e1' : '#fff' }}
              >
                Undo
              </button>
              <button
                onClick={handleResetLayout}
                className="btn-primary"
                style={{ padding: '5px 12px', fontSize: '0.82rem', borderRadius: '4px', cursor: 'pointer', border: 'none', fontWeight: 'bold', backgroundColor: '#ef4444' }}
              >
                Reset Layout
              </button>
              <button
                onClick={() => setShowBigLayout(v => !v)}
                className="btn-primary"
                style={{ padding: '5px 12px', fontSize: '0.82rem', borderRadius: '4px', cursor: 'pointer', border: 'none', fontWeight: 'bold', backgroundColor: showBigLayout ? '#6366f1' : '#10b981', color: '#fff', transition: 'background-color 0.2s' }}
              >
                {showBigLayout ? 'Collapse Layout' : 'Expand Layout'}
              </button>
            </div>
          </div>

          <div
            className="layout-canvas-container card glass"
            style={{ padding: '2px', marginBottom: '16px', display: showBigLayout ? 'block' : 'none', position: 'relative' }}
          >
            <StationLayout layout={generatedLayout} scrollToStation={navDropdownVal} navTrigger={navTrigger} onModifyLayout={handleModifyLayout} />

            <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '8px 16px', borderTop: '1px solid #e2e8f0', backgroundColor: '#f8fafc', borderBottomLeftRadius: '12px', borderBottomRightRadius: '12px' }}>
              <button
                onClick={() => setAppliedLayout(generatedLayout)}
                disabled={appliedLayout === generatedLayout}
                className="btn-primary"
                style={{
                  padding: '8px 20px',
                  fontSize: '0.85rem',
                  borderRadius: '6px',
                  cursor: appliedLayout === generatedLayout ? 'not-allowed' : 'pointer',
                  border: 'none',
                  fontWeight: 'bold',
                  backgroundColor: appliedLayout === generatedLayout ? '#94a3b8' : '#10b981',
                  color: '#fff',
                  boxShadow: appliedLayout === generatedLayout ? 'none' : '0 2px 4px rgba(16, 185, 129, 0.3)',
                  transition: 'all 0.2s'
                }}
              >
                Apply Changes
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
            {data.sheets.Schedule && data.sheets.Schedule.length > 0 && (
              <div style={{ flex: 1, minWidth: 0 }}>
                <TimeDistanceGraph layout={appliedLayout || generatedLayout} showSimulationModal={showSimulationModal} setShowSimulationModal={setShowSimulationModal} scheduleData={data.sheets.Schedule} routeInfo={data.sheets.RouteInfo} stationLines={data.sheets.StationLine} />
              </div>
            )}
          </div>
        </ErrorBoundary>
      )}

      {showConnectionsModal && (
        <ConnectionTableModal
          layout={generatedLayout}
          data={data}
          onSave={(newData) => {
            const previousSheets = cloneSheets(data.sheets);
            setHistory(prev => [...prev, previousSheets]);
            setData(newData);
            handleGenerate(selectedValue, newData);
            setAppliedLayout(null);
            setShowConnectionsModal(false);
          }}
          onClose={() => setShowConnectionsModal(false)}
        />
      )}
    </div>
  );


}