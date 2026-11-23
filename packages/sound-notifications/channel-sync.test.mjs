import test from 'node:test';
import assert from 'node:assert/strict';
import { installCompletionChannel, COMPLETION_ENDPOINT } from './completion-channel.js';
import { createAttentionState } from './attention-state.js';

const token = (sessionId, kind, value) => JSON.stringify([sessionId, kind, value]);
const terminal = (sessionId, id, outcome = 'attention') => ({ type: 'completed', sessionId, id, outcome, reason: outcome === 'success' ? 'completed' : 'error' });
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function tableFixture() {
  const records = new Map(), writes = [];
  return { records, writes, get: key => records.get(key), entries: () => records.entries(), async put(key, value) { records.set(key, structuredClone(value)); writes.push([key, structuredClone(value)]); } };
}
function fixture(t, options = {}) {
  const cleanups = [], timers = new Map();
  let handler, disposed = false, routeDisposed = false, time = 0, nextTimer = 0;
  const ctx = {
    connection: { fetch: { register(route) {
      assert.equal(route.path, '/api/' + COMPLETION_ENDPOINT); assert.deepEqual(route.methods, ['POST']); assert.equal(route.requestBody, 'buffered');
      handler = route.fetch; return () => { routeDisposed = true; };
    } } },
    effect(callback) { cleanups.push(callback()); },
  };
  const channel = installCompletionChannel(ctx, { now: () => time, later(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, at: time + ms }); return id; }, cancel: id => timers.delete(id), ...options });
  const fetch = (message, { contentType = 'application/json', signal = new AbortController().signal, raw = false } = {}) => handler(new Request('http://fixture.invalid/api/' + COMPLETION_ENDPOINT, {
    method: 'POST', headers: { 'content-type': contentType }, body: raw ? message : JSON.stringify(message), signal,
  }));
  const call = async (payload, signal) => {
    const response = await fetch({ type: 'client-request', rpcId: 'fixture-rpc', method: COMPLETION_ENDPOINT, payload }, { signal });
    assert.equal(response.status, 200);
    const envelope = await response.json(); assert.equal(envelope.type, 'server-response'); assert.equal(envelope.rpcId, 'fixture-rpc');
    return envelope.result;
  };
  const request = async (payload, signal) => { const result = await call(payload, signal); assert.equal(result.ok, true, result.error?.message); return result.value; };
  const watch = (clientId, baseline, extra = {}, signal) => request({ clientId, protocol: 2, action: 'watch', ...(baseline ? { generation: baseline.generation, cursor: baseline.cursor } : {}), ...extra }, signal);
  const ack = (sessionId, tokens, clientId = 'phone') => request({ protocol: 2, action: 'acknowledge', clientId, sessionId, tokens });
  const dispose = async () => { if (disposed) return; disposed = true; for (const cleanup of cleanups.reverse()) await cleanup?.(); };
  t.after(dispose);
  return {
    channel, call, request, watch, ack, fetch, dispose, timers,
    get routeDisposed() { return routeDisposed; },
    advance(ms) { time += ms; for (const [id, row] of [...timers]) if (row.at <= time) { timers.delete(id); row.fn(); } },
  };
}

test('legacy no-action API stays live-only; v2 baseline exposes pending logical attention', async t => {
  const f = fixture(t), event = terminal('chat', 'old-completion', 'success');
  f.channel.publish(event);
  const legacy = await f.request({ clientId: 'legacy' });
  assert.equal(legacy.protocol, 2); assert.deepEqual(legacy.events, []); assert.deepEqual(legacy.state.terminals, [event]);
  const modern = await f.watch('phone');
  assert.deepEqual(modern.events, []); assert.deepEqual(modern.state, legacy.state);
  const reset = await f.watch('returning', { generation: 'replaced-host', cursor: 0 });
  assert.deepEqual(reset.events, []); assert.deepEqual(reset.state.terminals, [event]);
  assert.deepEqual((await f.watch('future', { generation: modern.generation, cursor: modern.cursor + 1 })).events, []);
  const status = f.channel.status();
  assert.equal(status.transport, 'authenticated-rpc'); assert.equal(status.published, 1);
  assert.equal(status.clients[0].protocol, 1); assert.equal(status.clients[1].protocol, 2);
  assert.deepEqual(status.state, { revision: 1, sessionCount: 1, acknowledgedCount: 0, terminalCount: 1 });
});

test('phone ACK wakes every laptop/phone/desktop watch only after durable commit', async t => {
  const table = tableFixture(), gate = deferred(), original = table.put;
  table.put = async (...args) => { await gate.promise; await original(...args); };
  const state = createAttentionState({ table }), f = fixture(t, { attentionState: state });
  f.channel.publish(terminal('chat', 'stop'));
  const baselines = await Promise.all(['laptop', 'phone', 'desktop'].map(id => f.watch(id)));
  const polls = baselines.map((baseline, index) => f.watch(['laptop', 'phone', 'desktop'][index], baseline));
  await flush(); assert.equal(f.channel.status().waitingClients, 3);
  const exact = token('chat', 'terminal', 'stop'), pendingAck = f.ack('chat', [exact]);
  await flush(); assert.equal(f.channel.status().waitingClients, 3); assert.equal(f.channel.status().cursor, 1);
  assert.deepEqual(state.snapshot().acknowledged, []);
  gate.resolve(); const acknowledged = await pendingAck;
  assert.deepEqual(acknowledged.events, []); assert.equal(acknowledged.cursor, 2);
  for (const result of await Promise.all(polls)) {
    assert.deepEqual(result.events, [{ type: 'acknowledged', sessionId: 'chat', tokens: [exact] }]);
    assert.deepEqual(result.state.acknowledged, [{ sessionId: 'chat', tokens: [exact] }]);
  }
  assert.equal(f.channel.status().waitingClients, 0); assert.equal(f.timers.size, 0); assert.equal(table.writes.length, 1);
  assert.deepEqual(f.channel.status().state, { revision: 2, sessionCount: 1, acknowledgedCount: 1, terminalCount: 1 });
});

test('duplicate ACKs neither echo new events nor wake long polls', async t => {
  const f = fixture(t), exact = token('chat', 'approval', 'call');
  await f.ack('chat', [exact]); const baseline = await f.watch('laptop');
  const pending = f.watch('laptop', baseline);
  await flush(); assert.equal(f.channel.status().waitingClients, 1);
  const duplicate = await f.ack('chat', [exact, exact]);
  assert.equal(duplicate.cursor, baseline.cursor); assert.equal(f.channel.status().published, 1); assert.equal(f.channel.status().waitingClients, 1);
  f.advance(25000); const timeout = await pending;
  assert.deepEqual(timeout.events, []); assert.deepEqual(timeout.state.acknowledged, [{ sessionId: 'chat', tokens: [exact] }]);
});

test('expired journal loses neither terminal snapshot nor durable ACK state', async t => {
  const f = fixture(t), baseline = await f.watch('laptop'), event = terminal('chat', 'stop'), exact = token('chat', 'terminal', 'stop');
  f.channel.publish(event); f.advance(120001);
  const recovery = await f.watch('laptop', baseline);
  assert.deepEqual(recovery.events, []); assert.deepEqual(recovery.state.terminals, [event]);
  await f.ack('chat', [exact]); f.advance(120001);
  const fresh = await f.watch('fresh-window');
  assert.deepEqual(fresh.events, []); assert.deepEqual(fresh.state.terminals, [event]); assert.deepEqual(fresh.state.acknowledged, [{ sessionId: 'chat', tokens: [exact] }]);
  const returning = await f.watch('laptop', recovery);
  assert.deepEqual(returning.events, []); assert.deepEqual(returning.state, fresh.state);
});

test('stale ACK targets only its token, not a newer terminal/request or another chat', async t => {
  const f = fixture(t), old = terminal('a', 'old'), next = terminal('a', 'new', 'success'), other = terminal('b', 'other');
  f.channel.publish(old); f.channel.publish(next); f.channel.publish(other);
  const oldToken = token('a', 'terminal', 'old'), oldRequest = token('a', 'question', 'old-request');
  const acknowledged = await f.ack('a', [oldToken, oldRequest]);
  assert.deepEqual(acknowledged.state.terminals, [next, other]);
  assert.deepEqual(acknowledged.state.acknowledged, [{ sessionId: 'a', tokens: [oldToken, oldRequest] }]);
  assert.ok(!acknowledged.state.acknowledged[0].tokens.includes(token('a', 'terminal', 'new')));
  f.channel.publish({ type: 'clear-attention', sessionId: 'a' });
  const cleared = await f.watch('reload');
  assert.deepEqual(cleared.state.terminals, [other]); assert.deepEqual(cleared.state.acknowledged, acknowledged.state.acknowledged);
});

test('ACK response has no live events; independent saved watch cursor still receives them', async t => {
  const f = fixture(t), baseline = await f.watch('laptop'), event = terminal('chat', 'new-work');
  f.channel.publish(event);
  const exact = token('chat', 'approval', 'pending-request'), acknowledged = await f.ack('chat', [exact]);
  assert.deepEqual(acknowledged.events, []); assert.equal(acknowledged.cursor, 2);
  const live = await f.watch('laptop', baseline);
  assert.deepEqual(live.events, [event, { type: 'acknowledged', sessionId: 'chat', tokens: [exact] }]);
  assert.equal(live.cursor, acknowledged.cursor);
});

test('Host restart restores ACK tombstones but never old completion events', async t => {
  const table = tableFixture(), firstState = createAttentionState({ table }), first = fixture(t, { attentionState: firstState });
  const exact = token('chat', 'approval', 'pending'), oldTerminal = token('chat', 'terminal', 'old');
  first.channel.publish(terminal('chat', 'old')); await first.ack('chat', [exact, oldTerminal]); const previous = await first.watch('laptop');
  await first.dispose(); assert.equal(first.routeDisposed, true);
  // Caller owns an injected state and storage domain, not the channel cleanup.
  assert.equal(firstState.publish(terminal('not-closed', 'probe')), true); await firstState.dispose();
  const second = fixture(t, { attentionState: createAttentionState({ table }) });
  const baseline = await second.watch('laptop', previous);
  assert.notEqual(baseline.generation, previous.generation); assert.deepEqual(baseline.events, []); assert.deepEqual(baseline.state.terminals, []);
  assert.deepEqual(baseline.state.acknowledged, [{ sessionId: 'chat', tokens: [exact, oldTerminal] }]);
  second.channel.publish(terminal('chat', 'new'));
  assert.equal((await second.watch('laptop', baseline)).events[0].id, 'new');
});

test('storage failure is not acknowledged or broadcast; later retry succeeds', async t => {
  const table = tableFixture(), original = table.put;
  let fail = true;
  table.put = async (...args) => { if (fail) throw new Error('private disk path must not leak'); await original(...args); };
  const f = fixture(t, { attentionState: createAttentionState({ table }) }), baseline = await f.watch('laptop');
  const pending = f.watch('laptop', baseline); await flush();
  const payload = { clientId: 'phone', protocol: 2, action: 'acknowledge', sessionId: 'chat', tokens: [token('chat', 'plan-review', 'call')] };
  const failed = await f.call(payload);
  assert.equal(failed.ok, false); assert.equal(failed.error.code, 'storage-unavailable'); assert.doesNotMatch(failed.error.message, /private disk/);
  assert.equal(f.channel.status().cursor, 0); assert.equal(f.channel.status().waitingClients, 1); assert.equal(f.channel.status().state.acknowledgedCount, 0);
  fail = false; assert.equal((await f.call(payload)).ok, true);
  assert.equal((await pending).events[0].type, 'acknowledged'); assert.equal(table.writes.length, 1);
});

test('bad payloads and malformed envelopes do not touch notification state or exact route contract', async t => {
  const f = fixture(t), valid = token('chat', 'approval', 'call');
  for (const payload of [null, [], {}, { clientId: '' }, { clientId: 'x'.repeat(101) }, { clientId: 'phone', cursor: -1 }, { clientId: 'phone', action: 'unknown' }, { clientId: 'phone', action: null }, { clientId: 'phone', action: 'acknowledge', sessionId: 'chat', tokens: [valid, token('other', 'question', 'call')] }, { clientId: 'phone', action: 'acknowledge', sessionId: 'chat', tokens: Array(257).fill(valid) }]) {
    const result = await f.call(payload); assert.equal(result.ok, false); assert.equal(result.error.code, 'bad-request');
  }
  assert.equal((await f.fetch({}, { contentType: 'text/plain' })).status, 415);
  assert.equal((await f.fetch('{invalid', { raw: true })).status, 400);
  assert.equal((await f.fetch({ type: 'client-request', rpcId: 'a', method: 'other', payload: { clientId: 'phone' } })).status, 400);
  assert.equal(f.channel.status().published, 0); assert.equal(f.channel.status().state.revision, 0);
});

test('aborted and unloaded watches release timers and preserve injected state ownership', async t => {
  const state = createAttentionState(), f = fixture(t, { attentionState: state }), baseline = await f.watch('laptop');
  const controller = new AbortController(), aborted = f.watch('laptop', baseline, {}, controller.signal);
  await flush(); assert.equal(f.channel.status().waitingClients, 1); controller.abort(new Error('closed tab'));
  await assert.rejects(aborted, /closed tab/); assert.equal(f.timers.size, 0); assert.equal(f.channel.status().waitingClients, 0);
  const pending = f.watch('laptop', baseline); await flush(); await f.dispose();
  assert.deepEqual((await pending).events, []); assert.equal(f.routeDisposed, true); assert.equal(f.timers.size, 0);
  const before = f.channel.status().cursor; f.channel.publish(terminal('chat', 'after-unload')); assert.equal(f.channel.status().cursor, before);
  assert.equal((await state.acknowledge({ sessionId: 'chat', tokens: [token('chat', 'approval', 'call')] })).changed, true);
  await state.dispose();
});
