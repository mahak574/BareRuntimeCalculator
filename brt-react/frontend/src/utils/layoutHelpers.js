// src/utils/layoutHelpers.js
/**
 * Returns the block-section code that lies between two consecutive stations.
 * The layout.sequence is ordered as station → block → station → … and the
 * block nodes retain a temporary `code` property that matches the key in
 * layout.blockSections. This helper scans the sequence and extracts that code.
 */
export const getBlockCodeBetween = (layout, stnA, stnB) => {
  const seq = layout.sequence;
  for (let i = 0; i < seq.length - 2; i++) {
    const cur = seq[i];
    const blk = seq[i + 1];
    const nxt = seq[i + 2];
    if (
      cur.type === 'station' && blk.type === 'block' && blk.code &&
      nxt.type === 'station' &&
      ((cur.code === stnA && nxt.code === stnB) || (cur.code === stnB && nxt.code === stnA))
    ) {
      return blk.code; // block-section identifier
    }
  }
  return null;
};

/**
 * Parses the layout data to determine the semantic direction of each station line.
 * It uses layout.connections, sequence order, and MACRECVSENDFLAG.
 * 
 * Returns a mapping:
 * {
 *   [stnCode]: {
 *     [seqNum]: 'UP' | 'DOWN' | 'BOTH'
 *   }
 * }
 */
export const buildStationLineDirections = (layout) => {
  const directions = {};

  if (!layout || !layout.sequence || !layout.connections) return directions;

  const mainLineCache = {};
  const getMainLinesForNode = (code, type) => {
    const key = `${type}-${code}`;
    if (mainLineCache[key]) return mainLineCache[key];

    let lines = [];
    if (type === 'station') {
      const stn = layout.stations[code];
      if (stn && stn.lines) {
        lines = stn.lines.filter(l => {
          const cat = String(l.MACLINECATEGORY || '').trim().toUpperCase();
          return cat === 'M' || cat === 'MAIN';
        });
        if (lines.length === 0) {
          lines = stn.lines.filter(l => parseFloat(l.MANSEQNUMB) <= 2);
        }
      }
    }

    lines.sort((a, b) => parseFloat(a.MANSEQNUMB) - parseFloat(b.MANSEQNUMB));
    mainLineCache[key] = lines;
    return lines;
  };

  const nodeIndexMap = {};
  layout.sequence.forEach((n, i) => {
    nodeIndexMap[n.code] = i;
  });

  const mainLineColorsByIndex = {};
  const processedDirectionSources = new Set();

  layout.connections.forEach(conn => {
    let bsCode = conn.MAVBLCKSCTN || '';
    if (nodeIndexMap[bsCode] === undefined) {
      const reversed = String(bsCode).split('-').reverse().join('-');
      if (nodeIndexMap[reversed] !== undefined) bsCode = reversed;
    }

    const stnIndex = nodeIndexMap[conn.MAVSTTNCODE];
    const bsIndex = nodeIndexMap[bsCode];

    if (stnIndex !== undefined && bsIndex !== undefined) {
      const isSend = conn.MACRECVSENDFLAG === 'S';
      const isBidirectional = conn.MACRECVSENDFLAG === 'B';
      const isMSync = conn.MACRECVSENDFLAG === 'M_SYNC';

      const isLeftToRight = (bsIndex > stnIndex && (isSend || isMSync)) || (bsIndex < stnIndex && !(isSend || isMSync));

      const stn = layout.stations[conn.MAVSTTNCODE];
      let seqNum = parseInt(conn.MANSTTNLINENUMB);
      let actualStnLine = stn?.lines?.find(l => parseFloat(l.MANSEQNUMB) === seqNum);
      if (!actualStnLine) actualStnLine = stn?.lines?.find(l => String(l.MAVLINENUMB).trim() === String(conn.MANSTTNLINENUMB).trim());

      if (actualStnLine) seqNum = parseFloat(actualStnLine.MANSEQNUMB);

      const mLinesStn = getMainLinesForNode(conn.MAVSTTNCODE, 'station');
      const mainLineIndex = mLinesStn.findIndex(l => parseFloat(l.MANSEQNUMB) === seqNum);

      if (mainLineIndex !== -1 && !isBidirectional && !isMSync && (isSend || isMSync)) {
        const dedupKey = `${conn.MAVSTTNCODE}|${bsCode}|${seqNum}`;
        if (processedDirectionSources.has(dedupKey)) {
          // Skip duplicate processing for this station‑block‑mainLine combination
          return;
        }
        processedDirectionSources.add(dedupKey);

        if (!mainLineColorsByIndex[conn.MAVSTTNCODE]) {
          mainLineColorsByIndex[conn.MAVSTTNCODE] = {};
        }

        const calcDir = isLeftToRight ? 'DOWN' : 'UP';
        const existingDir = mainLineColorsByIndex[conn.MAVSTTNCODE][mainLineIndex];

        console.log('[DIRECTION SOURCE]', {
          station: conn.MAVSTTNCODE,
          connectionBlockSection: bsCode,
          MANSTTNLINENUMB: conn.MANSTTNLINENUMB,
          resolvedSeqNum: seqNum,
          mainLineIndex: mainLineIndex,
          MACRECVSENDFLAG: conn.MACRECVSENDFLAG,
          bsIndex: bsIndex,
          stnIndex: stnIndex,
          isLeftToRight: isLeftToRight,
          calculatedDirection: calcDir
        });

        if (existingDir && existingDir !== calcDir) {
          console.log('[DIRECTION OVERWRITE]', {
            station: conn.MAVSTTNCODE,
            mainLineIndex: mainLineIndex,
            previousDirection: existingDir,
            newDirection: calcDir,
            sourceConnection: bsCode
          });
          console.log('[AMBIGUOUS LINE DIRECTION]');
        }

        mainLineColorsByIndex[conn.MAVSTTNCODE][mainLineIndex] = calcDir;
      }
    }
  });

  // Assign directions to all lines
  layout.sequence.forEach((node) => {
    if (node.type === 'station') {
      const stnCode = node.code;
      directions[stnCode] = {};
      const stn = layout.stations[stnCode];
      if (!stn || !stn.lines) return;

      const mLines = getMainLinesForNode(stnCode, 'station');

      stn.lines.forEach(line => {
        const seqNum = parseFloat(line.MANSEQNUMB);
        const mainLineIndex = mLines.findIndex(l => parseFloat(l.MANSEQNUMB) === parseInt(seqNum));

        let dir = 'BOTH';
        if (mainLineIndex !== -1 && mainLineColorsByIndex[stnCode] && mainLineColorsByIndex[stnCode][mainLineIndex]) {
          dir = mainLineColorsByIndex[stnCode][mainLineIndex];
        }
        // If no resolved direction, keep default 'BOTH'
        directions[stnCode][seqNum] = dir;
      });
    }
  });

  console.log('[FINAL STATION LINE DIRECTIONS]', directions);
  return directions;
};
