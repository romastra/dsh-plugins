import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
const installed = createRequire(join(process.env.DSH_INSTALL_DIR, 'package.json'));
const load = name => installed('@deepseek-ai/' + name);
process.argv.push(join(process.env.DSH_INSTALL_DIR, 'lib/bin.js'));
const native = await import('../index.js');
const { Context } = load('cordis');
const { createUserMessage, createAssistantMessage, createToolResultMessage } = load('dsh-llm');

function response(round, kind = 'text') {
  const reason = { type: 'reasoning', id: 'rs_' + round, summary: [], encrypted_content: 'SCOPED_CIPHER_' + round, status: 'completed' };
  const item = kind === 'tool'
    ? { type: 'function_call', id: 'fc_' + round, call_id: 'call_' + round, name: 'side_effect', arguments: '{}', status: 'completed' }
    : { type: 'message', id: 'msg_' + round, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] };
  return [
    { type: 'response.output_item.added', output_index: 0, item: { ...reason, encrypted_content: undefined } },
    { type: 'response.output_item.done', output_index: 0, item: reason },
    { type: 'response.output_item.added', output_index: 1, item: kind === 'tool' ? { ...item, arguments: '' } : { ...item, content: [] } },
    ...(kind === 'tool' ? [{ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 1, delta: '{}' }] : [
      { type: 'response.content_part.added', item_id: item.id, output_index: 1, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', item_id: item.id, output_index: 1, content_index: 0, delta: 'ok' },
    ]),
    { type: 'response.output_item.done', output_index: 1, item },
    { type: 'response.completed', response: { id: 'resp_' + round, status: 'completed', output: [reason, item], usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 1 } } } },
  ];
}
const reset = () => [{ type: 'error', message: 'upstream connect error or disconnect/reset before headers. retried and the latest reset reason: remote connection failure' }];

async function fixture(t, responses, backoffMs = 1, seed) {
  const base = resolve('codex-native-next/test-state/retry-loop'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'isolated-'));
  const root = new Context();
  let originalFetch = globalThis.fetch;
  let calls = 0, tools = 0; const bodies = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://chatgpt.com/backend-api/codex/responses', 'No external metadata or auth network allowed in this fixture');
    let text = options.body;
    if (typeof text !== 'string') text = (await import('node:zlib')).zstdDecompressSync(text).toString('utf8');
    bodies.push(JSON.parse(text));
    const events = responses[Math.min(calls++, responses.length - 1)];
    return new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
  };
  t.after(async () => { await root.fiber.dispose(); globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); });
  for (const name of ['dsh-session-projection', 'dsh-session', 'dsh-llm', 'dsh-tools', 'dsh-system-prompt', 'dsh-agent', 'dsh-tool-executor-native', 'dsh-llm-retry', 'dsh-agent-loop']) {
    const module = load(name); await root.plugin(module.default ?? module);
  }
  const token = 'header.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-only' } })).toString('base64url') + '.signature';
  const record = { kind: 'grant', payload: { type: 'oauth', access: token, refresh: 'SYNTHETIC_ONLY', expires: Date.now() + 86400000 } };
  await root.plugin({ inject: ['llm', 'sessions', 'sessionProjections', 'tools'], async apply(ctx) {
    const bridge = {
      llm: ctx.llm, sessions: ctx.sessions, sessionProjections: ctx.sessionProjections,
      on: ctx.on.bind(ctx), emit: ctx.emit.bind(ctx), effect: ctx.effect.bind(ctx), get: ctx.get.bind(ctx), waterfall: ctx.waterfall.bind(ctx),
      credentials: { describeRecord: async () => ({ configured: false }), readRecord: async () => record, modifyRecord: async () => { throw Error('No credential writes allowed'); } },
      authorization: { describe: () => ({ inFlight: false }), begin: async () => { throw Error('No login allowed'); } },
      connection: { fetch: { register: () => () => {} } },
    };
    await native.apply(bridge, { stateDirectory: directory, retryPolicy: { mode: 'normal', maxRetries: 2, retryableCodes: ['TRANSPORT', 'STREAM_CLOSED', 'TIMEOUT', 'SERVER'], backoff: { initialDelayMs: backoffMs, maxDelayMs: backoffMs, jitterRatio: 0 } } });
    ctx.tools.register({ name: 'side_effect', description: 'Synthetic counter', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'counter-result' }] }, execute: async () => { tools++; return {}; } });
  } });
  const handle = await root.agents.create({ sessionId: 'native-loop-' + crypto.randomUUID(), ...(seed ? { seed, inheritedEventCount: seed.length, meta: { isSeeded: true } } : {}), agentOptions: { provider: 'openai-codex', model: 'gpt-6.1-sol' } });
  t.after(() => handle.dispose());
  return { root, agent: handle.agent, bodies, get calls() { return calls; }, get tools() { return tools; } };
}
async function run(agent) {
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Synthetic test only' }] }));
  await agent.whenIdle(); return agent.session.snapshotEvents();
}

test('real native owner + pi-ai transport + DSH retry preserve scoped replay and never repeat a successful tool', { timeout: 10000 }, async t => {
  const f = await fixture(t, [response(1, 'tool'), reset(), response(3)]);
  const events = await run(f.agent);
  assert.equal(f.calls, 3); assert.equal(f.tools, 1);
  assert.equal(events.filter(e => e.type === 'turn/start').length, 1);
  assert.equal(events.filter(e => e.type === 'step/start').length, 2);
  assert.equal(events.filter(e => e.type === 'assistant/attempt').length, 1);
  assert.equal(events.filter(e => e.type === 'llm/retry').length, 1);
  assert.equal(events.find(e => e.type === 'llm/retry').data.failure.code, 'TRANSPORT');
  assert.equal(events.findLast(e => e.type === 'turn/end').data.reason.kind, 'completed');
  assert.equal(f.bodies[1].input.some(item => item.encrypted_content === 'SCOPED_CIPHER_1'), true);
  assert.equal(f.bodies[2].input.some(item => item.encrypted_content === 'SCOPED_CIPHER_1'), true);
  assert.equal(f.bodies[2].input.filter(item => item.type === 'function_call_output').length, 1);
  assert.equal(events.findLast(e => e.type === 'assistant/message').data.message.source.replayState.response.kind, 'codex-native');
});

test('stock Pi-ai history is portable on the wire and subsequent native reasoning replays with its own scope', { timeout: 10000 }, async t => {
  const { Session, SessionId } = load('dsh-session');
  const session = Session.create(SessionId('portable-seed'));
  const assistant = createAssistantMessage({
    content: [{ type: 'reasoning', text: 'OLD_UNTRUSTED_REASONING' }, { type: 'text', text: 'visible old answer' }, { type: 'tool-call', id: 'old-call', name: 'side_effect', arguments: '{}' }],
    source: { provider: 'openai-codex', model: 'gpt-6.1-sol', replayState: {
      response: { kind: 'pi-ai', version: 2, provider: 'openai-codex', model: 'gpt-6.1-sol', api: 'openai-codex-responses', stopReason: 'toolUse', responseId: 'OLD_UNTRUSTED_RESPONSE' },
      blocks: [{ type: 'reasoning', thinkingSignature: 'OLD_UNTRUSTED_CIPHER' }, { type: 'text', textSignature: 'OLD_UNTRUSTED_SIGNATURE' }, { type: 'tool-call', namespace: 'OLD_UNTRUSTED_NAMESPACE' }],
    } },
  });
  session.append('turn/start', { turn: 1 });
  session.append('step/start', { turn: 1, step: 1 });
  session.append('assistant/message', { turn: 1, step: 1, message: assistant, stream: [] }, { surfaceOp: 'append' });
  session.append('tool/call', { turn: 1, step: 1, callId: 'old-call', name: 'side_effect', arguments: '{}' });
  session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: 'old-call', content: [{ type: 'text', text: 'old tool result' }], isError: false }) }, { surfaceOp: 'append' });
  session.append('step/end', { turn: 1, step: 1 });
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const seed = session.snapshotEvents(); const before = JSON.stringify(seed);
  const f = await fixture(t, [response(1, 'tool'), response(2)], 1, seed);
  const events = await run(f.agent);
  assert.equal(events.findLast(e => e.type === 'turn/end').data.reason.kind, 'completed');
  assert.equal(f.tools, 1, 'previous imported tool is not executed a second time');
  assert.equal(JSON.stringify(f.bodies).includes('OLD_UNTRUSTED'), false);
  assert.equal(JSON.stringify(f.bodies[0]).includes('visible old answer'), true);
  assert.equal(f.bodies[0].input.filter(item => item.type === 'function_call_output').length, 1);
  assert.equal(f.bodies[1].input.some(item => item.encrypted_content === 'SCOPED_CIPHER_1'), true);
  assert.equal(JSON.stringify(seed), before, 'persisted source history is not rewritten');
});

test('a partial failed native tool response is diagnostic only and never executes its tool', { timeout: 10000 }, async t => {
  const partial = [...response(2, 'tool').slice(0, -1), ...reset()];
  const f = await fixture(t, [response(1, 'tool'), partial, response(3)]);
  const events = await run(f.agent);
  assert.equal(f.calls, 3); assert.equal(f.tools, 1);
  assert.equal(events.filter(e => e.type === 'tool/call').length, 1);
  assert.equal(events.filter(e => e.type === 'assistant/attempt').length, 1);
  assert.equal(JSON.stringify(f.bodies[2]).includes('SCOPED_CIPHER_2'), false);
  assert.equal(JSON.stringify(f.bodies[2]).includes('call_2'), false);
  assert.equal(events.findLast(e => e.type === 'turn/end').data.reason.kind, 'completed');
});

for (const [message, code] of [['401 invalid credentials', 'AUTH'], ['insufficient_quota', 'QUOTA']]) {
  test(`native owner never retries permanent ${code}`, { timeout: 10000 }, async t => {
    const f = await fixture(t, [[{ type: 'error', message }]]);
    const events = await run(f.agent);
    assert.equal(f.calls, 1);
    assert.equal(events.filter(e => e.type === 'llm/retry').length, 0);
    assert.equal(events.findLast(e => e.type === 'turn/end').data.reason.error.code, code);
  });
}

test('native retry budget is finite and cancellation interrupts its wait', { timeout: 10000 }, async t => {
  const f = await fixture(t, [reset()]);
  const events = await run(f.agent);
  assert.equal(f.calls, 3);
  assert.equal(events.filter(e => e.type === 'llm/retry').length, 2);
  assert.equal(events.findLast(e => e.type === 'turn/end').data.reason.error.code, 'TRANSPORT');
});

test('native retry wait honours Stop', { timeout: 10000 }, async t => {
  const f = await fixture(t, [reset()], 1000);
  f.root.on('session/event', (_session, event) => { if (event.type === 'llm/retry') queueMicrotask(() => f.agent.cancel({ kind: 'user' })); });
  const events = await run(f.agent);
  assert.equal(f.calls, 1);
  assert.equal(events.filter(e => e.type === 'llm/retry-started').length, 0);
  assert.equal(events.findLast(e => e.type === 'turn/end').data.reason.kind, 'aborted');
});
