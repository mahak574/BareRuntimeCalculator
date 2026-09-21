import Papa from 'papaparse';
import kotaCsvUrl from '../data/KOTA-APR-MAY-26.csv?url';
import bspCsvUrl from '../data/BSP-APR-MAY-26.csv?url';
function parseCsvUrl(url) {
  return new Promise(async (resolve, reject) => {
    console.log('[GoodsSpeed DEBUG] CSV REQUEST START', url);
    console.log('[GoodsSpeed DEBUG] CSV PARSE CONFIG URL', url);

    let text = '';
    try {
      const response = await fetch(url);
      console.log('[GoodsSpeed DEBUG] FETCH STATUS', url, response.status);
      console.log('[GoodsSpeed DEBUG] FETCH CONTENT-TYPE', url, response.headers.get('content-type'));
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      console.log('[GoodsSpeed DEBUG] BODY STREAM', {
        url,
        hasBody: !!response.body,
        bodyUsed: response.bodyUsed
      });

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('CSV response body is not readable');
      }

      const { value, done } = await reader.read();
      console.log('[GoodsSpeed DEBUG] FIRST CHUNK', {
        url,
        done,
        bytes: value?.byteLength || 0
      });

      reader.releaseLock();

      // Do not parse anything, just resolve with empty array to satisfy UI type
      resolve([]);
    } catch (err) {
      console.error('[GoodsSpeed DEBUG] FETCH FAILED', url, err);
      return reject(err);
    }
  });
}

/**
 * Build physical sections directly from layout.sequence block nodes.
 *
 * The layout.sequence alternates: station → block → station → block → ...
 * Each block node has a `code` (the block section name from RouteInfo, e.g.
 * "ATH-BJK") and a `distance` property (km from RouteInfo DISTANCE column).
 *
 * IMPORTANT: We use node.distance directly as sectionDistanceKm.
 * We do NOT derive distances from MANMILEPOSTKM_I / MANMILEPOSTSUBKM_I because
 * those are absolute Indian Railways mileposts from different origins and
 * cannot be differenced across stations to obtain a reliable section distance.
 *
 * Returns an array of:
 * {
 *   BLOCK_SECTION_CODE: string,   // canonical code, e.g. "ATH-BJK"
 *   DISTANCE_KM:        number,   // from RouteInfo DISTANCE column
 *   FROM_STATION:       string,
 *   TO_STATION:         string,
 * }
 */
function buildPhysicalSections(layout) {
  const physicalSections = [];
  if (!layout || !layout.sequence) return physicalSections;

  let prevStn = null;
  let prevBlock = null;

  for (let i = 0; i < layout.sequence.length; i++) {
    const node = layout.sequence[i];
    if (node.type === 'station') {
      if (prevStn && prevBlock) {
        const fromCode = prevStn.code.trim().toUpperCase();
        const toCode = node.code.trim().toUpperCase();
        // Use the distance already stored on the block node (from RouteInfo).
        const distKm = parseFloat(prevBlock.distance) || 0;
        physicalSections.push({
          BLOCK_SECTION_CODE: prevBlock.code.trim().toUpperCase(),
          DISTANCE_KM: distKm,
          FROM_STATION: fromCode,
          TO_STATION: toCode,
        });
      }
      prevStn = node;
      prevBlock = null;
    } else if (node.type === 'block') {
      prevBlock = node;
    }
  }
  return physicalSections;
}

/**
 * Compute Median Absolute Deviation (MAD) of an array of numbers.
 */
function computeMAD(values) {
  if (values.length === 0) return { median: NaN, mad: NaN };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
  const deviations = values.map(v => Math.abs(v - median));
  const sortedDev = [...deviations].sort((a, b) => a - b);
  const devMid = Math.floor(sortedDev.length / 2);
  const mad = sortedDev.length % 2 !== 0
    ? sortedDev[devMid]
    : (sortedDev[devMid - 1] + sortedDev[devMid]) / 2;
  return { median, mad };
}

/**
 * Apply MAD filtering then return the mean of surviving values.
 * Returns null if no values survive.
 */
function madFilteredMean(speeds) {
  if (speeds.length === 0) return null;

  let filtered = speeds;
  if (speeds.length >= 4) {
    const { median, mad } = computeMAD(speeds);
    const threshold = Math.max(3 * mad, 2); // minimum 2 km/h band
    const candidate = speeds.filter(s => Math.abs(s - median) <= threshold);
    if (candidate.length > 0) filtered = candidate;
  }

  if (filtered.length === 0) return null;
  return filtered.reduce((a, b) => a + b, 0) / filtered.length;
}

export async function calculateGoodsSpeedConfig(routeInfo, layout) {
  try {
    const [kotaRows, bspRows] = await Promise.all([
      parseCsvUrl(kotaCsvUrl),
      parseCsvUrl(bspCsvUrl),
    ]);
    const allRows = [...kotaRows, ...bspRows];

    // ── Step 1: Build physical sections ──────────────────────────────────────
    // Uses block node `distance` from layout.sequence (sourced from RouteInfo).
    const physicalSections = buildPhysicalSections(layout);

    console.log('[GoodsSpeed] Physical sections built from layout:', physicalSections.length);
    physicalSections.forEach(s => {
      console.log(`  [GoodsSpeed]  ${s.BLOCK_SECTION_CODE}: ${s.DISTANCE_KM} km  (${s.FROM_STATION} → ${s.TO_STATION})`);
    });

    // ── Step 2: Build lookup maps ─────────────────────────────────────────────
    // Primary key: block section code (e.g. "ATH-BJK")
    // Also add the reversed key (e.g. "BJK-ATH") pointing to the same section,
    // so that backward-direction CSV rows are matched correctly.
    const blockSectionLookup = {};
    physicalSections.forEach(s => {
      const code = s.BLOCK_SECTION_CODE;
      blockSectionLookup[code] = s;
      if (code.includes('-')) {
        const reversed = code.split('-').reverse().join('-');
        if (!blockSectionLookup[reversed]) {
          blockSectionLookup[reversed] = s;
        }
      }
    });

    // ── Step 3: Initialise config ─────────────────────────────────────────────
    const config = { forward: {}, backward: {} };

    const initSection = (dir, code, dist) => {
      if (!config[dir][code]) {
        config[dir][code] = {
          distance: dist,
          LOADED: { defaultSpeed: null, hasData: false },
          EMPTY: { defaultSpeed: null, hasData: false },
          COACHING: { defaultSpeed: null, hasData: false },
        };
      }
    };

    physicalSections.forEach(s => {
      initSection('forward', s.BLOCK_SECTION_CODE, s.DISTANCE_KM);
      initSection('backward', s.BLOCK_SECTION_CODE, s.DISTANCE_KM);
    });

    // ── Step 4: Collect speed samples per (direction × section × loadType) ───
    // speedKmH = sectionDistanceKm × 3600 / canrunningtime(seconds)
    const speedSamples = {};   // aggKey → { direction, blockCode, loadType, distanceKm, speeds[], rawCount }
    const rejectedCounts = {};   // reason key → count

    const reject = (key) => { rejectedCounts[key] = (rejectedCounts[key] || 0) + 1; };

    allRows.forEach(row => {
      // ── Train category ────────────────────────────────────────────────────
      const trainNumb = (row.cavtrainnumb || '').trim();
      const isBlankTrainNumb =
        trainNumb === '' ||
        trainNumb.toLowerCase() === 'null' ||
        trainNumb.toLowerCase() === 'undefined';

      const trainType = (row.cavtraintype || '').trim().toUpperCase();
      const firstChar = trainType.charAt(0);

      let loadType = null;
      if (isBlankTrainNumb) {
        if (firstChar === 'L') loadType = 'LOADED';
        else if (firstChar === 'E') loadType = 'EMPTY';
        // Unknown freight type — skip
      } else {
        loadType = 'COACHING';
      }
      if (!loadType) { reject('unknown_train_type'); return; }

      // ── Block section ─────────────────────────────────────────────────────
      const csvBlock = (row.cavblcksctnname || '').trim().toUpperCase();
      if (!csvBlock) { reject('blank_block_section'); return; }

      const physSection = blockSectionLookup[csvBlock];
      if (!physSection) { reject(`not_in_layout:${csvBlock}`); return; }

      const sectionDistanceKm = physSection.DISTANCE_KM;
      if (!sectionDistanceKm || sectionDistanceKm <= 0) {
        reject(`zero_distance:${csvBlock}`); return;
      }

      // ── Running time ──────────────────────────────────────────────────────
      const canRunningTimeSec = parseFloat(row.canrunningtime);
      if (isNaN(canRunningTimeSec) || canRunningTimeSec <= 0) {
        reject(`bad_runtime:${csvBlock}`); return;
      }

      // ── Direction ─────────────────────────────────────────────────────────
      const dirRaw = (row.cavdrtn || '').trim().toUpperCase();
      let dirKey = null;
      if (dirRaw === 'DN' || dirRaw === 'FORWARD' || dirRaw === 'DOWN') dirKey = 'forward';
      else if (dirRaw === 'UP' || dirRaw === 'BACKWARD') dirKey = 'backward';
      if (!dirKey) { reject(`unknown_direction:${dirRaw}`); return; }

      // ── Speed ─────────────────────────────────────────────────────────────
      const speedKmH = sectionDistanceKm * 3600 / canRunningTimeSec;
      if (speedKmH < 1 || speedKmH > 160) {
        reject(`speed_oor:${csvBlock}:${speedKmH.toFixed(1)}`); return;
      }

      // ── Accumulate ────────────────────────────────────────────────────────
      // Always use the canonical (forward-direction) block code as the key.
      const canonicalCode = physSection.BLOCK_SECTION_CODE;
      const aggKey = `${dirKey}_${canonicalCode}_${loadType}`;

      if (!speedSamples[aggKey]) {
        speedSamples[aggKey] = {
          direction: dirKey,
          blockCode: canonicalCode,
          loadType,
          distanceKm: sectionDistanceKm,
          speeds: [],
          rawCount: 0,
        };
      }
      speedSamples[aggKey].speeds.push(speedKmH);
      speedSamples[aggKey].rawCount++;
    });

    // ── Step 5: MAD filter → mean → store ────────────────────────────────────
    Object.values(speedSamples).forEach(sample => {
      const rawCount = sample.speeds.length;
      const defaultSpeed = madFilteredMean(sample.speeds);
      const validCount = defaultSpeed !== null ? sample.speeds.length : 0;

      // Required console summary
      console.log('[GoodsSpeed]', {
        section: sample.blockCode,
        direction: sample.direction,
        loadType: sample.loadType,
        observations: rawCount,
        validObservations: validCount,
        defaultSpeed: defaultSpeed !== null ? parseFloat(defaultSpeed.toFixed(2)) : null,
      });

      if (defaultSpeed !== null && defaultSpeed > 0) {
        const { blockCode: code, direction: dir, loadType: lt } = sample;
        if (config[dir]?.[code]?.[lt]) {
          config[dir][code][lt].defaultSpeed = parseFloat(defaultSpeed.toFixed(2));
          config[dir][code][lt].hasData = true;
        }
      }
    });

    // ── Step 6: Report zero-observation sections ──────────────────────────────
    physicalSections.forEach(s => {
      const code = s.BLOCK_SECTION_CODE;
      ['forward', 'backward'].forEach(dir => {
        ['LOADED', 'EMPTY', 'COACHING'].forEach(lt => {
          const aggKey = `${dir}_${code}_${lt}`;
          if (!speedSamples[aggKey] || speedSamples[aggKey].speeds.length === 0) {
            const reversedCode = code.includes('-') ? code.split('-').reverse().join('-') : code;
            const csvKey = dir === 'forward' ? code : reversedCode;
            console.warn('[GoodsSpeed] ZERO observations:', {
              section: code,
              direction: dir,
              loadType: lt,
              reason: speedSamples[aggKey] ? 'all_filtered_out' : 'no_csv_rows_matched',
              csvLookupKey: csvKey,
              inLayout: blockSectionLookup[csvKey] ? 'yes' : 'no',
            });
          }
        });
      });
    });

    if (Object.keys(rejectedCounts).length > 0) {
      console.log('[GoodsSpeed] Rejection summary:', rejectedCounts);
    }

    return config;
  } catch (error) {
    console.error('[GOODS SPEED CALCULATOR ERROR]', error);
    console.error(error?.stack);

    // Return a safe empty config so the UI doesn't crash
    const safeConfig = { forward: {}, backward: {} };
    if (layout?.sequence) {
      buildPhysicalSections(layout).forEach(s => {
        ['forward', 'backward'].forEach(dir => {
          if (!safeConfig[dir][s.BLOCK_SECTION_CODE]) {
            safeConfig[dir][s.BLOCK_SECTION_CODE] = {
              distance: s.DISTANCE_KM,
              LOADED: { defaultSpeed: null, hasData: false },
              EMPTY: { defaultSpeed: null, hasData: false },
              COACHING: { defaultSpeed: null, hasData: false },
            };
          }
        });
      });
    }
    return safeConfig;
  }
}
