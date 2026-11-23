import test from 'node:test';
import assert from 'node:assert/strict';
import { sliderGeometry, popupPosition, inverseZoom, pointerPosition, thumbGrabOffset } from '../src/geometry.js';

const close = (actual, expected, tolerance = 2e-12) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
};
const invalidPositive = [0, -1, NaN, Infinity, -Infinity, '100', undefined, null, true, {}, new Number(100)];
const invalidFinite = [NaN, Infinity, -Infinity, '100', undefined, null, true, {}, new Number(100)];
const anchor = { left: 400, right: 440, top: 80, bottom: 100 };

test('geometry keeps a 30% track with readable thumb and full touch-target end clearance', () => {
  for (const height of [1, 200, 720, 1080, 2160, 10000]) {
    const length = height * 0.3;
    const thumb = Math.max(24, length * .07);
    const hit = Math.max(48, thumb + 16);
    const result = sliderGeometry(height);
    assert.deepEqual(result, {
      length, thumb, hit, track: Math.max(3, Math.min(5, length * .014)),
      panelWidth: hit + 120, panelHeight: length + hit + 128,
    });
    assert.ok(result.thumb >= 24);
    assert.ok(result.hit >= 48 && result.hit - result.thumb >= 16 - 1e-10);
    assert.ok(result.track >= 3 && result.track <= 5);
    if (length * .07 >= 24) close(result.thumb / result.length, .07);
    close(result.panelHeight - result.length - result.hit, 128);
    // Labels start 8px beyond the hitstrip and have a separate 40px column before padding.
    const labelLeft = result.panelWidth / 2 + result.hit / 2 + 8;
    close(result.panelWidth - 12 - labelLeft, 40);
    close(result.hit / 2 - result.hit / 2, 0);
    close(result.hit / 2 + result.length + result.hit / 2, result.length + result.hit);
  }
  assert.equal(sliderGeometry(720).panelWidth, 168);
  assert.ok(sliderGeometry(2160).panelWidth > 168);
});

test('document zoom is not a geometry input and inverse zoom preserves physical dimensions', () => {
  const geometry = sliderGeometry(1000);
  for (const percent of [50, 67, 100, 110.51709180756477, 125, 200, 300]) {
    assert.deepEqual(sliderGeometry(1000), geometry);
    close((percent / 100) * inverseZoom(percent), 1);
    for (const dimension of Object.values(geometry)) {
      close(dimension * (percent / 100) * inverseZoom(percent), dimension);
    }
  }
  assert.equal(inverseZoom(50), 2);
  assert.equal(inverseZoom(100), 1);
  assert.equal(inverseZoom(300), 1 / 3);
});

test('geometry and inverse zoom reject unsafe dimensions and invalid percentages', () => {
  for (const height of invalidPositive) assert.throws(() => sliderGeometry(height), RangeError);
  assert.throws(() => sliderGeometry(Number.MIN_VALUE), RangeError, 'underflow cannot create a zero-width track');
  for (const percent of [...invalidPositive, 49.99, 300.01]) assert.throws(() => inverseZoom(percent), RangeError);
  for (const value of Object.values(sliderGeometry(Number.MAX_VALUE))) {
    assert.ok(Number.isFinite(value) && value > 0);
  }
});

test('popup is centered below the trigger with an 8px gap when it fits', () => {
  const geometry = sliderGeometry(1000);
  assert.deepEqual(popupPosition(1000, 1000, anchor, geometry), {
    left: 420 - geometry.panelWidth / 2,
    top: 108,
  });
});

test('popup flips above a low trigger only when the whole panel fits there', () => {
  const geometry = sliderGeometry(1000);
  const lowAnchor = { left: 400, right: 440, top: 850, bottom: 870 };
  assert.deepEqual(popupPosition(1000, 1000, lowAnchor, geometry), {
    left: 420 - geometry.panelWidth / 2,
    top: lowAnchor.top - 8 - geometry.panelHeight,
  });
  const smallGeometry = sliderGeometry(500);
  const middleAnchor = { left: 400, right: 440, top: 250, bottom: 270 };
  assert.deepEqual(popupPosition(1000, 500, middleAnchor, smallGeometry), {
    left: 420 - smallGeometry.panelWidth / 2,
    top: 500 - smallGeometry.panelHeight - 8,
  });
});

test('popup clamps all four edges into 8px margins when those margins fit', () => {
  const geometry = sliderGeometry(1000);
  const result = patch => popupPosition(1000, 1000, { ...anchor, ...patch }, geometry);
  assert.equal(result({ left: -100, right: -60 }).left, 8);
  assert.equal(result({ left: 980, right: 1020 }).left, 1000 - geometry.panelWidth - 8);
  assert.equal(result({ top: -50, bottom: -20 }).top, 8);
  assert.equal(result({ top: 2000, bottom: 2020 }).top, 1000 - geometry.panelHeight - 8);
});

test('tiny viewports reduce impossible margins and keep oversized panels at a visible origin', () => {
  const geometry = { panelWidth: 88, panelHeight: 109 };
  assert.deepEqual(popupPosition(100, 120, anchor, geometry), { left: 6, top: 5.5 });
  assert.deepEqual(popupPosition(50, 40, anchor, geometry), { left: 0, top: 0 });
  assert.deepEqual(popupPosition(1, 1, anchor, sliderGeometry(1)), { left: 0, top: 0 });
});

test('popup validates viewport, anchor edges and panel dimensions without browser objects', () => {
  const geometry = sliderGeometry(1000);
  for (const value of invalidPositive) {
    assert.throws(() => popupPosition(value, 1000, anchor, geometry), RangeError);
    assert.throws(() => popupPosition(1000, value, anchor, geometry), RangeError);
    assert.throws(() => popupPosition(1000, 1000, anchor, { ...geometry, panelWidth: value }), RangeError);
    assert.throws(() => popupPosition(1000, 1000, anchor, { ...geometry, panelHeight: value }), RangeError);
  }
  for (const edge of ['left', 'right', 'top', 'bottom']) {
    for (const value of invalidFinite) {
      assert.throws(() => popupPosition(1000, 1000, { ...anchor, [edge]: value }, geometry), RangeError);
    }
  }
  assert.throws(() => popupPosition(1000, 1000, null, geometry), RangeError);
  assert.throws(() => popupPosition(1000, 1000, anchor, null), RangeError);
  assert.throws(() => popupPosition(1000, 1000, { ...anchor, left: 441 }, geometry), RangeError);
  assert.throws(() => popupPosition(1000, 1000, { ...anchor, top: 101 }, geometry), RangeError);
});

test('placement arithmetic remains finite even for extreme finite offscreen anchors', () => {
  const geometry = sliderGeometry(1000);
  for (const sign of [-1, 1]) {
    const edge = sign * Number.MAX_VALUE;
    const result = popupPosition(1000, 1000, { left: edge, right: edge, top: edge, bottom: edge }, geometry);
    assert.ok(Number.isFinite(result.left));
    assert.ok(Number.isFinite(result.top));
    assert.ok(result.left >= 8 && result.left + geometry.panelWidth <= 992);
    assert.ok(result.top >= 8 && result.top + geometry.panelHeight <= 992);
  }
});

test('pointer position maps viewport rect top to 1, bottom to 0, and clamps overtravel', () => {
  const rect = { top: 100, height: 300 };
  assert.equal(pointerPosition(100, rect), 1);
  assert.equal(pointerPosition(175, rect), 0.75);
  assert.equal(pointerPosition(250, rect), 0.5);
  assert.equal(pointerPosition(325, rect), 0.25);
  assert.equal(pointerPosition(400, rect), 0);
  assert.equal(pointerPosition(-1000, rect), 1);
  assert.equal(pointerPosition(1000, rect), 0);
});

test('pointer mapping is monotonic and translation invariant without any CSS zoom factor', () => {
  let previous = 1;
  for (let y = -100; y <= 500; y += 1) {
    const position = pointerPosition(y, { top: 100, height: 300 });
    assert.ok(position >= 0 && position <= 1);
    assert.ok(position <= previous);
    for (const offset of [-1000, -200, 1000]) {
      assert.equal(pointerPosition(y + offset, { top: 100 + offset, height: 300 }), position);
    }
    previous = position;
  }
  for (const height of [60, 300, 900]) {
    assert.equal(pointerPosition(50 + height / 4, { top: 50, height }), 0.75);
  }
});

test('finger grabs preserve their offset throughout the full 48px target at every zoom', () => {
  for (const height of [360, 640, 844, 1080, 2160]) {
    const geometry = sliderGeometry(height);
    for (const percent of [50, 100, 300]) {
      const rect = { top: 100, height: geometry.length * (percent / 100) * inverseZoom(percent) };
      for (const position of [0, .25, .5, 1]) {
        const center = rect.top + (1 - position) * rect.height;
        for (const offset of [-geometry.hit / 2, -15, 0, 15, geometry.hit / 2]) {
          const pointer = center + offset;
          close(thumbGrabOffset(pointer, center, geometry.hit), offset);
          close(pointerPosition(pointer - thumbGrabOffset(pointer, center, geometry.hit), rect), position);
        }
        assert.equal(thumbGrabOffset(center + geometry.hit / 2 + 1, center, geometry.hit), 0);
      }
    }
  }
});

test('the enlarged panel remains within ordinary phone and short landscape viewports', () => {
  for (const height of [280, 320, 360, 640, 844]) {
    const geometry = sliderGeometry(height);
    for (const width of [320, 390, 1280]) {
      const placement = popupPosition(width, height, { left: width - 60, right: width - 30, top: 20, bottom: 50 }, geometry);
      assert.ok(placement.left >= 0 && placement.left + geometry.panelWidth <= width);
      assert.ok(placement.top >= 0 && placement.top + geometry.panelHeight <= height);
    }
  }
});

test('very short viewports cap the scrollable popup while retaining the 30% track and reset access', () => {
  for (const height of [160, 180, 200, 240]) {
    const geometry = sliderGeometry(height);
    const visibleHeight = Math.min(geometry.panelHeight, Math.max(1, height - 16));
    const placement = popupPosition(320, height, { left: 240, right: 270, top: 20, bottom: 50 }, { ...geometry, panelHeight: visibleHeight });
    assert.ok(placement.top >= 8);
    assert.ok(placement.top + visibleHeight <= height - 8 + 1e-10);
    assert.ok(geometry.length === height * .3);
    assert.ok(geometry.hit >= 48);
  }
});

test('grab offset validates finite coordinates and positive target size', () => {
  for (const value of invalidFinite) {
    assert.throws(() => thumbGrabOffset(value, 100, 48), RangeError);
    assert.throws(() => thumbGrabOffset(100, value, 48), RangeError);
  }
  for (const value of invalidPositive) assert.throws(() => thumbGrabOffset(100, 100, value), RangeError);
});

test('pointer inputs require finite coordinates and a positive finite track height', () => {
  for (const value of invalidFinite) {
    assert.throws(() => pointerPosition(value, { top: 100, height: 300 }), RangeError);
    assert.throws(() => pointerPosition(100, { top: value, height: 300 }), RangeError);
  }
  for (const value of invalidPositive) {
    assert.throws(() => pointerPosition(100, { top: 100, height: value }), RangeError);
  }
  assert.throws(() => pointerPosition(100, null), RangeError);
  assert.equal(pointerPosition(Number.MAX_VALUE, { top: -Number.MAX_VALUE, height: 1 }), 0);
  assert.equal(pointerPosition(-Number.MAX_VALUE, { top: Number.MAX_VALUE, height: 1 }), 1);
});
