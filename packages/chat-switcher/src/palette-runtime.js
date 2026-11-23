import { adaptPalette, parsePaletteColor, paletteLuminance } from './palette.js';

export const CHAT_PALETTE_PREFIX = '--dsw-static-deepseek-';

/** Coalesce after the complete synchronous theme/change dispatch, independent
 * of listener registration order: native layout must finish applying body CSS.
 */
export function createChatThemeSource({ read, listen, defer = queueMicrotask }) {
  let snapshot = read();
  let disposed = false;
  let queued = false;
  const listeners = new Set();
  const invalidate = () => {
    if (disposed || queued) return;
    queued = true;
    defer(() => {
      queued = false;
      if (disposed) return;
      const next = read();
      if (next === snapshot) return;
      snapshot = next;
      for (const fn of [...listeners]) fn();
    });
  };
  const off = listen(invalidate);
  return {
    getSnapshot: () => snapshot,
    subscribe(fn) { if (disposed) return () => {}; listeners.add(fn); invalidate(); return () => listeners.delete(fn); },
    dispose() { if (disposed) return; disposed = true; off(); listeners.clear(); },
  };
}

const csChatPaletteName = /^--dsw-static-deepseek-[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const csChatPaletteTolerance = 1e-6;

/** Read the actual unmodified body palette, including third-party CSS layers.
 * Only our component's own stylesheet/probe is temporarily changed. Keeping
 * the copy, not CSSStyleDeclaration (which is live), prevents cumulative drift.
 */
export function readChatPaletteSource({ view, body, styleElement, probe }) {
  if (!view?.getComputedStyle || !body) throw new Error('Page theme is unavailable');
  const sheet = styleElement?.sheet;
  const wasDisabled = sheet?.disabled;
  const probeColor = probe?.style.getPropertyValue('color') ?? '';
  const probePriority = probe?.style.getPropertyPriority('color') ?? '';
  try {
    if (sheet) sheet.disabled = true;
    const computed = view.getComputedStyle(body);
    const names = new Set();
    for (let index = 0; index < computed.length; index++) {
      const name = computed.item ? computed.item(index) : computed[index];
      if (typeof name === 'string' && csChatPaletteName.test(name)) names.add(name);
    }
    const source = {};
    for (const name of [...names].sort()) {
      let value = computed.getPropertyValue(name).trim();
      if (!value) throw new Error('Unreadable brand color: ' + name);
      if (!parsePaletteColor(value) && probe) {
        // Let the browser resolve supported named colors/color-mix/etc. on an
        // element owned by this component; no canvas or page DOM mutation.
        probe.style.removeProperty('color');
        probe.style.setProperty('color', value);
        if (!probe.style.getPropertyValue('color')) throw new Error('Unsupported brand color: ' + name);
        value = view.getComputedStyle(probe).color;
      }
      // Do not silently mix a recolored subset with unsupported native tokens.
      if (!parsePaletteColor(value)) throw new Error('Unsupported brand color: ' + name);
      source[name] = value;
    }
    if (!Object.keys(source).length) throw new Error('No readable brand colors in the current theme');
    return Object.freeze(source);
  } finally {
    if (probe) {
      if (probeColor) probe.style.setProperty('color', probeColor, probePriority);
      else probe.style.removeProperty('color');
    }
    if (sheet) sheet.disabled = wasDisabled;
  }
}

export function chatPaletteBodyCss(colors) {
  const declarations = [];
  for (const name of Object.keys(colors).sort()) {
    const value = colors[name];
    if (!csChatPaletteName.test(name) || typeof value !== 'string' || /[;{}<>]/.test(value) || !parsePaletteColor(value)) throw new Error('Invalid generated brand color');
    declarations.push(name + ':' + value + '!important;');
  }
  return declarations.length ? 'body{' + declarations.join('') + '}' : '';
}

/** Pure coordinator; React owns the one body-targeting style in shell.overlay.
 * Always sample without that style, cache by the original palette + image
 * color, and never subscribe to our own output or mutate Theme preferences.
 */
export function createChatPaletteRuntime({ transform = adaptPalette, cacheLimit = 32, onError = () => {} } = {}) {
  let snapshot = Object.freeze({ status: 'inactive', css: '', color: null, count: 0, maxYError: 0, error: '' });
  let disposed = false;
  const listeners = new Set();
  const cache = new Map();
  const limit = Number.isSafeInteger(cacheLimit) && cacheLimit > 0 ? cacheLimit : 32;
  const publish = next => {
    if (snapshot.status === next.status && snapshot.css === next.css && snapshot.error === next.error && snapshot.color === next.color) return;
    snapshot = Object.freeze(next);
    for (const fn of [...listeners]) fn();
  };
  function reset() { publish({ status: 'inactive', css: '', color: null, count: 0, maxYError: 0, error: '' }); }
  return {
    getSnapshot: () => snapshot,
    subscribe(fn) { if (disposed) return () => {}; listeners.add(fn); return () => listeners.delete(fn); },
    update(color, readSource) {
      if (disposed) return snapshot;
      if (!color) { reset(); return snapshot; }
      try {
        const sampled = readSource();
        const names = Object.keys(sampled).sort();
        if (!names.length || names.some(name => !csChatPaletteName.test(name) || !parsePaletteColor(sampled[name]))) throw new Error('Invalid original brand palette');
        const original = Object.freeze(Object.fromEntries(names.map(name => [name, sampled[name]])));
        const key = JSON.stringify([color, original]);
        let result = cache.get(key);
        if (result) { cache.delete(key); cache.set(key, result); }
        else {
          const output = transform(original, color);
          const colors = output?.colors;
          if (!colors || Object.keys(colors).length !== names.length || Object.keys(colors).some(name => !Object.hasOwn(original, name))) throw new Error('Generated palette does not match its source');
          let maxYError = 0;
          for (const name of names) {
            const before = parsePaletteColor(original[name]);
            const after = parsePaletteColor(colors[name]);
            if (!before || !after || after.some(value => !Number.isFinite(value) || value < 0 || value > 1) || Math.abs(before[3] - after[3]) > csChatPaletteTolerance) throw new Error('Generated color is outside sRGB');
            maxYError = Math.max(maxYError, Math.abs(paletteLuminance(before) - paletteLuminance(after)));
          }
          if (maxYError > csChatPaletteTolerance) throw new Error('Generated palette changed the original luminance');
          result = Object.freeze({ css: chatPaletteBodyCss(colors), count: names.length, maxYError });
          cache.set(key, result);
          while (cache.size > limit) cache.delete(cache.keys().next().value);
        }
        publish({ status: 'ready', ...result, color, error: '' });
      } catch (error) {
        const message = error?.message ?? 'Chat colors unavailable';
        const report = snapshot.status !== 'fallback' || snapshot.error !== message;
        publish({ status: 'fallback', css: '', color, count: 0, maxYError: 0, error: message });
        if (report) { try { onError(message); } catch { /* feedback must not break the safe fallback */ } }
      }
      return snapshot;
    },
    dispose() { if (disposed) return; reset(); disposed = true; listeners.clear(); cache.clear(); },
  };
}
