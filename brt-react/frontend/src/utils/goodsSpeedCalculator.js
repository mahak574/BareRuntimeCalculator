import Papa from 'papaparse';

function parseCsvUrl(url) {
  return new Promise((resolve, reject) => {
    Papa.parse(url, {
      download: true,
      header: true,
      skipEmptyLines: true,
      transformHeader: (header) => header.replace(/"/g, '').trim().toLowerCase(),
      transform: (val) => {
        if (typeof val === 'string') return val.replace(/"/g, '').trim();
        return val;
      },
      complete: (results) => {
        resolve(results.data);
      },
      error: (err) => {
        reject(err);
      }
    });
  });
}

export async function calculateGoodsSpeedConfig(routeInfo, layout) {
  try {
    const [kotaRows, bspRows] = await Promise.all([
      parseCsvUrl('/data/KOTA-APR-MAY-26.csv'),
      parseCsvUrl('/data/BSP-APR-MAY-26.csv')
    ]);
    const allRows = [...kotaRows, ...bspRows];

    // Build physical sections from layout.sequence
    const physicalSections = [];
    if (layout && layout.sequence) {
      let currentStn = null;
      let currentBlock = null;
      for (let i = 0; i < layout.sequence.length; i++) {
        const node = layout.sequence[i];
        if (node.type === 'station') {
          if (currentStn && currentBlock) {
            physicalSections.push({
              BLOCK_SECTION_CODE: currentBlock.code,
              DISTANCE_KM: currentBlock.distanceKm || 0,
              FROM_STATION: currentStn.code,
              TO_STATION: node.code
            });
          }
          currentStn = node;
          currentBlock = null;
        } else if (node.type === 'block') {
          currentBlock = node;
        }
      }
    }
    

    const config = {
      'forward': {},
      'backward': {},
    };

    const initConfig = (dir, sectionCode, dist) => {
      if (!config[dir][sectionCode]) {
        config[dir][sectionCode] = {
          distance: dist,
          LOADED: { defaultSpeed: null, minimumTime: Infinity, hasData: false, totalTimes: 0 },
          EMPTY: { defaultSpeed: null, minimumTime: Infinity, hasData: false, totalTimes: 0 }
        };
      }
    };

    physicalSections.forEach(s => {
      initConfig('forward', s.BLOCK_SECTION_CODE, parseFloat(s.DISTANCE_KM) || 0);
      initConfig('backward', s.BLOCK_SECTION_CODE, parseFloat(s.DISTANCE_KM) || 0);
    });

    // Helper to find path of layout sections for a CSV block string like "SGAC-DXD"
    const getLayoutSectionsForSpan = (csvSectionName) => {
      if (!csvSectionName || !layout || !layout.sequence) return null;
      const name = csvSectionName.trim().toUpperCase();
      
      // Exact match check first
      const exact = physicalSections.find(s => s.BLOCK_SECTION_CODE.trim().toUpperCase() === name);
      if (exact) return { sections: [exact], totalDistance: parseFloat(exact.DISTANCE_KM) || 0 };

      // Split into start and end stations
      const parts = name.split('-');
      if (parts.length !== 2) return null;
      const stnA = parts[0].trim();
      const stnB = parts[1].trim();

      let startIndex = layout.sequence.findIndex(n => n.type === 'station' && n.code === stnA);
      let endIndex = layout.sequence.findIndex(n => n.type === 'station' && n.code === stnB);
      
      if (startIndex === -1 || endIndex === -1) return null;
      
      // Swap if needed
      if (startIndex > endIndex) {
        let temp = startIndex;
        startIndex = endIndex;
        endIndex = temp;
      }

      let matchedSections = [];
      let totalDist = 0;

      for (let i = startIndex; i < endIndex; i++) {
        const node = layout.sequence[i];
        if (node.type === 'block') {
           const lSec = physicalSections.find(s => s.BLOCK_SECTION_CODE === node.code);
           if (lSec) {
             matchedSections.push(lSec);
             totalDist += parseFloat(lSec.DISTANCE_KM) || 0;
           }
        }
      }
      
      if (matchedSections.length > 0 && totalDist > 0) {
        return { sections: matchedSections, totalDistance: totalDist };
      }
      return null;
    };

    let totalFreightRows = 0;
    let loadedCount = 0;
    let emptyCount = 0;
    
    let invalidTimeRows = 0;
    let nonPositiveTimeRows = 0;
    let impossibleSpeedRows = 0;
    let validRunningTimeRows = 0;
    let validSpeedRows = 0;

    let unmappedBlocks = new Set();
    let rejectedExamples = [];
    
    // Group minimum times by Span + Direction + LoadType
    const spanAggregations = {};

    // Process all CSV rows
    allRows.forEach(row => {
      const trainNumb = (row.cavtrainnumb || '').trim();
      if (trainNumb !== '' && trainNumb.toLowerCase() !== 'null' && trainNumb.toLowerCase() !== 'undefined') return;

      totalFreightRows++;

      const trainType = (row.cavtraintype || '').trim().toUpperCase();
      let loadType = null;
      if (trainType.startsWith('L')) {
          loadType = 'LOADED';
          loadedCount++;
      } else if (trainType.startsWith('E')) {
          loadType = 'EMPTY';
          emptyCount++;
      }
      
      if (!loadType) return;

      const arvTimeStr = row.cadarvltime;
      const dprtTimeStr = row.caddprttime;
      if (!arvTimeStr || !dprtTimeStr) {
         invalidTimeRows++;
         return;
      }

      // Handle raw date strings
      const arrTime = new Date(arvTimeStr).getTime();
      const dprtTime = new Date(dprtTimeStr).getTime();
      if (isNaN(arrTime) || isNaN(dprtTime)) {
         invalidTimeRows++;
         return;
      }

      const diffMs = dprtTime - arrTime;
      let diffMins = diffMs / 60000;
      
      if (diffMins < 0) diffMins += 24 * 60; // Handle midnight crossing
      
      if (diffMins <= 0) {
         nonPositiveTimeRows++;
         return;
      }

      const blockSection = row.cavblcksctnname;
      const spanResult = getLayoutSectionsForSpan(blockSection);
      
      if (!spanResult) {
         unmappedBlocks.add(blockSection);
         return;
      }

      if (spanResult.totalDistance <= 0) {
         impossibleSpeedRows++;
         return;
      }

      const direction = row.cavdrtn ? row.cavdrtn.trim().toUpperCase() : '';
      let dirKey = null;
      if (direction === 'DN' || direction === 'FORWARD' || direction === 'DOWN') dirKey = 'forward';
      else if (direction === 'UP' || direction === 'BACKWARD') dirKey = 'backward';
      
      if (!dirKey) return;

      // Validate speed
      const calculatedSpeedKmH = (spanResult.totalDistance * 60) / diffMins;
      if (calculatedSpeedKmH > 160) {
         impossibleSpeedRows++;
         if (rejectedExamples.length < 10) {
            rejectedExamples.push({
               span: blockSection,
               direction: dirKey,
               loadType: loadType,
               distanceKm: spanResult.totalDistance,
               runningTimeMinutes: diffMins,
               calculatedSpeedKmH: calculatedSpeedKmH,
               reason: "speed > 160 km/h"
            });
         }
         return;
      }
      
      validRunningTimeRows++;
      validSpeedRows++;

      const aggKey = `${dirKey}_${blockSection}_${loadType}`;
      if (!spanAggregations[aggKey]) {
        spanAggregations[aggKey] = {
          direction: dirKey,
          csvSpan: blockSection,
          loadType: loadType,
          minTime: Infinity,
          totalDistance: spanResult.totalDistance,
          physicalSections: spanResult.sections
        };
      }
      
      if (diffMins < spanAggregations[aggKey].minTime) {
        spanAggregations[aggKey].minTime = diffMins;
      }
    });

    // Map calculated speeds to physical sections
    Object.values(spanAggregations).forEach(spanInfo => {
      if (spanInfo.minTime === Infinity) return;
      
      const speedKmH = (spanInfo.totalDistance * 60) / spanInfo.minTime;
      

      spanInfo.physicalSections.forEach(lSec => {
        const code = lSec.BLOCK_SECTION_CODE;
        if (config[spanInfo.direction][code]) {
          const stats = config[spanInfo.direction][code][spanInfo.loadType];
          
          const physicalSectionDistanceKm = parseFloat(lSec.DISTANCE_KM) || 0;
          if (physicalSectionDistanceKm > 0 && speedKmH > 0) {
            const physicalSectionTime = (physicalSectionDistanceKm * 60) / speedKmH;
            
            if (physicalSectionTime < stats.minimumTime) {
              stats.minimumTime = physicalSectionTime;
              stats.defaultSpeed = speedKmH;
              stats.hasData = true;
            }
          }
        }
      });
    });

    return config;
  } catch (error) {
    console.error("[GOODS SPEED CALCULATOR ERROR]", error);
    console.error(error?.stack);
    
    // Return empty safe config structure so UI doesn't crash
    const safeConfig = { 'forward': {}, 'backward': {} };
    const physicalSections = [];
    if (layout && layout.sequence) {
      let currentStn = null;
      let currentBlock = null;
      for (let i = 0; i < layout.sequence.length; i++) {
        const node = layout.sequence[i];
        if (node.type === 'station') {
          if (currentStn && currentBlock) {
            physicalSections.push({
              BLOCK_SECTION_CODE: currentBlock.code,
              DISTANCE_KM: currentBlock.distanceKm || 0
            });
          }
          currentStn = node;
          currentBlock = null;
        } else if (node.type === 'block') {
          currentBlock = node;
        }
      }
    }
    
    const initConfig = (dir, sectionCode, dist) => {
      if (!safeConfig[dir][sectionCode]) {
        safeConfig[dir][sectionCode] = {
          distance: dist,
          LOADED: { defaultSpeed: null, minimumTime: Infinity, hasData: false, totalTimes: 0 },
          EMPTY: { defaultSpeed: null, minimumTime: Infinity, hasData: false, totalTimes: 0 }
        };
      }
    };
    physicalSections.forEach(s => {
      initConfig('forward', s.BLOCK_SECTION_CODE, parseFloat(s.DISTANCE_KM) || 0);
      initConfig('backward', s.BLOCK_SECTION_CODE, parseFloat(s.DISTANCE_KM) || 0);
    });
    
    return safeConfig;
  }
}
