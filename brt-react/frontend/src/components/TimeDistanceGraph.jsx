import React, { useMemo, useState, useRef, useEffect } from 'react';
import { runSimulation as runSimulationExternal } from '../simulation/freightScheduler';
import { calculateGoodsSpeedConfig } from '../utils/goodsSpeedCalculator';

/**
 * TimeDistanceGraph renders a dynamic 2D graph where:
 * - The Y-axis represents Physical Distance (stations spaced according to the layout).
 * - The X-axis represents Time (24h or continuous 48h windows).
 * 
 * It plots train schedules as lines intersecting the stations at their arrival/departure times.
 * 
 * @param {Object} layout - The structured topology layout.
 * @param {Array} scheduleData - The raw schedule rows from the Excel 'Schedule' sheet.
 */
export default function TimeDistanceGraph({ layout, scheduleData, routeInfo = [], showSimulationModal, setShowSimulationModal, stationLines = [] }) {
  const [windowMode, setWindowMode] = useState('24h');
  const [timeBlock, setTimeBlock] = useState('all'); // 'all', '0-8', '8-16', '16-24'
  const [ySpacing, setYSpacing] = useState('equidistant');
  const [yView, setYView] = useState('fit');
  const [hoveredTrain, setHoveredTrain] = useState(null);
  const [selectedTrain, setSelectedTrain] = useState(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const containerRef = useRef(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [simulatedPaths, setSimulatedPaths] = useState([]);
  const [simSource, setSimSource] = useState('');
  const [simDest, setSimDest] = useState('');
  const [simDay, setSimDay] = useState('All');
  const [hoveredSimDay, setHoveredSimDay] = useState(null);
  const [simTimeFrom, setSimTimeFrom] = useState('00:00');
  const [simTimeUpto, setSimTimeUpto] = useState('23:59');
  const [simCompletionTime, setSimCompletionTime] = useState('');
  const [simHeadway, setSimHeadway] = useState('5');
  const [simSpeed, setSimSpeed] = useState('');
  const [simMaxDetention, setSimMaxDetention] = useState('2');

  const [goodsSpeedConfig, setGoodsSpeedConfig] = useState(null);
  const [goodsSpeedOverrides, setGoodsSpeedOverrides] = useState({});
  const [simTrainLoadType, setSimTrainLoadType] = useState('LOADED');

  const [simAccelTime, setSimAccelTime] = useState('05:00');
  const [simDecelTime, setSimDecelTime] = useState('03:00');
  const [simBlockCorridor, setSimBlockCorridor] = useState(false);
  const [simBlockOperatingTime, setSimBlockOperatingTime] = useState('');
  // Direction: array of 'forward' | 'backward'
  const [simDirections, setSimDirections] = useState(['forward', 'backward']);
  // simStops: array of { code: string, halt: number (mins) }
  const [simStops, setSimStops] = useState([]);
  const [isStopsDropdownOpen, setIsStopsDropdownOpen] = useState(false);
  const [stopSearchQuery, setStopSearchQuery] = useState('');
  const abortSimRef = useRef(false);
  const [isSimulating, setIsSimulating] = useState(false);
  const [showSimStatsModal, setShowSimStatsModal] = useState(false);
  const [showGoodsConfigModal, setShowGoodsConfigModal] = useState(false);

  const formatMMSS = (val, prevVal) => {
    if (!val) return '';
    if (prevVal && prevVal.endsWith(':') && val === prevVal.slice(0, -1)) {
      return val.slice(0, -1);
    }
    let digits = val.replace(/\D/g, '');
    if (digits.length > 4) digits = digits.slice(0, 4);

    if (digits.length >= 3) {
      let mm = digits.slice(0, 2);
      let ss = digits.slice(2);
      if (ss.length >= 1 && parseInt(ss[0], 10) > 5) {
        ss = '5' + (ss.length > 1 ? ss[1] : '');
      }
      if (ss.length === 2 && parseInt(ss, 10) > 59) {
        ss = '59';
      }
      return `${mm}:${ss}`;
    } else if (digits.length === 2) {
      return `${digits}:`;
    }
    return digits;
  };

  const handleCancelSimulation = () => {
    if (isSimulating) {
      abortSimRef.current = true;
      setIsSimulating(false);
    }
    setShowSimulationModal(false);
    setIsStopsDropdownOpen(false);
  };

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(entries => {
      for (let entry of entries) {
        if (entry.contentRect.width > 0) {
          setContainerWidth(entry.contentRect.width);
        }
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    console.log("[GOODS CALL CHECK]", {
      layoutExists: !!layout,
      layoutSequenceLength: layout?.sequence?.length,
      shouldCall: !!(layout && layout.sequence)
    });

    if (layout && layout.sequence) {
      console.log("[GOODS DEBUG] >>> CALLING calculateGoodsSpeedConfig()");
      calculateGoodsSpeedConfig(null, layout).then(config => {
        console.log("[GOODS UI TRACE] calculator returned:", config);
        console.log("[GOODS UI TRACE] forward SGAC-CDSL:", config?.forward?.["SGAC-CDSL"]);
        console.log("[GOODS UI TRACE] backward SGAC-CDSL:", config?.backward?.["SGAC-CDSL"]);

        setGoodsSpeedConfig(config);
      }).catch(err => {
        console.error("[GOODS SPEED CALCULATOR ERROR] inside TimeDistanceGraph:", err);
      });
    } else {
      console.warn("[GOODS DEBUG] >>> CALCULATOR NOT CALLED", {
        layoutExists: !!layout
      });
    }
  }, [layout]);

  useEffect(() => {
    console.log("[GOODS UI TRACE] goodsSpeedConfig STATE:", goodsSpeedConfig);
    console.log("[GOODS UI TRACE] STATE forward SGAC-CDSL:",
      goodsSpeedConfig?.forward?.["SGAC-CDSL"]);
  }, [goodsSpeedConfig]);

  const graphData = useMemo(() => {
    if (!layout || !layout.sequence || !scheduleData) return null;

    const routeDetailsMap = {};
    if (routeInfo && routeInfo.length > 0) {
      routeInfo.forEach(r => {
        if (r.STATION_CODE) {
          routeDetailsMap[r.STATION_CODE] = {
            seq: r.SEQ_NO,
            zone: r.ZONE_CODE,
            division: r.DIVISION_CODE
          };
        }
      });
    }

    const numStations = layout.sequence.filter(n => n.type === 'station').length;
    const numBlocks = layout.sequence.filter(n => n.type === 'block').length;

    let totalAvailableHeight = 450;
    if (typeof window !== 'undefined') {
      totalAvailableHeight = yView === 'fit'
        ? Math.max(window.innerHeight - 170, 350)
        : Math.max(window.innerHeight - 170, numStations * 60);
    }

    // Default fallback
    let stationHeight = 45;
    let blockHeight = 15;

    if (numStations > 0) {
      // Station takes 3x space of a block
      const unit = totalAvailableHeight / ((3 * numStations) + numBlocks);
      stationHeight = 3 * unit;
      blockHeight = unit;
    }

    let totalPhysicalDistance = 0;
    layout.sequence.forEach(node => {
      if (node.type === 'block') {
        totalPhysicalDistance += parseFloat(node.distance) || 0;
      }
    });

    let currentY = 0;
    let cumulativeDistance = 0;

    const stationYMap = {};
    const layoutStations = [];

    layout.sequence.forEach((node) => {
      if (node.type === 'station') {
        let y = 0;
        if (ySpacing === 'scaled') {
          if (totalPhysicalDistance > 0) {
            y = 0 + (cumulativeDistance / totalPhysicalDistance) * totalAvailableHeight;
          }
        } else {
          y = currentY;
          currentY += stationHeight;
        }

        const stnData = layout.stations && layout.stations[node.code];
        let stnLines = [];
        if (stnData && stnData.lines) {
          stnLines = [...stnData.lines].sort((a, b) => parseInt(a.MANSEQNUMB || 0) - parseInt(b.MANSEQNUMB || 0));
        }

        stationYMap[node.code] = y;
        layoutStations.push({
          code: node.code,
          y: y,
          name: node.name,
          cumDist: cumulativeDistance.toFixed(1) + ' km',
          lines: stnLines
        });
      } else if (node.type === 'block') {
        const d = parseFloat(node.distance) || 0;
        cumulativeDistance += d;
        if (ySpacing === 'equidistant') {
          currentY += blockHeight;
        }
      }
    });

    const lastStationY = layoutStations.length > 0 ? layoutStations[layoutStations.length - 1].y : currentY;
    const totalHeight = lastStationY + 20;

    if (layoutStations.length === 0) return null;

    const layoutStationCodes = new Set(layoutStations.map(s => s.code));



    const trains = {};

    scheduleData.forEach(row => {
      if (!layoutStationCodes.has(row.MAVSTTNCODE)) return;

      let trainNo = String(row.MAVTRAINNUMBER || '').trim();
      if (trainNo.length === 4 && /^\d{4}$/.test(trainNo)) {
        trainNo = '0' + trainNo;
      }

      if (!trains[trainNo]) {
        trains[trainNo] = { trainNo, name: row.MAVTRAINNAME, stops: [], daysOfSrvc: row.MAVBLCKBUSYDAYS };
      }

      let arrTime = parseInt(row.MANWTTARVL) || 0;
      let depTime = parseInt(row.MANWTTDPRT) || 0;

      if (arrTime === 0 && depTime > 0) arrTime = depTime;
      if (depTime === 0 && arrTime > 0) depTime = arrTime;

      if (arrTime > 0) {
        const routeDtl = routeDetailsMap[row.MAVSTTNCODE] || {};
        const seqNum = parseInt(row.MANSEQNUMBER);
        const isOrigin = seqNum === 1;

        // Destination if there's an arrival time but no departure time in the raw data
        const rawDep = row.MANWTTDPRT;
        const isDestination = !rawDep || String(rawDep).trim() === '' || parseInt(rawDep) === 0;

        trains[trainNo].stops.push({
          station: row.MAVSTTNCODE,
          zone: routeDtl.zone || row.MAVZONECODE || "-",
          division: routeDtl.division || row.MAVDVSNCODE || "-",
          seq: row.MANSEQNUMBER || routeDtl.seq || "-",
          dayOfSrvc: row.MANWTTDAYOFRUN || "-",
          weekDay: formatDaysOfService(row.MAVBLCKBUSYDAYS),
          rawDaysOfSrvc: row.MAVBLCKBUSYDAYS,
          y: stationYMap[row.MAVSTTNCODE],
          arrTime: (arrTime / 3600) % 24,
          depTime: (depTime / 3600) % 24,
          arrStr: isOrigin ? "Origin" : formatTime(arrTime),
          depStr: isDestination ? "Destination" : formatTime(depTime)
        });
      }
    });

    const trainLines = [];
    const canonicalTrains = [];

    Object.values(trains).forEach(train => {
      if (train.stops.length < 2) return;

      const stnIndexMap = {};
      layoutStations.forEach((stn, idx) => stnIndexMap[stn.code] = idx);

      // Ensure chronological order by sorting via sequence number first
      train.stops.sort((a, b) => {
        const seqA = parseInt(a.seq);
        const seqB = parseInt(b.seq);
        if (!isNaN(seqA) && !isNaN(seqB)) {
          return seqA - seqB;
        }
        // Fallback to layout index if seq is missing (should be rare)
        const idxA = stnIndexMap[a.station];
        const idxB = stnIndexMap[b.station];
        return idxA - idxB;
      });

      // Determine the base daysOfSrvc from the first stop in the layout
      if (train.stops.length > 0) {
        train.daysOfSrvc = train.stops[0].rawDaysOfSrvc;
      }

      let currentDayOffset = 0;
      let lastRawDep = -1;

      train.stops.forEach((stop) => {
        const rawArr = stop.arrTime;
        const rawDep = stop.depTime;

        if (lastRawDep !== -1 && rawArr < lastRawDep) {
          currentDayOffset++;
        }

        stop.arrTime = rawArr + currentDayOffset * 24;

        if (rawDep < rawArr) {
          stop.depTime = rawDep + (currentDayOffset + 1) * 24;
          currentDayOffset++;
        } else {
          stop.depTime = rawDep + currentDayOffset * 24;
        }

        lastRawDep = rawDep;
      });

      const firstStop = train.stops[0];
      const lastStop = train.stops[train.stops.length - 1];
      const isForward = lastStop.y > firstStop.y;

      train.isForward = isForward;

      const firstDigit = train.trainNo.charAt(0);
      if (['1', '2', '8'].includes(firstDigit)) {
        train.color = '#dc2626'; // Red
      } else if (['5', '6', '7'].includes(firstDigit)) {
        train.color = '#2563eb'; // Blue
      } else if (['3', '4', '9'].includes(firstDigit)) {
        train.color = '#000000'; // Black
      } else if (firstDigit === '0') {
        train.color = '#9333ea'; // Purple
      } else {
        train.color = isForward ? '#2563eb' : '#ea580c';
      }

      train.originalTrainNo = train.trainNo;

      canonicalTrains.push(train);

      const isSpecificDayMode = typeof windowMode === 'string' && windowMode.startsWith('day-');
      if (windowMode === '7d' || isSpecificDayMode) {
        const daysStr = train.daysOfSrvc ? String(train.daysOfSrvc) : '1111111';
        const bits = daysStr.replace(/[^01]/g, '');
        let runsOnDays = [1, 1, 1, 1, 1, 1, 1];
        if (bits.length === 7) {
          runsOnDays = bits.split('').map(d => parseInt(d));
        } else if (daysStr.toLowerCase() === 'daily') {
          runsOnDays = [1, 1, 1, 1, 1, 1, 1];
        } else {
          const dStr = daysStr.toLowerCase().trim();
          if (dStr === 'm' || dStr === 'mon' || dStr === 'monday') {
            runsOnDays = [1, 0, 0, 0, 0, 0, 0];
          } else if (dStr === 'tu' || dStr === 'tue' || dStr === 'tuesday') {
            runsOnDays = [0, 1, 0, 0, 0, 0, 0];
          } else if (dStr === 'w' || dStr === 'wed' || dStr === 'wednesday') {
            runsOnDays = [0, 0, 1, 0, 0, 0, 0];
          } else if (dStr === 'th' || dStr === 'thu' || dStr === 'thursday') {
            runsOnDays = [0, 0, 0, 1, 0, 0, 0];
          } else if (dStr === 'f' || dStr === 'fri' || dStr === 'friday') {
            runsOnDays = [0, 0, 0, 0, 1, 0, 0];
          } else if (dStr === 'sa' || dStr === 'sat' || dStr === 'saturday') {
            runsOnDays = [0, 0, 0, 0, 0, 1, 0];
          } else if (dStr === 'su' || dStr === 'sun' || dStr === 'sunday') {
            runsOnDays = [0, 0, 0, 0, 0, 0, 1];
          }
        }

        runsOnDays.forEach((runs, dayIndex) => {
          if (runs) {
            const clonedTrain = { ...train, trainNo: `${train.trainNo}-${dayIndex}`, originalTrainNo: train.trainNo, stops: [] };
            train.stops.forEach(stop => {
              clonedTrain.stops.push({
                ...stop,
                arrTime: stop.arrTime + (dayIndex * 24),
                depTime: stop.depTime + (dayIndex * 24)
              });
            });
            trainLines.push(clonedTrain);
          }
        });
      } else {
        trainLines.push(train);
      }
    });

    const minTime = 0;
    const isSpecificDayMode = typeof windowMode === 'string' && windowMode.startsWith('day-');
    const maxTime = (windowMode === '7d' || isSpecificDayMode) ? 168 : 24;

    const trackBlocks = [];
    for (let i = 0; i < layout.sequence.length; i++) {
      const node = layout.sequence[i];
      if (node.type === 'block') {
        const prevStns = layout.sequence.slice(0, i).filter(n => n.type === 'station');
        const prevStn = prevStns.length > 0 ? prevStns[prevStns.length - 1] : null;
        const nextStn = layout.sequence.slice(i + 1).find(n => n.type === 'station');
        if (prevStn && nextStn && stationYMap[prevStn.code] !== undefined && stationYMap[nextStn.code] !== undefined) {
          let linesCount = 1;
          let trackColor = 'default';
          if (layout.blockSections && layout.blockSections[node.code]) {
            const bs = layout.blockSections[node.code];
            linesCount = Math.max(1, bs.lines ? bs.lines.length : 1);
            if (linesCount >= 2) trackColor = 'double';
          } else if (node.lines) {
            linesCount = Math.max(1, node.lines);
            if (linesCount >= 2) trackColor = 'double';
          }
          trackBlocks.push({
            y1: stationYMap[prevStn.code],
            y2: stationYMap[nextStn.code],
            lines: linesCount,
            trackColor
          });
        }
      }
    }

    return { totalHeight, minTime, maxTime, trainLines, canonicalTrains, layoutStations, trackBlocks };
  }, [layout, scheduleData, windowMode, ySpacing, yView]);

  const goodsSpeedRows = useMemo(() => {
    console.log("[GOODS UI STATE]", {
      hasConfig: !!goodsSpeedConfig,
      forwardKeys: goodsSpeedConfig?.forward ? Object.keys(goodsSpeedConfig.forward) : [],
      backwardKeys: goodsSpeedConfig?.backward ? Object.keys(goodsSpeedConfig.backward) : [],
      sgacCdslForwardLoaded: goodsSpeedConfig?.forward?.["SGAC-CDSL"]?.LOADED?.defaultSpeed,
      sgacCdslForwardEmpty: goodsSpeedConfig?.forward?.["SGAC-CDSL"]?.EMPTY?.defaultSpeed,
      sgacCdslBackwardLoaded: goodsSpeedConfig?.backward?.["SGAC-CDSL"]?.LOADED?.defaultSpeed,
      sgacCdslBackwardEmpty: goodsSpeedConfig?.backward?.["SGAC-CDSL"]?.EMPTY?.defaultSpeed
    });

    if (!layout || !layout.sequence) return [];
    let rows = [];
    let lastStn = null;
    let currentBlock = null;
    for (let i = 0; i < layout.sequence.length; i++) {
      const node = layout.sequence[i];
      if (node.type === 'station') {
        if (lastStn && currentBlock) {
          const fwdName = `${lastStn.code}-${node.code}`;
          const bwdName = `${node.code}-${lastStn.code}`;
          const secCode = currentBlock.code;

          console.log("[GOODS SECTION CODE]", {
            layoutBlockCode: currentBlock.code,
            normalizedLayoutBlockCode: String(currentBlock.code || "").trim().toUpperCase(),
            availableForwardKeys: Object.keys(goodsSpeedConfig?.forward || {}),
            availableBackwardKeys: Object.keys(goodsSpeedConfig?.backward || {})
          });

          const fwdStats = goodsSpeedConfig?.forward?.[secCode] || { LOADED: {}, EMPTY: {} };
          const bwdStats = goodsSpeedConfig?.backward?.[secCode] || { LOADED: {}, EMPTY: {} };

          console.log("[GOODS ROW TRACE]", {
            secCode,
            fwdName,
            bwdName,
            configForwardExists: !!goodsSpeedConfig?.forward?.[secCode],
            configBackwardExists: !!goodsSpeedConfig?.backward?.[secCode],
            fwdLoaded: goodsSpeedConfig?.forward?.[secCode]?.LOADED?.defaultSpeed,
            fwdEmpty: goodsSpeedConfig?.forward?.[secCode]?.EMPTY?.defaultSpeed,
            bwdLoaded: goodsSpeedConfig?.backward?.[secCode]?.LOADED?.defaultSpeed,
            bwdEmpty: goodsSpeedConfig?.backward?.[secCode]?.EMPTY?.defaultSpeed
          });

          rows.push({
            secCode,
            fwdName,
            bwdName,
            fwdLoadedDef: fwdStats.LOADED?.defaultSpeed,
            fwdEmptyDef: fwdStats.EMPTY?.defaultSpeed,
            bwdLoadedDef: bwdStats.LOADED?.defaultSpeed,
            bwdEmptyDef: bwdStats.EMPTY?.defaultSpeed
          });
        }
        lastStn = node;
        currentBlock = null;
      } else if (node.type === 'block') {
        currentBlock = node;
      }
    }
    return rows;
  }, [layout, goodsSpeedConfig]);

  // Set default source/destination when layout loads (must be after graphData useMemo)
  useEffect(() => {
    if (!graphData || !graphData.layoutStations || graphData.layoutStations.length === 0) return;
    const stations = graphData.layoutStations;
    setSimSource(stations[0].code);
    if (stations.length > 1) {
      setSimDest(stations[stations.length - 1].code);
    }
  }, [graphData]);

  const availableStopStations = useMemo(() => {
    if (!graphData || !graphData.layoutStations || graphData.layoutStations.length <= 2) return [];
    return graphData.layoutStations.slice(1, graphData.layoutStations.length - 1);
  }, [graphData]);

  const runSimulation = async () => {
    if (!graphData || !graphData.layoutStations || graphData.layoutStations.length < 2) {
      setIsSimulating(false);
      return;
    }
    setIsSimulating(true);
    await new Promise(resolve => setTimeout(resolve, 10));

    try {
      const resultPaths = await runSimulationExternal({
        layout,
        layoutStations: graphData.layoutStations,
        canonicalTrains: graphData.canonicalTrains,
        simSource,
        simDest,
        scheduleData,
        stationLines,
        simDay,
        simTimeFrom,
        simTimeUpto,
        simCompletionTime,
        simHeadway,
        simMaxDetention,

        simSpeed,
        goodsSpeedConfig,
        goodsSpeedOverrides,
        simTrainLoadType,
        simAccelTime,
        simDecelTime,
        simBlockCorridor,
        simBlockOperatingTime,
        simStops,
        simDirections,
        abortSimRef,
        simulatedPaths,
        debug: true
      });

      if (abortSimRef.current) return;

      const newPaths = resultPaths.paths || resultPaths;

      if (newPaths && newPaths.length > 0) {
        setSimulatedPaths(prev => [...prev, ...newPaths]);
        setWindowMode('24h');
        setTimeBlock('all');
        setShowSimulationModal(false);
        alert(`✅ Simulation complete! ${newPaths.length} new train path(s) scheduled.`);
      } else {
        alert('Could not find any conflict-free path within the specified time window and limits.');
      }
    } catch (err) {
      console.error('Simulation error:', err);
      alert('Simulation error: ' + (err && err.message ? err.message : String(err)));
    } finally {
      setIsSimulating(false);
    }
  };


  const expandedSimulatedPaths = useMemo(() => {
    // Build a live Y-map from the current graphData so simulated lines scale correctly
    const liveYMap = {};
    if (graphData && graphData.layoutStations) {
      graphData.layoutStations.forEach(stn => { liveYMap[stn.code] = stn.y; });
    }

    const expanded = [];
    simulatedPaths.forEach(train => {
      const daysStr = train.daysOfSrvc || '1111111';
      const bits = daysStr.replace(/[^01]/g, '');
      let runsOnDays = [1, 1, 1, 1, 1, 1, 1];
      if (bits.length === 7) {
        runsOnDays = bits.split('').map(d => parseInt(d));
      }
      runsOnDays.forEach((runs, dayIndex) => {
        if (runs) {
          const clonedTrain = { ...train, trainNo: `${train.trainNo}-D${dayIndex}`, originalTrainNo: train.trainNo, stops: [] };
          train.stops.forEach(stop => {
            // Remap Y dynamically so simulated lines follow scale/equidistant correctly
            const liveY = liveYMap[stop.station] !== undefined ? liveYMap[stop.station] : stop.y;
            clonedTrain.stops.push({
              ...stop,
              y: liveY,
              arrTime: stop.arrTime + (dayIndex * 24),
              depTime: stop.depTime + (dayIndex * 24)
            });
          });
          expanded.push(clonedTrain);
        }
      });
    });
    return expanded;
  }, [simulatedPaths, graphData]);

  const exportSimulationsToCSV = () => {
    if (simulatedPaths.length === 0) {
      alert("No simulated paths to export.");
      return;
    }

    let csvContent = "data:text/csv;charset=utf-8,";
    csvContent += "MAVTRAINNUMBER,MAVTRAINNAME,MAVSTTNCODE,MANWTTARVL,MANWTTDPRT,MANSEQNUMBER,MANWTTDAYOFRUN,MAVBLCKBUSYDAYS\n";

    simulatedPaths.forEach((sim, idx) => {
      const trainNo = `SIM${idx + 1}`;
      const trainName = `Simulated Train ${idx + 1}`;
      const daysOfSrvc = sim.daysOfSrvc || '1111111';

      sim.stops.forEach((stop, stopIdx) => {
        let arrSecs = 0;
        let depSecs = 0;
        let dayOfRun = 1;

        if (stop.arrTime !== null && !isNaN(stop.arrTime)) {
          arrSecs = Math.round((stop.arrTime % 24) * 3600);
          dayOfRun = Math.floor(stop.arrTime / 24) + 1;
        }
        if (stop.depTime !== null && !isNaN(stop.depTime)) {
          depSecs = Math.round((stop.depTime % 24) * 3600);
          if (arrSecs === 0) dayOfRun = Math.floor(stop.depTime / 24) + 1;
        }

        if (stopIdx === 0) {
          arrSecs = depSecs;
        }
        if (stopIdx === sim.stops.length - 1) {
          depSecs = arrSecs;
        }

        const seqNum = stopIdx + 1;
        csvContent += `${trainNo},${trainName},${stop.station},${arrSecs},${depSecs},${seqNum},${dayOfRun},${daysOfSrvc}\n`;
      });
    });

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", "simulated_schedule.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="time-distance-graph card glass" style={{ marginTop: '0px' }} ref={containerRef}>
      <div style={{ padding: '8px 10px', borderBottom: '1px solid #333', display: 'flex', justifyContent: 'flex-start', alignItems: 'center', flexWrap: 'nowrap', overflowX: 'auto' }}>
        <h4 style={{ margin: 0, whiteSpace: 'nowrap', fontSize: '13px', marginRight: '15px', color: '#1b2036' }}>
          {graphData && graphData.layoutStations && graphData.layoutStations.length > 0
            ? `${graphData.layoutStations[0].code} - ${graphData.layoutStations[graphData.layoutStations.length - 1].code}`
            : "Time-Distance Graph"}
        </h4>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'nowrap', width: '100%' }}>
          {/* Day Group */}
          <div style={{ display: 'flex', gap: '1px', alignItems: 'center', backgroundColor: '#f1f5f9', padding: '3px', borderRadius: '8px', border: '1px solid #cbd5e1', boxShadow: 'inset 0 2px 4px 0 rgba(0, 0, 0, 0.02)', flexShrink: 0 }}>
            <span style={{ color: '#64748b', fontSize: '9px', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.4px', padding: '0 5px', whiteSpace: 'nowrap', flexShrink: 0 }}>Day</span>
            {[
              { label: 'Week', value: '7d' },
              { label: 'All Days', value: '24h' },
              ...['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d, i) => ({ label: d, value: `day-${i}` }))
            ].map(opt => (
              <label key={opt.value} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: '3px 10px', borderRadius: '5px', cursor: 'pointer',
                backgroundColor: windowMode === opt.value ? '#3b82f6' : 'transparent',
                color: windowMode === opt.value ? '#ffffff' : '#64748b',
                boxShadow: windowMode === opt.value ? '0 4px 6px -1px rgba(59, 130, 246, 0.4), 0 2px 4px -2px rgba(59, 130, 246, 0.4)' : 'none',
                transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)', fontWeight: windowMode === opt.value ? '700' : '600',
                fontSize: '10px', letterSpacing: '0.2px', transform: windowMode === opt.value ? 'scale(1.02)' : 'scale(1)',
                whiteSpace: 'nowrap', flexShrink: 0
              }}>
                <input type="radio" name="daySelection" value={opt.value} checked={windowMode === opt.value} onChange={() => setWindowMode(opt.value)} style={{ display: 'none' }} />
                {opt.label}
              </label>
            ))}
          </div>

          {/* Time Group */}
          <div style={{ display: 'flex', gap: '1px', alignItems: 'center', backgroundColor: '#f1f5f9', padding: '3px', borderRadius: '8px', border: '1px solid #cbd5e1', boxShadow: 'inset 0 2px 4px 0 rgba(0, 0, 0, 0.02)', flexShrink: 0 }}>
            <span style={{ color: '#64748b', fontSize: '9px', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.4px', padding: '0 5px', whiteSpace: 'nowrap', flexShrink: 0 }}>Time</span>
            {[
              { label: '00-24', value: 'all' },
              { label: '00-08', value: '0-8' },
              { label: '08-16', value: '8-16' },
              { label: '16-24', value: '16-24' }
            ].map(opt => (
              <label key={opt.value} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: '3px 10px', borderRadius: '5px', cursor: 'pointer',
                backgroundColor: timeBlock === opt.value ? '#3b82f6' : 'transparent',
                color: timeBlock === opt.value ? '#ffffff' : '#64748b',
                boxShadow: timeBlock === opt.value ? '0 4px 6px -1px rgba(59, 130, 246, 0.4), 0 2px 4px -2px rgba(59, 130, 246, 0.4)' : 'none',
                transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)', fontWeight: timeBlock === opt.value ? '700' : '600',
                fontSize: '10px', letterSpacing: '0.2px', transform: timeBlock === opt.value ? 'scale(1.02)' : 'scale(1)',
                whiteSpace: 'nowrap', flexShrink: 0
              }}>
                <input type="radio" name="timeSelection" value={opt.value} checked={timeBlock === opt.value} onChange={() => setTimeBlock(opt.value)} style={{ display: 'none' }} />
                {opt.label}
              </label>
            ))}
          </div>

          {/* Space Group */}
          <div style={{ display: 'flex', gap: '1px', alignItems: 'center', backgroundColor: '#f1f5f9', padding: '3px', borderRadius: '8px', border: '1px solid #cbd5e1', boxShadow: 'inset 0 2px 4px 0 rgba(0, 0, 0, 0.02)', flexShrink: 0 }}>
            <span style={{ color: '#64748b', fontSize: '9px', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.4px', padding: '0 5px', whiteSpace: 'nowrap', flexShrink: 0 }}>Space</span>
            {[
              { label: 'Eq', value: 'equidistant' },
              { label: 'Scale', value: 'scaled' }
            ].map(opt => (
              <label key={opt.value} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: '3px 10px', borderRadius: '5px', cursor: 'pointer',
                backgroundColor: ySpacing === opt.value ? '#3b82f6' : 'transparent',
                color: ySpacing === opt.value ? '#ffffff' : '#64748b',
                boxShadow: ySpacing === opt.value ? '0 4px 6px -1px rgba(59, 130, 246, 0.4), 0 2px 4px -2px rgba(59, 130, 246, 0.4)' : 'none',
                transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)', fontWeight: ySpacing === opt.value ? '700' : '600',
                fontSize: '10px', letterSpacing: '0.2px', transform: ySpacing === opt.value ? 'scale(1.02)' : 'scale(1)',
                whiteSpace: 'nowrap', flexShrink: 0
              }}>
                <input type="radio" name="ySpacing" value={opt.value} checked={ySpacing === opt.value} onChange={() => setYSpacing(opt.value)} style={{ display: 'none' }} />
                {opt.label}
              </label>
            ))}
          </div>

          {/* View Group */}
          <div style={{ display: 'flex', gap: '1px', alignItems: 'center', backgroundColor: '#f1f5f9', padding: '3px', borderRadius: '8px', border: '1px solid #cbd5e1', boxShadow: 'inset 0 2px 4px 0 rgba(0, 0, 0, 0.02)', flexShrink: 0 }}>
            <span style={{ color: '#64748b', fontSize: '9px', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.4px', padding: '0 5px', whiteSpace: 'nowrap', flexShrink: 0 }}>View</span>
            {[
              { label: 'Fit', value: 'fit' },
              { label: 'Scroll', value: 'scroll' }
            ].map(opt => (
              <label key={opt.value} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: '3px 10px', borderRadius: '5px', cursor: 'pointer',
                backgroundColor: yView === opt.value ? '#3b82f6' : 'transparent',
                color: yView === opt.value ? '#ffffff' : '#64748b',
                boxShadow: yView === opt.value ? '0 4px 6px -1px rgba(59, 130, 246, 0.4), 0 2px 4px -2px rgba(59, 130, 246, 0.4)' : 'none',
                transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)', fontWeight: yView === opt.value ? '700' : '600',
                fontSize: '10px', letterSpacing: '0.2px', transform: yView === opt.value ? 'scale(1.02)' : 'scale(1)',
                whiteSpace: 'nowrap', flexShrink: 0
              }}>
                <input type="radio" name="yView" value={opt.value} checked={yView === opt.value} onChange={() => setYView(opt.value)} style={{ display: 'none' }} />
                {opt.label}
              </label>
            ))}
          </div>

          <div style={{
            marginLeft: 'auto',
            display: 'flex',
            gap: '4px',
            flexShrink: 0,
            flexWrap: 'nowrap',
            alignItems: 'center',
            whiteSpace: 'nowrap', // prevent inner text wrap
            minWidth: 'max-content' // keep toolbar from shrinking too much
          }}>
            <button onClick={() => setShowSimulationModal(true)} style={{
              padding: '6px 12px',
              background: '#16a34a',
              color: 'white',
              border: 'none',
              borderRadius: '5px',
              fontWeight: '600',
              cursor: 'pointer',
              fontSize: '12px',
              whiteSpace: 'nowrap'
            }}>
              Simulate Path
            </button>
            {simulatedPaths.length > 0 && (
              <>
                <button onClick={() => setShowSimStatsModal(true)} style={{
                  padding: '6px 12px',
                  background: '#f59e0b',
                  color: 'white',
                  border: 'none',
                  borderRadius: '5px',
                  fontWeight: '600',
                  cursor: 'pointer',
                  fontSize: '12px',
                  whiteSpace: 'nowrap'
                }}>
                  Sim Stats
                </button>
                <button onClick={exportSimulationsToCSV} style={{
                  padding: '6px 12px',
                  background: '#3b82f6',
                  color: 'white',
                  border: 'none',
                  borderRadius: '5px',
                  fontWeight: '600',
                  cursor: 'pointer',
                  fontSize: '12px',
                  whiteSpace: 'nowrap'
                }}>
                  Export CSV
                </button>
                <button onClick={() => { setSimulatedPaths([]); setSelectedTrain(null); }} style={{
                  padding: '6px 12px',
                  background: '#ef4444',
                  color: 'white',
                  border: 'none',
                  borderRadius: '5px',
                  fontWeight: '600',
                  cursor: 'pointer',
                  fontSize: '12px',
                  whiteSpace: 'nowrap'
                }}>
                  Clear Sims
                </button>
              </>
            )}
          </div>
        </div>
      </div>


      {/* Simulation Stats Modal */}
      {showSimStatsModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10000 }}>
          <div style={{ backgroundColor: '#ffffff', borderRadius: '12px', padding: '24px', width: '650px', maxHeight: '92vh', overflowY: 'auto', boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h3 style={{ margin: 0, color: '#1e293b', fontSize: '18px', fontWeight: 'bold' }}>Simulation Statistics</h3>
              <button onClick={() => setShowSimStatsModal(false)} style={{ background: 'transparent', border: 'none', fontSize: '20px', cursor: 'pointer', color: '#64748b' }}>×</button>
            </div>

            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'center' }}>
              <thead>
                <tr style={{ backgroundColor: '#f1f5f9' }}>
                  <th style={{ padding: '12px', border: '1px solid #cbd5e1' }}>Statistics</th>
                  <th style={{ padding: '12px', border: '1px solid #cbd5e1' }}>DOWN</th>
                  <th style={{ padding: '12px', border: '1px solid #cbd5e1' }}>UP</th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const fwds = simulatedPaths.filter(p => p.isForward);
                  const bwds = simulatedPaths.filter(p => !p.isForward);

                  const calcStats = (paths) => {
                    if (paths.length === 0) return { totalTrains: 0, avgTime: '-', avgSpeed: '-', detCount: '-', totalDet: '-' };

                    let totalTime = 0;
                    let totalDist = 0;
                    let detCount = 0;
                    let totalDet = 0;

                    paths.forEach(p => {
                      if (p.stops && p.stops.length > 1) {
                        const start = p.stops[0];
                        const end = p.stops[p.stops.length - 1];
                        let t = end.arrTime - start.depTime;
                        if (t < 0) t += 24; // Handle midnight cross
                        totalTime += t;

                        // Calculate approx distance
                        const startY = start.y;
                        const endY = end.y;
                        const dist = Math.abs(endY - startY); // Using Y as proxy for distance or if we have real dist...
                        // Better to use avg speed from the path segments if possible, but let's approximate
                        totalDist += dist; // this is just px distance, real distance is in graphData
                      }
                      detCount += (p.detentionCount || 0);
                      totalDet += (p.totalDetention || 0);
                    });

                    let avgTime = totalTime / paths.length; // in hours



                    return {
                      avgTime: (avgTime * 60).toFixed(0) + ' mins',
                      totalTrains: paths.length,
                      avgSpeed: '-', // Need real distance
                      detCount: detCount,
                      totalDet: totalDet + ' mins'
                    };
                  };

                  // Let's get real distance between simSource and simDest
                  let realDist = 0;
                  if (graphData && graphData.layoutStations) {
                    const s1 = graphData.layoutStations.find(s => s.code === simSource);
                    const s2 = graphData.layoutStations.find(s => s.code === simDest);
                    if (s1 && s2) {
                      realDist = Math.abs(parseFloat(s2.cumDist) - parseFloat(s1.cumDist));
                    }
                  }

                  const calcSpeed = (paths) => {
                    if (paths.length === 0 || realDist === 0) return '-';
                    let totalTime = 0;
                    paths.forEach(p => {
                      if (p.stops && p.stops.length > 1) {
                        const start = p.stops[0];
                        const end = p.stops[p.stops.length - 1];
                        let t = end.arrTime - start.depTime;
                        if (t < 0) t += 24;
                        totalTime += t;
                      }
                    });
                    let avgTimeHr = (totalTime / paths.length);
                    if (avgTimeHr <= 0) return '-';
                    return (realDist / avgTimeHr).toFixed(1) + ' km/h';
                  };

                  const fwdStats = calcStats(fwds);
                  const bwdStats = calcStats(bwds);

                  if (realDist > 0) {
                    fwdStats.avgSpeed = calcSpeed(fwds);
                    bwdStats.avgSpeed = calcSpeed(bwds);
                  }

                  return (
                    <>
                      <tr>
                        <td style={{ padding: '12px', border: '1px solid #cbd5e1', fontWeight: 'bold' }}>Total Simulated Paths</td>
                        <td style={{ padding: '12px', border: '1px solid #cbd5e1' }}>{fwdStats.totalTrains}</td>
                        <td style={{ padding: '12px', border: '1px solid #cbd5e1' }}>{bwdStats.totalTrains}</td>
                      </tr>
                      <tr>
                        <td style={{ padding: '12px', border: '1px solid #cbd5e1', fontWeight: 'bold' }}>Average Journey Time</td>
                        <td style={{ padding: '12px', border: '1px solid #cbd5e1' }}>{fwdStats.avgTime}</td>
                        <td style={{ padding: '12px', border: '1px solid #cbd5e1' }}>{bwdStats.avgTime}</td>
                      </tr>
                      <tr>
                        <td style={{ padding: '12px', border: '1px solid #cbd5e1', fontWeight: 'bold' }}>Average Speed</td>
                        <td style={{ padding: '12px', border: '1px solid #cbd5e1' }}>{fwdStats.avgSpeed}</td>
                        <td style={{ padding: '12px', border: '1px solid #cbd5e1' }}>{bwdStats.avgSpeed}</td>
                      </tr>
                      <tr>
                        <td style={{ padding: '12px', border: '1px solid #cbd5e1', fontWeight: 'bold' }}>Detention Count</td>
                        <td style={{ padding: '12px', border: '1px solid #cbd5e1' }}>{fwdStats.detCount}</td>
                        <td style={{ padding: '12px', border: '1px solid #cbd5e1' }}>{bwdStats.detCount}</td>
                      </tr>
                      <tr>
                        <td style={{ padding: '12px', border: '1px solid #cbd5e1', fontWeight: 'bold' }}>Total Detention</td>
                        <td style={{ padding: '12px', border: '1px solid #cbd5e1' }}>{fwdStats.totalDet}</td>
                        <td style={{ padding: '12px', border: '1px solid #cbd5e1' }}>{bwdStats.totalDet}</td>
                      </tr>
                    </>
                  );
                })()}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Simulation Modal */}
      {showSimulationModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}>
          <div style={{ backgroundColor: '#ffffff', borderRadius: '12px', width: '560px', maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)', overflow: 'hidden' }}>
            {/* Fixed Header */}
            <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid #f1f5f9', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0, color: '#1e293b', fontSize: '18px', fontWeight: 'bold' }}>Simulate New Train Path</h3>
              <button
                type="button"
                onClick={handleCancelSimulation}
                style={{ background: 'none', border: 'none', color: '#94a3b8', fontSize: '20px', cursor: 'pointer', lineHeight: 1, padding: '0 4px' }}
              >
                ×
              </button>
            </div>

            {/* Scrollable Form Body */}
            <div style={{ padding: '20px 24px', overflowY: 'auto', flex: 1 }}>
              {/* Direction checkboxes — dynamic labels in a single line (50/50 space) */}
              <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 'bold', color: '#64748b', marginBottom: '8px' }}>
                  Routes <span style={{ color: '#ef4444' }}>*</span>
                </label>
                <div style={{ display: 'flex', flexDirection: 'row', gap: '10px' }}>
                  {[
                    { dir: 'forward', label: `${graphData?.layoutStations?.[0]?.name || 'KOTA'} → ${graphData?.layoutStations?.[graphData.layoutStations.length - 1]?.name || 'BINA'}` },
                    { dir: 'backward', label: `${graphData?.layoutStations?.[graphData.layoutStations.length - 1]?.name || 'BINA'} → ${graphData?.layoutStations?.[0]?.name || 'KOTA'}` }
                  ].map(({ dir, label }) => {
                    const isChecked = simDirections.includes(dir);
                    return (
                      <label
                        key={dir}
                        style={{
                          flex: '1 1 50%',
                          minWidth: 0,
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                          fontSize: '13px',
                          color: '#334155',
                          cursor: 'pointer',
                          padding: '10px 12px',
                          borderRadius: '6px',
                          border: `1px solid ${isChecked ? '#16a34a' : '#cbd5e1'}`,
                          background: isChecked ? '#f0fdf4' : '#f8fafc',
                          boxSizing: 'border-box',
                          transition: 'all 0.15s ease'
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={(e) => {
                            if (e.target.checked) setSimDirections(prev => [...prev, dir]);
                            else setSimDirections(prev => prev.filter(d => d !== dir));
                          }}
                          style={{ accentColor: '#16a34a', width: '16px', height: '16px', flexShrink: 0 }}
                        />
                        <span style={{ fontWeight: isChecked ? '600' : '400', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {label}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 'bold', color: '#475569', marginBottom: '8px' }}>
                  Operating Days
                </label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', backgroundColor: '#f8fafc', padding: '6px', borderRadius: '8px', border: '1px solid #cbd5e1' }}>
                  {[
                    { label: 'All Days', value: 'All' },
                    { label: 'Mon', value: 'Mon' },
                    { label: 'Tue', value: 'Tue' },
                    { label: 'Wed', value: 'Wed' },
                    { label: 'Thu', value: 'Thu' },
                    { label: 'Fri', value: 'Fri' },
                    { label: 'Sat', value: 'Sat' },
                    { label: 'Sun', value: 'Sun' }
                  ].map(dayObj => {
                    const isSelected = simDay === dayObj.value;
                    const isHovered = hoveredSimDay === dayObj.value;
                    return (
                      <button
                        type="button"
                        key={dayObj.value}
                        onClick={() => setSimDay(dayObj.value)}
                        onMouseEnter={() => setHoveredSimDay(dayObj.value)}
                        onMouseLeave={() => setHoveredSimDay(null)}
                        style={{
                          flex: '1 1 auto',
                          textAlign: 'center',
                          padding: '7px 12px',
                          borderRadius: '6px',
                          cursor: 'pointer',
                          fontSize: '12px',
                          fontWeight: isSelected ? '700' : '600',
                          backgroundColor: isSelected ? '#2563eb' : (isHovered ? '#dbeafe' : '#eff6ff'),
                          color: isSelected ? '#ffffff' : '#1d4ed8',
                          border: isSelected ? '1px solid #1d4ed8' : (isHovered ? '1px solid #3b82f6' : '1px solid #93c5fd'),
                          boxShadow: isSelected
                            ? '0 2px 5px rgba(37, 99, 235, 0.35)'
                            : (isHovered ? '0 1px 3px rgba(37, 99, 235, 0.15)' : 'none'),
                          transition: 'all 0.15s ease',
                          outline: 'none',
                          userSelect: 'none'
                        }}
                      >
                        {dayObj.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Time Controls: Departure From, Departure Upto & Journey Completion Time */}
              <div style={{ display: 'flex', gap: '12px', marginBottom: '16px' }}>
                <div style={{ flex: 1 }}>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 'bold', color: '#64748b', marginBottom: '6px' }}>
                    Departure From <span style={{ color: '#ef4444' }}>*</span>
                  </label>
                  <input
                    type="time"
                    value={simTimeFrom}
                    onChange={e => setSimTimeFrom(e.target.value)}
                    style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '14px', outline: 'none', color: '#334155', boxSizing: 'border-box' }}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 'bold', color: '#64748b', marginBottom: '6px' }}>
                    Departure Upto <span style={{ color: '#ef4444' }}>*</span>
                  </label>
                  <input
                    type="time"
                    value={simTimeUpto}
                    onChange={e => setSimTimeUpto(e.target.value)}
                    style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '14px', outline: 'none', color: '#334155', boxSizing: 'border-box' }}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 'bold', color: '#64748b', marginBottom: '6px', whiteSpace: 'nowrap' }}>
                    Journey Completion (HH:MM)
                  </label>
                  <input
                    type="time"
                    value={simCompletionTime}
                    onChange={e => setSimCompletionTime(e.target.value)}
                    style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '14px', outline: 'none', color: '#334155', boxSizing: 'border-box' }}
                  />
                </div>
              </div>

              <div style={{ display: 'flex', gap: '12px', marginBottom: '16px' }}>
                <div style={{ flex: 1 }}>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 'bold', color: '#64748b', marginBottom: '6px' }}>Headway (mins)</label>
                  <select value={simHeadway} onChange={e => setSimHeadway(e.target.value)} style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '14px', outline: 'none', color: '#334155', boxSizing: 'border-box' }}>
                    {[...Array(15)].map((_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}
                  </select>
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 'bold', color: '#64748b', marginBottom: '6px' }}>Speed (kmph)</label>
                  <select value={simSpeed} onChange={e => setSimSpeed(e.target.value)} style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '14px', outline: 'none', color: '#334155', boxSizing: 'border-box' }}>
                    <option value="">Default (Coaching Trains)</option>
                    <option value="goods">Default (Goods Speed)</option>
                    {[30, 45, 60, 75, 80, 85, 90, 95, 100, 105, 110, 115, 120, 125, 130, 135, 140, 145, 150, 155, 160].map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '12px', marginBottom: '16px' }}>
                <div style={{ flex: 1 }}>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 'bold', color: '#64748b', marginBottom: '6px' }}>Max Detention (hrs)</label>
                  <select value={simMaxDetention} onChange={e => setSimMaxDetention(e.target.value)} style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '14px', outline: 'none', color: '#334155', boxSizing: 'border-box' }}>
                    {[1, 2, 3, 4, 5].map(h => <option key={h} value={h}>{h}</option>)}
                  </select>
                </div>

                <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', paddingBottom: '10px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#334155', cursor: 'pointer', fontWeight: 'bold' }}>
                    <input
                      type="checkbox"
                      checked={simBlockCorridor}
                      onChange={e => setSimBlockCorridor(e.target.checked)}
                      style={{ accentColor: '#16a34a', width: '16px', height: '16px' }}
                    />
                    Block Corridor
                  </label>
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 'bold', color: '#64748b', marginBottom: '6px' }}>Block Op Time (mins)</label>
                  <input
                    type="number"
                    min="0"
                    placeholder="0"
                    value={simBlockOperatingTime}
                    onChange={e => setSimBlockOperatingTime(e.target.value)}
                    disabled={!simBlockCorridor}
                    style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '14px', outline: 'none', color: '#334155', boxSizing: 'border-box', backgroundColor: !simBlockCorridor ? '#f1f5f9' : '#fff' }}
                  />
                </div>
              </div>

              {/* Acceleration & Deceleration Time (mm:ss) */}
              <div style={{ display: 'flex', gap: '12px', marginBottom: '16px' }}>
                <div style={{ flex: 1 }}>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 'bold', color: '#64748b', marginBottom: '6px' }}>
                    Acceleration Time (mm:ss)
                  </label>
                  <input
                    type="text"
                    placeholder="00:00"
                    value={simAccelTime}
                    onChange={e => setSimAccelTime(formatMMSS(e.target.value, simAccelTime))}
                    style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '14px', outline: 'none', color: '#334155', boxSizing: 'border-box' }}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 'bold', color: '#64748b', marginBottom: '6px' }}>
                    Deceleration Time (mm:ss)
                  </label>
                  <input
                    type="text"
                    placeholder="00:00"
                    value={simDecelTime}
                    onChange={e => setSimDecelTime(formatMMSS(e.target.value, simDecelTime))}
                    style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '14px', outline: 'none', color: '#334155', boxSizing: 'border-box' }}
                  />
                </div>
              </div>

              {simSpeed === 'goods' && (
                <div style={{ marginBottom: '16px', padding: '12px', border: '1px solid #2563eb', borderRadius: '8px', backgroundColor: '#f0fdf4', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: 'bold', color: '#16a34a' }}>Goods Speed Configuration</label>
                    <span style={{ fontSize: '11px', color: '#64748b' }}>Custom defaults per section and direction</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowGoodsConfigModal(true)}
                    style={{ padding: '6px 12px', borderRadius: '6px', backgroundColor: '#2563eb', color: '#ffffff', border: 'none', fontWeight: 'bold', cursor: 'pointer', fontSize: '12px' }}
                  >
                    Configure Goods Speed
                  </button>
                </div>
              )}

              {/* Stops & Halt Times — Dropdown Menu */}
              <div style={{ marginBottom: '18px', position: 'relative' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                  <label style={{ fontSize: '12px', fontWeight: 'bold', color: '#475569' }}>
                    Stops & Halt Times
                    {simStops.length > 0 && (
                      <span style={{ marginLeft: '8px', fontSize: '11px', fontWeight: '600', color: '#16a34a', background: '#dcfce7', padding: '2px 8px', borderRadius: '12px' }}>
                        {simStops.length} stop{simStops.length > 1 ? 's' : ''} configured
                      </span>
                    )}
                  </label>
                  {simStops.length > 0 && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setSimStops([]); }}
                      style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '11px', fontWeight: '600', cursor: 'pointer', padding: '2px 6px' }}
                    >
                      Clear all
                    </button>
                  )}
                </div>

                {/* Dropdown Toggle Bar */}
                <div
                  onClick={() => setIsStopsDropdownOpen(prev => !prev)}
                  style={{
                    width: '100%',
                    padding: '9px 12px',
                    borderRadius: isStopsDropdownOpen ? '6px 6px 0 0' : '6px',
                    border: `1px solid ${isStopsDropdownOpen ? '#2563eb' : '#cbd5e1'}`,
                    backgroundColor: '#ffffff',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    cursor: 'pointer',
                    userSelect: 'none',
                    boxSizing: 'border-box'
                  }}
                >
                  <div style={{ fontSize: '13px', color: simStops.length > 0 ? '#1e293b' : '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, marginRight: '8px' }}>
                    {simStops.length === 0
                      ? 'Select intermediate stop stations...'
                      : simStops.map(s => `${s.code} (${s.halt}m)`).join(', ')}
                  </div>
                  <span style={{ fontSize: '11px', color: '#64748b', transform: isStopsDropdownOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>
                    ▼
                  </span>
                </div>

                {/* Dropdown Menu Body */}
                {isStopsDropdownOpen && (
                  <div
                    style={{
                      border: '1px solid #2563eb',
                      borderTop: 'none',
                      borderRadius: '0 0 8px 8px',
                      backgroundColor: '#ffffff',
                      boxShadow: '0 8px 16px -4px rgba(0,0,0,0.1)',
                      overflow: 'hidden'
                    }}
                  >
                    {/* Search inside dropdown */}
                    <div style={{ padding: '8px 10px', background: '#f8fafc', borderBottom: '1px solid #e2e8f0' }}>
                      <input
                        type="text"
                        placeholder="Search station name or code..."
                        value={stopSearchQuery}
                        onChange={e => setStopSearchQuery(e.target.value)}
                        style={{ width: '100%', padding: '6px 10px', borderRadius: '4px', border: '1px solid #cbd5e1', fontSize: '12px', outline: 'none', boxSizing: 'border-box' }}
                      />
                    </div>

                    {/* Checkbox List */}
                    <div style={{ maxHeight: '180px', overflowY: 'auto' }}>
                      {availableStopStations.length === 0 ? (
                        <div style={{ padding: '16px', textAlign: 'center', color: '#64748b', fontSize: '12px' }}>
                          No intermediate stations available.
                        </div>
                      ) : (
                        availableStopStations
                          .filter(stn => {
                            if (!stopSearchQuery) return true;
                            const q = stopSearchQuery.toLowerCase();
                            return (stn.name || '').toLowerCase().includes(q) || (stn.code || '').toLowerCase().includes(q);
                          })
                          .map((stn) => {
                            const isChecked = simStops.some(s => s.code === stn.code);
                            const stopObj = simStops.find(s => s.code === stn.code);
                            return (
                              <div
                                key={stn.code}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'space-between',
                                  gap: '10px',
                                  padding: '8px 12px',
                                  borderBottom: '1px solid #f1f5f9',
                                  backgroundColor: isChecked ? '#eff6ff' : '#ffffff',
                                  transition: 'background-color 0.15s ease'
                                }}
                              >
                                <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', flex: 1, minWidth: 0, userSelect: 'none' }}>
                                  <input
                                    type="checkbox"
                                    checked={isChecked}
                                    onChange={(e) => {
                                      if (e.target.checked) {
                                        setSimStops(prev => [...prev.filter(s => s.code !== stn.code), { code: stn.code, halt: 2 }]);
                                      } else {
                                        setSimStops(prev => prev.filter(s => s.code !== stn.code));
                                      }
                                    }}
                                    style={{ accentColor: '#2563eb', width: '16px', height: '16px', cursor: 'pointer', flexShrink: 0 }}
                                  />
                                  <span style={{ fontSize: '13px', fontWeight: isChecked ? '700' : '500', color: isChecked ? '#1d4ed8' : '#334155', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                    {stn.name} <span style={{ color: isChecked ? '#3b82f6' : '#64748b', fontWeight: 'normal', fontSize: '12px' }}>({stn.code})</span>
                                  </span>
                                </label>

                                {isChecked && (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                                    <span style={{ fontSize: '12px', color: '#64748b', fontWeight: '500' }}>Halt:</span>
                                    <input
                                      type="number"
                                      min="1"
                                      max="60"
                                      value={stopObj?.halt ?? 2}
                                      onChange={(e) => {
                                        const val = Math.max(1, parseInt(e.target.value) || 1);
                                        setSimStops(prev => prev.map(s => s.code === stn.code ? { ...s, halt: val } : s));
                                      }}
                                      style={{
                                        width: '52px',
                                        padding: '4px 6px',
                                        borderRadius: '4px',
                                        border: '1px solid #93c5fd',
                                        fontSize: '13px',
                                        textAlign: 'center',
                                        fontWeight: 'bold',
                                        color: '#1d4ed8',
                                        backgroundColor: '#ffffff',
                                        outline: 'none'
                                      }}
                                    />
                                    <span style={{ fontSize: '12px', color: '#64748b', fontWeight: '500' }}>mins</span>
                                  </div>
                                )}
                              </div>
                            );
                          })
                      )}
                    </div>

                    {/* Dropdown footer bar */}
                    <div style={{ padding: '6px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#f8fafc', borderTop: '1px solid #e2e8f0' }}>
                      <span style={{ fontSize: '11px', color: '#64748b' }}>
                        {availableStopStations.length} intermediate stations
                      </span>
                      <button
                        type="button"
                        onClick={() => setIsStopsDropdownOpen(false)}
                        style={{ padding: '4px 12px', borderRadius: '4px', background: '#2563eb', color: '#ffffff', border: 'none', fontSize: '11px', fontWeight: 'bold', cursor: 'pointer' }}
                      >
                        Done
                      </button>
                    </div>
                  </div>
                )}
              </div>


            </div>

            {/* Fixed Modal Footer — Cancel and Run Simulation buttons never scroll away */}
            <div style={{ padding: '16px 24px', borderTop: '1px solid #e2e8f0', backgroundColor: '#ffffff', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
              <div style={{ fontSize: '12px', color: '#64748b' }}>
                {isSimulating && <span style={{ color: '#2563eb', fontWeight: 'bold' }}>⏳ Simulating paths...</span>}
                {!isSimulating && simulatedPaths.length > 0 && <span style={{ color: '#16a34a', fontWeight: 'bold' }}>✓ {simulatedPaths.length} train(s) scheduled so far</span>}
              </div>
              <div style={{ display: 'flex', gap: '12px' }}>
                <button
                  type="button"
                  onClick={handleCancelSimulation}
                  style={{ padding: '8px 16px', borderRadius: '6px', backgroundColor: '#f1f5f9', color: '#475569', border: 'none', fontWeight: 'bold', cursor: 'pointer' }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={isSimulating}
                  onClick={() => {
                    if (simDirections.length === 0) return alert('Please select at least one direction.');
                    runSimulation();
                  }}
                  style={{ padding: '8px 16px', borderRadius: '6px', backgroundColor: isSimulating ? '#94a3b8' : '#16a34a', color: '#ffffff', border: 'none', fontWeight: 'bold', cursor: isSimulating ? 'not-allowed' : 'pointer' }}
                >
                  {isSimulating ? 'Simulating...' : 'Run Simulation'}
                </button>
              </div>
            </div>

          </div>
        </div>
      )}

      {/* Goods Speed Config Modal */}
      {showGoodsConfigModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10001 }}>
          <div style={{ backgroundColor: '#ffffff', borderRadius: '12px', width: '850px', maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)', overflow: 'hidden' }}>
            <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid #f1f5f9', display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#f8fafc' }}>
              <h3 style={{ margin: 0, color: '#1e293b', fontSize: '18px', fontWeight: 'bold' }}>Goods Speed Configuration</h3>
              <button
                type="button"
                onClick={() => setShowGoodsConfigModal(false)}
                style={{ background: 'none', border: 'none', color: '#94a3b8', fontSize: '20px', cursor: 'pointer', lineHeight: 1, padding: '0 4px' }}
              >
                ×
              </button>
            </div>
            <div style={{ padding: '0px', overflowY: 'auto', flex: 1 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', textAlign: 'center' }}>
                <thead style={{ position: 'sticky', top: 0, backgroundColor: '#f1f5f9', boxShadow: '0 2px 4px rgba(0,0,0,0.05)', zIndex: 10 }}>
                  <tr>
                    <th colSpan="3" style={{ padding: '8px', borderRight: '2px solid #cbd5e1', borderBottom: '1px solid #cbd5e1', color: '#1e293b' }}>DOWN DIRECTION (FORWARD)</th>
                    <th colSpan="3" style={{ padding: '8px', borderBottom: '1px solid #cbd5e1', color: '#1e293b' }}>UP DIRECTION (BACKWARD)</th>
                  </tr>
                  <tr>
                    <th style={{ padding: '8px', borderBottom: '2px solid #e2e8f0', color: '#475569' }}>STATIONS</th>
                    <th style={{ padding: '8px', borderBottom: '2px solid #e2e8f0', color: '#475569' }}>LOADED TRAINS SPEED</th>
                    <th style={{ padding: '8px', borderBottom: '2px solid #e2e8f0', borderRight: '2px solid #cbd5e1', color: '#475569' }}>EMPTY TRAINS SPEED</th>
                    <th style={{ padding: '8px', borderBottom: '2px solid #e2e8f0', color: '#475569' }}>STATIONS</th>
                    <th style={{ padding: '8px', borderBottom: '2px solid #e2e8f0', color: '#475569' }}>LOADED TRAINS SPEED</th>
                    <th style={{ padding: '8px', borderBottom: '2px solid #e2e8f0', color: '#475569' }}>EMPTY TRAINS SPEED</th>
                  </tr>
                </thead>
                <tbody>
                  {goodsSpeedRows.length === 0 ? (
                    <tr><td colSpan="6" style={{ padding: '20px', color: '#64748b' }}>No configuration data available</td></tr>
                  ) : (
                    goodsSpeedRows.map((row, idx) => {
                      const getOvr = (dir, load) => goodsSpeedOverrides[`${dir}_${row.secCode}_${load}`] || '';
                      const setOvr = (dir, load, val) => setGoodsSpeedOverrides(prev => ({ ...prev, [`${dir}_${row.secCode}_${load}`]: val }));

                      const formatDef = (v, label = '') => {
                        console.log("[GOODS DISPLAY TRACE]", {
                          label,
                          value: v,
                          type: typeof v
                        });

                        return v !== null && v !== undefined && Number.isFinite(Number(v))
                          ? Number(v).toFixed(1)
                          : 'N/A';
                      };

                      const fwdLoadedDef = formatDef(row.fwdLoadedDef, `${row.secCode} fwdLoaded`);
                      const fwdEmptyDef = formatDef(row.fwdEmptyDef, `${row.secCode} fwdEmpty`);
                      const bwdLoadedDef = formatDef(row.bwdLoadedDef, `${row.secCode} bwdLoaded`);
                      const bwdEmptyDef = formatDef(row.bwdEmptyDef, `${row.secCode} bwdEmpty`);

                      return (
                        <tr key={row.secCode} style={{ backgroundColor: idx % 2 === 0 ? '#ffffff' : '#f8fafc' }}>
                          <td style={{ padding: '8px', borderBottom: '1px solid #e2e8f0', fontWeight: '600', color: '#334155' }}>{row.fwdName}</td>
                          <td style={{ padding: '8px', borderBottom: '1px solid #e2e8f0' }}>
                            <input
                              type="number"
                              value={getOvr('forward', 'LOADED')}
                              onChange={e => setOvr('forward', 'LOADED', e.target.value)}
                              placeholder={`[ ${fwdLoadedDef} ]`}
                              style={{ width: '70px', padding: '4px', textAlign: 'center', borderRadius: '4px', border: '1px solid #cbd5e1' }}
                            />
                          </td>
                          <td style={{ padding: '8px', borderBottom: '1px solid #e2e8f0', borderRight: '2px solid #cbd5e1' }}>
                            <input
                              type="number"
                              value={getOvr('forward', 'EMPTY')}
                              onChange={e => setOvr('forward', 'EMPTY', e.target.value)}
                              placeholder={`[ ${fwdEmptyDef} ]`}
                              style={{ width: '70px', padding: '4px', textAlign: 'center', borderRadius: '4px', border: '1px solid #cbd5e1' }}
                            />
                          </td>
                          <td style={{ padding: '8px', borderBottom: '1px solid #e2e8f0', fontWeight: '600', color: '#334155' }}>{row.bwdName}</td>
                          <td style={{ padding: '8px', borderBottom: '1px solid #e2e8f0' }}>
                            <input
                              type="number"
                              value={getOvr('backward', 'LOADED')}
                              onChange={e => setOvr('backward', 'LOADED', e.target.value)}
                              placeholder={`[ ${bwdLoadedDef} ]`}
                              style={{ width: '70px', padding: '4px', textAlign: 'center', borderRadius: '4px', border: '1px solid #cbd5e1' }}
                            />
                          </td>
                          <td style={{ padding: '8px', borderBottom: '1px solid #e2e8f0' }}>
                            <input
                              type="number"
                              value={getOvr('backward', 'EMPTY')}
                              onChange={e => setOvr('backward', 'EMPTY', e.target.value)}
                              placeholder={`[ ${bwdEmptyDef} ]`}
                              style={{ width: '70px', padding: '4px', textAlign: 'center', borderRadius: '4px', border: '1px solid #cbd5e1' }}
                            />
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
            <div style={{ padding: '16px 24px', borderTop: '1px solid #e2e8f0', backgroundColor: '#ffffff', display: 'flex', justifyContent: 'flex-end', alignItems: 'center' }}>
              <button
                type="button"
                onClick={() => setShowGoodsConfigModal(false)}
                style={{ padding: '8px 24px', borderRadius: '6px', backgroundColor: '#2563eb', color: '#ffffff', border: 'none', fontWeight: 'bold', cursor: 'pointer' }}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {containerWidth === 0 && (
        <div style={{ padding: '20px' }}>Loading graph...</div>
      )}

      {containerWidth > 0 && graphData && graphData.trainLines.length === 0 ? (
        <div style={{ padding: '20px' }}>No schedule data available for this layout route.</div>
      ) : containerWidth > 0 && graphData && (
        <GraphContent
          layout={layout}
          containerWidth={containerWidth}
          graphData={graphData}
          hoveredTrain={hoveredTrain}
          setHoveredTrain={setHoveredTrain}
          mousePos={mousePos}
          setMousePos={setMousePos}
          selectedTrain={selectedTrain}
          setSelectedTrain={setSelectedTrain}
          windowMode={windowMode}
          setWindowMode={setWindowMode}
          timeBlock={timeBlock}
          setTimeBlock={setTimeBlock}
          yView={yView}
          simulatedPaths={expandedSimulatedPaths}
          setSimulatedPaths={setSimulatedPaths}
        />
      )}
    </div>
  );
}

function LegendItem({ color, label }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
      <span style={{ width: 14, height: 3, background: color, display: 'inline-block', borderRadius: 2 }} />
      {label}
    </span>
  );
}

function GraphContent({ layout, containerWidth, graphData, hoveredTrain, setHoveredTrain, mousePos, setMousePos, selectedTrain, setSelectedTrain, windowMode, setWindowMode, timeBlock, setTimeBlock, yView, simulatedPaths, setSimulatedPaths }) {
  const { totalHeight, minTime, maxTime, trainLines, layoutStations, trackBlocks = [] } = graphData;

  const marginLeft = 100;
  const marginRight = 200;

  const chartWidth = Math.max(containerWidth - marginLeft - marginRight, 400);

  const isSpecificDay = typeof windowMode === 'string' && windowMode.startsWith('day-');
  const dayIndex = isSpecificDay ? parseInt(windowMode.split('-')[1]) : 0;

  let baseMinTime = isSpecificDay ? dayIndex * 24 : 0;
  let baseMaxTime = isSpecificDay ? (dayIndex + 1) * 24 : maxTime;

  let viewMinTime = baseMinTime;
  let viewMaxTime = baseMaxTime;

  if (windowMode !== '7d' && timeBlock !== 'all') {
    if (timeBlock === '0-8') {
      viewMaxTime = baseMinTime + 8;
    } else if (timeBlock === '8-16') {
      viewMinTime = baseMinTime + 8;
      viewMaxTime = baseMinTime + 16;
    } else if (timeBlock === '16-24') {
      viewMinTime = baseMinTime + 16;
      viewMaxTime = baseMinTime + 24;
    }
  }

  const viewDuration = viewMaxTime - viewMinTime;

  const getX = (timeStr) => {
    const xPadding = 6;
    return marginLeft + xPadding + ((timeStr - viewMinTime) / viewDuration) * (chartWidth - 2 * xPadding);
  };

  // Filter train lines based on view range
  const allTrainLines = simulatedPaths && simulatedPaths.length > 0 ? [...trainLines, ...simulatedPaths] : trainLines;
  const filteredTrainLines = allTrainLines.filter(train => {

    if (windowMode === '7d' || (windowMode === '24h' && timeBlock === 'all')) return true;

    const tMin = Math.min(...train.stops.map(s => Math.min(s.arrTime, s.depTime)));
    const tMax = Math.max(...train.stops.map(s => Math.max(s.arrTime, s.depTime)));

    return tMin <= viewMaxTime && tMax >= viewMinTime;
  });

  const getSegmentsD = (y1, t1, y2, t2) => {
    if (t2 <= t1) return '';
    let d = '';
    let currentT = t1;
    let currentY = y1;
    const deltaT = t2 - t1;
    const deltaY = y2 - y1;

    while (currentT < t2) {
      const currentCycle = Math.floor(currentT / maxTime);
      const endOfCycle = (currentCycle + 1) * maxTime;
      const nextT = Math.min(t2, endOfCycle);

      const segmentStartT = currentT % maxTime;
      let segmentEndT = nextT % maxTime;
      if (segmentEndT === 0 && nextT > currentT) {
        segmentEndT = maxTime;
      }

      const progress = (nextT - t1) / deltaT;
      const nextY = y1 + progress * deltaY;

      d += `M ${getX(segmentStartT)} ${currentY} L ${getX(segmentEndT)} ${nextY} `;

      currentT = nextT;
      currentY = nextY;
    }
    return d;
  };

  const xAxisLines = [];
  for (let t = viewMinTime; t <= viewMaxTime; t++) {
    xAxisLines.push(t);
  }

  const minorXAxisLines = [];
  if (viewDuration <= 24) {
    for (let t = viewMinTime; t < viewMaxTime; t++) {
      for (let m = 10; m < 60; m += 10) {
        minorXAxisLines.push({ t: t + (m / 60), label: String(m) });
      }
    }
  }

  const renderXAxis = (position) => {
    const isTop = position === 'top';

    return (
      <>
        {minorXAxisLines.map(mt => {
          const x = getX(mt.t);
          const lineY1 = isTop ? 32 : 0;
          const lineY2 = isTop ? 40 : 8;
          const textY = isTop ? 28 : 18;
          return (
            <g key={`minor-x-${position}-${mt.t}`}>
              <line x1={x} y1={lineY1} x2={x} y2={lineY2} stroke="#cbd5e1" strokeWidth={1} />
              <text x={x} y={textY} fill="#94a3b8" fontSize="7" textAnchor="middle">
                {mt.label}
              </text>
            </g>
          );
        })}
        {xAxisLines.map(t => {
          const x = getX(t);
          const isDayBoundary = t > viewMinTime && t % 24 === 0;

          let labelText = '';
          const showLabel = viewDuration === 168 ? (t % 24 === 12) : true;

          if (viewDuration === 168 && showLabel) {
            const daysOfWeek = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
            const dayIdx = Math.floor(t / 24);
            if (dayIdx < 7) {
              labelText = daysOfWeek[dayIdx];
            }
          } else if (viewDuration === 24) {
            const h = Math.floor(t % 24);
            labelText = (t > viewMinTime && h === 0) ? '24:00' : `${h.toString().padStart(2, '0')}:00`;
          } else {
            labelText = (t > viewMinTime && t % 24 === 0) ? `${t}:00` : formatTime(t * 3600);
          }
          let isClickableDay = false;
          let targetDayIndex = 0;

          if (viewDuration === 168 && showLabel) {
            const daysOfWeek = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
            const dayIdx = Math.floor(t / 24);
            if (dayIdx < 7) {
              labelText = daysOfWeek[dayIdx];
              isClickableDay = true;
              targetDayIndex = dayIdx;
            }
          }

          const rectY = isTop ? 2 : 14;
          const labelY = isTop ? 18 : 30;
          const tickY1 = isTop ? 28 : 0;
          const tickY2 = isTop ? 40 : 12;

          return (
            <g key={`x-lbl-${position}-${t}`}>
              {showLabel && (
                <g
                  style={{ cursor: isClickableDay ? 'pointer' : 'default' }}
                  onClick={isClickableDay ? () => setWindowMode(`day-${targetDayIndex}`) : undefined}
                >
                  {isClickableDay && (
                    <rect x={x - 45} y={rectY} width={90} height={24} rx={4} fill="#f1f5f9" stroke="#cbd5e1" strokeWidth={1} />
                  )}
                  <text
                    x={x} y={labelY} fill={isClickableDay ? "#2563eb" : "#1b2036"} fontWeight="bold" fontSize="12" textAnchor="middle"
                  >
                    {labelText}
                  </text>
                </g>
              )}
              <line x1={x} y1={tickY1} x2={x} y2={tickY2} stroke={isDayBoundary ? "#64748b" : "#94a3b8"} strokeWidth={2} />
            </g>
          );
        })}
      </>
    );
  };

  return (
    <div style={{ overflowX: 'auto', overflowY: yView === 'fit' ? 'hidden' : 'auto', position: 'relative' }}>

      <div style={{
        position: 'sticky',
        top: 0,
        width: 'max-content',
        minWidth: '100%',
        height: '40px',
        background: '#ffffff',
        zIndex: 10,
        borderBottom: '1px solid #444',
        boxShadow: '0 4px 10px rgba(0,0,0,0.05)'
      }}>
        <svg width={chartWidth + marginLeft + marginRight} height="40" style={{ display: 'block', background: '#ffffff', position: 'sticky', top: 0, zIndex: 10 }}>
          {renderXAxis('top')}
        </svg>
      </div>

      <svg width={chartWidth + marginLeft + marginRight} height={totalHeight + 20} style={{ display: 'block', background: '#ffffff' }}>
        <g transform="translate(0, 10)">
          <defs>
            <clipPath id="graphClip">
              <rect x={marginLeft} y={-100} width={chartWidth} height={totalHeight + 200} />
            </clipPath>
            {[
              { id: 'red', color: '#dc2626' },
              { id: 'blue', color: '#2563eb' },
              { id: 'black', color: '#000000' },
              { id: 'purple', color: '#9333ea' },
              { id: 'orange', color: '#ea580c' },
              { id: 'green', color: '#16a34a' }
            ].map(m => (
              <marker key={`arrowTdg-${m.id}`} id={`arrowTdg-${m.id}`} markerWidth="14" markerHeight="14" refX="10" refY="7" orient="auto" markerUnits="userSpaceOnUse">
                <path d="M 0 2 L 10 7 L 0 12 L 3 7 z" fill={m.color} />
              </marker>
            ))}
          </defs>

          {minorXAxisLines.map((mt, i) => (
            <line
              key={`minor-grid-${i}`}
              x1={getX(mt.t)} y1={layoutStations[0]?.y || 0} x2={getX(mt.t)} y2={layoutStations[layoutStations.length - 1]?.y || totalHeight}
              stroke="#f8fafc"
              strokeWidth="1"
            />
          ))}

          {xAxisLines.map(t => {
            const x = getX(t);
            const isDayBoundary = t > viewMinTime && t % 24 === 0;
            return (
              <line
                key={`x-line-${t}`}
                x1={x} y1={layoutStations[0]?.y || 0} x2={x} y2={layoutStations[layoutStations.length - 1]?.y || totalHeight}
                stroke={isDayBoundary ? "#cbd5e1" : "#e2e8f0"}
                strokeWidth={isDayBoundary ? 2 : (viewDuration === 24 ? 2 : 1)}
                strokeDasharray="none"
              />
            );
          })}

          {/* Right Y-axis Detailed Route Map - Track Lines */}
          {layoutStations.map((stn, i) => {
            if (i === layoutStations.length - 1) return null;
            const nextStn = layoutStations[i + 1];

            const baseX = containerWidth - 70;
            const midY = (stn.y + nextStn.y) / 2;

            const getMains = (lines) => {
              let mLines = lines.filter(l => {
                const cat = String(l.MACLINECATEGORY || '').trim().toUpperCase();
                return cat === 'M' || cat === 'MAIN';
              });
              if (mLines.length === 0) {
                mLines = lines.filter(l => parseInt(l.MANSEQNUMB) <= 2);
              }

              const mainIndices = mLines.map(ml => lines.findIndex(l => l === ml));
              let minIdx = mainIndices.length > 0 ? Math.min(...mainIndices) : 0;

              let dn = mainIndices.length > 0 ? mainIndices[0] : -1;
              let up = mainIndices.length > 1 ? mainIndices[1] : -1;

              const offsets = [];
              if (lines.length > 0) {
                let currentCx = 0;
                offsets[0] = 0;
                for (let j = 1; j < lines.length; j++) {
                  const prevMain = mainIndices.includes(j - 1);
                  const currMain = mainIndices.includes(j);
                  let gap = 10;
                  if (prevMain && currMain) gap = 20;
                  currentCx += gap;
                  offsets[j] = currentCx;
                }
                const shift = offsets[minIdx] || 0;
                for (let j = 0; j < offsets.length; j++) {
                  offsets[j] = -(offsets[j] - shift);
                }
              }

              return { upMainIdx: up, dnMainIdx: dn, minIdx, mainIndices, offsets };
            };

            const mainsA = getMains(stn.lines);
            let upMainIdxA = mainsA.upMainIdx;
            let dnMainIdxA = mainsA.dnMainIdx;

            const mainsB = getMains(nextStn.lines);
            let upMainIdxB = mainsB.upMainIdx;
            let dnMainIdxB = mainsB.dnMainIdx;

            const hasUpMain = upMainIdxA !== -1 || upMainIdxB !== -1;
            const hasDnMain = dnMainIdxA !== -1 || dnMainIdxB !== -1;

            let dnX_A = baseX - 4;
            let upX_A = baseX - 24;
            if (upMainIdxA !== -1) upX_A = baseX - 4 + mainsA.offsets[upMainIdxA];
            if (dnMainIdxA !== -1) dnX_A = baseX - 4 + mainsA.offsets[dnMainIdxA];
            if (dnMainIdxA !== -1 && upMainIdxA === -1) upX_A = dnX_A;
            else if (dnMainIdxA === -1 && upMainIdxA !== -1) dnX_A = upX_A;

            let dnX_B = baseX - 4;
            let upX_B = baseX - 24;
            if (upMainIdxB !== -1) upX_B = baseX - 4 + mainsB.offsets[upMainIdxB];
            if (dnMainIdxB !== -1) dnX_B = baseX - 4 + mainsB.offsets[dnMainIdxB];
            if (dnMainIdxB !== -1 && upMainIdxB === -1) upX_B = dnX_B;
            else if (dnMainIdxB === -1 && upMainIdxB !== -1) dnX_B = upX_B;

            let elements = [];
            const upMidX = (upX_A + upX_B) / 2;
            const dnMidX = (dnX_A + dnX_B) / 2;

            if (hasDnMain) {
              // Connect 1st main line (Blue)
              elements.push(
                <g key={`dn-link-${i}`}>
                  <line x1={dnX_A} y1={stn.y} x2={dnX_B} y2={nextStn.y} stroke="#2563eb" strokeWidth="3" />
                  <polygon points={`${dnMidX},${midY + 5} ${dnMidX - 5},${midY - 4} ${dnMidX + 5},${midY - 4}`} fill="#2563eb" />
                </g>
              );
            }
            if (hasUpMain) {
              // Connect 2nd main line (Orange)
              elements.push(
                <g key={`up-link-${i}`}>
                  <line x1={upX_A} y1={stn.y} x2={upX_B} y2={nextStn.y} stroke="#ea580c" strokeWidth="3" />
                  <polygon points={`${upMidX},${midY - 5} ${upMidX - 5},${midY + 4} ${upMidX + 5},${midY + 4}`} fill="#ea580c" />
                </g>
              );
            }
            if (!hasUpMain && !hasDnMain) {
              elements.push(
                <g key={`def-link-${i}`}>
                  <line x1={baseX - 4} y1={stn.y} x2={baseX - 4} y2={nextStn.y} stroke="#64748b" strokeWidth="3" />
                </g>
              );
            }

            return (
              <g key={`track-blk-${i}`}>
                {elements}
              </g>
            );
          })}

          {layoutStations.map((stn, i) => {
            const baseX = containerWidth - 70;

            const getMains = (lines) => {
              let mLines = lines.filter(l => {
                const cat = String(l.MACLINECATEGORY || '').trim().toUpperCase();
                return cat === 'M' || cat === 'MAIN';
              });
              if (mLines.length === 0) {
                mLines = lines.filter(l => parseInt(l.MANSEQNUMB) <= 2);
              }

              const mainIndices = mLines.map(ml => lines.findIndex(l => l === ml));
              let minIdx = mainIndices.length > 0 ? Math.min(...mainIndices) : 0;

              let dn = mainIndices.length > 0 ? mainIndices[0] : -1;
              let up = mainIndices.length > 1 ? mainIndices[1] : -1;

              const offsets = [];
              if (lines.length > 0) {
                let currentCx = 0;
                offsets[0] = 0;
                for (let j = 1; j < lines.length; j++) {
                  const prevMain = mainIndices.includes(j - 1);
                  const currMain = mainIndices.includes(j);
                  let gap = 10;
                  if (prevMain && currMain) gap = 20;
                  currentCx += gap;
                  offsets[j] = currentCx;
                }
                const shift = offsets[minIdx] || 0;
                for (let j = 0; j < offsets.length; j++) {
                  offsets[j] = -(offsets[j] - shift);
                }
              }

              return { upMainIdx: up, dnMainIdx: dn, minIdx, mainIndices, offsets };
            };

            const mains = getMains(stn.lines);
            let upMainIdx = mains.upMainIdx;
            let dnMainIdx = mains.dnMainIdx;

            if (upMainIdx === -1 && dnMainIdx === -1) {
              dnMainIdx = 0;
            }
            const isDouble = upMainIdx !== -1 && dnMainIdx !== -1;

            return (
              <g key={`y-${stn.code}`}>
                <line
                  x1={marginLeft} y1={stn.y} x2={containerWidth - marginRight} y2={stn.y}
                  stroke="#e7e9f2" strokeWidth="1" strokeDasharray="2,2"
                />
                {/* Cumulative Distance */}
                <text x={10} y={stn.y + 3} fill="#6b7189" fontSize="9" textAnchor="start" fontWeight="normal">
                  {stn.cumDist}
                </text>
                {/* Station Code Left */}
                <text x={marginLeft - 10} y={stn.y + 3} fill="#1b2036" fontSize="9" textAnchor="end" fontWeight="bold">
                  {stn.code}
                </text>

                {/* Station Nodes Right */}
                <text x={containerWidth - 190} y={stn.y + 3} fill="#1e293b" fontSize="9" fontWeight="bold" textAnchor="start">
                  {stn.code}
                </text>
                <g transform={`translate(${baseX - 4}, ${stn.y})`}>
                  {(stn.lines && stn.lines.length > 0) ? (
                    (() => {
                      return stn.lines.map((l, li) => {
                        let fillColor = '#94a3b8';
                        const stnLineNum = String(l.MANSEQNUMB || l.MAVLINENUMB).trim();
                        const myConns = (layout?.connections || []).filter(c =>
                          String(c.MAVSTTNCODE).trim() === String(stn.code).trim() &&
                          String(c.MANSTTNLINENUMB || '').trim() === stnLineNum
                        );

                        if (myConns.length > 0) {
                          let hasLTR = false;
                          let hasRTL = false;

                          myConns.forEach(conn => {
                            const bs = conn.MAVBLCKSCTN;
                            const otherStn = bs.split('-').find(s => s !== stn.code);

                            const stnIdx = layoutStations.findIndex(s => s.code === stn.code);
                            const otherIdx = layoutStations.findIndex(s => s.code === otherStn);

                            if (stnIdx !== -1 && otherIdx !== -1) {
                              let isLTR = false; // LTR is Top-to-Bottom
                              if (conn.MACRECVSENDFLAG === 'S') {
                                isLTR = stnIdx < otherIdx;
                              } else { // 'R'
                                isLTR = otherIdx < stnIdx;
                              }

                              if (isLTR) hasLTR = true;
                              else hasRTL = true;
                            }
                          });

                          if (hasLTR && hasRTL) fillColor = '#9316a3ff'; // purple (bidirectional)
                          else if (hasLTR) fillColor = '#2563eb';      // Blue (Down / Top-to-Bottom)
                          else if (hasRTL) fillColor = '#ea580c';      // Orange (Up / Bottom-to-Top)
                        } else {
                          if (l.MAVDRTN) {
                            const d = String(l.MAVDRTN).trim().toUpperCase();
                            if (d === 'UP' || d === 'U') fillColor = '#ea580c';
                            else if (d === 'DOWN' || d === 'DN' || d === 'D') fillColor = '#2563eb';
                            else if (d === 'BOTH' || d === 'B') fillColor = '#9316a3ff';
                          } else {
                            const mainLineIndex = mains.mainIndices.indexOf(li);
                            if (mainLineIndex === 0) fillColor = '#2563eb';
                            else if (mainLineIndex === 1) fillColor = '#ea580c';
                          }
                        }

                        let cx = mains.offsets[li] || 0;

                        return <circle key={`dot-${i}-${li}`} cx={cx} cy={0} r="3.5" fill={fillColor} stroke="#fff" strokeWidth="1" />;
                      });
                    })()
                  ) : (
                    <rect x={(isDouble ? 0 : 4)} y={-4} width={isDouble ? 16 : 8} height="8" rx="2" fill="#ffffff" stroke="#334155" strokeWidth="1.5" />
                  )}
                </g>
              </g>
            )
          })}

          <g clipPath="url(#graphClip)">
            {(() => {
              const startPlaced = {};
              const endPlaced = {};

              trainLines.sort((a, b) => (a.stops[0].arrTime % maxTime) - (b.stops[0].arrTime % maxTime));

              trainLines.forEach(train => {
                const startX = getX(train.stops[0].arrTime % maxTime);
                const startY = train.stops[0].y;
                const startKey = `${startY}-${train.isForward}`;

                if (!startPlaced[startKey]) startPlaced[startKey] = [];
                let stagger = 0;
                for (let p of startPlaced[startKey]) {
                  if (Math.abs(p.x - startX) < 2) {
                    stagger = Math.max(stagger, p.stagger + 1);
                  }
                }
                startPlaced[startKey].push({ x: startX, stagger });
                train.startStagger = stagger;

                const lastStop = train.stops[train.stops.length - 1];
                const endX = getX(lastStop.arrTime % maxTime);
                const endY = lastStop.y;
                const endKey = `${endY}-${train.isForward}`;

                if (!endPlaced[endKey]) endPlaced[endKey] = [];
                let endStagger = 0;
                for (let p of endPlaced[endKey]) {
                  if (Math.abs(p.x - endX) < 2) {
                    endStagger = Math.max(endStagger, p.stagger + 1);
                  }
                }
                endPlaced[endKey].push({ x: endX, stagger: endStagger });
                train.endStagger = endStagger;
              });

              return filteredTrainLines.map((train, i) => {
                const isHovered = hoveredTrain === train.trainNo;

                const sDays = String(train.daysOfSrvc).replace(/[^1]/g, '');
                const isDaily = sDays === '1111111' || String(train.daysOfSrvc).toLowerCase() === 'daily';

                let d = '';
                train.stops.forEach((stop, i) => {
                  if (i > 0) {
                    const prevStop = train.stops[i - 1];
                    d += getSegmentsD(prevStop.y, prevStop.depTime, stop.y, stop.arrTime);
                  }
                  if (stop.depTime > stop.arrTime && i < train.stops.length - 1) {
                    d += getSegmentsD(stop.y, stop.arrTime, stop.y, stop.depTime);
                  }
                });

                let angleStart = 0;
                if (train.stops.length > 1) {
                  const dx = getX(train.stops[1].arrTime) - getX(train.stops[0].depTime);
                  const dy = train.stops[1].y - train.stops[0].y;
                  angleStart = Math.atan2(dy, dx) * (180 / Math.PI);
                }

                let angleEnd = angleStart;
                if (train.stops.length > 2) {
                  const lastStop = train.stops[train.stops.length - 1];
                  const prevStop = train.stops[train.stops.length - 2];
                  const dx = getX(lastStop.arrTime) - getX(prevStop.depTime);
                  const dy = lastStop.y - prevStop.y;
                  angleEnd = Math.atan2(dy, dx) * (180 / Math.PI);
                }

                const drawnSegments = [];
                train.stops.forEach((stop, j) => {
                  if (j > 0) {
                    const prevStop = train.stops[j - 1];
                    let t1 = prevStop.depTime;
                    let y1 = prevStop.y;
                    let t2 = stop.arrTime;
                    let y2 = stop.y;

                    if (t2 > t1) {
                      let currentT = t1;
                      let currentY = y1;
                      const deltaT = t2 - t1;
                      const deltaY = y2 - y1;

                      while (currentT < t2) {
                        const currentCycle = Math.floor(currentT / maxTime);
                        const endOfCycle = (currentCycle + 1) * maxTime;
                        const nextT = Math.min(t2, endOfCycle);

                        const segmentStartT = currentT % maxTime;
                        let segmentEndT = nextT % maxTime;
                        if (segmentEndT === 0 && nextT > currentT) {
                          segmentEndT = maxTime;
                        }

                        const progress = (nextT - t1) / deltaT;
                        const nextY = y1 + progress * deltaY;

                        const sx = getX(segmentStartT);
                        const ex = getX(segmentEndT);
                        const dx = ex - sx;
                        const dy = nextY - currentY;
                        drawnSegments.push({ sx, sy: currentY, ex, ey: nextY, dx, dy, len: Math.hypot(dx, dy) });

                        currentT = nextT;
                        currentY = nextY;
                      }
                    }
                  }
                });

                let visibleStartX = null;
                let visibleStartY = null;
                let visibleEndX = null;
                let visibleEndY = null;

                drawnSegments.forEach(seg => {
                  const minX = marginLeft;
                  const maxX = marginLeft + chartWidth;

                  let x1 = seg.sx;
                  let y1 = seg.sy;
                  let x2 = seg.ex;
                  let y2 = seg.ey;

                  if (Math.max(x1, x2) < minX || Math.min(x1, x2) > maxX) return;

                  if (x1 < minX) {
                    y1 = seg.sy + (minX - seg.sx) * (seg.dy / seg.dx);
                    x1 = minX;
                  }
                  if (x1 > maxX) {
                    y1 = seg.sy + (maxX - seg.sx) * (seg.dy / seg.dx);
                    x1 = maxX;
                  }
                  if (x2 < minX) {
                    y2 = seg.sy + (minX - seg.sx) * (seg.dy / seg.dx);
                    x2 = minX;
                  }
                  if (x2 > maxX) {
                    y2 = seg.sy + (maxX - seg.sx) * (seg.dy / seg.dx);
                    x2 = maxX;
                  }

                  if (x1 > x2) {
                    let tempX = x1; x1 = x2; x2 = tempX;
                    let tempY = y1; y1 = y2; y2 = tempY;
                  }

                  if (visibleStartX === null || x1 < visibleStartX) {
                    visibleStartX = x1;
                    visibleStartY = y1;
                  }
                  if (visibleEndX === null || x2 > visibleEndX) {
                    visibleEndX = x2;
                    visibleEndY = y2;
                  }
                });

                const startX = visibleStartX !== null ? visibleStartX : getX(train.stops[0].arrTime % maxTime);
                const startY = visibleStartY !== null ? visibleStartY : train.stops[0].y;

                const endX = visibleEndX !== null ? visibleEndX : getX(train.stops[train.stops.length - 1].arrTime % maxTime);
                const endY = visibleEndY !== null ? visibleEndY : train.stops[train.stops.length - 1].y;

                let startAngle = 0;
                let endAngle = 0;
                if (train.stops.length >= 2) {
                  const s0 = train.stops[0];
                  const s1 = train.stops[1];
                  let dxStart = (s1.arrTime - s0.depTime) * (chartWidth / maxTime);
                  if (dxStart < 0) dxStart += chartWidth;
                  const dyStart = s1.y - s0.y;
                  startAngle = (Math.atan2(dyStart, dxStart) * 180) / Math.PI;

                  const sN = train.stops[train.stops.length - 1];
                  const sN1 = train.stops[train.stops.length - 2];
                  let dxEnd = (sN.arrTime - sN1.depTime) * (chartWidth / maxTime);
                  if (dxEnd < 0) dxEnd += chartWidth;
                  const dyEnd = sN.y - sN1.y;
                  endAngle = (Math.atan2(dyEnd, dxEnd) * 180) / Math.PI;
                }



                return (
                  <g
                    key={train.trainNo}
                    onMouseEnter={(e) => {
                      setHoveredTrain(train.trainNo);
                      setMousePos({ x: e.clientX, y: e.clientY });
                    }}
                    onMouseMove={(e) => {
                      setMousePos({ x: e.clientX, y: e.clientY });
                    }}
                    onMouseLeave={() => setHoveredTrain(null)}
                    onClick={() => setSelectedTrain(train.trainNo)}
                    style={{ cursor: 'pointer' }}
                  >
                    <path
                      d={d}
                      fill="none"
                      stroke={train.color}
                      strokeWidth={isHovered ? (isDaily ? 6 : 4) : (isDaily ? 3.5 : 1.2)}
                      opacity={1}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                      markerEnd={`url(#arrowTdg-${train.color === '#dc2626' ? 'red' : train.color === '#2563eb' ? 'blue' : train.color === '#000000' ? 'black' : train.color === '#9333ea' ? 'purple' : train.color === '#16a34a' ? 'green' : 'orange'})`}
                    />

                    {isHovered && train.stops.map((stop, i) => {
                      const t = stop.arrTime % maxTime === 0 && stop.arrTime > 0 ? maxTime : stop.arrTime % maxTime;
                      return (
                        <circle
                          key={`stop-${i}`}
                          cx={getX(t)}
                          cy={stop.y}
                          r={5}
                          fill={train.color}
                          stroke="#1b2036"
                          strokeWidth={2}
                        />
                      );
                    })}



                    {/* Start Label with Stroke for Print Readability */}
                    <text
                      x="0"
                      y="0"
                      transform={`translate(${startX}, ${startY}) rotate(${startAngle}) translate(12, -4)`}
                      fill="#ffffff"
                      stroke="#ffffff"
                      strokeWidth="3"
                      strokeLinejoin="round"
                      fontSize={isHovered ? "12" : (maxTime === 168 ? "9" : "10")}
                      fontWeight="bold"
                      textAnchor="start"
                      opacity={1}
                    >
                      {train.isSimulated ? train.name : train.originalTrainNo}
                    </text>
                    <text
                      x="0"
                      y="0"
                      transform={`translate(${startX}, ${startY}) rotate(${startAngle}) translate(12, -4)`}
                      fill={train.color}
                      fontSize={isHovered ? "12" : (maxTime === 168 ? "9" : "10")}
                      fontWeight="bold"
                      textAnchor="start"
                      opacity={1}
                    >
                      {train.isSimulated ? train.name : train.originalTrainNo}
                    </text>

                    {/* End Label with Stroke */}
                    {train.stops.length >= 2 && (
                      <>
                        <text
                          x="0"
                          y="0"
                          transform={`translate(${endX}, ${endY}) rotate(${endAngle}) translate(-12, -4)`}
                          fill="#ffffff"
                          stroke="#ffffff"
                          strokeWidth="3"
                          strokeLinejoin="round"
                          fontSize={isHovered ? "12" : (maxTime === 168 ? "9" : "10")}
                          fontWeight="bold"
                          textAnchor="end"
                          opacity={1}
                        >
                          {train.isSimulated ? train.name : train.originalTrainNo}
                        </text>
                        <text
                          x="0"
                          y="0"
                          transform={`translate(${endX}, ${endY}) rotate(${endAngle}) translate(-12, -4)`}
                          fill={train.color}
                          fontSize={isHovered ? "12" : (maxTime === 168 ? "9" : "10")}
                          fontWeight="bold"
                          textAnchor="end"
                          opacity={1}
                        >
                          {train.isSimulated ? train.name : train.originalTrainNo}
                        </text>
                      </>
                    )}
                  </g>
                );
              });
            })()}
          </g>
        </g>
      </svg>

      <div style={{
        position: 'sticky',
        bottom: 0,
        width: 'max-content',
        minWidth: '100%',
        height: '40px',
        background: '#ffffff',
        zIndex: 10,
        borderTop: '1px solid #444',
        boxShadow: '0 -4px 10px rgba(0,0,0,0.05)'
      }}>
        <svg width={chartWidth + marginLeft + marginRight} height="40" style={{ display: 'block', background: '#ffffff', position: 'sticky', bottom: 0, zIndex: 10 }}>
          {renderXAxis('bottom')}
        </svg>
      </div>

      {hoveredTrain && !selectedTrain && (
        <div className="tooltip" style={{
          position: 'fixed',
          left: `${mousePos.x + 15}px`,
          top: `${mousePos.y + 15}px`,
          background: 'rgba(27, 32, 54, 0.9)',
          border: `1px solid ${allTrainLines.find(t => t.trainNo === hoveredTrain)?.color}`,
          padding: '10px',
          borderRadius: '8px',
          pointerEvents: 'none',
          color: '#ffffff',
          zIndex: 9999,
          boxShadow: '0 4px 12px rgba(0,0,0,0.2)'
        }}>
          {(() => {
            const tr = allTrainLines.find(t => t.trainNo === hoveredTrain);
            if (!tr) return null;
            return (
              <>
                <h4 style={{ margin: '0 0 4px 0', color: tr?.color, fontSize: '13px' }}>{tr?.isSimulated ? tr.name : (tr?.originalTrainNo || tr?.trainNo)} (Click for full schedule)</h4>
              </>
            );
          })()}
        </div>
      )}

      {selectedTrain && (
        <div style={{
          position: 'fixed',
          top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
          zIndex: 10000,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }} onClick={() => setSelectedTrain(null)}>
          <div style={{
            background: '#ffffff',
            borderRadius: '12px',
            width: '800px',
            maxWidth: '95vw',
            maxHeight: '80vh',
            display: 'flex',
            flexDirection: 'column',
            boxShadow: '0 10px 25px rgba(0,0,0,0.5)',
            border: `2px solid ${allTrainLines.find(t => t.trainNo === selectedTrain)?.color || '#334155'}`
          }} onClick={(e) => e.stopPropagation()}>
            {(() => {
              const tr = allTrainLines.find(t => t.trainNo === selectedTrain);
              if (!tr) return null;
              return (
                <>
                  <div style={{ padding: '16px', borderBottom: '1px solid #eef0f7', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <h3 style={{ margin: 0, color: tr.color }}>{tr.isSimulated ? tr.name : (tr.originalTrainNo || tr.trainNo)} - {tr.isSimulated ? 'Simulated Path' : (tr.name || 'Train')}</h3>
                      {tr.isSimulated && (
                        <span style={{ fontSize: '13px', color: '#16a34a', fontWeight: 'bold', padding: '4px 8px', backgroundColor: '#dcfce7', borderRadius: '4px' }}>
                          Journey Time: {(() => {
                            const firstStop = tr.stops[0];
                            const lastStop = tr.stops[tr.stops.length - 1];
                            const diffMins = Math.round((lastStop.arrTime - firstStop.depTime) * 60);
                            const h = Math.floor(diffMins / 60);
                            const m = diffMins % 60;
                            return `${h}h ${m}m`;
                          })()}
                        </span>
                      )}
                      {tr.isSimulated && setSimulatedPaths && (
                        <button
                          onClick={() => {
                            setSimulatedPaths(prev => prev.filter(p => p.trainNo !== (tr.originalTrainNo || tr.trainNo)));
                            setSelectedTrain(null);
                          }}
                          style={{ padding: '4px 8px', background: '#ef4444', color: 'white', border: 'none', borderRadius: '4px', fontSize: '12px', fontWeight: 'bold', cursor: 'pointer' }}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                    <button onClick={() => setSelectedTrain(null)} style={{ background: 'transparent', border: 'none', color: '#6b7189', fontSize: '24px', cursor: 'pointer', lineHeight: 1 }}>&times;</button>
                  </div>
                  <div style={{ padding: '16px', overflowY: 'auto', flex: 1 }}>
                    <table>
                      <thead>
                        <tr>
                          <th>Seq</th>
                          <th>Zone</th>
                          <th>Div</th>
                          <th>Station</th>
                          <th>Arrival</th>
                          <th>Departure</th>
                          <th>Day</th>
                          <th>Service</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tr.stops.map((s, i) => (
                          <tr key={i}>
                            <td>{s.seq}</td>
                            <td>{s.zone}</td>
                            <td>{s.division}</td>
                            <td style={{ fontWeight: '700', color: '#1b2036' }}>{s.station}</td>
                            <td style={{ color: '#4f7cff', fontWeight: '600' }}>{s.arrStr}</td>
                            <td style={{ color: '#4f7cff', fontWeight: '600' }}>{s.depStr}</td>
                            <td>{s.dayOfSrvc}</td>
                            <td>{s.weekDay}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}

function formatTime(seconds) {
  const h = Math.floor((seconds % (24 * 3600)) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

function formatDaysOfService(daysStr) {
  if (!daysStr) return "-";

  // Extract just the 1s and 0s
  const bits = String(daysStr).replace(/[^01]/g, '');
  if (bits.length !== 7) return daysStr; // Fallback if format is unexpected

  const dayNames = ['M', 'Tu', 'W', 'Th', 'F', 'Sa', 'Su'];
  const runningDays = [];
  const notRunningDays = [];

  for (let i = 0; i < 7; i++) {
    if (bits[i] === '1') {
      runningDays.push(dayNames[i]);
    } else {
      notRunningDays.push(dayNames[i]);
    }
  }

  const onesCount = runningDays.length;

  if (onesCount === 7) return "Daily";
  if (onesCount === 0) return "None";
  if (onesCount >= 4) return `Except ${notRunningDays.join(', ')}`;

  return runningDays.join(', ');
}