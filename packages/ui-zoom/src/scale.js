/** Pure zoom arithmetic. Percentages remain full-precision numbers until display. */
export const SETTINGS_ID = 'ui-zoom';
export const ZOOM_MIN = 50;
export const ZOOM_MAX = 300;
export const LOG_STEP = 0.1;

const MIN_LOG = Math.log(ZOOM_MIN / 100);
const MAX_LOG = Math.log(ZOOM_MAX / 100);
const MIN_EXTENDED_LOG = MIN_LOG - LOG_STEP;
const MAX_EXTENDED_LOG = MAX_LOG + LOG_STEP;
const EXTENDED_LOG_SPAN = MAX_EXTENDED_LOG - MIN_EXTENDED_LOG;

const grid = [ZOOM_MIN];
for (let index = Math.ceil(MIN_LOG / LOG_STEP); index <= Math.floor(MAX_LOG / LOG_STEP); index += 1) {
  grid.push(index === 0 ? 100 : 100 * Math.exp(index * LOG_STEP));
}
grid.push(ZOOM_MAX);
export const ZOOM_LEVELS = Object.freeze(grid);

export function isZoomPercent(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= ZOOM_MIN && value <= ZOOM_MAX;
}

function requireZoomPercent(value) {
  if (!isZoomPercent(value)) throw new RangeError('Zoom percentage must be a finite number from 50 to 300.');
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

// Absorb arithmetic noise around an existing grid point, not a visible fraction of a step.
function sameLevelTolerance(a, b) {
  return 8 * Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b));
}

/** Keyboard/tool steps have no sticky state: each press advances to a distinct grid level. */
export function nextZoom(percent, action) {
  requireZoomPercent(percent);
  if (action === 'reset') return 100;
  if (action === 'in') {
    return ZOOM_LEVELS.find(level => level - percent > sameLevelTolerance(level, percent)) ?? ZOOM_MAX;
  }
  if (action === 'out') {
    return ZOOM_LEVELS.findLast(level => percent - level > sameLevelTolerance(level, percent)) ?? ZOOM_MIN;
  }
  throw new TypeError('Unknown zoom action.');
}

/**
 * Bottom is 0 and top is 1. The extended coordinate inserts one extra log step
 * on each side of 100%, before applying the ordinary nearest-grid quantization.
 * Thus the core [-0.1, +0.1] collapses to zero, and rounding adds its usual
 * half-step to either side. Exact half-step ties round toward the higher zoom.
 */
export function positionToPercent(position) {
  if (typeof position !== 'number' || !Number.isFinite(position)) {
    throw new RangeError('Slider position must be a finite number.');
  }
  const extendedLog = MIN_EXTENDED_LOG + clamp(position, 0, 1) * EXTENDED_LOG_SPAN;
  const log = extendedLog < -LOG_STEP
    ? extendedLog + LOG_STEP
    : extendedLog > LOG_STEP ? extendedLog - LOG_STEP : 0;
  const index = Math.round(log / LOG_STEP);
  return index === 0 ? 100 : clamp(100 * Math.exp(index * LOG_STEP), ZOOM_MIN, ZOOM_MAX);
}

/**
 * Place the thumb from the actual percentage, including off-grid legacy values.
 * This does not quantize: dragging at that position subsequently snaps to the grid.
 * Exactly 100% is displayed at the middle of the added sticky core.
 */
export function percentToPosition(percent) {
  requireZoomPercent(percent);
  const log = Math.log(percent / 100);
  const extendedLog = percent === 100 ? 0 : log + (percent < 100 ? -LOG_STEP : LOG_STEP);
  return clamp((extendedLog - MIN_EXTENDED_LOG) / EXTENDED_LOG_SPAN, 0, 1);
}

export const neutralPosition = percentToPosition(100);

/** Boundaries of the added collapse core, excluding the ordinary rounding half-step. */
export const STICKY_POSITIONS = Object.freeze({
  low: (-LOG_STEP - MIN_EXTENDED_LOG) / EXTENDED_LOG_SPAN,
  high: (LOG_STEP - MIN_EXTENDED_LOG) / EXTENDED_LOG_SPAN,
});

/** Numeric display text only; the caller supplies/localizes the percent sign. */
export function formatZoom(percent) {
  requireZoomPercent(percent);
  return percent.toFixed(1).replace(/\.0$/, '');
}
