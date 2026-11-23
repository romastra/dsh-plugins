import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWorkspaceColorBridge, EMPTY_WORKSPACE_COLORS, workspaceColor, workspaceTintStyle, WORKSPACE_TINT_CSS } from '../src/workspace-tint.js';
import { readWorkspaceMembership, readCardMeta } from '../src/card-meta.js';
import { readCandidates } from '../src/adapter.js';

// Only ordinary immutable data and callbacks: no React/DOM/layout renderer.
const snapshot = (colors = {}, revision = 0, generation = '') => Object.freeze({ generation, revision, colors: Object.freeze(colors) });
function source(initial = snapshot()) {
  let value = initial, removals = 0;
  const listeners = new Set(), callbacks = [];
  return {
    getSnapshot: () => value,
    subscribe(fn) { listeners.add(fn); callbacks.push(fn); return () => { removals++; listeners.delete(fn); }; },
    set(next) { value = next; for (const fn of [...listeners]) fn(); },
    callbacks, get size() { return listeners.size; }, get removals() { return removals; },
  };
}

test('without a provider the bridge is stable, immutable and has no tint', () => {
  const bridge = createWorkspaceColorBridge();
  assert.equal(bridge.getSnapshot(), EMPTY_WORKSPACE_COLORS);
  assert.equal(bridge.getSnapshot(), bridge.getSnapshot());
  assert.equal(workspaceColor(bridge.getSnapshot(), 'default'), null);
  assert.equal(Object.isFrozen(bridge.getSnapshot()), true);
  assert.equal(Object.isFrozen(bridge.getSnapshot().colors), true);
  bridge.dispose();
});

test('the initial empty-generation provider is active and repeated snapshots do not publish', () => {
  const bridge = createWorkspaceColorBridge(), provider = source(); let notifications = 0;
  bridge.subscribe(() => notifications++);
  bridge.connect(provider);
  assert.deepEqual(bridge.getSnapshot(), { active: true, generation: '', revision: 0, colors: {} });
  const before = bridge.getSnapshot(); provider.set(provider.getSnapshot()); provider.set(snapshot());
  assert.equal(bridge.getSnapshot(), before); assert.equal(notifications, 1);
  bridge.dispose(); assert.equal(notifications, 2);
});

test('hex colors are copied into immutable snapshots without consulting palette indices', () => {
  const bridge = createWorkspaceColorBridge(), provider = source(snapshot({ workspace: '#A0b1C2' }, 3, 'host'));
  bridge.connect(provider); const value = bridge.getSnapshot();
  assert.equal(workspaceColor(value, 'workspace'), '#a0b1c2');
  assert.notEqual(value.colors, provider.getSnapshot().colors);
  assert.equal(Object.isFrozen(value), true); assert.equal(Object.isFrozen(value.colors), true);
  assert.throws(() => { value.colors.workspace = '#ffffff'; }, TypeError);
  provider.set(snapshot({ workspace: '#112233', other: '#445566' }, 4, 'host'));
  assert.equal(workspaceColor(bridge.getSnapshot(), 'workspace'), '#112233');
  assert.equal(workspaceColor(value, 'workspace'), '#a0b1c2', 'previous snapshot stays immutable');
  bridge.dispose();
});

test('color removal and a new generation replace old colors without retaining a stale tint', () => {
  const bridge = createWorkspaceColorBridge(), provider = source(snapshot({ a: '#123456', b: '#abcdef' }, 4, 'old'));
  bridge.connect(provider); provider.set(snapshot({ b: '#abcdef' }, 5, 'old'));
  assert.equal(workspaceColor(bridge.getSnapshot(), 'a'), null);
  provider.set(snapshot({}, 0, 'new'));
  assert.deepEqual(bridge.getSnapshot(), { active: true, generation: 'new', revision: 0, colors: {} });
  bridge.dispose();
});

test('provider detach empties the bridge and old queued notifications cannot restore it', () => {
  const bridge = createWorkspaceColorBridge(), provider = source(snapshot({ a: '#123456' }));
  const off = bridge.connect(provider); assert.equal(provider.size, 1);
  off(); off(); assert.equal(provider.removals, 1); assert.equal(provider.size, 0);
  provider.callbacks[0](); assert.equal(bridge.getSnapshot(), EMPTY_WORKSPACE_COLORS);
  assert.equal(workspaceColor(bridge.getSnapshot(), 'a'), null); bridge.dispose();
});

test('late activation/replacement survives an older scope cleanup and stale callbacks', () => {
  const bridge = createWorkspaceColorBridge(), first = source(snapshot({ a: '#112233' })), second = source(snapshot({ a: '#445566' }));
  const oldOff = bridge.connect(first); bridge.connect(second);
  assert.equal(first.size, 0); assert.equal(second.size, 1);
  oldOff(); first.callbacks[0]();
  assert.equal(workspaceColor(bridge.getSnapshot(), 'a'), '#445566');
  bridge.dispose(); assert.equal(second.removals, 1);
});

test('provider changes during subscription are captured without polling or timers', () => {
  const bridge = createWorkspaceColorBridge(); let value = snapshot({ a: '#112233' });
  bridge.connect({ getSnapshot: () => value, subscribe() { value = snapshot({ a: '#445566' }, 1); return () => {}; } });
  assert.equal(workspaceColor(bridge.getSnapshot(), 'a'), '#445566'); bridge.dispose();
});

test('invalid/unavailable provider snapshots clear old tint and can recover on notification', () => {
  const invalid = [undefined, null, [], {}, { generation: 1, revision: 0, colors: {} },
    { generation: '', revision: -1, colors: {} }, { generation: '', revision: 0.5, colors: {} },
    { generation: '', revision: Infinity, colors: {} }, { generation: '', revision: 0, colors: [] }];
  const bridge = createWorkspaceColorBridge(), provider = source(snapshot({ a: '#123456' }));
  bridge.connect(provider);
  for (const value of invalid) {
    provider.set(value); assert.equal(bridge.getSnapshot(), EMPTY_WORKSPACE_COLORS);
    provider.set(snapshot({ a: '#123456' })); assert.equal(workspaceColor(bridge.getSnapshot(), 'a'), '#123456');
  }
  bridge.dispose();
});

test('a throwing read fails closed but a later provider notification recovers', () => {
  const bridge = createWorkspaceColorBridge(), provider = source(snapshot({ a: '#123456' }));
  const read = provider.getSnapshot; let failed = false;
  provider.getSnapshot = () => { if (failed) throw new Error('retired'); return read(); };
  bridge.connect(provider); failed = true; provider.callbacks[0]();
  assert.equal(bridge.getSnapshot(), EMPTY_WORKSPACE_COLORS);
  failed = false; provider.callbacks[0](); assert.equal(workspaceColor(bridge.getSnapshot(), 'a'), '#123456');
  bridge.dispose();
});

test('missing, malformed or throwing optional services cannot break the switcher', () => {
  const bridge = createWorkspaceColorBridge();
  for (const provider of [null, {}, { getSnapshot: () => snapshot() },
    { getSnapshot: () => snapshot({ a: '#123456' }), subscribe() { throw new Error('unavailable'); } },
    { getSnapshot: () => snapshot(), subscribe() {} }]) {
    assert.doesNotThrow(() => bridge.connect(provider)); assert.equal(bridge.getSnapshot(), EMPTY_WORKSPACE_COLORS);
  }
  bridge.connect({ getSnapshot: () => snapshot({ a: '#123456' }), subscribe: () => () => { throw new Error('already disposed'); } });
  assert.doesNotThrow(() => bridge.dispose()); assert.equal(bridge.getSnapshot(), EMPTY_WORKSPACE_COLORS);
});

test('dispose and subscriber cleanup are idempotent and no provider can reconnect afterward', () => {
  const bridge = createWorkspaceColorBridge(), provider = source(); let calls = 0;
  const off = bridge.subscribe(() => calls++); off(); off(); bridge.connect(provider); assert.equal(calls, 0);
  bridge.dispose(); bridge.dispose(); assert.equal(provider.removals, 1);
  bridge.connect(provider); provider.callbacks[0](); assert.equal(provider.size, 0);
  assert.equal(bridge.getSnapshot(), EMPTY_WORKSPACE_COLORS);
});

test('only own explicit six-digit hex strings are accepted, including safe arbitrary ids', () => {
  const colors = Object.assign(Object.create({ inherited: '#112233' }), { valid: '#abcdef', index: 8, name: 'red', shorthand: '#abc', alpha: '#11223344', css: '#123456;}body{display:none', variable: 'var(--foreign)', empty: null });
  Object.defineProperty(colors, '__proto__', { value: '#102030', enumerable: true });
  const bridge = createWorkspaceColorBridge(); bridge.connect(source({ generation: '', revision: 0, colors }));
  assert.deepEqual(Object.keys(bridge.getSnapshot().colors).sort(), ['__proto__', 'valid']);
  for (const id of ['inherited', 'index', 'name', 'shorthand', 'alpha', 'css', 'variable', 'empty', 'toString', 'constructor', null, '']) assert.equal(workspaceColor(bridge.getSnapshot(), id), null);
  assert.equal(workspaceColor(bridge.getSnapshot(), '__proto__'), '#102030'); bridge.dispose();
});

test('Workspace identity comes only from the first native sessionIds membership, never paths or titles', () => {
  const items = [{ workspaceId: 'w-z', title: 'Same name', path: 'C:/same', sessionIds: ['a'] },
    { workspaceId: 'w-a', title: 'Same name', path: 'C:/same', sessionIds: ['a', 'b'] }];
  assert.deepEqual(readWorkspaceMembership({ items }, 'a'), { workspaceId: 'w-z', workspaceTitle: 'Same name' });
  assert.equal(readWorkspaceMembership({ items }, 'b').workspaceId, 'w-a');
  assert.equal(readWorkspaceMembership({ items }, 'missing').workspaceId, null);
  for (const id of [undefined, null, '', 1]) assert.equal(readWorkspaceMembership({ items: [{ workspaceId: 'invalid', sessionIds: [id] }] }, id).workspaceId, null);
  for (const workspaceId of [undefined, null, '', 7]) assert.equal(readWorkspaceMembership({ items: [{ workspaceId, sessionIds: ['a'] }, ...items] }, 'a').workspaceId, null);
});

test('candidate and card metadata agree on canonical Workspace ids; stale raw ids are overwritten', () => {
  const rows = { a: { id: 'a', workspaceId: 'wrong', cwd: 'C:/wrong' }, b: { id: 'b', workspaceId: 'w', cwd: 'C:/same' }, c: { id: 'c', workspaceId: 'w', cwd: 'C:/same' } };
  const sessionSnapshot = { ids: ['a', 'b', 'c'], byId: rows };
  const workspaceSnapshot = { pinnedSessionIds: ['a', 'b', 'c'], items: [{ workspaceId: 'w', title: 'Same', path: 'C:/same', sessionIds: ['a'] }, { workspaceId: 'other', title: 'Same', path: 'C:/same', sessionIds: ['b'] }] };
  const candidates = readCandidates({ list: { getSnapshot: () => sessionSnapshot } }, { list: { getSnapshot: () => workspaceSnapshot } });
  const meta = readCardMeta(sessionSnapshot, workspaceSnapshot, ['a', 'b', 'c', 'ghost']);
  assert.deepEqual(candidates.map(row => row.workspaceId), ['w', 'other', null]);
  assert.deepEqual(candidates.map(row => meta.get(row.id).workspaceId), ['w', 'other', null]);
  assert.equal(meta.get('ghost').workspaceId, null); assert.equal(rows.a.workspaceId, 'wrong');
  workspaceSnapshot.items = [{ workspaceId: 'moved', title: 'New', sessionIds: ['a'] }];
  assert.equal(readCardMeta(sessionSnapshot, workspaceSnapshot, ['a']).get('a').workspaceId, 'moved');
});

test('card tint style contains only one custom property and invalid colors produce no style', () => {
  assert.deepEqual(workspaceTintStyle('#123456'), { '--cs-workspace-color': '#123456' });
  for (const value of [null, undefined, 8, 'red', 'var(--foreign)', '#123456;color:red', '#abc']) assert.equal(workspaceTintStyle(value), undefined);
});

test('tint CSS preserves mosaic, other text and selected border rules with only the scoped Workspace caption exception', () => {
  assert.match(WORKSPACE_TINT_CSS, /\.cs-card\[data-cs-workspace-tinted=true\]\{background:color-mix\(in srgb,var\(--cs-workspace-color\) 18%,var\(--dsw-alias-bg-layer-2/);
  assert.match(WORKSPACE_TINT_CSS, /@media\(hover:hover\)/);
  assert.match(WORKSPACE_TINT_CSS, /:hover\{background:color-mix\([^\n]+24%/);
  assert.match(WORKSPACE_TINT_CSS, /:focus-visible\{outline:2px solid var\(--dsw-alias-brand-primary\)/);
  const captionRule = '.cs-card[data-cs-workspace-tinted=true] .cs-workspace-name{color:var(--dsw-alias-label-primary)}';
  assert.equal(WORKSPACE_TINT_CSS.split(captionRule).length, 2, 'exactly one foreground exception, only for the tinted Workspace caption');
  assert.doesNotMatch(WORKSPACE_TINT_CSS.replace(captionRule, ''), /(?:^|[;{])\s*(?:color|opacity|filter|transform|font[^:;{]*|border(?:-color)?|pointer-events|touch-action)\s*:/m);
  assert.doesNotMatch(WORKSPACE_TINT_CSS, /\.cs-(?:preview|mosaic|state|active-task|tension|curtain)|aria-selected|--dsw-static-/);
  assert.doesNotMatch(WORKSPACE_TINT_CSS, /var\(--dsw-alias-[^)]*,/, 'neutral container uses native tokens without a literal-color fallback');
});

test('Client wiring keeps the source optional, local to owned card props, and diagnostics aggregate', () => {
  const client = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8');
  const inject = client.match(/return \{\s*inject: \[([^\]]+)\]/)?.[1];
  assert.ok(inject); assert.doesNotMatch(inject, /workspaceColorSource/);
  assert.match(client, /ctx\.inject\?\.\(\['workspaceColorSource'\], scope =>/);
  assert.match(client, /scope\.effect\(\(\) => workspaceColors\.connect\(scope\.get\('workspaceColorSource'\)\)/);
  assert.match(client, /ctx\.effect\(\(\) => \(\) => workspaceColors\.dispose\(\)\)/);
  assert.match(client, /'data-workspace-id': workspaceId \?\? undefined/);
  assert.match(client, /style: workspaceTintStyle\(color\)/);
  for (const field of ['workspaceColorSourceActive', 'workspaceTintedCandidates', 'mountedWorkspaceTintedCards', 'workspaceTintComputedBackgrounds', 'workspaceTintSupported']) assert.ok(client.includes(field + ':'));
  const bridge = readFileSync(new URL('../src/workspace-tint.js', import.meta.url), 'utf8');
  assert.doesNotMatch(bridge, /getComputedStyle|document\.|window\.|localStorage|setTimeout|setInterval|rpc\.|fetch\(/);
});

test('package exports a fresh versioned Client artifact built from the current source modules', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.version, '1.16.1'); assert.equal(manifest.exports['./client'], './client-v1.16.1.js');
  assert.ok(manifest.files.includes('client-v1.16.1.js')); assert.ok(!manifest.files.includes('client.js'));
  assert.equal(manifest.dsh.client.inject.includes('@local/workspace-colors'), false);
  const build = readFileSync(new URL('../build.mjs', import.meta.url), 'utf8');
  const names = [...build.match(/for \(const name of \[([^\]]+)\]/)[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  const joined = names.map(name => readFileSync(new URL('../src/' + name + '.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '') + '\n').join('');
  const deployed = readFileSync(new URL('../client-v1.16.1.js', import.meta.url), 'utf8');
  assert.equal(deployed, '// Generated by build.mjs.\nwindow.__ModuleLoader__.load({id: \'@local/chat-switcher\', factory(require) {\n' + joined + '\nreturn createPlugin(require(\'react\'));\n}});\n');
});
