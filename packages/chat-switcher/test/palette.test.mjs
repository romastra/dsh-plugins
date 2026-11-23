import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as api from '../src/palette.js';

const { adaptPalette, parsePaletteColor, paletteLuminance } = api;
const sourceText = readFileSync(new URL('../src/palette.js', import.meta.url), 'utf8');
const context = vm.createContext({});
vm.runInContext(sourceText.replace(/^export /gm, '') + '\nthis.privateApi = {csPaletteRgbToLab,csPaletteLabToLinear,csPaletteEncode,csPaletteSolveLightness,csPaletteMapChroma,csPaletteMaximumChroma,csPaletteShortAngle,csPaletteChromaIterations,csPaletteLightnessIterations};', context);
const math = context.privateApi;
const prefix = '--dsw-static-deepseek-';
// Example runtime snapshot belongs ONLY in tests, not in the production module.
const samples = Object.fromEntries([
  ['50', '#edf3fe'], ['100', '#e4edfd'], ['200', '#d3e2ff'],
  ['300', '#b7c8fe'], ['400', '#7aaaff'], ['450', '#5686fe'],
  ['500', '#4176e6'], ['600', '#4868b2'], ['700-delete', '#2f4c8f'],
  ['800', '#34415b'], ['900', '#283142'],
].map(([name, color]) => [prefix + name, color]));
const epsilon = 1e-7;
const decode = value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
const independentY = rgb => .2126 * decode(rgb[0]) + .7152 * decode(rgb[1]) + .0722 * decode(rgb[2]);
const contrast = (a, b) => (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
const angle = value => Math.atan2(Math.sin(value), Math.cos(value));
const approx = (a, b, tolerance = 1e-10, label = '') => assert.ok(Number.isFinite(a) && Math.abs(a - b) <= tolerance, `${label}: ${a} != ${b}, tolerance ${tolerance}`);
const approxArray = (a, b, tolerance = 1e-10) => { assert.equal(a.length, b.length); a.forEach((value, i) => approx(value, b[i], tolerance, 'component ' + i)); };
const labOf = color => Array.from(math.csPaletteRgbToLab(parsePaletteColor(color)));
const chromaOf = color => { const [, a, b] = labOf(color); return Math.hypot(a, b); };
function fixedY(y, chroma, hue, alpha = 1) {
  const mapped = math.csPaletteMapChroma(y, chroma, hue);
  assert.equal(mapped.fallback, false);
  return [...mapped.rgb, alpha];
}
function hsl(hue, saturation, lightness = .5) {
  const channel = n => {
    const k = (n + hue / 30) % 12;
    const a = saturation * Math.min(lightness, 1 - lightness);
    return lightness - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [channel(0), channel(8), channel(4), 1];
}
function verifyPalette(source, image, { checkHue = true } = {}) {
  const result = adaptPalette(source, image);
  assert.deepEqual(Object.keys(result.colors), Object.keys(source));
  assert.equal(result.diagnostics.adapted, Object.keys(source).length);
  assert.equal(result.diagnostics.skipped, 0);
  assert.equal(result.diagnostics.neutralFallbacks, 0);
  assert.ok(result.diagnostics.maxLuminanceError < epsilon);
  const values = [];
  const target = parsePaletteColor(image);
  const neutral = Math.max(...target.slice(0, 3)) - Math.min(...target.slice(0, 3)) <= 1e-7;
  for (const [name, original] of Object.entries(source)) {
    const from = parsePaletteColor(original), to = parsePaletteColor(result.colors[name]);
    assert.ok(to && to.every(value => Number.isFinite(value) && value >= 0 && value <= 1), name + ': gamut');
    assert.equal(to[3], from[3], name + ': alpha');
    const before = independentY(from), after = independentY(to);
    approx(after, before, 1e-9, name + ': serialized Y');
    values.push([before, after]);
    if (neutral) assert.equal(to[0], to[1]), assert.equal(to[1], to[2]);
    else if (checkHue && chromaOf(from) > 1e-5 && chromaOf(to) > 1e-5) {
      const oldLab = labOf(from), newLab = labOf(to);
      const observed = angle(Math.atan2(newLab[2], newLab[1]) - Math.atan2(oldLab[2], oldLab[1]));
      approx(angle(observed - result.diagnostics.hueShiftDegrees * Math.PI / 180), 0, 2e-5, name + ': shared hue rotation');
    }
  }
  for (let a = 0; a < values.length; a++) for (let b = a + 1; b < values.length; b++) {
    approx(contrast(values[a][1], values[b][1]), contrast(values[a][0], values[b][0]), 1e-8, 'opaque pair contrast');
  }
  return result;
}

test('exact public API, pure math, prefixed internals and bounded numerical loops', () => {
  assert.deepEqual(Object.keys(api).sort(), ['adaptPalette', 'paletteLuminance', 'parsePaletteColor']);
  for (const fn of Object.values(api)) assert.equal(typeof fn, 'function');
  assert.doesNotMatch(sourceText, /^import |\b(?:document|window|__ModuleLoader__)\b/m);
  for (const match of sourceText.matchAll(/^(?:const|let|var|function|class)\s+(\w+)/gm)) assert.match(match[1], /^csPalette/);
  for (const color of Object.values(samples)) assert.ok(!sourceText.includes(color), color + ' must not be a runtime constant');
  for (const name of Object.keys(samples)) assert.ok(!sourceText.includes(name), name + ' must not be a runtime constant');
  assert.ok(math.csPaletteLightnessIterations > 0 && math.csPaletteLightnessIterations <= 64);
  assert.ok(math.csPaletteChromaIterations > 0 && math.csPaletteChromaIterations <= 64);
});

const validColors = [
  ['#fff', [1, 1, 1, 1]], ['#123', [17 / 255, 34 / 255, 51 / 255, 1]],
  ['#1234', [17 / 255, 34 / 255, 51 / 255, 68 / 255]],
  ['#AA00FF80', [170 / 255, 0, 1, 128 / 255]], [' #abcdef ', [171 / 255, 205 / 255, 239 / 255, 1]],
  ['rgb(255, 127.5, 0)', [1, .5, 0, 1]], ['rgba(255,0,0,.125)', [1, 0, 0, .125]],
  ['rgba(10%, 20%, 30%, 40%)', [.1, .2, .3, .4]],
  ['RGB(10% 20% 30% / 50%)', [.1, .2, .3, .5]],
  ['rgb(255 50% 0 / 1)', [1, .5, 0, 1]], ['rgba(1 2 3)', [1 / 255, 2 / 255, 3 / 255, 1]],
  ['color(srgb 1e-1 .2 30% / 2.5e-1)', [.1, .2, .3, .25]],
  ['color( srgb 0 1 0 )', [0, 1, 0, 1]],
  [[.1, .2, .3], [.1, .2, .3, 1]], [[.1, .2, .3, 0], [.1, .2, .3, 0]],
];
for (const [css, expected] of validColors) test('parse explicit sRGB: ' + JSON.stringify(css), () => {
  const parsed = parsePaletteColor(css);
  assert.ok(parsed);
  approxArray(parsed, expected, 2e-15);
  assert.notEqual(parsed, css);
});

test('unsupported, malformed, non-finite, sparse and out-of-range inputs are rejected', () => {
  const invalid = [null, undefined, 12, {}, true, new String('#fff'), '', 'red', 'transparent', 'var(--color)',
    '#12', '#12345', '#1234567', '#123456789', '#ggg', 'rgba(1,2,3,)', 'rgb(1 2)', 'rgb(1 2 3 4)',
    'rgb(1, 2 3, 4)', 'rgb(1,2,3 / .5)', 'rgb(1%,2,3)', 'rgb(-1 0 0)', 'rgb(256 0 0)',
    'rgb(0 0 0 / 101%)', 'rgb(0 0 0 / NaN)', 'rgb(Infinity 0 0)', 'rgb(1e999 0 0)',
    'color(display-p3 1 0 0)', 'color(srgb 1,0,0)', 'color(srgb 1.01 0 0)', 'color(srgb 0 0 0 /)',
    'color(srgb 0 0 0 / .5 / .5)', 'color(srgb none 0 0)', 'rgb(1px 2 3)', 'rgb(0 0 0) junk',
    [], [0, 0], [0, 0, 0, 0, 0], [1, 0, Infinity], [-1, 0, 0], [0, 0, NaN], ['0', 0, 0],
    new Array(3), [0, , 0], new Float32Array([0, 0, 0])];
  for (const color of invalid) assert.equal(parsePaletteColor(color), null, String(color));
});

test('WCAG luminance known vectors and alpha independence', () => {
  for (const [rgb, y] of [[[0, 0, 0], 0], [[1, 1, 1], 1], [[1, 0, 0], .2126], [[0, 1, 0], .7152],
    [[0, 0, 1], .0722], [[.5, .5, .5], .21404114048223255]]) {
    approx(paletteLuminance(rgb), y, 2e-15);
    approx(paletteLuminance([...rgb, 0]), y, 2e-15);
  }
  for (const invalid of [null, 'red', [], [0, 0], [NaN, 0, 0], [2, 0, 0], new Array(3)]) assert.ok(Number.isNaN(paletteLuminance(invalid)));
});

test('canonical OKLab primary vectors and high-precision round trips', () => {
  const references = [
    [[1, 0, 0], [.6279553606145516, .22486306106597398, .1258462985307351]],
    [[0, 1, 0], [.8664396115356694, -.23388757418790818, .17949847989672985]],
    [[0, 0, 1], [.4520137183853429, -.03245698416876397, -.3115281476783751]],
  ];
  for (const [rgb, lab] of references) approxArray(Array.from(math.csPaletteRgbToLab(rgb)), lab, 2e-10);
  let seed = 0x13579bdf;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const colors = [...references.map(([rgb]) => rgb), [0, 0, 0], [1, 1, 1], [.5, .5, .5],
    ...Array.from({ length: 400 }, () => [random(), random(), random()])];
  for (const rgb of colors) {
    const linear = math.csPaletteLabToLinear(math.csPaletteRgbToLab(rgb));
    approxArray(Array.from(linear, math.csPaletteEncode), rgb, 2e-13);
  }
});

test('fixed h,C solve adjusts L to actual Y, checks bracket, and gamut-maps by C', () => {
  const y = .35, hue = 2.1, chroma = .08;
  const linear = math.csPaletteSolveLightness(y, chroma, hue);
  assert.ok(linear);
  approx(.2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2], y, 2e-14);
  const rgb = Array.from(linear, math.csPaletteEncode), lab = labOf(rgb);
  approx(Math.hypot(lab[1], lab[2]), chroma, 2e-14);
  approx(angle(Math.atan2(lab[2], lab[1]) - hue), 0, 2e-14);
  assert.equal(math.csPaletteSolveLightness(.5, 1e4, 1), null);
  const mapped = math.csPaletteMapChroma(.95, 1, Math.PI / 3);
  assert.equal(mapped.reduced, true);
  assert.equal(mapped.fallback, false);
  assert.ok(mapped.rgb.every(value => value >= 0 && value <= 1));
  approx(independentY(mapped.rgb), .95, 1e-10);
  const mappedLab = labOf(Array.from(mapped.rgb));
  approx(angle(Math.atan2(mappedLab[2], mappedLab[1]) - Math.PI / 3), 0, 1e-8);
});

const targets = [];
for (let hue = 0; hue < 360; hue += 15) {
  for (const saturation of [.25, .65, 1]) targets.push({ name: `h${hue}/s${saturation}`, image: hsl(hue, saturation) });
}
for (const image of ['#808080', '#000000', '#ffffff', '#fefefe', '#010101']) targets.push({ name: image, image });
for (const { name, image } of targets) test('all 11 runtime examples: gamut, serialized Y, alpha, hue offsets and all 55 contrasts → ' + name, () => {
  verifyPalette(samples, image);
});

test('same-color invariance across every example and saturated RGB/CMY vertices', () => {
  for (const original of [...Object.values(samples), '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff', '#ff00ff', '#ffffff', '#000000', '#777777']) {
    const result = adaptPalette({ [prefix + 'arbitrary-shade']: original }, original);
    const rgb = parsePaletteColor(result.colors[prefix + 'arbitrary-shade']);
    approxArray(rgb, parsePaletteColor(original), 3e-7);
    assert.equal(result.diagnostics.gamutReduced, 0, original + ': no needless gamut loss');
    assert.equal(result.diagnostics.neutralFallbacks, 0);
  }
});

test('a common-hue equal-relative-saturation palette is approximately invariant', () => {
  const hue = 4.1, saturation = .45;
  const source = Object.fromEntries([.03, .12, .3, .6, .9].map((y, i) => [prefix + 'custom-' + i,
    fixedY(y, math.csPaletteMaximumChroma(y, hue) * saturation, hue)]));
  const result = adaptPalette(source, source[prefix + 'custom-2']);
  approx(result.diagnostics.chromaScale, 1, 2e-7);
  approx(result.diagnostics.hueShiftDegrees, 0, 1e-6);
  for (const name of Object.keys(source)) approxArray(parsePaletteColor(result.colors[name]), source[name], 3e-7);
});

test('relative saturation is multiplicative, continuous towards gray, and capped', () => {
  const name = prefix + 'custom', hue = 1.2, y = .3;
  const original = fixedY(y, .04, hue), halfChroma = fixedY(y, .02, hue);
  const result = adaptPalette({ [name]: original }, halfChroma);
  approx(result.diagnostics.chromaScale, .5, 3e-7);
  approxArray(parsePaletteColor(result.colors[name]), halfChroma, 3e-7);
  const tiny = fixedY(y, .00001, hue);
  const amplified = adaptPalette({ [name]: tiny }, '#ff0000');
  assert.equal(amplified.diagnostics.chromaScale, 4);
  approx(chromaOf(amplified.colors[name]), chromaOf(tiny) * 4, 2e-10);
  const neutral = adaptPalette({ [name]: original }, '#888888');
  const rgb = parsePaletteColor(neutral.colors[name]);
  assert.equal(rgb[0], rgb[1]); assert.equal(rgb[1], rgb[2]);
  approx(independentY(rgb), y, 1e-10);
});

test('circular mean wraps at ±180° and uses one signed shortest hue delta', () => {
  const deg = Math.PI / 180;
  const source = { [prefix + 'a']: fixedY(.3, .04, 179 * deg), [prefix + 'b']: fixedY(.3, .04, -179 * deg) };
  const image = fixedY(.3, .04, -170 * deg);
  const result = verifyPalette(source, image);
  approx(Math.abs(result.diagnostics.referenceHueDegrees), 180, 2e-6);
  approx(result.diagnostics.hueShiftDegrees, 10, 2e-6);
  assert.equal(result.diagnostics.ambiguousHue, false);
  approx(math.csPaletteShortAngle(359 * deg), -deg, 1e-14);
});

test('opposing hues choose deterministic chroma-dominant fallback, independent of record order', () => {
  const first = fixedY(.3, .025, 0), second = fixedY(.3, .025, Math.PI);
  const a = prefix + 'a', b = prefix + 'b';
  const forward = adaptPalette({ [a]: first, [b]: second }, '#00ff00');
  const reversed = adaptPalette({ [b]: second, [a]: first }, '#00ff00');
  assert.equal(forward.diagnostics.ambiguousHue, true);
  assert.equal(reversed.diagnostics.ambiguousHue, true);
  assert.equal(forward.colors[a], reversed.colors[a]);
  assert.equal(forward.colors[b], reversed.colors[b]);
  assert.deepEqual(forward.diagnostics, reversed.diagnostics);
  approx(forward.diagnostics.referenceHueDegrees, 0, 1e-6);
});

test('mixed source hues, gray entries, extreme lightness and saturated targets remain finite', () => {
  const mixed = Object.fromEntries([0, 25, 85, 140, 210, 280, 350].map((hue, i) => [prefix + 'hue-' + i, hsl(hue, .8, .1 + i * .13)]));
  Object.assign(mixed, { [prefix + 'black']: '#000000', [prefix + 'white']: '#ffffff', [prefix + 'gray']: '#808080',
    [prefix + 'near-black']: '#010002', [prefix + 'near-white']: '#fffffe' });
  for (const image of ['#f00', '#0f0', '#00f', '#ff0', '#0ff', '#f0f', '#777', '#000', '#fff']) verifyPalette(mixed, image);
});

test('all-gray source remains exactly neutral without spurious injected hue', () => {
  const grays = Object.fromEntries(['#000', '#010101', '#555', '#bcbcbc', '#fefefe', '#fff'].map((color, i) => [prefix + 'neutral-' + i, color]));
  for (const image of ['#f00', '#0f0', '#00f', '#ff0', '#000', '#fff']) {
    const result = verifyPalette(grays, image, { checkHue: false });
    assert.equal(result.diagnostics.chromaScale, 0);
    for (const color of Object.values(result.colors)) {
      const rgb = parsePaletteColor(color);
      assert.equal(rgb[0], rgb[1]); assert.equal(rgb[1], rgb[2]);
    }
  }
});

test('alpha is exactly preserved across representations, including zero, and is not used as a backdrop', () => {
  const values = ['#4176e680', '#4170', 'rgba(65, 118, 230, .3141592653589793)',
    'rgb(25% 35% 75% / 33.3%)', 'color(srgb .3 .5 .7 / .000000000001)', [.3, .6, .9, 0]];
  const source = Object.fromEntries(values.map((value, i) => [prefix + 'alpha-' + i, value]));
  for (const image of ['#f00', '#0f0', '#888']) {
    const result = adaptPalette(source, image);
    for (const [name, original] of Object.entries(source)) {
      const from = parsePaletteColor(original), to = parsePaletteColor(result.colors[name]);
      assert.equal(to[3], from[3]);
      approx(independentY(to), independentY(from), 1e-9);
    }
  }
  assert.deepEqual(adaptPalette(source, [1, 0, 0, 0]), adaptPalette(source, [1, 0, 0, 1]));
});

test('only eligible brand CSS names change; status palettes, malformed names and invalid values do not', () => {
  const untouched = {
    '--dsw-status-error': '#f00', '--dsw-static-red-500': '#ff0000', '--dsw-static-yellow-100': '#ffff00',
    '--dsw-static-green-500': '#00ff00', '--dsw-static-deepseek-': '#4176e6',
    '--DSW-static-deepseek-500': '#4176e6', '--dsw-static-deepseek-500; color:red': '#4176e6',
    '--dsw-static-deepseek-unsupported': 'oklch(.6 .2 240)', '--dsw-static-deepseek-bad': 'not a color',
    '--dsw-static-deepseek-infinite': [0, Infinity, 0],
  };
  const input = { ...untouched, [prefix + 'bespoke_alpha-2']: '#4176e6', [prefix + '700-delete']: '#2f4c8f' };
  const result = adaptPalette(input, '#00ff00');
  assert.deepEqual(Object.keys(result.colors), Object.keys(input));
  for (const [name, original] of Object.entries(untouched)) assert.deepEqual(result.colors[name], original);
  assert.notEqual(result.colors[prefix + 'bespoke_alpha-2'], input[prefix + 'bespoke_alpha-2']);
  assert.notEqual(result.colors[prefix + '700-delete'], input[prefix + '700-delete']);
  assert.equal(result.diagnostics.adapted, 2);
  assert.equal(result.diagnostics.skipped, Object.keys(untouched).length);
});

test('invalid targets retain the complete source; invalid record and empty palette are safe', () => {
  for (const image of [null, undefined, '#xyz', 'red', 'color(display-p3 1 0 0)', [2, 0, 0]]) {
    const result = adaptPalette(samples, image);
    assert.deepEqual(result.colors, samples);
    assert.notEqual(result.colors, samples);
    assert.equal(result.diagnostics.invalidImage, true);
    assert.equal(result.diagnostics.adapted, 0);
  }
  for (const source of [null, undefined, 'palette', 12, []]) {
    const result = adaptPalette(source, '#f00');
    assert.deepEqual(result.colors, {});
    assert.equal(result.diagnostics.invalidSource, true);
  }
  assert.deepEqual(adaptPalette({}, '#f00').colors, {});
  assert.equal(adaptPalette({}, '#f00').diagnostics.invalidSource, false);
});

test('rounded sRGB cutover does not retain a colored source for a neutral image', () => {
  // These two standard rounded transfer-function breakpoints are not exact
  // inverses; an unnecessarily tight guard previously rejected valid gray.
  for (const y of [.0031308, .003130802, .003130804, .003130806, .003130808]) {
    const r = 1.055 * (y / .2126) ** (1 / 2.4) - .055;
    const name = prefix + 'cutover', source = { [name]: [r, 0, 0, 1] };
    const result = adaptPalette(source, '#808080');
    assert.equal(result.diagnostics.adapted, 1);
    const rgba = parsePaletteColor(result.colors[name]);
    assert.equal(rgba[0], rgba[1]); assert.equal(rgba[1], rgba[2]);
    approx(independentY(rgba), y, 1e-8);
  }
});

test('seeded full-gamut and near-endpoint fuzz preserves serialized Y and alpha', t => {
  let seed = 0x5eed1234, maximumError = 0, maximumContrastError = 0, count = 0;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let run = 0; run < 40; run++) {
    const source = Object.fromEntries(Array.from({ length: 8 }, (_, index) => {
      const rgb = [random(), random(), random()];
      const value = run % 4 === 0 ? rgb.map(channel => channel ** 9) : run % 4 === 1 ? rgb.map(channel => 1 - (1 - channel) ** 9) : rgb;
      return [prefix + 'fuzz-' + index, [...value, random()]];
    }));
    const image = run % 10 === 0 ? '#808080' : [random(), random(), random(), 1];
    const result = adaptPalette(source, image), pairs = [];
    assert.equal(result.diagnostics.adapted, 8);
    for (const [name, from] of Object.entries(source)) {
      const to = parsePaletteColor(result.colors[name]);
      assert.ok(to && to.every(channel => Number.isFinite(channel) && channel >= 0 && channel <= 1));
      assert.equal(to[3], from[3]);
      const oldY = independentY(from), newY = independentY(to);
      maximumError = Math.max(maximumError, Math.abs(oldY - newY));
      approx(oldY, newY, 1e-8);
      pairs.push([oldY, newY]); count++;
    }
    // Alpha is ignored only here to compare uncomposited Y-based contrast.
    for (let a = 0; a < pairs.length; a++) for (let b = a + 1; b < pairs.length; b++) {
      maximumContrastError = Math.max(maximumContrastError, Math.abs(contrast(pairs[a][0], pairs[b][0]) - contrast(pairs[a][1], pairs[b][1])));
    }
  }
  assert.ok(maximumContrastError < 1e-7);
  t.diagnostic(`${count} seeded transforms: max serialized |ΔY|=${maximumError}; max uncomposited contrast error=${maximumContrastError}`);
});

test('no input mutation, no inherited tokens, stable own keys and deterministic output', () => {
  const color = Object.freeze([.2, .4, .8, .12345678912345678]);
  const image = Object.freeze([.8, .2, .3, 1]);
  const input = Object.freeze({ [prefix + 'raw']: color, [prefix + 'hex']: '#abcd', '--status': 'keep' });
  const before = JSON.stringify(input);
  const first = adaptPalette(input, image);
  assert.equal(JSON.stringify(input), before);
  assert.notEqual(first.colors, input);
  for (let i = 0; i < 3; i++) assert.deepEqual(adaptPalette(input, image), first);
  const inherited = Object.create({ [prefix + 'inherited']: '#4176e6' });
  inherited[prefix + 'own'] = '#4176e6';
  assert.deepEqual(Object.keys(adaptPalette(inherited, '#0f0').colors), [prefix + 'own']);
  const hostile = Object.fromEntries([['__proto__', '#f00'], ['constructor', '#f00'], [prefix + 'x', '#4176e6']]);
  const result = adaptPalette(hostile, '#0f0');
  assert.deepEqual(Object.keys(result.colors), Object.keys(hostile));
  assert.equal(Object.getPrototypeOf(result.colors), Object.prototype);
  assert.equal(Object.hasOwn(result.colors, '__proto__'), true);
  assert.equal(result.colors.__proto__, '#f00');
});
