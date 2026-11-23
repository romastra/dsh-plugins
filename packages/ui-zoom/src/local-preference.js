import { isZoomPercent } from './scale.js';

export const STORAGE_KEY = 'dsh.ui-zoom.browser.v1';

/** Decode only this browser preference's versioned JSON document, without coercion. */
export function decodeStoredZoom(raw) {
  if (typeof raw !== 'string') return undefined;
  try {
    const record = JSON.parse(raw);
    if (record === null || typeof record !== 'object' || Array.isArray(record)
      || record.version !== 1 || !isZoomPercent(record.percent)) return undefined;
    return record.percent;
  } catch {
    return undefined;
  }
}

function snapshot(percent, persistent, problem) {
  return Object.freeze({
    status: 'ready', value: Object.freeze({ percent }), writable: true, persistent, problem,
  });
}

function storedSnapshot(raw) {
  const percent = decodeStoredZoom(raw);
  const valid = raw === null || percent !== undefined;
  return snapshot(percent ?? 100, valid, valid ? null : 'invalid');
}

/**
 * ConfigForm-shaped, browser-local preference. Both browser capabilities are
 * injected so importing this module never touches a window, DOM, or Host service.
 * A failed save accepts the chosen value in memory but reports false to callers.
 */
export function createLocalZoomPreference({ getStorage, subscribeStorage }) {
  const listeners = new Set();
  let disposed = false;
  let observedRaw;
  let hasObservedRaw = false;
  let memoryOnly = false;
  let state;

  try {
    observedRaw = getStorage().getItem(STORAGE_KEY);
    hasObservedRaw = true;
    state = storedSnapshot(observedRaw);
  } catch {
    state = snapshot(100, false, 'read');
  }

  const publish = (next, force = false) => {
    if (disposed) return;
    if (!force && state.value.percent === next.value.percent
      && state.persistent === next.persistent && state.problem === next.problem) return;
    state = next;
    for (const listener of listeners) listener();
  };

  const onStorage = event => {
    if (disposed || !event || (event.key !== STORAGE_KEY && event.key !== null)) return;
    let storage;
    try { storage = getStorage(); }
    catch { return; }
    // Storage events may also describe sessionStorage or another injected backend.
    if (event.storageArea != null && event.storageArea !== storage) return;
    let raw;
    try { raw = storage.getItem(STORAGE_KEY); }
    catch {
      publish(snapshot(state.value.percent, false, 'read'));
      return;
    }
    // A delayed event must not discard an unsaved tab-local choice when the
    // underlying durable value has not changed since it was last observed.
    if (memoryOnly && (!hasObservedRaw || raw === observedRaw)) return;
    observedRaw = raw;
    hasObservedRaw = true;
    memoryOnly = false;
    // Read the actual latest record, never the potentially stale event.newValue.
    publish(storedSnapshot(raw));
  };
  const unsubscribeStorage = subscribeStorage(onStorage);

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async set(field, percent) {
      if (disposed || field !== 'percent' || !isZoomPercent(percent)) return false;
      const raw = JSON.stringify({ version: 1, percent });
      let persistent = false;
      let storage;
      try {
        // Retry the getter on every explicit change, allowing blocked storage to recover.
        storage = getStorage();
        storage.setItem(STORAGE_KEY, raw);
        observedRaw = raw;
        hasObservedRaw = true;
        persistent = true;
      } catch {
        // Capture the durable baseline at this failed choice, not at initial load.
        // Older queued events must not replace the user's newer tab-local value.
        hasObservedRaw = false;
        if (storage) {
          try { observedRaw = storage.getItem(STORAGE_KEY); hasObservedRaw = true; }
          catch { /* Without a readable baseline, retain memory until an explicit save succeeds. */ }
        }
      }
      memoryOnly = !persistent;
      publish(snapshot(percent, persistent, persistent ? null : 'write'), true);
      return persistent;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      unsubscribeStorage();
    },
  };
}
