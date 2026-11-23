import test from 'node:test';
import assert from 'node:assert/strict';
import { modalAreaStyle, createModalAreaTracker } from '../src/modal-area.js';

const BASE = Object.freeze({ left: 316, top: 64, width: 1350, height: 720 });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('modal area uses exactly 90% of the non-square chat area, including its sidebar offset', () => {
  assert.deepEqual(modalAreaStyle(BASE), {
    position: 'fixed', margin: 0, inset: 'auto',
    left: '383.5px', top: '100px', width: '1215px', height: '648px',
    maxWidth: 'none', maxHeight: 'none',
  });
  assert.deepEqual(BASE, { left: 316, top: 64, width: 1350, height: 720 });
});

for (const zoom of [0.75, 1, 1.5, 2]) {
  test(`CSS root zoom ${zoom} preserves exact physical 5% margins on every side`, () => {
    const style = modalAreaStyle(BASE, zoom);
    const left = parseFloat(style.left) * zoom, top = parseFloat(style.top) * zoom;
    const width = parseFloat(style.width) * zoom, height = parseFloat(style.height) * zoom;
    near(left - BASE.left, BASE.width * 0.05);
    near(BASE.left + BASE.width - left - width, BASE.width * 0.05);
    near(top - BASE.top, BASE.height * 0.05);
    near(BASE.top + BASE.height - top - height, BASE.height * 0.05);
    near(width, BASE.width * 0.9);
    near(height, BASE.height * 0.9);
    assert.equal(style.left, (BASE.left + BASE.width * 0.05) / zoom + 'px');
    assert.equal(style.top, (BASE.top + BASE.height * 0.05) / zoom + 'px');
    assert.equal(style.width, BASE.width * 0.9 / zoom + 'px');
    assert.equal(style.height, BASE.height * 0.9 / zoom + 'px');
  });
}

test('area sizing has no minimum, fixed cap, or viewport-height substitute', () => {
  const large = modalAreaStyle({ left: 280, top: 80, width: 8000, height: 5000 });
  assert.equal(large.width, '7200px');
  assert.equal(large.height, '4500px');
  const small = modalAreaStyle({ left: 0, top: 0, width: 20, height: 10 });
  assert.equal(small.width, '18px');
  assert.equal(small.height, '9px');
  const negativeOrigin = modalAreaStyle({ left: -200, top: -100, width: 100, height: 50 });
  assert.equal(negativeOrigin.left, '-195px');
  assert.equal(negativeOrigin.top, '-97.5px');
  assert.equal('minWidth' in large, false);
  assert.equal('minHeight' in large, false);
});

test('invalid or nonpositive rectangles return null without coercing inputs', () => {
  for (const rect of [undefined, null, false, 0, '', {}, [], { ...BASE, height: undefined }]) {
    assert.equal(modalAreaStyle(rect), null);
  }
  for (const key of ['left', 'top', 'width', 'height']) {
    for (const value of [NaN, Infinity, -Infinity, '10', null, undefined]) {
      assert.equal(modalAreaStyle({ ...BASE, [key]: value }), null, `${key}=${value}`);
    }
  }
  for (const key of ['width', 'height']) {
    for (const value of [0, -0, -1]) assert.equal(modalAreaStyle({ ...BASE, [key]: value }), null);
  }
});

test('invalid, nonfinite, and nonpositive zoom values fall back to one', () => {
  const expected = modalAreaStyle(BASE, 1);
  for (const zoom of [undefined, null, NaN, Infinity, -Infinity, 0, -0, -0.75, '0.75', false, {}, []]) {
    assert.deepEqual(modalAreaStyle(BASE, zoom), expected);
  }
});

class TinyEventTarget {
  listeners = new Map();
  added = [];
  removed = [];
  addEventListener(type, listener) {
    this.added.push([type, listener]);
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) {
    this.removed.push([type, listener]);
    this.listeners.get(type)?.delete(listener);
  }
  count(type) { return this.listeners.get(type)?.size ?? 0; }
  dispatch(type) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener({ type });
  }
}

function makeView({ observer = true, viewport = true } = {}) {
  const view = new TinyEventTarget(), observers = [];
  if (viewport) view.visualViewport = new TinyEventTarget();
  if (observer) view.ResizeObserver = class {
    targets = new Set();
    disconnectCount = 0;
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(target) { this.targets.add(target); }
    disconnect() { this.disconnectCount++; this.targets.clear(); }
    // Allow delivery after disconnect to model an already-queued notification.
    deliver() { this.callback([], this); }
  };
  view.setTimeout = view.setInterval = view.requestAnimationFrame = () => assert.fail('no polling or timers');
  return { view, observers };
}

function makeSurface(session = 'current', initialRect = BASE) {
  let rect = initialRect, reads = 0;
  const content = { dataset: { conversationSession: session }, getBoundingClientRect() { assert.fail('core content is identity only'); } };
  const frame = {
    isConnected: true, content,
    closest(selector) { if (selector === '[data-rightbar-col]') return this.rightbar ?? null; assert.equal(selector, '[data-conversation-content]'); return this.content; },
    getBoundingClientRect() { assert.fail('the display:contents HOC is not the measured surface'); },
    querySelector() { assert.fail('do not discover a foreign button or surface'); },
  };
  const area = { isConnected: true, getBoundingClientRect() { reads++; return rect; } };
  for (const element of [frame, content, area]) {
    for (const key of ['textContent', 'innerText']) Object.defineProperty(element, key, { get() { assert.fail('chat text must never be read'); } });
  }
  return { frame, content, area, setRect(value) { rect = value; }, reads: () => reads };
}

test('a same-session embedded rightbar registered first cannot replace the main chat area', () => {
  const {view}=makeView(),main=makeSurface(),side=makeSurface('current',{...BASE,left:1800,width:400}),changes=[];
  side.frame.rightbar={};
  const tracker=createModalAreaTracker({view,getCurrent:()=> 'current',onChange:rect=>changes.push(rect)});
  tracker.register(side.frame,side.area);assert.equal(changes.length,0);assert.equal(side.reads(),0);
  tracker.register(main.frame,main.area);assert.deepEqual(changes,[BASE]);tracker.dispose();
});
test('tracker filters stale, foreign, detached, and missing core contexts before measuring', () => {
  const { view } = makeView();
  let current = 'current';
  const changes = [];
  const tracker = createModalAreaTracker({ view, getCurrent: () => current, onChange: rect => changes.push(rect) });
  const stale = makeSurface('old'), foreign = makeSurface('foreign');
  const detachedFrame = makeSurface(), detachedArea = makeSurface(), outside = makeSurface(), active = makeSurface();
  detachedFrame.frame.isConnected = false;
  detachedArea.area.isConnected = false;
  outside.frame.content = null;
  for (const surface of [stale, foreign, detachedFrame, detachedArea, outside]) tracker.register(surface.frame, surface.area);
  assert.deepEqual(changes, []);
  tracker.register(active.frame, active.area);
  assert.deepEqual(changes, [BASE]);
  for (const surface of [stale, foreign, detachedFrame, detachedArea, outside]) assert.equal(surface.reads(), 0);
  assert.equal(active.reads(), 1);

  current = 'missing';
  tracker.refresh();
  tracker.refresh();
  assert.deepEqual(changes, [BASE, null]);
  current = 'foreign';
  tracker.refresh();
  assert.deepEqual(changes, [BASE, null, BASE]);
  assert.equal(foreign.reads(), 1);
  foreign.content.dataset.conversationSession = 'other';
  tracker.refresh();
  assert.deepEqual(changes, [BASE, null, BASE, null], 'refresh sees committed core identity changes');
  tracker.dispose();
});

test('home identities normalize empty, null, and undefined to null without accepting missing context', () => {
  for (const current of [null, undefined, '']) {
    for (const session of [null, undefined, '']) {
      const { view } = makeView();
      const changes = [], surface = makeSurface(session);
      surface.content.dataset.conversationSession = session;
      const tracker = createModalAreaTracker({ view, getCurrent: () => current, onChange: rect => changes.push(rect) });
      tracker.register(surface.frame, surface.area);
      assert.deepEqual(changes, [BASE]);
      surface.frame.content = null;
      tracker.refresh();
      assert.deepEqual(changes, [BASE, null]);
      tracker.dispose();
    }
  }
});

test('tracker measures only its registered owned area and emits a plain numeric snapshot', () => {
  const { view } = makeView();
  const measured = Object.assign(Object.create({ toJSON() { assert.fail('do not serialize DOMRect'); } }), BASE, { x: 999, y: 999, right: 999, bottom: 999 });
  const surface = makeSurface('current', measured), changes = [];
  const tracker = createModalAreaTracker({ view, getCurrent: () => 'current', onChange: rect => changes.push(rect) });
  tracker.register(surface.frame, surface.area);
  assert.equal(surface.reads(), 1);
  assert.deepEqual(changes, [BASE]);
  assert.equal(Object.getPrototypeOf(changes[0]), Object.prototype);
  assert.deepEqual(Object.keys(changes[0]), ['left', 'top', 'width', 'height']);
  assert.notEqual(changes[0], measured);
  tracker.refresh();
  assert.equal(changes.length, 1, 'identical geometry does not republish a new object');
  measured.width = 1200;
  tracker.refresh();
  assert.equal(changes.length, 2);
  assert.equal(changes[0].width, BASE.width, 'DOMRect mutation cannot change a prior snapshot');
  assert.equal(changes[1].width, 1200);
  changes[1].left = -999;
  tracker.refresh();
  assert.equal(changes.length, 2, 'consumer mutation cannot corrupt the comparison baseline');
  surface.area.isConnected = false;
  tracker.refresh();
  assert.equal(changes.at(-1), null);
  tracker.dispose();
});

test('invalid owned bounds produce null and a later valid matching area can be selected', () => {
  const { view } = makeView();
  const first = makeSurface('current', { ...BASE, width: 0 }), second = makeSurface();
  const changes = [];
  const tracker = createModalAreaTracker({ view, getCurrent: () => 'current', onChange: rect => changes.push(rect) });
  tracker.register(first.frame, first.area);
  assert.deepEqual(changes, []);
  const offSecond = tracker.register(second.frame, second.area);
  assert.deepEqual(changes, [BASE]);
  offSecond();
  assert.deepEqual(changes, [BASE, null]);
  first.setRect({ ...BASE, top: NaN });
  tracker.refresh();
  assert.deepEqual(changes, [BASE, null]);
  first.setRect({ ...BASE, height: 900 });
  tracker.refresh();
  assert.deepEqual(changes.at(-1), { ...BASE, height: 900 });
  tracker.dispose();
});

test('resize observers watch owned areas while resize and viewport listeners are shared', () => {
  const { view, observers } = makeView();
  const active = makeSurface(), foreign = makeSurface('foreign'), changes = [];
  const tracker = createModalAreaTracker({ view, getCurrent: () => 'current', onChange: rect => changes.push(rect) });
  const offActive = tracker.register(active.frame, active.area);
  const offForeign = tracker.register(foreign.frame, foreign.area);
  assert.equal(observers.length, 2);
  assert.deepEqual([...observers[0].targets], [active.area]);
  assert.deepEqual([...observers[1].targets], [foreign.area]);
  assert.equal(view.count('resize'), 1);
  assert.equal(view.count('scroll'), 0);
  assert.equal(view.visualViewport.count('resize'), 1);
  assert.equal(view.visualViewport.count('scroll'), 1);
  assert.deepEqual(view.added.map(([type]) => type), ['resize']);
  assert.deepEqual(view.visualViewport.added.map(([type]) => type), ['resize', 'scroll']);

  active.setRect({ ...BASE, width: 1400 });
  observers[0].deliver();
  assert.equal(changes.at(-1).width, 1400);
  active.setRect({ ...BASE, left: 400 });
  view.dispatch('resize');
  assert.equal(changes.at(-1).left, 400);
  active.setRect({ ...BASE, height: 600 });
  view.visualViewport.dispatch('resize');
  assert.equal(changes.at(-1).height, 600);
  active.setRect({ ...BASE, top: 90 });
  view.visualViewport.dispatch('scroll');
  assert.equal(changes.at(-1).top, 90);
  assert.equal(changes.length, 5);
  view.visualViewport.dispatch('scroll');
  assert.equal(changes.length, 5, 'unchanged events are deduplicated');

  offActive();
  offActive();
  assert.equal(observers[0].disconnectCount, 1);
  assert.equal(changes.at(-1), null);
  assert.equal(view.count('resize'), 1, 'foreign registration still owns the shared listener lifetime');
  offForeign();
  offForeign();
  assert.equal(observers[1].disconnectCount, 1);
  assert.equal(view.count('resize'), 0);
  assert.equal(view.visualViewport.count('resize'), 0);
  assert.equal(view.visualViewport.count('scroll'), 0);
  assert.equal(view.removed.length, 1);
  assert.equal(view.visualViewport.removed.length, 2);

  const offAgain = tracker.register(active.frame, active.area);
  assert.equal(view.count('resize'), 1, 'listeners can restart after the last unregister');
  offAgain();
  tracker.dispose();
  assert.equal(observers[2].disconnectCount, 1);
  assert.equal(view.removed.length, 2);
});

test('replacing a frame registration disconnects its old observer and tolerates stale disposers', () => {
  const { view, observers } = makeView();
  const surface = makeSurface(), replacement = makeSurface('current', { ...BASE, left: 500 });
  const changes = [];
  const tracker = createModalAreaTracker({ view, getCurrent: () => 'current', onChange: rect => changes.push(rect) });
  const offOld = tracker.register(surface.frame, surface.area);
  const offNew = tracker.register(surface.frame, replacement.area);
  assert.equal(observers[0].disconnectCount, 1);
  assert.equal(observers[1].disconnectCount, 0);
  assert.equal(changes.at(-1).left, 500);
  offOld();
  tracker.refresh();
  assert.equal(changes.at(-1).left, 500);
  assert.equal(view.count('resize'), 1);
  assert.equal(view.added.length, 1);
  offNew();
  offNew();
  assert.equal(observers[1].disconnectCount, 1);
  assert.equal(changes.at(-1), null);
  assert.equal(view.count('resize'), 0);
  tracker.dispose();
});

test('window and viewport events still refresh when this view has no ResizeObserver', () => {
  const { view, observers } = makeView({ observer: false });
  const surface = makeSurface(), changes = [];
  const tracker = createModalAreaTracker({ view, getCurrent: () => 'current', onChange: rect => changes.push(rect) });
  tracker.register(surface.frame, surface.area);
  assert.equal(observers.length, 0);
  surface.setRect({ ...BASE, width: 1600 });
  view.dispatch('resize');
  assert.equal(changes.at(-1).width, 1600);
  surface.setRect({ ...BASE, height: 400 });
  view.visualViewport.dispatch('resize');
  assert.equal(changes.at(-1).height, 400);
  tracker.dispose();
  assert.equal(view.count('resize'), 0);
  assert.equal(view.visualViewport.count('resize'), 0);
  assert.equal(view.visualViewport.count('scroll'), 0);
});

test('tracker also works without visualViewport and ignores empty registrations', () => {
  const { view, observers } = makeView({ viewport: false });
  const surface = makeSurface(), changes = [];
  const tracker = createModalAreaTracker({ view, getCurrent: () => 'current', onChange: rect => changes.push(rect) });
  tracker.refresh();
  tracker.register(null, surface.area)();
  tracker.register(surface.frame, null)();
  assert.deepEqual(changes, []);
  assert.equal(view.count('resize'), 0);
  assert.equal(observers.length, 0);
  const off = tracker.register(surface.frame, surface.area);
  surface.setRect({ ...BASE, width: 1000 });
  view.dispatch('resize');
  assert.equal(changes.at(-1).width, 1000);
  off();
  assert.deepEqual(changes.at(-1), null);
  tracker.dispose();
});

test('dispose is idempotent and suppresses all later callbacks, registration, and queued deliveries', () => {
  const { view, observers } = makeView();
  const surface = makeSurface(), changes = [];
  let readsCurrent = 0;
  const tracker = createModalAreaTracker({ view, getCurrent() { readsCurrent++; return 'current'; }, onChange: rect => changes.push(rect) });
  const off = tracker.register(surface.frame, surface.area);
  const readsAtDispose = readsCurrent;
  tracker.dispose();
  tracker.dispose();
  assert.equal(observers[0].disconnectCount, 1);
  assert.equal(view.count('resize'), 0);
  assert.equal(view.visualViewport.count('resize'), 0);
  assert.equal(view.visualViewport.count('scroll'), 0);
  surface.setRect({ ...BASE, width: 1700 });
  tracker.refresh();
  observers[0].deliver();
  view.dispatch('resize');
  view.visualViewport.dispatch('resize');
  view.visualViewport.dispatch('scroll');
  off();
  tracker.register(surface.frame, surface.area)();
  assert.equal(observers.length, 1);
  assert.equal(observers[0].disconnectCount, 1);
  assert.equal(view.added.length, 1);
  assert.equal(readsCurrent, readsAtDispose);
  assert.deepEqual(changes, [BASE], 'dispose itself must not publish null after shutdown');
});
