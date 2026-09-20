/**
 * Simple in-memory cache to ensure that re-opening a train/section/leg-chart 
 * that the user has already visited in this session is instantaneous, 
 * bypassing the need for a network round trip.
 * @type {Map<string, any>}
 */
const cache = new Map();

/**
 * Fetches JSON data from a given URL, utilizing the local cache if available.
 * 
 * @param {string} url - The API endpoint to fetch.
 * @returns {Promise<any>} The parsed JSON response.
 * @throws {Error} If the HTTP request fails.
 */
async function getJSON(url) {
  if (cache.has(url)) return cache.get(url);
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Request failed: ${res.status}`);
  }
  const data = await res.json();
  cache.set(url, data);
  return data;
}

/**
 * Clears the local in-memory cache. 
 * This is useful after uploading new data to force fresh requests.
 */
export function clearApiCache() {
  cache.clear();
}

/**
 * Centralized API object containing all backend endpoints used by the React application.
 */
export const api = {
  health: () => getJSON("/api/health"),
  trains: () => getJSON("/api/trains"),
  sections: () => getJSON("/api/sections"),
  chartBounds: () => getJSON("/api/chart-bounds"), 
  
  /** Fetches BRT statistics for a specific train */
  trainWiseBRT: (trainNo) => getJSON(`/api/train/${encodeURIComponent(trainNo)}`),
  
  /** Fetches graphical charting data for a specific leg of a train's journey */
  trainLegChart: (trainNo, station, nextStation) =>
    getJSON(
      `/api/train/${encodeURIComponent(trainNo)}/leg-chart?station=${encodeURIComponent(
        station
      )}&next_station=${encodeURIComponent(nextStation)}`
    ),

  /** Fetches aggregated BRT metrics for an entire block section */
  sectionWiseBRT: (sectionName) => getJSON(`/api/section/${encodeURIComponent(sectionName)}`),
  
  /** Fetches clustered graphical charting data for all trains passing through a section */
  sectionLegChart: (station, nextStation, trains) =>
    getJSON(
      `/api/section-leg-chart?station=${encodeURIComponent(station)}&next_station=${encodeURIComponent(
        nextStation
      )}&trains=${encodeURIComponent(trains.join(","))}`
    ),

  /** Fetches the physical station layout metadata (stations, tracks, connections) */
  layoutData: () => getJSON("/api/layout/data"),

  /**
   * Reloads backend data from disk and clears frontend caches.
   */
  reload: async () => {
    clearApiCache();
    const res = await fetch("/api/reload", { method: "POST" });
    if (!res.ok) throw new Error("Reload failed");
    return res.json();
  },

  /**
   * Uploads new raw CSV/Excel data files to the backend server.
   * Clears the cache automatically upon success.
   */
  uploadData: async (movementFile, masterFile, routeFile, scheduleFile) => {
    const form = new FormData();
    if (movementFile) form.append("movement_file", movementFile);
    if (masterFile) form.append("master_file", masterFile);
    if (routeFile) form.append("route_file", routeFile);
    if (scheduleFile) form.append("schedule_file", scheduleFile);
    const res = await fetch("/api/upload-data", { method: "POST", body: form });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.detail || `Upload failed: ${res.status}`);
    clearApiCache();
    return body;
  },
};
