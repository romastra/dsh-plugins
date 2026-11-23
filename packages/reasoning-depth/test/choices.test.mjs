import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEffortView, selectionAt, stopPercent } from '../src/choices.js';
const levels = [
  { id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' },
  { id: 'high', name: 'High' }, { id: 'xhigh', name: 'Max' },
];
function state(reasoning = { efforts: levels, defaultEffort: 'high' }, effort) {
  return {
    current: { provider: 'codex', model: 'gpt', ...(effort === undefined ? {} : { reasoningEffort: effort }) },
    pending: null,
    groups: [{ id: 'codex', models: [{ id: 'gpt', name: 'GPT', reasoning }] }],
  };
}
test('uses advertised stops, order, ids and default without hardcoded vocabulary', () => {
  const view = buildEffortView(state());
  assert.equal(view.choices.length, 4);
  assert.deepEqual(view.choices, levels);
  assert.equal(view.index, 2);
  assert.deepEqual(selectionAt(view, 3), { provider: 'codex', model: 'gpt', reasoningEffort: 'xhigh' });
});
test('offers only actual levels and leaves an unspecified server policy unselected', () => {
  const view = buildEffortView(state({ efforts: levels }));
  assert.deepEqual(view.choices, levels);
  assert.equal(view.index, -1);
  assert.equal(view.selectionRequired, true);
  assert.equal(view.choices.some(choice => choice.id === undefined), false);
  assert.deepEqual(selectionAt(view, 0), { provider: 'codex', model: 'gpt', reasoningEffort: 'low' });
});
test('explicit none stays None only when the adapter actually advertises it', () => {
  const efforts = [{ id: 'none', name: 'None' }, ...levels];
  const view = buildEffortView(state({ efforts }, 'none'));
  assert.equal(view.index, 0);assert.equal(view.selectionRequired, false);
  assert.deepEqual(selectionAt(view, 0), { provider: 'codex', model: 'gpt', reasoningEffort: 'none' });
});
test('pending selection previews the shared directory rather than a stale current choice', () => {
  const value = state();
  value.pending = { ...value.current, reasoningEffort: 'low' };
  assert.equal(buildEffortView(value).index, 0);
});
test('hides unsupported, absent and unavailable reasoning instead of inventing stops', () => {
  assert.equal(buildEffortView(null), null);
  assert.equal(buildEffortView(state({ efforts: [] })), null);
  assert.equal(buildEffortView({ ...state(), groups: [] }), null);
  assert.equal(buildEffortView(state(undefined, 'obsolete')), null);
  assert.equal(buildEffortView(state(null)), null);
});
test('supports one, two, seven and provider-specific levels', () => {
  for (const count of [1, 2, 7]) {
    const efforts = Array.from({ length: count }, (_, i) => ({ id: `budget-${i}`, name: String(i) }));
    const view = buildEffortView(state({ efforts, defaultEffort: efforts[0].id }));
    assert.equal(view.choices.length, count);
    assert.equal(view.index, 0);
    assert.equal(stopPercent(0, count), 0);
    if (count > 1) assert.equal(stopPercent(count - 1, count), 100);
  }
});
test('never submits a clamped, fractional, or out-of-bounds choice', () => {
  const view = buildEffortView(state());
  for (const index of [-1, 4, 1.1, NaN]) assert.equal(selectionAt(view, index), null);
});
test('each model/choice-list identity invalidates an old gesture', () => {
  const first = buildEffortView(state());
  const changed = state();
  changed.current.model = 'new-model';
  changed.groups[0].models[0].id = 'new-model';
  assert.notEqual(buildEffortView(changed).key, first.key);
  assert.notEqual(buildEffortView(state({ efforts: levels.slice(0, 3), defaultEffort: 'high' })).key, first.key);
});
