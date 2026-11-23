import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The entry normally resolves peers through DSH's profile module loader.
// Exercise its real apply body without importing the installation's peers.
const source = readFileSync(new URL('./index-v9.js', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('export async function apply'));
const fluent = new Proxy(() => {}, { get: () => fluent, apply: () => fluent });
function fixture({ failState = false, failDrain = false } = {}) {
  const effects = [], order = [], specs = [];
  const table = {};
  const shared = { async dispose() { order.push('drain'); if (failDrain) throw Error('drain failed'); } };
  const projection = { stateOf: session => session.todos };
  let hostOptions;
  const apply = new Function('schema', 'createAttentionState', 'installHost', body.replace('export async function apply', 'return async function apply'))(
    fluent,
    ({ table: actual }) => { assert.equal(actual, table); if (failState) throw Error('invalid stored state'); return shared; },
    (_ctx, _config, options) => { hostOptions = options; },
  );
  const ctx = {
    settings: { configure: () => () => {} },
    effect(fn) { effects.push(fn()); },
    sessionProjections: { async register(spec) { specs.push(spec); return projection; } },
    storageDomain: { async open(spec) { specs.push(spec); return { table(name) { assert.equal(name, 'acknowledgments'); return table; }, async close() { order.push('close'); } }; } },
  };
  return { apply: () => apply(ctx, {}), effects, order, specs, shared, options: () => hostOptions };
}

test('production entry injects durable storage and passes the exact state into the real channel options', async () => {
  assert.match(source, /export const inject = .*'storageDomain'/);
  const f = fixture(); await f.apply();
  assert.equal(f.specs[1].name, 'local_sound_notifications_attention');
  assert.equal(f.specs[1].version, 1);
  assert.ok(f.specs[1].tables.acknowledgments.valueSchema);
  assert.equal(f.options().channelOptions.attentionState, f.shared);
  const todos = [{ content: 'work', status: 'completed' }];
  assert.equal(f.options().readTodos({ session: { todos } }), todos);
  for (const cleanup of f.effects.reverse()) await cleanup?.();
  assert.deepEqual(f.order, ['drain', 'close']);
});

test('entry owns the domain before state construction can fail', async () => {
  const f = fixture({ failState: true });
  await assert.rejects(f.apply(), /invalid stored state/);
  for (const cleanup of f.effects.reverse()) await cleanup?.();
  assert.deepEqual(f.order, ['close']);
});

test('a failed state drain still closes the storage domain on disposal', async () => {
  const f = fixture({ failDrain: true }); await f.apply();
  await assert.rejects(f.effects.at(-1)(), /drain failed/);
  assert.deepEqual(f.order, ['drain', 'close']);
});
