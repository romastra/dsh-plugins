import test from 'node:test';
import assert from 'node:assert/strict';
import { installHost, DEFAULTS } from './host-runtime.js';

// Mirrors the public rc.3 contracts: AgentRegistry has get/list, not roots;
// SubagentRuntime has waitForTreeWork, not waitForChildren. No running Host,
// profile settings, filesystem attachments, audio, or network is touched.
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const flushPromises = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, { header = {}, subagents = { async waitForTreeWork() { return false; } }, legacyRoots = false, readTodos = () => null } = {}) {
  const effects = [], routes = new Map(), tools = new Map(), listeners = new Map();
  const timers = new Map(), warnings = [];
  let timerId = 0, seq = 0, goal;
  const session = { id: 'root-session', header, firstLiveSeq: 0 };
  const agent = { id: session.id, session, status: 'idle', async whenIdle() {} };
  const live = new Map([[agent.id, agent]]);
  const agents = { get: id => live.get(id), list: () => [...live.values()] };
  if (legacyRoots) agents.roots = () => [agent];
  const later = callback => { const id = ++timerId; timers.set(id, callback); return id; };
  const cancel = id => timers.delete(id);
  const ctx = {
    agents, attachments: {},
    settings: { describe: () => [{ ns: 'sound-notifications', revision: 1 }], update() { assert.fail('settings must not change'); } },
    tools: { register(tool) { tools.set(tool.name, tool); } },
    connection: { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } } },
    effect(callback) { const cleanup = callback(); if (typeof cleanup === 'function') effects.push(cleanup); },
    on(name, callback) { const callbacks = listeners.get(name) ?? []; callbacks.push(callback); listeners.set(name, callbacks); },
    get(name) { if (name === 'subagents') return subagents; if (name === 'goals') return { get: () => goal }; },
    logger: { warn(...args) { warnings.push(args.join(' ')); } },
  };
  const config = Object.fromEntries(Object.entries(DEFAULTS).map(([key, value]) => [key, { get: () => value }]));
  installHost(ctx, config, { later, cancel, readTodos });
  t.after(() => { for (const cleanup of effects.reverse()) cleanup(); });
  const status = async () => (await tools.get('sound_notifications_settings').execute({ action: 'status' })).delivery;
  const request = async payload => {
    const response = await routes.get('/api/sound-notifications/events').fetch(new Request('http://fixture.invalid/api/sound-notifications/events', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'test-rpc', method: 'sound-notifications/events', payload: { clientId: 'test-client', ...payload } }),
    }));
    assert.equal(response.status, 200);
    const result = (await response.json()).result;
    assert.equal(result.ok, true);
    return result.value;
  };
  let cursor = await request({});
  return {
    agent, session, live, warnings,
    setGoal(value) { goal = value; },
    emit(name, ...args) {
      for (const callback of listeners.get(name) ?? []) {
        // Session's post-commit observers contain errors instead of failing a turn.
        try { callback(...args); } catch (error) { warnings.push(`${name}: ${error.message}`); }
      }
    },
    turn(type, reason = 'completed', target = session) {
      this.emit('session/event', target, { type, seq: seq++, data: type === 'turn/start' ? { turn: seq } : { turn: seq, reason: { kind: reason } } });
    },
    async settle() {
      const pending = [...timers.values()]; timers.clear();
      for (const callback of pending) callback();
      await flushPromises();
    },
    async events() {
      if ((await status()).cursor === cursor.cursor) return [];
      cursor = await request({ generation: cursor.generation, cursor: cursor.cursor });
      return cursor.events;
    },
    status,
  };
}

function completed(events) { return events.filter(event => event.type === 'completed'); }

test('rc.3 get/list-only registry publishes start clear and root completion', async t => {
  const f = await fixture(t);
  f.turn('turn/start'); f.turn('turn/end'); await f.settle();
  const events = await f.events();
  assert.deepEqual(f.warnings, []);
  assert.deepEqual(events.map(event => event.type), ['clear-attention', 'completed']);
  assert.equal(events[1].sessionId, f.agent.id);
  assert.equal(events[1].outcome, 'success');
});

test('subagent origin stays silent even when no runtime parent is resident', async t => {
  const f = await fixture(t, { header: { origin: 'subagent', parentSession: 'not-resident' } });
  f.turn('turn/start'); f.turn('turn/end'); await f.settle();
  assert.deepEqual(f.warnings, []);
  assert.deepEqual(await f.events(), []);
});

test('ordinary historical fork with parentSession is still an independent root', async t => {
  const f = await fixture(t, { header: { parentSession: 'fork-source', isSeeded: true } });
  f.turn('turn/end'); await f.settle();
  assert.deepEqual(f.warnings, []);
  assert.equal(completed(await f.events()).length, 1);
});

test('rc.3 waitForTreeWork is awaited before root completion', async t => {
  const gate = deferred(); t.after(() => gate.resolve());
  let waits = 0;
  const f = await fixture(t, { subagents: { async waitForTreeWork(root) { waits++; assert.equal(root, f.agent); await gate.promise; return true; } } });
  f.turn('turn/end'); await f.settle();
  assert.deepEqual(f.warnings, []);
  assert.equal(waits, 1);
  assert.deepEqual(await f.events(), []);
  gate.resolve(); await flushPromises();
  assert.equal(completed(await f.events()).length, 1);
});

test('renamed wait method works independently of a legacy roots-capable registry', async t => {
  let waits = 0;
  const f = await fixture(t, { legacyRoots: true, subagents: { async waitForTreeWork() { waits++; return false; } } });
  f.turn('turn/end'); await f.settle();
  assert.deepEqual(f.warnings, []);
  assert.equal(waits, 1);
  assert.equal(completed(await f.events()).length, 1);
});

test('new turn during descendant wait invalidates the old completion candidate', async t => {
  const gate = deferred(); t.after(() => gate.resolve());
  let waits = 0;
  const f = await fixture(t, { subagents: { async waitForTreeWork() { waits++; await gate.promise; return true; } } });
  f.turn('turn/end'); await f.settle();
  assert.equal(waits, 1);
  f.turn('turn/start');
  gate.resolve(); await flushPromises();
  assert.deepEqual(f.warnings, []);
  assert.deepEqual((await f.events()).map(event => event.type), ['clear-attention']);
});

test('error completion bypasses progressing descendants and reports attention', async t => {
  const f = await fixture(t, { subagents: { waitForTreeWork() { assert.fail('error must not wait for children'); } } });
  f.turn('turn/end', 'error'); await f.settle();
  assert.deepEqual(f.warnings, []);
  const events = completed(await f.events());
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, 'error');
  assert.equal(events[0].outcome, 'attention');
});

test('an absent subagents service does not suppress an ordinary completion', async t => {
  const f = await fixture(t, { subagents: null });
  f.turn('turn/end'); await f.settle();
  assert.deepEqual(f.warnings, []);
  assert.equal(completed(await f.events()).length, 1);
});

test('legacy waitForChildren remains supported when newer wait is absent', async t => {
  let waits = 0;
  const f = await fixture(t, { legacyRoots: true, subagents: { async waitForChildren(root) { waits++; assert.equal(root, f.agent); } } });
  f.turn('turn/end'); await f.settle();
  assert.deepEqual(f.warnings, []);
  assert.equal(waits, 1);
  assert.equal(completed(await f.events()).length, 1);
});

test('session event from a replaced instance cannot fabricate completion', async t => {
  const f = await fixture(t);
  f.live.set(f.agent.id, { ...f.agent, session: { ...f.session } });
  f.turn('turn/end'); await f.settle();
  assert.deepEqual(f.warnings, []);
  assert.deepEqual(await f.events(), []);
});

test('flat goal phase/activation keeps an armed goal silent until disarmed', async t => {
  const f = await fixture(t);
  f.setGoal({ phase: 'active', activation: 'armed' });
  f.turn('turn/end'); await f.settle();
  assert.deepEqual(f.warnings, []);
  assert.deepEqual(await f.events(), []);
  f.setGoal({ phase: 'active', activation: 'disarmed' });
  f.emit('goal/activation-changed', { sessionId: f.agent.id }); await f.settle();
  const events = completed(await f.events());
  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, 'attention');
  assert.equal(events[0].goalPhase, 'active');
});
