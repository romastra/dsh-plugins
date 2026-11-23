import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as api from '../src/mosaic.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/mosaic-python.json', import.meta.url), 'utf8'));
const source = ['image-variant','fractal','mosaic'].map(name=>readFileSync(new URL('../src/'+name+'.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'')).join('\n');
// Private test harness avoids widening the production module's exact API.
const context = vm.createContext({TextEncoder});
vm.runInContext(source.replaceAll('export function ', 'function ') + '\nthis.privateApi={sha256,hex,HashRandom,parameters,makeScene,inside,absArea,sceneSvg,clipHalfplane,dataUrlCache,DATA_URL_CACHE_LIMIT,getMosaicDataUrl};', context);
const internals = context.privateApi;
const plain = value => JSON.parse(JSON.stringify(value));
function approximately(actual, expected, path = 'scene') {
  if (typeof expected === 'number') {
    assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= 2e-9, path + ': ' + actual + ' != ' + expected);
  } else if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), path); assert.equal(actual.length, expected.length, path + '.length');
    expected.forEach((value, i) => approximately(actual[i], value, path + '[' + i + ']'));
  } else if (expected && typeof expected === 'object') {
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), path + '.keys');
    for (const key of Object.keys(expected)) approximately(actual[key], expected[key], path + '.' + key);
  } else assert.equal(actual, expected, path);
}
function validateScene(scene) {
  assert.equal(scene.algorithm, 'M-unified-parametric');
  assert.equal(scene.version, 'dsh-unified-mosaic/v1');
  assert.ok(scene.axes >= 0 && scene.axes <= 6);
  assert.ok(scene.colors >= 2 && scene.colors <= 16);
  assert.ok(scene.polygonCount >= 3 && scene.polygonCount <= 9);
  assert.equal(scene.palette.length, scene.colors);
  assert.equal(scene.shapes.length, scene.polygonCount);
  assert.deepEqual([...scene.paintGroups.flat()].sort((a,b)=>a-b), Array.from({length:scene.shapes.length},(_,i)=>i));
  assert.equal(new Set(scene.palette).size, scene.colors);
  for (const shape of scene.shapes) {
    assert.ok(shape.points.length >= 3 && shape.points.length <= 12);
    assert.ok(internals.absArea(shape.points) > .000001);
    assert.ok(internals.inside(shape.points, shape.center));
    for (const point of shape.points) assert.ok(point.every(Number.isFinite) && Math.hypot(...point)<1);
    assert.equal(shape.layers.length, shape.fillColors.length);
    shape.layers.forEach(layer=>assert.ok(scene.palette.includes(layer.color)));
  }
}

test('public exports include exact legacy APIs, cheap metadata and bounded hybrid rendering', async () => {
  assert.deepEqual(Object.keys(api).sort(), ['buildMosaicScene','createMosaicSvg','createMosaicSvgAsync','getFractalParameters','getFractalQuality','getMosaicBaseDataUrl','getMosaicCanvasColor','getMosaicDataUrl','getMosaicParameters','hasMosaicFractal']);
  for (const fn of Object.values(api)) assert.equal(typeof fn, 'function');
  for (const input of [null,undefined,123,{},new String('abc')]) {
    for (const [name,fn] of Object.entries(api)) {
      if(name==='createMosaicSvgAsync')await assert.rejects(fn(input),/Session ID must be a string/);
      else assert.throws(()=>fn(input), /Session ID must be a string/);
    }
  }
});

test('SHA-256 standard vectors and UTF-8 match Node cryptography', () => {
  const known = new Map([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  ]);
  for (const text of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(1000), 'сессия/東京/🎨', 'e\u0301', 'é']) {
    const expected = createHash('sha256').update(text, 'utf8').digest('hex');
    if (known.has(text)) assert.equal(expected, known.get(text));
    assert.equal(internals.hex(internals.sha256(new TextEncoder().encode(text))), expected);
    assert.equal(api.buildMosaicScene(text).seedSha256, expected);
  }
});

test('counter SHA-256 words preserve full unsigned 64-bit precision against Python', () => {
  for (const stream of fixture.streams) {
    const rng = new internals.HashRandom(stream.sessionId, stream.domain);
    assert.deepEqual(Array.from({length:stream.words.length},()=>rng.word().toString()), stream.words);
  }
  const rng = new internals.HashRandom('', 'unused');
  let reads=0;
  rng.word=()=>{reads++;return reads===1 ? (1n<<64n)-1n : 18446744073709551612n;};
  assert.equal(rng.integer(2,4), 2); // reject 2^64-1, exact remainder beyond Number precision
  assert.equal(reads, 2);
});

test('all approved demo scenes plus UTF-8 and hostile IDs match full Python geometry', () => {
  const axes=new Set(), compositions=new Set(), colors=new Set();
  for (const expected of fixture.records) {
    const scene=api.buildMosaicScene(expected.sessionId);
    approximately(scene, expected, expected.sessionId);
    validateScene(scene); axes.add(scene.axes); compositions.add(scene.controls.composition); colors.add(scene.colors);
    assert.deepEqual(scene, api.buildMosaicScene(expected.sessionId));
  }
  assert.deepEqual([...axes].sort(), [0,1,2,3,4,5,6]);
  assert.deepEqual([...compositions].sort(), ['nearest','stacked']);
  assert.ok(colors.has(2) && colors.has(16));
});

test('all 49 axes/count structural combinations match approved Python profiles and layers', () => {
  for (const expected of fixture.combinations) {
    const [p,controls]=internals.parameters(expected.sessionId);
    p.axes=expected.axes;p.polygonCount=expected.polygonCount;
    const scene=plain(internals.makeScene(p,controls));
    approximately(scene, expected, 'axes='+p.axes+',figures='+p.polygonCount);
    validateScene(scene);
  }
});

test('SVG is deterministic, self-contained, safe and contains all composition masks/layers', () => {
  const unique=new Set();
  for (const expected of fixture.records) {
    const svg=api.createMosaicSvg(expected.sessionId), scene=api.buildMosaicScene(expected.sessionId);
    assert.equal(svg, api.createMosaicSvg(expected.sessionId));unique.add(svg);
    assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
    assert.ok(svg.endsWith('</svg>'));
    assert.doesNotMatch(svg, /<script|<image|<foreignObject|href=|onload=|https?:\/\/(?!www.w3.org)|\bNaN\b|Infinity|undefined/i);
    if (expected.sessionId) assert.ok(!svg.includes(expected.sessionId));
    assert.equal((svg.match(/<mask /g)||[]).length, scene.shapes.length);
    assert.equal((svg.match(/<g mask=/g)||[]).length, scene.shapes.length);
    assert.equal((svg.match(/<feMorphology /g)||[]).length, scene.seamPixels ? 1 : 0);
    const ids=new Set([...svg.matchAll(/ id="([^"]+)"/g)].map(m=>m[1]));
    for (const match of svg.matchAll(/url\(#([^)]*)\)/g)) assert.ok(ids.has(match[1]));
    const painting=svg.slice(svg.indexOf('</defs>')+7);
    assert.equal((painting.match(/<polygon /g)||[]).length, scene.shapes.reduce((n,s)=>n+s.layers.length,0));
    assert.doesNotMatch(painting,/opacity|#171[cC]23/);
  }
  assert.equal(unique.size, fixture.records.length);
  assert.notEqual(api.createMosaicSvg('é'),api.createMosaicSvg('e\u0301'));
});

// Interpret emitted ownership masks independently at random interior probes.
// This catches nearest/stacked and central-over-shell errors without a browser.
function parsePoints(text) {return text.trim().split(/\s+/).map(pair=>pair.split(',').map(Number));}
function maskContains(xml,p,clipPaths) {
  let visible=false;
  const polygons=/(?:<g clip-path="url\(#([^)]*)\)">)?<polygon points="([^"]+)" fill="([^"]+)"\/>/g;
  for (const m of xml.matchAll(polygons)) {
    if (m[1] && !internals.inside(clipPaths.get(m[1]),p)) continue;
    if (internals.inside(parsePoints(m[2]),p)) visible=m[3]==='white';
  }
  return visible;
}
test('emitted SVG ownership matches explicit Python paintGroups at 12000 point probes', () => {
  let probes=0;
  for (const scene of fixture.records.slice(0,20)) {
    const svg=internals.sceneSvg(scene), clips=new Map();
    for (const m of svg.matchAll(/<clipPath id="([^"]+)"[^>]*><polygon points="([^"]+)"[^>]*\/><\/clipPath>/g)) clips.set(m[1],parsePoints(m[2]));
    const masks=[...svg.matchAll(/<mask id="m(\d+)"[^>]*>(.*?)<\/mask>/g)].map(m=>[Number(m[1]),m[2]]);
    const rng=new internals.HashRandom(scene.sessionId,'test/svg-ownership');
    for (let n=0;n<600;n++) {
      const p=[rng.uniform(-1,1),rng.uniform(-1,1)]; let owner=-1;
      for (const indices of scene.paintGroups) {
        let local=-1,best=Infinity;
        for (const i of indices) {
          const s=scene.shapes[i],d=(p[0]-s.center[0])**2+(p[1]-s.center[1])**2;
          if (internals.inside(s.points,p)&&d<best) {best=d;local=i;}
        }
        if (local>=0) owner=local;
      }
      const svgOwners=masks.filter(([,xml])=>maskContains(xml,p,clips)).map(([i])=>i);
      assert.deepEqual(svgOwners,owner<0?[]:[owner],scene.sessionId+' at '+p);probes++;
    }
  }
  assert.equal(probes,12000);
});

test('data URI is reversible, deterministic and LRU cache never exceeds 128', () => {
  internals.dataUrlCache.clear();
  const first='cache-id-0';
  const uri=internals.getMosaicDataUrl(first);
  assert.equal(decodeURIComponent(uri.split(',')[1]), api.createMosaicSvg(first));
  assert.ok(uri.startsWith('data:image/svg+xml;charset=utf-8,'));
  assert.equal(uri,api.getMosaicDataUrl(first));
  for (let i=1;i<128;i++) internals.getMosaicDataUrl('cache-id-'+i);
  assert.equal(internals.dataUrlCache.size,128);
  internals.getMosaicDataUrl(first); // refresh the oldest before adding another
  internals.getMosaicDataUrl('cache-id-128');
  assert.equal(internals.dataUrlCache.size,128);
  assert.ok(internals.dataUrlCache.has(first));assert.ok(!internals.dataUrlCache.has('cache-id-1'));
  for (let i=129;i<160;i++) internals.getMosaicDataUrl('cache-id-'+i);
  assert.equal(internals.dataUrlCache.size,internals.DATA_URL_CACHE_LIMIT);
  assert.equal(internals.getMosaicDataUrl(first),uri);
});

test('250 independently hashed IDs obey bounds and are mutation-independent', () => {
  for (let i=0;i<250;i++) validateScene(api.buildMosaicScene('mosaic-sweep-'+i));
  const scene=api.buildMosaicScene('mutation');const original=api.createMosaicSvg('mutation');
  scene.palette.fill('red');scene.shapes[0].points[0][0]=900;scene.controls.cellMix=900;
  assert.equal(api.createMosaicSvg('mutation'),original);
});
