// Installed DSH 0.2.2-rc.3: ui-context-menu's public embedded-resolution
// face delegates these rows to ui-workspace's existing actions and prompts.
// Keep the exact published ids: the native archive id also represents Restore,
// so membership and icon checks below must guard both display and selection.
const csSessionMenuIds = new Set(['session.pin/pin', 'session.rename/rename', 'session.fork/fork', 'session.id/copy', 'session.archive/archive']);
const csSessionMenuEmpty = Object.freeze([]);

/** No business calls occur until resolve/newSession/select is explicitly used. */
export function createSessionActions({ contextMenus, uiWorkspace, workspaces }) {
  return {
    // Exactly the native sidebar's unscoped New Session behavior: no prompt,
    // submission, explicit Session creation, or replacement of an unsent draft.
    newSession: () => uiWorkspace.startSession(),
    resolve(item) {
      const id = item.id;
      const native = contextMenus.resolve({ kind: 'session', value: {
        // Native Session rows pass the stored title (empty when unnamed),
        // never the preview's display fallback or the Session id.
        sessionId: id, displayTitle: !item.blank && typeof item.title === 'string' ? item.title.trim() : '',
      } });
      const subscriptions = new Set();
      let disposed = false, previous, previousArchived, projected = csSessionMenuEmpty;
      const archived = () => workspaces.list.getSnapshot().archivedSessionIds.includes(id);
      const getSnapshot = () => {
        if (disposed) return csSessionMenuEmpty;
        const rows = native.source.getSnapshot(), hidden = archived();
        if (rows !== previous || hidden !== previousArchived) {
          previous = rows; previousArchived = hidden;
          projected = hidden ? csSessionMenuEmpty : rows.filter(row => csSessionMenuIds.has(row.id)
            && row.icon?.key !== 'workspace.unarchive' && row.children === undefined);
        }
        return projected;
      };
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        for (const off of [...subscriptions]) off();
        native.dispose();
      };
      return {
        source: {
          getSnapshot,
          subscribe(listener) {
            if (disposed) return () => {};
            const offNative = native.source.subscribe(listener);
            const offWorkspace = workspaces.list.subscribe(listener);
            let active = true;
            const off = () => {
              if (!active) return;
              active = false; subscriptions.delete(off); offNative(); offWorkspace();
            };
            subscriptions.add(off);
            return off;
          },
        },
        ready: native.ready,
        select(actionId) {
          // Recheck current membership and native permissions, not a stale row
          // captured before archive or permission changes arrived.
          const row = getSnapshot().find(action => action.id === actionId);
          if (!row || row.disabled) return false;
          try { native.select(actionId); } finally { dispose(); }
          return true;
        },
        dispose,
      };
    },
  };
}

/** Element-owned press state; no document listeners, editor changes or click ban. */
export function createCardContextPress({ onOpen, enabled = () => true, later = setTimeout, cancel = clearTimeout, delayMs = 500, movePx = 6 }) {
  let timer = null, press = null, consumed = null, disposed = false;
  const clearTimer = () => { if (timer !== null) cancel(timer); timer = null; };
  const prevent = event => { event.preventDefault?.(); event.stopPropagation?.(); };
  const same = (event, candidate) => event.pointerId === undefined || candidate.pointerId === undefined || event.pointerId === candidate.pointerId;
  const open = (candidate, trigger) => {
    if (disposed || !enabled() || candidate.opened || candidate.canceled) return;
    clearTimer(); candidate.opened = true;
    consumed = { pointerId: candidate.pointerId, pointerType: candidate.pointerType, clickPending: true };
    onOpen({ x: candidate.x, y: candidate.y, pointerId: candidate.pointerId, pointerType: candidate.pointerType, trigger });
  };
  const handlers = {
    onPointerDown(event) {
      if (disposed || !enabled()) return;
      if (event.isPrimary === false) {
        clearTimer(); if (press) press.canceled = true;
        return;
      }
      clearTimer(); press = null; consumed = null;
      if (!['touch', 'pen'].includes(event.pointerType) || event.button > 0) return;
      const candidate = { pointerId: event.pointerId, pointerType: event.pointerType, x: event.clientX, y: event.clientY, opened: false, canceled: false };
      press = candidate;
      timer = later(() => { timer = null; if (press === candidate) open(candidate, 'hold'); }, delayMs);
    },
    onPointerMove(event) {
      if (!press || press.ended || !same(event, press)) return;
      if (!press.opened && Math.hypot(event.clientX - press.x, event.clientY - press.y) > movePx) {
        clearTimer(); press.canceled = true;
      }
    },
    onPointerUp(event) {
      if (!press || !same(event, press)) return;
      clearTimer();
      if (press.opened) event.preventDefault?.();
      press.ended = true;
    },
    onPointerCancel(event) {
      if (!press || !same(event, press)) return;
      clearTimer(); press.canceled = true; press.ended = true;
    },
    onContextMenu(event) {
      if (disposed || !enabled()) return;
      prevent(event);
      // A browser's own touch contextmenu can precede or follow our timer.
      // Neither order may open a second occurrence for the same press.
      if (press && same(event, press)) {
        open(press, 'contextmenu');
        return;
      }
      if (consumed && same(event, consumed)) return;
      open({ pointerId: event.pointerId, pointerType: event.pointerType || 'mouse', x: event.clientX, y: event.clientY, opened: false, canceled: false }, 'contextmenu');
    },
    onClickCapture(event) {
      if (!consumed?.clickPending || event.detail === 0) return;
      const compatibleMouse = !event.pointerType || (event.pointerType === 'mouse' && consumed.pointerType === 'touch');
      if (!same(event, consumed) && !compatibleMouse) return;
      consumed.clickPending = false;
      prevent(event);
    },
  };
  return { ...handlers, dispose() { disposed = true; clearTimer(); press = null; consumed = null; } };
}

export const SESSION_MENU_CSS = `
.cs-dialog [data-cs-context-card]{user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}
.cs-session-menu:not([open]){display:none!important}
.cs-session-menu{position:fixed;inset:auto;margin:0;box-sizing:border-box;width:250px;max-width:calc(100vw - 16px);max-height:calc(100dvh - 16px);overflow:auto;padding:5px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font:inherit;-webkit-app-region:no-drag;overscroll-behavior:contain}
.cs-session-menu::backdrop{background:transparent}
.cs-session-menu-list{display:flex;flex-direction:column;gap:2px;outline:none}
.cs-session-menu-item{display:flex;align-items:center;gap:10px;box-sizing:border-box;width:100%;min-height:40px;padding:8px 10px;border:0;border-radius:7px;text-align:start;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:1.4;cursor:pointer}
.cs-session-menu-item:hover:not(:disabled),.cs-session-menu-item:focus-visible{background:var(--dsw-alias-bg-layer-2)}
.cs-session-menu-item:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.cs-session-menu-item:disabled{color:var(--dsw-alias-label-secondary);cursor:default}
.cs-session-menu-item svg{flex:none;width:18px;height:18px;pointer-events:none}
.cs-session-menu-item span{overflow-wrap:anywhere}
.cs-session-menu-separator{height:0;border:0;border-top:1px solid var(--dsw-alias-border-l1);margin:4px 5px}
.cs-session-menu-status{margin:0;padding:10px;color:var(--dsw-alias-label-secondary);font-size:14px}
.cs-session-menu-error{margin:0;padding:10px;color:var(--dsw-alias-state-error-primary);font-size:14px;overflow-wrap:anywhere}
`;

function csSessionMenuPosition(node, anchor) {
  const view = node.ownerDocument.defaultView;
  const zoom = Number(node.currentCSSZoom) || Number.parseFloat(view.getComputedStyle?.(node.ownerDocument.documentElement).zoom) || 1;
  const width = view.visualViewport?.width ?? view.innerWidth;
  const height = view.visualViewport?.height ?? view.innerHeight;
  const originX = view.visualViewport?.offsetLeft ?? 0, originY = view.visualViewport?.offsetTop ?? 0;
  node.style.maxWidth = Math.max(0, width - 16) / zoom + 'px';
  node.style.maxHeight = Math.max(0, height - 16) / zoom + 'px';
  const rect = node.getBoundingClientRect();
  const x = Math.max(originX + 8, Math.min(anchor?.x ?? originX + 8, originX + width - rect.width - 8));
  const y = Math.max(originY + 8, Math.min(anchor?.y ?? originY + 8, originY + height - rect.height - 8));
  node.style.left = x / zoom + 'px'; node.style.top = y / zoom + 'px';
}

/** React-only top-layer renderer. Native action labels and callbacks stay native. */
export function createSessionMenu(React) {
  const h = React.createElement;
  function useCardContext({ onOpen }) {
    const callback = React.useRef(onOpen);
    callback.current = onOpen;
    const owned = React.useRef(null);
    React.useLayoutEffect(() => {
      const press = createCardContextPress({ onOpen: point => callback.current(point), enabled: () => typeof callback.current === 'function' });
      owned.current = press;
      return () => { owned.current = null; press.dispose(); };
    }, []);
    return React.useMemo(() => Object.fromEntries(['onPointerDown', 'onPointerMove', 'onPointerUp', 'onPointerCancel', 'onContextMenu', 'onClickCapture'].map(name => [name, event => owned.current?.[name](event)])), []);
  }
  function Glyph({ icon }) {
    const path = {
      'workspace.pin': 'M8 3h8l-1 6 3 4H6l3-4-1-6Zm4 10v8',
      'workspace.unpin': 'm3 3 18 18M9 3h7l-1 6 3 4h-4M6 13h4m2 2v6',
      'workspace.rename': 'm15 4 5 5M4 20l5-1L21 7l-5-5L4 14v6Z',
      'workspace.fork': 'M7 3v11a5 5 0 0 0 5 5h5M7 9h5a5 5 0 0 0 5-5m-3 12 3 3-3 3m0-15 3-3-3-3',
      'workspace.copy': 'M8 8h12v13H8V8Zm8-3V2H3v15h2',
      'workspace.archive': 'M3 4h18v4H3V4Zm2 4v13h14V8m-9 5h4',
    }[icon?.key];
    return path ? h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: path })) : null;
  }
  function SessionMenu({ model, onClose, onAction, busy = false, error = '', t = key => key }) {
    const dialog = React.useRef(null);
    const focusPending = React.useRef(true);
    React.useLayoutEffect(() => {
      const node = dialog.current;
      if (!node || !model) return;
      const previous = node.ownerDocument.activeElement;
      focusPending.current = true;
      if (!node.open) node.showModal();
      return () => {
        // A selection already closed this dialog before native prompts run.
        // Do not steal their focus later during the controlled unmount.
        if (node.open) {
          node.close();
          if (previous?.isConnected !== false) previous?.focus?.({ preventScroll: true });
        }
      };
    }, [model?.id]);
    React.useLayoutEffect(() => {
      const node = dialog.current;
      if (!node || !model) return;
      const position = () => csSessionMenuPosition(node, model.anchor);
      position();
      const first = node.querySelector('[role="menuitem"]:not(:disabled)');
      if (focusPending.current && first) { first.focus({ preventScroll: true }); focusPending.current = false; }
      else if (!first) node.querySelector('[role="menu"]')?.focus({ preventScroll: true });
      const view = node.ownerDocument.defaultView;
      view.addEventListener('resize', position);
      view.visualViewport?.addEventListener('resize', position);
      view.visualViewport?.addEventListener('scroll', position);
      return () => {
        view.removeEventListener('resize', position);
        view.visualViewport?.removeEventListener('resize', position);
        view.visualViewport?.removeEventListener('scroll', position);
      };
    }, [model, busy, error]);
    if (!model) return null;
    const close = () => { if (dialog.current?.open) dialog.current.close(); onClose(); };
    const keyDown = event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
      event.preventDefault();
      const buttons = [...dialog.current.querySelectorAll('[role="menuitem"]:not(:disabled)')];
      if (!buttons.length) return;
      const current = buttons.indexOf(dialog.current.ownerDocument.activeElement);
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : event.key === 'ArrowDown' ? (current + 1) % buttons.length : (current <= 0 ? buttons.length : current) - 1;
      buttons[index].focus({ preventScroll: true });
    };
    const rows = model.actions ?? csSessionMenuEmpty;
    return h('dialog', { ref: dialog, className: 'cs-session-menu', 'data-chat-switcher': '', 'data-no-attention-ack': '', 'data-shortcut-modal': 'chat-switcher-session-menu', 'aria-label': t('sessionActions'), onCancel: event => { event.preventDefault(); event.stopPropagation(); close(); }, onClick: event => { if (event.target === event.currentTarget) close(); }, onContextMenu: event => { event.preventDefault(); event.stopPropagation(); }, onKeyDown: keyDown, onKeyUp: event => event.stopPropagation() },
      h('style', null, SESSION_MENU_CSS),
      h('div', { className: 'cs-session-menu-list', role: 'menu', tabIndex: -1, 'aria-label': t('sessionActions'), 'aria-busy': busy },
        ...rows.flatMap((row, index) => [
          index > 0 && row.separatorBefore ? h('hr', { key: row.id + ':separator', className: 'cs-session-menu-separator', role: 'separator' }) : null,
          h('button', { key: row.id, type: 'button', className: 'cs-session-menu-item', role: 'menuitem', disabled: busy || row.disabled === true, onClick: event => { event.stopPropagation(); if (busy || row.disabled) return; if (dialog.current?.open) dialog.current.close(); onAction(row.id); } }, h(Glyph, { icon: row.icon }), h('span', null, row.label)),
        ]),
        !rows.length && h('p', { className: 'cs-session-menu-status', role: 'status' }, t(busy ? 'actionsLoading' : 'actionsNone'))),
      error && h('p', { className: 'cs-session-menu-error', role: 'alert' }, error));
  }
  return { SessionMenu, useCardContext };
}
