// Optional read-only Client service consumer. The provider alone owns its
// palette, index->hex mapping and persistence; this bridge never reads CSS/DOM.
export const EMPTY_WORKSPACE_COLORS = Object.freeze({
  active: false, generation: '', revision: 0, colors: Object.freeze({}),
});
const csWorkspaceHex = /^#[0-9a-f]{6}$/i;
const csWorkspaceRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function csWorkspaceColorSnapshot(value) {
  if (!csWorkspaceRecord(value) || typeof value.generation !== 'string'
    || !Number.isSafeInteger(value.revision) || value.revision < 0 || !csWorkspaceRecord(value.colors)) return EMPTY_WORKSPACE_COLORS;
  const colors = Object.fromEntries(Object.entries(value.colors)
    .filter(([id, color]) => id.length > 0 && typeof color === 'string' && csWorkspaceHex.test(color))
    .map(([id, color]) => [id, color.toLowerCase()]));
  return Object.freeze({ active: true, generation: value.generation, revision: value.revision, colors: Object.freeze(colors) });
}

/** Stable external store independent of the optional provider's lifetime.
 * A detached/replaced provider cannot publish through a queued old callback.
 */
export function createWorkspaceColorBridge() {
  let snapshot = EMPTY_WORKSPACE_COLORS, connection = null, disposed = false;
  const listeners = new Set();
  const publish = next => {
    if (snapshot === next || (snapshot.active === next.active && snapshot.generation === next.generation
      && snapshot.revision === next.revision && Object.keys(snapshot.colors).length === Object.keys(next.colors).length
      && Object.keys(snapshot.colors).every(id => Object.hasOwn(next.colors, id) && snapshot.colors[id] === next.colors[id]))) return;
    snapshot = next;
    for (const fn of [...listeners]) fn();
  };
  const detach = (clear = true) => {
    const old = connection;
    connection = null;
    try { old?.off?.(); } catch { /* A retiring optional service cannot break teardown. */ }
    if (clear) publish(EMPTY_WORKSPACE_COLORS);
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(fn) { if (disposed) return () => {}; listeners.add(fn); return () => listeners.delete(fn); },
    connect(source) {
      if (disposed) return () => {};
      detach(false);
      const ticket = { off: null, hasLast: false, last: null };
      connection = ticket;
      const disconnect = () => { if (connection === ticket) detach(); };
      const sync = () => {
        if (disposed || connection !== ticket) return;
        try {
          const value = source.getSnapshot();
          if (ticket.hasLast && value === ticket.last) return;
          ticket.hasLast = true; ticket.last = value;
          publish(csWorkspaceColorSnapshot(value));
        } catch { ticket.hasLast = false; publish(EMPTY_WORKSPACE_COLORS); }
      };
      try {
        if (typeof source?.getSnapshot !== 'function' || typeof source?.subscribe !== 'function') throw new Error('Unavailable source');
        sync();
        ticket.off = source.subscribe(sync);
        if (typeof ticket.off !== 'function') throw new Error('Unavailable subscription');
        sync(); // Cover a source update between the initial read and subscribe.
      } catch { disconnect(); }
      return disconnect;
    },
    dispose() { if (disposed) return; detach(); disposed = true; listeners.clear(); },
  };
}

export function workspaceColor(snapshot, workspaceId) {
  if (!snapshot?.active || typeof workspaceId !== 'string' || !workspaceId
    || !csWorkspaceRecord(snapshot.colors) || !Object.hasOwn(snapshot.colors, workspaceId)) return null;
  const color = snapshot.colors[workspaceId];
  return typeof color === 'string' && csWorkspaceHex.test(color) ? color : null;
}

/** Only a custom property on our card; no foreground/descendant style changes. */
export function workspaceTintStyle(color) {
  return typeof color === 'string' && csWorkspaceHex.test(color) ? { '--cs-workspace-color': color } : undefined;
}

export const WORKSPACE_TINT_CSS = `
@supports (background:color-mix(in srgb,#000000 18%,#ffffff)){
.cs-card[data-cs-workspace-tinted=true]{background:color-mix(in srgb,var(--cs-workspace-color) 18%,var(--dsw-alias-bg-layer-2))}
@media(hover:hover){
.cs-dialog .cs-card[data-cs-workspace-tinted=true]:hover{background:color-mix(in srgb,var(--cs-workspace-color) 24%,var(--dsw-alias-bg-layer-2))}
}
}
.cs-card[data-cs-workspace-tinted=true]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.cs-card[data-cs-workspace-tinted=true] .cs-workspace-name{color:var(--dsw-alias-label-primary)}
`;
