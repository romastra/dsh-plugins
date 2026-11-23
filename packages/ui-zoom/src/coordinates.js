/** Version-bounded compatibility with the SHIPPED DSH 0.2.2-rc.3 primitives.
 * Positioning boxes use viewport CSS pixels; visible children retain root zoom.
 * No browser prototypes, native actions, React trees or module exports are patched.
 */
export const FLOATING_CONTRACT = 'dsh-0.2.2-rc.3/viewport-v1';
export const FLOATING = Object.freeze({
  hover: '._portal_l6gf9_95>._card_l6gf9_9',
  bridge: '._portal_l6gf9_95>._bridge_l6gf9_99',
  tooltip: '._bubble_gm1ra_1',
  menu: '._portal_70kcw_43._surface_1w4el_1',
  submenu: '._submenu_70kcw_8._surface_1w4el_1',
  backing: 'body>._backing_1w4el_2',
  point: '._root_70kcw_1[style*="anchor-name:"][style*="position: fixed"]:not(:has(>._list_70kcw_7))',
});
const FZ = 'var(--dsh-ui-zoom-factor,1)';
const FI = 'var(--dsh-ui-zoom-inverse,1)';
const MENU_BOXES = `${FLOATING.menu},${FLOATING.submenu}`;
const MENU_CHILDREN = ':not(._material_1w4el_21):not(._submenuAnchor_70kcw_370)';
const MENU_LEASE = 'data-ui-zoom-menu-anchor';
const MENU_PREFIX = '--dsh-ui-zoom-menu-';

export const COORDINATE_CSS = `
/* A fake point has no visible content; real Menu content is portaled elsewhere. */
${FLOATING.point}{zoom:${FI}}
/* HoverCard offset sizes, screen rects, bridge and left/top now agree. */
${FLOATING.hover}{zoom:${FI};width:calc(244px * ${FZ});max-width:calc(100vw - 16px);max-height:calc(100dvh - 16px);padding:calc(12px * ${FZ}) calc(16px * ${FZ});border-radius:calc(var(--dsw-radius-lg) * ${FZ});overflow:auto}
${FLOATING.hover}>*{zoom:${FZ}}
${FLOATING.hover}:not(:has(>*)){font-size:calc(1em * ${FZ});line-height:calc(1lh * ${FZ})}
${FLOATING.hover}._preview_l6gf9_51{padding:0}
${FLOATING.hover}._media_l6gf9_79{padding:calc(8px * ${FZ})}
${FLOATING.hover}._fitContent_l6gf9_91{width:max-content}
${FLOATING.bridge}{zoom:${FI}}
/* Tooltip's native ResizeObserver measures this same viewport-unit box. */
${FLOATING.tooltip}{zoom:${FI};padding:calc(3px * ${FZ}) calc(7px * ${FZ});gap:calc(8px * ${FZ});border-radius:calc(var(--dsw-radius-sm) * ${FZ})}
${FLOATING.tooltip}>*{zoom:${FZ}}
${FLOATING.tooltip}[data-has-shortcut]{padding-inline-end:calc(5px * ${FZ})}
${FLOATING.tooltip}[data-has-shortcut]:not(:has(._label_gm1ra_31)){padding:calc(3px * ${FZ})}
/* Fixed menus AND submenus share the same units, including native row-offset,
 * offsetWidth/Height, available-space decisions and anchored max-height. */
${MENU_BOXES}{zoom:${FI};padding:calc(4px * ${FZ});border-radius:calc(var(--dsw-radius-lg) * ${FZ});max-width:min(calc(360px * ${FZ}),calc(100vw - 24px))}
${FLOATING.menu}{min-width:min(calc(144px * ${FZ}),calc(100vw - 24px))}
${FLOATING.submenu}{min-width:min(calc(163px * ${FZ}),calc(100vw - 24px))}
${FLOATING.menu}._compactList_70kcw_218,${FLOATING.submenu}._compactList_70kcw_218{min-width:min(calc(156px * ${FZ}),calc(100vw - 24px));padding:calc(4px * ${FZ})}
/* Preserve explicit width-matching and native page-mode semantics after base rules. */
${FLOATING.menu}[data-match-anchor-width]{min-width:min(anchor-size(width),calc(100vw - 24px))}
${FLOATING.submenu}[data-submenu-layout=page]{min-width:min(anchor-size(width),calc(100vw - 24px));max-width:calc(100vw - 24px)}
${FLOATING.menu}>${MENU_CHILDREN},${FLOATING.submenu}>${MENU_CHILDREN}{zoom:${FZ}}
/* Material and geometric submenu anchors deliberately do NOT get child zoom. */
${FLOATING.backing}{zoom:${FI};border-radius:calc(var(--dsw-radius-lg) * ${FZ})}
${FLOATING.menu}._compact_1w4el_6,${FLOATING.submenu}._compact_1w4el_6,${FLOATING.backing}._compact_1w4el_6{border-radius:calc(var(--dsw-radius-md) * ${FZ})}
`;

/** Attribute-string escaping, not a selector/identifier guessed from user text. */
export function coordinateCssString(value) {
  return '"' + String(value).replace(/[\x00-\x1f\x7f"\\]/g,
    char => '\\' + (char.charCodeAt(0) || 0xfffd).toString(16) + ' ') + '"';
}

export function retainedAnchorNames(value) {
  if (!value || String(value).trim().toLowerCase() === 'none') return [];
  const text = String(value);
  if (text.length > 8192) throw new TypeError('Anchor-name list exceeds compatibility limit.');
  const names = [];
  const space = char => char !== undefined && /[\t\n\r\f ]/.test(char);
  const hex = char => char !== undefined && /[0-9a-fA-F]/.test(char);
  let at = 0;
  while (at < text.length) {
    while (space(text[at])) at += 1;
    const start = at;
    if (text.slice(at, at + 2) !== '--') throw new TypeError('Invalid CSS anchor-name list.');
    at += 2;
    while (at < text.length) {
      const char = text[at];
      if (/[a-zA-Z0-9_-]/.test(char) || char.charCodeAt(0) >= 128) { at += 1; continue; }
      if (char !== '\\') break;
      at += 1;
      if (at >= text.length || /[\n\r\f]/.test(text[at])) throw new TypeError('Invalid CSS identifier escape.');
      if (hex(text[at])) {
        let digits = 0;
        while (digits < 6 && hex(text[at])) { at += 1; digits += 1; }
        if (space(text[at])) {
          if (text[at] === '\r' && text[at + 1] === '\n') at += 1;
          at += 1;
        }
      } else at += 1; // Escaped comma/quote/punctuation remains an identifier character.
    }
    if (at === start + 2) throw new TypeError('Empty CSS anchor name.');
    const name = text.slice(start, at);
    if (!name.startsWith(MENU_PREFIX)) names.push(name);
    while (space(text[at])) at += 1;
    if (at === text.length) break;
    if (text[at++] !== ',' || at === text.length) throw new TypeError('Invalid CSS anchor-name separator.');
  }
  return names;
}

/** Pure rule builder: menu ids stay opaque and tokens are internal safe integers. */
export function menuAnchorRules(groups) {
  const rules = [];
  for (const { tokens, baseNames = [], menus } of groups) {
    if (!tokens.length || tokens.some(token => !/^uzm-[1-9][0-9]*$/.test(token))) throw new TypeError('Invalid anchor lease.');
    const ownNames = tokens.map(token => MENU_PREFIX + token.slice(4));
    const names = [...new Set([...retainedAnchorNames(baseNames.join(',')), ...ownNames])];
    rules.push(`[${MENU_LEASE}=${coordinateCssString(tokens.join(' '))}]{anchor-name:${names.join(',')}!important}`);
    for (const { id, token } of menus) {
      if (typeof id !== 'string' || !id || !tokens.includes(token)) throw new TypeError('Invalid menu binding.');
      rules.push(`${FLOATING.menu}[id=${coordinateCssString(id)}]{position-anchor:${MENU_PREFIX + token.slice(4)}!important}`);
    }
  }
  return rules.join('\n');
}

/** Pure ownership decision: null means another writer owns the current value. */
export function coordinateLeaseRestore(current, lease) {
  return current === lease.written ? { value: lease.before } : null;
}
function releaseCoordinateLease(element, lease) {
  const restore = coordinateLeaseRestore(element.getAttribute(MENU_LEASE), lease);
  if (!restore) return;
  if (restore.value === null) element.removeAttribute(MENU_LEASE);
  else element.setAttribute(MENU_LEASE, restore.value);
}

export function createCoordinateCompatibility({ document, view }) {
  const style = document.createElement('style');
  style.setAttribute('data-ui-zoom-coordinates', FLOATING_CONTRACT);
  style.textContent = COORDINATE_CSS;
  document.head.appendChild(style);
  const bindings = new Map(); // Menu node -> its exact semantic opener; kept through dismissal.
  const leases = new Map();
  let sequence = 0, disposed = false, queued = false;
  let conflicts = 0, ambiguous = 0, failures = 0;
  const selector = `${FLOATING.menu},${FLOATING.point}`;
  const anchorsSupported = !!view.CSS?.supports?.('anchor-name', '--ui-zoom-probe')
    && !!view.CSS?.supports?.('position-anchor', '--ui-zoom-probe');

  function refresh() {
    queued = false;
    if (disposed || !anchorsSupported) return;
    const points = new Map();
    for (const point of document.querySelectorAll(FLOATING.point)) {
      const name = point.style.getPropertyValue('anchor-name').trim();
      if (/^--[a-zA-Z0-9_-]+$/.test(name)) points.set(name, point);
    }
    const surfaces = new Set(document.querySelectorAll(FLOATING.menu));
    for (const [node, binding] of bindings) {
      if (!surfaces.has(node) || !binding.button.isConnected || node.id !== binding.id) bindings.delete(node);
    }
    for (const node of surfaces) {
      if (bindings.has(node) || !node.id) continue;
      const anchor = node.style.getPropertyValue('position-anchor').trim();
      if (!points.has(anchor)) continue; // Real native anchors and non-point menus stay native.
      const candidates = document.querySelectorAll(`button[data-context-menu-trigger][aria-expanded="true"][aria-controls~=${coordinateCssString(node.id)}]`);
      if (candidates.length !== 1) { if (candidates.length > 1) ambiguous += 1; continue; }
      bindings.set(node, { id: node.id, button: candidates[0], token: 'uzm-' + (++sequence) });
    }
    const groups = new Map();
    for (const binding of bindings.values()) {
      if (!groups.has(binding.button)) groups.set(binding.button, []);
      groups.get(binding.button).push(binding);
    }
    for (const [button, lease] of leases) {
      if (!groups.has(button)) { releaseCoordinateLease(button, lease); leases.delete(button); }
    }
    const rules = [];
    for (const [button, items] of groups) {
      let lease = leases.get(button);
      const current = button.getAttribute(MENU_LEASE);
      if (lease && current !== lease.written) { conflicts += 1; continue; }
      if (!lease) { lease = { before: current, written: null }; leases.set(button, lease); }
      const tokens = items.map(item => item.token);
      const written = tokens.join(' ');
      // Read the native names without our own rule masking a concurrent class/style update.
      // Only our private lease attribute is temporarily removed; no geometry is read.
      if (current === lease.written) button.removeAttribute(MENU_LEASE);
      let baseNames;
      try { baseNames = retainedAnchorNames(view.getComputedStyle(button).getPropertyValue('anchor-name')); }
      finally { if (current !== null) button.setAttribute(MENU_LEASE, current); }
      button.setAttribute(MENU_LEASE, written);
      lease.written = written;
      rules.push({ tokens, baseNames, menus: items.map(({ id, token }) => ({ id, token })) });
    }
    const css = COORDINATE_CSS + '\n' + menuAnchorRules(rules);
    if (style.textContent !== css) style.textContent = css;
  }
  function schedule() {
    if (queued || disposed) return;
    queued = true;
    view.queueMicrotask(safeRefresh);
  }
  function relevant(records) {
    for (const record of records) {
      if (record.target === style || style.contains(record.target)) continue;
      if (record.type === 'attributes') {
        const node = record.target;
        if (node.matches?.(selector) || leases.has(node)
          || (['aria-controls', 'aria-expanded'].includes(record.attributeName) && node.matches?.('button[data-context-menu-trigger]'))) return true;
      } else {
        for (const node of [...record.addedNodes, ...record.removedNodes]) {
          if (node.nodeType === 1 && (node.matches?.(selector) || node.querySelector?.(selector))) return true;
        }
      }
    }
    return false;
  }
  function safeRefresh() {
    try { refresh(); }
    catch {
      queued = false; failures += 1;
      for (const [button, lease] of leases) releaseCoordinateLease(button, lease);
      leases.clear(); bindings.clear(); style.textContent = COORDINATE_CSS;
    }
  }
  const observer = new view.MutationObserver(records => { if (relevant(records)) schedule(); });
  observer.observe(document.body, { subtree: true, childList: true, attributes: true,
    attributeFilter: ['aria-controls', 'aria-expanded', 'id', 'style', 'class'] });
  safeRefresh();

  return {
    status() {
      const sizes = {};
      for (const key of ['hover', 'bridge', 'tooltip', 'menu', 'submenu', 'backing', 'point']) {
        const nodes = [...document.querySelectorAll(FLOATING[key])];
        const zooms = nodes.map(node => Number(node.currentCSSZoom)).filter(Number.isFinite);
        sizes[key] = { count: nodes.length, viewportUnits: zooms.length ? zooms.every(zoom => Math.abs(zoom - 1) < .0001) : null,
          measured: zooms.length, zooms: [...new Set(zooms)].slice(0, 4) };
      }
      return { contract: FLOATING_CONTRACT, installed: style.isConnected, anchorSupport: anchorsSupported,
        parsedRules: style.sheet?.cssRules?.length ?? 0, staticRules: (COORDINATE_CSS.match(/\}/g) ?? []).length,
        coordinateSpace: 'viewport-css-pixels', visualContent: 'browser-local-zoom',
        realMenuAnchors: bindings.size, openerLeases: leases.size, conflicts, ambiguous, failures, layers: sizes };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      for (const [button, lease] of leases) releaseCoordinateLease(button, lease);
      leases.clear(); bindings.clear(); style.remove();
    },
  };
}
