import { HYBRID_VARIANT, PARAMETRIC_VARIANT, LEGACY_VARIANT, HYBRID_SEED_DOMAIN, PARAMETRIC_SEED_DOMAIN, validImageVariant } from './image-variant.js';

export const IDENTITY_ENDPOINT = 'chat-switcher/images';

/** Length-delimited salt precedes the existing input; legacy art stays exact. */
export function identitySeed(sessionId, salt, variant) {
  if (!validImageVariant(variant)) throw new Error('Unsupported chat image variant');
  return typeof salt === 'string' && salt ? JSON.stringify([variant === PARAMETRIC_VARIANT ? PARAMETRIC_SEED_DOMAIN : variant === HYBRID_VARIANT ? HYBRID_SEED_DOMAIN : 'dsh-chat-image/v1', salt, sessionId]) : sessionId;
}

/** One cancellable, versioned subscription shared by all mosaic consumers. */
export function createIdentityClient({ call, later = setTimeout, cancel = clearTimeout } = {}) {
  let snapshot = { status: call ? 'connecting' : 'unavailable', records: new Map(), busy: new Set(), errors: new Map() };
  let generation;
  let revision;
  let baselineEpoch = 0;
  let controller;
  let retryTimer;
  const listeners = new Set();
  const operations = new Map();
  const publish = patch => { snapshot = { ...snapshot, ...patch }; for (const fn of [...listeners]) fn(); };
  function apply(data) {
    if (typeof data?.generation !== 'string' || !Number.isSafeInteger(data.revision) || data.revision < 0) throw new Error('Invalid chat image response');
    if (generation === data.generation && data.revision < revision) return;
    if (data.records !== undefined) {
      if (!Array.isArray(data.records) || data.records.some(row => typeof row?.sessionId !== 'string' || typeof row.salt !== 'string' || !Number.isSafeInteger(row.revision) || !validImageVariant(row.variant))) throw new Error('Invalid chat image records');
      const records = new Map(data.records.map(row => [row.sessionId, { ...row, generation: data.generation, catalogRevision: data.revision }]));
      // A click can settle before an older in-flight baseline. Preserve only
      // confirmed mutations beyond that baseline, but still accept its other
      // chats and advance the cursor only to this complete catalog cut.
      for (const [id, record] of snapshot.records) {
        if (record.generation === data.generation && record.catalogRevision > data.revision && (!records.has(id) || records.get(id).revision < record.revision)) records.set(id, record);
      }
      publish({ records, status: 'ready' });
    } else {
      if (generation !== data.generation) throw new Error('Chat image baseline required');
      publish({ status: 'ready' });
    }
    if (generation !== data.generation) baselineEpoch++;
    generation = data.generation; revision = data.revision;
  }
  function pause(signal, delay) {
    return new Promise(resolve => {
      function done() { if (retryTimer !== undefined) cancel(retryTimer); retryTimer = undefined; signal.removeEventListener('abort', done); resolve(); }
      signal.addEventListener('abort', done, { once: true });
      if (signal.aborted) done(); else retryTimer = later(done, delay);
    });
  }
  async function run(signal) {
    let delay = 500;
    while (!signal.aborted) {
      try {
        const response = await call({ action: 'watch', ...(generation === undefined ? {} : { generation, revision }) }, signal);
        if (signal.aborted) return;
        if (!response?.ok) throw new Error(response?.error?.message ?? 'Chat images unavailable');
        apply(response.value); delay = 500;
      } catch {
        if (signal.aborted) return;
        publish({ status: 'disconnected' });
        await pause(signal, delay); delay = Math.min(delay * 2, 10000);
      }
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    seed: sessionId => identitySeed(sessionId, snapshot.records.get(sessionId)?.salt, snapshot.records.get(sessionId)?.variant),
    start() { if (controller || !call) return; controller = new AbortController(); void run(controller.signal); },
    stop() { controller?.abort(); controller = undefined; for (const row of operations.values()) row.controller.abort(); operations.clear(); },
    regenerate(sessionId, referenceSalt, referenceVariant) {
      if (operations.has(sessionId)) return operations.get(sessionId).promise;
      if (!call) return Promise.reject(new Error('Chat image connection unavailable'));
      const operation = { controller: new AbortController(), baselineEpoch, expectedSalt: referenceSalt === undefined ? snapshot.records.get(sessionId)?.salt ?? null : referenceSalt, expectedGeneration: generation, expectedVariant: referenceVariant === undefined ? snapshot.records.get(sessionId)?.variant ?? LEGACY_VARIANT : referenceVariant };
      operations.set(sessionId, operation);
      const busy = new Set(snapshot.busy); busy.add(sessionId);
      const errors = new Map(snapshot.errors); errors.delete(sessionId);
      publish({ busy, errors });
      operation.promise = (async () => {
        try {
          const response = await call({ action: 'regenerate', sessionId, expectedSalt: operation.expectedSalt, expectedVariant: operation.expectedVariant, ...(operation.expectedGeneration === undefined ? {} : { expectedGeneration: operation.expectedGeneration }) }, operation.controller.signal);
          if (operation.controller.signal.aborted) throw new Error('Chat image change cancelled');
          if (!response?.ok) throw new Error(response?.error?.message ?? 'Could not change chat image');
          const record = response.value;
          if (record?.sessionId !== sessionId || typeof record.salt !== 'string' || !Number.isSafeInteger(record.revision) || typeof record.generation !== 'string' || !Number.isSafeInteger(record.catalogRevision) || !validImageVariant(record.variant)) throw new Error('Invalid chat image response');
          // A baseline from a replacement Host is authoritative. A late reply
          // from the retired generation must not roll that catalog back.
          if (generation !== undefined && record.generation !== generation && operation.baselineEpoch !== baselineEpoch) return record;
          const current = snapshot.records.get(sessionId);
          if (!current || current.generation !== record.generation || current.revision <= record.revision) {
            const records = new Map(snapshot.records); records.set(sessionId, record); publish({ records });
          }
          return record;
        } catch (error) {
          if (!operation.controller.signal.aborted) { const errors = new Map(snapshot.errors); errors.set(sessionId, error.message); publish({ errors }); }
          throw error;
        } finally {
          if (operations.get(sessionId) === operation) operations.delete(sessionId);
          const busy = new Set(snapshot.busy); busy.delete(sessionId); publish({ busy });
        }
      })();
      return operation.promise;
    },
  };
}
