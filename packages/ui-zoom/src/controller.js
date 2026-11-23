import { isZoomPercent, nextZoom } from './scale.js';

/** Browser preference adapter; dragging previews locally and saves once on release. */
export function createZoomController(form) {
  const listeners = new Set();
  let disposed = false;
  let pending = 0;
  let generation = 0;
  let previewing = false;
  let state = Object.freeze({ percent: 100, ready: false, writable: false, pending: false, previewing: false, persistent: true, error: false, notice: 0 });
  const publish = patch => {
    if (disposed) return;
    state = Object.freeze({ ...state, ...patch });
    for (const listener of listeners) listener();
  };
  const sync = () => {
    const snapshot = form.getSnapshot();
    const ready = snapshot.status === 'ready' && isZoomPercent(snapshot.value?.percent);
    publish({
      ready, writable: ready && snapshot.writable, persistent: snapshot.persistent !== false,
      ...(pending === 0 && !previewing && ready ? {
        percent: snapshot.value.percent,
        ...(snapshot.persistent !== false ? { error: false } : {}),
      } : {}),
    });
  };
  const unsubscribe = form.subscribe(sync);
  sync();
  const persist = async percent => {
    if (disposed) return false;
    if (!isZoomPercent(percent)) throw new RangeError('Invalid zoom percentage.');
    previewing = false;
    if (!state.ready || !state.writable) {
      sync();
      publish({ previewing: false, error: true, notice: state.notice + 1 });
      return false;
    }
    const saved = form.getSnapshot().value?.percent;
    if (pending === 0 && percent === saved && form.getSnapshot().persistent !== false) {
      publish({ percent, previewing: false, error: false, notice: state.notice + 1 });
      return true;
    }
    const ticket = ++generation;
    pending++;
    publish({ percent, previewing: false, pending: true, error: false, notice: state.notice + 1 });
    let accepted = false;
    try { accepted = await form.set('percent', percent); }
    catch { accepted = false; }
    finally {
      pending--;
      if (!disposed) {
        if (pending === 0) sync();
        publish({ pending: pending !== 0, ...(ticket === generation ? { error: !accepted } : {}) });
      }
    }
    return accepted;
  };
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async change(action) {
      if (disposed) return false;
      const percent = nextZoom(state.percent, action);
      if (percent === state.percent && !previewing && state.ready && state.writable && state.persistent) {
        publish({ error: false, notice: state.notice + 1 });
        return true;
      }
      return persist(percent);
    },
    set: persist,
    preview(percent) {
      if (disposed || !state.ready || !state.writable) return false;
      if (!isZoomPercent(percent)) throw new RangeError('Invalid zoom percentage.');
      previewing = true;
      if (percent !== state.percent || !state.previewing) publish({ percent, previewing: true, error: false });
      return true;
    },
    async commit() {
      if (disposed || !previewing) return true;
      return persist(state.percent);
    },
    dispose() { disposed = true; unsubscribe(); listeners.clear(); },
  };
}
