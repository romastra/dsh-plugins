import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { buildMosaicScene, createMosaicSvg, getMosaicParameters } from '../src/mosaic.js';

const baseKeys = ['axes', 'colors', 'polygonCount', 'palette', 'rotation'];
const controlKeys = ['cellMix', 'paperRadius', 'chamfer', 'gap', 'radialExponent',
  'contourOffset', 'contourTurnActivity', 'contourExponent', 'powerVariation',
  'composition', 'seamPixels', 'convexity', 'centralInnerRatio', 'occupancyRadius'];
const parameterKeys = [...baseKeys, ...controlKeys];
const fixture = JSON.parse(readFileSync(new URL('./fixtures/mosaic-python.json', import.meta.url), 'utf8'));
const source = ['image-variant','fractal','mosaic'].map(name=>readFileSync(new URL('../src/'+name+'.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'')).join('\n');
const plain = value => JSON.parse(JSON.stringify(value));

function privateHarness() {
  const context = vm.createContext({ TextEncoder });
  vm.runInContext(source.replaceAll('export function ', 'function ') + `
    this.privateApi = {
      getMosaicParameters, parameters, HashRandom, dataUrlCache,
      replaceParameters: fn => { parameters = fn; },
      blockRendering: fail => {
        makeScene = buildMosaicScene = sceneSvg = createMosaicSvg = getMosaicDataUrl = fail;
      },
    };
  `, context);
  return { context, ...context.privateApi };
}

function inputsFromScene(scene) {
  return Object.fromEntries(parameterKeys.map(key => [key,
    baseKeys.includes(key) ? scene[key] : scene.controls[key]]));
}

test('parameter accessor returns exactly the 19 flat variable input keys', () => {
  const result = getMosaicParameters('parameter-keyset');
  assert.equal(parameterKeys.length, 19);
  assert.deepEqual(Object.keys(result).sort(), [...parameterKeys].sort());
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  for (const key of parameterKeys) {
    if (key === 'palette') {
      assert.ok(Array.isArray(result.palette));
      assert.equal(result.palette.length, result.colors);
      assert.ok(result.palette.every(color => typeof color === 'string'));
    } else {
      assert.equal(typeof result[key], key === 'composition' ? 'string' : 'number', key);
    }
  }
});

test('seed validation matches the scene builder without coercion', () => {
  for (const input of [null, undefined, 0, NaN, true, {}, [], new String('seed'), Symbol('seed'), 1n]) {
    for (const fn of [getMosaicParameters, buildMosaicScene]) {
      assert.throws(() => fn(input), { name: 'TypeError', message: 'Session ID must be a string' });
    }
  }
  assert.equal(Object.keys(getMosaicParameters('')).length, 19);
});

test('variable inputs agree exactly with all existing scene parameters and controls', () => {
  for (const seed of [...fixture.records.map(record => record.sessionId), '', 'сессия/東京/🎨', 'e\u0301', 'é']) {
    const scene = buildMosaicScene(seed);
    const result = getMosaicParameters(seed);
    assert.deepEqual(result, inputsFromScene(scene), seed);
    assert.notStrictEqual(result.palette, scene.palette);
    for (const key of controlKeys) assert.equal(result[key], scene.controls[key], seed + '.' + key);
  }
});

test('raw seamPixels is preserved when the renderer forces a visible seam', () => {
  const expected = fixture.records.find(record => record.controls.seamPixels === 0 && record.seamPixels === 1);
  assert.ok(expected, 'fixture must exercise a forced seam');
  const result = getMosaicParameters(expected.sessionId);
  const scene = buildMosaicScene(expected.sessionId);
  assert.equal(result.seamPixels, 0);
  assert.equal(result.seamPixels, scene.controls.seamPixels);
  assert.equal(scene.seamPixels, 1);
});

test('parameter objects and palettes are detached from raw inputs and later calls', () => {
  const harness = privateHarness();
  const [p, controls] = harness.parameters('parameter-detachment');
  const originalPalette = Array.from(p.palette), originalCellMix = controls.cellMix;
  let calls = 0;
  harness.replaceParameters(seed => {
    assert.equal(seed, 'parameter-detachment');
    calls++;
    return [p, controls];
  });
  const result = harness.getMosaicParameters('parameter-detachment');
  assert.equal(calls, 1);
  assert.notStrictEqual(result.palette, p.palette);
  result.palette.fill('mutated');
  result.cellMix = -1;
  result.axes = -1;
  assert.deepEqual(Array.from(p.palette), originalPalette);
  assert.equal(controls.cellMix, originalCellMix);
  assert.ok(p.axes >= 0);
  assert.deepEqual(Array.from(harness.getMosaicParameters('parameter-detachment').palette), originalPalette);

  const seed = 'parameter-detachment-public', before = getMosaicParameters(seed), svg = createMosaicSvg(seed);
  const changed = getMosaicParameters(seed);
  assert.notStrictEqual(changed, before);
  assert.notStrictEqual(changed.palette, before.palette);
  changed.palette.push('mutated');
  changed.cellMix = -1;
  assert.deepEqual(getMosaicParameters(seed), before);
  assert.equal(createMosaicSvg(seed), svg);
});

test('parameter lookup uses only the existing parameter draws, never scene, SVG, DOM or cache work', () => {
  const harness = privateHarness(), fail = () => { throw new Error('Unexpected derived work'); };
  let draws = 0, calls = 0;
  const originalWord = harness.HashRandom.prototype.word;
  harness.HashRandom.prototype.word = function () { draws++; return originalWord.call(this); };
  const seed = 'parameter-only', expected = harness.parameters(seed), expectedDraws = draws;
  draws = 0;
  harness.replaceParameters(value => { calls++; return harness.parameters(value); });
  harness.blockRendering(fail);
  for (const name of ['document', 'window', 'Image', 'OffscreenCanvas']) {
    Object.defineProperty(harness.context, name, { get: fail });
  }
  harness.dataUrlCache.set('sentinel', 'unchanged');
  for (const name of ['get', 'has', 'set', 'delete', 'clear']) harness.dataUrlCache[name] = fail;
  const result = plain(harness.getMosaicParameters(seed));
  assert.equal(calls, 1);
  assert.equal(draws, expectedDraws);
  assert.deepEqual(result, plain({
    axes: expected[0].axes, colors: expected[0].colors, polygonCount: expected[0].polygonCount,
    palette: expected[0].palette, rotation: expected[0].rotation, ...expected[1],
  }));
  assert.deepEqual(plain(Array.from(harness.dataUrlCache.entries())), [['sentinel', 'unchanged']]);
});

test('parameter lookup is deterministic for exact, unnormalized UTF-8 seeds', () => {
  const seeds = ['', 'deterministic', 'сессия/東京/🎨', 'e\u0301', 'é', '\0seed'];
  const first = seeds.map(seed => getMosaicParameters(seed));
  for (let i = seeds.length - 1; i >= 0; i--) assert.deepEqual(getMosaicParameters(seeds[i]), first[i]);
  assert.notDeepEqual(getMosaicParameters('é'), getMosaicParameters('e\u0301'));
});
