import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');

test('manifest runtime/display exports exist and all locales describe the new slider', async () => {
  const manifest = JSON.parse(await read('package.json'));
  assert.equal(manifest.name, '@local/ui-zoom');
  assert.equal(manifest.version, '1.5.0');
  assert.equal(manifest.exports['.'], './index-v4.js');
  assert.equal(manifest.exports['./client'], './client-v6.js');
  assert.equal(manifest.scripts.postinstall, undefined);
  for (const path of ['index-v4.js', 'client-v6.js', 'cordis.patch.yml', 'icon.svg', 'README.md', 'locale/en.json', 'locale/ru.json', 'locale/zh.json']) {
    assert.ok((await stat(new URL(path, root))).isFile(), path);
  }
  for (const locale of ['en', 'ru', 'zh']) {
    const { meta } = JSON.parse(await read(`locale/${locale}.json`));
    assert.ok(meta.title && meta.description);
    assert.equal(meta.detail, undefined);
    assert.match(meta.description, /30%/);
  }
});

test('generated Client factory remains lazy with React as the only runtime import', async () => {
  const source = await read('client-v6.js');
  const registrations = [];
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: definition => registrations.push(definition) } } });
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].id, '@local/ui-zoom');
  const required = [];
  const plugin = registrations[0].factory(name => { required.push(name); return {}; });
  assert.deepEqual(required, ['react']);
  assert.equal(typeof plugin.apply, 'function');
  assert.doesNotMatch(source, /getSnapshot\?\.\(\)\.recording|document\.body\.append|documentElement\.style|fontSize\.increase/);
  assert.match(source, /document\.addEventListener\('keydown', onKeyDown\)/);
  assert.match(source, /document\.removeEventListener\('keydown', onKeyDown\)/);
});

test('toolbar has exactly one plain magnifier and controls the shared popup', async () => {
  const source = await read('src/client.js');
  const toolbar = source.slice(source.indexOf('function Toolbar()'), source.indexOf('function SettingsRow()'));
  const glyph = source.slice(source.indexOf('function ZoomGlyph()'), source.indexOf('function Toolbar()'));
  assert.equal((toolbar.match(/h\('button'/g) ?? []).length, 1);
  assert.match(toolbar, /'aria-haspopup': 'dialog', 'aria-expanded': view\.open, 'aria-controls': PANEL_ID/);
  assert.match(toolbar, /popup\.toggle\(event\.currentTarget\)/);
  assert.match(toolbar, /popup\.detach\(element\)/);
  assert.match(source, /name: 'conversation\.session\.header\.utilities', id: 'local\.ui-zoom\.toolbar:1\.5\.0'/);
  assert.match(glyph, /fill: 'none', stroke: 'currentColor'/);
  assert.match(glyph, /h\('circle'/);
  assert.doesNotMatch(glyph, /M7\.25|strokeWidth: 2\.9|foreignObject|image|#[0-9a-f]{3,8}/i);
});

test('popup uses inverse zoom, physical viewport geometry and accessible vertical slider semantics', async () => {
  const source = await read('src/client.js');
  assert.match(source, /sliderGeometry\(viewport\.height\)/);
  assert.match(source, /zoom: inverseZoom\(state\.percent\)/);
  assert.match(source, /position:fixed/);
  assert.match(source, /role: 'slider'/);
  assert.match(source, /'aria-orientation': 'vertical'/);
  assert.match(source, /'aria-valuenow': state\.percent/);
  assert.match(source, /onPointerDown: startDrag, onPointerMove: moveDrag, onPointerUp: finishDrag/);
  assert.match(source, /onPointerCancel: finishDrag, onLostPointerCapture: finishDrag/);
  assert.match(source, /controller\.preview\(positionToPercent\(value\)\)/);
  assert.match(source, /controller\.commit\(\)/);
  assert.match(source, /position: neutralPosition/);
  assert.match(source, /thumbGrabOffset\(event\.clientY, currentCenter, geometry\.hit\)/);
  assert.match(source, /prefers-reduced-motion/);
  for (const [target, type, name, capture] of [
    ['window', 'resize', 'resize', ''], ['window', 'blur', 'blur', ''],
    ['document', 'pointerdown', 'outside', ', true'], ['document', 'focusin', 'outside', ''], ['document', 'keydown', 'escape', ', true'],
  ]) {
    assert.ok(source.includes(`${target}.addEventListener('${type}', ${name}${capture})`));
    assert.ok(source.includes(`${target}.removeEventListener('${type}', ${name}${capture})`));
  }
});

test('movable circle and fixed labels use distinct shapes and separate pointer regions', async () => {
  const source = await read('src/client.js');
  assert.doesNotMatch(source, /dsh-ui-zoom-neutral|dsh-ui-zoom-snap/);
  assert.match(source, /\.dsh-ui-zoom-thumb[^\n]+border:2px solid var\(--dsw-alias-label-primary\)/);
  assert.match(source, /\.dsh-ui-zoom-thumb[^\n]+background:var\(--dsw-alias-bg-overlay\)/);
  assert.match(source, /className: 'dsh-ui-zoom-grip'/);
  assert.match(source, /className: 'dsh-ui-zoom-references', 'aria-hidden': true/);
  assert.match(source, /\.dsh-ui-zoom-references[^\n]+pointer-events:none/);
  assert.match(source, /style: \{ width: geometry\.hit \}/);
  assert.match(source, /height: geometry\.length \+ geometry\.hit/);
  assert.match(source, /top: geometry\.hit \/ 2, height: geometry\.length/);
  assert.match(source, /geometry\.hit \/ 2 \+ 8/);
  const labelStart = source.indexOf("].map(mark =>");
  const labelEnd = source.indexOf("}, t('resetShort')");
  assert.ok(labelStart > 0 && labelEnd > labelStart);
  const labels = source.slice(labelStart, labelEnd);
  assert.doesNotMatch(labels, /onPointerDown|onPointerMove|role: 'slider'/);
  assert.match(source, /'aria-describedby': `\$\{PANEL_ID\}-hint`/);
  assert.match(source, /\.dsh-ui-zoom-popup-head[^\n]+height:44px/);
  assert.match(source, /\.dsh-ui-zoom-popup-reset[^\n]+height:44px/);
  assert.match(source, /t\('resetShort'\)/);
  assert.match(source, /maxHeight: visibleHeight/);
  assert.match(source, /\.dsh-ui-zoom-popup[^\n]+overflow-y:auto/);
});

test('zoom is exclusively browser-local, with no global Host Config, tool or settings transport', async () => {
  const host = await read('index-v4.js');
  const source = await read('src/client.js');
  const manifest = JSON.parse(await read('package.json'));
  assert.match(host, /export function apply\(\) \{\}/);
  assert.doesNotMatch(host, /export const Config|ctx\.|tools\.register|import /);
  assert.doesNotMatch(source, /configForms|ctx\.remote|ctx\.settings|configEditor/);
  assert.match(source, /inject: \['slots', 'locale', 'shortcuts'\]/);
  assert.match(source, /getStorage: \(\) => window\.localStorage/);
  assert.match(source, /preference\.dispose\(\)/);
  assert.equal(manifest.peerDependencies, undefined);
  assert.ok(!manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'));
});

test('diagnostics are read-only and report the answering browser without changing local storage', async () => {
  const source = await read('src/client.js');
  const diagnostics = source.slice(source.indexOf("ctx.inject(['cordisInspect']"), source.indexOf('const useZoom'));
  assert.match(diagnostics, /id: 'UiZoom'/);
  assert.match(diagnostics, /name: 'status'/);
  assert.match(diagnostics, /scope: 'browser-origin', storage: 'localStorage'/);
  assert.match(diagnostics, /origin: window\.location\.origin/);
  assert.doesNotMatch(diagnostics, /\.set\(|setItem|\.preview\(|controller\.change/);
});
