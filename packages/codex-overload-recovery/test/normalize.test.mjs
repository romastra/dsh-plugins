import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCodexOverload, normalizeStream } from '../normalize.js';
import { apply } from '../index.js';

const message = 'Codex error: Our servers are currently overloaded. Please try again later.';
const error = (overrides = {}) => ({ type: 'finish', reason: { kind: 'error', failure: { message, code: 'PI_AI_ERROR', ...overrides } } });
const freeze = object => { for (const value of Object.values(object)) if (value && typeof value === 'object') freeze(value); return Object.freeze(object); };
const collect = async stream => { const out = []; for await (const chunk of stream) out.push(chunk); return out; };

for (const text of [message, message.replace('Codex error: ', ''), ` \n${message}\n `, message.replace(' Please', '\nPlease')]) {
  test(`normalizes the exact overload wording: ${JSON.stringify(text)}`, () => {
    const input = freeze(error({ message: text, requestId: 'req-1', providerRetryAfterMs: 1000 }));
    const output = normalizeCodexOverload(input);
    assert.notEqual(output, input);
    assert.equal(output.reason.failure.code, 'SERVER');
    assert.equal(output.reason.failure.message, text);
    assert.equal(output.reason.failure.requestId, 'req-1');
    assert.equal(output.reason.failure.providerRetryAfterMs, 1000);
    assert.equal(input.reason.failure.code, 'PI_AI_ERROR');
  });
}

for (const text of ['Invalid API key', 'Quota exceeded', 'pi-ai response ended pending', 'Our servers are currently overloaded. Invalid credentials.', 'Context window exceeded', `Invalid request: ${message}`, `${message} Quota exceeded.`]) {
  test(`does not retry a different PI_AI_ERROR: ${text}`, () => {
    const input = freeze(error({ message: text }));
    assert.equal(normalizeCodexOverload(input), input);
  });
}

for (const code of ['AUTH', 'QUOTA', 'INVALID_REQUEST', 'SERVER', 'ABORTED', 'CONTEXT_WINDOW_EXCEEDED']) {
  test(`preserves explicit ${code}`, () => {
    const input = freeze(error({ code }));
    assert.equal(normalizeCodexOverload(input), input);
  });
}

for (const status of [400, 401, 403, 413, 429]) {
  test(`does not override explicit HTTP ${status}`, () => {
    const input = freeze(error({ status }));
    assert.equal(normalizeCodexOverload(input), input);
  });
}

test('does not change aborted finishes or a cancelled request', () => {
  const controller = new AbortController(); controller.abort();
  const input = freeze(error());
  assert.equal(normalizeCodexOverload(input, controller.signal), input);
  const aborted = freeze({ type: 'finish', reason: { kind: 'aborted', failure: input.reason.failure } });
  assert.equal(normalizeCodexOverload(aborted), aborted);
});

test('preserves every output delta, tool fragment, success and replay state', async () => {
  const chunks = freeze([
    { type: 'reasoning-delta', index: 0, text: 'opaque-to-test' },
    { type: 'tool-call-delta', index: 1, id: 'call-1', name: 'write', argumentsDelta: '{' },
    { type: 'text-delta', index: 2, text: message },
    { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { opaque: true } } },
  ]);
  const output = await collect(normalizeStream(chunks));
  output.forEach((chunk, index) => assert.equal(chunk, chunks[index]));
});

test('single pass, normalizes only terminal error, never calls the provider twice', async () => {
  let entries = 0, normalized = 0;
  async function* provider() { entries++; yield { type: 'text-delta', index: 0, text: 'partial' }; yield error(); }
  const output = await collect(normalizeStream(provider(), undefined, () => { normalized++; }));
  assert.equal(entries, 1); assert.equal(normalized, 1);
  assert.equal(output.length, 2); assert.equal(output[1].reason.failure.code, 'SERVER');
});

test('thrown middleware errors propagate without a new request and iterator cleanup runs', async () => {
  const sentinel = new Error('extension failure'); let cleaned = false;
  async function* provider() { try { yield { type: 'text-delta', index: 0, text: 'a' }; throw sentinel; } finally { cleaned = true; } }
  await assert.rejects(() => collect(normalizeStream(provider())), value => value === sentinel);
  assert.equal(cleaned, true);
});

test('plugin registration owns cleanup and invokes next exactly once', async () => {
  let listener, tool, removed = false, nextCalls = 0;
  const ctx = {
    on(event, callback) { assert.equal(event, 'llm/stream'); listener = callback; },
    effect(factory) { this.cleanup = factory(); },
    tools: { register(definition) { tool = definition; return () => { removed = true; }; } },
    llm: { providerRetryPolicy() { return { mode: 'normal', maxRetries: 5, retryableCodes: ['SERVER'] }; } },
  };
  apply(ctx);
  const request = freeze({ provider: 'openai-codex', model: 'test', messages: [] });
  await collect(listener(request, () => { nextCalls++; return [error()]; }));
  assert.equal(nextCalls, 1);
  const status = await tool.execute({}, { agent: { model: { current: () => ({ provider: 'openai-codex', model: 'test' }) } } });
  assert.equal(status.normalizedFinishes, 1); assert.equal(status.retryPolicy.maxRetries, 5);
  ctx.cleanup(); assert.equal(removed, true);
});
