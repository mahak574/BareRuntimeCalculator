import { parquetReadObjects } from 'hyparquet';
import { decompress } from 'fzstd';
import kotaParquetUrl from '../data/KOTA-APR-MAY-26.parquet?url';
import bplParquetUrl from '../data/BPL-APR-MAY-26.parquet?url';
/**
 * ZSTD decompressor wrapper for hyparquet.
 */
function zstdDecompress(input, _outputLength) {
  return decompress(input);
}

/**
 * Read a Parquet file and process rows.
 */
async function parseParquetFile(url, onRow) {
  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(
        `Failed to load Parquet: ${response.status} ${response.statusText}`
      );
    }

    const arrayBuffer = await response.arrayBuffer();

    const rows = await parquetReadObjects({
      file: arrayBuffer,
      compressors: {
        ZSTD: zstdDecompress
      }
    });

    rows.forEach((row) => {
      const normalizedRow = {};

      Object.entries(row).forEach(([key, value]) => {
        const normalizedKey =
          key
            .replace(/"/g, '')
            .trim()
            .toLowerCase();

        let normalizedValue = value;

        if (typeof value === 'bigint') {
          normalizedValue = Number(value);
        } else if (typeof value === 'string') {
          normalizedValue =
            value.replace(/"/g, '').trim();
        }

        normalizedRow[normalizedKey] =
          normalizedValue;
      });

      onRow(normalizedRow);
    });
  } catch (error) {
    throw error;
  }
}


/**
 * Build physical sections directly from layout.sequence block nodes.
 *
 * layout.sequence:
 * station → block → station → block → ...
 */
function buildPhysicalSections(layout) {
  const physicalSections = [];

  if (!layout || !layout.sequence) {
    return physicalSections;
  }

  let prevStn = null;
  let prevBlock = null;

  for (
    let i = 0;
    i < layout.sequence.length;
    i++
  ) {
    const node =
      layout.sequence[i];

    if (node.type === 'station') {

      if (prevStn && prevBlock) {

        const fromCode =
          prevStn.code
            .trim()
            .toUpperCase();

        const toCode =
          node.code
            .trim()
            .toUpperCase();

        const distKm =
          parseFloat(
            prevBlock.distance
          ) || 0;

        physicalSections.push({
          BLOCK_SECTION_CODE:
            prevBlock.code
              .trim()
              .toUpperCase(),

          DISTANCE_KM:
            distKm,

          FROM_STATION:
            fromCode,

          TO_STATION:
            toCode
        });
      }

      prevStn = node;
      prevBlock = null;

    } else if (
      node.type === 'block'
    ) {
      prevBlock = node;
    }
  }

  return physicalSections;
}


/**
 * Helper to approximate the inverse CDF of the standard normal distribution,
 * then approximate the inverse CDF of the t-distribution.
 */
function tInvApprox(p, df) {
  const t = p < 0.5 ? p : 1 - p;
  const a = Math.sqrt(-2 * Math.log(t));
  const c = [2.515517, 0.802853, 0.010328];
  const d = [1.432788, 0.189269, 0.001308];
  const num = c[0] + a * (c[1] + a * c[2]);
  const den = 1 + a * (d[0] + a * (d[1] + a * d[2]));
  let z = a - num / den;
  if (p < 0.5) z = -z;
  
  if (df <= 0) return NaN;
  if (df < 1e5) {
      const z2 = z * z;
      return z + (z * (z2 + 1)) / (4 * df) + (z * (5 * z2 * z2 + 16 * z2 + 3)) / (96 * df * df);
  }
  return z;
}

/**
 * Helper to calculate median and IQR fences.
 */
function getTukeyFences(data) {
  if (data.length === 0) return { minFence: 0, maxFence: 0, median: 0 };
  const sorted = [...data].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  
  if (sorted.length < 4) return { minFence: sorted[0], maxFence: sorted[sorted.length - 1], median };
  
  const q1Idx = Math.floor(sorted.length * 0.25);
  const q3Idx = Math.floor(sorted.length * 0.75);
  const q1 = sorted[q1Idx];
  const q3 = sorted[q3Idx];
  let iqr = q3 - q1;
  
  if (iqr === 0) {
      const mean = data.reduce((a, b) => a + b, 0) / data.length;
      const stdDev = Math.sqrt(data.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (data.length || 1));
      iqr = stdDev > 0 ? stdDev * 1.35 : mean * 0.1;
      if (iqr === 0) iqr = 0.1;
  }

  const minFence = q1 - 1.5 * iqr;
  const maxFence = q3 + 1.5 * iqr;
  
  return { minFence, maxFence, median };
}

/**
 * Apply Generalized ESD test filtering and return mean.
 */
function gesdFilteredMean(speeds, alpha = 0.05, contextInfo = null) {
  if (speeds.length === 0) return null;
  
  let data = speeds.map(v => Number(v)).filter(v => !isNaN(v));
  const n = data.length;
  
  if (n === 0) return null;

  const { minFence, maxFence, median } = getTukeyFences(data);

  if (n <= 4) {
      return median;
  }

  const maxOutliers = Math.min(Math.max(1, Math.floor(n * 0.15)), n - 2); 
  
  let currentData = data.map((v, i) => ({ value: v, index: i }));
  const R_vals = [];
  const lambda_vals = [];
  const removedSequence = [];

  for (let i = 1; i <= maxOutliers; i++) {
    const mean = currentData.reduce((sum, item) => sum + item.value, 0) / currentData.length;
    const stdDev = Math.sqrt(currentData.reduce((sum, item) => sum + Math.pow(item.value - mean, 2), 0) / (currentData.length - 1));
    
    if (stdDev === 0) break;

    let maxDev = -1;
    let maxIdx = -1;
    let removePos = -1;
    let maxVal = 0;
    
    currentData.forEach((item, pos) => {
      const dev = Math.abs(item.value - mean);
      if (dev > maxDev) {
        maxDev = dev;
        maxIdx = item.index;
        removePos = pos;
        maxVal = item.value;
      }
    });

    const R = maxDev / stdDev;
    R_vals.push(R);
    removedSequence.push({ index: maxIdx, value: maxVal });
    currentData.splice(removePos, 1);

    const p = 1 - alpha / (2 * (n - i + 1));
    const df = n - i - 1;
    const t_val = tInvApprox(p, df);
    
    const lambda = ((n - i) * t_val) / Math.sqrt((df + t_val * t_val) * (n - i + 1));
    lambda_vals.push(lambda);
  }

  let numOutliers = 0;
  for (let i = 0; i < R_vals.length; i++) {
    if (R_vals[i] > lambda_vals[i]) {
      numOutliers = i + 1;
    }
  }

  const finalOutliers = [];
  for (let i = 0; i < numOutliers; i++) {
      const rm = removedSequence[i];
      if (rm.value < minFence || rm.value > maxFence) {
          finalOutliers.push(rm.index);
      }
  }

  const finalOutlierSet = new Set(finalOutliers);
  const filtered = data.filter((_, i) => !finalOutlierSet.has(i));
  
  const finalMean = filtered.length > 0 ? filtered.reduce((a, b) => a + b, 0) / filtered.length : null;

  return finalMean;
}


/**
 * Find a contiguous path of physical sections between two stations.
 */
function findPathInLayout(fromStn, toStn, physicalSections) {
  // Search forward
  for (let i = 0; i < physicalSections.length; i++) {
    if (physicalSections[i].FROM_STATION === fromStn) {
      const path = [];
      for (let j = i; j < physicalSections.length; j++) {
        path.push(physicalSections[j]);
        if (physicalSections[j].TO_STATION === toStn) {
          return path;
        }
      }
    }
  }

  // Search backward
  for (let i = physicalSections.length - 1; i >= 0; i--) {
    if (physicalSections[i].TO_STATION === fromStn) {
      const path = [];
      for (let j = i; j >= 0; j--) {
        path.push(physicalSections[j]);
        if (physicalSections[j].FROM_STATION === toStn) {
          return path;
        }
      }
    }
  }

  return null;
}


export async function calculateGoodsSpeedConfig(
  routeInfo,
  layout
) {

  try {

    // ============================================================
    // STEP 1: Build physical sections
    // ============================================================

    const physicalSections =
      buildPhysicalSections(layout);


    // ============================================================
    // STEP 2: Build section lookup
    // ============================================================

    const blockSectionLookup = {};

    physicalSections.forEach(s => {

      const code =
        s.BLOCK_SECTION_CODE;

      blockSectionLookup[code] = s;

      if (code.includes('-')) {

        const reversed =
          code
            .split('-')
            .reverse()
            .join('-');

        if (
          !blockSectionLookup[reversed]
        ) {
          blockSectionLookup[reversed] =
            s;
        }
      }
    });


    // ============================================================
    // STEP 3: Initialise configuration
    // ============================================================

    const config = {
      forward: {},
      backward: {}
    };

    const initSection = (
      dir,
      code,
      dist
    ) => {

      if (!config[dir][code]) {

        config[dir][code] = {

          distance: dist,

          LOADED: {
            defaultRuntime: null,
            hasData: false
          },

          EMPTY: {
            defaultRuntime: null,
            hasData: false
          },

          COACHING: {
            defaultRuntime: null,
            hasData: false
          }
        };
      }
    };

    physicalSections.forEach(s => {

      initSection(
        'forward',
        s.BLOCK_SECTION_CODE,
        s.DISTANCE_KM
      );

      initSection(
        'backward',
        s.BLOCK_SECTION_CODE,
        s.DISTANCE_KM
      );

    });


    // ============================================================
    // STEP 4: Prepare sample storage
    // ============================================================

    const speedSamples = {};

    const rejectedCounts = {};

    const reject = (key) => {
      rejectedCounts[key] =
        (rejectedCounts[key] || 0) + 1;
    };


    // ============================================================
    // STEP 5: Process one Parquet row
    // ============================================================

    const processRow = (row) => {

      // ----------------------------------------------------------
      // Train category
      // ----------------------------------------------------------

      const trainNumb =
        String(
          row.cavtrainnumb ?? ''
        ).trim();

      const isBlankTrainNumb =
        trainNumb === '' ||
        trainNumb.toLowerCase() === 'null' ||
        trainNumb.toLowerCase() === 'undefined';

      const trainType =
        String(
          row.cavtraintype ?? ''
        )
          .trim()
          .toUpperCase();

      const firstChar =
        trainType.charAt(0);

      let loadType = null;

      if (isBlankTrainNumb) {

        if (firstChar === 'L') {

          loadType = 'LOADED';

        } else if (
          firstChar === 'E'
        ) {

          loadType = 'EMPTY';
        }

      } else {

        loadType = 'COACHING';
      }

      if (!loadType) {

        reject(
          'unknown_train_type'
        );

        return;
      }


      // ----------------------------------------------------------
      // Block section
      // ----------------------------------------------------------

      const csvBlock =
        String(
          row.cavblcksctnname ?? ''
        )
          .trim()
          .toUpperCase();

      if (!csvBlock) {
        reject('blank_block_section');
        return;
      }

      let derivedSections = [];
      const physSection = blockSectionLookup[csvBlock];

      if (physSection) {
        derivedSections.push({
          section: physSection,
          distanceRatio: 1.0
        });
      } else if (csvBlock.includes('-')) {
        const parts = csvBlock.split('-');
        if (parts.length === 2) {
          const fromStn = parts[0].trim();
          const toStn = parts[1].trim();
          const path = findPathInLayout(fromStn, toStn, physicalSections);
          if (path && path.length > 0) {
            const totalDist = path.reduce((sum, p) => sum + (parseFloat(p.DISTANCE_KM) || 0), 0);
            if (totalDist > 0) {
              path.forEach(p => {
                derivedSections.push({
                  section: p,
                  distanceRatio: (parseFloat(p.DISTANCE_KM) || 0) / totalDist
                });
              });
            }
          }
        }
      }

      if (derivedSections.length === 0) {
        reject(`not_in_layout:${csvBlock}`);
        return;
      }

      // ----------------------------------------------------------
      // Running time
      // ----------------------------------------------------------

      const canRunningTimeSec = parseFloat(row.canrunningtime);

      if (Number.isNaN(canRunningTimeSec) || canRunningTimeSec <= 0) {
        reject(`bad_runtime:${csvBlock}`);
        return;
      }

      // ----------------------------------------------------------
      // Direction
      // ----------------------------------------------------------

      const dirRaw = String(row.cavdrtn ?? '').trim().toUpperCase();
      let dirKey = null;

      if (dirRaw === 'DN' || dirRaw === 'FORWARD' || dirRaw === 'DOWN') {
        dirKey = 'forward';
      } else if (dirRaw === 'UP' || dirRaw === 'BACKWARD') {
        dirKey = 'backward';
      }

      if (!dirKey) {
        reject(`unknown_direction:${dirRaw}`);
        return;
      }

      // ----------------------------------------------------------
      // Process Derived Sections
      // ----------------------------------------------------------

      derivedSections.forEach(ds => {
        const currentPhysSection = ds.section;
        const sectionDistanceKm = parseFloat(currentPhysSection.DISTANCE_KM) || 0;

        if (sectionDistanceKm <= 0) {
          reject(`zero_distance:${currentPhysSection.BLOCK_SECTION_CODE}`);
          return;
        }

        const apportionedRunningTimeSec = canRunningTimeSec * ds.distanceRatio;
        const apportionedRunningTimeMin = apportionedRunningTimeSec / 60;
        const speedKmH = (sectionDistanceKm * 3600) / apportionedRunningTimeSec;

        if (speedKmH < 1 || speedKmH > 160) {
          reject(`speed_oor:${currentPhysSection.BLOCK_SECTION_CODE}:${speedKmH.toFixed(1)}`);
          return;
        }

        // ----------------------------------------------------------
        // Accumulate sample
        // ----------------------------------------------------------

        const canonicalCode = currentPhysSection.BLOCK_SECTION_CODE;
        const aggKey = `${dirKey}_${canonicalCode}_${loadType}`;

        if (!speedSamples[aggKey]) {
          speedSamples[aggKey] = {
            direction: dirKey,
            blockCode: canonicalCode,
            loadType,
            distanceKm: sectionDistanceKm,
            runtimes: [],
            rawCount: 0
          };
        }

        speedSamples[aggKey].runtimes.push(apportionedRunningTimeMin);
        speedSamples[aggKey].rawCount++;
      });
    };


    // ============================================================
    // STEP 6: Read Parquet Files
    // ============================================================

    await parseParquetFile(
      kotaParquetUrl,
      processRow
    );

    await parseParquetFile(
      bplParquetUrl,
      processRow
    );


    // ============================================================
    // STEP 7: GESD test filter → mean → store default speed
    // ============================================================

    Object.keys(config).forEach(dir => {

      Object.keys(config[dir]).forEach(code => {

        [
          'LOADED',
          'EMPTY',
          'COACHING'
        ].forEach(lt => {

          const aggKey =
            `${dir}_${code}_${lt}`;

          const sample =
            speedSamples[aggKey];

          if (
            sample &&
            sample.runtimes &&
            sample.runtimes.length > 0
          ) {

            // Independently calculate GESD-filtered
            // mean for this exact category.
            const defaultRuntime =
              gesdFilteredMean(
                [...sample.runtimes],
                0.05,
                { dir, code, lt }
              );

            if (
              defaultRuntime !== null &&
              defaultRuntime > 0
            ) {
              const rounded = Math.max(0.25, Math.round(defaultRuntime * 4) / 4);
              config[dir][code][lt]
                .defaultRuntime = rounded;

              config[dir][code][lt]
                .hasData = true;
            }
          }
        });
      });
    });


    // ============================================================
    // STEP 8: Return final configuration
    // ============================================================

    return config;


  } catch (error) {

    // Preserve the existing safe-fallback behaviour.
    // No console output.

    const safeConfig = {
      forward: {},
      backward: {}
    };

    if (layout?.sequence) {

      buildPhysicalSections(layout)
        .forEach(s => {

          [
            'forward',
            'backward'
          ].forEach(dir => {

            if (
              !safeConfig[dir][
              s.BLOCK_SECTION_CODE
              ]
            ) {

              safeConfig[dir][
                s.BLOCK_SECTION_CODE
              ] = {

                distance:
                  s.DISTANCE_KM,

                LOADED: {
                  defaultRuntime: null,
                  hasData: false
                },

                EMPTY: {
                  defaultRuntime: null,
                  hasData: false
                },

                COACHING: {
                  defaultRuntime: null,
                  hasData: false
                }
              };
            }
          });
        });
    }

    return safeConfig;
  }
}