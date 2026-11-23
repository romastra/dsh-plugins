export const RECENT_VISITS_KEY = '@local/chat-switcher/visits/v1';
export const RECENT_VISIT_TTL = 60 * 60 * 1000;

/**
 * Browser-local visit timestamps, independent of the legacy MRU id list.
 * Storage v1 is JSON [[nonemptyStringId, epochMilliseconds], ...], newest first.
 * Only explicit record(id) writes storage; reads prune memory without rewriting
 * user data, and clear() is teardown only (it never erases persisted visits).
 *
 * No timers, polling, history reads, RPC or implicit window/localStorage access.
 * Every operation samples now() once, not once per id. A backwards clock drops
 * now-future visits rather than clamping their timestamps or inventing ages.
 */
export function createRecentVisits({ storage, now = () => Date.now(), limit = 1000 } = {}) {
  const capacity = Number.isSafeInteger(limit) && limit >= 0 ? Math.min(limit, 1000) : 1000;
  const validId = id => typeof id === 'string' && id.length > 0;
  const validEpoch = value => Number.isSafeInteger(value) && value >= 0;
  let visits = new Map();
  const clock = () => {
    try { const value = now(); return validEpoch(value) ? value : null; }
    catch { return null; }
  };
  function prune(at) {
    if (at === null) return;
    for (const [id, timestamp] of visits) {
      if (timestamp > at || at - timestamp >= RECENT_VISIT_TTL) visits.delete(id);
    }
  }
  function bound() {
    // Stable sort retains original input order for identical timestamps. Map
    // also deduplicates hostile/prototype-like ids without object-key hazards.
    visits = new Map([...visits].sort((a, b) => b[1] - a[1]).slice(0, capacity));
  }
  function persist() {
    try { storage?.setItem(RECENT_VISITS_KEY, JSON.stringify([...visits])); }
    catch { /* unavailable storage/quota leaves the bounded memory usable */ }
  }

  const initialNow = clock();
  try {
    const raw = storage?.getItem(RECENT_VISITS_KEY);
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) {
      for (const row of parsed) {
        if (!Array.isArray(row) || row.length !== 2 || !validId(row[0]) || !validEpoch(row[1])) continue;
        const [id, timestamp] = row;
        if (initialNow !== null && (timestamp > initialNow || initialNow - timestamp >= RECENT_VISIT_TTL)) continue;
        const previous = visits.get(id);
        if (previous === undefined || timestamp > previous) visits.set(id, timestamp);
      }
    }
  } catch { /* corrupt JSON or denied storage starts with a memory-only cache */ }
  bound();

  return {
    /** True iff a valid explicit visit is retained in memory; storage may fail. */
    record(id) {
      const at = clock();
      if (!validId(id) || at === null) return false;
      prune(at);
      visits.set(id, at);
      bound();
      persist();
      return visits.has(id);
    },
    /** Detached Set. A visit is recent exactly while 0 <= now-lastSeen < 1h. */
    getRecentIds() {
      const at = clock();
      if (at === null) return new Set();
      prune(at);
      return new Set(visits.keys());
    },
    /** Earliest absolute expiry for the supplied iterable of ids (all if omitted). */
    nextExpiry(ids) {
      const at = clock();
      if (at === null) return null;
      prune(at);
      let expiry = null;
      const candidates = ids === undefined ? visits.keys() : ids;
      if (candidates == null || typeof candidates[Symbol.iterator] !== 'function') return null;
      for (const id of candidates) {
        if (!validId(id)) continue;
        const timestamp = visits.get(id);
        if (timestamp === undefined) continue;
        const end = timestamp + RECENT_VISIT_TTL;
        if (Number.isFinite(end) && (expiry === null || end < expiry)) expiry = end;
      }
      return expiry;
    },
    /** Retained memory count, already bounded; does not sample a clock. */
    get size() { return visits.size; },
    clear() { visits.clear(); },
  };
}
