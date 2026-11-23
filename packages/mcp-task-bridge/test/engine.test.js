import test from 'node:test';
import assert from 'node:assert/strict';
import { runTask, summarizeResult } from '../engine.js';

const server = { name: 'fixture' };
function fake(statuses = ['working', 'completed'], result = { content: [{ type: 'text', text: 'ready' }] }) {
  const calls = { creates: 0, gets: 0, cancels: 0, closes: 0, waits: [] };
  let index = 0;
  const connection = {
    revision: 0,
    async createTask() { calls.creates++; return { task: { taskId: 't-1', status: 'working' } }; },
    async getTask() { calls.gets++; const status = statuses[Math.min(index++, statuses.length - 1)]; return { taskId: 't-1', status, pollInterval: 10 }; },
    async getResult() { return result; },
    async cancelTask() { calls.cancels++; return 'Cancellation acknowledged.'; },
    async close() { calls.closes++; },
    async waitForUpdate(revision, delay, signal) { calls.waits.push(delay); signal.throwIfAborted(); },
  };
  return { calls, connection, open: async () => connection };
}
function run(fixture, extra = {}) { return runTask({ server, toolName: 'wait', args: {}, signal: new AbortController().signal, open: fixture.open, ...extra }); }

test('a real remote task settles once, publishes only status changes and closes', async () => {
  const fixture = fake(['working', 'working', 'completed']);
  const progress = [];
  const result = await run(fixture, { report: line => progress.push(line) });
  assert.equal(result.status, 'completed');
  assert.equal(JSON.parse(result.result).task_id, 't-1');
  assert.equal(fixture.calls.creates, 1);
  assert.equal(fixture.calls.gets, 3);
  assert.equal(fixture.calls.cancels, 0);
  assert.equal(fixture.calls.closes, 1);
  assert.equal(progress.filter(line => line.includes(': working')).length, 1);
  assert.deepEqual(fixture.calls.waits, [1000, 1000]);
});

test('a transport failure never replays task creation', async () => {
  const fixture = fake();
  fixture.connection.createTask = async () => { fixture.calls.creates++; throw new Error('transport lost after send'); };
  const result = await run(fixture);
  assert.equal(result.status, 'failed');
  assert.equal(fixture.calls.creates, 1);
  assert.match(result.result, /indeterminate/);
  assert.equal(fixture.calls.closes, 1);
});

test('isError is a failed DSH job even with a completed protocol task', async () => {
  const result = await run(fake(['completed'], { isError: true, content: [{ type: 'text', text: 'denied' }] }));
  assert.equal(result.status, 'failed');
  assert.match(result.result, /denied/);
});

test('failed tasks retrieve failure details and never claim success', async () => {
  const fixture = fake(['failed']);
  fixture.connection.getResult = async () => { throw new Error('backend rejected execution'); };
  const result = await run(fixture);
  assert.equal(result.status, 'failed');
  assert.match(result.result, /backend rejected/);
  assert.equal(fixture.calls.cancels, 0);
});

test('remote cancellation maps to killed', async () => {
  const fixture = fake(['cancelled']);
  assert.equal((await run(fixture)).status, 'killed');
  assert.equal(fixture.calls.cancels, 0);
});

test('interactive input is unsupported and triggers bounded best-effort cancellation', async () => {
  const fixture = fake(['input_required']);
  const result = await run(fixture);
  assert.equal(result.status, 'failed');
  assert.match(result.result, /interactive input/);
  assert.equal(fixture.calls.cancels, 1);
  assert.equal(fixture.calls.closes, 1);
});

test('local kill cancels the remote task and settles the producer', async () => {
  const controller = new AbortController();
  const fixture = fake(['working']);
  fixture.connection.waitForUpdate = async () => { controller.abort(new Error('user stopped')); };
  const result = await run(fixture, { signal: controller.signal });
  assert.equal(result.status, 'killed');
  assert.equal(fixture.calls.cancels, 1);
  assert.equal(fixture.calls.closes, 1);
});

test('monitoring deadline is failure rather than a successful or user-killed job', async () => {
  const fixture = fake(['working']);
  fixture.connection.waitForUpdate = async (_rev, _delay, signal) => {
    await new Promise(resolve => setTimeout(resolve, 20));
    signal.throwIfAborted();
  };
  const result = await run(fixture, { maxDurationMs: 5 });
  assert.equal(result.status, 'failed');
  assert.match(result.detail, /deadline/);
  assert.equal(fixture.calls.cancels, 1);
});

test('cancel failure is explicit and still closes transport', async () => {
  const fixture = fake(['input_required']);
  fixture.connection.cancelTask = async () => { throw new Error('closed'); };
  const result = await run(fixture);
  assert.match(result.result, /may still be running/);
  assert.equal(fixture.calls.closes, 1);
});

test('wrong task id is never delivered to the owner as success', async () => {
  const fixture = fake();
  fixture.connection.getTask = async () => ({ taskId: 'other-owner-task', status: 'completed' });
  const result = await run(fixture);
  assert.equal(result.status, 'failed');
  assert.equal(fixture.calls.cancels, 1);
});

test('poll suggestions cannot produce a busy loop or an unbounded delay', async () => {
  const fixture = fake();
  let count = 0;
  fixture.connection.getTask = async () => ({ taskId: 't-1', status: count++ > 2 ? 'completed' : 'working', pollInterval: count === 1 ? -10 : count === 2 ? 1e50 : NaN });
  await run(fixture, { minPollMs: 100, maxPollMs: 2000 });
  assert.deepEqual(fixture.calls.waits, [100, 2000, 100]);
});

test('notification storms cannot bypass the authoritative-read minimum interval', async () => {
  const fixture = fake(['working', 'working', 'completed']);
  const times = [];
  const get = fixture.connection.getTask;
  fixture.connection.getTask = async () => { times.push(performance.now()); fixture.connection.revision++; return get(); };
  await run(fixture, { minPollMs: 50 });
  assert.ok(times[1] - times[0] >= 40);
  assert.ok(times[2] - times[1] >= 40);
});

test('synchronous optional-task response is labeled inline, not a fabricated task', async () => {
  const fixture = fake();
  fixture.connection.createTask = async () => ({ content: [{ type: 'text', text: 'inline' }] });
  const result = await run(fixture);
  assert.equal(result.status, 'completed');
  assert.equal(JSON.parse(result.result).execution, 'inline');
  assert.equal(fixture.calls.gets, 0);
});

test('rich base64 content never enters the delivered result', () => {
  const result = summarizeResult({ content: [{ type: 'image', data: 'SENSITIVE-BINARY' }, { type: 'text', text: 'hello' }] }, {}, 4096);
  assert.doesNotMatch(result, /SENSITIVE-BINARY/);
  assert.match(result, /omitted/);
});

test('result retention is bounded and truncation is explicit', () => {
  const result = summarizeResult({ content: [{ type: 'text', text: 'я'.repeat(10000) }], structuredContent: { big: 'x'.repeat(10000) } }, {}, 4096);
  assert.ok(Buffer.byteLength(result) <= 4096);
  assert.equal(JSON.parse(result).truncated, true);
});

test('JSON escaping cannot bypass the result byte bound', () => {
  const result = summarizeResult({ content: [{ type: 'text', text: '\\"\\\\'.repeat(20000) }] }, { task_id: 't' }, 4096);
  assert.ok(Buffer.byteLength(result) <= 4096);
  assert.equal(JSON.parse(result).truncated, true);
});
