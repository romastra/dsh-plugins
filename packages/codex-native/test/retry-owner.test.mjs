import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { nativeRetryPolicy, NATIVE_RETRY_DEFAULT } from '../src/retry-policy.js';
import { unwrapMessages, wrapReplayState } from '../src/scope.js';

const installed = createRequire(join(process.env.DSH_INSTALL_DIR, 'package.json'));
const { resolveRetryPolicy } = installed('@deepseek-ai/dsh-llm');
process.argv.push(join(process.env.DSH_INSTALL_DIR, 'lib/bin.js'));
const rootDir = resolve('codex-native-next/test-state/retry-owner');

const route = { provider: 'openai-codex', model: 'gpt-6.1-sol' };
function rawMessage() {
  return { role: 'assistant', content: [{ type: 'reasoning', text: 'UNTRUSTED_REASONING' }, { type: 'text', text: 'visible' }, { type: 'tool-call', id: 'call-kept', name: 'probe', arguments: '{}' }],
    source: { kind: 'model', ...route, replayState: { response: { kind: 'pi-ai', version: 2, ...route, api: 'openai-codex-responses', stopReason: 'toolUse', responseId: 'UNTRUSTED_RESPONSE' }, blocks: [{ type: 'reasoning', thinkingSignature: 'UNTRUSTED_CIPHER' }, { type: 'text', textSignature: 'UNTRUSTED_SIGNATURE' }, { type: 'tool-call', thoughtSignature: 'UNTRUSTED_THOUGHT' }] } } };
}
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

test('native retry default is finite, transient-only and captured immutably', () => {
  const p = nativeRetryPolicy({}, resolveRetryPolicy);
  assert.equal(p.maxRetries, 12); assert.equal(p.initialDelayMs, 2000); assert.equal(p.maxDelayMs, 60000);
  assert.equal(p.mode, 'normal'); assert.equal(Object.isFrozen(p), true);
  assert.deepEqual([...p.retryableCodes], [...NATIVE_RETRY_DEFAULT.retryableCodes]);
  assert.equal(p.retryableCodes.some(code => ['AUTH', 'QUOTA', 'PI_AI_ERROR', 'UNKNOWN', 'CODEX_REPLAY_SCOPE_MISMATCH'].includes(code)), false);
  assert.equal(nativeRetryPolicy({ retryPolicy: { mode: 'normal', maxRetries: 0 } }, resolveRetryPolicy).maxRetries, 0);
  assert.throws(() => nativeRetryPolicy({ allowPortablePiAiHistory: 'true' }, resolveRetryPolicy), /must be boolean/);
});

test('only explicit compatibility permits validated stock replay; request and log remain separate', () => {
  const msg = freeze(rawMessage());
  const result = freeze({ role: 'tool', toolCallId: 'call-kept', content: [{ type: 'text', text: 'tool result' }] });
  const history = freeze([msg, result]);
  assert.throws(() => unwrapMessages(history, 'current-scope', route), { code: 'CODEX_REPLAY_UNVERIFIED' });
  const portable = unwrapMessages(history, 'current-scope', { ...route, allowPortablePiAiHistory: true });
  assert.equal(portable[1], result);
  assert.deepEqual(portable[0].content.map(block => block.type), ['text', 'tool-call']);
  assert.equal(portable[0].content[1], msg.content[2]);
  assert.equal(portable[0].source.replayState, undefined);
  assert.equal(JSON.stringify(portable).includes('UNTRUSTED'), false);
  assert.equal(msg.source.replayState.response.kind, 'pi-ai');
});

for (const field of ['version', 'model', 'api', 'blocks', 'signature']) {
  test(`portable conversion rejects malformed ${field}`, () => {
    const m = rawMessage();
    if (field === 'version') m.source.replayState.response.version = 123;
    if (field === 'model') m.source.replayState.response.model = 'wrong-model';
    if (field === 'api') m.source.replayState.response.api = 'wrong-api';
    if (field === 'blocks') m.source.replayState.blocks.pop();
    if (field === 'signature') m.source.replayState.blocks[0].thinkingSignature = {};
    assert.throws(() => unwrapMessages([m], 'current-scope', { ...route, allowPortablePiAiHistory: true }));
  });
}

test('compatibility never adopts another native account/generation or malformed native envelope', () => {
  const m = rawMessage();
  m.source.replayState = wrapReplayState(m.source.replayState, 'different-scope');
  assert.throws(() => unwrapMessages([m], 'current-scope', { ...route, allowPortablePiAiHistory: true }), { code: 'CODEX_REPLAY_SCOPE_MISMATCH' });
  m.source.replayState.response.version = 77;
  assert.throws(() => unwrapMessages([m], 'current-scope', { ...route, allowPortablePiAiHistory: true }), { code: 'CODEX_REPLAY_INVALID' });
});

for (const entry of ['index.js', 'acp.js']) {
  test(`actual ${entry} publishes native policy and preserves it on a clean reload`, { timeout: 10000 }, async t => {
    await mkdir(rootDir, { recursive: true });
    const dir = await mkdtemp(join(rootDir, 'fixture-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const native = await import(pathToFileURL(resolve('codex-native-next', entry)).href);
    let adapter; const disposers = [];
    const ctx = {
      on: () => () => {},
      effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') disposers.push(cleanup); return cleanup; },
      credentials: { describeRecord: async () => ({ configured: false }), readRecord: async () => { throw Error('Unexpected credential read'); }, modifyRecord: async () => { throw Error('Unexpected credential write'); } },
      authorization: { describe: () => ({ inFlight: false }), begin: async () => { throw Error('Unexpected login'); } },
      sessionProjections: { register: async () => ({ stateOf: () => ({}) }) },
      sessions: { get: () => undefined },
      llm: { registerAdapter(providers, value) { assert.deepEqual(providers, ['openai-codex']); adapter = value; return () => {}; } },
      connection: { fetch: { register: () => () => {} } },
      get: () => undefined,
    };
    try {
      await native.apply(ctx, { stateDirectory: dir });
      assert.equal(adapter.providerRetryPolicy('openai-codex').maxRetries, 12);
      const generationBefore = await readFile(join(dir, 'grant-generation.json'), 'utf8');
      for (const dispose of disposers.splice(0).reverse()) await dispose();
      await native.apply(ctx, { stateDirectory: dir, retryPolicy: { mode: 'normal', maxRetries: 0 } });
      assert.equal(adapter.providerRetryPolicy('openai-codex').maxRetries, 0);
      assert.equal(await readFile(join(dir, 'grant-generation.json'), 'utf8'), generationBefore);
    } finally { for (const dispose of disposers.splice(0).reverse()) await dispose(); }
  });
}
