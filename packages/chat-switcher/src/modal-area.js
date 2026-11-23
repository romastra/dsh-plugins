function rectSnapshot(rect) {
  if (!rect) return null;
  const { left, top, width, height } = rect;
  if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return { left, top, width, height };
}

/** Physical chat-area bounds become CSS pixels under the root's CSS zoom. */
export function modalAreaStyle(rect, zoom = 1) {
  const area = rectSnapshot(rect);
  if (!area) return null;
  const effectiveZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return {
    position: 'fixed',
    margin: 0,
    inset: 'auto',
    left: (area.left + 0.05 * area.width) / effectiveZoom + 'px',
    top: (area.top + 0.05 * area.height) / effectiveZoom + 'px',
    width: 0.9 * area.width / effectiveZoom + 'px',
    height: 0.9 * area.height / effectiveZoom + 'px',
    maxWidth: 'none',
    maxHeight: 'none',
  };
}

const normalizeSession = value => value == null || value === '' ? null : value;
const sameRect = (a, b) => a === b || !!a && !!b
  && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;

/**
 * Measure only the inset-zero area probe owned by our Conversation HOC.
 * The core content ancestor supplies identity, never geometry or chat text.
 * Call refresh after a committed session change, even if no resize occurred.
 */
export function createModalAreaTracker({ getCurrent, onChange, view }) {
  const registrations = new Map();
  let previous = null, disposed = false, listening = false, viewport = null;

  function refresh() {
    if (disposed) return;
    const current = normalizeSession(getCurrent());
    let next = null;
    for (const [frame, registration] of registrations) {
      const area = registration.area;
      if (!frame.isConnected || !area.isConnected || frame.closest?.('[data-rightbar-col]')) continue;
      const content = frame.closest?.('[data-conversation-content]');
      if (!content || normalizeSession(content.dataset?.conversationSession) !== current) continue;
      next = rectSnapshot(area.getBoundingClientRect());
      if (next) break;
    }
    if (sameRect(previous, next)) return;
    // Keep the comparison baseline independent of consumers mutating a snapshot.
    previous = next ? { ...next } : null;
    onChange(next);
  }

  function startListening() {
    if (listening) return;
    listening = true;
    viewport = view?.visualViewport ?? null;
    view?.addEventListener?.('resize', refresh);
    viewport?.addEventListener?.('resize', refresh);
    viewport?.addEventListener?.('scroll', refresh);
  }

  function stopListening() {
    if (!listening) return;
    listening = false;
    view?.removeEventListener?.('resize', refresh);
    viewport?.removeEventListener?.('resize', refresh);
    viewport?.removeEventListener?.('scroll', refresh);
    viewport = null;
  }

  function register(frame, ownedAreaElement) {
    if (disposed || !frame || !ownedAreaElement) return () => {};
    registrations.get(frame)?.observer?.disconnect();
    const registration = { area: ownedAreaElement, observer: null };
    registrations.set(frame, registration);
    startListening();
    if (typeof view?.ResizeObserver === 'function') {
      registration.observer = new view.ResizeObserver(refresh);
      registration.observer.observe(ownedAreaElement);
    }
    refresh();
    return () => {
      // A previous registration's disposer must not remove a replacement.
      if (disposed || registrations.get(frame) !== registration) return;
      registrations.delete(frame);
      registration.observer?.disconnect();
      if (!registrations.size) stopListening();
      refresh();
    };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const registration of registrations.values()) registration.observer?.disconnect();
    registrations.clear();
    stopListening();
    previous = null;
  }

  return { register, refresh, dispose };
}

/** Keep dialog CSS coordinates fresh even when zoom changes but its area's
 * viewport rectangle happens to stay numerically identical. */
export function bindModalAreaStyle({ view, getArea, getZoom, changed }) {
  let disposed = false, previousKey;
  const update = () => {
    if (disposed) return;
    const style = modalAreaStyle(getArea(), getZoom());
    const key = style ? [style.left, style.top, style.width, style.height].join('|') : 'none';
    if (key === previousKey) return;
    previousKey = key;
    changed(style);
  };
  const viewport = view?.visualViewport;
  view?.addEventListener?.('resize', update);
  viewport?.addEventListener?.('resize', update);
  viewport?.addEventListener?.('scroll', update);
  update();
  return () => {
    if (disposed) return;
    disposed = true;
    view?.removeEventListener?.('resize', update);
    viewport?.removeEventListener?.('resize', update);
    viewport?.removeEventListener?.('scroll', update);
  };
}
