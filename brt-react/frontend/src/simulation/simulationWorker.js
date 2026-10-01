// simulationWorker.js — runs in a separate thread (Web Worker)
// Vite ?worker import syntax se yeh automatically Worker bundle ban jaata hai

import { runSimulation } from './freightScheduler.js';
import { getBlockCodeBetween, buildStationLineDirections } from '../utils/layoutHelpers.js';

// Make helpers available (freightScheduler imports them directly, so no extra work needed)

self.onmessage = async (event) => {
  const params = event.data;

  // abortSimRef as a simple object (worker has no shared ref with main thread)
  const abortSimRef = { current: false };

  // Listen for abort signal
  const abortHandler = (e) => {
    if (e.data && e.data.type === 'ABORT') {
      abortSimRef.current = true;
    }
  };
  self.addEventListener('message', abortHandler);

  try {
    const result = await runSimulation({
      ...params,
      abortSimRef,
    });

    self.postMessage({ type: 'DONE', result });
  } catch (err) {
    self.postMessage({ type: 'ERROR', message: err?.message || String(err) });
  } finally {
    self.removeEventListener('message', abortHandler);
  }
};
