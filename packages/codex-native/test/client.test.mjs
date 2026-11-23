import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlugin, createCodexApi, createAuthStore, publicAuth, safeAuthUrl, speedView, createReportedTierDefinition, reportedTierFromSource, buildPriorityRailCss, cssString, REPORTED_TIER_KEY } from '../src/client.js';

const idle = () => ({ id: null, state: 'idle', prompts: [], notices: [] });
const pending = (prompt = { id: 'prompt-1', type: 'input', message: 'Paste callback once' }) => ({ id: 'flow-1', state: 'pending', prompts: [prompt], notices: [{ message: '<img src=x onerror=bad()>', url: 'https://auth.openai.com/codex/device', code: 'ABCD-EFGH' }] });
const ok = value => ({ ok: true, value });
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred() { let resolve; let reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
function timers() {
  let next = 0;
  const queue = new Map();
  return { queue, later(fn) { queue.set(++next, fn); return next; }, cancel(id) { queue.delete(id); }, fire() { const [id, fn] = queue.entries().next().value; queue.delete(id); return fn(); } };
}
function rpcFixture() {
  const calls = [];
  let flow = idle();
  let authenticated = false;
  let fastAvailable = true;
  const tiers = new Map();
  const rpc = { async call(path, endpoint, args) {
    calls.push({ path, endpoint, args });
    switch (endpoint) {
      case 'codex-native.status': return ok({ nonce: 'nonce-1', authenticated, auth: flow, accessToken: 'DO_NOT_RENDER' });
      case 'codex-native.capabilitiesRefresh': fastAvailable = true; return ok({ checked: true, models: 7, accessToken: 'DO_NOT_RENDER' });
      case 'codex-native.speed': return ok({ tier: tiers.get(args.sessionId) ?? 'standard', fastAvailable });
      case 'codex-native.setSpeed': tiers.set(args.sessionId, args.tier); return ok({ tier: args.tier, fastAvailable });
      case 'codex-native.authStart': flow = pending(); return ok(flow);
      case 'codex-native.authPoll': return ok(flow);
      case 'codex-native.authAnswer': flow = { ...idle(), id: 'flow-1', state: 'complete' }; authenticated = true; return ok(flow);
      case 'codex-native.authCancel': flow = { ...idle(), id: 'flow-1', state: 'cancelled' }; return ok(flow);
      default: throw new Error('Unexpected endpoint');
    }
  } };
  return { rpc, calls, setFlow(value) { flow = value; }, setAuthenticated(value) { authenticated = value; }, setFast(value) { fastAvailable = value; } };
}

// Small deterministic hooks renderer: no React package, DOM, network or model requests.
function fakeReact() {
  const componentCells = new Map();
  let cells = [];
  let cursor = 0;
  let effects = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((item, i) => Object.is(item, b[i]));
  const React = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children: children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false) }; },
    useState(initial) { const i = cursor++; if (!cells[i]) cells[i] = { value: typeof initial === 'function' ? initial() : initial }; const cell = cells[i]; return [cell.value, value => { cell.value = typeof value === 'function' ? value(cell.value) : value; }]; },
    useRef(initial) { const i = cursor++; if (!cells[i]) cells[i] = { current: initial }; return cells[i]; },
    useId() { const i = cursor++; return 'fake-id-' + i; },
    useMemo(fn, deps) { const i = cursor++; if (!same(cells[i]?.deps, deps)) cells[i] = { deps, value: fn() }; return cells[i].value; },
    useCallback(fn, deps) { return React.useMemo(() => fn, deps); },
    useSyncExternalStore(subscribe, snapshot) { return snapshot(); },
    useEffect(fn, deps) { const i = cursor++; if (!same(cells[i]?.deps, deps)) { const cleanup = cells[i]?.cleanup; const cell = { deps }; cells[i] = cell; effects.push(() => { cleanup?.(); cell.cleanup = fn(); }); } },
  };
  return { React, render(Component, props = {}) { cursor = 0; if (!componentCells.has(Component)) componentCells.set(Component, []); cells = componentCells.get(Component); return Component(props); }, async flush() { const pendingEffects = effects; effects = []; for (const effect of pendingEffects) effect(); await tick(); }, unmount() { for (const list of componentCells.values()) for (const cell of list) cell?.cleanup?.(); } };
}
function walk(tree) { return tree && typeof tree === 'object' ? [tree, ...tree.children.flatMap(walk)] : []; }
function context(React, fixture) {
  const registrations = [];
  const dicts = {};
  let language = 'en';
  let model = { current: { provider: 'openai-codex', model: 'model-a' }, pending: null };
  let loads = 0;
  const directory = { store: { getSnapshot: () => model, subscribe: () => () => {} }, load() { loads++; throw new Error('Model requests forbidden'); } };
  const ctx = {
    connection: { rpc: fixture.rpc }, effect(fn) { return fn(); },
    uiConversation: { events: { register() { return () => {}; } } },
    locale: { register(ns, lang, dict) { dicts[lang] = dict; }, bind() { return key => dicts[language]?.[key] ?? key; }, subscribe() { return () => {}; }, getSnapshot() { return language; } },
    modelDirectories: { directoryFor() { return directory; } },
    slots: { inject(name, fn) { return fn(); }, register(metadata, Component) { registrations.push({ ...metadata, Component }); return () => {}; } },
  };
  const plugin = createPlugin(React);
  plugin.apply(ctx);
  return { plugin, registrations, setModel(value) { model = value; }, locale(value) { language = value; }, get loads() { return loads; } };
}

test('official HTTPS links only, rejecting credential URLs and open redirects', () => {
  assert.equal(safeAuthUrl('https://auth.openai.com/codex/device'), 'https://auth.openai.com/codex/device');
  assert.ok(safeAuthUrl('https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=fake'));
  for (const url of ['javascript:alert(1)', 'http://auth.openai.com/device', 'https://evil.test/device', 'https://auth.openai.com.evil.test/device', 'https://auth.openai.com@evil.test/device', 'https://fixture@auth.openai.com/device', '//auth.openai.com/device', 'https://auth.openai.com:444/device', 'https://auth.openai.com/oauth/authorize?redirect_uri=https://evil.test', 'https://auth.openai.com/device?next=https://evil.test', 'https://auth.openai.com/untrusted', 'https://auth.openai.com/device#secret']) assert.equal(safeAuthUrl(url), null, url);
});

test('public auth projection drops tokens, arbitrary fields and untrusted URLs', () => {
  const value = publicAuth({ ...pending(), token: 'SECRET_TOKEN', error: { message: 'SECRET_ERROR' }, prompts: [{ ...pending().prompts[0], value: 'SECRET_ANSWER', options: [{ id: 'a', label: 'A', token: 'SECRET_OPTION' }] }], notices: [{ url: 'https://evil.test', message: '<b>literal text</b>', code: 'DEVICE' }] });
  assert.equal(JSON.stringify(value).includes('SECRET'), false);
  assert.equal(value.notices[0].url, null);
  assert.equal(value.notices[0].message, '<b>literal text</b>');
  assert.deepEqual(value.prompts[0].options, [{ id: 'a', label: 'A' }]);
  assert.deepEqual(speedView({ tier: 'standard', fastAvailable: 'true', accessToken: 'secret' }), { tier: 'standard', fastAvailable: null });
  assert.throws(() => speedView({ tier: 'priority' }), /INVALID_RESPONSE/);
});

test('API uses exact endpoint, in-memory nonce and independent session Speed without touching old codex', async () => {
  const fixture = rpcFixture();
  const api = createCodexApi(fixture.rpc);
  assert.equal(await api.speed('s1', { provider: 'codex', model: 'model-a' }), null);
  assert.equal(fixture.calls.length, 0);
  await assert.rejects(api.authStart(), /STATUS_REQUIRED/);
  await assert.rejects(api.setSpeed('s1', { provider: 'codex', model: 'model-a' }, 'standard', true), /SPEED_UNAVAILABLE/);
  const model = { provider: 'openai-codex', model: 'model-a' };
  await api.speed('s1', model);
  assert.equal(fixture.calls[0].endpoint, 'codex-native.status');
  await api.setSpeed('s1', model, 'fast', null);
  await assert.rejects(api.setSpeed('s1', model, 'fast', false), /SPEED_UNAVAILABLE/);
  await api.setSpeed('s1', model, 'fast', true);
  assert.equal((await api.speed('s1', model)).tier, 'fast');
  assert.equal((await api.speed('s2', model)).tier, 'standard');
  await api.setSpeed('s1', model, 'standard', true);
  await api.authStart(); await api.authPoll('flow-1'); await api.authAnswer('flow-1', 'prompt-1', 'fake-code'); await api.authCancel('flow-1');
  for (const call of fixture.calls) {
    assert.equal(call.path, '/api');
    assert.match(call.endpoint, /^codex-native\./);
    if (!['codex-native.status', 'codex-native.speed'].includes(call.endpoint)) assert.equal(call.args.nonce, 'nonce-1');
  }
  assert.equal(fixture.calls.some(call => /model\./.test(call.endpoint)), false);
  assert.deepEqual(fixture.calls.find(call => call.endpoint === 'codex-native.authAnswer').args, { id: 'flow-1', promptId: 'prompt-1', answer: 'fake-code', nonce: 'nonce-1' });
});

test('nonce-required recovers via one status refresh and exactly one mutation retry', async () => {
  const calls = []; let generation = 0;
  const api = createCodexApi({ async call(path, endpoint, args) {
    calls.push({ endpoint, args });
    if (endpoint.endsWith('.status')) return ok({ nonce: 'nonce-' + ++generation, auth: idle() });
    return args.nonce === 'nonce-1' ? { ok: false, error: { code: 'NONCE_REQUIRED', message: 'SECRET' } } : ok({ tier: 'fast', fastAvailable: true });
  } });
  await api.status(); await api.setSpeed('s', { provider: 'openai-codex', model: 'm' }, 'fast', null);
  assert.deepEqual(calls.map(call => call.endpoint), ['codex-native.status', 'codex-native.setSpeed', 'codex-native.status', 'codex-native.setSpeed']);
  assert.equal(calls[3].args.nonce, 'nonce-2');
});

test('nonce recovery stops after one retry and other errors never replay mutations', async () => {
  for (const code of ['NONCE_REQUIRED', 'INTERNAL', 'AUTH_REQUIRED']) {
    let statuses = 0, mutations = 0;
    const api = createCodexApi({ async call(path, endpoint) {
      if (endpoint.endsWith('.status')) return ok({ nonce: 'nonce-' + ++statuses, auth: idle() });
      mutations++; return { ok: false, error: { code, message: 'SECRET_TOKEN' } };
    } });
    await api.status(); await assert.rejects(api.authStart(), error => error.message === 'RPC_FAILED' && !error.message.includes('SECRET'));
    assert.equal(mutations, code === 'NONCE_REQUIRED' ? 2 : 1); assert.equal(statuses, code === 'NONCE_REQUIRED' ? 2 : 1);
  }
});

test('status failure retries automatically with bounded delay and cleans up on dispose', async () => {
  const queue = new Map(); const delays = []; let next = 0, calls = 0;
  const clock = { later(fn, delay) { delays.push(delay); queue.set(++next, fn); return next; }, cancel(id) { queue.delete(id); } };
  const api = { async status() { calls++; if (calls < 3) throw new Error('SECRET'); return { ready: true, authenticated: true, auth: idle() }; } };
  const store = createAuthStore(api, clock); await store.load();
  assert.equal(store.getSnapshot().error, true); assert.equal(delays[0], 1000);
  let [id, fn] = queue.entries().next().value; queue.delete(id); await fn(); assert.equal(delays[1], 2000);
  [id, fn] = queue.entries().next().value; queue.delete(id); await fn();
  assert.equal(store.getSnapshot().authenticated, true); assert.equal(store.getSnapshot().error, false); assert.equal(queue.size, 0);
  store.dispose(); assert.equal(queue.size, 0);
  const fail = createAuthStore({ status: async () => { throw new Error('SECRET'); } }, clock); await fail.load(); assert.equal(queue.size, 1); fail.dispose(); assert.equal(queue.size, 0);
});

test('RPC failure messages are generic and never echo raw secrets', async () => {
  const api = createCodexApi({ call: async () => ({ ok: false, error: { message: 'SECRET_TOKEN' } }) });
  await assert.rejects(api.status(), error => error.message === 'RPC_FAILED');
});

test('auth store never auto-starts, polls active flow, sends once and stops after completion', async () => {
  const fixture = rpcFixture(); const clock = timers(); const api = createCodexApi(fixture.rpc); const store = createAuthStore(api, clock);
  assert.equal(fixture.calls.length, 0);
  await store.load(); assert.equal(clock.queue.size, 0);
  assert.equal(fixture.calls.some(call => call.endpoint === 'codex-native.authStart'), false);
  await store.start(); assert.equal(clock.queue.size, 1);
  await clock.fire(); assert.equal(clock.queue.size, 1);
  await store.answer('prompt-1', 'ONE_TIME_SECRET');
  assert.equal(store.getSnapshot().auth.state, 'complete');
  assert.equal(store.getSnapshot().authenticated, true);
  assert.equal(JSON.stringify(store.getSnapshot()).includes('ONE_TIME_SECRET'), false);
  assert.equal(clock.queue.size, 0);
  assert.equal(await store.answer('prompt-1', 'ONE_TIME_SECRET'), false);
  assert.equal(fixture.calls.filter(call => call.endpoint === 'codex-native.authAnswer').length, 1);
  store.dispose();
});

test('auth cancel wins against stale polling reply and disposes timers', async () => {
  const clock = timers(); const flight = deferred(); let pollCount = 0;
  const api = { status: async () => ({ ready: true, authenticated: false, auth: publicAuth(pending()) }), authPoll: () => { pollCount++; return flight.promise; }, authCancel: async () => publicAuth({ ...idle(), state: 'cancelled' }) };
  const store = createAuthStore(api, clock); await store.load();
  const polling = clock.fire(); assert.equal(pollCount, 1); assert.equal(clock.queue.size, 0);
  await store.cancel(); flight.resolve(publicAuth(pending())); await polling;
  assert.equal(store.getSnapshot().auth.state, 'cancelled'); assert.equal(clock.queue.size, 0);
  store.dispose();
});

test('auth answer types and selected option ids validated', async () => {
  const fixture = rpcFixture(); const clock = timers(); fixture.setFlow(pending({ id: 'p', type: 'select', message: 'Choose', options: [{ id: 'allowed', label: 'Allowed' }] }));
  const store = createAuthStore(createCodexApi(fixture.rpc), clock); await store.load();
  assert.equal(await store.answer('p', 'untrusted'), false);
  assert.equal(fixture.calls.filter(call => call.endpoint.endsWith('authAnswer')).length, 0);
  await store.cancel(); assert.equal(clock.queue.size, 0); store.dispose();
  fixture.setFlow(pending({ id: 'p', type: 'confirm', message: 'Confirm?' }));
  const store2 = createAuthStore(createCodexApi(fixture.rpc), clock); await store2.load();
  assert.equal(await store2.answer('p', 'yes'), false);
  assert.equal(await store2.answer('p', false), true);
  assert.equal(fixture.calls.at(-1).args.answer, false); store2.dispose();
});

test('pending polling retries failures, remains single flight across refresh, and stops on disposal', async () => {
  const clock = timers(); const flight = deferred(); let count = 0;
  const api = { status: async () => ({ ready: true, authenticated: false, auth: publicAuth(pending()) }), authPoll: () => { count++; return count === 1 ? Promise.reject(new Error('SECRET_FAILURE')) : flight.promise; } };
  const store = createAuthStore(api, clock); await store.load(); await clock.fire();
  assert.equal(store.getSnapshot().error, true); assert.equal(clock.queue.size, 1);
  const polling = clock.fire(); await store.load(); assert.equal(clock.queue.size, 0); assert.equal(count, 2);
  store.dispose(); const snapshot = store.getSnapshot(); flight.resolve(publicAuth({ ...idle(), state: 'complete' })); await polling;
  assert.equal(store.getSnapshot(), snapshot); assert.equal(clock.queue.size, 0);
});

test('store resumes after React strict effect cleanup without auto-starting auth', async () => {
  const fixture = rpcFixture(); const clock = timers(); const store = createAuthStore(createCodexApi(fixture.rpc), clock);
  store.resume(); const first = store.load(); store.dispose(); store.resume(); void store.load(); await first;
  assert.equal(store.getSnapshot().ready, true);
  assert.equal(fixture.calls.filter(call => call.endpoint.endsWith('authStart')).length, 0);
  store.dispose();
});

test('plugin registers own settings/Speed slots, locales, no startup RPC or model loads', () => {
  const renderer = fakeReact(); const fixture = rpcFixture(); const host = context(renderer.React, fixture);
  assert.deepEqual(host.plugin.inject, ['connection', 'slots', 'locale', 'modelDirectories', 'uiConversation']);
  assert.deepEqual(host.registrations.map(entry => [entry.name, entry.id]), [['settings.section', 'codex-native'], ['conversation.input.right', 'codex-native-speed'], ['conversation.composer.dock', 'codex-native-usage'], ['conversation.composer.dock', 'codex-native-tier-rails']]);
  assert.equal(fixture.calls.length, 0); assert.equal(host.loads, 0);
  assert.equal(host.registrations[0].label(), 'Codex OAuth');
});

test('capability refresh is explicit, nonce guarded and projects only checked/model count', async () => {
  const fixture = rpcFixture(); const api = createCodexApi(fixture.rpc);
  await assert.rejects(api.capabilitiesRefresh(), /STATUS_REQUIRED/); assert.equal(fixture.calls.length, 0);
  await api.status(); assert.equal(fixture.calls.some(call => call.endpoint.endsWith('capabilitiesRefresh')), false);
  assert.deepEqual(await api.capabilitiesRefresh(), { checked: true, models: 7 });
  assert.deepEqual(fixture.calls.at(-1), { path: '/api', endpoint: 'codex-native.capabilitiesRefresh', args: { nonce: 'nonce-1' } });
});

test('capability refresh unavailable before login and errors never display server secrets', async () => {
  const fixture = rpcFixture(); const clock = timers(); const api = createCodexApi(fixture.rpc); const store = createAuthStore(api, clock);
  await store.load(); assert.equal(await store.checkCapabilities(), false);
  assert.equal(fixture.calls.some(call => call.endpoint.endsWith('capabilitiesRefresh')), false);
  fixture.setAuthenticated(true); await store.load();
  fixture.rpc.call = async () => ({ ok: false, error: { message: 'SECRET_TOKEN' } });
  assert.equal(await store.checkCapabilities(), false);
  assert.equal(store.getSnapshot().error, true); assert.equal(store.getSnapshot().capabilities, null);
  assert.equal(JSON.stringify(store.getSnapshot()).includes('SECRET_TOKEN'), false); store.dispose();
});

test('settings displays literal notices and secure manual input, clearing before submit', async () => {
  const renderer = fakeReact(); const fixture = rpcFixture(); fixture.setFlow(pending());
  const host = context(renderer.React, fixture); const Component = host.registrations[0].Component;
  renderer.render(Component); await renderer.flush(); let tree = renderer.render(Component);
  assert.equal(fixture.calls.filter(call => call.endpoint.endsWith('authStart')).length, 0);
  const anchor = walk(tree).find(node => node.type === 'a'); assert.equal(anchor.props.rel, 'noopener noreferrer'); assert.equal(anchor.props.referrerPolicy, 'no-referrer');
  assert.ok(walk(tree).some(node => node.children.includes('<img src=x onerror=bad()>')));
  assert.equal(walk(tree).some(node => node.props.dangerouslySetInnerHTML), false);
  const promptRenderer = fakeReact(); const promptHost = context(promptRenderer.React, fixture);
  // Obtain the Prompt closure bound to the second renderer's hooks.
  promptRenderer.render(promptHost.registrations[0].Component); await promptRenderer.flush();
  const settingsTree = promptRenderer.render(promptHost.registrations[0].Component);
  const promptSeat = walk(settingsTree).find(node => typeof node.type === 'function');
  let form = promptRenderer.render(promptSeat.type, promptSeat.props);
  let input = walk(form).find(node => node.type === 'input');
  assert.equal(input.props.type, 'password'); assert.equal(input.props.autoComplete, 'off'); assert.equal(input.props.spellCheck, false);
  input.props.onChange({ target: { value: 'ONE_TIME_SECRET' } }); form = promptRenderer.render(promptSeat.type, promptSeat.props);
  form.props.onSubmit({ preventDefault() {} });
  form = promptRenderer.render(promptSeat.type, promptSeat.props); assert.equal(walk(form).find(node => node.type === 'input').props.value, '');
  await tick(); assert.equal(fixture.calls.filter(call => call.endpoint.endsWith('authAnswer')).length, 1);
  renderer.unmount(); promptRenderer.unmount();
});
