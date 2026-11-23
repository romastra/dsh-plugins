import test from 'node:test';
import assert from 'node:assert/strict';
import { captureCurtain, captureCardCurtain, curtainGeometry, bindCurtain, CURTAIN_CSS } from '../src/transition.js';
import { tensionModel } from '../src/tension.js';

function curtainNear(actual, expected) {
  assert.ok(Math.abs(actual - expected) <= Math.max(1, Math.abs(expected)) * 1e-12, `${actual} ≈ ${expected}`);
}

const curtainStartTransform = 'translate(0px, 0px) scale(1)';
const curtainEndTransform = geometry => `translate(${geometry.translateX}px, ${geometry.translateY}px) scale(${geometry.scale})`;

function curtainCoverage(circle, viewport, zoom, target = null, shape = 'circle') {
  const geometry = curtainGeometry(circle, viewport, zoom, target, shape);
  assert.ok(geometry);
  const centerX = (geometry.left + geometry.width / 2) * zoom;
  const centerY = (geometry.top + geometry.height / 2) * zoom;
  curtainNear(centerX, circle.left + circle.width / 2);
  curtainNear(centerY, circle.top + circle.height / 2);
  if (shape === 'card') {
    curtainNear(geometry.width * zoom, circle.width); curtainNear(geometry.height * zoom, circle.height);
  } else {
    curtainNear(geometry.size * zoom * 54 / 64, Math.max(circle.width, circle.height));
    curtainNear(geometry.width, geometry.size); curtainNear(geometry.height, geometry.size);
  }
  const endX = centerX + geometry.translateX * zoom, endY = centerY + geometry.translateY * zoom;
  const destination = target || { left: viewport.left ?? 0, top: viewport.top ?? 0,
    width: viewport.width, height: viewport.height };
  curtainNear(endX, destination.left + destination.width / 2);
  curtainNear(endY, destination.top + destination.height / 2);
  const radius = (shape === 'card' ? Math.min(geometry.width, geometry.height) / 2
    : geometry.size * 27 / 64) * zoom * geometry.scale;
  for (const x of [viewport.left ?? 0, (viewport.left ?? 0) + viewport.width]) {
    for (const y of [viewport.top ?? 0, (viewport.top ?? 0) + viewport.height]) {
      assert.ok(radius >= Math.hypot(x - endX, y - endY) + 1.99, 'filled source covers every corner from its end center, with overscan');
    }
  }
  return geometry;
}

for (const [name, circle, viewport] of [
  ['portrait left edge', { left: -60, top: 220, width: 216, height: 216 }, { width: 390, height: 844 }],
  ['landscape right edge', { left: 1180, top: 180, width: 224.64, height: 224.64 }, { width: 1365, height: 768 }],
  ['offset viewport', { left: -150, top: -80, width: 108, height: 108 }, { left: -30, top: 40, width: 1100, height: 900 }],
]) {
  test(`geometry preserves the initial glyph and fills ${name}, at every effective CSS zoom`, () => {
    Object.freeze(circle); Object.freeze(viewport);
    const beforeCircle = { ...circle }, beforeViewport = { ...viewport };
    let scale;
    for (const zoom of [.5, .8, 1, 1.25, 2]) {
      const geometry = curtainCoverage(circle, viewport, zoom);
      if (scale !== undefined) curtainNear(geometry.scale, scale);
      scale = geometry.scale;
    }
    assert.deepEqual(circle, beforeCircle); assert.deepEqual(viewport, beforeViewport);
  });
}

test('geometry accounts for head r27 inside the outer 64-unit SVG, not the track bounds', () => {
  const circle = { left: 100, top: 200, width: 54, height: 54 };
  const a = curtainGeometry(circle, { width: 800, height: 600 });
  assert.equal(a.left, 95); assert.equal(a.top, 195); assert.equal(a.size, 64);
  const b = curtainGeometry(circle, { width: 800, height: 600 }, 2);
  assert.equal(b.left, 47.5); assert.equal(b.top, 97.5); assert.equal(b.size, 32); assert.equal(b.scale, a.scale);
});

test('geometry permits a clipped negative head position and never shrinks an already covering circle', () => {
  const geometry = curtainGeometry({ left: -1000, top: -1000, width: 2000, height: 2000 }, { width: 100, height: 100 });
  assert.ok(geometry.left < 0); assert.equal(geometry.scale, 1);
});

test('geometry rejects missing, nonfinite, empty and overflowing dimensions without coercing inputs', () => {
  const valid = { left: 0, top: 0, width: 100, height: 100 };
  for (const bad of [undefined, null, {}, { ...valid, left: NaN }, { ...valid, top: Infinity },
    { ...valid, left: '0' }, { ...valid, width: 0 }, { ...valid, height: -1 },
    { ...valid, width: Infinity }, { ...valid, left: Number.MAX_VALUE, width: Number.MAX_VALUE }]) {
    assert.equal(curtainGeometry(bad, { width: 800, height: 600 }), null);
  }
  for (const bad of [undefined, null, {}, { width: 0, height: 10 }, { width: 10, height: NaN },
    { width: '800', height: 600 }, { left: Infinity, top: 0, width: 800, height: 600 }]) {
    assert.equal(curtainGeometry(valid, bad), null);
  }
  for (const zoom of [0, -1, Infinity, NaN, null, '2']) {
    assert.deepEqual(curtainGeometry(valid, { width: 800, height: 600 }, zoom), curtainGeometry(valid, { width: 800, height: 600 }));
  }
});

for (const [name, shape, source, viewport, target] of [
  ['left circle', 'circle', { left: -45, top: 260, width: 216, height: 216 },
    { width: 1200, height: 900 }, { left: 260, top: 30, width: 900, height: 790 }],
  ['right circle', 'circle', { left: 1230, top: 90, width: 108, height: 108 },
    { width: 1365, height: 768 }, { left: 340, top: 45, width: 800, height: 640 }],
  ['landscape card', 'card', { left: 80, top: 170, width: 320, height: 180 },
    { width: 1200, height: 900 }, { left: 260, top: 30, width: 900, height: 790 }],
  ['portrait card in an offset viewport', 'card', { left: -70, top: 50, width: 130, height: 260 },
    { left: -20, top: 40, width: 1100, height: 950 }, { left: 300, top: 100, width: 680, height: 700 }],
]) {
  test(`geometry moves ${name} to the chat-area center without distorting the source at any CSS zoom`, () => {
    Object.freeze(source); Object.freeze(viewport); Object.freeze(target);
    const before = { source: { ...source }, viewport: { ...viewport }, target: { ...target } };
    let scale;
    for (const zoom of [.5, .8, 1, 1.25, 2]) {
      const geometry = curtainCoverage(source, viewport, zoom, target, shape);
      curtainNear(geometry.translateX, (target.left + target.width / 2 - source.left - source.width / 2) / zoom);
      curtainNear(geometry.translateY, (target.top + target.height / 2 - source.top - source.height / 2) / zoom);
      if (shape === 'card') {
        curtainNear(geometry.left * zoom, source.left); curtainNear(geometry.top * zoom, source.top);
        curtainNear(geometry.width / geometry.height, source.width / source.height);
        curtainNear(geometry.size * zoom, Math.max(source.width, source.height));
      }
      if (scale !== undefined) curtainNear(geometry.scale, scale);
      scale = geometry.scale;
    }
    assert.deepEqual({ source, viewport, target }, before);
  });
}

test('scale covers from the final target center rather than the offscreen source center', () => {
  const source = { left: -1000, top: -600, width: 54, height: 54 };
  const viewport = { width: 800, height: 600 };
  const target = { left: 500, top: 100, width: 200, height: 300 };
  const geometry = curtainCoverage(source, viewport, 1, target);
  curtainNear(geometry.scale, (Math.hypot(600, 350) + 2) / 27);
  const card = curtainCoverage({ ...source, width: 180, height: 90 }, viewport, 1, target, 'card');
  curtainNear(card.scale, (Math.hypot(600, 350) + 2) / 45);
});

test('missing/malformed targets fall back to the viewport center without DOM measurements', () => {
  const source = { left: 10, top: 20, width: 180, height: 100 };
  const viewport = { left: -30, top: 40, width: 800, height: 600 };
  const fallback = curtainGeometry(source, viewport, 1.25, null, 'card');
  for (const target of [undefined, null, {}, { left: NaN, top: 0, width: 100, height: 100 },
    { left: 0, top: 0, width: 0, height: 100 }, { left: '0', top: 0, width: 100, height: 100 },
    { left: Number.MAX_VALUE, top: 0, width: Number.MAX_VALUE, height: 100 },
    { getBoundingClientRect() { throw new Error('target must be a snapshot, not measured'); } }]) {
    assert.deepEqual(curtainGeometry(source, viewport, 1.25, target, 'card'), fallback);
  }
});

test('legacy circle geometry remains square and conservative for a nonsquare source or unknown shape', () => {
  const source = { left: 100, top: 200, width: 54, height: 108 };
  const viewport = { width: 800, height: 600 };
  const geometry = curtainCoverage(source, viewport, 1);
  assert.equal(geometry.size, 128); assert.equal(geometry.width, 128); assert.equal(geometry.height, 128);
  assert.deepEqual(curtainGeometry(source, viewport, 1, null, 'unknown'), geometry);
});

test('capture snapshots exactly the owned head and actual shown image, without reading the area or foreign DOM', () => {
  const rect = Object.freeze({ left: -18, top: 100, width: 224.64, height: 224.64 });
  const calls = [];
  const owner = Object.freeze({
    querySelector(selector) {
      calls.push(selector);
      if (selector === '.cs-tension-head') return { getBoundingClientRect() { calls.push('head.bounds'); return rect; } };
      if (selector === '.cs-tension-head-svg image') return { getAttribute(name) { assert.equal(name, 'href'); return 'shown-mosaic'; } };
      throw new Error('foreign selector');
    },
    get textContent() { throw new Error('must not read text'); },
  });
  const area = { getBoundingClientRect() { throw new Error('must not measure fallback'); }, get currentCSSZoom() { throw new Error('unused zoom'); } };
  const result = captureCurtain({ owner, area, image: 'stale-image' });
  assert.deepEqual(result, { circle: rect, image: 'shown-mosaic' }); assert.notEqual(result.circle, rect);
  assert.deepEqual(calls, ['.cs-tension-head', '.cs-tension-head-svg image', 'head.bounds']);
});

test('capture uses SVG href.baseVal and retains the supplied image when the owned image is unavailable', () => {
  const rect = { left: 10, top: 20, width: 216, height: 216 };
  let imageNode = { href: { baseVal: 'animated-svg-href' } };
  const owner = { querySelector: selector => selector === '.cs-tension-head' ? { getBoundingClientRect: () => rect } : imageNode };
  assert.equal(captureCurtain({ owner, image: 'fallback' }).image, 'animated-svg-href');
  imageNode = null; assert.equal(captureCurtain({ owner, image: 'fallback' }).image, 'fallback');
  assert.equal(captureCurtain({ owner }).image, null);
  imageNode = { getAttribute() { throw new Error('optional API failure'); } };
  assert.equal(captureCurtain({ owner, image: 'fallback' }).image, 'fallback');
});

for (const side of ['left', 'right']) {
  test(`missing head fallback follows tensionModel ready geometry on the ${side}, including own effective zoom`, () => {
    const bounds = Object.freeze({ left: 80, top: 20, width: 900, height: 700 });
    const zoom = 1.5, distance = 104, model = tensionModel(distance, true);
    let measurements = 0;
    const area = Object.freeze({ currentCSSZoom: zoom, getBoundingClientRect() { measurements++; return bounds; } });
    const view = { getComputedStyle() { throw new Error('effective own zoom takes precedence'); } };
    const result = captureCurtain({ owner: { querySelector: () => null }, area, view, distance, side, image: 'fallback-mosaic' });
    const diameter = 54 * model.scale * 4 * zoom;
    const centerX = side === 'left' ? bounds.left + model.reach * 4 * zoom : bounds.left + bounds.width - model.reach * 4 * zoom;
    curtainNear(result.circle.left, centerX - diameter / 2);
    curtainNear(result.circle.top, bounds.top + bounds.height / 2 - diameter / 2);
    curtainNear(result.circle.width, diameter); curtainNear(result.circle.height, diameter);
    assert.equal(result.image, 'fallback-mosaic'); assert.equal(measurements, 1);
  });
}

test('capture fallback uses only root computed zoom when currentCSSZoom is unavailable, otherwise defaults to one', () => {
  const root = {}, area = { getBoundingClientRect: () => ({ left: 10, top: 20, width: 1000, height: 600 }) };
  const view = { document: { documentElement: root }, getComputedStyle(element) { assert.equal(element, root); return { zoom: '125%' }; } };
  const options = { area, view, distance: 80, side: 'left' };
  const zoomed = captureCurtain(options);
  curtainNear(zoomed.circle.width, 54 * tensionModel(80, true).scale * 4 * 1.25);
  view.getComputedStyle = () => ({ zoom: 'normal' });
  curtainNear(captureCurtain(options).circle.width, zoomed.circle.width / 1.25);
  view.getComputedStyle = () => { throw new Error('computed style failure'); };
  curtainNear(captureCurtain(options).circle.width, zoomed.circle.width / 1.25);
});

test('capture returns null for missing or invalid geometry; a present invalid head never triggers area reads', () => {
  assert.equal(captureCurtain(), null);
  assert.equal(captureCurtain({ owner: { querySelector: () => null }, side: 'left' }), null);
  assert.equal(captureCurtain({ area: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) }, side: 'invalid' }), null);
  const area = { getBoundingClientRect() { throw new Error('must not use fallback for a present head'); } };
  for (const rect of [null, {}, { left: 0, top: NaN, width: 100, height: 100 }, { left: 0, top: 0, width: 0, height: 100 }]) {
    const owner = { querySelector: selector => selector === '.cs-tension-head' ? { getBoundingClientRect: () => rect } : null };
    assert.equal(captureCurtain({ owner, area, side: 'left' }), null);
  }
  assert.equal(captureCurtain({ owner: { querySelector() { throw new Error('query failed'); } } }), null);
  assert.equal(captureCurtain({ area, side: 'left' }), null);
});

// API oracles for the owned preview/grid only, not a DOM or renderer substitute.
function curtainCard({ rect = { left: 100, top: 200, width: 240, height: 120 },
  imageNode = { currentSrc: 'shown-card-image' }, zoom = 1, style = { borderTopLeftRadius: '12px' },
  clipRect = null } = {}) {
  const events = [];
  const preview = {
    currentCSSZoom: zoom,
    matches(selector) { assert.equal(selector, '.cs-preview'); events.push('preview.matches'); return true; },
    getBoundingClientRect() { events.push('preview.bounds'); return rect; },
    querySelector(selector) { assert.equal(selector, 'img.cs-mosaic'); events.push('preview.image'); return imageNode; },
    get textContent() { throw new Error('no task/chat text'); },
    get parentElement() { throw new Error('no foreign ancestors'); },
    closest() { throw new Error('no foreign traversal'); },
  };
  const clip = { getBoundingClientRect() { events.push('clip.bounds'); return clipRect; },
    get textContent() { throw new Error('no grid text'); }, querySelector() { throw new Error('no grid traversal'); } };
  const view = { innerWidth: 1000, innerHeight: 800,
    getComputedStyle(element) { assert.equal(element, preview); events.push('preview.radius'); return style; },
    get document() { throw new Error('no foreign document'); },
  };
  const options = { preview, clip: clipRect ? clip : null, view, image: 'fallback-card-image' };
  return { preview, clip, view, rect, events, options };
}

test('card capture snapshots only the owned preview rect and actual mosaic, preserving source radius in screen px', () => {
  const fixture = curtainCard({ zoom: 1.5, imageNode: { currentSrc: 'responsive-current-image',
    get src() { throw new Error('must prefer actual currentSrc'); } } });
  Object.freeze(fixture.rect);
  const result = captureCardCurtain(fixture.options);
  assert.deepEqual(result, { circle: fixture.rect, image: 'responsive-current-image', shape: 'card', radius: 18, crop: null });
  assert.notEqual(result.circle, fixture.rect);
  result.circle.left = -999; assert.equal(fixture.rect.left, 100);
  assert.deepEqual(fixture.events, ['preview.matches', 'preview.bounds', 'preview.image', 'preview.radius']);
});

test('card image/radius optional API failures retain usable owned geometry and supplied image', () => {
  for (const [imageNode, expected] of [
    [{ currentSrc: '', src: 'actual-src' }, 'actual-src'],
    [{ currentSrc: '', src: '', getAttribute(name) { assert.equal(name, 'src'); return 'attribute-src'; } }, 'attribute-src'],
    [null, 'fallback-card-image'], [{ get currentSrc() { throw new Error('image API failure'); } }, 'fallback-card-image'],
  ]) {
    const fixture = curtainCard({ imageNode });
    fixture.view.getComputedStyle = () => { throw new Error('optional style API failure'); };
    const result = captureCardCurtain(fixture.options);
    assert.equal(result.image, expected); assert.equal(result.radius, 0); assert.equal(result.shape, 'card');
  }
  const fixture = curtainCard({ imageNode: null });
  assert.equal(captureCardCurtain({ ...fixture.options, image: undefined }).image, null);
});

test('card radius accepts owned px/percentage styles, clamps rounding and never reads task text', () => {
  for (const [style, zoom, expected] of [
    [{ borderTopLeftRadius: '12px' }, 2, 24], [{ borderTopLeftRadius: '25%' }, 2, 30],
    [{ borderRadius: '9px' }, 1.5, 13.5], [{ borderTopLeftRadius: '999px' }, 2, 60],
    [{ borderTopLeftRadius: '-8px' }, 1, 0], [{ borderTopLeftRadius: 'normal' }, 1, 0], [{}, 1, 0],
  ]) {
    const fixture = curtainCard({ style, zoom });
    assert.equal(captureCardCurtain(fixture.options).radius, expected);
  }
});

test('card capture rejects missing/nonowned/invalid preview nodes without falling back to card labels or other DOM', () => {
  assert.equal(captureCardCurtain(), null);
  const nonowned = curtainCard(); nonowned.preview.matches = () => false;
  assert.equal(captureCardCurtain(nonowned.options), null); assert.deepEqual(nonowned.events, []);
  const failedMatch = curtainCard(); failedMatch.preview.matches = () => { throw new Error('matches failure'); };
  assert.equal(captureCardCurtain(failedMatch.options), null);
  for (const rect of [null, {}, { left: 0, top: 0, width: 0, height: 100 }, { left: NaN, top: 0, width: 100, height: 100 }]) {
    const fixture = curtainCard({ rect });
    assert.equal(captureCardCurtain(fixture.options), null);
    assert.deepEqual(fixture.events, ['preview.matches', 'preview.bounds']);
  }
  const thrown = curtainCard(); thrown.preview.getBoundingClientRect = () => { throw new Error('bounds failure'); };
  assert.equal(captureCardCurtain(thrown.options), null);
});

test('card crop intersects the exact owned preview with both grid and viewport, keeping original source dimensions', () => {
  const fixture = curtainCard({ rect: { left: 80, top: 70, width: 240, height: 160 },
    clipRect: { left: 100, top: 100, width: 180, height: 100 } });
  Object.freeze(fixture.rect); Object.freeze(fixture.options);
  const result = captureCardCurtain(fixture.options);
  assert.deepEqual(result.circle, fixture.rect); assert.notEqual(result.circle, fixture.rect);
  assert.deepEqual(result.crop, { top: 30, right: 40, bottom: 30, left: 20 });
  assert.deepEqual(fixture.events, ['preview.matches', 'preview.bounds', 'clip.bounds', 'preview.image', 'preview.radius']);
  fixture.view.innerWidth = 250; fixture.view.innerHeight = 180;
  assert.deepEqual(captureCardCurtain(fixture.options).crop, { top: 30, right: 70, bottom: 50, left: 20 });
});

test('viewport clipping handles every source edge and the actual visual viewport, not its larger coverage union', () => {
  const fixture = curtainCard({ rect: { left: -20, top: -10, width: 300, height: 220 } });
  fixture.view.innerWidth = 250; fixture.view.innerHeight = 180;
  assert.deepEqual(captureCardCurtain(fixture.options).crop, { top: 10, right: 30, bottom: 30, left: 20 });
  const visual = curtainCard({ rect: { left: 0, top: 0, width: 400, height: 300 } });
  visual.view.visualViewport = { offsetLeft: 50, offsetTop: 20, width: 180, height: 100 };
  assert.deepEqual(captureCardCurtain(visual.options).crop, { top: 20, right: 170, bottom: 180, left: 50 });
  visual.view.visualViewport.width = 0;
  assert.equal(captureCardCurtain(visual.options).crop, null);
});

test('wholly invisible cards, unavailable viewport and invalid owned grid geometry skip animation without image/text reads', () => {
  for (const rect of [
    { left: -200, top: 20, width: 100, height: 100 }, { left: 1000, top: 20, width: 100, height: 100 },
    { left: 20, top: 800, width: 100, height: 100 }, { left: 20, top: -100, width: 100, height: 100 },
  ]) {
    const fixture = curtainCard({ rect });
    assert.equal(captureCardCurtain(fixture.options), null);
    assert.deepEqual(fixture.events, ['preview.matches', 'preview.bounds']);
  }
  const clipped = curtainCard({ clipRect: { left: 600, top: 100, width: 100, height: 100 } });
  assert.equal(captureCardCurtain(clipped.options), null);
  assert.deepEqual(clipped.events, ['preview.matches', 'preview.bounds', 'clip.bounds']);
  const noViewport = curtainCard(); delete noViewport.view.innerWidth;
  assert.equal(captureCardCurtain(noViewport.options), null);
  const invalidClip = curtainCard();
  assert.equal(captureCardCurtain({ ...invalidClip.options, clip: invalidClip.clip }), null);
  invalidClip.clip.getBoundingClientRect = () => { throw new Error('invalid owned grid'); };
  assert.equal(captureCardCurtain({ ...invalidClip.options, clip: invalidClip.clip }), null);
});

// These doubles represent only the two owned nodes and their Web API inputs;
// no renderer, page DOM, native dialog or browser implementation is simulated.
function curtainClock() {
  let id = 0;
  const frames = new Map(), timers = new Map(), events = [];
  const view = {
    requestAnimationFrame(callback) { const next = id++; frames.set(next, callback); events.push('raf.request'); return next; },
    cancelAnimationFrame(key) { events.push('raf.cancel'); frames.delete(key); },
    setTimeout(callback, delay) { const next = id++; timers.set(next, { callback, delay }); return next; },
    clearTimeout(key) { timers.delete(key); },
  };
  return { view, frames, timers, events,
    runFrame() { const [key, callback] = frames.entries().next().value; frames.delete(key); callback(); },
    runTimer() { const [key, timer] = timers.entries().next().value; timers.delete(key); timer.callback(); },
  };
}

function curtainBinding({ zoom = 1, reduced = false, popover = true } = {}) {
  const clock = curtainClock();
  let resolve, reject;
  const finished = new Promise((yes, no) => { resolve = yes; reject = no; });
  const state = { zoom, done: 0, hidden: 0, cancelled: 0, keyframes: null, options: null };
  const animation = { finished, onfinish: null, oncancel: null, cancel() { state.cancelled++; } };
  const root = { get style() { throw new Error('no global styles'); } };
  const view = Object.assign(clock.view, {
    innerWidth: 1000, innerHeight: 800,
    document: { documentElement: root, get body() { throw new Error('no body access'); } },
    getComputedStyle(element) { assert.equal(element, root); clock.events.push('zoom.root'); return { zoom: '1.25' }; },
    matchMedia(query) { assert.equal(query, '(prefers-reduced-motion: reduce)'); return { matches: reduced }; },
    addEventListener() { throw new Error('no global subscriptions'); },
  });
  const host = {
    popover: popover ? 'manual' : null,
    get currentCSSZoom() { clock.events.push('zoom.host'); return state.zoom; },
    showPopover() { clock.events.push('popover.show'); },
    hidePopover() { clock.events.push('popover.hide'); state.hidden++; },
    focus() { throw new Error('no focus'); },
    getBoundingClientRect() { throw new Error('no host geometry read'); },
    querySelector() { throw new Error('no host DOM traversal'); },
  };
  const bubble = {
    style: {},
    animate(keyframes, options) { clock.events.push('animate'); state.keyframes = keyframes; state.options = options; return animation; },
    focus() { throw new Error('no focus'); },
    getBoundingClientRect() { throw new Error('no bubble geometry read'); },
  };
  const circle = Object.freeze({ left: -20, top: 180, width: 216, height: 216 });
  const options = { view, host, bubble, circle, onDone() { clock.events.push('done'); state.done++; } };
  return { ...clock, view, host, bubble, circle, state, animation, resolve, reject, options,
    bind(extra = {}) { return bindCurtain({ ...options, ...extra }); },
  };
}

test('binding schedules exactly one RAF so dialog layout effect precedes popover; zoom is measured after showing', () => {
  const fixture = curtainBinding();
  fixture.host.showPopover = () => { fixture.events.push('popover.show'); fixture.state.zoom = 2; };
  const off = fixture.bind();
  assert.deepEqual(fixture.events, ['raf.request']); assert.deepEqual(fixture.bubble.style, {});
  fixture.events.push('dialog.showModal'); fixture.runFrame();
  assert.deepEqual(fixture.events, ['raf.request', 'dialog.showModal', 'popover.show', 'zoom.host', 'animate']);
  const geometry = curtainGeometry(fixture.circle, { width: 1000, height: 800 }, 2);
  assert.equal(fixture.bubble.style.left, geometry.left + 'px'); assert.equal(fixture.bubble.style.top, geometry.top + 'px');
  assert.equal(fixture.bubble.style.width, geometry.size + 'px'); assert.equal(fixture.bubble.style.height, geometry.size + 'px');
  assert.deepEqual(fixture.state.keyframes, [{ transform: curtainStartTransform, opacity: 1 }, { transform: curtainEndTransform(geometry), opacity: 0 }]);
  assert.deepEqual(fixture.state.options, { duration: 280, easing: 'ease-out', fill: 'forwards' });
  assert.equal(fixture.frames.size, 0); assert.equal(fixture.timers.size, 1); off();
});

test('card binding preserves exact non-square preview, radius and flat grid crop while moving/scaling to chat center', () => {
  const fixture = curtainBinding({ zoom: 2 });
  const circle = Object.freeze({ left: 120, top: 180, width: 320, height: 180 });
  const target = Object.freeze({ left: 300, top: 40, width: 650, height: 700,
    getBoundingClientRect() { throw new Error('target is a copied own rect, never measured'); } });
  const crop = Object.freeze({ top: 30, right: 40, bottom: 10, left: 20 });
  const off = fixture.bind({ circle, target, shape: 'card', radius: 18, crop }); fixture.runFrame();
  const geometry = curtainGeometry(circle, { width: 1000, height: 800 }, 2, target, 'card');
  assert.equal(fixture.bubble.style.left, '60px'); assert.equal(fixture.bubble.style.top, '90px');
  assert.equal(fixture.bubble.style.width, '160px'); assert.equal(fixture.bubble.style.height, '90px');
  assert.equal(fixture.bubble.style.borderRadius, '9px'); assert.equal(fixture.bubble.style.overflow, 'hidden');
  assert.equal(fixture.bubble.style.transform, curtainStartTransform);
  assert.equal(fixture.bubble.style.clipPath, 'inset(15px 20px 5px 10px)');
  assert.doesNotMatch(fixture.bubble.style.clipPath, /round/);
  assert.deepEqual(fixture.state.keyframes, [
    { transform: curtainStartTransform, opacity: 1, clipPath: 'inset(15px 20px 5px 10px)' },
    { transform: curtainEndTransform(geometry), opacity: 0, clipPath: 'inset(0px 0px 0px 0px)' },
  ]);
  assert.deepEqual(fixture.state.options, { duration: 280, easing: 'ease-out', fill: 'forwards' });
  fixture.animation.onfinish(); assert.equal(fixture.state.done, 1); assert.equal(fixture.state.hidden, 1);
  assert.equal(fixture.timers.size, 0); off();
});

test('circle binding uses the same copied chat-center target but never reads or animates card crop', () => {
  const fixture = curtainBinding({ zoom: 1.25 });
  const target = Object.freeze({ left: 320, top: 90, width: 600, height: 500 });
  const crop = new Proxy({}, { get() { throw new Error('circle must ignore card crop'); } });
  const off = fixture.bind({ target, crop }); fixture.runFrame();
  const geometry = curtainGeometry(fixture.circle, { width: 1000, height: 800 }, 1.25, target);
  assert.equal(fixture.bubble.style.overflow, 'visible'); assert.equal(fixture.bubble.style.borderRadius, '0px');
  assert.equal(fixture.bubble.style.clipPath, 'none');
  assert.deepEqual(fixture.state.keyframes, [
    { transform: curtainStartTransform, opacity: 1 }, { transform: curtainEndTransform(geometry), opacity: 0 },
  ]);
  off(); assert.equal(fixture.state.cancelled, 1); assert.equal(fixture.state.done, 0);
});

test('reduced-motion cards keep their original crop/position/size and only fade opacity', () => {
  const fixture = curtainBinding({ zoom: 1.25, reduced: true });
  const circle = { left: 120, top: 180, width: 300, height: 120 };
  const crop = { top: 20, right: 0, bottom: 10, left: 30 };
  const off = fixture.bind({ circle, shape: 'card', radius: 12, crop,
    target: { left: 400, top: 20, width: 500, height: 700 } }); fixture.runFrame();
  assert.equal(fixture.bubble.style.width, '240px'); assert.equal(fixture.bubble.style.height, '96px');
  assert.equal(fixture.bubble.style.transform, curtainStartTransform);
  assert.equal(fixture.bubble.style.clipPath, 'inset(16px 0px 8px 24px)');
  assert.deepEqual(fixture.state.keyframes, [{ opacity: 1 }, { opacity: 0 }]);
  assert.ok(fixture.state.options.duration > 0 && fixture.state.options.duration <= 40);
  fixture.runTimer(); assert.equal(fixture.state.done, 1); assert.equal(fixture.state.hidden, 1); off();
});

test('fully visible cards start with zero crop; invalid radii cannot inject nonfinite CSS', () => {
  for (const radius of [undefined, null, '12', -1, NaN, Infinity]) {
    const fixture = curtainBinding(); const off = fixture.bind({ shape: 'card', radius }); fixture.runFrame();
    assert.equal(fixture.bubble.style.borderRadius, '0px');
    assert.equal(fixture.bubble.style.clipPath, 'inset(0px 0px 0px 0px)');
    assert.equal(fixture.state.keyframes[0].clipPath, 'inset(0px 0px 0px 0px)');
    assert.equal(fixture.state.keyframes[1].clipPath, 'inset(0px 0px 0px 0px)'); off();
  }
});

test('malformed or fully clipped card crops finish without WAAPI or an unmasked image flash', () => {
  for (const crop of [{}, { top: -1, right: 0, bottom: 0, left: 0 },
    { top: NaN, right: 0, bottom: 0, left: 0 }, { top: 108, right: 0, bottom: 108, left: 0 },
    { top: 0, right: 216, bottom: 0, left: 0 }]) {
    const fixture = curtainBinding(); const off = fixture.bind({ shape: 'card', crop }); fixture.runFrame();
    assert.equal(fixture.state.done, 1); assert.equal(fixture.state.keyframes, null);
    assert.equal(fixture.timers.size, 0); assert.equal(fixture.bubble.style.opacity, '0'); off();
  }
});

test('normal finish, queued finish/cancel, promise completion and fallback timer call onDone only once', async () => {
  const fixture = curtainBinding(); const off = fixture.bind(); fixture.runFrame();
  const queuedFinish = fixture.animation.onfinish, queuedCancel = fixture.animation.oncancel;
  const queuedTimer = [...fixture.timers.values()][0].callback;
  queuedFinish(); queuedFinish(); queuedCancel(); queuedTimer(); fixture.resolve(); await Promise.resolve();
  assert.equal(fixture.state.done, 1); assert.equal(fixture.state.hidden, 1); assert.equal(fixture.state.cancelled, 1);
  assert.equal(fixture.bubble.style.opacity, '0'); assert.equal(fixture.timers.size, 0); assert.equal(fixture.frames.size, 0);
  off(); off(); assert.equal(fixture.state.hidden, 1); assert.equal(fixture.state.cancelled, 1);
});

test('dispose cancels a pending RAF, including id zero, and guards an already queued frame', () => {
  const fixture = curtainBinding(); const off = fixture.bind(); const queued = [...fixture.frames.values()][0];
  off(); off(); queued();
  assert.equal(fixture.frames.size, 0); assert.equal(fixture.timers.size, 0); assert.equal(fixture.state.done, 0);
  assert.deepEqual(fixture.events, ['raf.request', 'raf.cancel']); assert.deepEqual(fixture.bubble.style, {});
});

test('dispose cancels timer/animation/popover and suppresses queued callbacks and rejected finished promises', async () => {
  const fixture = curtainBinding(); const off = fixture.bind(); fixture.runFrame();
  const queuedFinish = fixture.animation.onfinish, queuedCancel = fixture.animation.oncancel;
  const queuedTimer = [...fixture.timers.values()][0].callback;
  off(); off(); queuedFinish(); queuedCancel(); queuedTimer(); fixture.reject(new Error('cancelled')); await Promise.resolve();
  assert.equal(fixture.state.done, 0); assert.equal(fixture.state.hidden, 1); assert.equal(fixture.state.cancelled, 1);
  assert.equal(fixture.timers.size, 0); assert.equal(fixture.frames.size, 0);
  assert.equal(fixture.animation.onfinish, null); assert.equal(fixture.animation.oncancel, null);
});

test('reduced motion uses a tiny opacity-only fade with no enlargement', () => {
  const fixture = curtainBinding({ reduced: true }); const off = fixture.bind(); fixture.runFrame();
  assert.deepEqual(fixture.state.keyframes, [{ opacity: 1 }, { opacity: 0 }]);
  assert.ok(fixture.state.options.duration > 0 && fixture.state.options.duration <= 40);
  assert.equal(fixture.bubble.style.transform, curtainStartTransform);
  fixture.runTimer(); assert.equal(fixture.state.done, 1); off();
});

test('regular root/inside-dialog fallback never invokes inherited popover methods', () => {
  const fixture = curtainBinding({ popover: false }); const off = fixture.bind(); fixture.runFrame();
  assert.equal(fixture.events.includes('popover.show'), false); assert.ok(fixture.state.keyframes);
  fixture.animation.onfinish(); off(); assert.equal(fixture.state.hidden, 0); assert.equal(fixture.state.done, 1);
});

for (const failure of ['missing', 'throws', 'null', 'finished getter throws']) {
  test(`WAAPI ${failure} has a bounded, non-stuck fallback without extra frames or subscriptions`, () => {
    const fixture = curtainBinding();
    if (failure === 'missing') delete fixture.bubble.animate;
    if (failure === 'throws') fixture.bubble.animate = () => { throw new Error('WAAPI failed'); };
    if (failure === 'null') fixture.bubble.animate = () => null;
    if (failure === 'finished getter throws') Object.defineProperty(fixture.animation, 'finished', { get() { throw new Error('finished failed'); } });
    const off = fixture.bind(); fixture.runFrame();
    assert.equal(fixture.bubble.style.opacity, '0'); assert.equal(fixture.frames.size, 0); assert.equal(fixture.timers.size, 1);
    assert.equal([...fixture.timers.values()][0].delay, 360);
    fixture.runTimer(); assert.equal(fixture.state.done, 1); assert.equal(fixture.state.hidden, 1); assert.equal(fixture.timers.size, 0); off();
  });
}

test('a never-settling animation is bounded, and a rejected finished promise completes safely', async () => {
  const unresolved = curtainBinding(); unresolved.bind(); unresolved.runFrame(); unresolved.runTimer();
  assert.equal(unresolved.state.done, 1); assert.equal(unresolved.state.cancelled, 1);
  const rejected = curtainBinding(); rejected.bind(); rejected.runFrame(); rejected.reject(new Error('external cancellation')); await Promise.resolve();
  assert.equal(rejected.state.done, 1); assert.equal(rejected.state.hidden, 1); assert.equal(rejected.timers.size, 0);
});

for (const failure of ['missing RAF', 'throwing RAF']) {
  test(`${failure} defers popover using one zero-delay timer, and the queued timer is disposable`, () => {
    const fixture = curtainBinding();
    if (failure === 'missing RAF') delete fixture.view.requestAnimationFrame;
    else fixture.view.requestAnimationFrame = () => { throw new Error('RAF failed'); };
    const off = fixture.bind();
    assert.equal(fixture.events.includes('popover.show'), false); assert.equal(fixture.timers.size, 1);
    assert.equal([...fixture.timers.values()][0].delay, 0);
    const queued = [...fixture.timers.values()][0].callback; off(); queued();
    assert.equal(fixture.timers.size, 0); assert.equal(fixture.state.done, 0); assert.equal(fixture.events.includes('popover.show'), false);
  });
}

test('zero-delay scheduling fallback starts normally after the dialog effect', () => {
  const fixture = curtainBinding(); delete fixture.view.requestAnimationFrame;
  const off = fixture.bind(); fixture.events.push('dialog.showModal'); fixture.runTimer();
  assert.ok(fixture.events.indexOf('dialog.showModal') < fixture.events.indexOf('popover.show'));
  assert.equal(fixture.state.options.duration, 280); assert.equal(fixture.timers.size, 1); off();
});

test('failed popover, hidePopover and optional motion APIs cannot retain the owned curtain', () => {
  const failedShow = curtainBinding(); failedShow.host.showPopover = () => { throw new Error('showPopover failed'); };
  failedShow.view.matchMedia = () => { throw new Error('motion query failed'); };
  const offShow = failedShow.bind(); failedShow.runFrame(); failedShow.runTimer();
  assert.equal(failedShow.state.done, 1); assert.equal(failedShow.state.hidden, 0); assert.equal(failedShow.state.options.duration, 280); offShow();
  const failedHide = curtainBinding(); failedHide.host.hidePopover = () => { throw new Error('already hidden'); };
  const offHide = failedHide.bind(); failedHide.runFrame(); failedHide.animation.onfinish();
  assert.equal(failedHide.state.done, 1); assert.equal(failedHide.timers.size, 0); offHide();
});

test('binding uses root computed zoom only as own effective zoom fallback', () => {
  const fixture = curtainBinding({ zoom: 0 }); const off = fixture.bind(); fixture.runFrame();
  assert.ok(fixture.events.indexOf('popover.show') < fixture.events.indexOf('zoom.root'));
  assert.equal(fixture.bubble.style.width, curtainGeometry(fixture.circle, { width: 1000, height: 800 }, 1.25).size + 'px'); off();
});

test('binding supports visualViewport-only geometry and covers union with a displaced layout viewport', () => {
  const only = curtainBinding(); only.view.innerWidth = undefined; only.view.innerHeight = 0;
  only.view.visualViewport = { width: 390, height: 844, offsetLeft: 11, offsetTop: 17 };
  const offOnly = only.bind(); only.runFrame();
  const expectedOnly = curtainGeometry(only.circle, { left: 11, top: 17, width: 390, height: 844 });
  assert.equal(only.state.keyframes[1].transform, curtainEndTransform(expectedOnly)); offOnly();
  const union = curtainBinding(); union.view.visualViewport = { width: 1200, height: 950, offsetLeft: -20, offsetTop: 40 };
  const offUnion = union.bind(); union.runFrame();
  const expectedUnion = curtainGeometry(union.circle, { left: -20, top: 0, width: 1200, height: 990 });
  assert.equal(union.state.keyframes[1].transform, curtainEndTransform(expectedUnion)); offUnion();
});

test('missing nodes, invalid circle or unavailable viewport finish once after scheduling, without starting WAAPI', () => {
  for (const extra of [{ host: null }, { bubble: null }, { circle: null }, { circle: { left: 0, top: 0, width: Infinity, height: 100 } }]) {
    const fixture = curtainBinding(); const off = fixture.bind(extra); assert.equal(fixture.state.done, 0); fixture.runFrame();
    assert.equal(fixture.state.done, 1); assert.equal(fixture.state.options, null); assert.equal(fixture.timers.size, 0); off();
  }
  const fixture = curtainBinding(); fixture.view.innerWidth = 0; const off = fixture.bind(); fixture.runFrame();
  assert.equal(fixture.state.done, 1); assert.equal(fixture.state.options, null); off();
});

test('duration is finite/bounded even for invalid input and reduced motion never enlarges', () => {
  for (const [duration, expected] of [[NaN, 280], [Infinity, 280], [-1, 0], [140, 140], [1e9, 1000]]) {
    const fixture = curtainBinding(); const off = fixture.bind({ duration }); fixture.runFrame();
    assert.equal(fixture.state.options.duration, expected); assert.equal([...fixture.timers.values()][0].delay, expected + 80); off();
  }
});

test('curtain CSS is zero-sized, fixed, transparent, pointer-inert and never clips the full-viewport scaled glyph', () => {
  assert.match(CURTAIN_CSS, /\.cs-curtain\{[^}]*position:fixed;inset:auto;left:0;top:0;width:0;height:0/);
  assert.match(CURTAIN_CSS, /max-width:none;max-height:none;margin:0;padding:0;border:0;overflow:visible/);
  assert.match(CURTAIN_CSS, /\.cs-curtain\{[^}]*background:transparent;pointer-events:none;z-index:\d+/);
  assert.match(CURTAIN_CSS, /\.cs-curtain::backdrop\{background:transparent;pointer-events:none\}/);
  assert.match(CURTAIN_CSS, /\.cs-curtain-bubble\{position:absolute;transform-origin:center;will-change:transform,opacity/);
  assert.match(CURTAIN_CSS, /\.cs-curtain-bubble svg\{display:block;width:100%;height:100%;overflow:visible\}/);
  assert.match(CURTAIN_CSS, /\.cs-curtain-bubble img\{display:block;width:100%;height:100%;object-fit:contain\}/);
  assert.doesNotMatch(CURTAIN_CSS, /object-fit:cover/, 'card mosaics preserve the original full artwork');
  assert.ok(CURTAIN_CSS.includes('.cs-curtain-bubble[data-shape=card]{background:var(--dsw-alias-bg-base)}'), 'non-square card letterboxing keeps the opaque native base behind the original shade');
  assert.doesNotMatch(CURTAIN_CSS, /body|autofocus|membrane|spinner|@keyframes|animation|#[a-f0-9]{3,8}\b|rgba?\(/i);
  assert.doesNotMatch(CURTAIN_CSS, /\.cs-tension-/, 'the root reuses shared glyph styling, rather than this module duplicating it');
});
