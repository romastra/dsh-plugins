import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSessionActions, createCardContextPress, createSessionMenu, SESSION_MENU_CSS } from '../src/session-menu.js';

function store(value) {
  const listeners = new Set();
  return { getSnapshot: () => value, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    set(next) { value = next; for (const fn of [...listeners]) fn(); }, get size() { return listeners.size; } };
}
const views = () => [
  { id: 'session.pin/pin', label: 'Native pin', icon: { key: 'workspace.pin' } },
  { id: 'session.rename/rename', label: 'Native rename', icon: { key: 'workspace.rename' } },
  { id: 'session.fork/fork', label: 'Native fork', icon: { key: 'workspace.fork' } },
  { id: 'session.id/copy', label: 'Native copy ID', icon: { key: 'workspace.copy' }, separatorBefore: true },
  { id: 'session.archive/archive', label: 'Native archive', icon: { key: 'workspace.archive' }, separatorBefore: true },
];
function actionsFixture(initial = views()) {
  const source = store(initial), workspaces = { list: store({ archivedSessionIds: [] }) }, calls = [];
  const native = { source, ready: Promise.resolve(), select: id => calls.push(['select', id]), dispose: () => calls.push(['dispose']) };
  const actions = createSessionActions({ contextMenus: { resolve: target => { calls.push(['resolve', target]); return native; } },
    uiWorkspace: { startSession: (...args) => calls.push(['new', ...args]) }, workspaces });
  return { actions, native, source, workspaces, calls };
}

test('construction is inert; native New Session receives no options or auto-submit', () => {
  const f = actionsFixture();
  assert.deepEqual(f.calls, []);
  f.actions.newSession();
  assert.deepEqual(f.calls, [['new']]);
});
test('embedded occurrence uses exact native target, action ids and localized views', async () => {
  const f = actionsFixture([...views(), { id: 'external/copy', label: 'not a native session operation' }]);
  const occurrence = f.actions.resolve({ id: 'a', title: 'Stored title', displayTitle: 'fallback' });
  assert.deepEqual(f.calls, [['resolve', { kind: 'session', value: { sessionId: 'a', displayTitle: 'Stored title' } }]]);
  assert.deepEqual(occurrence.source.getSnapshot(), views());
  assert.equal(occurrence.source.getSnapshot(), occurrence.source.getSnapshot(), 'external-store snapshot stays stable');
  await occurrence.ready;
  assert.equal(occurrence.select('external/copy'), false);
  assert.equal(occurrence.select('session.rename/rename'), true);
  assert.deepEqual(f.calls.slice(1), [['select', 'session.rename/rename'], ['dispose']]);
  assert.equal(occurrence.select('session.fork/fork'), false, 'one selection only');
  occurrence.dispose();
  assert.equal(f.calls.filter(call => call[0] === 'dispose').length, 1);
});
test('native Rename uses trimmed stored titles and leaves unnamed/blank drafts empty', () => {
  for (const [item, expected] of [
    [{ id: 'a', title: '  Stored  ', displayTitle: 'Shown' }, 'Stored'],
    [{ id: 'a', title: '', displayTitle: 'Untitled' }, ''],
    [{ id: 'a', displayTitle: 'Untitled' }, ''],
    [{ id: 'a', title: 'New Session', blank: true }, ''],
  ]) {
    const f = actionsFixture(), occurrence = f.actions.resolve(item);
    assert.equal(f.calls[0][1].value.displayTitle, expected);
    occurrence.dispose();
  }
});
test('all five actions select native ids, not invented RPC or local operation implementations', () => {
  for (const view of views()) {
    const f = actionsFixture(), occurrence = f.actions.resolve({ id: 'a', displayTitle: 'Native display title' });
    assert.equal(occurrence.select(view.id), true);
    assert.deepEqual(f.calls.slice(1), [['select', view.id], ['dispose']]);
  }
});
test('live native permissions and disabled states are honored before selection', () => {
  const f = actionsFixture(), occurrence = f.actions.resolve({ id: 'a' });
  assert.equal(f.calls[0][1].value.displayTitle, '', 'unnamed native Rename starts empty, not with an id');
  f.source.set(views().map(view => ({ ...view, disabled: true })));
  assert.equal(occurrence.select('session.pin/pin'), false);
  f.source.set([]);
  assert.equal(occurrence.select('session.archive/archive'), false);
  assert.equal(f.calls.some(call => call[0] === 'select'), false);
  occurrence.dispose();
});
test('archived sessions disappear immediately and a stale archive row cannot restore', () => {
  const f = actionsFixture(), occurrence = f.actions.resolve({ id: 'a' });
  const snapshots = [];
  const off = occurrence.source.subscribe(() => snapshots.push(occurrence.source.getSnapshot()));
  assert.equal(f.source.size, 1); assert.equal(f.workspaces.list.size, 1);
  f.workspaces.list.set({ archivedSessionIds: ['a'] });
  assert.deepEqual(snapshots.at(-1), []);
  assert.equal(occurrence.select('session.archive/archive'), false);
  f.source.set([{ id: 'session.archive/archive', label: 'Restore', icon: { key: 'workspace.unarchive' } }]);
  f.workspaces.list.set({ archivedSessionIds: [] });
  assert.deepEqual(occurrence.source.getSnapshot(), [], 'Restore is forbidden even with stale membership');
  assert.equal(occurrence.select('session.archive/archive'), false);
  occurrence.dispose(); off();
  assert.equal(f.source.size, 0); assert.equal(f.workspaces.list.size, 0);
  assert.equal(f.calls.some(call => call[0] === 'select'), false);
});
test('selection and explicit disposal release every caller-owned subscription', () => {
  for (const select of [false, true]) {
    const f = actionsFixture(), occurrence = f.actions.resolve({ id: 'a' });
    const offA = occurrence.source.subscribe(() => {}), offB = occurrence.source.subscribe(() => {});
    assert.equal(f.source.size, 2); assert.equal(f.workspaces.list.size, 2);
    if (select) occurrence.select('session.id/copy'); else occurrence.dispose();
    assert.equal(f.source.size, 0); assert.equal(f.workspaces.list.size, 0);
    offA(); offB(); occurrence.source.subscribe(() => {})();
    assert.equal(f.source.size, 0);
  }
});

function clock() {
  let now = 0, serial = 0;
  const pending = new Map();
  return { later(fn, delay) { const id = ++serial; pending.set(id, { fn, at: now + delay }); return id; }, cancel(id) { pending.delete(id); },
    advance(ms) { now += ms; for (const [id, task] of [...pending]) if (task.at <= now) { pending.delete(id); task.fn(); } },
    get size() { return pending.size; } };
}
function event(patch = {}) {
  return { pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0, clientX: 20, clientY: 30, detail: 1,
    preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...patch };
}
function pressFixture(options = {}) {
  const time = clock(), opened = [];
  const press = createCardContextPress({ onOpen: point => opened.push(point), later: time.later, cancel: time.cancel, ...options });
  return { time, opened, press };
}
test('ordinary touch tap remains direct navigation and does not prevent native pointer behavior', () => {
  const f = pressFixture(), down = event(), up = event(), click = event();
  f.press.onPointerDown(down); f.time.advance(499); f.press.onPointerUp(up); f.press.onClickCapture(click); f.time.advance(1);
  assert.deepEqual(f.opened, []); assert.equal(f.time.size, 0);
  for (const e of [down, up, click]) { assert.equal(e.prevented, undefined); assert.equal(e.stopped, undefined); }
});
test('touch/pen hold opens once at 500ms and consumes only its terminal click', () => {
  for (const pointerType of ['touch', 'pen']) {
    const f = pressFixture(), down = event({ pointerType });
    f.press.onPointerDown(down); f.time.advance(500);
    assert.equal(down.prevented, undefined);
    assert.deepEqual(f.opened, [{ x: 20, y: 30, pointerId: 7, pointerType, trigger: 'hold' }]);
    const context = event({ pointerType }); f.press.onContextMenu(context); f.time.advance(1000);
    assert.equal(context.prevented, true); assert.equal(f.opened.length, 1);
    const up = event({ pointerType }); f.press.onPointerUp(up); assert.equal(up.prevented, true);
    const click = event({ pointerType }); f.press.onClickCapture(click);
    assert.equal(click.prevented, true); assert.equal(click.stopped, true);
    f.press.onPointerDown(event({ pointerType })); f.press.onPointerUp(event({ pointerType }));
    const fresh = event({ pointerType }); f.press.onClickCapture(fresh);
    assert.equal(fresh.prevented, undefined, 'fresh tap is never banned');
    f.press.dispose();
  }
});
test('more than 6px cancels a hold and early native touch contextmenu cannot revive it', () => {
  const f = pressFixture();
  f.press.onPointerDown(event()); f.press.onPointerMove(event({ clientX: 26.01 })); f.time.advance(500);
  const context = event(); f.press.onContextMenu(context);
  assert.equal(context.prevented, true); assert.equal(f.opened.length, 0);
  f.press.onPointerUp(event()); f.press.onContextMenu(event());
  assert.equal(f.opened.length, 0, 'late native contextmenu after release cannot revive a moved press');
  const click = event(); f.press.onClickCapture(click); assert.equal(click.prevented, undefined);
  f.press.onPointerDown(event()); f.press.onPointerMove(event({ clientX: 26 })); f.time.advance(500);
  assert.equal(f.opened.length, 1, 'exactly 6px is permitted');
});
test('native contextmenu before timer recognition opens once with the held target', () => {
  const f = pressFixture(); f.press.onPointerDown(event()); f.time.advance(300);
  const context = event(); f.press.onContextMenu(context); f.time.advance(1000); f.press.onPointerUp(event());
  const late = event(); f.press.onContextMenu(late);
  assert.equal(f.opened.length, 1); assert.equal(f.opened[0].trigger, 'contextmenu'); assert.equal(f.time.size, 0);
});
test('right click opens at its coordinates without adding a mouse hold or blocking fresh left clicks', () => {
  const f = pressFixture();
  f.press.onPointerDown(event({ pointerType: 'mouse', button: 2 })); assert.equal(f.time.size, 0);
  const context = event({ pointerType: 'mouse', button: 2, clientX: 75, clientY: 85 }); f.press.onContextMenu(context);
  assert.equal(context.prevented, true); assert.equal(context.stopped, true);
  assert.deepEqual(f.opened, [{ x: 75, y: 85, pointerId: 7, pointerType: 'mouse', trigger: 'contextmenu' }]);
  f.press.onPointerDown(event({ pointerType: 'mouse' }));
  const click = event({ pointerType: 'mouse' }); f.press.onClickCapture(click); assert.equal(click.prevented, undefined);
});
test('secondary touch cancels; unrelated pointers cannot cancel a primary hold', () => {
  const f = pressFixture(); f.press.onPointerDown(event());
  f.press.onPointerMove(event({ pointerId: 8, clientX: 100 })); f.press.onPointerUp(event({ pointerId: 8 })); f.time.advance(500);
  assert.equal(f.opened.length, 1);
  f.press.onPointerDown(event()); f.press.onPointerDown(event({ pointerId: 8, isPrimary: false })); f.time.advance(500);
  assert.equal(f.opened.length, 1);
});
test('cancel, disabled handlers and disposal leave no timer or later action', () => {
  for (const mode of ['cancel', 'dispose', 'disable']) {
    let enabled = true;
    const f = pressFixture({ enabled: () => enabled }); f.press.onPointerDown(event());
    if (mode === 'cancel') f.press.onPointerCancel(event());
    if (mode === 'dispose') f.press.dispose();
    if (mode === 'disable') enabled = false;
    f.time.advance(500); const context = event(); f.press.onContextMenu(context);
    assert.equal(f.opened.length, 0); assert.equal(f.time.size, 0);
    if (mode !== 'cancel') assert.equal(context.prevented, undefined);
    f.press.dispose();
  }
});
test('keyboard activation and another pen pointer are never swallowed by a consumed press', () => {
  const f = pressFixture(); f.press.onPointerDown(event({ pointerType: 'pen' })); f.time.advance(500);
  const keyboard = event({ detail: 0, pointerId: undefined, pointerType: undefined }); f.press.onClickCapture(keyboard);
  const other = event({ pointerType: 'pen', pointerId: 8 }); f.press.onClickCapture(other);
  assert.equal(keyboard.prevented, undefined); assert.equal(other.prevented, undefined);
  const terminal = event({ pointerType: 'pen' }); f.press.onClickCapture(terminal); assert.equal(terminal.prevented, true);
});

// A hook/element fake, not a browser, DOM renderer, or application runtime.
function reactFixture() {
  const slots = []; let cursor = 0; const pending = [];
  const changed = (a, b) => !a || a.length !== b.length || a.some((value, index) => value !== b[index]);
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(value => value !== null && value !== false) }),
    useRef(value) { const index = cursor++; return slots[index] ??= { current: value }; },
    useMemo(fn, deps) { const index = cursor++; if (!slots[index] || changed(slots[index].deps, deps)) slots[index] = { deps, value: fn() }; return slots[index].value; },
    useLayoutEffect(setup, deps) {
      const index = cursor++, previous = slots[index];
      if (!previous || changed(previous.deps, deps)) { const slot = { deps, setup, cleanup: previous?.cleanup }; slots[index] = slot; pending.push(slot); }
    },
  };
  return { React, render(fn, props) { cursor = 0; return fn(props); },
    flush() { for (const slot of pending.splice(0)) { slot.cleanup?.(); slot.cleanup = slot.setup(); } },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
    replay() { for (const slot of slots) if (slot?.setup) { slot.cleanup?.(); slot.cleanup = slot.setup(); } } };
}
function descendants(tree) { return tree && typeof tree === 'object' ? [tree, ...tree.children.flatMap(descendants)] : []; }
function dialogFixture(tree, zoom = 1) {
  const main = { isConnected: true, focus() { doc.activeElement = main; main.focused = true; } };
  const doc = { activeElement: main, documentElement: {} };
  const listeners = new Map();
  const view = { innerWidth: 640, innerHeight: 480, getComputedStyle: () => ({ zoom: String(zoom) }),
    addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: (name, callback) => { if (listeners.get(name) === callback) listeners.delete(name); } };
  doc.defaultView = view;
  const buttons = descendants(tree).filter(node => node.type === 'button').map(node => ({ ...node, focus() { doc.activeElement = this; } }));
  const list = { focus() { doc.activeElement = list; } };
  let returnFocus;
  const node = { ownerDocument: doc, style: {}, open: false, currentCSSZoom: zoom, shows: 0, closes: 0,
    showModal() { this.shows++; this.open = true; returnFocus = doc.activeElement; }, close() { this.closes++; this.open = false; returnFocus?.focus?.(); },
    getBoundingClientRect: () => ({ width: 250, height: 240 }),
    querySelector(selector) { return selector === '[role="menu"]' ? list : buttons.find(button => !button.props.disabled); },
    querySelectorAll: () => buttons.filter(button => !button.props.disabled) };
  tree.props.ref.current = node;
  return { node, doc, main, buttons, list, listeners };
}
test('React hook owns timer cleanup and survives StrictMode layout-effect replay', () => {
  const time = clock(), previousLater = globalThis.setTimeout, previousCancel = globalThis.clearTimeout;
  globalThis.setTimeout = time.later; globalThis.clearTimeout = time.cancel;
  try {
    const fixture = reactFixture(), { useCardContext } = createSessionMenu(fixture.React), opened = [];
    const handlers = fixture.render(useCardContext, { onOpen: point => opened.push(point) }); fixture.flush();
    assert.deepEqual(Object.keys(handlers), ['onPointerDown', 'onPointerMove', 'onPointerUp', 'onPointerCancel', 'onContextMenu', 'onClickCapture']);
    handlers.onPointerDown(event()); assert.equal(time.size, 1);
    fixture.replay(); assert.equal(time.size, 0);
    handlers.onPointerDown(event()); time.advance(500); assert.equal(opened.length, 1);
    handlers.onPointerDown(event()); fixture.unmount(); time.advance(500);
    assert.equal(time.size, 0); assert.equal(opened.length, 1);
    const context = event(); handlers.onContextMenu(context); assert.equal(context.prevented, undefined);
  } finally { globalThis.setTimeout = previousLater; globalThis.clearTimeout = previousCancel; }
});
test('nested native dialog focuses first enabled item, navigates and Escape closes only menu', () => {
  const fixture = reactFixture(), { SessionMenu } = createSessionMenu(fixture.React), closed = [], selected = [];
  const rows = views().map((row, index) => ({ ...row, disabled: index === 0 }));
  const tree = fixture.render(SessionMenu, { model: { id: 'a', anchor: { x: 620, y: 460 }, actions: rows }, onClose: () => closed.push('menu'), onAction: id => selected.push(id), t: key => key });
  const f = dialogFixture(tree); fixture.flush();
  assert.equal(tree.type, 'dialog'); assert.equal(f.node.shows, 1); assert.equal(f.doc.activeElement, f.buttons[1]);
  assert.equal(tree.props['data-no-attention-ack'], '');
  assert.equal(f.node.style.left, '382px'); assert.equal(f.node.style.top, '232px');
  const down = event({ key: 'ArrowDown' }); tree.props.onKeyDown(down);
  assert.equal(down.prevented, true); assert.equal(f.doc.activeElement, f.buttons[2]);
  tree.props.onKeyDown(event({ key: 'End' })); assert.equal(f.doc.activeElement, f.buttons.at(-1));
  tree.props.onKeyDown(event({ key: 'ArrowDown' })); assert.equal(f.doc.activeElement, f.buttons[1]);
  const escape = event({ key: 'Escape' }); tree.props.onKeyDown(escape);
  assert.equal(escape.prevented, true); assert.equal(escape.stopped, true); assert.deepEqual(closed, ['menu']);
  assert.equal(f.node.open, false); assert.equal(f.doc.activeElement, f.main); assert.deepEqual(selected, []);
  fixture.unmount(); assert.equal(f.listeners.size, 0);
});
test('menu selection closes its top layer before invoking native action callback', () => {
  const fixture = reactFixture(), { SessionMenu } = createSessionMenu(fixture.React), selected = [];
  let f;
  const tree = fixture.render(SessionMenu, { model: { id: 'a', anchor: { x: 20, y: 30 }, actions: views() }, onClose() {}, onAction: id => selected.push([id, f.node.open]) });
  f = dialogFixture(tree); fixture.flush();
  f.buttons[1].props.onClick(event());
  assert.deepEqual(selected, [['session.rename/rename', false]]);
  fixture.unmount();
});
test('controlled unmount after selection cannot steal focus from a native prompt', () => {
  const fixture = reactFixture(), { SessionMenu } = createSessionMenu(fixture.React), prompt = {};
  let f;
  const tree = fixture.render(SessionMenu, { model: { id: 'a', anchor: { x: 20, y: 30 }, actions: views() }, onClose() {}, onAction() { f.doc.activeElement = prompt; } });
  f = dialogFixture(tree); fixture.flush();
  f.buttons[1].props.onClick(event()); fixture.unmount();
  assert.equal(f.doc.activeElement, prompt);
});
test('busy menus cannot execute; cancel prevents bubbling and restores parent focus', () => {
  const fixture = reactFixture(), { SessionMenu } = createSessionMenu(fixture.React), selected = [], closed = [];
  const tree = fixture.render(SessionMenu, { model: { id: 'a', anchor: { x: 5, y: 5 }, actions: views() }, busy: true, error: 'visible failure', onClose: () => closed.push(true), onAction: id => selected.push(id) });
  const f = dialogFixture(tree); fixture.flush();
  assert.equal(f.doc.activeElement, f.list);
  for (const button of f.buttons) { assert.equal(button.props.disabled, true); button.props.onClick(event()); }
  assert.deepEqual(selected, []);
  assert.equal(descendants(tree).some(node => node.props.role === 'alert' && node.children.includes('visible failure')), true);
  const cancel = event(); tree.props.onCancel(cancel);
  assert.equal(cancel.prevented, true); assert.equal(cancel.stopped, true); assert.deepEqual(closed, [true]); assert.equal(f.doc.activeElement, f.main);
  fixture.unmount();
});
test('menu positioning compensates inherited CSS zoom and keeps an 8px viewport inset', () => {
  const fixture = reactFixture(), { SessionMenu } = createSessionMenu(fixture.React);
  const tree = fixture.render(SessionMenu, { model: { id: 'a', anchor: { x: 620, y: 460 }, actions: views() }, onClose() {}, onAction() {} });
  const f = dialogFixture(tree, 2); fixture.flush();
  assert.equal(f.node.style.left, '191px'); assert.equal(f.node.style.top, '116px');
  assert.equal(f.node.style.maxWidth, '312px'); assert.equal(f.node.style.maxHeight, '232px');
  fixture.unmount();
});
test('null controlled model renders nothing and card styling is modal-only/theme-alias-only', async () => {
  const fixture = reactFixture(), { SessionMenu } = createSessionMenu(fixture.React);
  assert.equal(fixture.render(SessionMenu, { model: null }), null); fixture.flush(); fixture.unmount();
  assert.match(SESSION_MENU_CSS, /\.cs-dialog \[data-cs-context-card\]/);
  assert.match(SESSION_MENU_CSS, /-webkit-touch-callout:none/);
  for (const match of SESSION_MENU_CSS.matchAll(/var\(([^)]+)\)/g)) assert.match(match[1], /^--dsw-alias-[\w-]+$/);
  assert.doesNotMatch(SESSION_MENU_CSS, /#[0-9a-f]{3,8}\b/i);
  const source = await readFile(new URL('../src/session-menu.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^import /m);
  assert.doesNotMatch(source, /(?:\.retain\(|\.using\(|\.rename\(|\.fork\(|\.archiveSession\(|\.unarchiveSession\(|\.acknowledge\(|\.remote\.)/);
});
