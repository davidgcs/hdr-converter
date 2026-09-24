/**
 * A pool of render workers, with a main-thread fallback.
 *
 * Jobs are queued by priority, so the render of the edit you just made never
 * waits behind a batch conversion or a background render, and several images
 * convert at once — one per worker. When module workers are not available
 * (an old browser, or the page opened from file://) the same jobs run here
 * on the main thread instead, exactly as the app used to.
 */

import { handlers } from "./jobs.js";

export const PRIORITY = Object.freeze({ interactive: 0, export: 1, batch: 2, background: 3 });

/** Must match SOURCE_CACHE in worker.js, so the mirror below stays in step. */
const WORKER_SOURCE_CACHE = 1;

function abortError() {
  return new DOMException("Job cancelled", "AbortError");
}

export function createPool({ size = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) } = {}) {
  const queue = [];
  const workers = [];
  let nextId = 1;
  let local = typeof Worker !== "function";
  let localRunning = false;

  function spawn() {
    const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    const slot = { worker, job: null, sources: [], alive: true };
    worker.onmessage = ({ data }) => {
      if (data.ready) return;
      const job = slot.job;
      if (!job || data.id !== job.id) return;
      if ("progress" in data) {
        if (!job.cancelled) job.onProgress?.(data.progress);
        return;
      }
      slot.job = null;
      if (!data.ok && /source not available/.test(data.error) && !job.retried) {
        // The mirror of what the worker holds was wrong; send the source again.
        slot.sources = [];
        job.retried = true;
        queue.unshift(job);
      } else if (!job.cancelled) {
        if (data.ok) job.resolve(data.result);
        else job.reject(new Error(data.error));
      }
      pump();
    };
    // Only fires when the worker itself fails to load or crashes; errors inside
    // a job are caught there and come back as a message.
    worker.onerror = (event) => {
      event.preventDefault?.();
      slot.alive = false;
      worker.terminate();
      if (slot.job) {
        queue.unshift(slot.job);
        slot.job = null;
      }
      if (!workers.some((other) => other.alive)) local = true;
      pump();
    };
    workers.push(slot);
  }

  if (!local) {
    try {
      for (let i = 0; i < size; i++) spawn();
    } catch {
      local = true;
    }
  }

  function takeNext() {
    let best = 0;
    for (let i = 1; i < queue.length; i++) if (queue[i].priority < queue[best].priority) best = i;
    return queue.splice(best, 1)[0];
  }

  function dispatch(slot, job) {
    const { sourceId } = job.payload;
    const index = slot.sources.indexOf(sourceId);
    const payload = { ...job.payload };
    if (index >= 0) {
      slot.sources.splice(index, 1);
      delete payload.source;
    } else if (slot.sources.length >= WORKER_SOURCE_CACHE) {
      slot.sources.shift();
    }
    slot.sources.push(sourceId);
    slot.job = job;
    slot.worker.postMessage({ id: job.id, type: job.type, payload });
  }

  async function runLocally(job) {
    localRunning = true;
    try {
      const { result } = await handlers[job.type](job.payload, (value) => job.onProgress?.(value), true);
      if (!job.cancelled) job.resolve(result);
    } catch (error) {
      if (!job.cancelled) job.reject(error);
    } finally {
      localRunning = false;
      pump();
    }
  }

  function pump() {
    if (local) {
      if (!localRunning && queue.length) runLocally(takeNext());
      return;
    }
    for (;;) {
      const idle = workers.filter((slot) => slot.alive && !slot.job);
      if (!idle.length || !queue.length) return;
      const job = takeNext();
      // Prefer a worker that already holds this source: no 22 MB copy.
      const slot = idle.find((candidate) => candidate.sources.includes(job.payload.sourceId)) || idle[0];
      dispatch(slot, job);
    }
  }

  /**
   * Queues a job. Resolves with its result; `cancel()` drops it if it has not
   * started, or discards its result if it has.
   */
  function run(type, payload, { priority = PRIORITY.batch, onProgress } = {}) {
    const job = { id: nextId++, type, payload, priority, onProgress, cancelled: false };
    const promise = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    queue.push(job);
    pump();
    return {
      promise,
      /** Moves a job that has not started up the queue, when it is needed sooner. */
      raise(next) {
        if (next < job.priority) job.priority = next;
      },
      cancel() {
        if (job.cancelled) return;
        job.cancelled = true;
        const index = queue.indexOf(job);
        if (index >= 0) queue.splice(index, 1);
        job.reject(abortError());
      }
    };
  }

  /** Lets the workers drop a source that no longer exists (a removed image). */
  function forget(sourceId) {
    for (const slot of workers) {
      const index = slot.sources.indexOf(sourceId);
      if (index < 0) continue;
      slot.sources.splice(index, 1);
      slot.worker.postMessage({ id: 0, type: "forget", payload: { sourceId } });
    }
  }

  return {
    run,
    forget,
    get size() {
      return local ? 1 : workers.filter((slot) => slot.alive).length;
    },
    get local() {
      return local;
    }
  };
}
