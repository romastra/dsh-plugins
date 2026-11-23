import test from 'node:test';
import assert from 'node:assert/strict';
import { bindComposerDoubleActivation, COMPOSER_ACTION } from '../src/double-activation.js';
function rig() {
  const handlers = new Map(); let time = 0, session = 'a', mutated;
  const style = { remove() { this.removed = true; } };
  const document = { body: {}, head: { appendChild() {} }, createElement: () => style,
    addEventListener: (n, f) => handlers.set(n, f), removeEventListener: n => handlers.delete(n) };
  const button = { disabled: false, isConnected: true, innerHTML: 'send', attrs: { 'aria-label': 'Send', 'aria-busy': 'false' }, getAttribute(n) { return this.attrs[n] ?? null; } };
  const target = { closest(selector) { assert.equal(selector, COMPOSER_ACTION); return button; } };
  const cleanup = bindComposerDoubleActivation({ document, getSession: () => session, now: () => time, Observer: class { constructor(f) { mutated = f; } observe() {} disconnect() {} } });
  const emit = (name, props = {}) => { const e = { target, button: 0, detail: 1, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...props }; handlers.get(name)?.(e); return e; };
  return { button, emit, cleanup, handlers, style, mutate: () => mutated(), tick: ms => time += ms, session: s => { session = s; } };
}
for (const pointerType of ['mouse', 'touch', 'pen', '']) {
  for (const mode of ['Send', 'Stop', 'Steer', 'Queue']) test(mode + ' requires two activations: ' + pointerType, () => {
    const r = rig(); r.button.attrs['aria-label'] = mode;
    const props = { pointerType, detail: pointerType ? 1 : 0 };
    assert.equal(r.emit('click', props).prevented, true); r.tick(150);
    assert.equal(r.emit('click', props).prevented, undefined);
    assert.equal(r.emit('click', props).prevented, true, 'third click cannot activate the next action');
  });
}
test('timeout, session, mode, replacement and input type cannot complete an old pair', () => {
  for (const change of [r => r.tick(451), r => r.session('b'), r => { r.button.attrs['aria-label'] = 'Stop'; }, r => { r.button.innerHTML = 'stop'; }, r => { r.button.disabled = true; }]) {
    const r = rig(); r.emit('click'); change(r); assert.equal(r.emit('click').prevented, true);
  }
  const r = rig(); r.emit('click', { pointerType: 'touch' }); assert.equal(r.emit('click', { pointerType: 'mouse' }).prevented, true);
});
test('outside clicks, escape, blur/visibility and mode mutations cancel pending activation', () => {
  for (const reset of [r => r.emit('click', { target: {} }), r => r.emit('pointerdown', { target: {} }), r => r.emit('keydown', { key: 'Escape' }), r => r.emit('visibilitychange'), r => { r.button.attrs['aria-busy'] = 'true'; r.mutate(); r.button.attrs['aria-busy'] = 'false'; }]) {
    const r = rig(); r.emit('click'); reset(r); assert.equal(r.emit('click').prevented, true);
  }
});
test('unrelated controls and editor keys remain native; cleanup removes all listeners and style', () => {
  const r = rig(); assert.equal(r.emit('click', { target: {} }).prevented, undefined);
  assert.equal(r.emit('keydown', { key: 'Enter', target: {} }).prevented, undefined);
  assert.match(r.style.textContent, /touch-action:manipulation/);
  r.cleanup(); assert.equal(r.handlers.size, 0); assert.equal(r.style.removed, true);
});
