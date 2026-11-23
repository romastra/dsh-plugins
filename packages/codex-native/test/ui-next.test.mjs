import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlugin, createCodexApi, createPollingStore, usageView, formatUsageBadge, findComposerStats, observeComposerStats } from '../src/client.js';

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

test('automatic shared polling is single flight, focus coalesced, retains stale value on error', async () => {
  const clock = timers(); let now = 0; let calls = 0; let pending = deferred(); let signal;
  const store = createPollingStore(value => { signal = value; calls++; return pending.promise; }, { ...clock, now: () => now });
  const release1 = store.acquire(), release2 = store.acquire(); await tick();
  assert.equal(calls, 1); assert.equal(store.refresh(), store.refresh());
  pending.resolve({ tier: 'fast' }); await tick(); assert.equal(store.getSnapshot().value.tier, 'fast'); assert.equal(clock.queue.size, 1);
  await store.refresh({ focus: true }); assert.equal(calls, 1);
  now = 1000; pending = deferred(); const refresh = clock.fire(); await tick(); pending.reject(new Error('SECRET')); await tick();
  assert.equal(store.getSnapshot().error, true); assert.equal(store.getSnapshot().value.tier, 'fast');
  assert.equal(JSON.stringify(store.getSnapshot()).includes('SECRET'), false);
  release1(); assert.equal(clock.queue.size, 1); release2(); assert.equal(clock.queue.size, 0); assert.equal(signal.aborted, false);
  store.dispose(); void refresh;
});

test('automatic store aborts last owner and ignores old epoch completion after reacquire', async () => {
  const clock = timers(); const first = deferred(), second = deferred(); const signals = []; let calls = 0;
  const store = createPollingStore(signal => { signals.push(signal); return ++calls === 1 ? first.promise : second.promise; }, clock);
  const release = store.acquire(); await tick(); release(); assert.equal(signals[0].aborted, true);
  const release2 = store.acquire(); await tick(); second.resolve('new'); await tick(); first.resolve('old'); await tick();
  assert.equal(store.getSnapshot().value, 'new'); release2(); store.dispose();
});

test('usage projects safe canonical windows and compact badge shows most USED not remaining', () => {
  const now = 100000;
  const value = { state: 'available', windows: [
    { kind: 'session', usedPercent: 10, remainingPercent: 90, resetAt: now + 3600000, windowSeconds: 18000 },
    { kind: 'weekly', usedPercent: 45, remainingPercent: 55, resetAt: now + (2 * 24 + 21) * 3600000, windowSeconds: 604800 },
    { kind: 'other', usedPercent: 12, remainingPercent: 88, resetAt: null, windowSeconds: 100 },
  ], checkedAt: now, stale: true, accessToken: 'SECRET' };
  assert.equal(formatUsageBadge(value, { now }).label, 'Codex 2d 21h 45%');
  assert.equal(formatUsageBadge(value, { now }).stale, true);
  assert.equal(JSON.stringify(usageView(value)).includes('SECRET'), false);
  assert.equal(formatUsageBadge({ state: 'unknown', windows: [] }, { now }).label, 'Codex —');
  assert.equal(usageView({ state: 'available', windows: [{ kind: 'weekly', usedPercent: NaN, remainingPercent: 3 }] }).state, 'unknown');
  value.windows[1].resetAt = now - 1; assert.equal(formatUsageBadge(value, { now }).label, 'Codex — 45%');
});

test('usage RPC checks exact provider and uses status nonce automatically', async () => {
  const calls = []; const api = createCodexApi({ async call(path, endpoint, args) { calls.push({ path, endpoint, args }); return ok(endpoint.endsWith('.status') ? { nonce: 'nonce-test', auth: idle() } : { state: 'unknown', windows: [], stale: false }); } });
  assert.equal(await api.usage('s', { provider: 'codex', model: 'm' }), null); assert.equal(calls.length, 0);
  await api.usage('s', { provider: 'openai-codex', model: 'm' });
  assert.deepEqual(calls.map(call => call.endpoint), ['codex-native.status', 'codex-native.usage']);
  assert.deepEqual(calls[1].args, { sessionId: 's', model: 'm', nonce: 'nonce-test' });
});

test('compact Speed opens two radio options, auto polls, unknown Fast can server-check, no refresh', async () => {
  const renderer = fakeReact(); const fixture = rpcFixture(); fixture.setFast(null); const host = context(renderer.React, fixture);
  const seat = host.registrations[1], props = seat.inject('session-A');
  renderer.render(seat.Component, props); await renderer.flush(); let tree = renderer.render(seat.Component, props);
  let button = walk(tree).find(node => node.type === 'button'); assert.deepEqual(button.children, ['Speed · Standard']);
  assert.equal(walk(tree).some(node => node.type === 'select'), false);
  assert.equal(walk(tree).some(node => /refresh/i.test(node.props['aria-label'] ?? '')), false);
  button.props.onFocus(); button.props.onClick(); await tick(); tree = renderer.render(seat.Component, props);
  const items = walk(tree).filter(node => node.props.role === 'menuitemradio'); assert.equal(items.length, 2); assert.equal(items[1].props.disabled, false);
  items[1].props.onClick(); await tick(); tree = renderer.render(seat.Component, props);
  assert.equal(walk(tree).find(node => node.type === 'button').children[0], 'Speed · Fast');
  assert.equal(fixture.calls.filter(call => call.endpoint.endsWith('setSpeed')).length, 1);
  renderer.unmount();
});

test('Speed trigger copies exact legacy compact dimensions and menu styling', async () => {
  const renderer = fakeReact(); const fixture = rpcFixture(); const host = context(renderer.React, fixture); const seat = host.registrations[1];
  const tree = renderer.render(seat.Component, seat.inject('s')); const css = walk(tree).find(node => node.type === 'style').children.join('');
  assert.match(css, /border:0\.5px solid var\(--dsw-alias-border-l3\)!important/);
  assert.match(css, /padding:2px 8px!important/); assert.match(css, /font-size:12px;line-height:18px/);
  assert.match(css, /min-width:180px;padding:4px;z-index:20/); assert.match(css, /var\(--dsw-radius-lg, 16px\)/);
  assert.equal(css.includes('[data-composer-dock]:has'), false); await renderer.flush(); renderer.unmount();
});

test('compact Speed hides old provider and settings contains no manual status/catalog controls', async () => {
  const renderer = fakeReact(); const fixture = rpcFixture(); const host = context(renderer.React, fixture);
  host.setModel({ current: { provider: 'codex', model: 'm' }, pending: null });
  const seat = host.registrations[1]; assert.equal(renderer.render(seat.Component, seat.inject('s')), null); await renderer.flush();
  assert.equal(fixture.calls.length, 0); const Settings = host.registrations[0].Component;
  renderer.render(Settings); await renderer.flush(); const tree = renderer.render(Settings);
  const buttons = walk(tree).filter(node => node.type === 'button').flatMap(node => node.children);
  assert.equal(buttons.includes('Refresh status'), false); assert.equal(buttons.includes('Check Fast support'), false);
  assert.equal(buttons.includes('Sign in with OpenAI'), true); renderer.unmount();
});

test('detached Speed menu handler cannot mutate after model switch or unmount', async () => {
  const renderer = fakeReact(); const fixture = rpcFixture(); const host = context(renderer.React, fixture);
  const seat = host.registrations[1], props = seat.inject('s'); renderer.render(seat.Component, props); await renderer.flush();
  let tree = renderer.render(seat.Component, props); walk(tree).find(node => node.type === 'button').props.onClick(); await tick();
  tree = renderer.render(seat.Component, props); const oldFast = walk(tree).find(node => node.props.role === 'menuitemradio' && walk(node).some(child => child.children.includes('Fast')));
  host.setModel({ current: { provider: 'openai-codex', model: 'model-b' }, pending: null }); renderer.render(seat.Component, props); await renderer.flush();
  oldFast.props.onClick(); await tick(); assert.equal(fixture.calls.some(call => call.endpoint.endsWith('setSpeed')), false);
  renderer.unmount(); oldFast.props.onClick(); await tick(); assert.equal(fixture.calls.some(call => call.endpoint.endsWith('setSpeed')), false);
});

test('local observer handles stats row appearing and disappearing without scanning session root', () => {
  let row = null, callback, disconnected = false;
  const session = { tagName: 'DIV', matches: selector => selector === '[data-conversation-session]', querySelector() { throw new Error('cross session scan'); } };
  const local = { tagName: 'DIV', parentElement: session, matches: () => false, querySelector: () => row };
  class Observer { constructor(fn) { callback = fn; } observe(target) { assert.equal(target, local); } disconnect() { disconnected = true; } }
  const targets = []; const cleanup = observeComposerStats({ parentElement: local }, value => targets.push(value), { Observer });
  assert.equal(targets[0], null); row = {}; callback(); assert.equal(targets[1], row); row = null; callback(); assert.equal(targets[2], null); cleanup(); assert.equal(disconnected, true);
});

test('composer target search remains local and observer disconnects on cleanup', () => {
  let scans = 0, observed, disconnected = false, callback; const row = {};
  const session = { tagName: 'DIV', matches: selector => selector === '[data-conversation-session]', querySelector() { throw new Error('Must not scan another composer/session'); } };
  const scope = { tagName: 'DIV', parentElement: session, matches: () => false, querySelector() { scans++; return row; } };
  const anchor = { parentElement: scope }; assert.equal(findComposerStats(anchor).row, row);
  class Observer { constructor(fn) { callback = fn; } observe(target) { observed = target; } disconnect() { disconnected = true; } }
  const targets = []; const cleanup = observeComposerStats(anchor, target => targets.push(target), { Observer });
  assert.equal(observed, scope); assert.equal(targets[0], row); callback(); assert.equal(targets.length, 2); cleanup(); assert.equal(disconnected, true); assert.ok(scans > 0);
  assert.equal(findComposerStats({ parentElement: session }), null);
});
