import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// Only transport/producer boundaries are mocked. No SSH, child process, or network
// is opened by these registration/admission unit tests (not a live UI test).
const stateKey = Symbol.for('mcp-task-bridge:index-admission-test');
const state = globalThis[stateKey] = { opened: 0, produced: 0 };
const connectionUrl = new URL('../connection.js', import.meta.url).href;
const engineUrl = new URL('../engine.js', import.meta.url).href;
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url === connectionUrl) return { format: 'module', shortCircuit: true, source: `
      export async function openConnection() {
        globalThis[Symbol.for('mcp-task-bridge:index-admission-test')].opened++;
        return { listTaskTools: async () => [], close: async () => {} };
      }` };
    if (url === engineUrl) return { format: 'module', shortCircuit: true, source: `
      export async function runTask() {
        globalThis[Symbol.for('mcp-task-bridge:index-admission-test')].produced++;
        return { status: 'completed', result: 'fixture' };
      }` };
    return nextLoad(url, context);
  },
});
const { install, Config } = await import('../index.js');
hooks.deregister();
let messageSequence = 0;
const createUserMessage = input => ({ ...input, id: `notice-${++messageSequence}`, role: 'user' });
const apply = (ctx, settings) => install(ctx, settings, createUserMessage);

function config(extra = {}) {
  return { servers: [{ name: 'fixture', transport: 'stdio', command: 'NEVER_EXECUTED',
    args: [], env: {}, allowedTools: ['allowed'], requestTimeoutMs: 1000, startupTimeoutMs: 1000 }],
    minPollMs: 100, maxPollMs: 1000, maxDurationMs: 5000, resultMaxBytes: 4096, ...extra };
}
function fixture({ current = true, controls = ['job_output', 'job_kill'], rejectStart = false } = {}) {
  const definitions = new Map();
  const cleanups = [];
  const jobs = [];
  let starts = 0;
  let listener;
  let lifetimeCleanup;
  const notices = [];
  const warnings = [];
  const owner = { id: 'owner-session', status: 'idle', followup(message) { notices.push(message); this.status = 'running'; } };
  const ctx = {
    logger: { warn(message) { warnings.push(message); } },
    effect(setup, label) { const cleanup = setup(); if (cleanup) cleanups.push(cleanup); if (label === 'mcp-task-bridge:lifetime') lifetimeCleanup = cleanup; return cleanup; },
    tools: {
      register(definition) { definitions.set(definition.name, definition); return () => definitions.delete(definition.name); },
      get(name, scope) { assert.equal(scope, owner); return controls.includes(name) ? { name } : undefined; },
    },
    agents: { get(id) { return current && id === owner.id ? owner : undefined; } },
    jobs: { events: { subscribe(filter, callback) {
      assert.deepEqual(filter, { owners: 'all' }); listener = callback;
      return () => { listener = undefined; };
    } }, start(spec) {
      starts++;
      if (rejectStart) throw new Error('No attached job controller serves owner');
      const handle = { id: `mcp-task-${starts}`, updateProgress() {} };
      const result = spec.run(handle);
      jobs.push({ spec, result });
      return handle.id;
    } },
  };
  const exec = { agent: owner, signal: new AbortController().signal,
    callId: 'nested-call', rootCallId: 'root-call', concluded: 0,
    concludeTurn() { this.concluded++; } };
  apply(ctx, config());
  return { ctx, owner, exec, jobs, definitions, notices, warnings, get starts() { return starts; },
    emit(event) { listener?.(event); },
    disposeLifetime() { return lifetimeCleanup(); },
    start(args = {}) { return definitions.get('mcp_task_start').execute({ server: 'fixture', tool: 'allowed', arguments: {}, ...args }, exec); },
    async close() { for (const cleanup of cleanups.reverse()) await cleanup(); } };
}

test('server listing has no connection or producer side effects', async () => {
  const f = fixture();
  const before = { ...state };
  const result = await f.definitions.get('mcp_task_tools').execute({}, f.exec);
  assert.deepEqual(result.servers.map(s => s.name), ['fixture']);
  assert.deepEqual(state, before);
  assert.equal(f.starts, 0);
  await f.close();
});

test('missing, stale, or foreign Agent is rejected before job admission', async () => {
  for (const mode of ['missing', 'stale', 'foreign']) {
    const f = fixture({ current: mode !== 'stale' });
    if (mode === 'missing') f.exec.agent = undefined;
    if (mode === 'foreign') f.exec.agent = { id: f.owner.id };
    await assert.rejects(f.start(), /live owning Agent/);
    assert.equal(f.starts, 0);
    assert.equal(f.exec.concluded, 0);
    await f.close();
  }
});

test('server and raw-tool allowlists reject before job admission', async () => {
  const f = fixture();
  await assert.rejects(f.start({ server: 'unknown' }), /Unknown MCP Tasks server/);
  await assert.rejects(f.start({ tool: 'call_tool' }), /not allowlisted/);
  await assert.rejects(f.start({ tool: 'ALLOWED' }), /not allowlisted/);
  assert.equal(f.starts, 0);
  await f.close();
});

test('both stock job output and kill controls are required before start', async () => {
  for (const controls of [[], ['job_output'], ['job_kill']]) {
    const f = fixture({ controls });
    await assert.rejects(f.start(), /stock job controls/);
    assert.equal(f.starts, 0);
    await f.close();
  }
});

test('invalid monitoring limits cannot start work or conclude a turn', async () => {
  const f = fixture();
  for (const max_wait_ms of [0, 999, 5001, 1000.5, NaN, Infinity, '1000']) {
    await assert.rejects(f.start({ max_wait_ms }), /max_wait_ms/);
  }
  assert.equal(f.starts, 0);
  assert.equal(f.exec.concluded, 0);
  await f.close();
});

test('job controller refusal starts no producer and does not pause the Agent', async () => {
  const f = fixture({ rejectStart: true });
  const before = { ...state };
  await assert.rejects(f.start(), /No attached job controller/);
  await Promise.resolve();
  assert.deepEqual(state, before);
  assert.equal(f.starts, 1);
  assert.equal(f.exec.concluded, 0);
  await f.close();
});

test('successful admission carries exact owner and nested call identity; pause defaults on', async () => {
  const f = fixture();
  const result = await f.start({ max_wait_ms: 1000 });
  assert.equal(result.status, 'registered');
  assert.match(result.note, /creation is pending/);
  assert.equal(result.paused, true);
  assert.equal(f.exec.concluded, 1);
  assert.equal(f.jobs[0].spec.owner, f.owner.id);
  assert.equal(f.jobs[0].spec.kind, 'mcp-task');
  assert.deepEqual(f.jobs[0].spec.toolCall, { callId: 'nested-call', rootCallId: 'root-call' });
  await f.jobs[0].result.done;
  await f.close();
});

test('upper monitoring boundary and pause false retain independent work', async () => {
  const f = fixture();
  const result = await f.start({ max_wait_ms: 5000, pause: false });
  assert.equal(result.paused, false);
  assert.equal(f.exec.concluded, 0);
  await f.jobs[0].result.done;
  await f.close();
});

test('aborted foreground admission and disposed plugin reject before job start', async () => {
  const f = fixture();
  f.exec.signal = AbortSignal.abort(new Error('caller aborted'));
  await assert.rejects(f.start(), /caller aborted/);
  assert.equal(f.starts, 0);
  const startDefinition = f.definitions.get('mcp_task_start');
  await f.close();
  await assert.rejects(startDefinition.execute({ server: 'fixture', tool: 'allowed', arguments: {} }, f.exec), /unloading/);
  assert.equal(f.starts, 0);
});

test('inverted polling limits and duplicate server names fail during setup', () => {
  assert.throws(() => apply({}, config({ minPollMs: 1001, maxPollMs: 1000 })), /minPollMs/);
  const server = config().servers[0];
  assert.throws(() => apply({}, config({ servers: [server, { ...server }] })), /Duplicate/);
});

const settlement = (id, extra = {}) => ({ type: 'settled', cause: 'producer', awaited: false,
  job: { id, owner: 'owner-session', status: 'completed' }, ...extra });

// These exercise bridge fallback admission, not the real Agent driver or Web UI.
test('idle quiet owner receives exactly one bounded completion wake', async () => {
  const f = fixture();
  const receipt = await f.start();
  await f.jobs[0].result.done;
  f.emit(settlement(receipt.job_id));
  assert.equal(f.notices.length, 0, 'delivery waits until stock listeners finish');
  await Promise.resolve();
  assert.equal(f.notices.length, 1);
  assert.match(f.notices[0].content[0].text, new RegExp(receipt.job_id));
  assert.match(f.notices[0].content[0].text, /job_output/);
  assert.equal(f.notices[0].source.kind, 'tool-jobs');
  f.owner.status = 'idle';
  f.emit(settlement(receipt.job_id));
  await Promise.resolve();
  assert.equal(f.notices.length, 1, 'a repeated terminal event cannot duplicate wake');
  await f.close();
});

test('stock reporter waking owner synchronously prevents fallback duplication', async () => {
  const f = fixture();
  const receipt = await f.start();
  await f.jobs[0].result.done;
  f.emit(settlement(receipt.job_id));
  f.owner.status = 'running'; // a later stock subscription ran in the same delivery round
  await Promise.resolve();
  assert.equal(f.notices.length, 0);
  await f.close();
});

test('busy owner is left to the stock next-step injection', async () => {
  const f = fixture();
  const receipt = await f.start();
  await f.jobs[0].result.done;
  f.owner.status = 'running';
  f.emit(settlement(receipt.job_id));
  await Promise.resolve();
  assert.equal(f.notices.length, 0);
  await f.close();
});

test('awaited, kill, and teardown settlements never create a completion wake', async () => {
  for (const flags of [{ awaited: true }, { cause: 'kill' }, { cause: 'teardown' }]) {
    const f = fixture();
    const receipt = await f.start();
    await f.jobs[0].result.done;
    f.emit(settlement(receipt.job_id, flags));
    await Promise.resolve();
    assert.equal(f.notices.length, 0);
    await f.close();
  }
});

test('foreign job and same-session replacement Agent cannot receive the wake', async () => {
  const f = fixture();
  const receipt = await f.start();
  await f.jobs[0].result.done;
  f.emit(settlement('mcp-task-foreign'));
  await Promise.resolve();
  assert.equal(f.notices.length, 0);
  f.ctx.agents.get = () => ({ id: f.owner.id, status: 'idle', followup() { throw new Error('foreign Agent called'); } });
  f.emit(settlement(receipt.job_id));
  await Promise.resolve();
  assert.equal(f.notices.length, 0);
  assert.equal(f.warnings.length, 0);
  await f.close();
});

test('owner destruction or plugin disposal before microtask suppresses delivery', async () => {
  for (const mode of ['owner', 'plugin']) {
    const f = fixture();
    const receipt = await f.start();
    await f.jobs[0].result.done;
    f.emit(settlement(receipt.job_id));
    if (mode === 'owner') f.ctx.agents.get = () => undefined;
    else f.disposeLifetime();
    await Promise.resolve();
    assert.equal(f.notices.length, 0);
    await f.close();
  }
});

test('a throwing followup is contained and reports a non-sensitive warning', async () => {
  const f = fixture();
  const receipt = await f.start();
  await f.jobs[0].result.done;
  f.owner.followup = () => { throw new Error('fixture-private-error-not-for-logs'); };
  f.emit(settlement(receipt.job_id));
  await Promise.resolve();
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /result remains in job_output/);
  assert.doesNotMatch(f.warnings[0], /fixture-private/);
  await f.close();
});

test('Config enforces numerical bounds at the schema boundary', () => {
  for (const extra of [{ minPollMs: 99 }, { maxPollMs: 60001 }, { maxDurationMs: 999 },
    { maxDurationMs: 604800001 }, { resultMaxBytes: 4095 }, { resultMaxBytes: 262145 }]) {
    assert.throws(() => Config(config(extra)));
  }
});
