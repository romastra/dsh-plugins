// Bounded Float64 escape-time textures. No DOM, canvas, network, entropy or cache.
const FRACTAL_GRID = 64;
const FRACTAL_ITERATIONS = 96;
const FRACTAL_PROBE_GRID = 24;
const FRACTAL_PROBE_ITERATIONS = 64;
const FRACTAL_ROW_CHUNK = 4;
const FRACTAL_RUN_LIMIT = 3072;
const FRACTAL_TAU = 2 * Math.PI;
const FRACTAL_JULIA_WINDOWS = [
  [-.8, .156, 0, 0, 2.9], [-.74543, .11301, 0, 0, 2.8],
  [-.4, .6, 0, 0, 2.7], [.285, .01, 0, 0, 2.7],
  [-.70176, -.3842, 0, 0, 2.8], [-.835, -.2321, 0, 0, 2.8],
];
const FRACTAL_MANDELBROT_WINDOWS = [
  [-.5, 0, 2.8], [-.75, .1, .45], [-.16, 1.04, .6],
  [-1.25, .03, .45], [.28, .01, .38], [-.7453, .1127, .055], [-.101, .9563, .13],
];

/** Raw variable inputs only; the caller supplies a domain-separated HashRandom. */
export function createFractalDescriptor(rng) {
  const family = rng.choice(['julia', 'mandelbrot']);
  const julia = rng.choice(FRACTAL_JULIA_WINDOWS);
  const view = family === 'julia' ? julia.slice(2) : rng.choice(FRACTAL_MANDELBROT_WINDOWS);
  return {
    family,
    centerReal: view[0] + rng.uniform(-.035, .035) * view[2],
    centerImag: view[1] + rng.uniform(-.035, .035) * view[2],
    windowSpan: view[2] * rng.uniform(.9, 1.1),
    juliaReal: julia[0] + rng.uniform(-.0015, .0015),
    juliaImag: julia[1] + rng.uniform(-.0015, .0015),
    fieldRotation: rng.uniform(0, FRACTAL_TAU),
    bandDensity: rng.uniform(1.8, 3.6),
    bandPhase: rng.uniform(0, 2),
    rimScale: rng.uniform(.88, .94),
    paletteOffset: rng.integer(0, 15),
  };
}

function fractalEscape(p, u, v, symmetry, limit, out) {
  // A full source window is unwrapped into one canonical wedge. SVG replicates
  // that SAME wedge, so local dihedral symmetry is exact, not a grid approximation.
  if (symmetry === 1) v = 2 * Math.abs(v) - 1;
  else if (symmetry > 1) {
    const period = FRACTAL_TAU / symmetry;
    const theta = Math.atan2(v, u);
    const folded = Math.abs(((theta + period / 2) % period + period) % period - period / 2);
    u = 2 * Math.min(1, Math.hypot(u, v)) - 1;
    v = 4 * folded / period - 1;
  }
  const c = Math.cos(p.fieldRotation), s = Math.sin(p.fieldRotation);
  const real = p.centerReal + (c * u - s * v) * p.windowSpan / 2;
  const imag = p.centerImag + (s * u + c * v) * p.windowSpan / 2;
  const julia = p.family === 'julia';
  const cr = julia ? p.juliaReal : real, ci = julia ? p.juliaImag : imag;
  let zr = julia ? real : 0, zi = julia ? imag : 0, steps = 0, magnitude = 0;
  for (; steps < limit; steps++) {
    const next = zr * zr - zi * zi + cr;
    zi = 2 * zr * zi + ci; zr = next;
    magnitude = zr * zr + zi * zi;
    if (magnitude > 4) { steps++; break; }
  }
  out[0] = magnitude <= 4 ? limit : Math.max(0, Math.min(limit - 1e-6,
    steps + 1 - Math.log2(Math.log2(Math.sqrt(magnitude)))));
  out[1] = steps;
}

function fractalBand(p, value, limit) {
  return value >= limit ? 0 : Math.floor(Math.log1p(value) * p.bandDensity + p.bandPhase) & 1;
}

function createFractalFieldState(size, iterations) {
  return { size, iterations, values: new Float64Array(size * size), bands: new Uint8Array(size * size), steps: 0 };
}
function fillFractalRows(field, p, symmetry, first, last) {
  const scratch = new Float64Array(2), size = field.size;
  for (let y = first; y < last; y++) for (let x = 0; x < size; x++) {
    fractalEscape(p, 2 * (x + .5) / size - 1, 2 * (y + .5) / size - 1, symmetry, field.iterations, scratch);
    const i = y * size + x;
    field.values[i] = scratch[0]; field.bands[i] = fractalBand(p, scratch[0], field.iterations);
    field.steps += scratch[1];
  }
}

export function buildFractalField(p, symmetry = 0) {
  const field = createFractalFieldState(FRACTAL_GRID, FRACTAL_ITERATIONS);
  fillFractalRows(field, p, symmetry, 0, field.size);
  return field;
}

export function checkFractalAbort(shouldAbort) {
  if (shouldAbort()) {
    const error = new Error('Mosaic rendering aborted'); error.name = 'AbortError'; throw error;
  }
}

/** At most four 64-pixel rows / 24576 complex iterations between yield points. */
export async function buildFractalFieldAsync(p, symmetry, { yieldControl, shouldAbort }) {
  const field = createFractalFieldState(FRACTAL_GRID, FRACTAL_ITERATIONS);
  for (let row = 0; row < field.size; row += FRACTAL_ROW_CHUNK) {
    checkFractalAbort(shouldAbort);
    fillFractalRows(field, p, symmetry, row, Math.min(field.size, row + FRACTAL_ROW_CHUNK));
    if (row + FRACTAL_ROW_CHUNK < field.size) await yieldControl();
  }
  checkFractalAbort(shouldAbort);
  return field;
}

function fractalProbeMetrics(field) {
  const counts = [0, 0], size = field.size;
  let transitions = 0, edges = 0, interior = 0, minimum = Infinity, maximum = -Infinity;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * size + x, band = field.bands[i], value = field.values[i];
    counts[band]++; if (value >= field.iterations) interior++;
    minimum = Math.min(minimum, value); maximum = Math.max(maximum, value);
    if (x) { transitions += Number(band !== field.bands[i - 1]); edges++; }
    if (y) { transitions += Number(band !== field.bands[i - size]); edges++; }
  }
  const fractions = counts.map(n => n / field.bands.length);
  return {
    entropy: -fractions.reduce((sum, f) => sum + (f ? f * Math.log2(f) : 0), 0),
    transitionRatio: transitions / edges,
    insideFraction: interior / field.bands.length,
    dominantFraction: Math.max(...fractions),
    distinctBands: counts.filter(Boolean).length,
    escapeSpread: maximum - minimum,
  };
}

/** Four 24x24 probes, max64 iterations: <=147456 steps, never geometry or SVG. */
export function measureFractalQuality(p) {
  const metrics = [], symmetries = [0, 1, 3, 6];
  let steps = 0;
  for (const symmetry of symmetries) {
    const field = createFractalFieldState(FRACTAL_PROBE_GRID, FRACTAL_PROBE_ITERATIONS);
    fillFractalRows(field, p, symmetry, 0, field.size);
    metrics.push(fractalProbeMetrics(field)); steps += field.steps;
  }
  const entropy = Math.min(...metrics.map(m => m.entropy));
  const transitionRatio = Math.min(...metrics.map(m => m.transitionRatio));
  const dominantFraction = Math.max(...metrics.map(m => m.dominantFraction));
  const escapeSpread = Math.min(...metrics.map(m => m.escapeSpread));
  const distinctBands = Math.min(...metrics.map(m => m.distinctBands));
  return {
    accepted: distinctBands === 2 && entropy >= .3 && transitionRatio >= .025
      && dominantFraction <= .945 && escapeSpread >= 2,
    entropy, transitionRatio, dominantFraction, escapeSpread, distinctBands,
    insideFraction: metrics.reduce((sum, m) => sum + m.insideFraction, 0) / metrics.length,
    samples: symmetries.length * FRACTAL_PROBE_GRID * FRACTAL_PROBE_GRID, steps,
  };
}

function fractalRowRuns(bands, size) {
  const paths = ['', '']; let runs = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size;) {
    const start = x, band = bands[y * size + x];
    while (x < size && bands[y * size + x] === band) x++;
    const width = x - start;
    paths[band] += 'M' + start + ' ' + y + 'h' + width + 'v1h-' + width + 'z'; runs++;
  }
  return { paths, runs };
}
const fractalNumber = value => Number(value.toFixed(9)).toString();

/** Shared path definitions; repeated/mirrored <use> elements never repeat path data. */
export function fractalFieldSvg(field, colors, id, symmetry) {
  let size = field.size, bands = field.bands, rows = fractalRowRuns(bands, size);
  if (rows.runs > FRACTAL_RUN_LIMIT) {
    // A hard vertex/serialization cap, without new complex iterations or RNG draws.
    size /= 2; bands = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = 2 * y * field.size + 2 * x;
      const count = field.bands[i] + field.bands[i + 1] + field.bands[i + field.size] + field.bands[i + field.size + 1];
      bands[y * size + x] = count > 2 ? 1 : count < 2 ? 0 : field.bands[i];
    }
    rows = fractalRowRuns(bands, size);
  }
  let definitions = '<g id="' + id + '-grid" shape-rendering="crispEdges" transform="translate(-1 -1) scale(' + fractalNumber(2 / size) + ')">'
    + rows.paths.map((d, i) => '<path fill="' + colors[i] + '" d="' + d + '"/>').join('') + '</g>';
  if (!symmetry) return definitions + '<g id="' + id + '"><use href="#' + id + '-grid"/></g>';
  const wedge = symmetry === 1 ? '-3,0 3,0 3,3 -3,3'
    : '0,0 3,0 ' + fractalNumber(3 * Math.cos(Math.PI / symmetry)) + ',' + fractalNumber(3 * Math.sin(Math.PI / symmetry));
  definitions += '<clipPath id="' + id + '-wedge" clipPathUnits="userSpaceOnUse"><polygon points="' + wedge + '"/></clipPath><g id="' + id + '">';
  for (let k = 0; k < symmetry; k++) {
    const tile = '<g clip-path="url(#' + id + '-wedge)"><use href="#' + id + '-grid"/></g>';
    definitions += '<g transform="rotate(' + fractalNumber(360 * k / symmetry) + ')">' + tile
      + '<g transform="scale(1 -1)">' + tile + '</g></g>';
  }
  return definitions + '</g>';
}
