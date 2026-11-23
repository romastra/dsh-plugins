import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SETTINGS_ID, ZOOM_MIN, ZOOM_MAX, LOG_STEP, ZOOM_LEVELS,
  isZoomPercent, nextZoom, positionToPercent, percentToPosition,
  neutralPosition, STICKY_POSITIONS, formatZoom,
} from '../src/scale.js';

const MIN_LOG = Math.log(0.5);
const MAX_LOG = Math.log(3);
const MIN_U = MIN_LOG - LOG_STEP;
const SPAN_U = MAX_LOG - MIN_LOG + 2 * LOG_STEP;
const fromU = u => (u - MIN_U) / SPAN_U;
const fromIndex = index => index === 0 ? 100 : 100 * Math.exp(index * LOG_STEP);
const close = (actual, expected, tolerance = 2e-12) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
};
const invalidPercents = [
  0, -1, 49.999, 300.001, NaN, Infinity, -Infinity,
  '100', undefined, null, true, {}, [], new Number(100),
];

test('public constants expose the immutable 50–300 anchored natural-log grid', () => {
  assert.equal(SETTINGS_ID, 'ui-zoom');
  assert.equal(ZOOM_MIN, 50);
  assert.equal(ZOOM_MAX, 300);
  assert.equal(LOG_STEP, 0.1);
  assert.ok(Object.isFrozen(ZOOM_LEVELS));
  assert.deepEqual(ZOOM_LEVELS, [50, ...Array.from({ length: 17 }, (_, i) => fromIndex(i - 6)), 300]);
  assert.equal(ZOOM_LEVELS.filter(level => level === 100).length, 1);
  assert.throws(() => { ZOOM_LEVELS[0] = 51; }, TypeError);
});

test('all interior steps have the same exp(0.1) ratio and only endpoints are shortened', () => {
  for (let i = 2; i < ZOOM_LEVELS.length - 1; i += 1) {
    close(ZOOM_LEVELS[i] / ZOOM_LEVELS[i - 1], Math.exp(LOG_STEP), 1e-14);
    close(Math.log(ZOOM_LEVELS[i] / ZOOM_LEVELS[i - 1]), LOG_STEP, 1e-14);
  }
  for (let i = 1; i < ZOOM_LEVELS.length; i += 1) {
    assert.ok(ZOOM_LEVELS[i] > ZOOM_LEVELS[i - 1]);
    assert.ok(Math.log(ZOOM_LEVELS[i] / ZOOM_LEVELS[i - 1]) <= LOG_STEP + 1e-14);
  }
});

test('validation accepts finite numeric fractional and legacy integer percentages only', () => {
  for (const value of [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 123.456789, ...ZOOM_LEVELS]) {
    assert.equal(isZoomPercent(value), true, String(value));
  }
  for (const value of invalidPercents) assert.equal(isZoomPercent(value), false, String(value));
});

test('keyboard traversal is strictly directional, reversible and clamped at endpoints', () => {
  const upward = [50];
  let percent = 50;
  for (let i = 1; i < ZOOM_LEVELS.length; i += 1) {
    const next = nextZoom(percent, 'in');
    assert.ok(next > percent);
    assert.equal(nextZoom(next, 'out'), percent);
    upward.push(next);
    percent = next;
  }
  assert.deepEqual(upward, ZOOM_LEVELS);
  assert.equal(nextZoom(300, 'in'), 300);

  const downward = [300];
  percent = 300;
  for (let i = 1; i < ZOOM_LEVELS.length; i += 1) {
    const next = nextZoom(percent, 'out');
    assert.ok(next < percent);
    assert.equal(nextZoom(next, 'in'), percent);
    downward.push(next);
    percent = next;
  }
  assert.deepEqual(downward, [...ZOOM_LEVELS].reverse());
  assert.equal(nextZoom(50, 'out'), 50);
});

test('keyboard passes exactly through 100 with no dead or repeated 100 presses', () => {
  const lower = fromIndex(-1);
  const upper = fromIndex(1);
  assert.equal(nextZoom(lower, 'in'), 100);
  assert.equal(nextZoom(100, 'in'), upper);
  assert.equal(nextZoom(upper, 'out'), 100);
  assert.equal(nextZoom(100, 'out'), lower);
  assert.equal(nextZoom(99, 'in'), 100);
  assert.equal(nextZoom(101, 'out'), 100);
  for (const action of ['in', 'out']) {
    let percent = action === 'in' ? 50 : 300;
    const visited = [];
    for (let i = 0; i < ZOOM_LEVELS.length; i += 1) {
      visited.push(percent);
      percent = nextZoom(percent, action);
    }
    assert.equal(visited.filter(value => value === 100).length, 1);
  }
});

test('off-grid legacy values choose the nearest strictly directional grid level', () => {
  for (const percent of [67, 75, 80, 90, 110, 125, 150, 175, 200, 250, 50.001, 99.99, 100.01, 299.99, 123.456789]) {
    assert.equal(nextZoom(percent, 'in'), ZOOM_LEVELS.find(level => level > percent));
    assert.equal(nextZoom(percent, 'out'), ZOOM_LEVELS.findLast(level => level < percent));
    assert.equal(nextZoom(percent, 'reset'), 100);
  }
});

test('floating-point noise cannot create a duplicate same-level keyboard step', () => {
  for (let i = 1; i < ZOOM_LEVELS.length - 1; i += 1) {
    const level = ZOOM_LEVELS[i];
    for (const percent of [level, level * (1 + Number.EPSILON), level * (1 - Number.EPSILON)]) {
      assert.equal(nextZoom(percent, 'in'), ZOOM_LEVELS[i + 1]);
      assert.equal(nextZoom(percent, 'out'), ZOOM_LEVELS[i - 1]);
    }
  }
  assert.equal(nextZoom(100.00000000000001, 'out'), fromIndex(-1));
  assert.equal(nextZoom(99.99999999999999, 'in'), fromIndex(1));
});

test('reset is exactly 100 and invalid percentages/actions fail explicitly', () => {
  for (const percent of ZOOM_LEVELS) assert.equal(nextZoom(percent, 'reset'), 100);
  for (const percent of invalidPercents) {
    assert.throws(() => nextZoom(percent, 'in'), RangeError);
    assert.throws(() => nextZoom(percent, 'reset'), RangeError);
    assert.throws(() => percentToPosition(percent), RangeError);
    assert.throws(() => formatZoom(percent), RangeError);
  }
  for (const action of [undefined, '', 'up', 'IN', 1]) assert.throws(() => nextZoom(100, action), TypeError);
});

test('positions use the extended log range and clamp finite overtravel to exact endpoints', () => {
  for (const position of [-Number.MAX_VALUE, -1, 0]) assert.equal(positionToPercent(position), 50);
  for (const position of [1, 2, Number.MAX_VALUE]) assert.equal(positionToPercent(position), 300);
  assert.equal(percentToPosition(50), 0);
  assert.equal(percentToPosition(300), 1);
  assert.equal(neutralPosition, percentToPosition(100));
  close(neutralPosition, fromU(0), 1e-15);
  assert.notEqual(neutralPosition, 0.5, '100 is anchored logarithmically, not centered between endpoints');
  for (const position of [NaN, Infinity, -Infinity, '0.5', null, undefined, {}, new Number(0.5)]) {
    assert.throws(() => positionToPercent(position), RangeError);
  }
});

test('sticky core adds a whole log step to each side beyond ordinary quantization', () => {
  assert.ok(Object.isFrozen(STICKY_POSITIONS));
  close(STICKY_POSITIONS.low, fromU(-0.1), 1e-15);
  close(STICKY_POSITIONS.high, fromU(0.1), 1e-15);
  close(STICKY_POSITIONS.high - STICKY_POSITIONS.low, 0.2 / SPAN_U, 1e-15);
  assert.ok(STICKY_POSITIONS.low < neutralPosition && neutralPosition < STICKY_POSITIONS.high);
  for (const u of [-0.149999, -0.13, -0.1, -0.05, 0, 0.05, 0.1, 0.13, 0.149999]) {
    assert.equal(positionToPercent(fromU(u)), 100, String(u));
  }
  assert.equal(positionToPercent(fromU(-0.150001)), fromIndex(-1));
  assert.equal(positionToPercent(fromU(0.150001)), fromIndex(1));
  assert.equal(positionToPercent(fromU(-0.26)), fromIndex(-2));
  assert.equal(positionToPercent(fromU(0.26)), fromIndex(2));
});

test('quantized tails retain both clamped endpoints without an extra keyboard level', () => {
  assert.equal(positionToPercent(fromU(-0.751)), 50);
  assert.equal(positionToPercent(fromU(-0.749)), fromIndex(-6));
  assert.equal(positionToPercent(fromU(1.149)), fromIndex(10));
  assert.equal(positionToPercent(fromU(1.151)), 300);
  assert.equal(nextZoom(50, 'in'), fromIndex(-6));
  assert.equal(nextZoom(300, 'out'), fromIndex(10));
});

test('drag mapping is monotonic over its whole range and visits every full-double grid level', () => {
  let previous = 50;
  const visited = new Set();
  for (let i = 0; i <= 10000; i += 1) {
    const percent = positionToPercent(i / 10000);
    assert.ok(isZoomPercent(percent));
    assert.ok(percent >= previous);
    assert.ok(ZOOM_LEVELS.includes(percent));
    visited.add(percent);
    previous = percent;
  }
  assert.deepEqual([...visited], ZOOM_LEVELS);
});

test('thumb inverse round-trips all valid grid values with strict position ordering', () => {
  let previous = -1;
  for (const percent of ZOOM_LEVELS) {
    const position = percentToPosition(percent);
    assert.ok(position > previous);
    assert.equal(positionToPercent(position), percent);
    previous = position;
  }
});

test('legacy thumb positions preserve actual logarithms instead of rounding to the grid', () => {
  let previous = -1;
  for (const percent of [50, 67, 75, 80, 90, 99.9, 100, 100.1, 110, 125, 150, 175, 200, 250, 300]) {
    const position = percentToPosition(percent);
    const expectedU = percent === 100 ? 0 : Math.log(percent / 100) + (percent < 100 ? -0.1 : 0.1);
    close(position, fromU(expectedU), 1e-15);
    assert.ok(position > previous);
    const u = MIN_U + position * SPAN_U;
    const log = percent === 100 ? 0 : u + (percent < 100 ? 0.1 : -0.1);
    close(100 * Math.exp(log), percent);
    previous = position;
  }
  assert.notEqual(percentToPosition(125), percentToPosition(fromIndex(2)));
  assert.equal(positionToPercent(percentToPosition(125)), fromIndex(2), 'a later drag quantizes a legacy value');
});

test('only display text is rounded; internal logarithmic values retain full doubles', () => {
  const percent = nextZoom(100, 'in');
  assert.equal(percent, 100 * Math.exp(0.1));
  assert.notEqual(percent, 110.5);
  assert.notEqual(percent, Math.round(percent));
  assert.equal(formatZoom(percent), '110.5');
  assert.equal(formatZoom(fromIndex(-6)), '54.9');
  assert.equal(formatZoom(123.456789), '123.5');
  assert.equal(formatZoom(100), '100');
  assert.equal(formatZoom(300), '300');
  assert.equal(percentToPosition(percent), percentToPosition(100 * Math.exp(0.1)));
});
