import { HYBRID_VARIANT, PARAMETRIC_VARIANT, imageVariantFromSeed } from './image-variant.js';
import { createFractalDescriptor, measureFractalQuality, buildFractalField, buildFractalFieldAsync, fractalFieldSvg, checkFractalAbort } from './fractal.js';

// Browser port of mosaic-lab/unified.py (M-unified-parametric, v1).
// Domain separation, draw order, and RNG consumption intentionally match Python.
// No DOM, network, runtime entropy, session reads, or Python dependency.
const TAU = 2 * Math.PI;
const VERSION = 'dsh-unified-mosaic/v1';
const C64 = ['#000000', '#ffffff', '#9f4e44', '#6abfc6', '#a057a3', '#5cab5e', '#50459b', '#c9d487', '#a1683c', '#6d5412', '#cb7e75', '#626262', '#898989', '#9ae29b', '#887ecb', '#adadad'];
const encoder = new TextEncoder();
const SHA_K = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
]);
const rotr = (x, n) => (x >>> n) | (x << (32 - n));
function sha256(bytes) {
  const data = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  data.set(bytes); data[bytes.length] = 128;
  const view = new DataView(data.buffer);
  view.setBigUint64(data.length - 8, BigInt(bytes.length) * 8n);
  const h = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const w = new Uint32Array(64);
  for (let start = 0; start < data.length; start += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(start + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], b = w[i - 2];
      w[i] = w[i - 16] + (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) + w[i - 7] + (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10));
    }
    let [a,b,c,d,e,f,g,j] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (j + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA_K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      j = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    [a,b,c,d,e,f,g,j].forEach((value, i) => { h[i] += value; });
  }
  const result = new Uint8Array(32), out = new DataView(result.buffer);
  h.forEach((value, i) => out.setUint32(i * 4, value));
  return result;
}
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
class HashRandom {
  constructor(sessionId, domain) {
    this.seed = encoder.encode('dsh-mosaic/v1/' + domain + '\0' + sessionId);
    this.counter = 0n;
    this.input = new Uint8Array(this.seed.length + 8);
    this.input.set(this.seed);
    this.view = new DataView(this.input.buffer);
  }
  word() {
    this.view.setBigUint64(this.seed.length, this.counter++);
    const digest = sha256(this.input);
    return new DataView(digest.buffer).getBigUint64(0);
  }
  integer(low, high) {
    const span = BigInt(high - low + 1), limit = (1n << 64n) - (1n << 64n) % span;
    let value;
    do { value = this.word(); } while (value >= limit);
    return low + Number(value % span);
  }
  unit() { return Number(this.word() >> 11n) / 9007199254740992; }
  uniform(low, high) { return low + (high - low) * this.unit(); }
  choice(values) { return values[this.integer(0, values.length - 1)]; }
  shuffle(values) {
    const result = [...values];
    for (let i = result.length - 1; i > 0; i--) {
      const j = this.integer(0, i); [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }
}
function parameters(sessionId) {
  const rng = new HashRandom(sessionId, 'parameters');
  const oldAxes = rng.integer(0, 3), colors = rng.integer(2, 16);
  const polygonCount = oldAxes === 3 ? rng.choice([3,4,6,7,9]) : rng.integer(3,9);
  const palette = rng.shuffle(C64).slice(0, colors);
  const p = { sessionId, axes: new HashRandom(sessionId, 'unified/v1/axes').integer(0,6), colors, polygonCount, palette,
    rotation: rng.uniform(0, TAU), seedSha256: hex(sha256(encoder.encode(sessionId))) };
  const r = new HashRandom(sessionId, 'unified/v1/controls'), u = r.unit();
  const controls = { cellMix: (1 - Math.cos(Math.PI * u)) / 2, paperRadius: r.uniform(.26,.48),
    chamfer: r.uniform(0,.24), gap: r.uniform(.018,.095), radialExponent: r.uniform(.62,1.58),
    contourOffset: r.uniform(0,.28), contourTurnActivity: r.unit(), contourExponent: r.uniform(.82,1.03),
    powerVariation: r.uniform(0,.32), composition: r.choice(['nearest','stacked']), seamPixels: r.integer(0,1),
    convexity: r.unit(), centralInnerRatio: r.uniform(.38,.53), occupancyRadius: r.uniform(.91,.975) };
  return [p, controls];
}
const rotate = ([x,y], angle) => [Math.cos(angle)*x - Math.sin(angle)*y, Math.sin(angle)*x + Math.cos(angle)*y];
const transform = ([x,y], angle = 0, mirror = false) => rotate([x, mirror ? -y : y], angle);
const distance = (a,b) => Math.hypot(a[0]-b[0], a[1]-b[1]);
const norm = p => Math.hypot(...p);
const comparePoint = (a,b) => a[0]-b[0] || a[1]-b[1];
const range = n => Array.from({length:n}, (_,i) => i);
// Python round uses ties-to-even. Preserve that for bevel keys and hull snapping.
function rounded(value, digits) {
  const scale = 10 ** digits, n = value * scale, base = Math.floor(n), fraction = n - base;
  return (fraction === .5 ? base + (base % 2 === 0 ? 0 : 1) : Math.round(n)) / scale;
}
function hull(points) {
  const sorted = points.map(p => p.map(v => rounded(v,12))).sort(comparePoint);
  const pts = sorted.filter((p,i) => !i || comparePoint(p,sorted[i-1]));
  const cross = (o,a,b) => (a[0]-o[0])*(b[1]-o[1]) - (a[1]-o[1])*(b[0]-o[0]);
  const half = values => {
    const result = [];
    for (const p of values) {
      while (result.length >= 2 && cross(result.at(-2),result.at(-1),p) <= 1e-12) result.pop();
      result.push(p);
    }
    return result.slice(0,-1);
  };
  return [...half(pts), ...half([...pts].reverse())];
}
function clipHalfplane(poly, normal, offset) {
  if (!poly.length) return [];
  const signed = p => {
    const value = p[0]*normal[0] + p[1]*normal[1] - offset;
    return Math.abs(value) < 1e-11 ? 0 : value;
  };
  let previous = poly.at(-1), pv = signed(previous);
  const output = [];
  for (const point of poly) {
    const value = signed(point);
    if ((pv <= 0) !== (value <= 0)) {
      const t = Math.max(0,Math.min(1,pv/(pv-value)));
      output.push([previous[0]+t*(point[0]-previous[0]), previous[1]+t*(point[1]-previous[1])]);
    }
    if (value <= 0) output.push(point);
    previous = point; pv = value;
  }
  return output;
}
function cell(site, index, sites, weights, boundary) {
  let poly = boundary;
  sites.forEach((other,j) => {
    if (j === index) return;
    const normal = [other[0]-site[0],other[1]-site[1]];
    const offset = (other[0]**2+other[1]**2-site[0]**2-site[1]**2+weights[index]-weights[j])/2;
    poly = clipHalfplane(poly,normal,offset);
  });
  return hull(poly);
}
function inside(poly, [x,y]) {
  let result = false;
  poly.forEach((a,i) => {
    const b = poly[(i+1)%poly.length];
    if ((a[1]>y) !== (b[1]>y) && x < (b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0]) result = !result;
  });
  return result;
}
function centroid(poly) {
  let area = 0, x = 0, y = 0;
  poly.forEach((a,i) => { const b = poly[(i+1)%poly.length], cross = a[0]*b[1]-b[0]*a[1];
    area += cross; x += (a[0]+b[0])*cross; y += (a[1]+b[1])*cross; });
  return [x/(3*area), y/(3*area)];
}
function absArea(poly) {
  return Math.abs(poly.reduce((sum,a,i) => { const b = poly[(i+1)%poly.length]; return sum+a[0]*b[1]-b[0]*a[1]; },0))/2;
}
function orbitPlan(p, rng) {
  const m = p.axes, n = p.polygonCount;
  let sizes;
  if (m <= 2) {
    sizes = m === 0 ? Array(n).fill(1) : m === 1 ? [...Array(Math.floor(n/2)).fill(2), ...Array(n%2).fill(1)]
      : [...Array(Math.floor(n/4)).fill(4), ...(n%4 >= 2 ? [2] : []), ...Array(n%2).fill(1)];
    const noncentralCount = sizes.filter(size => size>1).length;
    let rank = 0;
    return sizes.map((size,i) => {
      let center, symmetry, operations;
      if (!m) {
        const angle = TAU*(i+rng.uniform(.05,.95))/n, radius = rng.uniform(.18,.68);
        center = [radius*Math.cos(angle),radius*Math.sin(angle)]; symmetry = 0; operations = [[0,false]];
      } else if (size === 1) {
        // Consume the legacy random center before unified.py resets it to zero.
        if (m === 1) rng.uniform(-.13,.13);
        center = [0,0]; symmetry = m; operations = [[0,false]];
      } else {
        let radius = .35+.40*((rank+.5)/Math.max(noncentralCount,1));
        radius += rng.uniform(-.035,.035); rank++;
        if (m === 1) { center = [rng.uniform(-.55,.55),radius*.76]; symmetry = 0; operations = [[0,false],[0,true]]; }
        else if (size === 2) { center = [radius,0]; symmetry = 1; operations = [[0,false],[Math.PI,false]]; }
        else { const angle = rng.uniform(.26,Math.PI/2-.26);
          center = [radius*Math.cos(angle),radius*Math.sin(angle)]; symmetry = 0;
          operations = [[0,false],[0,true],[Math.PI,false],[Math.PI,true]]; }
      }
      return { center, symmetry, operations, size, central: m>0 && size===1 };
    });
  }
  let quotient = Math.floor(n/m), remainder = n%m;
  sizes = [];
  if (quotient >= 2 && 2*m <= 9 && rng.integer(0,1)) { sizes.push(2*m); quotient -= 2; }
  sizes.push(...Array(quotient).fill(m));
  const centralCount = sizes.length ? remainder : n;
  const entries = sizes.map((size,i) => {
    const radius = .29+.42*(i+.5)/sizes.length;
    if (size === m) return { center:[radius,0], symmetry:1, size, operations:range(m).map(k=>[TAU*k/m,false]), central:false };
    const angle = rng.uniform(.17,Math.PI/m-.17);
    return { center:[radius*Math.cos(angle),radius*Math.sin(angle)], symmetry:0, size,
      operations:range(m).flatMap(k=>[[TAU*k/m,false],[TAU*k/m,true]]), central:false };
  });
  for (let i=0;i<centralCount;i++) entries.push({center:[0,0],symmetry:m,size:1,operations:[[0,false]],central:true});
  return entries;
}
function unitPolygon(rng, symmetry) {
  if (symmetry > 3) {
    const n = rng.choice(range(10).map(i=>i+3).filter(v=>v%symmetry===0)), period = n/symmetry, radii = new Map();
    return range(n).map(k => {
      const key = Math.min(k%period, ((-k%period)+period)%period);
      if (!radii.has(key)) radii.set(key,rng.uniform(.78,1));
      const angle = TAU*k/n; return [radii.get(key)*Math.cos(angle),radii.get(key)*Math.sin(angle)];
    });
  }
  const count = symmetry===2 ? rng.choice([4,8,12]) : symmetry===3 ? rng.choice([3,6,9,12]) : rng.integer(3,12);
  let values = [];
  if (!symmetry) values = range(count).map(i=>[(i+rng.uniform(.30,.70))*TAU/count,rng.uniform(.62,1)]);
  else if (symmetry===1) {
    if (count%2) values.push([0,rng.uniform(.72,1)]);
    for (let i=0;i<Math.floor(count/2);i++) {
      const angle = count===3 ? rng.uniform(1.9,2.7) : (i+rng.uniform(.20,.80))*Math.PI/Math.floor(count/2);
      const radius = rng.uniform(.62,1); values.push([angle,radius],[-angle,radius]);
    }
  } else {
    const period = count/symmetry, radii = new Map();
    values = range(count).map(k=>{
      const key = Math.min(k%period,((-k%period)+period)%period);
      if (!radii.has(key)) radii.set(key,rng.uniform(.62,1));
      return [TAU*k/count,radii.get(key)];
    });
  }
  const points = values.sort(comparePoint).map(([angle,radius])=>[radius*Math.cos(angle),radius*Math.sin(angle)]);
  const sx = symmetry===3 ? 1 : rng.uniform(.85,1.2), sy = symmetry===3 ? 1 : rng.uniform(.70,1.1);
  return points.map(([x,y])=>[x*sx,y*sy]);
}
function rayDistance(poly, origin, direction) {
  let answer = Infinity;
  poly.forEach((a,i) => {
    const b = poly[(i+1)%poly.length], ex = b[0]-a[0], ey = b[1]-a[1], [dx,dy] = direction;
    const determinant = dx*ey-dy*ex;
    if (Math.abs(determinant)<1e-12) return;
    const ax = a[0]-origin[0], ay = a[1]-origin[1], t = (ax*ey-ay*ex)/determinant, u = (ax*dy-ay*dx)/determinant;
    if (t>=-1e-10 && u>=-1e-9 && u<=1+1e-9) answer = Math.min(answer,Math.max(0,t));
  });
  if (!Number.isFinite(answer) || answer<=1e-8) throw new Error('Invalid M mosaic ray');
  return answer;
}
function bevel(points, center, symmetry, strength, rng) {
  const budget = 12-points.length;
  if (budget<=0 || strength<.025) return [points,0];
  const groups = new Map();
  points.forEach((p,i)=>{
    const rel = [p[0]-center[0],p[1]-center[1]];
    const candidates = symmetry ? range(symmetry).flatMap(k=>[false,true].map(mirror=>transform(rel,TAU*k/symmetry,mirror).map(v=>rounded(v,7)))) : [rel.map(v=>rounded(v,7))];
    const key = JSON.stringify(candidates.sort(comparePoint)[0]);
    if (!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(i);
  });
  const chosen = new Map();
  for (const key of rng.shuffle([...groups.keys()])) {
    const group = groups.get(key);
    if (chosen.size+group.length<=budget && rng.unit()<.35+.65*strength/.24) {
      const t = strength*rng.uniform(.82,1);
      group.forEach(i=>chosen.set(i,t));
    }
  }
  return [points.flatMap((p,i)=>{
    if (!chosen.has(i)) return [p];
    const t = chosen.get(i);
    return [points[(i+points.length-1)%points.length],points[(i+1)%points.length]].map(q=>[(1-t)*p[0]+t*q[0],(1-t)*p[1]+t*q[1]]);
  }),chosen.size];
}
function shapeFromRep(poly, center, entry, orbit, rotation, centralRank = null) {
  return entry.operations.map(([angle,mirror])=>({
    points:poly.map(q=>rotate(transform(q,angle,mirror),rotation)), center:rotate(transform(center,angle,mirror),rotation),
    orbit, localSymmetry:entry.symmetry, textureAngle:rotation+angle, textureMirror:mirror, central:entry.central, centralRank,
  }));
}
function fillLayers(scene, rng, centralRatio) {
  const controls = scene.controls, groups = [...new Set(scene.shapes.map(s=>s.orbit))].sort((a,b)=>a-b);
  const representatives = new Map(groups.map(o=>[o,scene.shapes.find(s=>s.orbit===o)]));
  const central = groups.filter(o=>representatives.get(o).central), weights = new Map();
  for (const [o,s] of representatives) {
    const radius = Math.max(...s.points.map(point=>distance(s.center,point)));
    weights.set(o,s.central && o!==central.at(-1) ? radius*(1-centralRatio) : radius);
  }
  const foregrounds = scene.palette.slice(1), colors = new Map(groups.map(o=>[o,[]])), order = rng.shuffle(groups);
  order.forEach((o,index)=>colors.set(o,[foregrounds[index%foregrounds.length]]));
  for (const color of foregrounds.slice(groups.length)) {
    let best = order[0];
    for (const o of order) if (weights.get(o)/(colors.get(o).length+1)>weights.get(best)/(colors.get(best).length+1)) best=o;
    colors.get(best).push(color);
  }
  const recipes = {};
  for (const [o,s] of representatives) {
    const symmetry = s.localSymmetry, center = s.center, poly = s.points;
    const rin = Math.min(...poly.map((a,i)=>{ const b=poly[(i+1)%poly.length];
      return Math.abs((a[0]-center[0])*(b[1]-center[1])-(a[1]-center[1])*(b[0]-center[0]))/distance(a,b); }));
    const shift = controls.contourOffset*rin;
    let offset;
    if (symmetry>=2) offset=[0,0];
    else if (symmetry===1) offset=[shift*rng.choice([-1,1]),0];
    else { const a = rng.uniform(0,TAU); offset=[shift*Math.cos(a),shift*Math.sin(a)]; }
    let turn = 0;
    if (rng.unit()<controls.contourTurnActivity) turn = symmetry ? Math.PI/symmetry : rng.uniform(-.60,.60);
    const annular = s.central && o!==central.at(-1);
    if (annular) { offset=[0,0]; turn=0; }
    recipes[o]={offset,turn,annular,colors:colors.get(o)};
  }
  for (const s of scene.shapes) {
    const recipe = recipes[s.orbit]; s.fillColors=recipe.colors;
    const relative = s.points.map(point=>{
      const q=rotate([point[0]-s.center[0],point[1]-s.center[1]],-s.textureAngle);
      return [q[0],s.textureMirror ? -q[1] : q[1]];
    });
    const count = s.fillColors.length;
    s.layers = s.fillColors.map((color,j)=>{
      if (!j) return {points:s.points,color};
      const scale = recipe.annular ? 1-(j/count)*(1-centralRatio) : (1-j/count)**controls.contourExponent;
      const points = relative.map(point=>{
        let q=rotate(point,recipe.turn); q=[recipe.offset[0]+scale*q[0],recipe.offset[1]+scale*q[1]];
        q=rotate(transform(q,0,s.textureMirror),s.textureAngle);
        return [s.center[0]+q[0],s.center[1]+q[1]];
      });
      return {points,color};
    });
  }
  scene.fillRecipes=recipes;
}
function makeScene(p, controls) {
  const sid = p.sessionId, rng = new HashRandom(sid,'unified/v1/geometry'), entries = orbitPlan(p,rng);
  const shell = entries.filter(e=>!e.central), central = entries.filter(e=>e.central);
  const m=p.axes, frameN=m ? m*Math.floor(12/m) : 11, frameRadii=new Map();
  let boundary=range(frameN).map(k=>{
    const period=m ? frameN/m : frameN, key=m ? Math.min(k%period,((-k%period)+period)%period) : k;
    if (!frameRadii.has(key)) frameRadii.set(key,rng.uniform(.90,1));
    const angle=TAU*k/frameN+(m ? 0 : rng.uniform(-.08,.08));
    return [frameRadii.get(key)*Math.cos(angle),frameRadii.get(key)*Math.sin(angle)];
  });
  boundary=hull(boundary);
  const extent=Math.max(...boundary.map(norm)); boundary=boundary.map(([x,y])=>[x*.975/extent,y*.975/extent]);
  const inradius=Math.min(...boundary.map((a,i)=>{ const b=boundary[(i+1)%boundary.length]; return Math.abs(a[0]*b[1]-a[1]*b[0])/distance(a,b); }));
  if (shell.length) {
    const maxr=Math.max(...shell.map(e=>norm(e.center))), factor=Math.min(1,.82*inradius/maxr);
    shell.forEach(e=>{e.center=e.center.map(v=>v*factor);});
  }
  const sites=[],siteOrbits=[];
  shell.forEach((e,i)=>e.operations.forEach(([angle,mirror])=>{sites.push(transform(e.center,angle,mirror));siteOrbits.push(i);}));
  if (central.length) {sites.push([0,0]);siteOrbits.push(shell.length);}
  const pairs=sites.flatMap((a,i)=>sites.slice(i+1).map(b=>distance(a,b))), minimum=pairs.length ? Math.min(...pairs) : 1;
  const orbitWeights=new Map([...new Set(siteOrbits)].map(o=>[o,rng.uniform(-1,1)*controls.powerVariation*minimum**2]));
  const weights=siteOrbits.map(o=>orbitWeights.get(o)),gamma=controls.radialExponent;
  const warp=point=>{
    const r=norm(point); if (r<1e-12) return [0,0];
    const f=.975*(r/.975)**gamma/r; return point.map(v=>v*f);
  };
  const representative=(e,index,isCentral=false)=>{
    let center=e.center, domain=cell(center,index,sites,weights,boundary), unit=unitPolygon(rng,e.symmetry);
    const maxUnit=Math.max(...unit.map(norm));
    let radius=isCentral ? (shell.length ? .40 : .87) : controls.paperRadius;
    if (!isCentral) {
      const others=sites.map(q=>distance(center,q)).filter(d=>d>1e-9),nearest=others.length ? Math.min(...others) : 1;
      radius=Math.min(radius,.88*nearest/maxUnit);
    }
    let points=unit.map(([x,y])=>{
      const r=Math.hypot(x,y),direction=[x/r,y/r],cellR=rayDistance(domain,center,direction);
      let value=(1-controls.cellMix)*(r*radius)+controls.cellMix*cellR;
      if (isCentral && shell.length) value=Math.min(value,.94*cellR);
      value*=1-controls.gap;
      return [center[0]+value*direction[0],center[1]+value*direction[1]];
    });
    const beveled=bevel(points,center,e.symmetry,controls.chamfer,rng); points=beveled[0].map(warp); center=warp(center);
    if (controls.convexity>.48 || !inside(points,center)) points=hull(points);
    if (!inside(points,center)) center=centroid(points);
    return [points,center,beveled[1]];
  };
  const shapes=[],actualBeveledVerticesByOrbit={}; let offset=0;
  shell.forEach((e,i)=>{
    const [points,center,beveled]=representative(e,offset); actualBeveledVerticesByOrbit[i]=beveled;
    shapes.push(...shapeFromRep(points,center,e,i,p.rotation)); offset+=e.size;
  });
  let ratio=1;
  if (central.length) {
    const [points,,beveled]=representative(central[0],sites.length-1,true);
    ratio=controls.centralInnerRatio**(1/Math.max(1,central.length-1));
    central.forEach((e,rank)=>{
      const scale=ratio**rank,poly=points.map(([x,y])=>[x*scale,y*scale]),orbit=shell.length+rank;
      actualBeveledVerticesByOrbit[orbit]=beveled;
      shapes.push(...shapeFromRep(poly,[0,0],e,orbit,p.rotation,rank));
    });
  }
  const shapeExtent=Math.max(...shapes.flatMap(s=>s.points.map(norm))),fit=controls.occupancyRadius/shapeExtent;
  shapes.forEach(s=>{s.points=s.points.map(([x,y])=>[x*fit,y*fit]);s.center=s.center.map(v=>v*fit);});
  let shellGroups=range(shell.length).map(o=>range(shapes.length).filter(i=>shapes[i].orbit===o));
  if (controls.composition==='nearest' && shellGroups.length) shellGroups=[shellGroups.flat()];
  else if (shellGroups.length) shellGroups.sort((a,b)=>b.reduce((sum,i)=>sum+absArea(shapes[i].points),0)/b.length-a.reduce((sum,i)=>sum+absArea(shapes[i].points),0)/a.length);
  const centralGroups=range(central.length).map(rank=>range(shapes.length).filter(i=>shapes[i].central && shapes[i].centralRank===rank));
  let seam=controls.seamPixels;
  if (central.length || p.colors-1<entries.length) seam=1;
  const scene={...p,algorithm:'M-unified-parametric',version:VERSION,controls,shapes,paintGroups:[...shellGroups,...centralGroups],
    seamPixels:seam,actualBeveledVerticesByOrbit,centralCount:central.length,centralRatio:ratio,fitScale:fit};
  fillLayers(scene,new HashRandom(sid,'unified/v1/fills'),ratio);
  return scene;
}

/** Detached variable inputs only; seamPixels is the raw control, not its rendered override. */
export function getMosaicParameters(seed) {
  if (typeof seed !== 'string') throw new TypeError('Session ID must be a string');
  const [p, controls] = parameters(seed);
  return { axes: p.axes, colors: p.colors, polygonCount: p.polygonCount, palette: [...p.palette],
    rotation: p.rotation, ...controls };
}

function parametricFractalPresence(seed) {
  return new HashRandom(seed, 'hybrid-fractal/v2/presence').integer(0, 1) === 1;
}

/** Presence metadata only; V1 is always on, V2 has an independent random bit. */
export function hasMosaicFractal(seed) {
  if (typeof seed !== 'string') throw new TypeError('Session ID must be a string');
  const variant = imageVariantFromSeed(seed);
  return variant === HYBRID_VARIANT || (variant === PARAMETRIC_VARIANT && parametricFractalPresence(seed));
}

/** Raw metadata only; V1 draws stay exact and V2 retains all controls even off. */
export function getFractalParameters(seed) {
  if (typeof seed !== 'string') throw new TypeError('Session ID must be a string');
  const variant = imageVariantFromSeed(seed);
  if (variant === HYBRID_VARIANT) return createFractalDescriptor(new HashRandom(seed, 'hybrid-fractal/v1/parameters'));
  if (variant === PARAMETRIC_VARIANT) return {
    enabled: parametricFractalPresence(seed),
    ...createFractalDescriptor(new HashRandom(seed, 'hybrid-fractal/v2/parameters')),
  };
  return null;
}

function fractalColorPair(palette, offset = 0) {
  const luminance = color => {
    const rgb = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255)
      .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
    return .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
  };
  const sorted = palette.map(color => ({ color, y: luminance(color) })).sort((a, b) => a.y - b.y);
  const first = sorted[0], last = sorted.at(-1);
  const colors = [first.color, last.color];
  return { colors: offset % 2 ? colors.reverse() : colors, contrast: (last.y + .05) / (first.y + .05) };
}

/** Host acceptance probe only: no scene, SVG, full-resolution field, DOM or cache. */
export function getFractalQuality(seed) {
  const descriptor = getFractalParameters(seed);
  if (!descriptor || descriptor.enabled === false) return null;
  const paletteContrast = fractalColorPair(parameters(seed)[0].palette).contrast;
  if (paletteContrast < 3) return { accepted: false, paletteContrast, samples: 0, steps: 0 };
  return { ...measureFractalQuality(descriptor), paletteContrast };
}

/** Pure synchronous scene builder; IDs are exact UTF-8 strings, never normalized. */
export function buildMosaicScene(sessionId) {
  if (typeof sessionId !== 'string') throw new TypeError('Session ID must be a string');
  return makeScene(...parameters(sessionId));
}

const number = value => Number(value.toFixed(9)).toString();
const pointsAttribute = points => points.map(p=>p.map(number).join(',')).join(' ');
const polygon = (points, color) => '<polygon points="'+pointsAttribute(points)+'" fill="'+color+'"/>';
const SQUARE=[[-1,-1],[1,-1],[1,1],[-1,1]];
function sceneSvg(scene) {
  const definitions=[],masks=[],paint=[],groupByShape=new Map();
  scene.paintGroups.forEach((indices,group)=>indices.forEach(i=>groupByShape.set(i,group)));
  // One reference pixel is 2/272 normalized units. Erode the final ownership,
  // not every contour, matching MinFilter(3)'s one-pixel square seam at 272px.
  if (scene.seamPixels) definitions.push('<filter id="seam" filterUnits="userSpaceOnUse" x="-1" y="-1" width="2" height="2" color-interpolation-filters="sRGB"><feMorphology in="SourceGraphic" operator="erode" radius="'+number(2/272)+'"/></filter>');
  scene.shapes.forEach((shape,i)=>{
    const ownGroup=groupByShape.get(i),cuts=[];
    scene.shapes.forEach((competitor,j)=>{
      const otherGroup=groupByShape.get(j);
      if (j===i || otherGroup<ownGroup) return;
      if (otherGroup>ownGroup) { cuts.push(polygon(competitor.points,'black')); return; }
      // In a paint group the nearest containing site wins; earlier wins ties.
      const normal=[shape.center[0]-competitor.center[0],shape.center[1]-competitor.center[1]];
      const offset=(shape.center[0]**2+shape.center[1]**2-competitor.center[0]**2-competitor.center[1]**2)/2;
      if (normal[0]===0 && normal[1]===0) { if (j<i) cuts.push(polygon(competitor.points,'black')); return; }
      const halfplane=clipHalfplane(SQUARE,normal,offset);
      if (!halfplane.length) return;
      const id='h'+i+'_'+j;
      definitions.push('<clipPath id="'+id+'" clipPathUnits="userSpaceOnUse">'+polygon(halfplane,'white')+'</clipPath>');
      cuts.push('<g clip-path="url(#'+id+')">'+polygon(competitor.points,'black')+'</g>');
    });
    const content=polygon(shape.points,'white')+cuts.join('');
    masks.push('<mask id="m'+i+'" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x="-1" y="-1" width="2" height="2" style="mask-type:luminance">'+(scene.seamPixels ? '<g filter="url(#seam)">'+content+'</g>' : content)+'</mask>');
    paint.push('<g mask="url(#m'+i+')">'+shape.layers.map(layer=>polygon(layer.points,layer.color)).join('')+'</g>');
  });
  // Nothing from the ID is interpolated into XML, including identifiers/labels.
  return '<svg xmlns="http://www.w3.org/2000/svg" width="272" height="272" viewBox="-1 -1 2 2"><defs>'+definitions.join('')+masks.join('')+'</defs><rect x="-1" y="-1" width="2" height="2" fill="'+scene.palette[0]+'"/>'+paint.join('')+'</svg>';
}

function hybridFractalPlan(scene) {
  const representatives = new Map();
  scene.shapes.forEach(shape => { if (!representatives.has(shape.orbit)) representatives.set(shape.orbit, shape); });
  const weightedArea = shape => absArea(shape.points)
    * (shape.central && shape.centralRank < scene.centralCount - 1 ? 1 - scene.centralRatio ** 2 : 1);
  const selected = [...representatives.values()].sort((a, b) => weightedArea(b) - weightedArea(a) || a.orbit - b.orbit).slice(0, 2);
  return { orbits: new Set(selected.map(shape => shape.orbit)), symmetries: [...new Set(selected.map(shape => shape.localSymmetry))] };
}

function hybridFractalSvg(scene, descriptor, plan, fields) {
  const colors = fractalColorPair(scene.palette, descriptor.paletteOffset).colors;
  let definitions = plan.symmetries.map((symmetry, i) => fractalFieldSvg(fields[i], colors, 'fractal' + i, symmetry)).join('');
  const overlays = [];
  scene.shapes.forEach((shape, i) => {
    if (!plan.orbits.has(shape.orbit)) return;
    const inner = shape.points.map(point => point.map((v, axis) => shape.center[axis] + descriptor.rimScale * (v - shape.center[axis])));
    definitions += '<clipPath id="fractal-inner' + i + '" clipPathUnits="userSpaceOnUse">' + polygon(inner, 'white') + '</clipPath>';
    const radius = Math.max(...shape.points.map(point => distance(shape.center, point)));
    const c = Math.cos(shape.textureAngle), s = Math.sin(shape.textureAngle), sign = shape.textureMirror ? -1 : 1;
    const matrix = [radius * c, radius * s, -radius * s * sign, radius * c * sign, ...shape.center].map(number).join(' ');
    const fieldIndex = plan.symmetries.indexOf(shape.localSymmetry);
    // Both clips matter: inset retains the legacy rim, ownership retains every
    // nearest/stacked/central cut. Existing geometry and masks are never mutated.
    overlays.push('<g mask="url(#m' + i + ')"><g clip-path="url(#fractal-inner' + i + ')"><use href="#fractal' + fieldIndex + '" transform="matrix(' + matrix + ')"/></g></g>');
  });
  const base = sceneSvg(scene).replace('</defs>', definitions + '</defs>');
  return base.slice(0, -6) + overlays.join('') + '</svg>';
}

/** Self-contained SVG; legacy renderer bytes are deliberately untouched. */
export function createMosaicSvg(sessionId) {
  const scene = buildMosaicScene(sessionId), descriptor = getFractalParameters(sessionId);
  if (!descriptor || descriptor.enabled === false) return sceneSvg(scene);
  const plan = hybridFractalPlan(scene);
  const fields = plan.symmetries.map(symmetry => buildFractalField(descriptor, symmetry));
  return hybridFractalSvg(scene, descriptor, plan, fields);
}

/** Cooperative fallback; workers can use the synchronous entry point above. */
export async function createMosaicSvgAsync(seed, {
  yieldControl = () => new Promise(resolve => setTimeout(resolve, 0)), shouldAbort = () => false,
} = {}) {
  if (typeof seed !== 'string') throw new TypeError('Session ID must be a string');
  if (typeof yieldControl !== 'function' || typeof shouldAbort !== 'function') throw new TypeError('Invalid mosaic render callbacks');
  checkFractalAbort(shouldAbort);
  const descriptor = getFractalParameters(seed), scene = buildMosaicScene(seed);
  if (!descriptor || descriptor.enabled === false) return sceneSvg(scene);
  const plan = hybridFractalPlan(scene), fields = [];
  for (const symmetry of plan.symmetries) {
    if (fields.length) { await yieldControl(); checkFractalAbort(shouldAbort); }
    fields.push(await buildFractalFieldAsync(descriptor, symmetry, { yieldControl, shouldAbort }));
  }
  checkFractalAbort(shouldAbort);
  return hybridFractalSvg(scene, descriptor, plan, fields);
}

/** Cheap native canvas color: parameters only, never geometry or a fractal field. */
export function getMosaicCanvasColor(seed) {
  if (typeof seed !== 'string') throw new TypeError('Session ID must be a string');
  return parameters(seed)[0].palette[0];
}

// Bounded LRU: only the finished URI is retained, never a session object/scene.
const DATA_URL_CACHE_LIMIT = 128;
const dataUrlCache = new Map();
export function getMosaicDataUrl(sessionId) {
  if (typeof sessionId !== 'string') throw new TypeError('Session ID must be a string');
  if (dataUrlCache.has(sessionId)) {
    const uri=dataUrlCache.get(sessionId);dataUrlCache.delete(sessionId);dataUrlCache.set(sessionId,uri);return uri;
  }
  const uri='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(createMosaicSvg(sessionId));
  dataUrlCache.set(sessionId,uri);
  if (dataUrlCache.size>DATA_URL_CACHE_LIMIT) dataUrlCache.delete(dataUrlCache.keys().next().value);
  return uri;
}

// Cheap placeholder cache is separate: it can never trigger the full renderer.
const mosaicBaseDataUrlCache = new Map();
export function getMosaicBaseDataUrl(seed) {
  if (typeof seed !== 'string') throw new TypeError('Session ID must be a string');
  if (!hasMosaicFractal(seed)) return getMosaicDataUrl(seed);
  if (mosaicBaseDataUrlCache.has(seed)) {
    const uri = mosaicBaseDataUrlCache.get(seed);
    mosaicBaseDataUrlCache.delete(seed); mosaicBaseDataUrlCache.set(seed, uri); return uri;
  }
  const uri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(sceneSvg(buildMosaicScene(seed)));
  mosaicBaseDataUrlCache.set(seed, uri);
  if (mosaicBaseDataUrlCache.size > DATA_URL_CACHE_LIMIT) mosaicBaseDataUrlCache.delete(mosaicBaseDataUrlCache.keys().next().value);
  return uri;
}
