import test from 'node:test';
import assert from 'node:assert/strict';
import { createAttentionState, validateAcknowledgement, ATTENTION_LIMITS } from './attention-state.js';

const token = (sessionId, kind, value) => JSON.stringify([sessionId, kind, value]);
const terminal = (sessionId, id, outcome = 'attention') => ({ type: 'completed', sessionId, id, outcome, reason: 'error' });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const flush = () => new Promise(resolve => setImmediate(resolve));
function tableFixture(rows = []) {
  const records = new Map(rows), writes = [];
  return {
    records, writes,
    get: key => records.get(key), entries: () => records.entries(),
    async put(key, value) { writes.push([key, structuredClone(value)]); records.set(key, structuredClone(value)); },
  };
}

test('canonical JSON tokens distinguish separators, kinds and escaped ids', () => {
  const sessionId = 's:"\\☃', values = ['a:b', 'a","b', '\\', '雪'];
  const tokens = values.flatMap(value => ['approval', 'question', 'plan-review', 'terminal'].map(kind => token(sessionId, kind, value)));
  assert.equal(new Set(tokens).size, 16);
  assert.deepEqual(validateAcknowledgement({ sessionId, tokens: [...tokens, tokens[0]] }), { sessionId, tokens });
});

test('exact session and canonical-token length boundaries remain accepted', async () => {
  const sessionId = 's'.repeat(ATTENTION_LIMITS.sessionLength);
  const overhead = token(sessionId, 'approval', '').length;
  const exact = token(sessionId, 'approval', 'v'.repeat(ATTENTION_LIMITS.tokenLength - overhead));
  assert.equal(exact.length, ATTENTION_LIMITS.tokenLength);
  const state = createAttentionState();
  assert.equal((await state.acknowledge({ sessionId, tokens: [exact] })).changed, true);
  assert.deepEqual(state.snapshot().acknowledged, [{ sessionId, tokens: [exact] }]);
});

test('malformed, noncanonical, cross-session and oversized ACKs are rejected atomically', async () => {
  const table = tableFixture(), state = createAttentionState({ table });
  const valid = token('s', 'approval', 'call');
  const invalid = [
    undefined, null, [], {}, { sessionId: '', tokens: [valid] }, { sessionId: 'x'.repeat(257), tokens: [valid] },
    { sessionId: 's', tokens: [] }, { sessionId: 's', tokens: [valid, 'oops'] },
    { sessionId: 's', tokens: [token('other', 'approval', 'call')] },
    { sessionId: 's', tokens: ['["s", "approval", "call"]'] },
    { sessionId: 's', tokens: ['["s","approval","\\u0061"]'] },
    ...['unknown', '', 'completion'].map(kind => ({ sessionId: 's', tokens: [token('s', kind, 'call')] })),
    ...['["s","approval",1]', '["s","approval",""]', '["s","approval","call",0]', '{}', 'null'].map(value => ({ sessionId: 's', tokens: [value] })),
    { sessionId: 's', tokens: [token('s', 'question', 'x'.repeat(2048))] },
    { sessionId: 's', tokens: Array(257).fill(valid) }, { sessionId: 's', tokens: [null] },
  ];
  for (const input of invalid) await assert.rejects(state.acknowledge(input), { code: 'bad-request' });
  assert.deepEqual(state.snapshot(), { revision: 0, acknowledged: [], terminals: [] });
  assert.equal(table.writes.length, 0);
});

test('ACKs merge exact tokens idempotently without mutating callers or snapshots', async () => {
  const table = tableFixture(), state = createAttentionState({ table });
  const a = token('s', 'approval', 'a'), b = token('s', 'question', 'b');
  const input = { sessionId: 's', tokens: [a, a] };
  const pending = state.acknowledge(input); input.tokens.push(b);
  assert.deepEqual(await pending, { changed: true, tokens: [a] });
  assert.deepEqual(await state.acknowledge({ sessionId: 's', tokens: [a] }), { changed: false, tokens: [a] });
  assert.deepEqual(await state.acknowledge({ sessionId: 's', tokens: [a, b] }), { changed: true, tokens: [a, b] });
  assert.equal(table.writes.length, 2);
  const snapshot = state.snapshot(); snapshot.acknowledged[0].tokens.length = 0; snapshot.acknowledged.push({ sessionId: 'oops', tokens: [] });
  assert.deepEqual(state.snapshot(), { revision: 2, acknowledged: [{ sessionId: 's', tokens: [a, b] }], terminals: [] });
});

test('terminal snapshots keep latest live event per chat; clears retain exact ACK tombstones', async () => {
  const state = createAttentionState();
  const old = terminal('s', 'old'), next = terminal('s', 'new', 'success'), other = terminal('other', 'other');
  state.publish(old); state.publish(other);
  await state.acknowledge({ sessionId: 's', tokens: [token('s', 'terminal', old.id)] });
  state.publish(next);
  assert.deepEqual(state.snapshot().terminals, [next, other]);
  assert.equal(state.publish(next), false, 'same event is idempotent');
  state.publish({ type: 'clear-attention', sessionId: 's' });
  assert.deepEqual(state.snapshot().terminals, [other]);
  assert.deepEqual(state.snapshot().acknowledged, [{ sessionId: 's', tokens: [token('s', 'terminal', 'old')] }]);
  assert.equal(state.publish({ type: 'clear-attention', sessionId: 's' }), false);
  assert.equal(state.publish({ type: 'unrelated', sessionId: 's' }), false);
});

test('published terminal metadata and all returned snapshots are isolated copies', () => {
  const state = createAttentionState(), event = { ...terminal('s', 'a'), metadata: { reason: ['original'] } };
  state.publish(event); event.metadata.reason[0] = 'input mutation';
  const snapshot = state.snapshot(); snapshot.terminals[0].metadata.reason[0] = 'snapshot mutation'; snapshot.terminals.length = 0;
  assert.deepEqual(state.snapshot().terminals[0].metadata, { reason: ['original'] });
});

test('ACK success and revision are invisible until durable put resolves', async () => {
  const gate = deferred(), table = tableFixture(), original = table.put;
  table.put = async (...args) => { await gate.promise; await original(...args); };
  const state = createAttentionState({ table }), a = token('s', 'approval', 'a');
  let settled = false;
  const pending = state.acknowledge({ sessionId: 's', tokens: [a] }).then(value => { settled = true; return value; });
  await flush(); assert.equal(settled, false); assert.equal(state.snapshot().revision, 0); assert.deepEqual(state.snapshot().acknowledged, []);
  gate.resolve(); assert.equal((await pending).changed, true);
  assert.deepEqual(table.get('s'), { tokens: [a] }); assert.equal(state.snapshot().revision, 1);
});

test('concurrent ACKs serialize merges and concurrent duplicates commit only once', async () => {
  const gate = deferred(), table = tableFixture(), original = table.put;
  let started = 0;
  table.put = async (...args) => { if (++started === 1) await gate.promise; await original(...args); };
  const state = createAttentionState({ table }), a = token('s', 'approval', 'a'), b = token('s', 'approval', 'b');
  const pending = [state.acknowledge({ sessionId: 's', tokens: [a] }), state.acknowledge({ sessionId: 's', tokens: [b] }), state.acknowledge({ sessionId: 's', tokens: [a, b] })];
  await flush(); assert.equal(started, 1); gate.resolve();
  assert.deepEqual((await Promise.all(pending)).map(row => row.changed), [true, true, false]);
  assert.equal(table.writes.length, 2); assert.deepEqual(table.get('s'), { tokens: [a, b] });
});

test('failed durable ACK is never visible and a later retry can commit', async () => {
  const table = tableFixture(), original = table.put;
  let fail = true;
  table.put = async (...args) => { if (fail) throw new Error('disk unavailable'); await original(...args); };
  const state = createAttentionState({ table }), a = token('s', 'plan-review', 'a');
  await assert.rejects(state.acknowledge({ sessionId: 's', tokens: [a] }), /disk unavailable/);
  assert.equal(state.snapshot().revision, 0); assert.deepEqual(state.snapshot().acknowledged, []);
  fail = false; assert.equal((await state.acknowledge({ sessionId: 's', tokens: [a] })).changed, true);
  assert.equal(table.writes.length, 1);
});

test('restart restores pending-request tombstones but never old terminal events', async () => {
  const table = tableFixture(), first = createAttentionState({ table });
  const tokens = [token('s', 'approval', 'pending'), token('s', 'terminal', 'old-stop')];
  first.publish(terminal('s', 'old-stop'));
  await first.acknowledge({ sessionId: 's', tokens }); await first.dispose();
  const restarted = createAttentionState({ table });
  assert.deepEqual(restarted.snapshot().acknowledged, [{ sessionId: 's', tokens }]);
  assert.deepEqual(restarted.snapshot().terminals, []);
  assert.equal((await restarted.acknowledge({ sessionId: 's', tokens })).changed, false);
  assert.equal(table.writes.length, 1);
});

test('per-session capacity rejects new tokens without evicting any tombstones', async () => {
  const state = createAttentionState(), tokens = Array.from({ length: ATTENTION_LIMITS.tokensPerSession }, (_, index) => token('s', 'approval', String(index)));
  await state.acknowledge({ sessionId: 's', tokens });
  assert.equal((await state.acknowledge({ sessionId: 's', tokens: [tokens[0]] })).changed, false);
  await assert.rejects(state.acknowledge({ sessionId: 's', tokens: [token('s', 'question', 'overflow')] }), { code: 'capacity-exceeded' });
  assert.deepEqual(state.snapshot().acknowledged, [{ sessionId: 's', tokens }]);
});

test('session capacity refuses new chats but permits existing and duplicate ACKs', async () => {
  const rows = Array.from({ length: ATTENTION_LIMITS.sessions }, (_, index) => ['s' + index, { tokens: [token('s' + index, 'approval', 'a')] }]);
  const table = tableFixture(rows), state = createAttentionState({ table });
  assert.equal((await state.acknowledge({ sessionId: 's0', tokens: rows[0][1].tokens })).changed, false);
  await state.acknowledge({ sessionId: 's0', tokens: [token('s0', 'question', 'b')] });
  await assert.rejects(state.acknowledge({ sessionId: 'new', tokens: [token('new', 'approval', 'a')] }), { code: 'capacity-exceeded' });
  assert.equal(state.snapshot().acknowledged.length, ATTENTION_LIMITS.sessions); assert.equal(table.writes.length, 1);
});

test('dispose drains already accepted commits and rejects new mutations without closing the table', async () => {
  const gate = deferred(), table = tableFixture(), original = table.put;
  table.put = async (...args) => { await gate.promise; await original(...args); };
  table.close = () => assert.fail('the storage domain belongs to the caller');
  const state = createAttentionState({ table }), a = token('s', 'question', 'a');
  const pending = state.acknowledge({ sessionId: 's', tokens: [a] });
  let drained = false;
  const disposing = state.dispose().then(() => { drained = true; });
  await assert.rejects(state.acknowledge({ sessionId: 's', tokens: [a] }), { code: 'disposed' });
  assert.equal(state.publish(terminal('s', 'late')), false); await flush(); assert.equal(drained, false);
  gate.resolve(); await Promise.all([pending, disposing]);
  assert.equal(drained, true); assert.deepEqual(table.get('s'), { tokens: [a] });
});
