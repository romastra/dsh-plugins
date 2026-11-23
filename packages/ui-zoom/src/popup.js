/** Plugin-owned view state, independent of the durable zoom preference. */
export function createZoomPopup() {
  const listeners = new Set();
  let opener;
  let disposed = false;
  let state = Object.freeze({ open: false, anchor: null, serial: 0 });
  const publish = patch => {
    if (disposed) return;
    state = Object.freeze({ ...state, ...patch });
    for (const listener of listeners) listener();
  };
  const close = (restoreFocus = false) => {
    if (!state.open) return;
    const target = opener;
    publish({ open: false });
    if (restoreFocus && target?.isConnected && !target.disabled) target.focus({ preventScroll: true });
  };
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    toggle(element) {
      if (disposed) return;
      if (state.open && opener === element) { close(true); return; }
      const { left, right, top, bottom } = element.getBoundingClientRect();
      opener = element;
      publish({ open: true, anchor: { left, right, top, bottom }, serial: state.serial + 1 });
    },
    close,
    containsOpener(target) { return !!opener?.contains(target); },
    detach(element) { if (opener === element) { close(false); opener = undefined; } },
    dispose() { disposed = true; opener = undefined; listeners.clear(); },
  };
}
