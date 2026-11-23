import test from 'node:test';
import assert from 'node:assert/strict';
import { zoomAction, zoomStyle } from '../src/core.js';
import { ZOOM_LEVELS, isZoomPercent, nextZoom } from '../src/scale.js';

const event = (code, patch = {}) => ({ code, key: '', ctrlKey: true, shiftKey: true, metaKey: false, altKey: false, ...patch });

test('Shift shortcuts use physical codes including shifted symbols and the numpad', () => {
  for (const [code, key, action] of [
    ['Equal', '+', 'in'], ['Minus', '_', 'out'], ['Digit0', ')', 'reset'],
    ['NumpadAdd', '+', 'in'], ['NumpadSubtract', '-', 'out'], ['Numpad0', 'Insert', 'reset'],
  ]) assert.equal(zoomAction(event(code, { key })), action);
});

test('Cmd is used on macOS; other modifier combinations and no-Shift inputs pass through', () => {
  assert.equal(zoomAction(event('Equal', { ctrlKey: false, metaKey: true }), true), 'in');
  for (const patch of [{ shiftKey: false }, { altKey: true }, { ctrlKey: false }, { metaKey: true }, { defaultPrevented: true }, { isComposing: true }, { keyCode: 229 }, { key: 'Dead' }, { getModifierState: () => true }]) {
    assert.equal(zoomAction(event('Equal', patch)), undefined, JSON.stringify(patch));
  }
  assert.equal(zoomAction(event('Equal'), true), undefined);
  assert.equal(zoomAction(event('Equal', { metaKey: true }), true), undefined);
  assert.equal(zoomAction(event('KeyA')), undefined);
});

test('repeat remains recognized for consumption without a second adjustment in the adapter', () => {
  assert.equal(zoomAction(event('Equal', { repeat: true })), 'in');
});

test('keyboard actions use the shared logarithmic scale and retain exact reset', () => {
  assert.deepEqual([...ZOOM_LEVELS].sort((a, b) => a - b), ZOOM_LEVELS);
  assert.ok(Math.abs(nextZoom(100, 'in') - 100 * Math.exp(0.1)) < 1e-10);
  assert.ok(Math.abs(nextZoom(100, 'out') - 100 * Math.exp(-0.1)) < 1e-10);
  assert.equal(nextZoom(nextZoom(100, 'in'), 'out'), 100);
  assert.equal(nextZoom(300, 'in'), 300);
  assert.equal(nextZoom(50, 'out'), 50);
  assert.equal(nextZoom(300, 'reset'), 100);
});

test('invalid persisted/tool values are rejected before entering CSS', () => {
  for (const value of [0, -1, 49, 301, NaN, Infinity, '125', undefined, null, '1; display:none']) {
    assert.equal(isZoomPercent(value), false);
    assert.throws(() => zoomStyle(value), RangeError);
    assert.throws(() => nextZoom(value, 'in'), RangeError);
  }
  assert.throws(() => nextZoom(100, 'unknown'), TypeError);
});

test('root zoom scales the whole document and reset restores the existing CSS cascade', () => {
  assert.equal(zoomStyle(125), ':root { zoom: 1.25 !important; --dsh-ui-zoom-factor: 1.25; --dsh-ui-zoom-inverse: 0.8; }');
  assert.equal(zoomStyle(80), ':root { zoom: 0.8 !important; --dsh-ui-zoom-factor: 0.8; --dsh-ui-zoom-inverse: 1.25; }');
  assert.equal(zoomStyle(100), ':root { --dsh-ui-zoom-factor: 1; --dsh-ui-zoom-inverse: 1; }');
  assert.doesNotMatch(zoomStyle(100), /[{;]\s*zoom\s*:/);
  assert.doesNotMatch(zoomStyle(200), /font-size|transform|height|width/);
});
