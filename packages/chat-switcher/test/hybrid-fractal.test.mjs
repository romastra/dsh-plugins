import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as mosaic from '../src/mosaic.js';
import * as fractal from '../src/fractal.js';
import * as variants from '../src/image-variant.js';

const source = readFileSync(new URL('../src/mosaic.js', import.meta.url), 'utf8');
const fixture = JSON.parse(readFileSync(new URL('./fixtures/mosaic-python.json', import.meta.url), 'utf8'));
const hybridSeed = (salt, id = 'hybrid-quality') => JSON.stringify([variants.HYBRID_SEED_DOMAIN, salt, id]);
const rawKeys = ['family', 'centerReal', 'centerImag', 'windowSpan', 'juliaReal', 'juliaImag',
  'fieldRotation', 'bandDensity', 'bandPhase', 'rimScale', 'paletteOffset'];
const mosaicKeys = ['axes', 'colors', 'polygonCount', 'palette', 'rotation', 'cellMix', 'paperRadius',
  'chamfer', 'gap', 'radialExponent', 'contourOffset', 'contourTurnActivity', 'contourExponent',
  'powerVariation', 'composition', 'seamPixels', 'convexity', 'centralInnerRatio', 'occupancyRadius'];
const plain = value => structuredClone(value);
const fail = () => { throw new Error('Unexpected expensive/derived work'); };

function mosaicHarness(overrides = {}) {
  const context = vm.createContext({ TextEncoder, ...fractal, ...variants, ...overrides });
  vm.runInContext(source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '') + `
    this.privateApi = {
      getMosaicParameters, getFractalParameters, getFractalQuality, buildMosaicScene,
      createMosaicSvg, createMosaicSvgAsync, getMosaicBaseDataUrl, getMosaicCanvasColor,
      parameters, makeScene, sceneSvg, HashRandom, hybridFractalPlan, dataUrlCache, mosaicBaseDataUrlCache,
      forbidGeometry: fail => { makeScene = buildMosaicScene = sceneSvg = hybridFractalPlan = hybridFractalSvg = fail; },
      forbidFullRenderer: fail => { createMosaicSvg = createMosaicSvgAsync = hybridFractalSvg = fail; },
    };
  `, context);
  return { context, ...context.privateApi };
}

const masks = svg => [...svg.matchAll(/<mask id="m\d+"[^>]*>.*?<\/mask>/g)].map(m => m[0]);
const points = text => text.split(' ').map(pair => pair.split(',').map(Number));
const area = poly => Math.abs(poly.reduce((sum, a, i) => {
  const b = poly[(i + 1) % poly.length]; return sum + a[0] * b[1] - b[0] * a[1];
}, 0)) / 2;

function selectedOrbits(scene) {
  const reps = [...new Map(scene.shapes.map(shape => [shape.orbit, shape])).values()];
  const visibleArea = shape => area(shape.points)
    * (shape.central && shape.centralRank < scene.centralCount - 1 ? 1 - scene.centralRatio ** 2 : 1);
  return reps.sort((a, b) => visibleArea(b) - visibleArea(a) || a.orbit - b.orbit).slice(0, 2).map(s => s.orbit);
}

test('hybrid descriptor contains only 11 detached raw variables; base accessor stays exactly 19', () => {
  assert.equal(mosaic.getFractalParameters('legacy'), null);
  assert.equal(mosaic.getFractalQuality('legacy'), null);
  for (const seed of ['legacy', hybridSeed('descriptor')]) {
    assert.deepEqual(Object.keys(mosaic.getMosaicParameters(seed)).sort(), [...mosaicKeys].sort());
  }
  const seed = hybridSeed('descriptor'), descriptor = mosaic.getFractalParameters(seed);
  assert.deepEqual(Object.keys(descriptor).sort(), [...rawKeys].sort());
  for (const key of rawKeys) assert.equal(typeof descriptor[key], key === 'family' ? 'string' : 'number', key);
  assert.ok(['julia', 'mandelbrot'].includes(descriptor.family));
  assert.ok(descriptor.windowSpan > 0 && descriptor.rimScale >= .88 && descriptor.rimScale <= .94);
  const changed = mosaic.getFractalParameters(seed); changed.centerReal = 1e9;
  assert.notStrictEqual(changed, descriptor);
  assert.deepEqual(mosaic.getFractalParameters(seed), descriptor);
  for (const input of [null, undefined, 1, {}, [], new String('seed')]) {
    for (const fn of [mosaic.getFractalParameters, mosaic.getFractalQuality, mosaic.getMosaicBaseDataUrl, mosaic.getMosaicCanvasColor]) {
      assert.throws(() => fn(input), /Session ID must be a string/);
    }
  }
});

test('descriptor uses only its new RNG domain and never builds a field, geometry, SVG or cache', () => {
  const h = mosaicHarness({ buildFractalField: fail, buildFractalFieldAsync: fail, measureFractalQuality: fail, fractalFieldSvg: fail });
  const before = plain(h.getMosaicParameters(hybridSeed('metadata'))), domains = [];
  const word = h.HashRandom.prototype.word;
  h.HashRandom.prototype.word = function () { domains.push(new TextDecoder().decode(this.seed)); return word.call(this); };
  h.forbidGeometry(fail); h.forbidFullRenderer(fail);
  for (const name of ['document', 'window', 'Image', 'OffscreenCanvas']) Object.defineProperty(h.context, name, { get: fail });
  const seed = hybridSeed('metadata'), descriptor = h.getFractalParameters(seed);
  assert.equal(Object.keys(descriptor).length, 11);
  assert.ok(domains.length > 0 && domains.length <= 20);
  assert.ok(domains.every(domain => domain === 'dsh-mosaic/v1/hybrid-fractal/v1/parameters\0' + seed));
  assert.equal(h.dataUrlCache.size, 0); assert.equal(h.mosaicBaseDataUrlCache.size, 0);
  assert.deepEqual(plain(h.getMosaicParameters(seed)), before);
});

test('quality probe is bounded and independent of geometry/full fields; low-contrast palettes reject early', () => {
  const h = mosaicHarness({ buildFractalField: fail, buildFractalFieldAsync: fail, fractalFieldSvg: fail });
  h.forbidGeometry(fail); h.forbidFullRenderer(fail);
  let accepted, rejected;
  for (let i = 0; i < 100 && (!accepted || !rejected); i++) {
    const seed = hybridSeed('quality-' + i), q = h.getFractalQuality(seed);
    if (q.accepted) accepted = q;
    if (q.paletteContrast < 3) rejected = q;
    assert.ok(q.steps <= 4 * 24 * 24 * 64);
    assert.ok(q.samples === 0 || q.samples === 4 * 24 * 24);
  }
  assert.ok(accepted && rejected);
  assert.ok(accepted.paletteContrast >= 3 && accepted.entropy >= .3 && accepted.transitionRatio >= .025);
  assert.equal(rejected.accepted, false); assert.equal(rejected.steps, 0); assert.equal(rejected.samples, 0);
  const flat = { ...mosaic.getFractalParameters(hybridSeed('flat')), family: 'mandelbrot', centerReal: 20, centerImag: 20, windowSpan: .0001 };
  assert.equal(fractal.measureFractalQuality(flat).accepted, false);
});

test('400 salt windows have stable nonflat acceptance and every raw descriptor field varies', () => {
  const families = { julia: { total: 0, accepted: 0 }, mandelbrot: { total: 0, accepted: 0 } };
  const values = Object.fromEntries(rawKeys.map(key => [key, new Set()]));
  let accepted = 0, contrastRejected = 0, fieldRejected = 0;
  for (let i = 0; i < 400; i++) {
    const seed = hybridSeed('quality-' + i), p = mosaic.getFractalParameters(seed), q = mosaic.getFractalQuality(seed);
    for (const key of rawKeys) values[key].add(p[key]);
    families[p.family].total++;
    if (q.accepted) { accepted++; families[p.family].accepted++; }
    else if (q.paletteContrast < 3) contrastRejected++;
    else fieldRejected++;
    assert.ok(q.steps <= 147456);
    assert.deepEqual(mosaic.getFractalParameters(seed), p);
  }
  assert.ok(accepted >= 280 && accepted <= 380, 'acceptance=' + accepted);
  assert.ok(contrastRejected > 10 && fieldRejected > 5);
  for (const family of Object.values(families)) {
    assert.ok(family.total > 150); assert.ok(family.accepted / family.total > .5);
  }
  for (const key of rawKeys) assert.ok(values[key].size > 1, key);
});

test('scene and cheap base/canvas APIs never compute a full fractal field', () => {
  const h = mosaicHarness({ buildFractalField: fail, buildFractalFieldAsync: fail, fractalFieldSvg: fail });
  h.forbidFullRenderer(fail);
  const seed = hybridSeed('cheap-base');
  const scene = h.buildMosaicScene(seed), original = h.makeScene(...h.parameters(seed));
  assert.deepEqual(plain(scene), plain(original));
  const uri = h.getMosaicBaseDataUrl(seed);
  assert.equal(decodeURIComponent(uri.slice(uri.indexOf(',') + 1)), h.sceneSvg(scene));
  assert.equal(h.getMosaicCanvasColor(seed), scene.palette[0]);
  assert.equal(h.getMosaicBaseDataUrl(seed), uri);
  assert.equal(h.dataUrlCache.size, 0);
  for (let i = 0; i < 160; i++) h.getMosaicBaseDataUrl(hybridSeed('base-cache-' + i));
  assert.equal(h.mosaicBaseDataUrlCache.size, 128);
  assert.equal(h.dataUrlCache.size, 0);
});

test('Float64 fields obey the fixed step/pixel budgets and sync/async data are identical', async () => {
  for (let i = 0; i < 24; i++) {
    const p = mosaic.getFractalParameters(hybridSeed('field-' + i));
    for (const symmetry of [0, 1, 3, 6]) {
      const field = fractal.buildFractalField(p, symmetry);
      assert.equal(field.size, 64); assert.equal(field.iterations, 96);
      assert.ok(field.values instanceof Float64Array); assert.equal(field.values.length, 4096);
      assert.ok(field.steps > 0 && field.steps <= 64 * 64 * 96);
      assert.ok(field.values.every(v => Number.isFinite(v) && v >= 0 && v <= 96));
      assert.ok(field.bands.every(v => v === 0 || v === 1));
    }
  }
  const p = mosaic.getFractalParameters(hybridSeed('field-async'));
  let yields = 0;
  const asyncField = await fractal.buildFractalFieldAsync(p, 3, { yieldControl: async () => { yields++; }, shouldAbort: () => false });
  assert.equal(yields, 15); assert.deepEqual(asyncField, fractal.buildFractalField(p, 3));
});

test('vector serialization caps row-run vertices even for an adversarial checkerboard', () => {
  const size = 64, bands = Uint8Array.from({ length: size * size }, (_, i) => (i % size + Math.floor(i / size)) & 1);
  const svg = fractal.fractalFieldSvg({ size, bands }, ['#000000', '#ffffff'], 'budget', 6);
  assert.ok((svg.match(/M\d+ /g) || []).length <= 3072);
  assert.ok(Buffer.byteLength(svg) < 60000);
  assert.equal((svg.match(/<path /g) || []).length, 2);
  assert.equal((svg.match(/transform="rotate\(/g) || []).length, 6);
  assert.equal((svg.match(/transform="scale\(1 -1\)"/g) || []).length, 6);
});

test('hybrid keeps every original ownership mask/body, clips inset texture only to the two largest orbits', () => {
  const h = mosaicHarness();
  for (let i = 0; i < 40; i++) {
    const seed = hybridSeed('structure-' + i), scene = mosaic.buildMosaicScene(seed), descriptor = mosaic.getFractalParameters(seed);
    const original = h.sceneSvg(scene), svg = mosaic.createMosaicSvg(seed);
    assert.deepEqual(masks(svg), masks(original));
    const originalDefs = original.slice(original.indexOf('<defs>') + 6, original.indexOf('</defs>'));
    const hybridDefs = svg.slice(svg.indexOf('<defs>') + 6, svg.indexOf('</defs>'));
    assert.ok(hybridDefs.startsWith(originalDefs));
    assert.ok(svg.slice(svg.indexOf('</defs>') + 7).startsWith(original.slice(original.indexOf('</defs>') + 7, -6)));
    const selected = selectedOrbits(scene);
    const indices = [...svg.matchAll(/<clipPath id="fractal-inner(\d+)"[^>]*><polygon points="([^"]+)"/g)].map(match => {
      const index = Number(match[1]), shape = scene.shapes[index], inner = points(match[2]);
      assert.ok(selected.includes(shape.orbit));
      inner.forEach((point, j) => point.forEach((value, axis) => {
        const expected = shape.center[axis] + descriptor.rimScale * (shape.points[j][axis] - shape.center[axis]);
        assert.ok(Math.abs(value - expected) < 1e-9);
      }));
      assert.ok(svg.includes('<g mask="url(#m' + index + ')"><g clip-path="url(#fractal-inner' + index + ')"><use href="#fractal'));
      return index;
    });
    assert.deepEqual(indices, scene.shapes.map((shape, index) => selected.includes(shape.orbit) ? index : -1).filter(i => i >= 0));
    assert.ok((svg.match(/id="fractal\d+-grid"/g) || []).length <= 2);
    for (const match of svg.matchAll(/fill="(#[0-9a-f]{6})"/g)) assert.ok(scene.palette.includes(match[1]));
    assert.ok(Buffer.byteLength(svg) < 200000);
  }
});

test('wedge replication and per-shape texture matrices preserve all local symmetries, orbit rotations and mirrors', () => {
  const seen = new Set();
  for (let i = 0; i < 100; i++) {
    const seed = hybridSeed('symmetry-' + i), scene = mosaic.buildMosaicScene(seed), svg = mosaic.createMosaicSvg(seed);
    const selected = selectedOrbits(scene), syms = [...new Set(selected.map(orbit => scene.shapes.find(s => s.orbit === orbit).localSymmetry))];
    // Plan sorts by largest representative, so derive its exact field order independently.
    const h = mosaicHarness(), plan = h.hybridFractalPlan(scene);
    assert.deepEqual([...plan.symmetries].sort(), syms.sort());
    for (const [fieldIndex, symmetry] of [...plan.symmetries].entries()) {
      seen.add(symmetry);
      if (symmetry) {
        assert.ok(svg.includes('id="fractal' + fieldIndex + '-wedge"'));
        for (let k = 0; k < symmetry; k++) {
          const angle = Number((360 * k / symmetry).toFixed(9)).toString();
          assert.ok(svg.includes('transform="rotate(' + angle + ')"'));
        }
      }
    }
    for (const match of svg.matchAll(/<g clip-path="url\(#fractal-inner(\d+)\)"><use href="#fractal(\d+)" transform="matrix\(([^)]+)\)"/g)) {
      const shape = scene.shapes[Number(match[1])], matrix = match[3].split(' ').map(Number);
      const radius = Math.max(...shape.points.map(p => Math.hypot(p[0] - shape.center[0], p[1] - shape.center[1])));
      const c = Math.cos(shape.textureAngle), s = Math.sin(shape.textureAngle), sign = shape.textureMirror ? -1 : 1;
      const expected = [radius * c, radius * s, -radius * s * sign, radius * c * sign, ...shape.center];
      matrix.forEach((v, j) => assert.ok(Math.abs(v - expected[j]) < 1e-9));
      assert.equal(plan.symmetries[Number(match[2])], shape.localSymmetry);
    }
  }
  assert.deepEqual([...seen].sort(), [0, 1, 2, 3, 4, 5, 6]);
});

test('full SVG is deterministic/self-contained and sync, worker-style, async and data URL serialization agree', async () => {
  for (let i = 0; i < 12; i++) {
    const seed = hybridSeed('serialization-' + i, i ? 'chat' : '</svg><script>alert(1)</script>'), svg = mosaic.createMosaicSvg(seed);
    let yields = 0;
    const asyncSvg = await mosaic.createMosaicSvgAsync(seed, { yieldControl: async () => { yields++; } });
    assert.equal(asyncSvg, svg); assert.ok(yields >= 15 && yields <= 32);
    assert.equal(mosaic.createMosaicSvg(seed), svg);
    assert.equal(decodeURIComponent(mosaic.getMosaicDataUrl(seed).split(',').slice(1).join(',')), svg);
    assert.doesNotMatch(svg, /<script|<image|<foreignObject|onload=|\bNaN\b|Infinity|undefined|data:|https?:\/\/(?!www.w3.org)/i);
    assert.ok(!svg.includes(seed));
    const ids = new Set([...svg.matchAll(/ id="([^"]+)"/g)].map(match => match[1]));
    for (const match of svg.matchAll(/(?:url\(#|href="#)([^)" ]+)/g)) assert.ok(ids.has(match[1]), match[1]);
    assert.ok(svg.startsWith('<svg ') && svg.endsWith('</svg>'));
  }
  assert.equal(await mosaic.createMosaicSvgAsync('legacy-async'), mosaic.createMosaicSvg('legacy-async'));
});

test('cooperative render stops on pre-abort, between row chunks and callback failures', async () => {
  const seed = hybridSeed('abort'); let yields = 0;
  await assert.rejects(mosaic.createMosaicSvgAsync(seed, { shouldAbort: () => true, yieldControl: fail }), { name: 'AbortError' });
  await assert.rejects(mosaic.createMosaicSvgAsync(seed, {
    shouldAbort: () => yields >= 2, yieldControl: async () => { yields++; },
  }), { name: 'AbortError' });
  assert.equal(yields, 2);
  await assert.rejects(mosaic.createMosaicSvgAsync(seed, { yieldControl: async () => { throw new Error('scheduler stopped'); } }), /scheduler stopped/);
  await assert.rejects(mosaic.createMosaicSvgAsync(seed, { yieldControl: null }), /Invalid mosaic render callbacks/);
});

test('276 pre-change legacy scenes and SVGs retain exact recorded aggregate digests', () => {
  const seeds = [...new Set([...fixture.records.map(x => x.sessionId), ...fixture.combinations.map(x => x.sessionId),
    ...Array.from({ length: 250 }, (_, i) => 'mosaic-sweep-' + i)])];
  assert.equal(seeds.length, 276);
  const svgHash = createHash('sha256'), sceneHash = createHash('sha256');
  for (const seed of seeds) {
    assert.equal(variants.imageVariantFromSeed(seed), variants.LEGACY_VARIANT);
    const svg = mosaic.createMosaicSvg(seed);
    svgHash.update(seed + '\0' + svg + '\0');
    sceneHash.update(seed + '\0' + JSON.stringify(mosaic.buildMosaicScene(seed)) + '\0');
    assert.equal(mosaic.getMosaicBaseDataUrl(seed), mosaic.getMosaicDataUrl(seed));
  }
  assert.equal(svgHash.digest('hex'), '6f2c7fbb1b14a6b1a0f415c299af1c7a36b8d84d4344d39e03bc3c81325d5aee');
  assert.equal(sceneHash.digest('hex'), 'fa7f03f1e3b6b5cabeb79c33b7444095ad4713e2ca0f3ec74b3d5788de4be975');
});
