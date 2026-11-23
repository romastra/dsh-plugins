// Pure account/generation-scoped capability state. The injected loader owns I/O.
const UNAVAILABLE = 'CODEX_FAST_CHECK_UNAVAILABLE';
function unavailable() {
  const error = new Error('Fast capability could not be checked.');
  error.code = UNAVAILABLE;
  return error;
}
function validKey(value) { return typeof value === 'string' && value.length > 0 && value.length <= 2048; }
function copyCatalog(value) {
  if (!(value instanceof Map) || value.size > 4096) throw unavailable();
  const result = new Map();
  for (const [model, capability] of value) {
    if (!validKey(model) || !capability || typeof capability.fast !== 'boolean' ||
        (capability.ultrafast !== undefined && typeof capability.ultrafast !== 'boolean')) throw unavailable();
    result.set(model, { fast: capability.fast, ultrafast: capability.ultrafast ?? false });
  }
  return result;
}

export function createCapabilityCache({ load, now = Date.now, ttlMs = 3600000, retryMs = 30000 } = {}) {
  if (typeof load !== 'function' || typeof now !== 'function' || !Number.isSafeInteger(ttlMs) || ttlMs < 1 ||
      !Number.isSafeInteger(retryMs) || retryMs < 1) throw unavailable();
  const entries = new Map();
  let epoch = 0;
  let disposed = false;

  function lookup(scope) {
    if (!validKey(scope)) throw unavailable();
    return entries.get(scope);
  }
  function record(scope) {
    let entry = lookup(scope);
    if (!entry) {
      entry = { catalog: undefined, checkedAt: null, retryAt: 0, error: undefined, flight: undefined };
      entries.set(scope, entry);
    }
    return entry;
  }
  function get(scope, model, tier = 'fast') {
    if (tier !== 'fast' && tier !== 'ultrafast') throw unavailable();
    const entry = lookup(scope);
    const capability = validKey(model) ? entry?.catalog?.get(model) : undefined;
    const available = capability?.[tier] ?? null;
    return {
      available,
      stale: available === null || entry.checkedAt === null || now() - entry.checkedAt >= ttlMs || Boolean(entry.error),
      checkedAt: entry?.checkedAt ?? null,
      refreshing: Boolean(entry?.flight),
      ...(entry?.error ? { error: UNAVAILABLE } : {}),
    };
  }
  function refresh(scope, entry) {
    if (entry.flight) return entry.flight.promise;
    const ownedEpoch = epoch;
    const controller = new AbortController();
    const flight = { controller, promise: undefined };
    const aborted = new Promise((resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(unavailable()), { once: true });
    });
    const isCurrent = () => !disposed && epoch === ownedEpoch && entries.get(scope) === entry && entry.flight === flight;
    const loaded = Promise.resolve().then(() => {
      if (!isCurrent() || controller.signal.aborted) throw unavailable();
      return load(scope, { signal: controller.signal });
    });
    entry.flight = flight;
    flight.promise = Promise.race([loaded, aborted]).then(value => {
      if (!isCurrent()) throw unavailable();
      const catalog = copyCatalog(value);
      entry.catalog = catalog;
      entry.checkedAt = now();
      entry.retryAt = entry.checkedAt + retryMs;
      entry.error = undefined;
    }).catch(error => {
      if (isCurrent()) {
        let retryAfterMs = 0;
        try {
          if (Number.isFinite(error?.retryAfterMs) && error.retryAfterMs >= 0) retryAfterMs = Math.min(error.retryAfterMs, 86400000);
        } catch {}
        entry.error = UNAVAILABLE;
        entry.retryAt = now() + Math.max(retryMs, retryAfterMs);
      }
      throw unavailable();
    }).finally(() => {
      if (entry.flight === flight) entry.flight = undefined;
    });
    // Stale-while-revalidate never leaves an unhandled detached rejection.
    flight.promise.catch(() => {});
    return flight.promise;
  }
  function waitFor(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(unavailable());
    return new Promise((resolve, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); reject(unavailable()); };
      signal.addEventListener('abort', abort, { once: true });
      promise.then(value => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted) reject(unavailable()); else resolve(value);
      }, () => { signal.removeEventListener('abort', abort); reject(unavailable()); });
      if (signal.aborted) abort();
    });
  }
  async function ensure(scope, { model, tier = 'fast', force = false, signal } = {}) {
    if (disposed || (tier !== 'fast' && tier !== 'ultrafast') || (model !== undefined && !validKey(model)) ||
        typeof force !== 'boolean' || signal?.aborted ||
        (signal && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function'))) throw unavailable();
    const entry = record(scope);
    const selected = model === undefined ? undefined : entry.catalog?.get(model);
    const positive = model === undefined ? [...(entry.catalog?.values() ?? [])].some(value => value[tier]) : selected?.[tier] === true;
    const fresh = entry.catalog && !entry.error && now() - entry.checkedAt < ttlMs;
    const known = model === undefined ? Boolean(entry.catalog) : Boolean(selected);
    if (!force && fresh && known) return;
    // Preserve Fast's existing stale-while-revalidate path. The new, higher
    // cost Ultrafast tier requires a fresh positive before selection and use.
    if (!force && tier === 'fast' && positive) {
      if (entry.flight || !entry.error || now() >= entry.retryAt) refresh(scope, entry);
      return;
    }
    if (!entry.flight && now() < entry.retryAt && (entry.error || (!force && !known))) throw unavailable();
    await waitFor(refresh(scope, entry), signal);
    if (disposed || entries.get(scope) !== entry || (model !== undefined && !entry.catalog?.has(model))) throw unavailable();
  }
  function invalidate() {
    epoch++;
    for (const entry of entries.values()) entry.flight?.controller.abort();
    entries.clear();
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    invalidate();
  }
  return { get, ensure, invalidate, dispose };
}
