import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PALETTE, workspaceColorRules, cssString } from '../palette.js';
import { createWorkspaceColorService, createColorRoute, ENDPOINT } from '../service.js';
import { createColorMenu } from '../src/menu.js';
import { COPY } from '../src/copy.js';
import { createColorStore } from '../src/store.js';

function fixture(options = {}) {
  const records = options.records ?? new Map();
  const rows = new Map([['a', { id: 'a', title: 'Same title', path: '/a' }], ['b', { id: 'b', title: 'Same title', path: '/b' }]]);
  let writes = 0;
  const table = { get: id => records.get(id), async put(id, value) { writes++; records.set(id, value); }, async delete(id) { writes++; return records.delete(id); }, ...options.table };
  const registry = { get: id => rows.get(id), list: () => [...rows.values()] };
  const service = createWorkspaceColorService({ generation: 'test-generation', ...options, table, registry });
  return { service, records, rows, registry, writes: () => writes };
}
const translate = language => (key, values = {}) => (COPY[language][key] ?? key).replace(/\{(\w+)\}/g, (_, name) => values[name] ?? '');
const snapshot = (revision, colors = {}) => ({ generation: 'g', revision, colors });

for (const language of ['en', 'ru']) test(`menu: 15 swatches, reset, selected choice and captured Workspace (${language})`, async () => {
  const calls = [];
  const menu = createColorMenu({ workspaceId: 'a', current: 4, t: translate(language), save: async value => calls.push(value) });
  assert.equal(menu.length, 1);
  const children = menu[0].children;
  assert.equal(children.length, 16);
  assert.equal(new Set(children.map(row => row.id)).size, 16);
  assert.match(children[4].label, /^✓ /);
  assert.equal(children.filter(row => row.label.startsWith('✓')).length, 1);
  await children[7].run(); await children[0].run();
  assert.deepEqual(calls, [{ workspaceId: 'a', color: 7, expectedColor: 4 }, { workspaceId: 'a', color: null, expectedColor: 4 }]);
});

test('exact MSX values, transparent reset, no second black', () => {
  assert.deepEqual(PALETTE.map(row => row.hex), ['#010101','#3eb849','#74d07d','#5955e0','#8076f1','#b95e51','#65dbef','#db6559','#ff897d','#ccc35e','#ded087','#3aa241','#b766b5','#cccccc','#ffffff']);
  assert.deepEqual(PALETTE.map(row => row.index), Array.from({ length: 15 }, (_, i) => i + 1));
  assert.deepEqual(Object.keys(COPY.en).sort(), Object.keys(COPY.ru).sort());
});

test('safe ID-specific CSS, no geometry/text/hover overrides; null means no styling', () => {
  const rules = workspaceColorRules({ a: 7, b: null, c: 0, d: 16 });
  assert.match(rules, /\[data-sidebar-list-area\] \[data-row-key="workspace:a"\]/);
  assert.match(rules, /#65dbef/); assert.match(rules, /12%/);
  assert.doesNotMatch(rules, /(?:^|[;{])(?:color|background|padding|outline|border|position):/);
  assert.equal(workspaceColorRules({ a: null }), '');
  const injection = workspaceColorRules({ ['\"]{}<style>\\\n']: 3 });
  assert.doesNotMatch(injection, /<style>|\n/);
  assert.equal(cssString('a"\\\n'), '"a\\22 \\5c \\a "');
});

test('all 15 colors can be set and removed without changing another same-named Workspace', async () => {
  const f = fixture();
  for (const color of PALETTE) {
    const result = await f.service.operate({ action: 'set', workspaceId: 'a', color: color.index });
    assert.equal(result.color, color.index);
    assert.equal(f.service.list().workspaces.find(row => row.workspaceId === 'b').color, null);
  }
  await f.service.operate({ action: 'set', workspaceId: 'b', color: 13 });
  await f.service.operate({ action: 'set', workspaceId: 'a', color: null });
  assert.deepEqual(f.service.snapshot().colors, { b: 13 });
  await f.service.close();
});

test('new service generation reads retained records; rename/order do not key colors', async () => {
  const f = fixture();
  await f.service.operate({ action: 'set', workspaceId: 'a', color: 12 });
  await f.service.close();
  const reopened = fixture({ records: f.records, generation: 'new-generation' });
  reopened.rows.get('a').title = 'Renamed';
  assert.deepEqual(reopened.service.snapshot().colors, { a: 12 });
  assert.equal(reopened.service.list().workspaces[0].color, 12);
  reopened.rows.delete('a');
  assert.deepEqual(reopened.service.snapshot().colors, {});
  await reopened.service.close();
});

test('compare-and-set serializes concurrent writes and no-op does not write', async () => {
  const f = fixture();
  const result = await Promise.allSettled([
    f.service.operate({ action: 'set', workspaceId: 'a', color: 2, expectedColor: null }),
    f.service.operate({ action: 'set', workspaceId: 'a', color: 3, expectedColor: null }),
  ]);
  assert.equal(result[0].status, 'fulfilled'); assert.equal(result[1].reason.code, 'conflict');
  assert.equal(f.service.snapshot().revision, 1);
  assert.equal((await f.service.operate({ action: 'set', workspaceId: 'a', color: 2 })).changed, false);
  assert.equal(f.writes(), 1); await f.service.close();
});

test('invalid colors, missing Workspaces and unknown fields do not write', async () => {
  const f = fixture();
  for (const color of [0, 16, -1, 1.5, '7', undefined]) await assert.rejects(f.service.operate({ action: 'set', workspaceId: 'a', color }), { code: 'invalid-request' });
  await assert.rejects(f.service.operate({ action: 'set', workspaceId: 'missing', color: 7 }), { code: 'workspace-not-found' });
  await assert.rejects(f.service.operate({ action: 'list', extra: true }), { code: 'invalid-request' });
  await assert.rejects(f.service.operate({ action: 'watch' }), { code: 'invalid-request' });
  assert.equal(f.writes(), 0); await f.service.close();
});

test('storage failure leaves previous colors and revision untouched', async () => {
  const f = fixture({ table: { async put() { throw new Error('disk unavailable'); } } });
  await assert.rejects(f.service.operate({ action: 'set', workspaceId: 'a', color: 2 }), { code: 'storage-unavailable' });
  assert.deepEqual(f.service.snapshot().colors, {}); assert.equal(f.service.snapshot().revision, 0);
  await f.service.close();
});

test('watch publishes only after durable save and releases its waiters', async () => {
  let commit;
  const records = new Map();
  const f = fixture({ records, table: { async put(id, value) { await new Promise(resolve => { commit = resolve; }); records.set(id, value); } } });
  const first = await f.service.operate({ action: 'watch' }, { internal: true });
  const waiting = f.service.operate({ action: 'watch', generation: first.generation, revision: first.revision }, { internal: true });
  const save = f.service.operate({ action: 'set', workspaceId: 'a', color: 7 });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.service.status().waitingClients, 1); assert.equal(f.service.snapshot().revision, 0);
  commit(); await save;
  assert.deepEqual((await waiting).colors, { a: 7 }); assert.equal(f.service.status().waitingClients, 0);
  await f.service.close();
});

test('aborted watch and unload release every timer and waiter', async () => {
  const f = fixture(); const control = new AbortController();
  const waiting = f.service.operate({ action: 'watch', generation: 'test-generation', revision: 0 }, { internal: true, signal: control.signal });
  control.abort(); await assert.rejects(waiting); assert.equal(f.service.status().waitingClients, 0);
  const unloadWait = f.service.operate({ action: 'watch', generation: 'test-generation', revision: 0 }, { internal: true });
  const settled = assert.rejects(unloadWait, { code: 'unavailable' });
  await f.service.close(); await settled; assert.equal(f.service.status().waitingClients, 0);
});

test('UI route and agent operation share state, return values and explicit failures', async () => {
  const f = fixture(); const route = createColorRoute(f.service);
  const request = payload => new Request(`https://example.invalid/api/${ENDPOINT}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'correlated', method: ENDPOINT, payload }) });
  const result = await (await route.fetch(request({ action: 'set', workspaceId: 'a', color: 7, expectedColor: null }))).json();
  assert.equal(result.rpcId, 'correlated'); assert.equal(result.result.ok, true);
  assert.deepEqual(result.result.value.snapshot, f.service.snapshot());
  assert.equal((await f.service.operate({ action: 'list' })).workspaces[0].color, 7);
  const refused = await (await route.fetch(request({ action: 'set', workspaceId: 'a', color: 3, expectedColor: null }))).json();
  assert.equal(refused.result.error.code, 'conflict');
  assert.equal((await route.fetch(new Request('https://example.invalid', { method: 'POST' }))).status, 415);
  assert.equal((await route.fetch(new Request('https://example.invalid', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' }))).status, 400);
  await f.service.close();
});

test('Client store ignores stale same-generation replies and publishes only changes', async () => {
  const store = createColorStore({ call: async () => snapshot(3, { a: 7 }) });
  let changed = 0; store.subscribe(() => changed++);
  store.accept(snapshot(3, { a: 7 })); store.accept(snapshot(2, { a: 3 })); store.accept(snapshot(3, { a: 7 }));
  assert.equal(store.getSnapshot().colors.a, 7); assert.equal(changed, 1);
  store.accept({ generation: 'new-host', revision: 0, colors: { a: 3 } });
  assert.equal(store.getSnapshot().colors.a, 3); assert.equal(changed, 2); await store.dispose();
});

test('Client long poll is cancelled on disposal, with no DOM/React emulation', async () => {
  let cancelled = false;
  const store = createColorStore({ call: (_payload, signal) => new Promise((_, reject) => { signal.addEventListener('abort', () => { cancelled = true; reject(new Error('abort')); }, { once: true }); }) });
  store.start(); await store.dispose(); assert.equal(cancelled, true);
});

test('manifest metadata and installed resources are complete and local', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.engines.dsh, '0.2.2-rc.3 || 0.2.2-rc.5');
  for (const file of ['host-v2.js', 'client-v3.js', 'cordis.patch.yml', 'icon.svg', 'locale/en.json', 'locale/ru.json']) assert.ok((await readFile(new URL(`../${file}`, import.meta.url))).length > 0);
  for (const language of ['en', 'ru']) {
    const locale = JSON.parse(await readFile(new URL(`../locale/${language}.json`, import.meta.url), 'utf8'));
    assert.ok(locale.meta.title); assert.ok(locale.meta.description.includes('MSX'));
  }
  const client = await readFile(new URL('../client-v3.js', import.meta.url), 'utf8');
  // The real icon Slot owner passes { icon: { key, src } }, not a root src.
  assert.match(client, /function Swatch\(\{ icon \}\)/);
  assert.match(client, /String\(item.index\) === icon\?\.src/);
  assert.doesNotMatch(client, /function Swatch\(\{ src \}\)/);
  assert.deepEqual([...client.matchAll(/require\('([^']+)'\)/g)].map(match => match[1]), ['react']);
  assert.doesNotMatch(client, /appendChild|MutationObserver|localStorage|setInterval/);
});
