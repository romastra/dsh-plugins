import { isZoomPercent } from './scale.js';

function requireFinite(value, name, positive = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || (positive && value <= 0)) {
    throw new RangeError(`${name} must be a ${positive ? 'positive ' : ''}finite number.`);
  }
}

function clampGeometry(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

/** Viewport-pixel geometry: document zoom deliberately is not an input. */
export function sliderGeometry(viewportHeight) {
  requireFinite(viewportHeight, 'Viewport height', true);
  const length = viewportHeight * 0.3;
  requireFinite(length, 'Track length', true);
  const thumb = Math.max(24, length * 0.07);
  const hit = Math.max(48, thumb + 16);
  const track = Math.max(3, Math.min(5, length * 0.014));
  return {
    length,
    thumb,
    hit,
    track,
    // 40px for the off-track reference column, with padding and a separate hitstrip.
    panelWidth: hit + 120,
    // Full endpoint hit targets + 44px header + 24px padding + 16px gaps + 44px reset.
    panelHeight: length + hit + 128,
  };
}

/**
 * Center below the trigger, prefer above when below does not fit, then clamp.
 * When full 8px margins are impossible, reduce them symmetrically; panels larger
 * than a viewport start at zero rather than being positioned entirely offscreen.
 */
export function popupPosition(viewportWidth, viewportHeight, anchor, geometry) {
  requireFinite(viewportWidth, 'Viewport width', true);
  requireFinite(viewportHeight, 'Viewport height', true);
  for (const edge of ['left', 'right', 'top', 'bottom']) requireFinite(anchor?.[edge], `Anchor ${edge}`);
  if (anchor.right < anchor.left || anchor.bottom < anchor.top) {
    throw new RangeError('Anchor edges must be ordered.');
  }
  requireFinite(geometry?.panelWidth, 'Panel width', true);
  requireFinite(geometry?.panelHeight, 'Panel height', true);

  const { panelWidth, panelHeight } = geometry;
  const horizontalInset = Math.min(8, Math.max(0, (viewportWidth - panelWidth) / 2));
  const verticalInset = Math.min(8, Math.max(0, (viewportHeight - panelHeight) / 2));
  const maxLeft = Math.max(horizontalInset, viewportWidth - panelWidth - horizontalInset);
  const maxTop = Math.max(verticalInset, viewportHeight - panelHeight - verticalInset);
  const desiredLeft = anchor.left / 2 + anchor.right / 2 - panelWidth / 2;
  const below = anchor.bottom + 8;
  const above = anchor.top - 8 - panelHeight;
  const desiredTop = below > maxTop && above >= verticalInset && above <= maxTop ? above : below;

  return {
    left: clampGeometry(desiredLeft, horizontalInset, maxLeft),
    top: clampGeometry(desiredTop, verticalInset, maxTop),
  };
}

/** Cancel CSS document zoom for the popup while retaining viewport-pixel sizing. */
export function inverseZoom(percent) {
  if (!isZoomPercent(percent)) throw new RangeError('Zoom percentage must be a finite number from 50 to 300.');
  return 100 / percent;
}

/** Preserve a finger's grab offset anywhere in the thumb's enlarged hit target. */
export function thumbGrabOffset(clientY, centerY, hit) {
  requireFinite(clientY, 'Pointer Y');
  requireFinite(centerY, 'Thumb center');
  requireFinite(hit, 'Thumb hit size', true);
  const delta = clientY - centerY;
  const epsilon = 8 * Number.EPSILON * Math.max(1, Math.abs(clientY), Math.abs(centerY), hit);
  return Math.abs(delta) <= hit / 2 + epsilon ? delta : 0;
}

/** clientY and the track's getBoundingClientRect() share viewport coordinates. */
export function pointerPosition(clientY, rect) {
  requireFinite(clientY, 'Pointer Y');
  requireFinite(rect?.top, 'Track top');
  requireFinite(rect?.height, 'Track height', true);
  return clampGeometry(1 - (clientY - rect.top) / rect.height, 0, 1);
}
