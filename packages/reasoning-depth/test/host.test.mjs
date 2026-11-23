import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../index.js';
function setup({ reasoning = { defaultEffort: 'high', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] }, projectionKind = 'sequenced' } = {}) {
  let tool;
  const writes = [];
  const selected = { provider: 'codex', model: 'gpt', reasoningEffort: 'high' };
  const controller = {
    async modelCatalog() { return { default: { provider: 'other', model: 'fallback' }, groups: [{ id: 'codex', models: [{ id: 'gpt', reasoning }] }] }; },
    async projections() { return { kind: projectionKind, values: { modelSelection: { next: selected } } }; },
    async selectModel(value) { writes.push(value); return { selected: value }; },
  };
  apply({
    sessionController: controller,
    tools: { register(value) { tool = value; return () => {}; } },
    effect(callback) { return callback(); },
  });
  const exec = { agent: { id: 'own-session' }, signal: new AbortController().signal };
  return { tool, exec, writes };
}
test('get returns current session choices without mutating selection', async () => {
  const { tool, exec, writes } = setup();
  const result = await tool.execute({ action: 'get' }, exec);
  assert.equal(result.selected.reasoningEffort, 'high');
  assert.equal(result.choices.length, 2);
  assert.equal(writes.length, 0);
  assert.deepEqual(tool.output.render({}, result), [{ type: 'text', text: JSON.stringify(result) }]);
});
test('set calls the shared Host entry point, retaining model and own session', async () => {
  const { tool, exec, writes } = setup();
  await tool.execute({ action: 'set', effort: 'low' }, exec);
  assert.deepEqual(writes, [{ sessionId: 'own-session', provider: 'codex', model: 'gpt', reasoningEffort: 'low' }]);
});
test('omitting effort restores adapter default without a synthetic effort id', async () => {
  const { tool, exec, writes } = setup();
  await tool.execute({ action: 'set' }, exec);
  assert.deepEqual(writes, [{ sessionId: 'own-session', provider: 'codex', model: 'gpt' }]);
});
test('invalid choices never mutate the session', async () => {
  const { tool, exec, writes } = setup();
  await assert.rejects(tool.execute({ action: 'set', effort: 'invented' }, exec), /Unsupported/);
  await assert.rejects(tool.execute({ action: 'get', effort: 'low' }, exec), /only accepted/);
  await assert.rejects(tool.execute({ action: 'other' }, exec), /Unknown/);
  await assert.rejects(tool.execute({ action: 'set', effort: 7 }, exec), /Invalid/);
  assert.equal(writes.length, 0);
});
test('rejects missing owner and projections requiring migration', async () => {
  const fixture = setup();
  await assert.rejects(fixture.tool.execute({ action: 'get' }, {}), /current session/);
  const pending = setup({ projectionKind: 'migration-required' });
  await assert.rejects(pending.tool.execute({ action: 'set', effort: 'low' }, pending.exec), /not ready/);
  assert.equal(pending.writes.length, 0);
});
test('does not expose a fake adjustable level for a model without reasoning', async () => {
  const { tool, exec, writes } = setup({ reasoning: null });
  assert.deepEqual((await tool.execute({ action: 'get' }, exec)).choices, []);
  await assert.rejects(tool.execute({ action: 'set', effort: 'low' }, exec), /does not advertise/);
  assert.equal(writes.length, 0);
});
