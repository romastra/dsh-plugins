import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as recovery from '../index.js';

const installed = createRequire(join(process.env.DSH_INSTALL_DIR, 'package.json'));
const load = name => installed(`@deepseek-ai/${name}`);
const { Context } = load('cordis');
const { LlmAdapter, createUserMessage } = load('dsh-llm');
const overload = { type: 'finish', reason: { kind: 'error', failure: { code: 'PI_AI_ERROR', message: 'Codex error: Our servers are currently overloaded. Please try again later.' } } };
const finish = kind => ({ type: 'finish', reason: { kind } });
const providerError = (code, message = code, details = {}) => ({ type: 'finish', reason: { kind: 'error', failure: { code, message, ...details } } });
const gatewayReset = providerError('TRANSPORT', 'upstream connect error or disconnect/reset before headers. retried and the latest reset reason: remote connection failure');
const transientCodes = ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'STREAM_CLOSED', 'TIMEOUT', 'TRANSPORT'];
// Keep actual tests fast while exercising the extended count and retryable codes.
const extendedPolicy = { maxRetries: 12, retryableCodes: transientCodes };
const block = (content, index = 0) => ({ type: 'block-end', index, block: content });

async function harness(t, sequence, policy = {}) {
  const root = new Context();
  t.after(() => root.fiber.dispose());
  for (const name of ['dsh-session-projection', 'dsh-session', 'dsh-llm', 'dsh-tools', 'dsh-system-prompt', 'dsh-agent', 'dsh-tool-executor-native', 'dsh-llm-retry', 'dsh-agent-loop']) {
    const module = load(name);
    await root.plugin(module.default ?? module);
  }
  await root.plugin(recovery);
  let attempts = 0;
  const requests = [];
  class ScriptedAdapter extends LlmAdapter {
    providerRetryPolicy() { return { mode: 'normal', maxRetries: 2, retryableCodes: ['SERVER'], initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0, ...policy }; }
    async *stream(options) {
      requests.push(options);
      const chunks = sequence[Math.min(attempts++, sequence.length - 1)];
      for (const chunk of chunks) yield chunk;
    }
  }
  await root.plugin({ inject: ['llm'], apply(ctx) { ctx.llm.registerAdapter(['openai-codex'], new ScriptedAdapter()); } });
  const handle = await root.agents.create({ sessionId: `recovery-test-${crypto.randomUUID()}`, agentOptions: { provider: 'openai-codex', model: 'offline-test' } });
  t.after(() => handle.dispose());
  return { root, agent: handle.agent, requests, get attempts() { return attempts; } };
}

async function run(agent) {
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'offline recovery test' }] }));
  await agent.whenIdle();
  return agent.session.snapshotEvents();
}

test('real native loop recovers same step with no extra user message or failed partial tool dispatch', { timeout: 10000 }, async t => {
  const env = await harness(t, [
    [{ type: 'reasoning-delta', index: 0, text: 'failed partial' }, block({ type: 'tool-call', id: 'never-dispatched', name: 'side_effect', arguments: '{}' }, 1), overload],
    [block({ type: 'text', text: 'recovered' }), finish('stop')],
  ]);
  let calls = 0, terminalErrors = 0;
  env.root.on('agent/error', () => { terminalErrors++; });
  await env.root.plugin({ inject: ['tools'], apply(ctx) { ctx.tools.register({ name: 'side_effect', description: 'offline counter', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' }, render: () => [] }, async execute() { calls++; return {}; } }); } });
  const events = await run(env.agent);
  assert.equal(env.attempts, 2); assert.equal(calls, 0);
  assert.equal(terminalErrors, 0); // No goal-driver disarm event on successful recovery.
  assert.equal(events.filter(e => e.type === 'turn/start').length, 1);
  assert.equal(events.filter(e => e.type === 'step/start').length, 1);
  assert.equal(events.filter(e => e.type === 'user/message' && e.data.source.kind === 'user').length, 1);
  assert.equal(events.filter(e => e.type === 'assistant/attempt').length, 1);
  assert.equal(events.filter(e => e.type === 'llm/retry').length, 1);
  assert.equal(events.find(e => e.type === 'llm/retry').data.failure.code, 'SERVER');
  assert.equal(events.findLast(e => e.type === 'turn/end').data.reason.kind, 'completed');
  assert.deepEqual(env.requests[0].messages, env.requests[1].messages);
  assert.ok(!JSON.stringify(env.agent.session.deriveMessages()).includes('failed partial'));
  assert.ok(!JSON.stringify(env.requests[1].messages).includes('never-dispatched'));
});

test('real native budget exhaustion remains bounded in one turn', { timeout: 10000 }, async t => {
  const env = await harness(t, [[overload]]);
  const events = await run(env.agent);
  assert.equal(env.attempts, 3);
  assert.equal(events.filter(e => e.type === 'llm/retry').length, 2);
  assert.equal(events.filter(e => e.type === 'turn/start').length, 1);
  const ending = events.findLast(e => e.type === 'turn/end');
  assert.equal(ending.data.reason.kind, 'error');
  assert.equal(ending.data.reason.error.code, 'SERVER');
  // The same installed Session fork API accepts an error-ended prefix offline.
  const fork = env.root.sessions.fork(env.agent.session, ending.seq, `fork-test-${crypto.randomUUID()}`);
  assert.equal(fork.eventAt(ending.seq).data.reason.kind, 'error');
  assert.deepEqual(fork.deriveMessages(), env.agent.session.deriveMessages());
  assert.equal(fork.inheritedEventCount, ending.seq + 1);
  assert.equal(fork.header.isSeeded, true);
});

test('permanent PI_AI_ERROR remains terminal without retries', { timeout: 10000 }, async t => {
  const permanent = { type: 'finish', reason: { kind: 'error', failure: { code: 'PI_AI_ERROR', message: 'Invalid credentials or unsupported request' } } };
  const env = await harness(t, [[permanent]]);
  const events = await run(env.agent);
  assert.equal(env.attempts, 1);
  assert.equal(events.filter(e => e.type === 'llm/retry').length, 0);
  assert.equal(events.findLast(e => e.type === 'turn/end').data.reason.error.code, 'PI_AI_ERROR');
});

test('cancelling native backoff prevents any retry-started or new request', { timeout: 10000 }, async t => {
  const env = await harness(t, [[overload]], { initialDelayMs: 1000, maxDelayMs: 1000 });
  env.root.on('session/event', (_session, event) => {
    if (event.type === 'llm/retry') queueMicrotask(() => env.agent.cancel({ kind: 'user' }));
  });
  const events = await run(env.agent);
  assert.equal(env.attempts, 1);
  assert.equal(events.filter(e => e.type === 'llm/retry').length, 1);
  assert.equal(events.filter(e => e.type === 'llm/retry-started').length, 0);
  assert.equal(events.findLast(e => e.type === 'turn/end').data.reason.kind, 'aborted');
});

test('gateway resets beyond the old five-retry budget recover without closing the step', { timeout: 10000 }, async t => {
  const env = await harness(t, [
    ...Array.from({ length: 6 }, () => [gatewayReset]),
    [block({ type: 'text', text: 'reconnected' }), finish('stop')],
  ], extendedPolicy);
  const events = await run(env.agent);
  assert.equal(env.attempts, 7);
  assert.equal(events.filter(e => e.type === 'turn/start').length, 1);
  assert.equal(events.filter(e => e.type === 'step/start').length, 1);
  assert.deepEqual(events.filter(e => e.type === 'llm/retry-started').map(e => e.data.retry), [1, 2, 3, 4, 5, 6]);
  assert.equal(events.findLast(e => e.type === 'turn/end').data.reason.kind, 'completed');
});

test('allowlisted transient types share a finite budget, including interrupted streams', { timeout: 10000 }, async t => {
  const env = await harness(t, [
    [gatewayReset],
    [providerError('STREAM_CLOSED')],
    [providerError('TIMEOUT')],
    [overload],
    [providerError('RATE_LIMIT')],
    [providerError('EMPTY_RESPONSE')],
    [gatewayReset],
  ], extendedPolicy);
  const events = await run(env.agent);
  assert.equal(env.attempts, 13);
  const retries = events.filter(e => e.type === 'llm/retry');
  assert.equal(retries.length, 12);
  assert.deepEqual(retries.slice(0, 6).map(e => e.data.failure.code), ['TRANSPORT', 'STREAM_CLOSED', 'TIMEOUT', 'SERVER', 'RATE_LIMIT', 'EMPTY_RESPONSE']);
  assert.equal(new Set(retries.map(e => e.data.policyKey)).size, 1);
  assert.equal(events.findLast(e => e.type === 'turn/end').data.reason.error.code, 'TRANSPORT');
});

for (const code of ['AUTH', 'QUOTA', 'INVALID_REQUEST', 'CONTENT_REFUSED', 'UNKNOWN']) {
  test(`expanded transient policy still stops on ${code}`, { timeout: 10000 }, async t => {
    const env = await harness(t, [[providerError(code)]], extendedPolicy);
    const events = await run(env.agent);
    assert.equal(env.attempts, 1);
    assert.equal(events.filter(e => e.type === 'llm/retry').length, 0);
    assert.equal(events.findLast(e => e.type === 'turn/end').data.reason.error.code, code);
  });
}

test('successful earlier tool result remains in retry request and tool runs exactly once', { timeout: 10000 }, async t => {
  const env = await harness(t, [
    [block({ type: 'reasoning', text: 'committed reasoning' }), block({ type: 'tool-call', id: 'completed-once', name: 'side_effect', arguments: '{}' }, 1), { ...finish('tool-calls'), replayState: { response: { opaque: 'committed-replay' } } }],
    [overload],
    [block({ type: 'text', text: 'done after existing result' }), finish('stop')],
  ]);
  let calls = 0;
  await env.root.plugin({ inject: ['tools'], apply(ctx) { ctx.tools.register({ name: 'side_effect', description: 'offline counter', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'already-done' }] }, async execute() { calls++; return {}; } }); } });
  const events = await run(env.agent);
  assert.equal(env.attempts, 3); assert.equal(calls, 1);
  assert.equal(events.filter(e => e.type === 'tool/call').length, 1);
  assert.equal(events.filter(e => e.type === 'tool/result').length, 1);
  assert.deepEqual(env.requests[1].messages, env.requests[2].messages);
  assert.ok(env.requests[2].messages.some(m => m.role === 'tool' && m.toolCallId === 'completed-once'));
  const earlierAssistant = env.requests[2].messages.find(m => m.role === 'assistant');
  assert.ok(earlierAssistant.content.some(b => b.type === 'reasoning' && b.text === 'committed reasoning'));
  assert.deepEqual(earlierAssistant.source.replayState, { response: { opaque: 'committed-replay' } });
  assert.equal(events.findLast(e => e.type === 'turn/end').data.reason.kind, 'completed');
});
