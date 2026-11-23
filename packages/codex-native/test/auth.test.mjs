import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthBroker } from '../src/auth.js';

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(begin, extra = {}) {
  let time = 1000, serial = 0, timerId = 0;
  const scheduled = new Map();
  const calls = [];
  const broker = createAuthBroker({
    authorization: { begin(request) { calls.push(request); return begin(request); } },
    now: () => time,
    idFactory: () => 'attempt-' + (++serial),
    timers: {
      setTimeout(callback, ms) { const id = ++timerId; scheduled.set(id, { callback, at: time + ms }); return id; },
      clearTimeout(id) { scheduled.delete(id); },
    },
    ...extra,
  });
  return { broker, calls, scheduled, advance(ms, run = true) {
    time += ms;
    if (run) for (const [id, timer] of [...scheduled]) if (timer.at <= time) { scheduled.delete(id); timer.callback(); }
  } };
}
const hasCode = code => error => error?.code === code && error.message === 'Authorization interaction could not continue.';
// Keep fixture answers and provider text out of assertion diagnostics as well as snapshots.
const privateValue = () => ['fixture', 'private', 'answer'].join('-');
const isPrivateFree = value => !JSON.stringify(value).includes(privateValue());

test('start is synchronous, fence awaited exactly once, complete follows authorized hook', async () => {
  const fence = deferred(), authorized = deferred();
  let starts = 0, finishes = 0;
  const f = fixture(() => ({ status: 'authorized' }), {
    onStarting: async () => { starts++; await fence.promise; },
    onAuthorized: async () => { finishes++; await authorized.promise; },
  });
  assert.deepEqual(f.broker.status(), { state: 'idle' });
  const result = f.broker.start();
  assert.deepEqual(result, { id: 'attempt-1', state: 'pending', prompts: [], notices: [] });
  assert.equal(f.calls.length, 0);
  assert.throws(() => f.broker.start(), hasCode('AUTH_BUSY'));
  await flush();
  assert.equal(starts, 1);
  assert.equal(f.calls.length, 0);
  fence.resolve();
  await flush();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].key, 'llm-pi-ai/openai-codex');
  assert.equal(f.calls[0].method, 'oauth');
  assert.equal(f.calls[0].signal.aborted, false);
  assert.equal(finishes, 1);
  assert.equal(f.broker.poll(result.id).state, 'pending');
  authorized.resolve();
  await flush();
  assert.equal(f.broker.poll(result.id).state, 'complete');
  assert.equal(f.scheduled.size, 0);
  f.broker.dispose();
});

test('text and secret answers are one-shot, validated, never retained or echoed', async () => {
  let received = 0;
  const f = fixture(async ({ interaction }) => {
    for (const kind of ['text', 'secret']) {
      const value = await interaction.prompt({ kind, message: privateValue(), placeholder: privateValue(), default: privateValue() });
      if (value === privateValue()) received++;
    }
    return { status: 'authorized' };
  });
  const { id } = f.broker.start();
  await flush();
  for (const type of ['input', 'secret']) {
    const state = f.broker.poll(id), prompt = state.prompts[0];
    assert.equal(prompt.type, type);
    assert.equal(isPrivateFree(state), true);
    assert.throws(() => f.broker.answer('missing', prompt.id, privateValue()), hasCode('AUTH_NOT_FOUND'));
    assert.throws(() => f.broker.answer(id, 'wrong', privateValue()), hasCode('AUTH_PROMPT_MISMATCH'));
    for (const answer of [null, {}, true, '', 'x'.repeat(4097), 'line\nbreak']) {
      assert.throws(() => f.broker.answer(id, prompt.id, answer), hasCode('AUTH_INVALID_ANSWER'));
    }
    const after = f.broker.answer(id, prompt.id, privateValue());
    assert.equal(isPrivateFree(after), true);
    assert.equal(after.prompts.length, 0);
    assert.throws(() => f.broker.answer(id, prompt.id, privateValue()), hasCode('AUTH_PROMPT_MISMATCH'));
    await flush();
  }
  assert.equal(received, 2);
  assert.equal(f.broker.poll(id).state, 'complete');
  assert.equal(isPrivateFree(f.broker.poll(id)), true);
  f.broker.dispose();
});

test('select opaque IDs map privately to native values and confirm accepts only boolean', async () => {
  let selected = false, confirmed = false;
  const f = fixture(async ({ interaction }) => {
    selected = await interaction.prompt({ kind: 'select', message: privateValue(), options: [
      { value: privateValue(), label: privateValue() }, { value: 'other', label: 'Other' },
    ] }) === privateValue();
    confirmed = await interaction.prompt({ kind: 'confirm', message: privateValue() });
    return { status: 'authorized' };
  });
  const { id } = f.broker.start(); await flush();
  const state = f.broker.poll(id), prompt = state.prompts[0];
  assert.equal(prompt.type, 'select');
  assert.equal(isPrivateFree(state), true);
  assert.throws(() => f.broker.answer(id, prompt.id, privateValue()), hasCode('AUTH_INVALID_ANSWER'));
  prompt.options[0].label = 'mutated';
  assert.equal(f.broker.poll(id).prompts[0].options[0].label, 'Option 1');
  f.broker.answer(id, prompt.id, prompt.options[0].id); await flush();
  const confirm = f.broker.poll(id).prompts[0];
  assert.equal(confirm.type, 'confirm');
  assert.throws(() => f.broker.answer(id, confirm.id, 'true'), hasCode('AUTH_INVALID_ANSWER'));
  f.broker.answer(id, confirm.id, false); await flush();
  assert.equal(selected, true);
  assert.equal(confirmed, false);
  assert.equal(f.broker.poll(id).state, 'complete');
  f.broker.dispose();
});

test('official OpenAI select and DSH unchanged options relay support browser and device code', async () => {
  // No provider/runtime imports: exact native selector fixture with transport stubbed.
  // dsh-llm-pi-ai restate forwards options untouched and changes type to kind;
  // dsh-authorization session.prompt forwards that neutral prompt untouched.
  for (const chosen of ['browser', 'device_code']) {
    let matched = false;
    const f = fixture(async ({ interaction }) => {
      const nativePrompt = {
        type: 'select',
        message: 'Select OpenAI Codex login method:',
        options: [
          { id: 'browser', label: 'Browser login (default)' },
          { id: 'device_code', label: 'Device code login (headless)' },
        ],
      };
      const session = { prompt: request => interaction.prompt(request).catch(error => { throw error; }) };
      const result = await session.prompt({
        ...(nativePrompt.signal === undefined ? {} : { signal: nativePrompt.signal }),
        kind: 'select',
        message: nativePrompt.message,
        options: nativePrompt.options,
      });
      matched = result === chosen;
      return { status: 'authorized' };
    });
    const { id } = f.broker.start(); await flush();
    const prompt = f.broker.poll(id).prompts[0];
    assert.equal(prompt.type, 'select');
    assert.deepEqual(prompt.options, [
      { id: 'option-1', label: 'Browser login' },
      { id: 'option-2', label: 'Device code login' },
    ]);
    assert.throws(() => f.broker.answer(id, prompt.id, chosen), hasCode('AUTH_INVALID_ANSWER'));
    f.broker.answer(id, prompt.id, chosen === 'browser' ? 'option-1' : 'option-2');
    await flush();
    assert.equal(matched, true);
    assert.equal(f.broker.poll(id).state, 'complete');
    f.broker.dispose();
  }
});

test('unknown native ID labels and values stay private; agreeing dual fields are accepted', async () => {
  let received = false;
  const f = fixture(async ({ interaction }) => {
    received = await interaction.prompt({ kind: 'select', options: [
      { id: privateValue(), label: privateValue() },
      { id: 'browser', value: 'browser', label: privateValue() },
    ] }) === privateValue();
    return { status: 'authorized' };
  });
  const { id } = f.broker.start(); await flush();
  const state = f.broker.poll(id), prompt = state.prompts[0];
  assert.equal(isPrivateFree(state), true);
  assert.equal(prompt.options[0].label, 'Option 1');
  assert.equal(prompt.options[1].label, 'Browser login');
  f.broker.answer(id, prompt.id, prompt.options[0].id); await flush();
  assert.equal(received, true);
  assert.equal(f.broker.poll(id).state, 'complete');
  f.broker.dispose();
});

test('simultaneous prompts fail closed rather than replacing or bypassing pending input', async () => {
  const f = fixture(async ({ interaction }) => {
    const first = interaction.prompt({ kind: 'secret' });
    const second = interaction.prompt({ kind: 'text' });
    await Promise.allSettled([first, second]);
    return { status: 'authorized' };
  });
  const { id } = f.broker.start(); await flush();
  const state = f.broker.poll(id);
  assert.equal(state.state, 'error');
  assert.equal(state.errorCode, 'AUTH_CONCURRENT_PROMPT');
  assert.deepEqual(state.prompts, []);
  assert.equal(f.calls[0].signal.aborted, true);
  f.broker.dispose();
});

test('unsupported kinds and malformed options fail closed with static codes', async () => {
  for (const request of [
    { kind: 'html', message: privateValue() },
    { type: 'input' },
    { kind: 'select', options: [] },
    { kind: 'select', options: new Array(33).fill({ value: 'x' }) },
    { kind: 'select', options: [{ value: 'same' }, { value: 'same' }] },
    { kind: 'select', options: [{ value: {} }] },
    { kind: 'select', options: [{ id: 'browser', value: 'device_code' }] },
    { kind: 'select', options: [{ id: 'browser' }, { value: 'browser' }] },
    { kind: 'select', options: [{ id: {} }] },
    { kind: 'select', options: [{ id: '' }] },
  ]) {
    const f = fixture(async ({ interaction }) => { await interaction.prompt(request); return { status: 'authorized' }; });
    const { id } = f.broker.start(); await flush();
    assert.equal(f.broker.poll(id).errorCode, 'AUTH_UNSUPPORTED_PROMPT');
    assert.equal(isPrivateFree(f.broker.poll(id)), true);
    f.broker.dispose();
  }
});

test('prompt-scoped abort withdraws question without cancelling browser callback winner', async () => {
  const control = new AbortController();
  let rejected = false;
  const finish = deferred();
  const f = fixture(async ({ interaction }) => {
    try { await interaction.prompt({ kind: 'text', signal: control.signal }); }
    catch (error) { rejected = hasCode('AUTH_WITHDRAWN')(error); }
    await finish.promise;
    return { status: 'authorized' };
  });
  const { id } = f.broker.start(); await flush();
  const promptId = f.broker.poll(id).prompts[0].id;
  control.abort(new Error(privateValue())); await flush();
  assert.equal(rejected, true);
  assert.deepEqual(f.broker.poll(id).prompts, []);
  assert.equal(f.broker.poll(id).state, 'pending');
  assert.throws(() => f.broker.answer(id, promptId, privateValue()), hasCode('AUTH_PROMPT_MISMATCH'));
  finish.resolve(); await flush();
  assert.equal(f.broker.poll(id).state, 'complete');
  f.broker.dispose();
});

test('notices allow only official HTTPS authorize/device URLs and bounded static content', async () => {
  let interaction;
  const pending = deferred();
  const f = fixture(request => { interaction = request.interaction; return pending.promise; });
  const { id } = f.broker.start(); await flush();
  const valid = 'https://auth.openai.com/oauth/authorize?state=fixture-state&code_challenge=fixture-challenge&response_type=code';
  interaction.notify({ url: valid, message: privateValue() });
  const first = f.broker.poll(id);
  assert.equal(first.notices[0].url, valid);
  assert.equal(isPrivateFree(first), true);
  first.notices[0].url = 'changed';
  assert.equal(f.broker.poll(id).notices[0].url, valid);
  for (const url of [
    'http://auth.openai.com/authorize', 'javascript:alert(1)', 'https://evil.test/authorize',
    'https://auth.openai.com.evil.test/authorize', 'https://fixture@auth.openai.com/authorize',
    'https://auth.openai.com:444/authorize', 'https://auth.openai.com/authorize#fragment',
    'https://auth.openai.com/authorize?access_token=fixture', 'https://auth.openai.com/arbitrary',
    'https://auth.openai.com/device?code=fixture', 'https://auth.openai.com/authorize?<html>',
  ]) {
    interaction.notify({ url, message: privateValue(), code: privateValue() });
    const notice = f.broker.poll(id).notices.at(-1);
    assert.equal(Object.hasOwn(notice, 'url'), false);
    assert.equal(Object.hasOwn(notice, 'code'), false);
    assert.equal(isPrivateFree(notice), true);
  }
  assert.equal(f.broker.poll(id).notices.length, 8);
  interaction.notify({ url: 'https://auth.openai.com/codex/device', code: 'ABCD-EFGH', message: '<b>ignored</b>' });
  assert.equal(f.broker.poll(id).notices.at(-1).code, 'ABCD-EFGH');
  pending.resolve({ status: 'authorized' }); await flush();
  assert.deepEqual(f.broker.poll(id).notices, []);
  f.broker.dispose();
});

test('cancel rejects prompt generically, clears sensitive UI and timer, late completion cannot win', async () => {
  let rejected = false;
  const f = fixture(async ({ interaction }) => {
    interaction.notify({ url: 'https://auth.openai.com/authorize?state=fixture-state' });
    try { await interaction.prompt({ kind: 'secret' }); }
    catch (error) { rejected = hasCode('AUTH_WITHDRAWN')(error); }
    return { status: 'authorized' };
  });
  const { id } = f.broker.start(); await flush();
  assert.equal(f.broker.poll(id).prompts.length, 1);
  assert.deepEqual(f.broker.cancel(id), { id, state: 'cancelled', prompts: [], notices: [] });
  assert.equal(f.scheduled.size, 0);
  await flush();
  assert.equal(rejected, true);
  assert.equal(f.broker.poll(id).state, 'cancelled');
  assert.equal(f.calls[0].signal.aborted, true);
  f.broker.dispose();
});

test('cancel before fence finishes never calls authorization service', async () => {
  const fence = deferred();
  const f = fixture(() => ({ status: 'authorized' }), { onStarting: () => fence.promise });
  const { id } = f.broker.start(); await flush();
  f.broker.cancel(id);
  assert.throws(() => f.broker.start(), hasCode('AUTH_BUSY'));
  fence.resolve(); await flush();
  assert.equal(f.calls.length, 0);
  assert.equal(f.broker.poll(id).state, 'cancelled');
  f.broker.dispose();
});

test('default timeout is 15 minutes, expires pending input and terminal history TTL', async () => {
  const f = fixture(async ({ interaction }) => {
    await interaction.prompt({ kind: 'text' });
    return { status: 'authorized' };
  });
  const { id } = f.broker.start(); await flush();
  const timer = [...f.scheduled.values()][0];
  assert.equal(timer.at, 1000 + 15 * 60 * 1000);
  f.advance(15 * 60 * 1000);
  const state = f.broker.poll(id);
  assert.equal(state.state, 'error');
  assert.equal(state.errorCode, 'AUTH_TIMEOUT');
  assert.deepEqual(state.prompts, []);
  assert.equal(f.scheduled.size, 0);
  await flush();
  f.advance(15 * 60 * 1000);
  assert.throws(() => f.broker.poll(id), hasCode('AUTH_NOT_FOUND'));
  assert.deepEqual(f.broker.status(), { state: 'idle' });
  f.broker.dispose();
});

test('clock deadline prevents late answers even if timer callback has not fired', async () => {
  const f = fixture(async ({ interaction }) => { await interaction.prompt({ kind: 'text' }); }, { timeoutMs: 50 });
  const { id } = f.broker.start(); await flush();
  const prompt = f.broker.poll(id).prompts[0];
  f.advance(50, false);
  assert.throws(() => f.broker.answer(id, prompt.id, privateValue()), hasCode('AUTH_PROMPT_MISMATCH'));
  assert.equal(f.broker.poll(id).errorCode, 'AUTH_TIMEOUT');
  await flush(); f.broker.dispose();
});

test('provider failures, hook failures, and uncommitted results expose no raw errors', async () => {
  const cases = [
    { begin: () => { throw Object.assign(new Error(privateValue()), { code: privateValue() }); }, expected: 'AUTH_FAILED' },
    { begin: () => Promise.reject(Object.assign(new Error(privateValue()), { code: 'NO_FLOW' })), expected: 'AUTH_UNAVAILABLE' },
    { begin: () => ({ status: 'unknown', message: privateValue() }), expected: 'AUTH_NOT_COMMITTED' },
    { begin: () => undefined, expected: 'AUTH_NOT_COMMITTED' },
    { begin: () => ({ status: 'authorized' }), extra: { onStarting() { throw new Error(privateValue()); } }, expected: 'AUTH_FAILED' },
    { begin: () => ({ status: 'authorized' }), extra: { onAuthorized: () => Promise.reject(new Error(privateValue())) }, expected: 'AUTH_FAILED' },
  ];
  for (const item of cases) {
    const f = fixture(item.begin, item.extra);
    const { id } = f.broker.start(); await flush();
    const state = f.broker.poll(id);
    assert.equal(state.state, 'error');
    assert.equal(state.errorCode, item.expected);
    assert.equal(isPrivateFree(state), true);
    assert.equal(Object.hasOwn(state, 'message'), false);
    f.broker.dispose();
  }
});

test('official cancelled result is not success and does not invoke authorized hook', async () => {
  let authorized = 0;
  const f = fixture(() => ({ status: 'cancelled' }), { onAuthorized() { authorized++; } });
  const { id } = f.broker.start(); await flush();
  assert.equal(f.broker.poll(id).state, 'cancelled');
  assert.equal(authorized, 0);
  f.broker.dispose();
});

test('reauth gate, bounded history, safe old polls and id validation', async () => {
  const f = fixture(() => ({ status: 'authorized' }));
  const old = f.broker.start(); await flush();
  const next = f.broker.start();
  assert.equal(f.broker.poll(old.id).state, 'complete');
  assert.equal(f.broker.poll(next.id).state, 'pending');
  assert.throws(() => f.broker.start(), hasCode('AUTH_BUSY'));
  await flush();
  for (let i = 0; i < 16; i++) { f.broker.start(); await flush(); }
  assert.throws(() => f.broker.poll(old.id), hasCode('AUTH_NOT_FOUND'));
  f.broker.dispose();
  const bad = fixture(() => {}, { idFactory: () => '<unsafe>' });
  assert.throws(() => bad.broker.start(), hasCode('INVALID_ID'));
  bad.broker.dispose();
  assert.throws(() => createAuthBroker({ authorization: { begin() {} }, timeoutMs: 900001 }), hasCode('INVALID_CONFIG'));
});

test('dispose is idempotent, aborts active flow, forgets history and refuses restart', async () => {
  const f = fixture(async ({ interaction }) => { await interaction.prompt({ kind: 'secret' }); });
  const { id } = f.broker.start(); await flush();
  f.broker.dispose(); f.broker.dispose(); await flush();
  assert.equal(f.calls[0].signal.aborted, true);
  assert.equal(f.scheduled.size, 0);
  assert.deepEqual(f.broker.status(), { state: 'idle' });
  assert.throws(() => f.broker.poll(id), hasCode('AUTH_NOT_FOUND'));
  assert.throws(() => f.broker.start(), hasCode('AUTH_DISPOSED'));
});

test('malformed native signal cannot be swallowed to bypass the interaction guard', async () => {
  const f = fixture(async ({ interaction }) => {
    try { await interaction.prompt({ kind: 'text', signal: {} }); } catch {}
    return { status: 'authorized' };
  });
  const { id } = f.broker.start(); await flush();
  assert.equal(f.broker.poll(id).state, 'error');
  assert.equal(f.broker.poll(id).errorCode, 'AUTH_UNSUPPORTED_PROMPT');
  f.broker.dispose();
});

test('a cancelled but still-running service cannot race a replacement attempt', async () => {
  const finish = deferred();
  const f = fixture(() => finish.promise);
  const { id } = f.broker.start(); await flush();
  f.broker.cancel(id);
  assert.throws(() => f.broker.start(), hasCode('AUTH_BUSY'));
  finish.resolve({ status: 'authorized' }); await flush();
  const replacement = f.broker.start();
  assert.equal(replacement.state, 'pending');
  assert.equal(f.broker.poll(id).state, 'cancelled');
  await flush(); f.broker.dispose();
});

test('prompt count has a strict per-attempt ceiling', async () => {
  const f = fixture(async ({ interaction }) => {
    for (let i = 0; i < 129; i++) await interaction.prompt({ kind: 'confirm' });
    return { status: 'authorized' };
  });
  const { id } = f.broker.start(); await flush();
  for (let i = 0; i < 128; i++) {
    const prompt = f.broker.poll(id).prompts[0];
    assert.equal(prompt.type, 'confirm');
    f.broker.answer(id, prompt.id, true); await flush();
  }
  assert.equal(f.broker.poll(id).state, 'error');
  assert.equal(f.broker.poll(id).errorCode, 'AUTH_UNSUPPORTED_PROMPT');
  f.broker.dispose();
});

test('isRunning reports unsettled detached hooks and flow independently of public state', async () => {
  const fence = deferred(), flow = deferred(), authorized = deferred();
  const f = fixture(() => flow.promise, {
    onStarting: () => fence.promise,
    onAuthorized: () => authorized.promise,
  });
  assert.equal(f.broker.isRunning(), false);
  f.broker.start();
  assert.equal(f.broker.isRunning(), true);
  await flush();
  assert.equal(f.calls.length, 0);
  assert.equal(f.broker.isRunning(), true);
  fence.resolve(); await flush();
  assert.equal(f.broker.isRunning(), true);
  flow.resolve({ status: 'authorized' }); await flush();
  assert.equal(f.broker.isRunning(), true);
  authorized.resolve(); await flush();
  assert.equal(f.broker.isRunning(), false);
  f.broker.dispose();

  for (const ending of ['cancel', 'timeout', 'dispose']) {
    const unsettled = deferred();
    const pending = fixture(() => unsettled.promise, { timeoutMs: 50 });
    const { id } = pending.broker.start(); await flush();
    if (ending === 'cancel') pending.broker.cancel(id);
    if (ending === 'timeout') pending.advance(50);
    if (ending === 'dispose') pending.broker.dispose();
    assert.equal(pending.broker.isRunning(), true);
    assert.notEqual(pending.broker.status().state, 'pending');
    unsettled.resolve({ status: 'cancelled' }); await flush();
    assert.equal(pending.broker.isRunning(), false);
    pending.broker.dispose();
  }
});

test('ignored prompt rejection and detached flow rejection never become unhandled', async () => {
  let unhandled = 0;
  const listener = () => { unhandled++; };
  process.on('unhandledRejection', listener);
  try {
    const f = fixture(({ interaction }) => { interaction.prompt({ kind: 'html' }); return Promise.reject(new Error(privateValue())); });
    f.broker.start(); await flush();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(unhandled, 0);
    f.broker.dispose();
  } finally { process.off('unhandledRejection', listener); }
});
