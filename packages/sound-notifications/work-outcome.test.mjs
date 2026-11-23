import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyWorkOutcome } from './work-outcome.js';
import { installHost, DEFAULTS } from './host-runtime.js';

const todo = status => ({ content: `Task ${status}`, status });

test('success requires a completed reason, absent/complete Goal and no open current todos', () => {
  for (const goal of [undefined, null, { phase: 'complete' }]) {
    for (const todos of [null, [], [todo('completed')]]) {
      assert.deepEqual(classifyWorkOutcome({ reason: 'completed', goal, todos }), {
        outcome: 'success', goalPhase: goal?.phase ?? null, openTodos: 0,
      });
    }
    for (const status of ['pending', 'in_progress']) {
      assert.deepEqual(classifyWorkOutcome({ reason: 'completed', goal, todos: [todo('completed'), todo(status)] }), {
        outcome: 'attention', goalPhase: goal?.phase ?? null, openTodos: 1,
      });
    }
  }
});

test('active/disarmed, paused, blocked and unknown Goal phases are never victory', () => {
  for (const phase of ['active', 'paused', 'blocked', 'unknown']) {
    assert.equal(classifyWorkOutcome({ reason: 'completed', goal: { phase, activation: 'disarmed' }, todos: [] }).outcome, 'attention');
  }
  assert.equal(classifyWorkOutcome({ reason: 'completed', goal: {}, todos: [] }).outcome, 'attention');
});

test('error, aborted, blocked, token exhaustion and interruption always need attention', () => {
  for (const reason of ['error', 'aborted', 'blocked', 'max-tokens', 'interrupted']) {
    for (const goal of [undefined, { phase: 'complete' }, { phase: 'active', activation: 'armed' }]) {
      assert.equal(classifyWorkOutcome({ reason, goal, todos: [] }).outcome, 'attention', `${reason}/${goal?.phase}`);
    }
  }
});

test('unknown or malformed TODO data fails closed, unlike known projection null', () => {
  for (const todos of [undefined, {}, 'completed', [null], [{ status: 'canceled' }]]) {
    assert.deepEqual(classifyWorkOutcome({ reason: 'completed', todos }), { outcome: 'attention', goalPhase: null, openTodos: null });
  }
  assert.equal(classifyWorkOutcome({ reason: 'completed', todos: null }).outcome, 'success');
});

// A focused Host fixture, independent of the existing notification suite. It
// exercises the real channel's status without changing production settings.
function hostFixture({ todos = [], readTodos, settings: patch = {} } = {}) {
  const events = new Map(), effects = [], timers = new Map(), warnings = [];
  const settings = { ...DEFAULTS, ...patch };
  let goal, next = 0, settingsTool, roots;
  const agent = { id: 'root', status: 'idle', session: { id: 'root', header: {}, firstLiveSeq: 10 }, whenIdle: async () => {} };
  roots = [agent];
  const ctx = {
    logger: { warn(...args) { warnings.push(args); } },
    agents: { get: id => id === agent.id && roots.includes(agent) ? agent : undefined, list: () => [...roots] },
    settings: { describe: () => [{ ns: 'sound-notifications', revision: 1 }], async update(_ns, patch) { Object.assign(settings, patch); } },
    tools: { register(definition) { if (definition.name === 'sound_notifications_settings') settingsTool = definition; } },
    connection: { fetch: { register() { return () => {}; } } },
    get: key => key === 'goals' ? { get: () => goal } : undefined,
    on(name, handler) { events.set(name, handler); },
    effect(fn) { effects.push(fn()); },
  };
  installHost(ctx, Object.fromEntries(Object.keys(DEFAULTS).map(key => [key, { get: () => settings[key] }])), {
    readTodos: readTodos ?? (() => todos),
    later(fn) { timers.set(++next, fn); return next; },
    cancel(id) { timers.delete(id); },
  });
  const status = async () => (await settingsTool.execute({ action: 'status' })).delivery;
  return {
    agent, ctx, events, timers, warnings, settings, status,
    goal(value) { goal = value; },
    todos(value) { todos = value; },
    roots(value) { roots = value; },
    emit(type = 'turn/end', seq = 10, reason = 'completed', session = agent.session, extraReason = {}) {
      events.get('session/event')(session, { type, seq, data: { reason: { kind: reason, ...extraReason } } });
    },
    async flush() {
      for (const [id, fn] of [...timers]) { timers.delete(id); fn(); }
      for (let i = 0; i < 20; i++) await Promise.resolve();
      return status();
    },
    dispose() { for (const effect of effects.reverse()) effect?.(); },
  };
}

test('Host publishes backward-compatible envelopes enriched with authoritative outcome metadata', async () => {
  const f = hostFixture({ todos: [todo('pending'), todo('in_progress'), todo('completed')] });
  f.goal({ phase: 'complete' }); f.emit();
  let state = await f.flush();
  assert.equal(state.published, 1);
  assert.deepEqual(state.lastPublished, {
    type: 'completed', id: `${state.generation}:root:10`, sessionId: 'root', reason: 'completed',
    outcome: 'attention', goalPhase: 'complete', openTodos: 2,
  });
  f.todos([todo('completed')]); f.emit('turn/end', 11);
  state = await f.flush();
  assert.equal(state.lastPublished.outcome, 'success'); assert.equal(state.lastPublished.openTodos, 0);
  f.goal(undefined); f.todos(null); f.emit('turn/end', 12);
  state = await f.flush();
  assert.equal(state.lastPublished.outcome, 'success'); assert.equal(state.lastPublished.goalPhase, null);
  f.dispose();
});

test('Host delivers logical outcomes regardless of sound switches; browser gates playback', async () => {
  for (const completionEnabled of [false, true]) for (const approvalEnabled of [false, true]) {
    for (const [reason, todos, goal, outcome] of [
      ['completed', [], undefined, 'success'],
      ['completed', [todo('pending')], undefined, 'attention'],
      ['completed', [], { phase: 'paused' }, 'attention'],
      ['error', [], { phase: 'complete' }, 'attention'],
    ]) {
      const f = hostFixture({ todos, settings: { completionEnabled, approvalEnabled } });
      f.goal(goal); f.emit('turn/end', 10, reason);
      const state = await f.flush();
      assert.equal(state.published, 1, `${outcome}/${completionEnabled}/${approvalEnabled}`);
      if (state.published) assert.equal(state.lastPublished.outcome, outcome);
      f.dispose();
    }
  }
});

test('Host keeps automatic armed Goal rounds silent, then classifies a real stop', async () => {
  for (const phase of ['active', 'paused', 'blocked', 'complete']) {
    const f = hostFixture();
    f.goal({ phase: 'active', activation: 'armed' }); f.emit();
    assert.equal((await f.flush()).published, 0);
    f.goal({ phase, activation: 'disarmed' }); f.events.get('goal/changed')({ agent: f.agent });
    const state = await f.flush();
    assert.equal(state.published, 1); assert.equal(state.lastPublished.outcome, phase === 'complete' ? 'success' : 'attention');
    f.dispose();
  }
});

test('Host non-completed reasons remain attention even with an armed Goal', async () => {
  for (const reason of ['error', 'aborted', 'blocked', 'max-tokens', 'interrupted']) {
    const f = hostFixture(); f.goal({ phase: 'active', activation: 'armed' }); f.emit('turn/end', 10, reason);
    const state = await f.flush();
    assert.equal(state.published, 1); assert.equal(state.lastPublished.outcome, 'attention');
    f.dispose();
  }
});

test('Host unavailable TODO projection reports attention instead of assuming an empty list', async () => {
  for (const readTodos of [() => undefined, () => { throw new Error('projection unavailable'); }]) {
    const f = hostFixture({ readTodos }); f.emit();
    const state = await f.flush();
    assert.equal(state.lastPublished.outcome, 'attention'); assert.equal(state.lastPublished.openTodos, null);
    f.dispose();
  }
});

test('only live root turn starts clear attention and invalidate pending terminal candidates', async () => {
  const f = hostFixture({ settings: { approvalEnabled: false, completionEnabled: false } });
  // Initial idle baseline and history must not manufacture clear notifications.
  assert.equal((await f.status()).published, 0);
  f.emit('turn/start', 9); assert.equal((await f.status()).published, 0);
  f.emit('turn/start', 10, 'completed', { id: 'root' }); assert.equal((await f.status()).published, 0);
  f.agent.session.header.origin = 'subagent'; f.emit('turn/start'); assert.equal((await f.status()).published, 0);
  delete f.agent.session.header.origin;
  f.roots([]); f.emit('turn/start'); assert.equal((await f.status()).published, 0);
  f.roots([f.agent]); f.emit(); f.emit('turn/start', 11);
  const state = await f.flush();
  assert.equal(state.published, 1); assert.deepEqual(state.lastPublished, { type: 'clear-attention', sessionId: 'root' });
  assert.equal(f.timers.size, 0);
  f.dispose();
});

test('a new live turn cancels an in-flight terminal check without publishing stale completion', async () => {
  let release;
  const f = hostFixture(); f.agent.whenIdle = () => new Promise(resolve => { release = resolve; });
  f.emit(); await f.flush();
  f.emit('turn/start', 11); release(); await f.flush();
  const state = await f.status();
  assert.equal(state.published, 1); assert.equal(state.lastPublished.type, 'clear-attention');
  f.dispose();
});

test('history, teardown, forks and disposed contexts never publish terminal outcomes', async () => {
  const f = hostFixture();
  f.emit('turn/end', 9); f.emit('turn/end', 10, 'forked');
  f.emit('turn/end', 11, 'aborted', f.agent.session, { reason: { kind: 'disposed' } });
  assert.equal((await f.flush()).published, 0);
  f.emit('turn/end', 12); f.dispose();
  assert.equal(f.timers.size, 0);
});
