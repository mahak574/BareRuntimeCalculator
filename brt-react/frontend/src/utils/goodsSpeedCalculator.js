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
 * Compute Median Absolute Deviation (MAD).
 */
function computeMAD(values) {

  if (values.length === 0) {
    return {
      median: NaN,
      mad: NaN
    };
  }

  const sorted =
    [...values].sort(
      (a, b) => a - b
    );

  const mid =
    Math.floor(
      sorted.length / 2
    );

  const median =
    sorted.length % 2 !== 0
      ? sorted[mid]
      : (
        sorted[mid - 1] +
        sorted[mid]
      ) / 2;

  const deviations =
    values.map(
      v => Math.abs(v - median)
    );

  const sortedDev =
    [...deviations].sort(
      (a, b) => a - b
    );

  const devMid =
    Math.floor(
      sortedDev.length / 2
    );

  const mad =
    sortedDev.length % 2 !== 0
      ? sortedDev[devMid]
      : (
        sortedDev[devMid - 1] +
        sortedDev[devMid]
      ) / 2;

  return {
    median,
    mad
  };
}


/**
 * Apply MAD filtering and return mean.
 */
function madFilteredMean(speeds) {

  if (speeds.length === 0) {
    return null;
  }

  let filtered = speeds;

  if (speeds.length >= 4) {

    const {
      median,
      mad
    } = computeMAD(speeds);

    const threshold =
      Math.max(
        3 * mad,
        2
      );

    const candidate =
      speeds.filter(
        s =>
          Math.abs(
            s - median
          ) <= threshold
      );

    if (candidate.length > 0) {
      filtered = candidate;
    }
  }

  if (filtered.length === 0) {
    return null;
  }

  return (
    filtered.reduce(
      (a, b) => a + b,
      0
    ) / filtered.length
  );
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
            defaultSpeed: null,
            hasData: false
          },

          EMPTY: {
            defaultSpeed: null,
            hasData: false
          },

          COACHING: {
            defaultSpeed: null,
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
            speeds: [],
            rawCount: 0
          };
        }

        speedSamples[aggKey].speeds.push(speedKmH);
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
    // STEP 7: MAD filter → mean → store default speed
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
            sample.speeds &&
            sample.speeds.length > 0
          ) {

            // Independently calculate MAD-filtered
            // mean for this exact category.
            const defaultSpeed =
              madFilteredMean(
                [...sample.speeds]
              );

            if (
              defaultSpeed !== null &&
              defaultSpeed > 0
            ) {

              config[dir][code][lt]
                .defaultSpeed =
                parseFloat(
                  defaultSpeed.toFixed(2)
                );

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
                  defaultSpeed: null,
                  hasData: false
                },

                EMPTY: {
                  defaultSpeed: null,
                  hasData: false
                },

                COACHING: {
                  defaultSpeed: null,
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