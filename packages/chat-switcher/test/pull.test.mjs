import test from 'node:test';
import assert from 'node:assert/strict';
import { bindPullGesture, bindDismissGesture, pullContext, browseKey, PULL_THRESHOLD, PULL_EDITOR_INTENT_MS, createSwipeDiagnostics } from '../src/pull.js';
// Deterministic input-adapter doubles, not a browser/DOM renderer or device test.
class Target {
  listeners = new Map();
  addEventListener(type, fn, options) { if (!this.listeners.has(type)) this.listeners.set(type, new Map()); this.listeners.get(type).set(fn, options); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  emit(type, patch = {}) {
    const event = { target: this, cancelable: true, defaultPrevented: false, preventDefault() { if (this.cancelable) this.defaultPrevented = true; }, ...patch };
    for (const [fn] of this.listeners.get(type) ?? []) fn(event);
    return event;
  }
  get count() { return [...this.listeners.values()].reduce((n, fns) => n + fns.size, 0); }
}
const finger = (x = 150, y = 300, identifier = 1) => ({ clientX: x, clientY: y, identifier });
function fixture({ dismiss = false, realScrollTarget = false, next: initialNext = null, omitQuickApi = false,
  beforeComplete, canClose, onChanged = () => {}, onComplete = () => {} } = {}) {
  const target = new Target(), view = new Target(), document = new Target();
  const body = { dataset: { conversationSession: 'a', contentPhase: 'active' } };
  const child = { scrollHeight: 50, clientHeight: 50, scrollWidth: 50, clientWidth: 50, matches: () => false, closest: () => null };
  const scroller = Object.assign(new Target(), { scrollTop: 600, clientHeight: 400, scrollHeight: 1000, isConnected: true,
    hasAttribute: name => name === 'data-conversation-scroll',
    closest: selector => selector === '[data-cs-pull-frame]' ? target : body,
    querySelector: selector => selector === '[data-slot="conversation.chat.flow"]' ? chat : null });
  if (realScrollTarget) target.querySelector = () => scroller;
  const chat = { closest: selector => selector === '[data-conversation-scroll]' ? scroller : body };
  const feedback = [], calls = [], listeners = new Set(), traces = [], nextReads = [];
  let enabled = true, canOpen = true, session = 'a', modal = null, next = initialNext, eligible = () => true;
  document.visibilityState = 'visible'; document.querySelector = () => modal;
  document.getSelection = () => ({ isCollapsed: true }); view.visualViewport = { scale: 1 };
  view.getComputedStyle = () => ({ display: 'block', overflowY: 'visible', overflowX: 'visible', getPropertyValue: () => '180px' });
  const common = { target, view, document, beforeComplete, changed: x => { feedback.push(x); onChanged(x); }, trace: x => traces.push(x) };
  const quickApi = omitQuickApi ? {} : { getNext: () => { nextReads.push(next); return next; }, isEligible: id => eligible(id),
    quick: (id, prepared) => { calls.push(['quick', id]); onComplete('quick', prepared, id); } };
  const off = dismiss ? bindDismissGesture({ ...common, canClose, close: prepared => { calls.push('close'); onComplete('dismiss', prepared); } })
    : bindPullGesture({ ...common, ...quickApi, enabled: () => enabled, getSession: () => session, canOpen: () => canOpen,
      open: prepared => { calls.push('open'); onComplete('browse', prepared); }, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } });
  const receiver = realScrollTarget && !dismiss ? scroller : target;
  const emit = (type, touches, patch = {}) => receiver.emit(type, { target: child, touches, changedTouches: touches, composedPath: () => [child, scroller, target], ...patch });
  const start = (x = 150, y = 300, patch = {}) => emit('touchstart', [finger(x, y)], patch);
  // Coordinates are literal physical clientX values, not mirrored input:
  // the chat defaults 150→60 (right-to-left browse), dialog 150→240 (dismiss).
  // Quick-switch tests explicitly move the chat from 150 toward larger x.
  const move = (x = dismiss ? 240 : 60, y = 300, patch = {}) => emit('touchmove', [finger(x, y)], patch);
  const end = (x = dismiss ? 240 : 60, y = 300, patch = {}) => emit('touchend', [], { changedTouches: [finger(x, y)], ...patch });
  const invalidate = () => { for (const listener of listeners) listener(); };
  return { target, view, document, body, child, scroller, chat, feedback, calls, traces, nextReads, emit, start, move, end, off, invalidate, listeners,
    enable: value => enabled = value, available: value => canOpen = value, session: value => session = value, modal: value => modal = value,
    next: value => next = value, eligibility: predicate => eligible = predicate };
}
test('chat right-to-left opens browse only on release at 80px, never automatically selects a card', () => {
  const f = fixture(); f.start(); assert.equal(f.move(150 - PULL_THRESHOLD).defaultPrevented, true);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.feedback.at(-1), { distance: 80, ready: true, action: 'browse', targetId: null });
  assert.equal(f.end(70).defaultPrevented, true); assert.deepEqual(f.calls, ['open']); assert.equal(f.feedback.at(-1), null);
  assert.deepEqual(f.nextReads, []); assert.deepEqual(f.traces.filter(x => x.phase === 'intent'), [{ phase: 'intent', reason: 'browse' }]);
  assert.deepEqual(f.traces.at(-1), { phase: 'complete', reason: null });
  f.end(); assert.deepEqual(f.calls, ['open']); f.off();
});
test('chat right-to-left works at top, middle, end and on short content, without starting at an edge', () => {
  for (const top of [0, 300, 598.5, 600, 630]) { const f = fixture(); f.scroller.scrollTop = top; f.start(200, 200); f.move(110, 200); f.end(110, 200); assert.deepEqual(f.calls, ['open']); f.off(); }
  const f = fixture(); f.scroller.scrollHeight = 250; f.scroller.scrollTop = 0; f.start(); f.move(); f.end(); assert.deepEqual(f.calls, ['open']); f.off();
});
test('both vertical directions stay native in the chat and in the modal', () => {
  for (const dismiss of [false, true]) for (const y of [180, 420]) {
    const f = fixture({ dismiss }); f.start(); assert.equal(f.move(150, y).defaultPrevented, false); f.end(150, y); assert.deepEqual(f.calls, []); f.off();
  }
});
test('tap, short, rightward without a target and mostly vertical chat swipes never open', () => {
  for (const [x,y] of [[150,300],[145,300],[71,300],[250,300],[60,400],[110,330]]) {
    const f = fixture(); f.start(); f.move(x,y); f.end(x,y); assert.deepEqual(f.calls, []); f.off();
  }
});
test('browse threshold reversal and final coordinates disarm without delaying the next fresh gesture', () => {
  const f = fixture(); f.start(); f.move(50); assert.equal(f.feedback.at(-1).ready,true); f.move(110); assert.equal(f.feedback.at(-1).ready,false); f.end(110); assert.deepEqual(f.calls,[]);
  f.start(); f.move(50); f.end(110); assert.deepEqual(f.calls,[]); f.start(); f.move(); f.end(); assert.deepEqual(f.calls,['open']); f.off();
});
test('small horizontal slop stays native, and a rightward intent without a target cannot turn into browse', () => {
  const f = fixture(); f.start(); assert.equal(f.move(147).defaultPrevented,false); assert.equal(f.move(170).defaultPrevented,false); f.move(); f.end(); assert.deepEqual(f.calls,[]); f.off();
});
test('chat left-to-right previews the exact quick target at 6px and commits once only on an 80px release', () => {
  const f = fixture({ next: 'b' }); f.start();
  assert.deepEqual(f.nextReads, []); assert.equal(f.move(155).defaultPrevented, false); assert.deepEqual(f.feedback, []);
  assert.equal(f.move(156).defaultPrevented, true);
  assert.deepEqual(f.feedback.at(-1), { distance: 6, ready: false, action: 'quick', targetId: 'b' });
  f.move(229); assert.equal(f.feedback.at(-1).ready, false);
  f.move(150 + PULL_THRESHOLD);
  assert.deepEqual(f.feedback.at(-1), { distance: 80, ready: true, action: 'quick', targetId: 'b' });
  assert.deepEqual(f.calls, []); assert.deepEqual(f.nextReads, ['b']);
  assert.equal(f.end(230).defaultPrevented, true); assert.deepEqual(f.calls, [['quick', 'b']]);
  assert.equal(f.feedback.at(-1), null); assert.deepEqual(f.traces.at(-1), { phase: 'complete', reason: 'quick' });
  f.end(230); assert.deepEqual(f.calls, [['quick', 'b']], 'no browse call or double quick commit'); f.off();
});
test('quick uses the target at first dominant horizontal capture, not touchstart or a diagonal slop', () => {
  const f = fixture({ next: 'b' }); f.start();
  assert.equal(f.move(157, 305).defaultPrevented, false, '7px/5px is exactly the unclaimed 1.4 axis boundary');
  assert.deepEqual(f.nextReads, []); f.next('c');
  assert.equal(f.move(158, 305).defaultPrevented, true);
  assert.deepEqual(f.feedback.at(-1), { distance: 8, ready: false, action: 'quick', targetId: 'c' });
  f.end(240, 305); assert.deepEqual(f.calls, [['quick', 'c']]); assert.deepEqual(f.nextReads, ['c']); f.off();
});
test('quick short drags, releases below threshold and unclaimed terminal coordinates never commit', () => {
  for (const mode of ['slop', 'short', 'reversed-threshold', 'short-end', 'unclaimed']) {
    const f = fixture({ next: 'b' }); f.start();
    if (mode === 'slop') f.move(155);
    if (mode === 'short') f.move(229);
    if (mode === 'reversed-threshold' || mode === 'short-end') { f.move(250); if (mode === 'reversed-threshold') { f.move(190); assert.equal(f.feedback.at(-1).ready, false); } }
    f.end(mode === 'slop' ? 155 : mode === 'short' ? 229 : mode === 'unclaimed' ? 250 : 190);
    assert.deepEqual(f.calls, [], mode); f.off();
  }
});
test('crossing the chat start cancels either frozen action rather than changing or rearming it', () => {
  for (const action of ['browse', 'quick']) {
    const f = fixture({ next: 'b' }); f.start();
    const first = action === 'browse' ? 50 : 250, acrossStart = action === 'browse' ? 151 : 149;
    f.move(first); assert.equal(f.feedback.at(-1).action, action);
    f.move(acrossStart); assert.equal(f.feedback.at(-1), null);
    f.move(action === 'browse' ? 250 : 50); f.move(first);
    assert.equal(f.end(first).defaultPrevented, true); assert.deepEqual(f.calls, []);
    assert.deepEqual(f.traces.filter(x => x.phase === 'intent'), [{ phase: 'intent', reason: action }]);
    assert.deepEqual(f.nextReads, action === 'quick' ? ['b'] : []); f.off();
  }
});
test('sub-slop direction changes do not freeze a chat action before dominant capture', () => {
  const quick = fixture({ next: 'b' }); quick.start(); quick.move(147); quick.move(156); quick.end(240);
  assert.deepEqual(quick.calls, [['quick', 'b']]); quick.off();
  const browse = fixture({ next: 'b' }); browse.start(); browse.move(153); browse.move(144); browse.end(60);
  assert.deepEqual(browse.calls, ['open']); assert.deepEqual(browse.nextReads, []); browse.off();
});
test('missing, current or initially ineligible quick targets leave the entire contact native', () => {
  for (const mode of ['missing', 'current', 'ineligible']) {
    const f = fixture({ next: mode === 'missing' ? null : mode === 'current' ? 'a' : 'b' });
    if (mode === 'ineligible') f.eligibility(() => false);
    f.start(); assert.equal(f.move(156).defaultPrevented, false); assert.deepEqual(f.feedback, []);
    f.next('c'); f.eligibility(() => true); assert.equal(f.move(250).defaultPrevented, false);
    assert.equal(f.end(250).defaultPrevented, false); assert.deepEqual(f.calls, []);
    assert.equal(f.nextReads.length, 1, 'a later target cannot revive this contact'); f.off();
  }
});
test('reordering next-priority chats while held preserves the previewed eligible id through release', () => {
  for (const next of ['c', null]) {
    const f = fixture({ next: 'b' }); f.start(); f.move(156); f.next(next); f.invalidate(); f.move(250);
    assert.deepEqual(f.feedback.at(-1), { distance: 100, ready: true, action: 'quick', targetId: 'b' });
    f.end(250); assert.deepEqual(f.calls, [['quick', 'b']]); assert.deepEqual(f.nextReads, ['b']); f.off();
  }
});
test('removed, archived or otherwise ineligible frozen quick targets cancel without substituting getNext', () => {
  for (const mode of ['removed', 'archived', 'filtered']) for (const recheck of ['state', 'move', 'release']) {
    const f = fixture({ next: 'b' }), rows = new Map([['b', {}], ['c', {}]]);
    f.eligibility(id => { const row = rows.get(id); return !!row && !row.archived && !row.filtered; });
    f.start(); f.move(240); f.next('c');
    if (mode === 'removed') rows.delete('b'); else rows.get('b')[mode] = true;
    if (recheck === 'state') { f.invalidate(); assert.equal(f.feedback.at(-1), null); }
    if (recheck === 'move') { f.move(250); assert.equal(f.feedback.at(-1), null); }
    assert.equal(f.end(250).defaultPrevented, true); assert.deepEqual(f.calls, [], mode + ':' + recheck);
    assert.equal(f.feedback.at(-1), null); assert.deepEqual(f.nextReads, ['b']);
    assert.ok(f.traces.some(x => x.phase === 'cancel' && x.reason === 'ineligible-quick-target')); f.off();
  }
});
test('omitting the new quick API preserves browse and leaves left-to-right contacts native', () => {
  const f = fixture({ omitQuickApi: true }); f.start(); assert.equal(f.move(240).defaultPrevented, false);
  assert.equal(f.end(240).defaultPrevented, false); assert.deepEqual(f.calls, []);
  f.start(); f.move(60); f.end(60); assert.deepEqual(f.calls, ['open']); f.off();
});
test('providing getNext alone uses default eligible=true and a no-op quick callback', () => {
  const f = fixture({ omitQuickApi: true }); f.off();
  const off = bindPullGesture({ target: f.target, document: f.document, view: f.view,
    enabled: () => true, getSession: () => 'a', canOpen: () => true, getNext: () => 'b',
    open: () => assert.fail('default quick must never call browse'), changed: value => f.feedback.push(value) });
  f.start(); assert.equal(f.move(240).defaultPrevented, true);
  assert.deepEqual(f.feedback.at(-1), { distance: 90, ready: true, action: 'quick', targetId: 'b' });
  assert.equal(f.end(240).defaultPrevented, true); assert.equal(f.feedback.at(-1), null); off();
});
test('quick selection, pinch, lifecycle and composer-independent policy changes cancel a held preview', () => {
  for (const change of [f => f.document.getSelection = () => ({ isCollapsed: false }), f => f.view.visualViewport.scale = 1.5,
    f => f.modal({}), f => f.enable(false), f => f.available(false), f => f.session('b'), f => f.scroller.isConnected = false,
    f => f.view.emit('blur'), f => { f.document.visibilityState = 'hidden'; f.document.emit('visibilitychange'); }]) {
    const f = fixture({ next: 'b' }); f.start(); f.move(240); change(f); f.invalidate();
    assert.equal(f.feedback.at(-1), null); assert.equal(f.end(240).defaultPrevented, true); assert.deepEqual(f.calls, []); f.off();
  }
  const selected = fixture({ next: 'b' }); selected.document.getSelection = () => ({ isCollapsed: false });
  selected.start(); assert.equal(selected.move(240).defaultPrevented, false); selected.end(240);
  assert.deepEqual(selected.calls, []); assert.deepEqual(selected.nextReads, []); selected.off();
});
test('quick non-cancelable and externally consumed events cannot navigate', () => {
  for (const mode of ['move', 'end', 'consumed-move', 'consumed-end', 'prevent-ignored']) {
    const f = fixture({ next: 'b' }); f.start();
    f.move(240, 300, mode === 'move' ? { cancelable: false } : mode === 'consumed-move' ? { defaultPrevented: true } : mode === 'prevent-ignored' ? { preventDefault() {} } : {});
    f.end(240, 300, mode === 'end' ? { cancelable: false } : mode === 'consumed-end' ? { defaultPrevented: true } : {});
    assert.deepEqual(f.calls, []); f.off();
  }
});
test('beforeComplete prepares browse/quick/dismiss while feedback is still mounted, then reset precedes dispatch', () => {
  for (const surface of ['browse', 'quick', 'dismiss']) {
    const order = [], seen = [], prepared = { circle: { radius: 36 }, art: 'snapshot' };
    let f;
    f = fixture({ dismiss: surface === 'dismiss', next: 'b',
      beforeComplete: finished => {
        order.push('prepare'); seen.push({ finished, visible: f.feedback.at(-1), calls: [...f.calls] }); return prepared;
      },
      onChanged: value => { if (value === null) order.push('reset'); },
      onComplete: (action, snapshot, id) => {
        order.push('complete'); assert.equal(action, surface); assert.equal(snapshot, prepared);
        assert.equal(f.feedback.at(-1), null); assert.equal(id, surface === 'quick' ? 'b' : undefined);
      } });
    f.start(); f.move(surface === 'browse' ? 60 : 240); f.next('c');
    assert.equal(f.end(surface === 'browse' ? 50 : 250).defaultPrevented, true);
    assert.deepEqual(order, ['prepare', 'reset', 'complete']); assert.equal(seen.length, 1);
    assert.equal(seen[0].visible.ready, true); assert.equal(seen[0].visible.distance, 90); assert.deepEqual(seen[0].calls, []);
    const { finished } = seen[0];
    assert.equal(finished.distance, 100, 'preparation receives the final release distance, not last move');
    assert.equal(finished.ready, true); assert.equal(finished.captured, true);
    assert.equal(finished.action, surface === 'dismiss' ? undefined : surface);
    assert.equal(finished.targetId, surface === 'quick' ? 'b' : surface === 'browse' ? null : undefined);
    f.end(surface === 'browse' ? 50 : 250); assert.deepEqual(order, ['prepare', 'reset', 'complete']); f.off();
  }
});
test('beforeComplete visual failures pass undefined through reset and never prevent navigation', () => {
  for (const surface of ['browse', 'quick', 'dismiss']) {
    const order = [], results = []; let f, visibleBeforeFailure;
    f = fixture({ dismiss: surface === 'dismiss', next: 'b',
      beforeComplete: () => { order.push('prepare'); visibleBeforeFailure = f.feedback.at(-1); throw new Error('visual preparation failed'); },
      onChanged: value => { if (value === null) order.push('reset'); },
      onComplete: (action, prepared) => { order.push('complete'); results.push({ action, prepared }); } });
    f.start(); f.move(surface === 'browse' ? 60 : 240); f.end(surface === 'browse' ? 60 : 240);
    assert.equal(visibleBeforeFailure.ready, true); assert.deepEqual(order, ['prepare', 'reset', 'complete']);
    assert.deepEqual(results, [{ action: surface, prepared: undefined }]);
    assert.deepEqual(f.calls, surface === 'browse' ? ['open'] : surface === 'quick' ? [['quick', 'b']] : ['close']); f.off();
  }
});
test('cancelled, unclaimed, ineligible or non-cancelable releases never run beforeComplete', () => {
  for (const surface of ['browse', 'quick', 'dismiss']) {
    const modes = ['unclaimed', 'short', 'reverse', 'touchcancel', 'non-cancelable', 'already-consumed'];
    if (surface === 'quick') modes.push('ineligible', 'no-target');
    for (const mode of modes) {
      let preparations = 0;
      const f = fixture({ dismiss: surface === 'dismiss', next: mode === 'no-target' ? null : 'b', beforeComplete: () => { preparations++; return {}; } });
      const x = surface === 'browse' ? 60 : 240;
      f.start(); if (mode !== 'unclaimed') f.move(x);
      if (mode === 'reverse') f.move(surface === 'browse' ? 151 : 149);
      if (mode === 'touchcancel') f.emit('touchcancel', []);
      if (mode === 'ineligible') f.eligibility(() => false);
      f.end(mode === 'short' ? surface === 'browse' ? 110 : 190 : x, 300,
        mode === 'non-cancelable' ? { cancelable: false } : mode === 'already-consumed' ? { defaultPrevented: true } : {});
      assert.equal(preparations, 0, surface + ':' + mode); assert.deepEqual(f.calls, []); f.off();
    }
  }
});
test('quick capture diagnostics contain bounded intent/result reasons, never the previewed id or coordinates', () => {
  const targetId = 'private-quick-target-sentinel', f = fixture({ next: targetId }), d = createSwipeDiagnostics();
  f.start(); f.move(240); f.end(240);
  assert.deepEqual(f.traces.filter(x => x.phase === 'intent'), [{ phase: 'intent', reason: 'quick' }]);
  for (const event of f.traces) { assert.deepEqual(Object.keys(event).sort(), ['phase', 'reason']); d.trace('open', event); }
  const status = d.status(f.view, 'a');
  assert.equal(status.reasons['open:complete:quick'], 1);
  assert.doesNotMatch(JSON.stringify(status), /private-quick-target-sentinel|targetId|clientX|clientY|textContent|title/); f.off();
});
test('multi-touch, contact identity changes and touchcancel never complete', () => {
  for (const dismiss of [false,true]) for (const mode of ['second','identity','cancel']) {
    const f = fixture({dismiss}); f.start(); f.move();
    if(mode==='second')f.emit('touchstart',[finger(),finger(200,300,2)]);
    if(mode==='identity'){const x=dismiss?240:60;f.move(x,300,{touches:[finger(x,300,2)]});}
    if(mode==='cancel')f.emit('touchcancel',[]);
    f.end();assert.deepEqual(f.calls,[]);f.off();
  }
});
test('selection, pinch zoom, foreign modal and disabled/no-candidate policies remain native', () => {
  for (const change of [f=>f.document.getSelection=()=>({isCollapsed:false}),f=>f.view.visualViewport.scale=1.5,f=>f.modal({}),f=>f.enable(false),f=>f.available(false),f=>f.session(null)]) {
    const f=fixture();change(f);f.start();assert.equal(f.move().defaultPrevented,false);f.end();assert.deepEqual(f.calls,[]);assert.deepEqual(f.feedback,[]);assert.equal(f.traces.at(-1).phase,'reject');f.off();
  }
});
test('session/phase/view changes, blur, hiding, removal and disabled settings cancel ready gestures', () => {
  for (const change of [f=>f.session('b'),f=>f.body.dataset.conversationSession='b',f=>f.body.dataset.contentPhase='hero',f=>f.scroller.querySelector=()=>null,f=>f.scroller.isConnected=false,f=>f.view.emit('blur'),f=>{f.document.visibilityState='hidden';f.document.emit('visibilitychange');},f=>f.enable(false),f=>f.available(false),f=>f.modal({})]) {
    const f=fixture();f.start();f.move();change(f);f.invalidate();f.end();assert.deepEqual(f.calls,[]);assert.equal(f.feedback.at(-1),null);f.off();
  }
});
test('streaming and changing vertical position do not cancel a horizontal gesture', () => {
  const f=fixture();f.start();f.move();f.scroller.scrollHeight+=100;f.scroller.scrollTop=100;f.invalidate();f.end();assert.deepEqual(f.calls,['open']);f.off();
});
test('non-cancelable/already-consumed/ignored-cancellation events never report success', () => {
  for(const mode of ['move','end','consumed-move','consumed-end','prevent-ignored']){
    const f=fixture();f.start();f.move(60,300,mode==='move'?{cancelable:false}:mode==='consumed-move'?{defaultPrevented:true}:mode==='prevent-ignored'?{preventDefault(){}}:{});
    f.end(60,300,mode==='end'?{cancelable:false}:mode==='consumed-end'?{defaultPrevented:true}:{});assert.deepEqual(f.calls,[]);assert.ok(f.traces.at(-1).reason);f.off();
  }
});
test('controls and genuine horizontal panes keep their own gestures', () => {
  for(const mode of ['control','horizontal']){
    const f=fixture();if(mode==='control')f.child.matches=()=>true;
    else{f.child.scrollWidth=300;f.view.getComputedStyle=()=>({display:'block',overflowX:'auto'});}
    f.start();assert.equal(f.move().defaultPrevented,false);f.end();assert.deepEqual(f.calls,[]);f.off();
  }
});
// Element.matches doubles for the actual clickable tags/roles, not a visual DOM.
const clickSurface = token => ({
  matches: selector => selector.split(',').includes(token),
  closest(selector) { return this.matches(selector) ? this : null; },
  click() { assert.fail('gesture must never synthesize a click'); },
});
test('Edited files header/rows/toggle, links and ordinary view buttons admit swipes without swallowing taps', () => {
  for (const token of ['button','a[href]','summary','[role="button"]']) {
    const f=fixture();Object.assign(f.child,clickSurface(token));
    assert.equal(f.start().defaultPrevented,false);assert.equal(f.end(150).defaultPrevented,false);assert.deepEqual(f.calls,[],'native tap is not replaced');
    f.start();assert.equal(f.move().defaultPrevented,true);assert.equal(f.end().defaultPrevented,true);assert.deepEqual(f.calls,['open']);f.off();
  }
});
test('quick swipes on native message buttons/links suppress only the claimed contact, never an ordinary tap', () => {
  for (const token of ['button', 'a[href]', 'summary', '[role="button"]']) {
    const f = fixture({ next: 'b' }); Object.assign(f.child, clickSurface(token));
    assert.equal(f.start().defaultPrevented, false); assert.equal(f.end(150).defaultPrevented, false); assert.deepEqual(f.calls, []);
    f.start(); assert.equal(f.move(240).defaultPrevented, true); assert.equal(f.end(240).defaultPrevented, true);
    assert.deepEqual(f.calls, [['quick', 'b']]); f.off();
  }
});
test('a sent image inside its preview button is a swipe surface without opening the image', () => {
  const f=fixture(),image=clickSurface('img'),button=clickSurface('button');
  const patch={target:image,composedPath:()=>[image,button,f.scroller,f.target]};
  f.start(150,300,patch);assert.equal(f.end(150,300,patch).defaultPrevented,false);
  f.start(150,300,patch);assert.equal(f.move(60,300,patch).defaultPrevented,true);assert.equal(f.end(60,300,patch).defaultPrevented,true);assert.deepEqual(f.calls,['open']);f.off();
});
test('clickable message surfaces still leave both vertical directions to native scrolling',()=>{
  for(const token of ['button','a[href]','[role="button"]'])for(const y of [180,420]){
    const f=fixture();Object.assign(f.child,clickSurface(token));f.start();assert.equal(f.move(150,y).defaultPrevented,false);assert.equal(f.end(150,y).defaultPrevented,false);assert.deepEqual(f.calls,[]);f.off();
  }
});
test('editors, direct-manipulation controls, menus and composer ancestors stay protected even around a button/image',()=>{
  for(const token of ['input','textarea','select','[contenteditable]:not([contenteditable="false"])','[role="slider"]','[role="switch"]','[role="checkbox"]','[role="menu"]','[role="menubar"]','[role="listbox"]','[data-composer-seat]','[data-conversation-region="composer"]','[data-chat-switcher-no-swipe]','[data-slot="tool.view.cordis"]']){
    const f=fixture(),control=clickSurface(token),button=clickSurface('button');
    const patch={target:button,composedPath:()=>[button,control,f.scroller,f.target]};
    f.start(150,300,patch);assert.equal(f.move(60,300,patch).defaultPrevented,false,token);f.end(60,300,patch);assert.deepEqual(f.calls,[],token);f.off();
  }
});
test('the dialog Close button permits a physical left-to-right swipe while its ordinary tap stays native',()=>{
  const f=fixture({dismiss:true});Object.assign(f.child,clickSurface('button'));
  f.start();assert.equal(f.end(150).defaultPrevented,false);assert.deepEqual(f.calls,[]);
  f.start();f.move();assert.equal(f.end().defaultPrevented,true);assert.deepEqual(f.calls,['close']);f.off();
});
test('vertical panes and contents-only anchors do not falsely block a horizontal swipe', () => {
  for(const display of ['block','contents']){
    const f=fixture();f.child.scrollHeight=300;f.child.scrollWidth=300;
    f.view.getComputedStyle=()=>({display,overflowX:display==='contents'?'auto':'visible',overflowY:'auto',getPropertyValue:()=>''});
    f.start();f.move();f.end();assert.deepEqual(f.calls,['open']);f.off();
  }
});
test('admission requires the current main Chat and the same nearest frame/scroll owner', () => {
  for(const mode of ['no-path','nested-frame','wrong-session','hero','no-flow','nested-flow']){
    const f=fixture();if(mode==='nested-frame')f.scroller.closest=s=>s==='[data-cs-pull-frame]'?{}:f.body;
    if(mode==='wrong-session')f.body.dataset.conversationSession='child';if(mode==='hero')f.body.dataset.contentPhase='hero';if(mode==='no-flow')f.scroller.querySelector=()=>null;if(mode==='nested-flow')f.chat.closest=()=>({});
    assert.equal(pullContext({composedPath:()=>mode==='no-path'?[f.child]:[f.child,f.scroller,f.target]},f.target,f.view,'a'),null,mode);f.off();
  }
});
test('a Chat approval composer is not confused with another target view',()=>{
  const f=fixture();f.scroller.querySelector=()=>f.chat;f.start();f.move();f.end();assert.deepEqual(f.calls,['open']);f.off();
});
test('dialog left-to-right dismisses only on release, without navigation or a compatibility click',()=>{
  const f=fixture({dismiss:true});f.start();assert.equal(f.move(150+PULL_THRESHOLD).defaultPrevented,true);assert.deepEqual(f.feedback.at(-1),{distance:80,ready:true});assert.deepEqual(f.calls,[]);assert.equal(f.end(230).defaultPrevented,true);assert.deepEqual(f.calls,['close']);f.end(230);assert.deepEqual(f.calls,['close']);f.off();
});
test('dialog right-to-left rejection or crossing the start cannot turn into a dismiss mid-contact', () => {
  const rejected = fixture({ dismiss: true }); rejected.start(); assert.equal(rejected.move(144).defaultPrevented, false);
  rejected.move(240); rejected.end(240); assert.deepEqual(rejected.calls, []); rejected.off();
  const reversed = fixture({ dismiss: true }); reversed.start(); reversed.move(230); reversed.move(149);
  assert.equal(reversed.feedback.at(-1), null); reversed.move(240);
  assert.equal(reversed.end(240).defaultPrevented, true); assert.deepEqual(reversed.calls, []); reversed.off();
});
test('a busy dialog keeps contacts native from admission and cleanup still removes every listener', () => {
  const f = fixture({ dismiss: true, canClose: () => false });
  assert.equal(f.start().defaultPrevented, false); assert.equal(f.move(240).defaultPrevented, false);
  assert.equal(f.end(240).defaultPrevented, false); assert.deepEqual(f.feedback, []); assert.deepEqual(f.calls, []);
  assert.deepEqual(f.traces.at(-1), { phase: 'reject', reason: 'dialog-busy' });
  f.off(); assert.equal(f.target.count + f.document.count + f.view.count + f.listeners.size, 0);
});
test('live dialog busy state cancels a captured dismiss on move or release without losing contact consumption', () => {
  for (const recheck of ['move', 'release']) {
    let canClose = true, preparations = 0;
    const f = fixture({ dismiss: true, canClose: () => canClose, beforeComplete: () => { preparations++; } });
    f.start(); f.move(240); canClose = false;
    if (recheck === 'move') { f.move(250); assert.equal(f.feedback.at(-1), null); }
    assert.equal(f.end(250).defaultPrevented, true); assert.equal(f.feedback.at(-1), null);
    assert.deepEqual(f.calls, []); assert.equal(preparations, 0);
    assert.ok(f.traces.some(event => event.phase === 'cancel' && event.reason === 'dialog-busy'));
    canClose = true; f.move(250); f.end(250); assert.deepEqual(f.calls, [], 'closing the menu cannot revive its old contact');
    f.start(); f.move(240); f.end(240); assert.deepEqual(f.calls, ['close']); assert.equal(preparations, 1);
    f.off(); assert.equal(f.target.count + f.document.count + f.view.count + f.listeners.size, 0);
  }
});
test('dismiss needs its own touchstart, not the terminal event that opened the dialog',()=>{
  const f=fixture({dismiss:true});f.end();assert.deepEqual(f.calls,[]);f.off();
});
test('short/reversed/interactive/right-to-left dialog contacts do not dismiss',()=>{
  for(const mode of ['tap','short','reversed','control','left']){
    const f=fixture({dismiss:true});if(mode==='control')f.child.closest=()=>({});f.start();
    if(mode!=='tap')f.move(mode==='left'?50:mode==='short'?180:250);if(mode==='reversed')f.move(180);f.end(['short','reversed'].includes(mode)?180:mode==='tap'?150:mode==='left'?50:250);assert.deepEqual(f.calls,[],mode);f.off();
  }
});
test('a second finger outside the owned surface cancels, without capturing the second touch',()=>{
  for(const dismiss of [false,true]){const f=fixture({dismiss});f.start();f.move();const e=f.document.emit('touchstart',{touches:[finger(),finger(200,300,2)]});assert.equal(e.defaultPrevented,false);assert.equal(f.feedback.at(-1),null);f.move();assert.equal(f.end().defaultPrevented,true);assert.deepEqual(f.calls,[]);f.off();}
});
test('cancelled captured contacts still suppress terminal clicks but a fresh tap is not blocked',()=>{
  for(const dismiss of [false,true])for(const cancel of [f=>f.view.emit('blur'),f=>f.move(150,500),f=>f.modal({})]){
    const f=fixture({dismiss});f.start();f.move();cancel(f);assert.equal(f.end().defaultPrevented,true);assert.deepEqual(f.calls,[]);f.modal(null);f.start();assert.equal(f.end(150).defaultPrevented,false);f.off();
  }
});
test('quick multi-touch/identity/touchcancel contacts stay consumed without committing or blocking the next tap', () => {
  for (const mode of ['inside', 'outside', 'identity', 'cancel']) {
    const f = fixture({ next: 'b' }); f.start(); f.move(240);
    if (mode === 'inside') f.emit('touchstart', [finger(240), finger(200, 300, 2)]);
    if (mode === 'outside') f.document.emit('touchstart', { touches: [finger(240), finger(200, 300, 2)] });
    if (mode === 'identity') f.move(240, 300, { touches: [finger(240, 300, 2)] });
    if (mode === 'cancel') f.emit('touchcancel', []);
    assert.equal(f.feedback.at(-1), null); assert.equal(f.end(240).defaultPrevented, true); assert.deepEqual(f.calls, []);
    f.start(); assert.equal(f.end(150).defaultPrevented, false); f.off();
  }
  const f = fixture({ next: 'b' }); f.start(); f.move(240); f.emit('touchcancel', []);
  f.start(); assert.equal(f.end(150).defaultPrevented, false, 'touchcancel need not be followed by touchend'); f.off();
});
test('capture listeners are non-passive only where needed, and cleanup detaches all resources',()=>{
  for(const dismiss of [false,true]){const f=fixture({dismiss});const moveOptions=[...f.target.listeners.get('touchmove').values()][0];assert.equal(moveOptions.passive,false);assert.equal(moveOptions.capture,true);f.start();f.move();f.off();assert.equal(f.feedback.at(-1),null);assert.equal(f.target.count+f.view.count+f.document.count+f.listeners.size,0);f.end();assert.deepEqual(f.calls,[]);}
});
test('one bidirectional listener set uses the real scroll box, with the contents frame only an admission boundary',()=>{
  const f=fixture({realScrollTarget:true,next:'b'});assert.equal(f.target.count,0);
  for(const type of ['touchstart','touchmove','touchend']){
    assert.equal(f.scroller.listeners.get(type).size,1,type);
    assert.deepEqual([...f.scroller.listeners.get(type).values()][0],{passive:false,capture:true});
  }
  f.start();f.move(60);f.end(60);f.start();f.move(240);f.end(240);
  assert.deepEqual(f.calls,['open',['quick','b']]);f.off();assert.equal(f.scroller.count+f.document.count+f.view.count,0);
});
test('late native ownership exposes a bounded rejection reason rather than claiming a successful swipe',()=>{
  const f=fixture();f.start();f.move(148);f.move(60,300,{cancelable:false});f.end();assert.deepEqual(f.calls,[]);assert.deepEqual(f.traces.at(-1),{phase:'cancel',reason:'native-gesture-owned'});f.off();
});
test('read-only diagnostics expose mounts, guards and bounded counters without contents or coordinates',()=>{
  const f=fixture(),d=createSwipeDiagnostics();f.target.isConnected=true;f.target.querySelector=()=>f.scroller;
  const off=d.observe(f.target);d.trace('open',{phase:'reject',reason:'not-chat-view'});let s=d.status(f.view,'a');assert.equal(s.mountedFrames,1);assert.equal(s.frames[0].admission,null);assert.equal(s.counts['open:reject'],1);assert.equal(s.reasons['open:reject:not-chat-view'],1);
  assert.doesNotMatch(JSON.stringify(s),/conversationSession|clientX|clientY|textContent|title/);off();assert.equal(d.status(f.view,'a').mountedFrames,0);f.off();
});
function composerFixture({ hero=false, noSession=false, background=false, next=null }={}) {
  const f=fixture({next}),dimensions={scrollWidth:100,clientWidth:100,scrollHeight:100,clientHeight:100,isConnected:true};
  const seat={...dimensions,hasAttribute:name=>name==='data-composer-seat',matches:selector=>selector.split(',').includes('[data-composer-seat]'),closest:selector=>selector==='[data-conversation-scroll]'?f.scroller:null};
  const card={...dimensions,hasAttribute:name=>name==='data-composer-card',matches:()=>false,closest:selector=>selector==='[data-composer-seat]'?seat:null,querySelector:selector=>selector==='[data-composer-input]'?input:null};
  const input={...dimensions,...clickSurface('[role="textbox"]'),hasAttribute:name=>name==='data-composer-input',closest:selector=>selector==='[data-composer-card]'?card:selector==='[data-composer-seat]'?seat:null};
  for(const prop of ['value','textContent','innerHTML'])Object.defineProperty(input,prop,{get(){assert.fail('gesture must not read the draft');},set(){assert.fail('gesture must not write the draft');}});
  for(const method of ['focus','blur','dispatchEvent'])input[method]=()=>assert.fail('gesture must not edit, focus or submit the editor');
  const inputScroll={...dimensions,hasAttribute:name=>name==='data-input-scroll',matches:()=>false};
  const path=background?[card,seat,f.scroller,f.target]:[input,inputScroll,card,seat,f.scroller,f.target];
  if(hero){f.body.dataset.contentPhase='hero';f.scroller.querySelector=()=>null;}
  if(noSession){delete f.body.dataset.conversationSession;f.session(null);}
  const patch=timeStamp=>({timeStamp,target:path[0],composedPath:()=>path});
  return {...f,input,card,seat,inputScroll,path,patch,
    startEditor:(time=0)=>f.start(150,300,patch(time)),
    moveEditor:(time=100,x=60,y=300)=>f.move(x,y,patch(time)),
    endEditor:(time=150,x=60,y=300)=>f.end(x,y,patch(time))};
}
test('a timely right-to-left swipe from the native composer input or bare card opens browse without editing its draft',()=>{
  for(const background of [false,true]){
    const f=composerFixture({background});assert.equal(f.startEditor().defaultPrevented,false);
    assert.equal(f.endEditor(50,150).defaultPrevented,false);assert.deepEqual(f.calls,[]);
    f.startEditor();assert.equal(f.moveEditor().defaultPrevented,true);assert.equal(f.endEditor().defaultPrevented,true);assert.deepEqual(f.calls,['open']);
    assert.ok(f.traces.some(event=>event.phase==='composer'));f.off();
  }
});
test('composer vertical scrolling and a long hold before capture remain native, while a captured swipe may stay held',()=>{
  for(const y of [180,420]){const f=composerFixture();f.startEditor();assert.equal(f.moveEditor(100,150,y).defaultPrevented,false);f.endEditor(200,150,y);assert.deepEqual(f.calls,[]);f.off();}
  const f=composerFixture();f.startEditor();assert.equal(f.moveEditor(PULL_EDITOR_INTENT_MS).defaultPrevented,false);assert.equal(f.endEditor(500).defaultPrevented,false);assert.deepEqual(f.calls,[]);
  f.startEditor();assert.equal(f.moveEditor(PULL_EDITOR_INTENT_MS-1).defaultPrevented,true);f.moveEditor(5000);f.endEditor(10000);assert.deepEqual(f.calls,['open']);f.off();
});
test('selected text and selection appearing during a composer drag cancel navigation without rewriting selection',()=>{
  const f=composerFixture();f.document.getSelection=()=>({isCollapsed:false});f.startEditor();f.moveEditor();assert.equal(f.endEditor().defaultPrevented,false);assert.deepEqual(f.calls,[]);
  f.document.getSelection=()=>({isCollapsed:true});f.startEditor();f.moveEditor();f.document.getSelection=()=>({isCollapsed:false});f.moveEditor(200);assert.equal(f.endEditor(250).defaultPrevented,true);assert.deepEqual(f.calls,[]);f.off();
});
test('composer takeover forms, toolbar actions and nested non-native inputs are not covered by the editor exception',()=>{
  for(const token of ['button','a[href]','input','textarea','[role="slider"]','[data-chat-switcher-no-swipe]']){
    const f=composerFixture(),control=clickSurface(token),patch={timeStamp:0,target:control,composedPath:()=>[control,f.inputScroll,f.card,f.seat,f.scroller,f.target]};
    f.start(150,300,patch);assert.equal(f.move(60,300,{...patch,timeStamp:100}).defaultPrevented,false,token);f.end(60,300,{...patch,timeStamp:150});assert.deepEqual(f.calls,[]);f.off();
  }
  const f=composerFixture(),takeover=clickSurface('[role="textbox"]'),patch={target:takeover,composedPath:()=>[takeover,f.seat,f.scroller,f.target]};
  f.start(150,300,patch);f.move(60,300,patch);f.end(60,300,patch);assert.deepEqual(f.calls,[],'the hidden native fallback must not admit a takeover textarea');f.off();
});
test('blank hero and no-session native composers allow swipes, but a non-Chat active view does not',()=>{
  for(const noSession of [false,true]){const f=composerFixture({hero:true,noSession});f.startEditor();f.moveEditor();f.endEditor();assert.deepEqual(f.calls,['open']);f.off();}
  const f=composerFixture();f.scroller.querySelector=()=>null;f.startEditor();f.moveEditor();f.endEditor();assert.deepEqual(f.calls,[]);f.off();
});
test('composer replacement and same-session rightbar copies cannot complete a primary editor gesture',()=>{
  const f=composerFixture();f.startEditor();f.moveEditor();f.input.isConnected=false;f.endEditor();assert.deepEqual(f.calls,[]);f.off();
  const side=composerFixture();side.target.closest=selector=>selector==='[data-rightbar-col]'?{}:null;side.startEditor();side.moveEditor();side.endEditor();assert.deepEqual(side.calls,[]);side.off();
});
test('non-editor blank toolbar regions do not become swipe surfaces merely because a native card is nearby',()=>{
  const f=composerFixture(),blank={matches:()=>false},patch={target:blank,composedPath:()=>[blank,f.card,f.seat,f.scroller,f.target]};
  f.start(150,300,patch);f.move(60,300,patch);f.end(60,300,patch);assert.deepEqual(f.calls,[]);f.off();
});
test('native composer quick capture admits input/card/hero/no-session without reading drafts or opening browse', () => {
  for (const options of [{}, { background: true }, { hero: true }, { hero: true, noSession: true }]) {
    const f = composerFixture({ ...options, next: 'b' }); f.startEditor();
    assert.equal(f.moveEditor(100, 155).defaultPrevented, false);
    assert.equal(f.moveEditor(PULL_EDITOR_INTENT_MS - 1, 156).defaultPrevented, true);
    assert.deepEqual(f.feedback.at(-1), { distance: 6, ready: false, action: 'quick', targetId: 'b' });
    f.moveEditor(5000, 230); assert.deepEqual(f.calls, []);
    assert.equal(f.endEditor(10000, 230).defaultPrevented, true); assert.deepEqual(f.calls, [['quick', 'b']]); f.off();
  }
});
test('composer quick keeps the 300ms pre-capture deadline, including invalid or backwards timestamps', () => {
  for (const time of [PULL_EDITOR_INTENT_MS, 5000, -1, NaN, Infinity]) {
    const f = composerFixture({ next: 'b' }); f.startEditor();
    assert.equal(f.moveEditor(time, 240).defaultPrevented, false);
    assert.equal(f.endEditor(6000, 240).defaultPrevented, false); assert.deepEqual(f.calls, []);
    assert.deepEqual(f.nextReads, []); assert.deepEqual(f.traces.at(-1), { phase: 'cancel', reason: 'editing-hold' }); f.off();
  }
});
test('composer selection/replacement/seat removal/reversal cancel a claimed quick without substituting or editing', () => {
  for (const mode of ['selection', 'replacement', 'seat', 'reverse']) {
    const f = composerFixture({ next: 'b' }); f.startEditor(); f.moveEditor(100, 240); f.next('c');
    if (mode === 'selection') f.document.getSelection = () => ({ isCollapsed: false });
    if (mode === 'replacement') f.input.isConnected = false;
    if (mode === 'seat') f.seat.closest = () => null;
    if (mode === 'reverse') f.moveEditor(120, 149);
    f.invalidate(); assert.equal(f.feedback.at(-1), null);
    assert.equal(f.endEditor(200, 240).defaultPrevented, true); assert.deepEqual(f.calls, []); assert.deepEqual(f.nextReads, ['b']); f.off();
  }
});
test('quick composer toolbar buttons, takeover editors and same-session side copies remain native', () => {
  for (const token of ['button', 'a[href]', 'input', '[role="slider"]']) {
    const f = composerFixture({ next: 'b' }), control = clickSurface(token);
    const patch = { timeStamp: 0, target: control, composedPath: () => [control, f.inputScroll, f.card, f.seat, f.scroller, f.target] };
    f.start(150, 300, patch); assert.equal(f.move(240, 300, { ...patch, timeStamp: 100 }).defaultPrevented, false);
    f.end(240, 300, { ...patch, timeStamp: 150 }); assert.deepEqual(f.calls, []); assert.deepEqual(f.nextReads, []); f.off();
  }
  const takeover = composerFixture({ next: 'b' }), editor = clickSurface('[role="textbox"]');
  const patch = { target: editor, composedPath: () => [editor, takeover.seat, takeover.scroller, takeover.target] };
  takeover.start(150, 300, patch); assert.equal(takeover.move(240, 300, patch).defaultPrevented, false); takeover.end(240, 300, patch);
  assert.deepEqual(takeover.calls, []); assert.deepEqual(takeover.nextReads, []); takeover.off();
  const side = composerFixture({ next: 'b' }); side.target.closest = selector => selector === '[data-rightbar-col]' ? {} : null;
  side.startEditor(); assert.equal(side.moveEditor(100, 240).defaultPrevented, false); side.endEditor(150, 240);
  assert.deepEqual(side.calls, []); assert.deepEqual(side.nextReads, []); side.off();
});
test('browse keyboard actions preserve the persistent mode and leave Tab navigation native',()=>{
  const calls=[],controller={move:n=>calls.push(['move',n]),select:n=>calls.push(['select',n]),release:()=>calls.push(['open'])};
  const event=key=>({key,preventDefault(){this.prevented=true;},stopPropagation(){}});
  for(const key of ['ArrowRight','ArrowDown','ArrowLeft','ArrowUp','Home','End','Enter',' ']){const e=event(key);browseKey(e,controller,3);assert.equal(e.prevented,true);}
  assert.deepEqual(calls,[['move',1],['move',1],['move',-1],['move',-1],['select',0],['select',2],['open'],['open']]);const tab=event('Tab');browseKey(tab,controller,3);assert.equal(tab.prevented,undefined);
});
