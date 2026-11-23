import { tensionModel } from './tension.js';

function curtainRect(rect) {
  if (!rect) return null;
  const { left, top, width, height } = rect;
  if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return { left, top, width, height };
}

function curtainEffectiveZoom(element, view) {
  try {
    const zoom = element?.currentCSSZoom;
    if (Number.isFinite(zoom) && zoom > 0) return zoom;
  } catch { /* Older Web APIs may not expose the effective element zoom. */ }
  try {
    const root = view?.document?.documentElement;
    const value = root && view?.getComputedStyle?.(root)?.zoom;
    const text = typeof value === 'string' ? value.trim() : value;
    const percent = typeof text === 'string' && text.endsWith('%');
    const zoom = Number(percent ? text.slice(0, -1) : text) / (percent ? 100 : 1);
    if (Number.isFinite(zoom) && zoom > 0) return zoom;
  } catch { /* Root computed zoom is only a compatibility fallback. */ }
  return 1;
}

function curtainViewport(view) {
  try {
    const visual = view?.visualViewport;
    const axis = (inner, size, offset) => {
      const hasInner = Number.isFinite(inner) && inner > 0;
      const hasVisual = Number.isFinite(size) && size > 0;
      if (!hasInner && !hasVisual) return null;
      const origin = Number.isFinite(offset) ? offset : 0;
      const left = hasInner ? Math.min(0, hasVisual ? origin : 0) : origin;
      const right = Math.max(hasInner ? inner : -Infinity, hasVisual ? origin + size : -Infinity);
      return { left, size: right - left };
    };
    // Cover both the layout viewport and any displaced visual viewport. Neither
    // viewport receives listeners: a release is a single bounded snapshot.
    const x = axis(view?.innerWidth, visual?.width, visual?.offsetLeft);
    const y = axis(view?.innerHeight, visual?.height, visual?.offsetTop);
    return x && y ? curtainRect({ left: x.left, top: y.left, width: x.size, height: y.size }) : null;
  } catch { return null; }
}

/** Snapshot only our own indicator; never inspect chat/editor/control content. */
export function captureCurtain({ owner, area, view, distance, side, image = null } = {}) {
  try {
    const head = owner?.querySelector?.('.cs-tension-head');
    try {
      const shownImage = owner?.querySelector?.('.cs-tension-head-svg image');
      const href = shownImage?.getAttribute?.('href') || shownImage?.href?.baseVal;
      if (typeof href === 'string' && href) image = href;
    } catch { /* Missing image APIs must not invalidate a usable head snapshot. */ }
    if (head) {
      const circle = curtainRect(head.getBoundingClientRect());
      return circle ? { circle, image } : null;
    }
    if (side !== 'left' && side !== 'right') return null;
    const bounds = curtainRect(area?.getBoundingClientRect?.());
    if (!bounds) return null;
    const zoom = curtainEffectiveZoom(area, view);
    const model = tensionModel(distance, true);
    const diameter = 54 * model.scale * 4 * zoom;
    const x = side === 'left' ? bounds.left + model.reach * 4 * zoom
      : bounds.left + bounds.width - model.reach * 4 * zoom;
    const circle = curtainRect({ left: x - diameter / 2, top: bounds.top + bounds.height / 2 - diameter / 2,
      width: diameter, height: diameter });
    return circle ? { circle, image } : null;
  } catch { return null; }
}

/** Snapshot only our own preview/image, never card labels, tasks or other DOM. */
export function captureCardCurtain({ preview, clip = null, view, image = null } = {}) {
  try {
    if (preview?.matches?.('.cs-preview') !== true) return null;
    const circle = curtainRect(preview.getBoundingClientRect());
    if (!circle) return null;
    const visual = view?.visualViewport;
    // Visibility uses the actual visual viewport when available, not the larger
    // coverage union used by the expanding curtain. Read only numeric Web APIs.
    const viewport = curtainRect({ left: Number.isFinite(visual?.offsetLeft) ? visual.offsetLeft : 0,
      top: Number.isFinite(visual?.offsetTop) ? visual.offsetTop : 0, width: visual?.width, height: visual?.height })
      || curtainRect({ left: 0, top: 0, width: view?.innerWidth, height: view?.innerHeight });
    if (!viewport) return null;
    const intersect = (a, b) => {
      const left = Math.max(a.left, b.left), top = Math.max(a.top, b.top);
      return curtainRect({ left, top, width: Math.min(a.left + a.width, b.left + b.width) - left,
        height: Math.min(a.top + a.height, b.top + b.height) - top });
    };
    let visible = intersect(circle, viewport);
    if (visible && clip) {
      const clipBounds = curtainRect(clip.getBoundingClientRect?.());
      if (!clipBounds) return null;
      visible = intersect(visible, clipBounds);
    }
    if (!visible) return null;
    const insets = { top: Math.max(0, visible.top - circle.top),
      right: Math.max(0, circle.left + circle.width - visible.left - visible.width),
      bottom: Math.max(0, circle.top + circle.height - visible.top - visible.height),
      left: Math.max(0, visible.left - circle.left) };
    const crop = Object.values(insets).some(value => value > 0) ? insets : null;
    try {
      const shown = preview.querySelector?.('img.cs-mosaic');
      const source = shown?.currentSrc || shown?.src || shown?.getAttribute?.('src');
      if (typeof source === 'string' && source) image = source;
    } catch { /* An unavailable image API must not invalidate our preview rect. */ }
    let radius = 0;
    try {
      const style = view?.getComputedStyle?.(preview);
      const text = style?.borderTopLeftRadius || style?.borderRadius;
      const value = typeof text === 'string' && /^\s*(\d*\.?\d+)(px|%)\s*$/.exec(text);
      if (value) {
        const amount = Number(value[1]);
        radius = Math.min(Math.min(circle.width, circle.height) / 2, value[2] === '%'
          ? amount * Math.min(circle.width, circle.height) / 100
          : amount * curtainEffectiveZoom(preview, view));
      }
    } catch { /* Square corners are a safe fallback for optional radius APIs. */ }
    return { circle, image, shape: 'card', radius, crop };
  } catch { return null; }
}

/** Preserve the source shape, then cover the viewport from the target center. */
export function curtainGeometry(circle, viewport, zoom = 1, target = null, shape = 'circle') {
  const head = curtainRect(circle);
  const bounds = curtainRect(viewport && { left: viewport.left ?? 0, top: viewport.top ?? 0,
    width: viewport.width, height: viewport.height });
  if (!head || !bounds) return null;
  const effectiveZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const card = shape === 'card';
  // Circles retain head r27 inside the outer 64-unit SVG; cards keep their exact
  // measured width/height. A uniform scale never stretches either source.
  const diameter = Math.max(head.width, head.height);
  const width = card ? head.width : diameter * 64 / 54;
  const height = card ? head.height : width;
  const centerX = head.left + head.width / 2, centerY = head.top + head.height / 2;
  const destination = curtainRect(target) || bounds;
  let endX = destination.left + destination.width / 2, endY = destination.top + destination.height / 2;
  if (![endX, endY].every(Number.isFinite)) {
    endX = bounds.left + bounds.width / 2; endY = bounds.top + bounds.height / 2;
  }
  const dx = Math.max(Math.abs(bounds.left - endX), Math.abs(bounds.left + bounds.width - endX));
  const dy = Math.max(Math.abs(bounds.top - endY), Math.abs(bounds.top + bounds.height - endY));
  // The centered inscribed circle is inside every rounded card, so its coverage
  // is conservative even at maximum corner rounding and non-square aspect.
  const radius = (card ? Math.min(head.width, head.height) : diameter) / 2;
  const result = {
    left: (centerX - width / 2) / effectiveZoom,
    top: (centerY - height / 2) / effectiveZoom,
    size: Math.max(width, height) / effectiveZoom,
    width: width / effectiveZoom,
    height: height / effectiveZoom,
    translateX: (endX - centerX) / effectiveZoom,
    translateY: (endY - centerY) / effectiveZoom,
    // Two viewport pixels of overscan keep a rounded/antialiased edge outside.
    scale: Math.max(1, (Math.hypot(dx, dy) + 2) / radius),
  };
  return Object.values(result).every(Number.isFinite) && result.width > 0 && result.height > 0 ? result : null;
}

/** Bind only two React-owned nodes. React owns glyphs, navigation and removal. */
export function bindCurtain({ host, bubble, view, circle, target = null, shape = 'circle', radius = 0, crop = null,
  onDone, duration = 280 } = {}) {
  const setTimer = typeof view?.setTimeout === 'function' && typeof view?.clearTimeout === 'function'
    ? view.setTimeout.bind(view) : globalThis.setTimeout.bind(globalThis);
  const clearTimer = typeof view?.setTimeout === 'function' && typeof view?.clearTimeout === 'function'
    ? view.clearTimeout.bind(view) : globalThis.clearTimeout.bind(globalThis);
  let disposed = false, done = false, opened = false;
  let frame = null, startTimer = null, fallbackTimer = null, animation = null;

  function cleanup() {
    if (frame !== null) {
      try { view?.cancelAnimationFrame?.(frame); } catch { /* Queued callbacks are guarded below. */ }
      frame = null;
    }
    if (startTimer !== null) { clearTimer(startTimer); startTimer = null; }
    if (fallbackTimer !== null) { clearTimer(fallbackTimer); fallbackTimer = null; }
    if (animation) {
      const owned = animation; animation = null;
      try { owned.onfinish = null; owned.oncancel = null; } catch { /* Partial WAAPI implementations. */ }
      try { owned.cancel?.(); } catch { /* The animation may already have finished. */ }
    }
    if (opened) {
      opened = false;
      // Only hide a popover this binding successfully opened. If it was already
      // hidden/detached, hidePopover may harmlessly fail on older implementations.
      try { host?.hidePopover?.(); } catch { /* No longer an open/valid popover. */ }
    }
  }

  function finish() {
    if (disposed || done) return;
    done = true;
    // Cancelling a filled animation must not briefly restore the opaque glyph
    // while React processes onDone and removes the curtain.
    try { if (bubble?.style) bubble.style.opacity = '0'; } catch { /* Detached/failed node. */ }
    cleanup();
    if (typeof onDone === 'function') onDone();
  }

  function start() {
    frame = null; startTimer = null;
    if (disposed || done) return;
    if (!host || !bubble?.style) { finish(); return; }
    try {
      if (typeof host.showPopover === 'function'
          && (host.popover === 'manual' || host.getAttribute?.('popover') === 'manual')) {
        host.showPopover(); opened = true;
      }
    } catch { /* Root selects the regular/inside-dialog fallback when needed. */ }
    const zoom = curtainEffectiveZoom(host, view);
    const geometry = curtainGeometry(circle, curtainViewport(view), zoom, target, shape);
    if (!geometry) { finish(); return; }
    let startClip = 'none';
    try {
      if (shape === 'card') {
        const insets = crop ? ['top', 'right', 'bottom', 'left'].map(key => crop[key]) : [0, 0, 0, 0];
        if (!insets.every(value => Number.isFinite(value) && value >= 0)
            || insets[0] + insets[2] >= circle.height || insets[1] + insets[3] >= circle.width) { finish(); return; }
        startClip = `inset(${insets.map(value => value / zoom + 'px').join(' ')})`;
      }
      bubble.style.left = geometry.left + 'px'; bubble.style.top = geometry.top + 'px';
      bubble.style.width = geometry.width + 'px'; bubble.style.height = geometry.height + 'px';
      bubble.style.borderRadius = (shape === 'card' && Number.isFinite(radius) ? Math.max(0, radius) / zoom : 0) + 'px';
      bubble.style.overflow = shape === 'card' ? 'hidden' : 'visible';
      bubble.style.clipPath = startClip;
      bubble.style.transform = 'translate(0px, 0px) scale(1)'; bubble.style.opacity = '1';
    } catch { finish(); return; }
    let reduced = false;
    try { reduced = !!view?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches; } catch { /* Optional API. */ }
    const milliseconds = Number.isFinite(duration) ? Math.max(0, Math.min(1000, duration)) : 280;
    const elapsed = reduced ? Math.min(40, milliseconds) : milliseconds;
    // A broken/missing WAAPI finished promise can never retain the curtain.
    fallbackTimer = setTimer(finish, elapsed + 80);
    try {
      if (typeof bubble.animate !== 'function') throw new Error('WAAPI unavailable');
      const keyframes = reduced ? [{ opacity: 1 }, { opacity: 0 }]
        : [{ transform: 'translate(0px, 0px) scale(1)', opacity: 1 },
          { transform: `translate(${geometry.translateX}px, ${geometry.translateY}px) scale(${geometry.scale})`, opacity: 0 }];
      if (!reduced && shape === 'card') {
        keyframes[0].clipPath = startClip; keyframes[1].clipPath = 'inset(0px 0px 0px 0px)';
      }
      animation = bubble.animate(keyframes, { duration: elapsed, easing: 'ease-out', fill: 'forwards' });
      if (!animation) throw new Error('WAAPI returned no animation');
      animation.onfinish = finish; animation.oncancel = finish;
      animation.finished?.then?.(finish, finish);
    } catch {
      // Without WAAPI simply reveal the underlying React UI, then expire the
      // owned layer on the same bounded timer; no CSS polling or global writes.
      try { bubble.style.opacity = '0'; } catch { /* Failed style API. */ }
    }
  }

  // Dialog showModal() runs in React's layout effect first. Showing our manual
  // popover in this one following frame then places it above that native dialog.
  try {
    if (typeof view?.requestAnimationFrame === 'function') frame = view.requestAnimationFrame(start);
    else startTimer = setTimer(start, 0);
  } catch { startTimer = setTimer(start, 0); }
  return () => {
    if (disposed) return;
    disposed = true;
    cleanup();
  };
}

export const CURTAIN_CSS = `
.cs-curtain{position:fixed;inset:auto;left:0;top:0;width:0;height:0;min-width:0;min-height:0;max-width:none;max-height:none;margin:0;padding:0;border:0;overflow:visible;background:transparent;pointer-events:none;z-index:2147483647}
.cs-curtain::backdrop{background:transparent;pointer-events:none}
.cs-curtain-bubble{position:absolute;transform-origin:center;will-change:transform,opacity;opacity:0;pointer-events:none}
.cs-curtain-bubble svg{display:block;width:100%;height:100%;overflow:visible}
.cs-curtain-bubble img{display:block;width:100%;height:100%;object-fit:contain}
.cs-curtain-bubble[data-shape=card]{background:var(--dsw-alias-bg-base)}
`;
