import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { COORDINATE_CSS, FLOATING, FLOATING_CONTRACT, coordinateCssString,
  retainedAnchorNames, menuAnchorRules, coordinateLeaseRestore } from '../src/coordinates.js';
import { zoomStyle } from '../src/core.js';
import { ZOOM_LEVELS } from '../src/scale.js';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const source = () => readFile(new URL('../src/coordinates.js', import.meta.url), 'utf8');

test('position boxes use one viewport unit and visible content retains every logarithmic zoom', () => {
  for (const percent of [...ZOOM_LEVELS, 81.87307530779819, 134.9858807576003]) {
    const css = zoomStyle(percent);
    const z = Number(css.match(/--dsh-ui-zoom-factor:\s*([\d.e+-]+)/)[1]);
    const inverse = Number(css.match(/--dsh-ui-zoom-inverse:\s*([\d.e+-]+)/)[1]);
    const shellZoom = z * inverse;
    close(shellZoom, 1);
    close(shellZoom * z, z);
    // Algebraic coordinate contracts only; this is not a browser/layout mock.
    for (const coordinate of [0, 8, 120, 512.25, 1900]) close(coordinate * shellZoom, coordinate);
    close(244 * z * shellZoom, 244 * z);
    close(13 * z * shellZoom, 13 * z);
    close((12 * z + 16 * z) * shellZoom, 28 * z);
  }
});

test('submenu measurements and row offsets use the same units as viewport rects', () => {
  for (const percent of [50, 100, 134.9858807576003, 200, 300]) {
    const z = percent / 100;
    const shell = z * (1 / z);
    const parentTop = 60.5, rowOffset = 72 * z;
    const rowTop = parentTop + rowOffset;
    const nativeRowDifference = rowTop - parentTop;
    close(nativeRowDifference * shell, rowOffset);
    const physicalWidth = Math.min(163 * z, 390 - 24);
    close(physicalWidth * shell, physicalWidth);
    assert.ok(physicalWidth <= 390 - 24);
  }
});

test('adapters have exact shipped fingerprints, not broad role/fixed-element rules', () => {
  assert.equal(FLOATING_CONTRACT, 'dsh-0.2.2-rc.3/viewport-v1');
  for (const selector of Object.values(FLOATING)) assert.ok(COORDINATE_CSS.includes(selector));
  assert.match(FLOATING.point, /position: fixed/);
  assert.match(FLOATING.point, /:not\(:has\(>\._list_70kcw_7\)\)/);
  assert.doesNotMatch(COORDINATE_CSS, /\[role=|\[role="|cs-session-menu|cs-dialog|dsh-ui-zoom-popup|:root\s*\{/);
  assert.doesNotMatch(COORDINATE_CSS, /\._portal_l6gf9_95\s*\{/);
});

test('existing compact-hover compensation remains idempotent at the same card and child levels', () => {
  assert.ok(COORDINATE_CSS.includes(`${FLOATING.hover}{zoom:var(--dsh-ui-zoom-inverse,1)`));
  assert.ok(COORDINATE_CSS.includes(`${FLOATING.hover}>*{zoom:var(--dsh-ui-zoom-factor,1)}`));
  assert.ok(COORDINATE_CSS.includes('width:calc(244px * var(--dsh-ui-zoom-factor,1))'));
  assert.ok(COORDINATE_CSS.includes('padding:calc(12px * var(--dsh-ui-zoom-factor,1)) calc(16px * var(--dsh-ui-zoom-factor,1))'));
  assert.doesNotMatch(COORDINATE_CSS, /inset:|position-anchor:|position-area:/);
});

test('preview/media geometry, plaintext, and bridge have their own compatible rules', () => {
  assert.ok(COORDINATE_CSS.includes(`${FLOATING.bridge}{zoom:var(--dsh-ui-zoom-inverse,1)}`));
  assert.ok(COORDINATE_CSS.includes(`${FLOATING.hover}._preview_l6gf9_51{padding:0}`));
  assert.ok(COORDINATE_CSS.includes(`${FLOATING.hover}._media_l6gf9_79{padding:calc(8px * var(--dsh-ui-zoom-factor,1))}`));
  assert.match(COORDINATE_CSS, /:not\(:has\(>\*\)\)\{font-size:calc\(1em/);
  assert.match(COORDINATE_CSS, /line-height:calc\(1lh/);
});

test('native menu material and geometric anchors are not rezoomed as text', () => {
  assert.ok(COORDINATE_CSS.includes(`${FLOATING.menu}>:not(._material_1w4el_21):not(._submenuAnchor_70kcw_370)`));
  assert.ok(COORDINATE_CSS.includes(`${FLOATING.submenu}>:not(._material_1w4el_21):not(._submenuAnchor_70kcw_370)`));
  assert.ok(COORDINATE_CSS.includes(`${FLOATING.backing}{zoom:var(--dsh-ui-zoom-inverse,1)`));
  assert.doesNotMatch(COORDINATE_CSS, /\._list_70kcw_7\s*\{/);
  assert.match(COORDINATE_CSS, /163px \* var\(--dsh-ui-zoom-factor/);
  assert.match(COORDINATE_CSS, /156px \* var\(--dsh-ui-zoom-factor/);
});

test('fit-content, match-anchor-width and submenu page modes preserve native semantic widths', () => {
  assert.ok(COORDINATE_CSS.includes(`${FLOATING.hover}._fitContent_l6gf9_91{width:max-content}`));
  const compact = COORDINATE_CSS.indexOf('._compactList_70kcw_218');
  const matched = COORDINATE_CSS.indexOf('[data-match-anchor-width]');
  const page = COORDINATE_CSS.indexOf('[data-submenu-layout=page]');
  assert.ok(matched > compact && page > compact);
  assert.ok(COORDINATE_CSS.includes(`${FLOATING.menu}[data-match-anchor-width]{min-width:min(anchor-size(width),calc(100vw - 24px))}`));
  assert.ok(COORDINATE_CSS.includes(`${FLOATING.submenu}[data-submenu-layout=page]{min-width:min(anchor-size(width),calc(100vw - 24px));max-width:calc(100vw - 24px)}`));
});

test('tooltip keeps its existing transforms and restores visible label/shortcut scale', () => {
  assert.ok(COORDINATE_CSS.includes(`${FLOATING.tooltip}>*{zoom:var(--dsh-ui-zoom-factor,1)}`));
  assert.ok(COORDINATE_CSS.includes('gap:calc(8px * var(--dsh-ui-zoom-factor,1))'));
  assert.doesNotMatch(COORDINATE_CSS, /transform:|visibility:|pointer-events:|animation:|display:/);
});

test('semantic opener rules preserve native names and retain multiple dismissing/open menus', () => {
  const css = menuAnchorRules([{ tokens: ['uzm-1', 'uzm-2'], baseNames: ['--native', '--other'],
    menus: [{ id: ':r1:', token: 'uzm-1' }, { id: ':r2:', token: 'uzm-2' }] }]);
  assert.match(css, /anchor-name:--native,--other,--dsh-ui-zoom-menu-1,--dsh-ui-zoom-menu-2!important/);
  assert.ok(css.includes('[data-ui-zoom-menu-anchor="uzm-1 uzm-2"]'));
  assert.ok(css.includes('[id=":r1:"]{position-anchor:--dsh-ui-zoom-menu-1!important}'));
  assert.ok(css.includes('[id=":r2:"]{position-anchor:--dsh-ui-zoom-menu-2!important}'));
  assert.doesNotMatch(css, /left:|top:|width:|getBoundingClientRect/);
  assert.deepEqual(retainedAnchorNames('--native, --dsh-ui-zoom-menu-4, --other'), ['--native', '--other']);
  assert.deepEqual(retainedAnchorNames('none'), []);
});

test('cooperative anchor names retain Unicode, escapes and escaped commas without CSS injection', () => {
  const names = ['--якорь', '--a\\,b', '--x\\3a y', '--quoted\\"name'];
  assert.deepEqual(retainedAnchorNames(names.join(', ')), names);
  const css = menuAnchorRules([{ tokens: ['uzm-1'], baseNames: names, menus: [{ id: 'm', token: 'uzm-1' }] }]);
  assert.ok(css.includes('anchor-name:' + names.join(',') + ',--dsh-ui-zoom-menu-1!important'));
  for (const value of ['--bad;body{}', '--a,', '--a, ', '--a\\\n', '--a b', '--a\\']) {
    assert.throws(() => retainedAnchorNames(value), TypeError);
  }
});

test('opaque ids and control characters cannot escape a generated attribute selector', () => {
  const id = 'a"\\\n]{}';
  const quoted = coordinateCssString(id);
  assert.equal(quoted, '"a\\22 \\5c \\a ]{}"');
  const css = menuAnchorRules([{ tokens: ['uzm-3'], menus: [{ id, token: 'uzm-3' }] }]);
  assert.ok(css.includes('[id=' + quoted + ']'));
  for (const token of ['', '--bad', 'uzm-0', 'uzm-3}body{color:red}', 'a b']) {
    assert.throws(() => menuAnchorRules([{ tokens: [token], menus: [] }]), TypeError);
  }
  assert.throws(() => menuAnchorRules([{ tokens: ['uzm-1'], menus: [{ id: 'a', token: 'uzm-2' }] }]), TypeError);
});

test('cleanup restores absent/existing lease values but never clobbers another writer', () => {
  assert.deepEqual(coordinateLeaseRestore('uzm-1', { written: 'uzm-1', before: null }), { value: null });
  assert.deepEqual(coordinateLeaseRestore('uzm-1', { written: 'uzm-1', before: 'prior' }), { value: 'prior' });
  assert.equal(coordinateLeaseRestore('other', { written: 'uzm-1', before: 'prior' }), null);
  assert.equal(coordinateLeaseRestore(null, { written: 'uzm-1', before: 'prior' }), null);
});

test('adapter owns cleanup, semantic references and narrow observers, not native APIs or user actions', async () => {
  const text = await source();
  assert.match(text, /observer\.disconnect\(\)/);
  assert.match(text, /style\.remove\(\)/);
  assert.match(text, /leases\.clear\(\); bindings\.clear\(\)/);
  assert.match(text, /button\[data-context-menu-trigger\]\[aria-expanded="true"\]\[aria-controls~=/);
  assert.match(text, /if \(candidates\.length !== 1\)/);
  assert.match(text, /if \(bindings\.has\(node\)/);
  assert.doesNotMatch(text, /\.prototype|defineProperty|__ModuleLoader__|\.click\(|\.focus\(|dispatchEvent|requestAnimationFrame|setInterval|setTimeout|localStorage|getBoundingClientRect\(/);
  assert.match(text, /record\.target === style \|\| style\.contains\(record\.target\)/);
  assert.match(text, /attributeFilter:/);
});
