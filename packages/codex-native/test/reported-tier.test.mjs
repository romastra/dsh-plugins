import test from 'node:test';
import assert from 'node:assert/strict';
import { noteReportedTier, attachReportedTier } from '../src/reported-tier.js';

const replay = (stopReason = 'stop') => ({ blocks: [{ type: 'reasoning', thinkingSignature: 'SECRET-CIPHER' }], response: { kind: 'codex-native', version: 1, scope: 'test-scope', state: { kind: 'pi-ai', version: 2, provider: 'openai-codex', api: 'openai-codex-responses', model: 'gpt-6.1-sol', stopReason } } });
const terminal = (tier, extra = {}) => ({ phase: 'response-terminal', eventType: 'response.completed', rawReportedTierPresent: true, rawReportedTierRecognized: true, rawReportedTier: tier, requestedTier: 'priority', selectedTier: 'fast', ...extra });

test('raw default stays default despite requested Fast; only actual raw priority yields priority metadata', () => {
  for (const tier of ['default', 'priority', 'flex', 'auto', 'scale']) {
    const context = { reportedTier: null };
    noteReportedTier(context, terminal(tier));
    const input = replay(); const output = attachReportedTier(input, context);
    assert.deepEqual(output.response.reportedServiceTier, { source: 'codex-terminal', version: 1, tier });
    assert.equal(output.blocks, input.blocks);
    assert.equal(output.response.state, input.response.state);
    assert.equal(output.response.scope, input.response.scope);
    assert.equal(Object.hasOwn(input.response, 'reportedServiceTier'), false);
    assert.doesNotMatch(JSON.stringify(output.response.reportedServiceTier), /SECRET|requested|selected|scope|model/);
  }
});

test('request policy reset clears prior confirmation, missing retry report stays unknown', () => {
  const context = {};
  noteReportedTier(context, terminal('priority'));
  noteReportedTier(context, { phase: 'request-policy', selectedTier: 'fast', requestedTier: 'priority' });
  assert.equal(context.reportedTier, null);
  assert.equal(attachReportedTier(replay(), context).response.reportedServiceTier, undefined);
  noteReportedTier(context, terminal('priority'));
  noteReportedTier(context, terminal(undefined, { rawReportedTierPresent: false, rawReportedTierRecognized: false }));
  assert.equal(context.reportedTier, null);
});

test('request-local contexts cannot inherit another request raw priority', () => {
  const first = {}; const second = {};
  noteReportedTier(first, terminal('priority'));
  assert.equal(attachReportedTier(replay(), second).response.reportedServiceTier, undefined);
  noteReportedTier(second, terminal('default'));
  assert.equal(attachReportedTier(replay(), first).response.reportedServiceTier.tier, 'priority');
  assert.equal(attachReportedTier(replay(), second).response.reportedServiceTier.tier, 'default');
});

test('incomplete/error/malformed/unknown terminal rows clear confirmation rather than claim priority', () => {
  for (const row of [
    terminal('priority', { eventType: 'response.incomplete' }),
    terminal('priority', { eventType: 'response.failed' }),
    terminal('priority', { eventType: 'error' }),
    terminal('priority', { eventType: null }),
    terminal('priority', { rawReportedTierPresent: false }),
    terminal('priority', { rawReportedTierPresent: 'true' }),
    terminal('priority', { rawReportedTierRecognized: false }),
    terminal('priority', { rawReportedTierRecognized: 1 }),
    terminal('SECRET-UNKNOWN'), terminal({ tier: 'priority' }), terminal(null),
  ]) {
    const context = { reportedTier: 'priority' };
    noteReportedTier(context, row);
    assert.equal(context.reportedTier, null);
    assert.equal(attachReportedTier(replay(), context).response.reportedServiceTier, undefined);
  }
  for (const eventType of ['response.done', 'response.completed']) {
    const context = {};
    noteReportedTier(context, terminal('priority', { eventType }));
    assert.equal(context.reportedTier, 'priority');
  }
});

test('aborted/error/length finish and malformed native route stay grey, stale metadata removed', () => {
  for (const stopReason of ['error', 'aborted', 'length', 'pending', undefined]) {
    const input = replay(); input.response.state.stopReason = stopReason;
    input.response.reportedServiceTier = { source: 'codex-terminal', version: 1, tier: 'priority' };
    const output = attachReportedTier(input, { reportedTier: 'priority' });
    assert.equal(output.response.reportedServiceTier, undefined);
    assert.equal(output.blocks, input.blocks); assert.equal(output.response.state, input.response.state);
    assert.equal(input.response.reportedServiceTier.tier, 'priority');
  }
  for (const patch of [{ provider: 'codex' }, { api: 'other' }, { version: 1 }, { kind: 'other' }]) {
    const input = replay(); Object.assign(input.response.state, patch);
    assert.equal(attachReportedTier(input, { reportedTier: 'priority' }).response.reportedServiceTier, undefined);
  }
  assert.equal(attachReportedTier(replay('toolUse'), { reportedTier: 'priority' }).response.reportedServiceTier.tier, 'priority');
});

test('helpers tolerate absent context/rows and do not infer tier from requested or normalized fields', () => {
  for (const value of [undefined, null, [], 'priority', 1]) {
    assert.doesNotThrow(() => noteReportedTier(value, terminal('priority')));
    assert.equal(attachReportedTier(replay(), value).response.reportedServiceTier, undefined);
    assert.equal(attachReportedTier(value, {}), value);
  }
  const context = {};
  for (const row of [null, [], {}, { phase: 'other', rawReportedTier: 'priority' }, { phase: 'request-policy', serviceTier: 'priority' }]) noteReportedTier(context, row);
  assert.equal(attachReportedTier(replay(), context).response.reportedServiceTier, undefined);
  assert.equal(attachReportedTier(replay(), { selectedTier: 'fast', requestedTier: 'priority', serviceTier: 'priority' }).response.reportedServiceTier, undefined);
  const native = { blocks: [], response: { kind: 'pi-ai', version: 2 } };
  assert.equal(attachReportedTier(native, { reportedTier: 'priority' }), native);
});
