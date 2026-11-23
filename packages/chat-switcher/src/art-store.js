import { getMosaicBaseDataUrl, getMosaicDataUrl, getMosaicCanvasColor, createMosaicSvgAsync, hasMosaicFractal } from './mosaic.js';
import { imageVariantFromSeed, HYBRID_VARIANT } from './image-variant.js';
import { MOSAIC_WORKER_SOURCE } from './mosaic-worker-source.js';

const SVG_URI = 'data:image/svg+xml;charset=utf-8,';
const isSvgUri = value => typeof value === 'string' && /^data:image\/svg\+xml[;,]/.test(value);
const neededNow = needed => { try { return typeof needed === 'function' && !!needed(); } catch { return false; } };
const bounded = (value, fallback, maximum) => Number.isFinite(value) && value > 0 ? Math.min(maximum, Math.max(1, Math.floor(value))) : fallback;

/** Optional dependency injection keeps lifecycle tests independent of a renderer/Worker implementation. */
export function createMosaicArtRuntime(environment = globalThis, options = {}) {
  const baseUri = options.baseUri ?? getMosaicBaseDataUrl;
  const legacyUri = options.legacyUri ?? getMosaicDataUrl;
  const colorFor = options.color ?? getMosaicCanvasColor;
  const createSvgAsync = options.createSvgAsync ?? createMosaicSvgAsync;
  const variant = options.variant ?? imageVariantFromSeed;
  // Production follows the actual presence bit, not merely the seed generation.
  // The optional variant hook remains compatible with existing fake-API lifecycle tests.
  const containsFractal = options.hasFractal ?? (options.variant ? seed => variant(seed) === HYBRID_VARIANT : hasMosaicFractal);
  const workerSource = options.workerSource ?? MOSAIC_WORKER_SOURCE;
  const cacheLimit = bounded(options.cacheLimit, 32, 32);
  const workerTimeout = bounded(options.workerTimeout, 8000, 30000);
  const fallbackTimeout = bounded(options.fallbackTimeout, 8000, 30000);
  const pollInterval = bounded(options.pollInterval, 50, 100);
  const ownTimers = typeof environment?.setTimeout === 'function' && typeof environment?.clearTimeout === 'function';
  const setTimer = ownTimers ? environment.setTimeout.bind(environment) : globalThis.setTimeout.bind(globalThis);
  const clearTimer = ownTimers ? environment.clearTimeout.bind(environment) : globalThis.clearTimeout.bind(globalThis);
  const timers = new Set(), entries = new Map(), queue = [];
  let disposed = false, pumping = false, active = null, nextId = 0;
  let pumpTimer = null, pollTimer = null, worker = null, workerUrl = null, workerDisabled = false;

  function later(callback, milliseconds) {
    const id = setTimer(() => { if (timers.delete(id) && !disposed) callback(); }, milliseconds);
    timers.add(id);
    return id;
  }
  function cancelTimer(id) {
    if (id === null) return;
    timers.delete(id);
    try { clearTimer(id); } catch { /* Already removed or partial timer API. */ }
  }
  const interested = entry => entry.listeners.size > 0 || entry.waiters.size > 0;
  function touch(entry) { entries.delete(entry.seed); entries.set(entry.seed, entry); }
  function trim() {
    let idle = 0;
    for (const entry of entries.values()) if (!interested(entry) && !entry.job) idle++;
    for (const [seed, entry] of entries) {
      if (idle <= cacheLimit) break;
      if (!interested(entry) && !entry.job) { entries.delete(seed); idle--; }
    }
  }
  function notify(entry) {
    for (const token of [...entry.listeners]) {
      if (disposed) break;
      if (entry.listeners.has(token)) { try { token.callback(); } catch { /* One observer cannot strand the shared queue. */ } }
    }
  }
  function snapshot(entry, uri, status) {
    if (disposed || (entry.snapshot.uri === uri && entry.snapshot.status === status)) return;
    entry.snapshot = Object.freeze({ uri, color: entry.snapshot.color, status });
  }
  function settle(entry, uri) {
    for (const waiter of [...entry.waiters]) {
      entry.waiters.delete(waiter);
      waiter.resolve(uri !== null && !disposed && neededNow(waiter.needed) ? uri : null);
    }
  }
  function destroyWorker() {
    const owned = worker; worker = null;
    if (!owned) return;
    try { owned.onmessage = null; owned.onerror = null; owned.onmessageerror = null; } catch { /* Partial Worker API. */ }
    try { owned.terminate(); } catch { /* Already terminated. */ }
  }
  function endJob(job) {
    if (active !== job) return false;
    active = null; job.cancelled = true; job.entry.job = null;
    cancelTimer(job.timeout); job.timeout = null;
    for (const [id, resolve] of job.yields) { cancelTimer(id); resolve(); }
    job.yields.clear();
    return true;
  }
  function cancelJob(job) {
    const wasWorker = job.phase === 'worker';
    if (!endJob(job)) return;
    if (wasWorker) destroyWorker();
  }
  function schedulePump() {
    if (disposed || pumping || active || pumpTimer !== null || !queue.length) return;
    pumpTimer = later(() => { pumpTimer = null; pump(); }, 0);
  }
  function syncPoll() {
    let hasWaiters = false;
    for (const entry of entries.values()) if (entry.waiters.size) { hasWaiters = true; break; }
    if (disposed || !hasWaiters) { cancelTimer(pollTimer); pollTimer = null; return; }
    if (pollTimer !== null) return;
    pollTimer = later(() => {
      pollTimer = null;
      for (const entry of [...entries.values()]) pruneWaiters(entry);
      syncPoll();
    }, pollInterval);
  }
  function release(entry) {
    if (disposed) return;
    if (!interested(entry)) {
      if (entry.queued) {
        entry.queued = false;
        const index = queue.indexOf(entry); if (index >= 0) queue.splice(index, 1);
      }
      if (entry.job) cancelJob(entry.job);
      if (!queue.length) { cancelTimer(pumpTimer); pumpTimer = null; }
    }
    trim(); syncPoll(); fillQueue();
  }
  function pruneWaiters(entry) {
    let removed = false;
    for (const waiter of [...entry.waiters]) {
      if (!neededNow(waiter.needed)) { entry.waiters.delete(waiter); waiter.resolve(null); removed = true; }
      if (disposed) return;
    }
    if (removed) release(entry);
  }
  function shouldAbort(job) {
    if (disposed || job.cancelled || active !== job) return true;
    pruneWaiters(job.entry);
    return disposed || job.cancelled || active !== job || !interested(job.entry);
  }
  function yieldControl(job) {
    if (shouldAbort(job)) return Promise.resolve();
    return new Promise(resolve => {
      const id = later(() => { job.yields.delete(id); resolve(); }, 0);
      job.yields.set(id, resolve);
    });
  }
  function complete(job, uri) {
    if (shouldAbort(job) || !endJob(job)) return;
    const entry = job.entry;
    snapshot(entry, uri, 'ready'); touch(entry); settle(entry, uri); notify(entry);
    trim(); syncPoll(); fillQueue();
  }
  function fail(job) {
    if (shouldAbort(job) || !endJob(job)) return;
    const entry = job.entry;
    snapshot(entry, entry.base, 'fallback'); touch(entry); settle(entry, null); notify(entry);
    trim(); syncPoll(); fillQueue();
  }
  function fallback(job) {
    if (shouldAbort(job)) return;
    cancelTimer(job.timeout);
    job.phase = 'fallback';
    job.timeout = later(() => fail(job), fallbackTimeout);
    // Even an async implementation may do synchronous setup before its first
    // await: enter it only after our own zero-delay macrotask, never in React.
    void (async () => {
      await yieldControl(job);
      if (shouldAbort(job)) return;
      const svg = await createSvgAsync(job.entry.seed, {
        yieldControl: () => yieldControl(job), shouldAbort: () => shouldAbort(job),
      });
      if (shouldAbort(job)) return;
      if (typeof svg !== 'string' || !/^\s*(?:<\?xml[^>]*>\s*)?<svg\b/.test(svg)) { fail(job); return; }
      complete(job, SVG_URI + encodeURIComponent(svg));
    })().catch(() => fail(job));
  }
  function workerFailed(owned) {
    if (disposed || worker !== owned) return;
    const job = active;
    workerDisabled = true; destroyWorker();
    if (job?.phase === 'worker') fallback(job);
  }
  function ensureWorker() {
    if (worker) return true;
    if (workerDisabled) return false;
    try {
      if (typeof environment?.Worker !== 'function' || typeof environment?.Blob !== 'function'
          || typeof environment?.URL?.createObjectURL !== 'function' || typeof environment?.URL?.revokeObjectURL !== 'function'
          || typeof workerSource !== 'string' || !workerSource) throw new Error('Worker unavailable');
      if (workerUrl === null) workerUrl = environment.URL.createObjectURL(new environment.Blob([workerSource], { type: 'text/javascript' }));
      const owned = new environment.Worker(workerUrl, { name: 'dsh-chat-mosaic' });
      worker = owned;
      owned.onmessage = event => {
        if (disposed || worker !== owned) return;
        const job = active, data = event?.data;
        if (!job || job.phase !== 'worker' || data?.id !== job.id) return;
        if (!data.error && isSvgUri(data.uri)) complete(job, data.uri);
        else workerFailed(owned);
      };
      owned.onerror = event => { try { event?.preventDefault?.(); } catch { /* Optional error API. */ } workerFailed(owned); };
      owned.onmessageerror = () => workerFailed(owned);
      return true;
    } catch { workerDisabled = true; destroyWorker(); return false; }
  }
  function pump() {
    if (disposed || active) return;
    pumping = true;
    try {
      while (queue.length && !disposed) {
        const entry = queue.shift(); entry.queued = false;
        pruneWaiters(entry);
        if (disposed || !interested(entry) || entry.snapshot.status !== 'pending') continue;
        const job = { id: ++nextId, entry, phase: 'worker', cancelled: false, timeout: null, yields: new Map() };
        active = job; entry.job = job;
        if (ensureWorker()) {
          const owned = worker;
          job.timeout = later(() => { if (active === job && job.phase === 'worker') workerFailed(owned); }, workerTimeout);
          try { owned.postMessage({ id: job.id, seed: entry.seed }); } catch { workerFailed(owned); }
        } else fallback(job);
        break;
      }
    } finally { pumping = false; trim(); fillQueue(); }
  }
  function fillQueue() {
    if (disposed || pumping) return;
    // Overflow stays pending in the already-owned store Map, not another queue.
    // Refill in Map order only when capacity opens; a full queue adds no timers.
    for (const entry of entries.values()) {
      if (queue.length + (active ? 1 : 0) >= 64) break;
      if (interested(entry) && entry.snapshot.status === 'pending' && !entry.queued && !entry.job) {
        entry.queued = true; queue.push(entry);
      }
    }
    schedulePump();
  }
  function enqueue(entry) {
    if (disposed || !interested(entry) || entry.snapshot.status !== 'pending' || entry.queued || entry.job) return;
    fillQueue();
  }
  function claim(handle) {
    const current = entries.get(handle.entry.seed);
    if (current && current !== handle.entry) handle.entry = current;
    touch(handle.entry);
    return handle.entry;
  }
  function getStore(seed) {
    if (typeof seed !== 'string') throw new TypeError('Mosaic seed must be a string');
    let entry = entries.get(seed);
    if (entry) { touch(entry); return entry.store; }
    const hybrid = containsFractal(seed);
    const uri = hybrid ? baseUri(seed) : legacyUri(seed);
    entry = { seed, base: uri, snapshot: Object.freeze({ uri, color: colorFor(seed), status: hybrid ? 'pending' : 'legacy' }),
      listeners: new Set(), waiters: new Set(), queued: false, job: null, store: null };
    const handle = { entry };
    entry.store = Object.freeze({
      getSnapshot: () => handle.entry.snapshot,
      subscribe(callback) {
        if (disposed || typeof callback !== 'function') return () => {};
        const target = claim(handle), token = { callback };
        target.listeners.add(token); enqueue(target); trim();
        let removed = false;
        return () => { if (removed) return; removed = true; target.listeners.delete(token); release(target); };
      },
    });
    if (!disposed) { touch(entry); trim(); }
    return entry.store;
  }
  function waitForArt(seed, needed = () => true) {
    if (disposed || !neededNow(needed)) return Promise.resolve(null);
    const store = getStore(seed), entry = entries.get(seed);
    if (disposed || !neededNow(needed)) return Promise.resolve(null);
    const value = store.getSnapshot();
    const deliver = uri => uri !== null && !disposed && neededNow(needed) ? uri : null;
    if (value.status === 'ready' || value.status === 'legacy') return Promise.resolve(value.uri).then(deliver);
    if (value.status === 'fallback') return Promise.resolve(null);
    return new Promise(resolve => {
      entry.waiters.add({ needed, resolve }); enqueue(entry); syncPoll(); trim();
    }).then(deliver);
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (active) cancelJob(active);
    destroyWorker();
    for (const id of [...timers]) cancelTimer(id);
    pumpTimer = null; pollTimer = null;
    for (const entry of entries.values()) { settle(entry, null); entry.listeners.clear(); entry.queued = false; }
    queue.length = 0; entries.clear();
    if (workerUrl !== null) {
      try { environment.URL.revokeObjectURL(workerUrl); } catch { /* Already revoked/partial URL API. */ }
      workerUrl = null;
    }
  }
  function getHealth() {
    let ready = 0, pending = 0, fallbackCount = 0;
    for (const entry of entries.values()) {
      if (entry.snapshot.status === 'ready') ready++;
      if (entry.snapshot.status === 'fallback') fallbackCount++;
      if (entry.snapshot.status === 'pending' && interested(entry)) pending++;
    }
    return { ready, pending, fallback: fallbackCount, cached: entries.size, queued: queue.length,
      activeJobs: active ? 1 : 0, workerActive: !!worker && active?.phase === 'worker', workerAlive: !!worker };
  }
  return Object.freeze({ getStore, waitForArt, dispose, getHealth });
}

let runtimes = new WeakMap();
const ownedRuntimes = new Set();
function runtimeFor(environment) {
  const key = environment && (typeof environment === 'object' || typeof environment === 'function') ? environment : globalThis;
  let runtime = runtimes.get(key);
  if (!runtime) { runtime = createMosaicArtRuntime(key); runtimes.set(key, runtime); ownedRuntimes.add(runtime); }
  return runtime;
}

export function getMosaicArtStore(seed, environment = globalThis) { return runtimeFor(environment).getStore(seed); }
export function waitForMosaicArt(seed, environment = globalThis, needed = () => true) { return runtimeFor(environment).waitForArt(seed, needed); }
export function disposeMosaicArtRuntime() {
  for (const runtime of ownedRuntimes) runtime.dispose();
  ownedRuntimes.clear(); runtimes = new WeakMap();
}
/** Aggregate lifecycle counts only: no seeds, session IDs, artwork or user data. */
export function getMosaicArtHealth() {
  const total = { ready: 0, pending: 0, fallback: 0, cached: 0, queued: 0, activeJobs: 0, workerActive: 0, workerAlive: 0 };
  for (const runtime of ownedRuntimes) {
    const health = runtime.getHealth();
    for (const key of Object.keys(total)) total[key] += Number(health[key]);
  }
  return total;
}
