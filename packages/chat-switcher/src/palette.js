// Pure sRGB/OKLab palette math. No DOM, browser probes, Harness imports or token table.
// Y is the WCAG relative luminance of the *uncomposited* RGB; alpha is carried through.
const csPaletteTau = 2 * Math.PI;
const csPaletteGrayEpsilon = 1e-7;
const csPaletteGamutEpsilon = 2e-12;
// WCAG's rounded 0.04045 decode and sRGB's 0.0031308 encode cutovers
// differ by ~2.4e-9 in linear RGB. Allow that tiny discontinuity, still < 1e-7.
const csPaletteYVerificationTolerance = 1e-8;
const csPaletteMaximumAmplification = 4;
const csPaletteLightnessIterations = 52;
const csPaletteChromaIterations = 32;
const csPaletteBrandName = /^--dsw-static-deepseek-[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const csPaletteNumber = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const csPaletteLmsFromLinear = [
  [0.4122214708, 0.5363325363, 0.0514459929],
  [0.2119034982, 0.6806995451, 0.1073969566],
  [0.0883024619, 0.2817188376, 0.6299787005],
];
const csPaletteLabFromLms = [
  [0.2104542553, 0.7936177850, -0.0040720468],
  [1.9779984951, -2.4285922050, 0.4505937099],
  [0.0259040371, 0.7827717662, -0.8086757660],
];
// Invert the forward matrices rather than using rounded inverse coefficients. This
// keeps same-colour round trips accurate even close to a gamut face.
const csPaletteLinearFromLms = csPaletteInverse3(csPaletteLmsFromLinear);
const csPaletteLmsFromLab = csPaletteInverse3(csPaletteLabFromLms);

function csPaletteInverse3(matrix) {
  const [[a, b, c], [d, e, f], [g, h, i]] = matrix;
  const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  return [
    [e * i - f * h, c * h - b * i, b * f - c * e],
    [f * g - d * i, a * i - c * g, c * d - a * f],
    [d * h - e * g, b * g - a * h, a * e - b * d],
  ].map(row => row.map(value => value / determinant));
}

function csPaletteMultiply3(matrix, vector) {
  return matrix.map(row => row[0] * vector[0] + row[1] * vector[1] + row[2] * vector[2]);
}

function csPaletteDecode(component) {
  return component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4;
}

function csPaletteEncode(component) {
  return component <= 0.0031308 ? 12.92 * component : 1.055 * component ** (1 / 2.4) - 0.055;
}

function csPaletteLinearY(rgb) {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function csPaletteValidComponents(value, lengths) {
  if (!Array.isArray(value) || !lengths.includes(value.length)) return false;
  for (let i = 0; i < value.length; i++) {
    const component = value[i];
    if (typeof component !== 'number' || !Number.isFinite(component) || component < 0 || component > 1) return false;
  }
  return true;
}

function csPaletteParseComponent(token, numericScale) {
  const percent = token.endsWith('%');
  const number = percent ? token.slice(0, -1) : token;
  if (!csPaletteNumber.test(number)) return null;
  const value = Number(number) / (percent ? 100 : numericScale);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function csPaletteParseFunction(body, numericScale, allowCommas) {
  let channels, alpha;
  if (body.includes(',')) {
    if (!allowCommas || body.includes('/')) return null;
    const parts = body.split(',').map(part => part.trim());
    if (parts.length !== 3 && parts.length !== 4) return null;
    channels = parts.slice(0, 3);
    // Legacy rgb() requires either all percentages or all numeric channels.
    if (!channels.every(part => part.endsWith('%') === channels[0].endsWith('%'))) return null;
    alpha = parts.length === 4 ? parts[3] : '1';
  } else {
    const parts = body.split('/');
    if (parts.length > 2 || !parts[0].trim()) return null;
    channels = parts[0].trim().split(/\s+/);
    if (channels.length !== 3) return null;
    alpha = parts.length === 2 ? parts[1].trim() : '1';
  }
  const result = channels.map(part => csPaletteParseComponent(part, numericScale));
  result.push(csPaletteParseComponent(alpha, 1));
  return result.includes(null) ? null : result;
}

/**
 * Parse the bounded, explicit sRGB forms used by the runtime probe: hex,
 * rgb()/rgba(), color(srgb ...), or a copied [r,g,b,(a)] array in 0..1.
 * Unsupported CSS (names, var(), other spaces, relative colours, out-of-range
 * channels) returns null rather than guessing a browser's colour normalization.
 */
export function parsePaletteColor(css) {
  if (Array.isArray(css)) return csPaletteValidComponents(css, [3, 4]) ? [...css.slice(0, 3), css.length === 4 ? css[3] : 1] : null;
  if (typeof css !== 'string') return null;
  const text = css.trim();
  if (/^#[\da-f]+$/i.test(text)) {
    const hex = text.slice(1);
    if (![3, 4, 6, 8].includes(hex.length)) return null;
    const parts = hex.length < 5 ? [...hex].map(part => parseInt(part + part, 16) / 255) : hex.match(/../g).map(part => parseInt(part, 16) / 255);
    return [...parts.slice(0, 3), parts.length === 4 ? parts[3] : 1];
  }
  const functional = /^([a-z]+)\(([\s\S]*)\)$/i.exec(text);
  if (!functional) return null;
  if (/^rgba?$/i.test(functional[1])) return csPaletteParseFunction(functional[2], 255, true);
  if (functional[1].toLowerCase() !== 'color') return null;
  const srgb = /^\s*srgb\s+([\s\S]*)$/i.exec(functional[2]);
  return srgb ? csPaletteParseFunction(srgb[1], 1, false) : null;
}

/** WCAG relative luminance of normalized sRGB (not alpha-composited). */
export function paletteLuminance(rgb) {
  return csPaletteValidComponents(rgb, [3, 4]) ? csPaletteLinearY(rgb.slice(0, 3).map(csPaletteDecode)) : NaN;
}

function csPaletteRgbToLab(rgb) {
  return csPaletteMultiply3(csPaletteLabFromLms,
    csPaletteMultiply3(csPaletteLmsFromLinear, rgb.slice(0, 3).map(csPaletteDecode)).map(Math.cbrt));
}

function csPaletteLabToLinear(lab) {
  return csPaletteMultiply3(csPaletteLinearFromLms,
    csPaletteMultiply3(csPaletteLmsFromLab, lab).map(value => value ** 3));
}

function csPaletteIsGray(rgb, chroma) {
  return chroma <= csPaletteGrayEpsilon || Math.max(...rgb.slice(0, 3)) - Math.min(...rgb.slice(0, 3)) <= csPaletteGrayEpsilon;
}

function csPaletteInGamut(linear) {
  return linear && linear.every(value => Number.isFinite(value) && value >= -csPaletteGamutEpsilon && value <= 1 + csPaletteGamutEpsilon);
}

function csPaletteNeutral(y) {
  const component = csPaletteEncode(y);
  return [component, component, component];
}

// This clamp is ONLY for numerical epsilon at a gamut face, never gamut mapping.
function csPaletteCleanLinear(linear) {
  return csPaletteInGamut(linear) ? linear.map(value => Math.max(0, Math.min(1, value))) : null;
}

/** Solve actual linear-sRGB Y by varying OKLab L with fixed a,b (fixed h,C).
 * A failed sign bracket is rejected, not silently fed into bisection. At very
 * large C the cubic need not bracket a physical solution; reducing C fixes it.
 */
function csPaletteSolveLightness(y, chroma, hue) {
  const a = chroma * Math.cos(hue), b = chroma * Math.sin(hue);
  const at = lightness => csPaletteLabToLinear([lightness, a, b]);
  let low = 0, high = 1;
  let lowValue = csPaletteLinearY(at(low)) - y;
  const highValue = csPaletteLinearY(at(high)) - y;
  if (!Number.isFinite(lowValue) || !Number.isFinite(highValue) || lowValue > 0 || highValue < 0) return null;
  if (lowValue === 0) return at(low);
  if (highValue === 0) return at(high);
  for (let iteration = 0; iteration < csPaletteLightnessIterations; iteration++) {
    const middle = (low + high) / 2;
    const value = csPaletteLinearY(at(middle)) - y;
    if (!Number.isFinite(value)) return null;
    if (value === 0) return at(middle);
    if ((value < 0) === (lowValue < 0)) { low = middle; lowValue = value; }
    else high = middle;
  }
  const result = at((low + high) / 2);
  return Math.abs(csPaletteLinearY(result) - y) <= 1e-12 ? result : null;
}

// C / Cmax(Y,h) is a gamut-aware relative saturation, independent of raw C's
// strong lightness/hue dependence. All in-gamut sRGB OKLab chromas are < 1.
function csPaletteMaximumChroma(y, hue) {
  if (y <= 0 || y >= 1) return 0;
  let low = 0, high = 1;
  for (let iteration = 0; iteration < csPaletteChromaIterations; iteration++) {
    const middle = (low + high) / 2;
    if (csPaletteInGamut(csPaletteSolveLightness(y, middle, hue))) low = middle;
    else high = middle;
  }
  return low;
}

function csPaletteRelativeSaturation(y, chroma, hue) {
  const maximum = csPaletteMaximumChroma(y, hue);
  return maximum > 0 ? Math.min(1, chroma / maximum) : 0;
}

function csPaletteMapChroma(y, chroma, hue) {
  let linear = csPaletteSolveLightness(y, chroma, hue);
  if (csPaletteInGamut(linear)) return { rgb: csPaletteCleanLinear(linear).map(csPaletteEncode), reduced: false, fallback: false };
  let low = 0, high = chroma, best = null;
  for (let iteration = 0; iteration < csPaletteChromaIterations; iteration++) {
    const middle = (low + high) / 2;
    linear = csPaletteSolveLightness(y, middle, hue);
    if (csPaletteInGamut(linear)) { low = middle; best = linear; }
    else high = middle;
  }
  // A same-Y gray exists for every valid input, even if no chromatic candidate
  // survives the numerical checks. Gray is built directly to avoid hue artifacts.
  return best ? { rgb: csPaletteCleanLinear(best).map(csPaletteEncode), reduced: true, fallback: false } :
    { rgb: csPaletteNeutral(y), reduced: true, fallback: true };
}

function csPaletteShortAngle(angle) {
  return ((angle + Math.PI) % csPaletteTau + csPaletteTau) % csPaletteTau - Math.PI;
}

function csPaletteReference(entries) {
  let x = 0, y = 0, weight = 0, saturation = 0, dominant = entries[0];
  for (const entry of entries) {
    x += entry.chroma * Math.cos(entry.hue);
    y += entry.chroma * Math.sin(entry.hue);
    weight += entry.chroma;
    saturation += entry.chroma * csPaletteRelativeSaturation(entry.y, entry.chroma, entry.hue);
    if (entry.chroma > dominant.chroma + 1e-12) dominant = entry;
  }
  // Opposing hues have no circular mean. Use a deterministic dominant token,
  // with lexical name tie-breaking supplied by the sorted input, not angle 0.
  const ambiguous = Math.hypot(x, y) <= weight * 1e-7;
  return { hue: ambiguous ? dominant.hue : Math.atan2(y, x), saturation: saturation / weight, ambiguous };
}

function csPaletteSerialize(rgb, alpha) {
  const components = rgb.map(component => String(Number(component.toFixed(12))));
  return `color(srgb ${components.join(' ')} / ${String(alpha)})`;
}

function csPaletteSerializeVerified(rgb, alpha, y) {
  let css = csPaletteSerialize(rgb, alpha);
  let parsed = parsePaletteColor(css);
  let error = parsed ? Math.abs(paletteLuminance(parsed) - y) : Infinity;
  let fallback = false;
  if (error > csPaletteYVerificationTolerance || !parsed || parsed[3] !== alpha) {
    css = csPaletteSerialize(csPaletteNeutral(y), alpha);
    parsed = parsePaletteColor(css);
    error = parsed ? Math.abs(paletteLuminance(parsed) - y) : Infinity;
    fallback = true;
  }
  return { css, error, fallback };
}

/**
 * Rotate a runtime-supplied brand palette towards imageColor, retaining each
 * token's WCAG Y and alpha. Hue offsets share a single signed short rotation;
 * C is scaled by target/reference relative saturation (amplification <= 4),
 * then reduced, never channel-clipped, if the new hue cannot fit the same Y.
 *
 * Only explicit --dsw-static-deepseek-* names are eligible. Unknown names,
 * invalid source values and an unsupported imageColor are copied unchanged.
 * No assumed shade names/count, source hexes, input mutation or browser APIs.
 * Transparent inputs preserve uncomposited Y, NOT contrast on an arbitrary
 * backdrop; pairwise WCAG contrast is consequently guaranteed for opaque pairs.
 */
export function adaptPalette(sourceRecord, imageColor) {
  const validRecord = sourceRecord !== null && typeof sourceRecord === 'object' && !Array.isArray(sourceRecord);
  const source = validRecord ? Object.entries(sourceRecord) : [];
  const colors = Object.fromEntries(source);
  const diagnostics = { adapted: 0, skipped: source.length, gamutReduced: 0, neutralFallbacks: 0,
    hueShiftDegrees: 0, chromaScale: 0, referenceHueDegrees: null, referenceSaturation: 0,
    targetSaturation: 0, ambiguousHue: false, maxLuminanceError: 0,
    invalidImage: false, invalidSource: !validRecord };
  const image = parsePaletteColor(imageColor);
  if (!image) { diagnostics.invalidImage = true; return { colors, diagnostics }; }
  const entries = source.filter(([name]) => csPaletteBrandName.test(name)).map(([name, value]) => {
    const rgba = parsePaletteColor(value);
    if (!rgba) return null;
    const lab = csPaletteRgbToLab(rgba), chroma = Math.hypot(lab[1], lab[2]);
    return { name, rgba, y: paletteLuminance(rgba), chroma, hue: Math.atan2(lab[2], lab[1]), gray: csPaletteIsGray(rgba, chroma) };
  }).filter(Boolean).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const chromatic = entries.filter(entry => !entry.gray);
  const imageLab = csPaletteRgbToLab(image), imageChroma = Math.hypot(imageLab[1], imageLab[2]);
  const neutralImage = csPaletteIsGray(image, imageChroma);
  let shift = 0, scale = 0;
  if (chromatic.length && !neutralImage) {
    const reference = csPaletteReference(chromatic), imageHue = Math.atan2(imageLab[2], imageLab[1]);
    const imageSaturation = csPaletteRelativeSaturation(paletteLuminance(image), imageChroma, imageHue);
    shift = csPaletteShortAngle(imageHue - reference.hue);
    scale = Math.min(csPaletteMaximumAmplification, imageSaturation / Math.max(reference.saturation, 1e-12));
    diagnostics.referenceHueDegrees = reference.hue * 180 / Math.PI;
    diagnostics.referenceSaturation = reference.saturation;
    diagnostics.targetSaturation = imageSaturation;
    diagnostics.ambiguousHue = reference.ambiguous;
  }
  diagnostics.hueShiftDegrees = shift * 180 / Math.PI;
  diagnostics.chromaScale = scale;
  for (const entry of entries) {
    const mapped = neutralImage || entry.gray || scale === 0 ? { rgb: csPaletteNeutral(entry.y), reduced: false, fallback: false } :
      csPaletteMapChroma(entry.y, entry.chroma * scale, entry.hue + shift);
    const serialized = csPaletteSerializeVerified(mapped.rgb, entry.rgba[3], entry.y);
    // Construction is finite for every valid sRGB source. If verification ever
    // fails even for gray, retain the source rather than expose a wrong-Y token.
    if (serialized.error > csPaletteYVerificationTolerance) continue;
    colors[entry.name] = serialized.css;
    diagnostics.adapted++;
    diagnostics.skipped--;
    if (mapped.reduced) diagnostics.gamutReduced++;
    if (mapped.fallback || serialized.fallback) diagnostics.neutralFallbacks++;
    diagnostics.maxLuminanceError = Math.max(diagnostics.maxLuminanceError, serialized.error);
  }
  return { colors, diagnostics };
}
