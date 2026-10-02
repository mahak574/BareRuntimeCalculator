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
  simSource,
  simDest,
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
  simBlockCorridor,
  simBlockOperatingTime,
  simStops,
  simDirections,
  abortSimRef,
  simulatedPaths = [],
  debug = false
}) {
  const formatTimeMins = mins => {
    const totalSecs = Math.round(mins * 60);
    const h = Math.floor((totalSecs % (24 * 3600)) / 3600);
    const m = Math.floor((totalSecs % 3600) / 60);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
  };

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

  const abort = abortSimRef;
  abort.current = false;
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
  const speedLimit = (simSpeed === 'goods' || simSpeed === 'coaching' || !simSpeed) ? null : parseFloat(simSpeed);
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
  const blockOpTime = simBlockOperatingTime ? parseTimeInput(simBlockOperatingTime) : 0;
  const STATION_SAFETY_MARGIN = 5;

  const simStopsMap = new Map(simStops.map(s => [s.code, s.halt]));

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

  // Pre-index: stationCode -> [{train, stopIdx}] for fast buildBlockInfo lookup
  const stationStopIndex = new Map();
  const fixedTrainsBase = [...canonicalTrains, ...simulatedPaths];
  const canonicalSet = new Set(canonicalTrains);
  for (const train of fixedTrainsBase) {
    if (!train.stops || train.stops.length < 2) continue;
    for (let i = 0; i < train.stops.length; i++) {
      const code = train.stops[i].station;
      if (!stationStopIndex.has(code)) stationStopIndex.set(code, []);
      stationStopIndex.get(code).push({ train, stopIdx: i });
    }
  }

  const buildBlockInfo = (stn1Code, stn2Code, isDoubleLine, signalling = 'AB') => {
    const o1 = stationOrderMap[stn1Code];
    const o2 = stationOrderMap[stn2Code];
    const simFwd = o2 > o1;
    const matchedCandidates = [];

    // Use pre-index: find trains that pass through stn1Code, then check if next/prev stop is stn2Code
    const stn1Entries = stationStopIndex.get(stn1Code) || [];
    for (const { train, stopIdx } of stn1Entries) {
      const isSimulated = !canonicalSet.has(train);
      if (isSimulated) {
        // Check stn1 -> stn2
        if (stopIdx + 1 < train.stops.length && train.stops[stopIdx + 1].station === stn2Code) {
          if (!isDoubleLine) { // both dirs
            const pStp = train.stops[stopIdx];
            const cStp = train.stops[stopIdx + 1];
            matchedCandidates.push({
              isSimulated: true,
              segDepBase: pStp.absDepMins !== undefined ? pStp.absDepMins : (pStp.depTime * 60),
              segArrBase: cStp.absArrMins !== undefined ? cStp.absArrMins : (cStp.arrTime * 60),
              isSameDir: true,
              daysBits: null
            });
          } else {
            const pStp = train.stops[stopIdx];
            const cStp = train.stops[stopIdx + 1];
            matchedCandidates.push({
              isSimulated: true,
              segDepBase: pStp.absDepMins !== undefined ? pStp.absDepMins : (pStp.depTime * 60),
              segArrBase: cStp.absArrMins !== undefined ? cStp.absArrMins : (cStp.arrTime * 60),
              isSameDir: true,
              daysBits: null
            });
          }
        }
        // Check stn2 -> stn1 (opposite direction)
        if (!isDoubleLine && stopIdx + 1 < train.stops.length && train.stops[stopIdx].station === stn1Code) {
          // already covered above
        }
      } else {
        // canonical train: check if segment pStp->cStp covers block
        if (stopIdx + 1 < train.stops.length) {
          const pStp = train.stops[stopIdx];
          const cStp = train.stops[stopIdx + 1];
          const bothIn = stationBetween(stn1Code, pStp.station, cStp.station) && stationBetween(stn2Code, pStp.station, cStp.station);
          if (bothIn) {
            const oA = stationOrderMap[pStp.station];
            const oB = stationOrderMap[cStp.station];
            const realFwd = oB > oA;
            const isSameDir = realFwd === simFwd;
            const isOppDir = !isSameDir;
            if (isDoubleLine && isOppDir) continue;
            matchedCandidates.push({
              isSimulated: false,
              segDepBase: pStp.depTime * 60,
              segArrBase: cStp.arrTime * 60,
              isSameDir,
              daysBits: train.daysOfSrvc ? String(train.daysOfSrvc).replace(/[^01]/g, '') : null
            });
          }
        }
      }
    }

    // Also check trains passing through stn2Code in opposite direction (stn2->stn1 for simulated)
    if (!isDoubleLine) {
      const stn2Entries = stationStopIndex.get(stn2Code) || [];
      for (const { train, stopIdx } of stn2Entries) {
        const isSimulated = !canonicalSet.has(train);
        if (isSimulated && stopIdx + 1 < train.stops.length && train.stops[stopIdx + 1].station === stn1Code) {
          const pStp = train.stops[stopIdx];
          const cStp = train.stops[stopIdx + 1];
          matchedCandidates.push({
            isSimulated: true,
            segDepBase: pStp.absDepMins !== undefined ? pStp.absDepMins : (pStp.depTime * 60),
            segArrBase: cStp.absArrMins !== undefined ? cStp.absArrMins : (cStp.arrTime * 60),
            isSameDir: false,
            daysBits: null
          });
        }
      }
    }

    // stn2Candidates for conflict counting at station
    const stn2Candidates = [];
    const stn2Entries2 = stationStopIndex.get(stn2Code) || [];
    for (const { train, stopIdx } of stn2Entries2) {
      const isSimulated = !canonicalSet.has(train);
      const stop = train.stops[stopIdx];
      stn2Candidates.push({
        isSimulated,
        arrBase: (isSimulated && stop.absArrMins !== undefined) ? stop.absArrMins : (stop.arrTime * 60),
        depBase: (isSimulated && stop.absDepMins !== undefined) ? stop.absDepMins : (stop.depTime * 60),
        daysBits: (!isSimulated && train.daysOfSrvc) ? String(train.daysOfSrvc).replace(/[^01]/g, '') : null
      });
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

  const countOverlapsFast = (blockInfo, depMins, arrMins, extraScheduled, capacity = 1) => {
    let sameDirOverlaps = 0;
    let oppDirOverlaps = 0;
    let headwayViolation = false;
    let blockOpTimeViolation = false;
    let autoConflict = false;
    let confTrainId = null;
    let confTrainDir = null;

    const currentDayIdx = Math.floor(depMins / 1440);

    for (const cand of blockInfo.matchedCandidates) {
      let segDep, segArr;
      if (!cand.isSimulated) {
        if (simDay === 'All') {
          const baseK = Math.floor(cand.segDepBase / 1440);
          segDep = (cand.segDepBase - baseK * 1440) + currentDayIdx * 1440;
          segArr = (cand.segArrBase - baseK * 1440) + currentDayIdx * 1440;

          if (segDep - depMins > 720) {
            segDep -= 1440;
            segArr -= 1440;
          } else if (depMins - segArr > 720) {
            segDep += 1440;
            segArr += 1440;
          }
        } else {
          if (cand.daysBits && cand.daysBits.length === 7 && cand.daysBits[currentDayIdx % 7] !== '1') continue;
          let dayOffset = currentDayIdx * 1440;
          segDep = cand.segDepBase + dayOffset;
          segArr = cand.segArrBase + dayOffset;
        }
      } else {
        segDep = cand.segDepBase;
        segArr = cand.segArrBase;
      }

      if (cand.isSameDir) {
        if (blockInfo.signalling === 'AUTO') {
          const C = Math.max(1, capacity);
          for (let k = 0; k < C; k++) {
            const aIn = segDep + k * (segArr - segDep) / C;
            const aOut = segDep + (k + 1) * (segArr - segDep) / C;
            const bIn = depMins + k * (arrMins - depMins) / C;
            const bOut = depMins + (k + 1) * (arrMins - depMins) / C;

            if (aIn < bOut && aOut > bIn) {
              autoConflict = true;
            }
            if (aOut <= bIn && bIn < aOut + blockOpTime) {
              autoConflict = true;
            }
            if (bOut <= aIn && aIn < bOut + blockOpTime) {
              autoConflict = true;
            }
          }
        } else {
          if (Math.abs(segDep - depMins) < hwMargin) headwayViolation = true;
          if (Math.abs(segArr - arrMins) < hwMargin) headwayViolation = true;
          if ((segDep < depMins && segArr > arrMins) || (segDep > depMins && segArr < arrMins)) headwayViolation = true;

          if (segArr <= depMins && depMins < segArr + blockOpTime) blockOpTimeViolation = true;
        }
      }

      if (segDep < arrMins && segArr > depMins) {
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
            if (blockInfo.signalling === 'AUTO') {
              const C = Math.max(1, capacity);
              for (let k = 0; k < C; k++) {
                const aIn = segDep + k * (segArr - segDep) / C;
                const aOut = segDep + (k + 1) * (segArr - segDep) / C;
                const bIn = depMins + k * (arrMins - depMins) / C;
                const bOut = depMins + (k + 1) * (arrMins - depMins) / C;

                if (aIn < bOut && aOut > bIn) {
                  autoConflict = true;
                }
                if (aOut <= bIn && bIn < aOut + blockOpTime) {
                  autoConflict = true;
                }
                if (bOut <= aIn && aIn < bOut + blockOpTime) {
                  autoConflict = true;
                }
              }
            } else {
              if (Math.abs(segDep - depMins) < hwMargin) headwayViolation = true;
              if (Math.abs(segArr - arrMins) < hwMargin) headwayViolation = true;
              if ((segDep < depMins && segArr > arrMins) || (segDep > depMins && segArr < arrMins)) headwayViolation = true;

              if (segArr <= depMins && depMins < segArr + blockOpTime) blockOpTimeViolation = true;
            }
          }

          if (segDep < arrMins && segArr > depMins) {
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

    if (autoConflict && !confTrainId) {
      confTrainId = 'auto_conflict_train';
      confTrainDir = 'SAME';
    }

    return { sameDirOverlaps, oppDirOverlaps, headwayViolation, blockOpTimeViolation, autoConflict, confTrainId, confTrainDir };
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
      let aStart = int.start;
      let aEnd = int.end;

      if (simDay === 'All' && alloc.daysBits) {
        const baseK = Math.floor(aStart / 1440);
        const currentDayIdx = Math.floor(reqStart / 1440);
        aStart = (aStart - baseK * 1440) + currentDayIdx * 1440;
        aEnd = (aEnd - baseK * 1440) + currentDayIdx * 1440;

        if (aStart - reqStart > 720) {
          aStart -= 1440;
          aEnd -= 1440;
        } else if (reqStart - aEnd > 720) {
          aStart += 1440;
          aEnd += 1440;
        }
      }

      if (aStart < reqEnd && reqStart < (aEnd + safetyMargin)) {
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
        return aBoth - bBoth;
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
      // Console debug removed to stop spam
      const forcedLineId = compatibleLines.length > 0 ? compatibleLines[0].lineId : 'UNKNOWN';
      allocations.push({ lineId: forcedLineId, tId, tDir, tStart, tEnd, daysBits, overflow: true });
      return forcedLineId;
    }
  };

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
      if (iter % 50000 === 0) await new Promise(r => setTimeout(r, 0));
      if (iter > 10000000) return null;
      if (i < 0) return null;
      if (i >= n - 1) {
        const path = [];
        for (let k = 0; k < n - 1; k++) {
          path.push(hopResult[k]);
        }
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
        let currentEndLineId = null;
        let blockConflictFound = false;
        let stationConflictFound = false;

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
          if (i === 0) {
            return null;
          }
          for (let k = i; k < n; k++) {
            departAttempt[k] = null;
            waitStartedAt[k] = null;
            if (k > i) arrivalAt[k] = null;
            if (k >= i && blockData[k]) {
              detainedStations.delete(blockData[k].stn1.code);
              detainedStations.delete(blockData[k].stn2.code);
            }
          }
          for (let k = i - 1; k < n - 1; k++) {
            hopResult[k] = null;
            if (conflictReasons[k]) conflictReasons[k] = null;
          }
          i -= 1;
          departAttempt[i] += 1;
          detentionCount++;
          break;
        }

        const depTime = departAttempt[i];

        let stnSpeeds = speedLimit ? [speedLimit] : cachedGetStationSpeeds(block.stn1.code);

        if (simSpeed === 'goods' || simSpeed === 'coaching' || !simSpeed) {
          const dirKey = reqDir === 'DOWN' ? 'forward' : 'backward';
          const secCode = block.blockCode;
          const loadType = (simSpeed === 'coaching' || !simSpeed) ? 'COACHING' : (simTrainLoadType || 'LOADED');
          const ovrKey = `${dirKey}_${secCode}_${loadType}`;
          const override = goodsSpeedOverrides && goodsSpeedOverrides[ovrKey];
          let foundSpeed = null;
          let foundRuntime = null;
          let defRuntime = null;

          if (goodsSpeedConfig && goodsSpeedConfig[dirKey] && goodsSpeedConfig[dirKey][secCode] && goodsSpeedConfig[dirKey][secCode][loadType]) {
            const stats = goodsSpeedConfig[dirKey][secCode][loadType];
            if (stats.defaultRuntime > 0) {
              defRuntime = stats.defaultRuntime;
            }
          }

          const parseTime = (val) => {
            if (typeof val === 'string' && val.includes(':')) {
              const [m, s] = val.split(':');
              return parseInt(m || 0, 10) + parseInt(s || 0, 10) / 60;
            }
            return parseFloat(val);
          };

          const parsedOverride = override ? parseTime(override) : NaN;

          if (!isNaN(parsedOverride) && parsedOverride > 0) {
            foundRuntime = parsedOverride;
          } else if (defRuntime) {
            foundRuntime = defRuntime;
          }

          if (foundRuntime && block.dist > 0) {
            // runtime is in minutes, block.dist in km.
            // speed (km/h) = (dist / runtime) * 60
            foundSpeed = (block.dist / foundRuntime) * 60;
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


          const stn1Halt = simStopsMap.has(block.stn1.code) ? simStopsMap.get(block.stn1.code) : 0;
          const stn1IsActualStop = i > 0 && (stn1Halt > 0 || departAttempt[i] > waitStartedAt[i] || detainedStations.has(block.stn1.code));

          if ((i === 0 || stn1IsActualStop) && accelPenaltyMins > 0) {
            accelMins = accelPenaltyMins;
          }

          const stn2Halt = simStopsMap.has(block.stn2.code) ? simStopsMap.get(block.stn2.code) : 0;
          const stn2IsActualStop = i < n - 2 && (stn2Halt > 0 || detainedStations.has(block.stn2.code));

          if ((i === n - 2 || stn2IsActualStop) && decelPenaltyMins > 0) {
            decelMins = decelPenaltyMins;
          }

          let runTime;
          if (spd > 0) {
            const vKmMin = spd / 60;
            const baseRunTime = block.dist / vKmMin;
            runTime = Math.round(baseRunTime + accelMins + decelMins);
          } else {
            runTime = 10;
          }



          const testArr = depTime + runTime;
          diagnostics.blockConflictChecks++;

          const { sameDirOverlaps, oppDirOverlaps, headwayViolation, blockOpTimeViolation, autoConflict, confTrainId, confTrainDir } = countOverlapsFast(blockInfo, depTime, testArr, localScheduled, block.capacity);

          let blockConflict = false;
          let conflictReason = null;

          if (blockInfo.signalling === 'AB') {
            if (headwayViolation) {
              blockConflict = true;
              conflictReason = 'HEADWAY_VIOLATION';
            } else if ((sameDirOverlaps + oppDirOverlaps) >= 1) {
              blockConflict = true;
              conflictReason = 'PHYSICAL_OCCUPANCY_CONFLICT';
            } else if (blockOpTimeViolation) {
              blockConflict = true;
              conflictReason = 'BLOCK_OP_TIME_VIOLATION';
            }
          } else if (blockInfo.signalling === 'AUTO') {

            if (oppDirOverlaps >= 1) {
              blockConflict = true;
              conflictReason = 'OPPOSITE_DIRECTION_PHYSICAL_CONFLICT';
            } else if (autoConflict) {
              blockConflict = true;
              conflictReason = 'AUTO_SUBBLOCK_CONFLICT';
            }
          } else {
            if (headwayViolation || (sameDirOverlaps + oppDirOverlaps) >= 1) {
              blockConflict = true;
              conflictReason = 'FALLBACK_CONFLICT';
            } else if (blockOpTimeViolation) {
              blockConflict = true;
              conflictReason = 'BLOCK_OP_TIME_VIOLATION';
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
          currentEndLineId = nextRes.assignedLineId;
          break;
        }

        if (!conflictReasons[i]) {
          conflictReasons[i] = new Set();
        }

        if (assignedSpeed === null) {
          if (blockConflictFound) conflictReasons[i].add('BLOCK_CONFLICT');
          if (stationConflictFound) conflictReasons[i].add('STATION_CONFLICT');

          const stepSize = 5;
          departAttempt[i] += stepSize;
          if (i > 0) totalWaitMins += stepSize;
          const waitedHere = departAttempt[i] - waitStartedAt[i];
          if (
            waitedHere === stepSize &&
            i > 0 &&
            !detainedStations.has(block.stn1.code)
          ) {
            detentionCount++;
          }

          const stn1Halt = simStopsMap.has(block.stn1.code) ? simStopsMap.get(block.stn1.code) : 0;
          if (waitedHere === stepSize && stn1Halt === 0 && i > 0 && !detainedStations.has(block.stn1.code)) {
            detainedStations.add(block.stn1.code);
            diagnostics.backtrackCount++;
            for (let k = i; k < n; k++) {
              departAttempt[k] = null;
              waitStartedAt[k] = null;
              if (k >= i) arrivalAt[k] = null;
            }
            for (let k = i - 1; k < n - 1; k++) {
              hopResult[k] = null;
              if (conflictReasons[k]) conflictReasons[k] = null;
            }
            i -= 1;
            break;
          }

          if (waitedHere > maxDetentionMins) {
            diagnostics.backtrackCount++;

            for (let k = i; k < n; k++) {
              departAttempt[k] = null;
              waitStartedAt[k] = null;
              if (k > i) arrivalAt[k] = null;
              if (k >= i && blockData[k]) {
                detainedStations.delete(blockData[k].stn1.code);
                detainedStations.delete(blockData[k].stn2.code);
              }
            }
            for (let k = i; k < n - 1; k++) {
              hopResult[k] = null;
              if (conflictReasons[k]) conflictReasons[k] = null;
            }

            i -= 1;
            if (i >= 0) {
              departAttempt[i] += 1;
              detentionCount++;
            }
            break;
          }

          if (i >= 0) {
            const stateKey = `${i}|${departAttempt[i]}`;
            if (visited.has(stateKey)) return null;
            visited.add(stateKey);
          }

          continue;
        }

        const detentionMins = i === 0 ? 0 : departAttempt[i] - waitStartedAt[i];

        const stn1HaltForCheck = simStopsMap.has(block.stn1.code) ? simStopsMap.get(block.stn1.code) : 0;
        if (i > 0 && detentionMins === 0 && stn1HaltForCheck === 0 && detainedStations.has(block.stn1.code)) {
          if (!visited.phantomDetentions) visited.phantomDetentions = new Map();
          const oscKey = `${i}-${block.stn1.code}`;
          const count = (visited.phantomDetentions.get(oscKey) || 0) + 1;
          visited.phantomDetentions.set(oscKey, count);

          if (count <= 2) {
            detainedStations.delete(block.stn1.code);
            diagnostics.backtrackCount++;
            for (let k = i; k < n; k++) {
              departAttempt[k] = null;
              waitStartedAt[k] = null;
              if (k >= i) arrivalAt[k] = null;
            }
            for (let k = i - 1; k < n - 1; k++) {
              hopResult[k] = null;
              if (conflictReasons[k]) conflictReasons[k] = null;
            }
            i -= 1;
            break;
          }
        }

        let finalReason = 'NONE';
        if (detentionMins > 0 && conflictReasons[i].size > 0) {
          finalReason = Array.from(conflictReasons[i]).join('+');
        }

        hopResult[i] = {
          startStn: block.stn1.code,
          endStn: block.stn2.code,
          startLineId: i === 0 ? originLineId : hopResult[i - 1].endLineId,
          endLineId: currentEndLineId,
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

      if (isAuto) {
        capacity = Math.max(2, Math.floor(dist / 1.5));
      } else {
        capacity = 1;
      }

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
    const getWeekDay = mins => simDay === 'All' ? 'Daily' : DAY_ABBR[Math.floor(mins / 1440) % 7];
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

      const lastStop = stops.length > 0 ? stops[stops.length - 1] : null;
      if (lastStop && lastStop.station === seg.endStn) {
        lastStop.depTime = (depMins - startDayIdx * 24 * 60) / 60;
        lastStop.absDepMins = depMins;
        lastStop.depStr = isDestination ? 'Destination' : formatTimeMins(depMins);
        lastStop.normalHalt = (lastStop.normalHalt || 0) + haltMins;
        lastStop.detentionMinutes = (lastStop.detentionMinutes || 0) + detentionMins;
        if (dReason && dReason !== 'NONE') lastStop.detentionReason = dReason;
        lastStop.stationLineId = seg.endLineId;
      } else {
        stops.push({
          seq: stops.length + 1, zone: '-', division: '-', station: seg.endStn,
          arrTime: (arrMins - startDayIdx * 24 * 60) / 60, depTime: (depMins - startDayIdx * 24 * 60) / 60,
          absArrMins: arrMins, absDepMins: depMins,
          arrStr: formatTimeMins(arrMins), depStr: isDestination ? 'Destination' : formatTimeMins(depMins),
          dayOfSrvc: getDay(arrMins), weekDay: getWeekDay(arrMins),
          y: stations.find(s => s.code === seg.endStn)?.y || 0,
          normalHalt: haltMins, detentionMinutes: detentionMins, detentionReason: dReason,
          stationLineId: seg.endLineId
        });
      }
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
      totalDetention: stops.reduce((sum, s) => sum + (s.detentionMinutes || 0), 0),
      detentionCount: stops.filter(s => (s.detentionMinutes || 0) > 0).length,
      stationCodes: stops.map(s => s.station)
    };
  };

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
    if (++iterCount % 50 === 0) await new Promise(r => setTimeout(r, 0));
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
        if (!result) {
          // console.warn(`[SIM ABORT] attemptPathFromTime returned null! tryStartMins: ${tryFwd ? tryStartMinsFwd : tryStartMinsBwd}, tryFwd: ${tryFwd}`);
        }
        if (tryFwd) tryStartMinsFwd += hwMargin;
        else tryStartMinsBwd += hwMargin;
      }
    }
  }

  if (debug) {
    console.log('--- SIMULATOR FINAL DIAGNOSTICS ---');
    console.log('[SIM SUMMARY]', {
      totalScheduled: foundPaths.length,
      finalTryStartMinsFwd: tryStartMinsFwd,
      finalTryStartMinsBwd: tryStartMinsBwd,
      uptoMins: uptoMins
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
