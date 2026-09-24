/**
 * A render worker. Runs the jobs in jobs.js off the main thread.
 *
 * Sources are large (a 2560×1440 10-bit picture is 22 MB of samples), so the
 * worker keeps the last few it was sent and the pool only sends a source to a
 * worker that does not already have it.
 */

import { handlers } from "./jobs.js";

/** One is enough: the image being edited. Every extra copy is 22 MB per worker. */
const SOURCE_CACHE = 1;
const sources = new Map();

function remember(id, source) {
  sources.delete(id);
  sources.set(id, source);
  while (sources.size > SOURCE_CACHE) sources.delete(sources.keys().next().value);
}

self.onmessage = async ({ data }) => {
  const { id, type, payload } = data;
  if (type === "forget") {
    sources.delete(payload.sourceId);
    return;
  }
  try {
    if (payload.source) remember(payload.sourceId, payload.source);
    const source = sources.get(payload.sourceId);
    if (!source) throw new Error("source not available in worker");
    sources.delete(payload.sourceId);
    sources.set(payload.sourceId, source);
    const progress = (value) => self.postMessage({ id, progress: value });
    const { result, transfer } = await handlers[type]({ ...payload, source }, progress, false);
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (error) {
    self.postMessage({ id, ok: false, error: String(error?.message || error) });
  }
};

self.postMessage({ ready: true });
