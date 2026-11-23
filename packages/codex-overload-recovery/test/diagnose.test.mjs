import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseSession } from '../diagnose.js';

function storage(events, extras = {}) {
  const calls = [];
  return {
    calls,
    async stat(id, options) { calls.push(['stat', id]); return { header: { id }, formatStatus: 'current', ...extras }; },
    async open(id, access) {
      calls.push(['open', id, access]);
      assert.equal(access, 'read');
      return {
        async read(offset, length) { calls.push(['read', offset, length]); return { events: events.slice(offset, offset + length) }; },
        async close() { calls.push(['close']); },
        append() { assert.fail('must never append'); }, flush() { assert.fail('must never flush'); },
      };
    },
  };
}
const event = (seq, type, data) => ({ seq, type, data });

test('read-only audit identifies overload, retained replay metadata and complete tool pairs without content', async () => {
  const events = [
    event(0, 'turn/start', { turn: 1 }),
    event(1, 'request/header', { header: { config: { provider: 'openai-codex', model: 'test' } } }),
    event(2, 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: 'SECRET_THOUGHT' }], source: { replayState: { SECRET_REPLAY: true } } } }),
    event(3, 'tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'write', arguments: 'SECRET_ARGS' }),
    event(4, 'tool/result', { turn: 1, step: 1, message: { toolCallId: 'call-1', content: 'SECRET_RESULT' } }),
    event(5, 'assistant/attempt', { turn: 1, step: 2, stream: [{ content: 'SECRET_PARTIAL' }] }),
    event(6, 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'PI_AI_ERROR', message: 'overloaded' } } }),
  ];
  const persistence = storage(events);
  const result = await diagnoseSession(persistence, 'test');
  assert.equal(result.contiguous, true); assert.equal(result.eventsRead, 7);
  assert.deepEqual(result.unansweredRecordedCalls, []);
  assert.equal(result.lastTurn.toolCalls, 1); assert.equal(result.lastTurn.attempts, 1);
  assert.equal(result.retainedReasoningBlocks, 1); assert.equal(result.retainedReplayMessages, 1);
  assert.equal(result.recentFailures[0].error.code, 'PI_AI_ERROR');
  assert.ok(!JSON.stringify(result).includes('SECRET'));
  assert.equal(persistence.calls.at(-1)[0], 'close');
});

test('read-only audit reports unanswered calls and noncontiguous logs rather than hiding them', async () => {
  const persistence = storage([event(0, 'tool/call', { callId: 'a', name: 'write' }), event(2, 'step/end', { turn: 1, step: 1 })]);
  const result = await diagnoseSession(persistence, 'test');
  assert.equal(result.contiguous, false);
  assert.deepEqual(result.unansweredRecordedCalls, [{ seq: 0, name: 'write' }]);
});

test('migration-required logs are not resumed, opened for write, or migrated', async () => {
  const persistence = storage([], { formatStatus: 'migration-required' });
  const result = await diagnoseSession(persistence, 'test');
  assert.equal(result.inspected, false);
  assert.equal(persistence.calls.length, 1);
});

test('read handles close after errors', async () => {
  let closed = false;
  const persistence = { stat: async () => ({}), open: async () => ({ read: async () => { throw new Error('read error'); }, close: async () => { closed = true; } }) };
  await assert.rejects(() => diagnoseSession(persistence, 'test'), /read error/);
  assert.equal(closed, true);
});

test('missing sessions are not created', async () => {
  const persistence = { stat: async () => undefined, open: () => assert.fail('not found must not open') };
  await assert.rejects(() => diagnoseSession(persistence, 'missing'), /Session not found/);
});
