import { getBlockCodeBetween, buildStationLineDirections } from '../utils/layoutHelpers';

let diagnostics = {
  attemptCount: 0,
  totalIterations: 0,
  blockConflictChecks: 0,
  stationConflictChecks: 0,
  backtrackCount: 0,
};

export async function runSimulation({
  layout,
  layoutStations,
  canonicalTrains = [],
  simSource,          // explicit: user-selected source station code
  simDest,            // explicit: user-selected destination station code
  scheduleData,
  stationLines = [],
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
  simStops,
  simDirections,
  abortSimRef,
  simulatedPaths = [], // existing simulated paths
  debug = false
}) {
  // Helper to format time strings
  const formatTimeMins = mins => {
    const totalSecs = Math.round(mins * 60);
    const h = Math.floor((totalSecs % (24 * 3600)) / 3600);
    const m = Math.floor((totalSecs % 3600) / 60);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
  };

  // ─── Use the explicitly-passed layoutStations ─────────────────────────────
  // layoutStations is now received as a parameter from the React component.
  // It must NOT be referenced from module scope (there is no such global).
  // The caller (TimeDistanceGraph) passes graphData.layoutStations.
  if (!layoutStations || layoutStations.length < 2) {
    console.error('runSimulation: layoutStations not provided or too short.');
    return [];
  }

  if (debug) {
    diagnostics = {
      attemptCount: 0,
      totalIterations: 0,
      blockConflictChecks: 0,
      stationConflictChecks: 0,
      backtrackCount: 0,
    };
  }

  let goodsLogCount = 0;

  // Prepare data needed for simulation
  const abort = abortSimRef;
  abort.current = false;
  // Convert time strings to minutes
  let startDayIdx = 0;
  if (simDay === 'Tue') startDayIdx = 1;
  else if (simDay === 'Wed') startDayIdx = 2;
  else if (simDay === 'Thu') startDayIdx = 3;
  else if (simDay === 'Fri') startDayIdx = 4;
  else if (simDay === 'Sat') startDayIdx = 5;
  else if (simDay === 'Sun') startDayIdx = 6;

  const [fh, fm] = simTimeFrom.split(':').map(Number);
  let fromMins = startDayIdx * 24 * 60 + fh * 60 + fm;
  const [uh, um] = simTimeUpto.split(':').map(Number);
  let uptoMins = startDayIdx * 24 * 60 + uh * 60 + um;
  if (uptoMins < fromMins) uptoMins += 24 * 60;

  let completionMins = null;
  if (simCompletionTime) {
    const [ch, cm] = simCompletionTime.split(':').map(Number);
    completionMins = startDayIdx * 24 * 60 + ch * 60 + cm;
    if (completionMins < fromMins) completionMins += 24 * 60;
  }

  const hwMargin = parseInt(simHeadway) || 5;
  const maxDetentionMins = (parseInt(simMaxDetention) || 2) * 60;
  const speedLimit = (simSpeed === 'goods' || !simSpeed) ? null : parseFloat(simSpeed);
  const parseTimeInput = val => {
    if (!val) return 0;
    if (String(val).includes(':')) {
      const parts = String(val).split(':');
      const m = parseInt(parts[0]) || 0;
      const s = parseInt(parts[1]) || 0;
      return m + (s / 60);
    }
    return parseFloat(val) || 0;
  };
  const accelPenaltyMins = simAccelTime ? Math.max(0, parseTimeInput(simAccelTime)) : 0;
  const decelPenaltyMins = simDecelTime ? Math.max(0, parseTimeInput(simDecelTime)) : 0;
  const STATION_SAFETY_MARGIN = 5;

  const simStopsMap = new Map(simStops.map(s => [s.code, s.halt]));

  // Helper functions (copied from component)
  const getStationSpeeds = stnCode => {
    const stnLines = stationLines.filter(l => String(l.MAVSTTNCODE).trim() === stnCode);
    if (!stnLines || stnLines.length === 0) return [110];
    const mainLines = stnLines.filter(l => {
      const cat = String(l.MACLINECATEGORY || '').trim().toUpperCase();
      return cat === 'M' || cat === 'MAIN';
    });
    const mainSeqs = mainLines.map(l => parseFloat(l.MANSEQNUMB) || 0);
    const speeds = stnLines.map(l => {
      if (l.MAVSPEED) return parseFloat(l.MAVSPEED);
      const cat = String(l.MACLINECATEGORY || '').trim().toUpperCase();
      if (cat === 'M' || cat === 'MAIN') return 110;
      const seq = parseFloat(l.MANSEQNUMB) || 0;
      let minDiff = Infinity;
      for (let mSeq of mainSeqs) {
        const diff = Math.abs(seq - mSeq);
        if (diff < minDiff) minDiff = diff;
      }
      if (minDiff <= 1) return 30;
      return 15;
    });
    return speeds.sort((a, b) => b - a);
  };

  const getStationCapacity = stnCode => {
    const stnLines = stationLines.filter(l => String(l.MAVSTTNCODE).trim() === stnCode);
    return Math.max(1, stnLines.length);
  };

  const speedsCache = new Map();
  const cachedGetStationSpeeds = stnCode => {
    if (!speedsCache.has(stnCode)) speedsCache.set(stnCode, getStationSpeeds(stnCode));
    return speedsCache.get(stnCode);
  };
  const capacityCache = new Map();
  const cachedGetStationCapacity = stnCode => {
    if (!capacityCache.has(stnCode)) capacityCache.set(stnCode, getStationCapacity(stnCode));
    return capacityCache.get(stnCode);
  };

  // Station order map for block checking
  const stationOrderMap = {};
  let _ord = 0;
  for (const node of layout.sequence) {
    if (node.type === 'station') stationOrderMap[node.code] = _ord++;
  }
  const stationBetween = (code, stopA, stopB) => {
    const o = stationOrderMap[code];
    const oA = stationOrderMap[stopA];
    const oB = stationOrderMap[stopB];
    if (o === undefined || oA === undefined || oB === undefined) return false;
    return o >= Math.min(oA, oB) && o <= Math.max(oA, oB);
  };

  // Build blockInfo (same as component)
  const buildBlockInfo = (stn1Code, stn2Code, isDoubleLine, signalling = 'AB') => {
    const o1 = stationOrderMap[stn1Code];
    const o2 = stationOrderMap[stn2Code];
    const simFwd = o2 > o1;
    const matchedCandidates = [];
    const fixedTrainsBase = [...canonicalTrains, ...simulatedPaths];
    const canonicalSet = new Set(canonicalTrains);
    for (const train of fixedTrainsBase) {
      if (!train.stops || train.stops.length < 2) continue;
      const isSimulated = !canonicalSet.has(train);
      for (let i = 1; i < train.stops.length; i++) {
        const pStp = train.stops[i - 1];
        const cStp = train.stops[i];
        let segCoversBlock, isSameDir, isOppDir;
        if (isSimulated) {
          const same = pStp.station === stn1Code && cStp.station === stn2Code;
          const opp = pStp.station === stn2Code && cStp.station === stn1Code;
          segCoversBlock = same || opp;
          isSameDir = same;
          isOppDir = opp;
        } else {
          const bothIn = stationBetween(stn1Code, pStp.station, cStp.station) && stationBetween(stn2Code, pStp.station, cStp.station);
          if (!bothIn) continue;
          const oA = stationOrderMap[pStp.station];
          const oB = stationOrderMap[cStp.station];
          const realFwd = oB > oA;
          isSameDir = realFwd === simFwd;
          isOppDir = !isSameDir;
          segCoversBlock = true;
        }
        if (!segCoversBlock) continue;
        if (isDoubleLine && isOppDir) continue;
        matchedCandidates.push({
          isSimulated,
          segDepBase: (isSimulated && pStp.absDepMins !== undefined) ? pStp.absDepMins : (pStp.depTime * 60),
          segArrBase: (isSimulated && cStp.absArrMins !== undefined) ? cStp.absArrMins : (cStp.arrTime * 60),
          isSameDir,
          daysBits: (!isSimulated && train.daysOfSrvc) ? String(train.daysOfSrvc).replace(/[^01]/g, '') : null
        });
        break;
      }
    }
    // stn2Candidates for conflict counting at station
    const stn2Candidates = [];
    for (const train of fixedTrainsBase) {
      if (!train.stops || train.stops.length === 0) continue;
      const isSimulated = !canonicalSet.has(train);
      for (const stop of train.stops) {
        if (stop.station !== stn2Code) continue;
        stn2Candidates.push({
          isSimulated,
          arrBase: (isSimulated && stop.absArrMins !== undefined) ? stop.absArrMins : (stop.arrTime * 60),
          depBase: (isSimulated && stop.absDepMins !== undefined) ? stop.absDepMins : (stop.depTime * 60),
          daysBits: (!isSimulated && train.daysOfSrvc) ? String(train.daysOfSrvc).replace(/[^01]/g, '') : null
        });
        break;
      }
    }
    return {
      stn1Code,
      stn2Code,
      isDoubleLine,
      matchedCandidates,
      stn2Candidates,
      signalling
    };
  };

  const countOverlapsFast = (blockInfo, depMins, arrMins, extraScheduled) => {
    let sameDirOverlaps = 0;
    let oppDirOverlaps = 0;
    let headwayViolation = false;
    let automaticSeparationViolation = false;
    let confTrainId = null;
    let confTrainDir = null;

    // TEMPORARY: project/railway-specific Automatic Signalling separation
    // must be confirmed by project authority.
    const automaticSeparationMins = hwMargin;

    const currentDayIdx = Math.floor(depMins / 1440);

    // Check matched candidates (existing trains)
    for (const cand of blockInfo.matchedCandidates) {
      let dayOffset = 0;
      if (!cand.isSimulated) {
        if (simDay !== 'All') {
          if (cand.daysBits && cand.daysBits.length === 7 && cand.daysBits[currentDayIdx % 7] !== '1') continue;
        }
        dayOffset = currentDayIdx * 1440;
      }
      const segDep = cand.segDepBase + dayOffset;
      const segArr = cand.segArrBase + dayOffset;

      if (cand.isSameDir) {
        // Normal scheduler headway check
        if (Math.abs(segDep - depMins) < hwMargin) headwayViolation = true;
        if (Math.abs(segArr - arrMins) < hwMargin) headwayViolation = true;
        if ((segDep < depMins && segArr > arrMins) || (segDep > depMins && segArr < arrMins)) headwayViolation = true;

        // Automatic signalling separation check
        if (Math.abs(segDep - depMins) < automaticSeparationMins) automaticSeparationViolation = true;
        if (Math.abs(segArr - arrMins) < automaticSeparationMins) automaticSeparationViolation = true;
        if ((segDep < depMins && segArr > arrMins) || (segDep > depMins && segArr < arrMins)) automaticSeparationViolation = true;
      }

      // Physical occupancy overlap (Time-window overlap)
      if ((segDep - hwMargin) < arrMins && (segArr + hwMargin) > depMins) {
        if (cand.isSameDir) {
          sameDirOverlaps++;
        } else {
          oppDirOverlaps++;
        }
        if (!confTrainId) {
          confTrainId = 'canonical_train';
          confTrainDir = cand.isSameDir ? 'SAME' : 'OPPOSITE';
        }
      }
    }

    // Check extra scheduled trains
    if (extraScheduled && extraScheduled.length > 0) {
      for (const train of extraScheduled) {
        if (!train.stops || train.stops.length < 2) continue;
        for (let i = 1; i < train.stops.length; i++) {
          const pStp = train.stops[i - 1];
          const cStp = train.stops[i];
          const same = pStp.station === blockInfo.stn1Code && cStp.station === blockInfo.stn2Code;
          const opp = pStp.station === blockInfo.stn2Code && cStp.station === blockInfo.stn1Code;
          if (!same && !opp) continue;
          if (blockInfo.isDoubleLine && opp) continue;

          const segDep = pStp.absDepMins !== undefined ? pStp.absDepMins : (pStp.depTime * 60);
          const segArr = cStp.absArrMins !== undefined ? cStp.absArrMins : (cStp.arrTime * 60);

          if (same) {
            if (Math.abs(segDep - depMins) < hwMargin) headwayViolation = true;
            if (Math.abs(segArr - arrMins) < hwMargin) headwayViolation = true;
            if ((segDep < depMins && segArr > arrMins) || (segDep > depMins && segArr < arrMins)) headwayViolation = true;

            if (Math.abs(segDep - depMins) < automaticSeparationMins) automaticSeparationViolation = true;
            if (Math.abs(segArr - arrMins) < automaticSeparationMins) automaticSeparationViolation = true;
            if ((segDep < depMins && segArr > arrMins) || (segDep > depMins && segArr < arrMins)) automaticSeparationViolation = true;
          }

          if ((segDep - hwMargin) < arrMins && (segArr + hwMargin) > depMins) {
            if (same) {
              sameDirOverlaps++;
            } else {
              oppDirOverlaps++;
            }
            if (!confTrainId) {
              confTrainId = 'simulated_train';
              confTrainDir = same ? 'SAME' : 'OPPOSITE';
            }
          }
          break;
        }
      }
    }

    return { sameDirOverlaps, oppDirOverlaps, headwayViolation, automaticSeparationViolation, confTrainId, confTrainDir };
  };

  const stationLineDirs = buildStationLineDirections(layout);

  const globalStationAllocations = {};

  const initAllocations = (stnCode) => {
    if (!globalStationAllocations[stnCode]) {
      globalStationAllocations[stnCode] = [];
    }
    return globalStationAllocations[stnCode];
  };

  const getAbsoluteIntervals = (alloc, maxDays = 7) => {
    if (!alloc.daysBits) return [{ start: alloc.tStart, end: alloc.tEnd }];
    const intervals = [];
    for (let day = 0; day < maxDays; day++) {
      if (alloc.daysBits[day % 7] === '1') {
        intervals.push({
          start: alloc.tStart + day * 1440,
          end: alloc.tEnd + day * 1440
        });
      }
    }
    return intervals;
  };

  const checkIntervalOverlap = (reqStart, reqEnd, alloc, safetyMargin = 5) => {
    const intervals = getAbsoluteIntervals(alloc);
    for (const int of intervals) {
      if (int.start < reqEnd && reqStart < (int.end + safetyMargin)) {
        return true;
      }
    }
    return false;
  };

  const allocateStationLine = (stnCode, tId, tDir, tStart, tEnd, daysBits, isCanonical) => {
    const stnLines = stationLineDirs[stnCode];
    if (!stnLines) return null;

    const lines = Object.keys(stnLines).map(lineId => ({ lineId, direction: stnLines[lineId] }));
    const compatibleLines = lines
      .filter(l => l.direction === tDir || l.direction === 'BOTH')
      .sort((a, b) => {
        const aBoth = a.direction === 'BOTH' ? 1 : 0;
        const bBoth = b.direction === 'BOTH' ? 1 : 0;
        return aBoth - bBoth; // exact direction first
      });

    const allocations = initAllocations(stnCode);

    let assignedLineId = null;
    for (const l of compatibleLines) {
      let conflict = false;
      for (const a of allocations) {
        if (a.lineId !== l.lineId) continue;

        const reqIntervals = getAbsoluteIntervals({ tStart, tEnd, daysBits });
        for (const cInt of reqIntervals) {
          if (checkIntervalOverlap(cInt.start, cInt.end, a, STATION_SAFETY_MARGIN)) {
            conflict = true;
            break;
          }
        }
        if (conflict) break;
      }

      if (!conflict) {
        assignedLineId = l.lineId;
        break;
      }
    }

    if (assignedLineId) {
      allocations.push({ lineId: assignedLineId, tId, tDir, tStart, tEnd, daysBits, overflow: false });
      return assignedLineId;
    } else {
      console.debug('[STATION CAPACITY VIOLATION]', {
        station: stnCode, trainId: tId, direction: tDir,
        requested: `${tStart}-${tEnd}`,
        lines: compatibleLines.length,
        isCanonical
      });
      const forcedLineId = compatibleLines.length > 0 ? compatibleLines[0].lineId : 'UNKNOWN';
      allocations.push({ lineId: forcedLineId, tId, tDir, tStart, tEnd, daysBits, overflow: true });
      return forcedLineId;
    }
  };

  // Pre-allocate Canonical Trains
  canonicalTrains.forEach(train => {
    if (!train.stops) return;
    const tId = train.trainNo;
    const tDir = train.isForward ? 'DOWN' : 'UP';
    const daysBits = train.daysOfSrvc ? String(train.daysOfSrvc).replace(/[^01]/g, '') : null;
    for (const stop of train.stops) {
      const arr = stop.absArrMins !== undefined ? stop.absArrMins : (stop.arrTime * 60);
      const dep = stop.absDepMins !== undefined ? stop.absDepMins : (stop.depTime * 60);
      allocateStationLine(stop.station, tId, tDir, arr, dep, daysBits, true);
    }
  });

  // Pre-allocate Accepted Simulated Paths (from previous runs/reloads)
  simulatedPaths.forEach(train => {
    if (!train.stops) return;
    const tId = train.trainNo;
    const tDir = train.isForward ? 'DOWN' : 'UP';
    for (const stop of train.stops) {
      if (stop.stationLineId) {
        const arr = stop.absArrMins !== undefined ? stop.absArrMins : (stop.arrTime * 60);
        const dep = stop.absDepMins !== undefined ? stop.absDepMins : (stop.depTime * 60);
        const allocations = initAllocations(stop.station);
        allocations.push({ lineId: stop.stationLineId, tId, tDir, tStart: arr, tEnd: dep, daysBits: null, overflow: false });
      }
    }
  });

  const checkCandidateStationLine = (stnCode, reqStart, reqEnd, reqDir, reqTrainId, forceLineId = null) => {
    diagnostics.stationConflictChecks++;
    const stnLines = stationLineDirs[stnCode];

    if (!stnLines) return { conflict: false, assignedLineId: null };

    let compatibleLines = [];
    if (forceLineId) {
      compatibleLines = [{ lineId: forceLineId, direction: stnLines[forceLineId] }];
    } else {
      const lines = Object.keys(stnLines).map(lineId => ({ lineId, direction: stnLines[lineId] }));
      compatibleLines = lines
        .filter(l => l.direction === reqDir || l.direction === 'BOTH')
        .sort((a, b) => {
          const aBoth = a.direction === 'BOTH' ? 1 : 0;
          const bBoth = b.direction === 'BOTH' ? 1 : 0;
          return aBoth - bBoth;
        });
    }

    const allocations = globalStationAllocations[stnCode] || [];

    let assignedLineId = null;
    for (const l of compatibleLines) {
      let conflict = false;
      for (const a of allocations) {
        if (a.lineId !== l.lineId) continue;

        if (checkIntervalOverlap(reqStart, reqEnd, a, STATION_SAFETY_MARGIN)) {
          conflict = true;
          break;
        }
      }

      if (!conflict) {
        assignedLineId = l.lineId;
        break;
      }
    }

    if (assignedLineId) {
      return { conflict: false, assignedLineId };
    } else {
      diagnostics.stationCapacityFailures = (diagnostics.stationCapacityFailures || 0) + 1;
      return { conflict: true, assignedLineId: null };
    }
  };

  const attemptPathFromTime = async (stations, blockData, blockInfos, tryStartMins, extraScheduled, reqTrainId) => {
    const n = stations.length;
    if (n < 2) return null;
    const arrivalAt = new Array(n).fill(null);
    const departAttempt = new Array(n).fill(null);
    const hopResult = new Array(n - 1).fill(null);
    const waitStartedAt = new Array(n).fill(null);
    const conflictReasons = new Array(n - 1).fill(null);
    arrivalAt[0] = tryStartMins;
    let i = 0;
    let totalWaitMins = 0;
    let detentionCount = 0;
    let iter = 0;
    let originLineId = null;
    const visited = new Set();
    const detainedStations = new Set();
    while (true) {
      iter++;
      diagnostics.totalIterations++;
      if (iter % 300 === 0) await new Promise(r => setTimeout(r, 0));
      if (iter > 200000) return null;
      if (i < 0) return null;
      if (i >= n - 1) {
        const path = [];
        for (let k = 0; k < n - 1; k++) path.push(hopResult[k]);
        return { path, totalWaitMins, detentionCount };
      }
      const block = blockData[i];
      const blockInfo = blockInfos[i];
      const halt = i === 0 ? 0 : (simStopsMap.has(block.stn1.code) ? simStopsMap.get(block.stn1.code) : 0);
      const isFwdAttempt = stationOrderMap[block.stn2.code] > stationOrderMap[block.stn1.code];
      const reqDir = isFwdAttempt ? 'DOWN' : 'UP';

      if (departAttempt[i] === null) {
        departAttempt[i] = arrivalAt[i] + halt;
        waitStartedAt[i] = departAttempt[i];
      }

      while (departAttempt[i] <= arrivalAt[i] + halt + maxDetentionMins) {
        let assignedSpeed = null;
        let finalArrTime = null;
        let blockConflictFound = false;
        let stationConflictFound = false;

        // RE-CHECK THE ENTIRE HALT DURATION INCLUDING DETENTION
        let currentLineId = null;
        if (i === 0) {
          const originRes = checkCandidateStationLine(block.stn1.code, arrivalAt[0], departAttempt[0], reqDir, reqTrainId);
          if (originRes.conflict) {
            stationConflictFound = true;
          } else {
            currentLineId = originRes.assignedLineId;
            originLineId = currentLineId;
          }
        } else {
          currentLineId = hopResult[i - 1].endLineId;
          const waitRes = checkCandidateStationLine(block.stn1.code, arrivalAt[i], departAttempt[i], reqDir, reqTrainId, currentLineId);
          if (waitRes.conflict) {
            stationConflictFound = true;
          }
        }

        if (stationConflictFound) {
          diagnostics.backtrackCount++;
          for (let k = i; k < n; k++) departAttempt[k] = null;
          if (i > 0) departAttempt[i - 1] += 1;
          break;
        }

        const depTime = departAttempt[i];

        let stnSpeeds = speedLimit ? [speedLimit] : cachedGetStationSpeeds(block.stn1.code);

        if (simSpeed === 'goods') {
          const dirKey = reqDir === 'DOWN' ? 'forward' : 'backward';
          const secCode = block.blockCode;
          const loadType = simTrainLoadType || 'LOADED';
          const ovrKey = `${dirKey}_${secCode}_${loadType}`;
          const override = goodsSpeedOverrides && goodsSpeedOverrides[ovrKey];

          let foundSpeed = null;
          let defSpeed = null;

          if (goodsSpeedConfig && goodsSpeedConfig[dirKey] && goodsSpeedConfig[dirKey][secCode] && goodsSpeedConfig[dirKey][secCode][loadType]) {
            const stats = goodsSpeedConfig[dirKey][secCode][loadType];
            if (stats.defaultSpeed > 0) {
              defSpeed = stats.defaultSpeed;
            }
          }

          if (override && !isNaN(parseFloat(override)) && parseFloat(override) > 0) {
            foundSpeed = parseFloat(override);
          } else if (defSpeed) {
            foundSpeed = defSpeed;
          }

          if (foundSpeed) {
            stnSpeeds = [foundSpeed];
          } else {
            stnSpeeds = cachedGetStationSpeeds(block.stn1.code);
          }
        }

        for (const spd of stnSpeeds) {
          let accelMins = 0;
          let decelMins = 0;

          // Acceleration logic:
          // - Always apply at origin (i === 0).
          // - Apply at every intermediate actual stop.
          //   A station is an actual stop if it has a scheduled halt > 0 OR if it was detained there.
          const stn1Halt = simStopsMap.has(block.stn1.code) ? simStopsMap.get(block.stn1.code) : 0;
          const stn1Detention = i > 0 ? departAttempt[i] - waitStartedAt[i] : 0;
          const stn1IsActualStop = i > 0 && (stn1Halt > 0 || stn1Detention > 0);

          if ((i === 0 || stn1IsActualStop) && accelPenaltyMins > 0) {
            accelMins = accelPenaltyMins;
          }

          // Deceleration logic:
          // - Always apply for the last segment (i === n - 2, arriving at final destination).
          // - Apply when arriving at any intermediate actual stop (planned halt > 0).
          const stn2Halt = simStopsMap.has(block.stn2.code) ? simStopsMap.get(block.stn2.code) : 0;
          const stn2IsActualStop = i < n - 2 && (stn2Halt > 0 || detainedStations.has(block.stn2.code));

          if ((i === n - 2 || stn2IsActualStop) && decelPenaltyMins > 0) {
            decelMins = decelPenaltyMins;
          }

          let runTime;
          if (spd > 0) {
            const vKmMin = spd / 60;
            const dAccel = (vKmMin / 2) * accelMins;
            const dDecel = (vKmMin / 2) * decelMins;

            if (block.dist >= dAccel + dDecel) {
              const dCruise = block.dist - dAccel - dDecel;
              const tCruise = dCruise / vKmMin;
              runTime = accelMins + tCruise + decelMins;
            } else {
              // Not enough distance to reach full speed. Calculate based on peak speed reached.
              const invA = accelMins > 0 ? (accelMins / vKmMin) : 0;
              const invD = decelMins > 0 ? (decelMins / vKmMin) : 0;
              runTime = Math.sqrt(2 * block.dist * (invA + invD));
            }
          } else {
            runTime = 10;
          }



          const testArr = depTime + runTime;
          diagnostics.blockConflictChecks++;

          // 6. UPDATE countOverlapsFast()
          const { sameDirOverlaps, oppDirOverlaps, headwayViolation, automaticSeparationViolation, confTrainId, confTrainDir } = countOverlapsFast(blockInfo, depTime, testArr, localScheduled);

          let blockConflict = false;
          let conflictReason = null;

          // 7. UPDATE attemptPathFromTime() & 4. ABSOLUTE SIGNALLING & 5. AUTOMATIC SIGNALLING
          if (blockInfo.signalling === 'AB') {
            // Absolute: Strict physical occupancy + headway
            if (headwayViolation) {
              blockConflict = true;
              conflictReason = 'HEADWAY_VIOLATION';
            } else if ((sameDirOverlaps + oppDirOverlaps) >= block.capacity) {
              blockConflict = true;
              conflictReason = 'PHYSICAL_OCCUPANCY_CONFLICT';
            }
          } else if (blockInfo.signalling === 'AUTO') {
            // Automatic: Physical block capacity is relaxed based on separation rules for SAME-DIRECTION ONLY.
            // Opposite direction physical block capacity must be strictly maintained (head-on collision prevention).
            if (oppDirOverlaps >= block.capacity) {
              blockConflict = true;
              conflictReason = 'OPPOSITE_DIRECTION_PHYSICAL_CONFLICT';
            } else if (automaticSeparationViolation) {
              blockConflict = true;
              conflictReason = 'AUTOMATIC_SEPARATION_VIOLATION';
            }
          } else {
            // Fallback (treat as Absolute)
            if (headwayViolation || (sameDirOverlaps + oppDirOverlaps) >= block.capacity) {
              blockConflict = true;
              conflictReason = 'FALLBACK_CONFLICT';
            }
          }

          if (blockConflict) {
            blockConflictFound = true;
            continue;
          }

          const nextHalt = simStopsMap.has(block.stn2.code) ? simStopsMap.get(block.stn2.code) : 0;
          const nextRes = checkCandidateStationLine(block.stn2.code, testArr, testArr + nextHalt, reqDir, reqTrainId);
          if (nextRes.conflict) {
            stationConflictFound = true;
            continue;
          }
          assignedSpeed = spd;
          finalArrTime = testArr;
          hopResult.currentEndLineId = nextRes.assignedLineId;
          break;
        }

        if (!conflictReasons[i]) {
          conflictReasons[i] = new Set();
        }

        if (assignedSpeed === null) {
          if (blockConflictFound) conflictReasons[i].add('BLOCK_CONFLICT');
          if (stationConflictFound) conflictReasons[i].add('STATION_CONFLICT');

          departAttempt[i] += 1;
          if (i > 0) totalWaitMins += 1;
          const waitedHere = departAttempt[i] - waitStartedAt[i];

          // BACKTRACK LOGIC FOR UNEXPECTED DETENTION DECELERATION:
          // If we just got detained (waitedHere === 1) at a pass-through station (halt === 0),
          // we must backtrack to the previous hop so it can recalculate its runTime WITH deceleration.
          const stn1Halt = simStopsMap.has(block.stn1.code) ? simStopsMap.get(block.stn1.code) : 0;
          if (waitedHere === 1 && stn1Halt === 0 && i > 0 && !detainedStations.has(block.stn1.code)) {
            detainedStations.add(block.stn1.code);
            diagnostics.backtrackCount++;
            for (let k = i; k < n; k++) {
              departAttempt[k] = null;
              waitStartedAt[k] = null;
              if (k >= i) arrivalAt[k] = null;
            }
            for (let k = i - 1; k < n - 1; k++) {
              hopResult[k] = null;
              conflictReasons[k] = null;
            }
            i -= 1;
            continue; // Re-evaluate i-1, now stn2IsActualStop will be true
          }

          if (waitedHere > maxDetentionMins) {
            diagnostics.backtrackCount++;

            for (let k = i; k < n; k++) {
              departAttempt[k] = null;
              waitStartedAt[k] = null;
              if (k > i) arrivalAt[k] = null;
            }
            for (let k = i; k < n - 1; k++) {
              hopResult[k] = null;
              conflictReasons[k] = null;
            }

            i -= 1;
            if (i >= 0) {
              departAttempt[i] += 1;
              detentionCount++;
            }
          }

          if (i >= 0) {
            const stateKey = `${i}|${departAttempt[i]}`;
            if (visited.has(stateKey)) return null;
            visited.add(stateKey);
          }

          continue;
        }

        const detentionMins = i === 0 ? 0 : departAttempt[i] - waitStartedAt[i];
        let finalReason = 'NONE';
        if (detentionMins > 0 && conflictReasons[i].size > 0) {
          finalReason = Array.from(conflictReasons[i]).join('+');
        }

        hopResult[i] = {
          startStn: block.stn1.code,
          endStn: block.stn2.code,
          startLineId: i === 0 ? originLineId : hopResult[i - 1].endLineId,
          endLineId: hopResult.currentEndLineId,
          arrivalTime: i === 0 ? depTime : arrivalAt[i],
          normalHalt: halt,
          earliestDeparture: i === 0 ? depTime : waitStartedAt[i],
          actualDeparture: depTime,
          detentionMinutes: detentionMins,
          detentionReason: finalReason,
          startMins: depTime,
          endMins: finalArrTime,
          speed: assignedSpeed
        };
        arrivalAt[i + 1] = finalArrTime;
        departAttempt[i + 1] = null;
        i += 1;
        break;
      }
    }
  };

  const buildBlockData = stations => {
    const blockData = [];
    for (let i = 0; i < stations.length - 1; i++) {
      const stn1 = stations[i];
      const stn2 = stations[i + 1];
      const blockCode = getBlockCodeBetween(layout, stn1.code, stn2.code);
      if (!blockCode) {
        console.error(`Missing block section between ${stn1.code} and ${stn2.code}`);
        return null;
      }
      let dist = 0;
      let capacity = 1;
      let numPhysicalLines = 1;
      let inBlock = false;
      // Normalize to layout order for scanning (sequence is always forward)
      const layoutOrder1 = stationOrderMap[stn1.code];
      const layoutOrder2 = stationOrderMap[stn2.code];
      const scanFirst = layoutOrder1 < layoutOrder2 ? stn1.code : stn2.code;
      const scanSecond = layoutOrder1 < layoutOrder2 ? stn2.code : stn1.code;
      let isAuto = false;
      for (let node of layout.sequence) {
        if (node.type === 'station') {
          if (node.code === scanFirst) inBlock = true;
          else if (node.code === scanSecond) { inBlock = false; break; }
        } else if (node.type === 'block' && inBlock && node.code === blockCode) {
          dist += parseFloat(node.distance) || 0;
          if (layout.blockSections && layout.blockSections[node.code] && layout.blockSections[node.code].lines) {
            const lines = layout.blockSections[node.code].lines;
            numPhysicalLines = Math.max(numPhysicalLines, lines.length);
            lines.forEach(l => {
              const sig = String(l.MAVSIGNALLING || '').trim().toUpperCase();
              if (sig === 'AUTO') isAuto = true;
            });
          }
        }
      }

      // 1. REMOVE ARBITRARY CAPACITY FORMULA
      // Physical capacity per track direction is 1. Double line opposite is handled separately.
      capacity = 1;

      if (dist === 0) {
        console.error(`Block section ${blockCode} has 0 distance or not found in sequence between ${stn1.code} and ${stn2.code}`);
        return null;
      }
      blockData.push({
        stn1,
        stn2,
        dist,
        capacity,
        numPhysicalLines,
        blockCode,
        signalling: isAuto ? 'AUTO' : 'AB'
      });
    }
    return blockData;
  };

  const buildBlockInfos = blockData => blockData.map(block => buildBlockInfo(block.stn1.code, block.stn2.code, block.numPhysicalLines >= 2, block.signalling));

  const formatSimulatedPath = (path, stations, isFwd, pathPrefix, totalWaitMins, detentionCount, currentPathsCount) => {
    const stops = [];
    const DAY_ABBR = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const getDay = mins => Math.floor((mins - startDayIdx * 24 * 60) / (24 * 60)) + 1;
    const getWeekDay = mins => simDay === 'All' ? 'Daily' : DAY_ABBR[(startDayIdx + getDay(mins) - 1) % 7];
    path.forEach((seg, idx) => {
      if (idx === 0) {
        stops.push({
          seq: 1, zone: '-', division: '-', station: seg.startStn,
          arrTime: (seg.arrivalTime - startDayIdx * 24 * 60) / 60,
          depTime: (seg.actualDeparture - startDayIdx * 24 * 60) / 60,
          absArrMins: seg.arrivalTime,
          absDepMins: seg.actualDeparture,
          arrStr: 'Origin', depStr: formatTimeMins(seg.actualDeparture),
          dayOfSrvc: getDay(seg.arrivalTime), weekDay: getWeekDay(seg.arrivalTime),
          y: stations.find(s => s.code === seg.startStn)?.y || 0,
          normalHalt: seg.normalHalt, detentionMinutes: seg.detentionMinutes, detentionReason: seg.detentionReason,
          stationLineId: seg.startLineId
        });
      }
      const arrMins = seg.endMins;
      let depMins, detentionMins = 0, dReason = 'NONE', haltMins = 0;
      let isDestination = false;
      if (idx === path.length - 1) {
        depMins = arrMins;
        isDestination = true;
      } else {
        depMins = path[idx + 1].actualDeparture;
        detentionMins = path[idx + 1].detentionMinutes;
        dReason = path[idx + 1].detentionReason;
        haltMins = path[idx + 1].normalHalt;
      }
      stops.push({
        seq: idx + 2, zone: '-', division: '-', station: seg.endStn,
        arrTime: (arrMins - startDayIdx * 24 * 60) / 60, depTime: (depMins - startDayIdx * 24 * 60) / 60,
        absArrMins: arrMins, absDepMins: depMins,
        arrStr: formatTimeMins(arrMins), depStr: isDestination ? 'Destination' : formatTimeMins(depMins),
        dayOfSrvc: getDay(arrMins), weekDay: getWeekDay(arrMins),
        y: stations.find(s => s.code === seg.endStn)?.y || 0,
        normalHalt: haltMins, detentionMinutes: detentionMins, detentionReason: dReason,
        stationLineId: seg.endLineId
      });
    });
    let daysStr = '1111111';
    if (simDay === 'Mon') daysStr = '1000000';
    else if (simDay === 'Tue') daysStr = '0100000';
    else if (simDay === 'Wed') daysStr = '0010000';
    else if (simDay === 'Thu') daysStr = '0001000';
    else if (simDay === 'Fri') daysStr = '0000100';
    else if (simDay === 'Sat') daysStr = '0000010';
    else if (simDay === 'Sun') daysStr = '0000001';
    else if (simDay === 'Week') daysStr = '1111100';
    const simCount = currentPathsCount + 1;
    const dirPrefix = isFwd ? 'DN' : 'UP';
    return {
      trainNo: `SIM-${Date.now()}-${pathPrefix}-${dirPrefix}${simCount}`,
      name: `${dirPrefix}${simCount}`,
      color: '#16a34a',
      stops: stops,
      isForward: isFwd,
      daysOfSrvc: daysStr,
      isSimulated: true,
      totalDetention: totalWaitMins,
      detentionCount: detentionCount,
      stationCodes: stops.map(s => s.station)
    };
  };

  // ─── Source → Destination slicing ──────────────────────────────────────────
  const srcIdx = layoutStations.findIndex(s => s.code === simSource);
  const dstIdx = layoutStations.findIndex(s => s.code === simDest);
  if (srcIdx === -1 || dstIdx === -1 || srcIdx === dstIdx) {
    console.error('runSimulation: invalid simSource/simDest', simSource, simDest);
    return [];
  }
  const fwdStart = Math.min(srcIdx, dstIdx);
  const fwdEnd = Math.max(srcIdx, dstIdx);
  const fwdStationsBase = layoutStations.slice(fwdStart, fwdEnd + 1);
  const bwdStationsBase = [...fwdStationsBase].reverse();
  const userWantsFwd = srcIdx <= dstIdx;

  const fwdStations = userWantsFwd ? fwdStationsBase : bwdStationsBase;
  const bwdStations = userWantsFwd ? bwdStationsBase : fwdStationsBase;

  let fwdBlockData = null, fwdBlockInfos = null;
  let bwdBlockData = null, bwdBlockInfos = null;
  let tryStartMinsFwd = Infinity;
  let tryStartMinsBwd = Infinity;
  let activeFwd = false;
  let activeBwd = false;

  if (simDirections.includes('forward')) {
    fwdBlockData = buildBlockData(fwdStations);
    if (fwdBlockData) {
      fwdBlockInfos = buildBlockInfos(fwdBlockData);
      tryStartMinsFwd = fromMins;
      activeFwd = true;
    }
  }

  if (simDirections.includes('backward')) {
    bwdBlockData = buildBlockData(bwdStations);
    if (bwdBlockData) {
      bwdBlockInfos = buildBlockInfos(bwdBlockData);
      tryStartMinsBwd = fromMins;
      activeBwd = true;
    }
  }

  const localScheduled = [];
  const foundPaths = [];
  let iterCount = 0;
  let nextDirection = 'fwd';
  const startTimeMs = performance.now();
  const maxMs = 2 * 60 * 1000;

  while ((activeFwd && tryStartMinsFwd <= uptoMins) || (activeBwd && tryStartMinsBwd <= uptoMins)) {
    if (abort.current) break;
    if (++iterCount % 5 === 0) await new Promise(r => setTimeout(r, 0));
    if (debug && (performance.now() - startTimeMs) > maxMs) {
      console.warn('Simulation time budget exceeded');
      break;
    }

    let tryFwd = false;
    if (activeFwd && !activeBwd) {
      tryFwd = true;
    } else if (!activeFwd && activeBwd) {
      tryFwd = false;
    } else if (activeFwd && activeBwd) {
      if (tryStartMinsFwd > uptoMins && tryStartMinsBwd <= uptoMins) {
        tryFwd = false;
      } else if (tryStartMinsBwd > uptoMins && tryStartMinsFwd <= uptoMins) {
        tryFwd = true;
      } else {
        tryFwd = (nextDirection === 'fwd');
      }
    }

    diagnostics.attemptCount++;

    const currentPathsCount = simulatedPaths.length + foundPaths.length;
    const reqTrainId = `SIM_ATTEMPT_${currentPathsCount + 1}_${tryFwd ? 'FWD' : 'BWD'}_${iterCount}`;

    let result, pathStations, isFwdAttempt, pathPrefix;
    if (tryFwd) {
      result = await attemptPathFromTime(fwdStations, fwdBlockData, fwdBlockInfos, tryStartMinsFwd, localScheduled, reqTrainId);
      pathStations = fwdStations;
      isFwdAttempt = userWantsFwd;
      pathPrefix = 'F';
    } else {
      result = await attemptPathFromTime(bwdStations, bwdBlockData, bwdBlockInfos, tryStartMinsBwd, localScheduled, reqTrainId);
      pathStations = bwdStations;
      isFwdAttempt = !userWantsFwd;
      pathPrefix = 'B';
    }

    if (abort.current) break;

    const path = result ? result.path : [];
    const totalWaitMins = result ? result.totalWaitMins : 0;
    const detentionCount = result ? result.detentionCount : 0;
    const currTime = path.length > 0 ? path[path.length - 1].endMins : (tryFwd ? tryStartMinsFwd : tryStartMinsBwd);
    const withinCompletion = completionMins !== null ? (currTime <= completionMins) : true;
    const pathValid = !!result && path.length === pathStations.length - 1 && withinCompletion;

    if (pathValid && path.length > 0) {
      const currentPathsCount = simulatedPaths.length + foundPaths.length;
      const newPath = formatSimulatedPath(path, pathStations, isFwdAttempt, pathPrefix, totalWaitMins, detentionCount, currentPathsCount);
      foundPaths.push(newPath);
      localScheduled.push(newPath);

      // Update persistent allocations with the newly accepted path so future candidates see it
      const tId = newPath.trainNo;
      const tDir = newPath.isForward ? 'DOWN' : 'UP';
      for (const stop of newPath.stops) {
        if (stop.stationLineId) {
          const allocations = initAllocations(stop.station);
          const newAlloc = { lineId: stop.stationLineId, tId, tDir, tStart: stop.absArrMins, tEnd: stop.absDepMins, daysBits: null, overflow: false };

          for (const a of allocations) {
            if (a.lineId !== newAlloc.lineId) continue;

            for (let day = 0; day < 7; day++) {
              if (a.daysBits && a.daysBits.length === 7 && a.daysBits[day] !== '1') continue;
              const aStart = a.tStart + (a.daysBits ? day * 1440 : 0);
              const aEnd = a.tEnd + (a.daysBits ? day * 1440 : 0);

            }
          }

          allocations.push(newAlloc);
        }
      }

      if (tryFwd) {
        tryStartMinsFwd = path[0].startMins + hwMargin;
        nextDirection = 'bwd';
      } else {
        tryStartMinsBwd = path[0].startMins + hwMargin;
        nextDirection = 'fwd';
      }
    } else {
      if (result && path.length === pathStations.length - 1 && !withinCompletion) {
        if (tryFwd) tryStartMinsFwd = Infinity;
        else tryStartMinsBwd = Infinity;
      } else {
        if (tryFwd) tryStartMinsFwd += hwMargin;
        else tryStartMinsBwd += hwMargin;
      }
    }
  }

  if (debug) {
    console.log('--- SIMULATOR FINAL DIAGNOSTICS ---');
    console.log('[113 TRAIN INVESTIGATION]', {
      totalScheduled: foundPaths.length,
      stationConflictChecks: diagnostics.stationConflictChecks,
      stationCapacityFailures: diagnostics.stationCapacityFailures || 0,
      blockConflictChecks: diagnostics.blockConflictChecks
    });

    const summaryReports = [];
    let totalSameLineOverlapCount = 0;

    for (const stn of Object.keys(globalStationAllocations)) {
      const allocations = globalStationAllocations[stn] || [];
      const stnLines = stationLineDirs[stn] || {};
      const physicalLinesArr = (layout && layout.stations && layout.stations[stn] && layout.stations[stn].lines) ? layout.stations[stn].lines : [];
      const physicalLineCount = physicalLinesArr.length;
      const schedulerLineCount = Object.keys(stnLines).length;

      if (schedulerLineCount !== physicalLineCount) {
        console.log('[STATION LINE COUNT MISMATCH]', {
          station: stn,
          physicalLineCount,
          schedulerLineCount,
          schedulerLines: Object.keys(stnLines),
          physicalLines: physicalLinesArr.map(l => ({
            seq: l.MANSEQNUMB,
            line: l.MAVLINENUMB,
            category: l.MACLINECATEGORY
          }))
        });
      }

      let maxOccupancy = 0;
      let maxInterval = null;
      let maxTrains = [];
      let sameLineOverlapCount = 0;

      for (const a of allocations) {
        // Check for each day in a 7-day period to find absolute max
        for (let day = 0; day < 7; day++) {
          if (a.daysBits && a.daysBits.length === 7 && a.daysBits[day] !== '1') continue;

          const t = a.tStart + (a.daysBits ? day * 1440 : 0);

          let currentOverlapping = [];
          let overlapDict = {};
          let trainsAtT = [];

          for (const b of allocations) {
            if (b.daysBits && b.daysBits.length === 7 && b.daysBits[day] !== '1') continue;

            const bStart = b.tStart + (b.daysBits ? day * 1440 : 0);
            const bEnd = b.tEnd + (b.daysBits ? day * 1440 : 0);

            if (bStart <= t && t < (bEnd + STATION_SAFETY_MARGIN)) {
              const tr = {
                trainId: b.tId,
                lineId: b.lineId,
                direction: b.tDir,
                start: bStart,
                end: bEnd,
                daysBits: b.daysBits
              };
              currentOverlapping.push(tr);
              trainsAtT.push(tr);
              overlapDict[b.lineId] = (overlapDict[b.lineId] || 0) + 1;
            }
          }

          let hasSameLineOverlap = false;
          for (const l in overlapDict) {
            if (overlapDict[l] > 1) {
              hasSameLineOverlap = true;
              sameLineOverlapCount++;


            }
          }

          if (currentOverlapping.length > maxOccupancy) {
            maxOccupancy = currentOverlapping.length;
            maxTrains = currentOverlapping;
            maxInterval = t;
          }
        }
      }

      const report = {
        station: stn,
        physicalLineCount,
        schedulerLineCount,
        maxSimultaneousOccupancy: maxOccupancy,
        capacityExceeded: maxOccupancy > physicalLineCount,
        sameLineOverlapCount,
        maxInterval,
        maxTrains
      };

      summaryReports.push(report);
      totalSameLineOverlapCount += sameLineOverlapCount;

      console.log('[FINAL STATION CAPACITY SUMMARY]', JSON.stringify(report, null, 2));
    }

    console.log('[FINAL STATION ALLOCATIONS]', JSON.stringify(globalStationAllocations, null, 2));

    console.log('[FINAL STATION CAPACITY RESULT]', JSON.stringify({
      acceptedTrains: foundPaths.length,
      stationConflicts: diagnostics.stationConflictChecks,
      illegalOverlaps: totalSameLineOverlapCount,
      capacityViolations: summaryReports.filter(r => r.capacityExceeded).length
    }, null, 2));

    console.log({
      candidatesEvaluated: iterCount,
      pathsAccepted: foundPaths.length,
      blockConflicts: diagnostics.blockConflictChecks,
      stationConflicts: diagnostics.stationConflictChecks,
      backtracks: diagnostics.backtrackCount,
      stopReason: abort.current ? 'Simulation aborted' : 'Window exhausted'
    });
    console.log('Simulation diagnostics:', diagnostics);
    return { paths: foundPaths, diagnostics };
  }

  return foundPaths;
}
