import { orderCandidates } from './controller.js';
import { liveInteractionKind } from './status.js';

/**
 * Order already-eligible main chats, without widening that eligibility:
 * 0 current, 1 live requests/questions, 2 actual errors, 3 proven successful
 * completions, 4 the remaining pinned/working/attention chats in existing MRU.
 *
 * The current sound bridge publishes only kind/reminderActive/reason. Its rows
 * are immutable but are recreated for unrelated changes, and same-kind event
 * replacement is not exposed. For that bridge an uninterrupted session+kind
 * episode receives one browser-local firstObserved time, NOT row-object age.
 * A disappearance, changed kind, or supplied new eventId starts a fresh episode.
 * All first observations in one call share one clock sample: old notices first
 * seen together have unknown original chronology and therefore tie by MRU.
 *
 * Optional future bridge metadata: eventId identifies replacement, occurredAt
 * (preferred) / receivedAt are finite nonnegative epoch milliseconds. Zero is
 * valid; null, negative, non-finite and coerced/string values are not times.
 * These fields are NOT claimed to exist in the current sound bridge contract.
 * Pending requests use its existing callId ?? key identity, else their stable
 * request object. The tracker owns at most two current signals per candidate;
 * it never retains historical events, reads history or acknowledges anything.
 */
export function createPriorityOrder({ now = () => Date.now() } = {}) {
  let tracked = new Map();

  const validTime = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const validKey = value => (typeof value === 'string' && value.length > 0) || (typeof value === 'number' && Number.isFinite(value));
  function pendingIdentity(request) {
    try {
      if (validKey(request.callId)) return { field: 'callId', key: request.callId };
      if (validKey(request.key)) return { field: 'key', key: request.key };
    } catch { /* disposed getters do not turn a read-only sort into a failure */ }
    return { field: 'object', key: request };
  }
  function noticeIdentity(notice) {
    if (validKey(notice.eventId)) return { field: 'eventId', key: notice.eventId };
    // The absence of a published event id is a continuous visible episode, not
    // permission to invent a new event whenever a frozen bridge row is rebuilt.
    return { field: 'episode', key: notice.kind };
  }
  const sameSignal = (a, b) => a && a.rank === b.rank && a.kind === b.kind && a.field === b.field && a.key === b.key;

  function order(items, { currentId = null, history = [], status = new Map(), attention = new Map() } = {}) {
    const baseline = orderCandidates(items, history);
    const next = new Map();
    let sampled = false, observedAt;
    const firstObserved = () => {
      if (!sampled) {
        sampled = true;
        try { observedAt = validTime(now()); } catch { observedAt = null; }
      }
      return observedAt;
    };
    function timeOf(id, channel, signal, published = null) {
      const previous = tracked.get(id)?.[channel];
      const matching = sameSignal(previous, signal);
      // Published event time, when supplied, is authoritative over a local
      // first-observation estimate. Keep its earliest value for this identity.
      const time = published !== null
        ? matching && previous.published ? Math.min(previous.time, published) : published
        : matching ? previous.time : firstObserved();
      const entry = { ...signal, time, published: published !== null || Boolean(matching && previous.published) };
      let row = next.get(id);
      if (!row) next.set(id, row = {});
      row[channel] = entry;
      return time;
    }
    const ranked = baseline.map((item, index) => {
      const state = status.get(item.id);
      const notice = attention.get(item.id);
      const pending = state?.pendingInteraction;
      const pendingKind = liveInteractionKind(pending);
      const signals = [];
      if (pendingKind) {
        const signal = { rank: 1, kind: pendingKind, ...pendingIdentity(pending) };
        signals.push({ rank: 1, time: timeOf(item.id, 'pending', signal) });
      }
      let noticeRank = 4;
      if (notice?.kind === 'approval' || notice?.kind === 'question' || notice?.kind === 'plan-review') noticeRank = 1;
      else if (notice?.kind === 'attention' && notice.reason === 'error') noticeRank = 2;
      else if (notice?.kind === 'completion') noticeRank = 3;
      // completionUnread only establishes an unread stop, not successful work.
      // Likewise generic attention/aborted/blocked/max-tokens is not an error.
      if (noticeRank < 4) {
        const signal = { rank: noticeRank, kind: notice.kind, ...noticeIdentity(notice) };
        const published = validTime(notice.occurredAt) ?? validTime(notice.receivedAt);
        signals.push({ rank: noticeRank, time: timeOf(item.id, 'notice', signal, published) });
      }
      const rank = item.id === currentId ? 0 : signals.reduce((rank, signal) => Math.min(rank, signal.rank), 4);
      const times = signals.filter(signal => signal.rank === rank && signal.time !== null).map(signal => signal.time);
      return { item, index, rank, time: times.length ? Math.min(...times) : null };
    });
    // Replacement rather than accumulation also drops removed candidates,
    // closed requests, cleared notices, and objects no longer owned by a source.
    tracked = next;
    ranked.sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      if (a.rank > 0 && a.rank < 4) {
        // A failed clock has no chronology. Known ages sort before unknown ones;
        // unknown/tied ages use the original MRU/input order, transitively.
        if (a.time !== null && b.time !== null && a.time !== b.time) return a.time - b.time;
        if ((a.time === null) !== (b.time === null)) return a.time === null ? 1 : -1;
      }
      return a.index - b.index;
    });
    return ranked.map(row => row.item);
  }
  return {
    order,
    clear() { tracked.clear(); },
    get size() { return tracked.size; },
  };
}
