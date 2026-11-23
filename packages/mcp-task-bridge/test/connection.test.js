import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openConnection } from '../connection.js';
import { Config } from '../index.js';

// Each connection starts its own uniquely owned process. No shared executable fixture,
// network/SSH service, installed profile, SDK monkeypatch, or persistent fixture files.
const fixture = String.raw`
import { createInterface } from 'node:readline';
const mode = process.env.FIXTURE_MODE ?? '';
let calls = 0;
let searches = 0;
let cancelled = 0;
const stamp = '2026-01-01T00:00:00Z';
const task = (status = 'working', taskId = mode === 'bad-id' ? 'x'.repeat(513) : 'made-' + calls) => ({ taskId, status, ttl: 5000, createdAt: stamp, lastUpdatedAt: stamp });
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const tool = { name: 'raw_task', inputSchema: { type: 'object', properties: { count: { type: 'integer', minimum: 1 } }, required: ['count'], additionalProperties: false }, outputSchema: { type: 'object', properties: { answer: { type: 'integer' } }, required: ['answer'] }, execution: { taskSupport: mode === 'forbidden' ? 'forbidden' : 'optional' } };
if (mode === 'long-description') tool.description = 'x'.repeat(12000);
if (mode === 'schema-collision') { tool.inputSchema.$id = 'urn:fixture:shared'; tool.outputSchema.$id = 'urn:fixture:shared'; }
const search = { name: 'search_tools', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, annotations: { readOnlyHint: mode !== 'unsafe-search' } };
const capabilities = { tools: {}, tasks: { requests: { tools: { call: {} } }, ...(mode === 'no-cancel' ? {} : { cancel: {} }) } };
if (mode === 'no-task-cap') delete capabilities.tasks.requests;
async function handle(request) {
  const { method, id, params } = request;
  if (id === undefined) return;
  let result;
  if (method === 'initialize') {
    if (mode === 'startup-hang') return;
    result = { protocolVersion: '2025-11-25', capabilities, serverInfo: { name: 'unique-local-fixture', version: '1' } };
  } else if (method === 'tools/list') {
    if (mode === 'request-hang') return;
    if (['metadata', 'near-match', 'unsafe-search'].includes(mode)) result = { tools: [search] };
    else if (mode === 'cycle') result = { tools: [], nextCursor: 'same' };
    else if (mode === 'too-many') result = { tools: [], nextCursor: String(Number(params?.cursor ?? 0) + 1) };
    else result = params?.cursor ? { tools: [tool] } : { tools: [search], nextCursor: 'page-two' };
  } else if (method === 'tools/call' && params.name === 'search_tools') {
    searches++;
    if (params.task) throw new Error('Discovery search must not create a task');
    if (params.arguments.query !== 'raw_task') throw new Error('Expected exact name query');
    result = { content: [{ type: 'text', text: JSON.stringify([{ ...tool, name: mode === 'near-match' ? 'prefix_raw_task' : tool.name }]) }] };
  } else if (method === 'tools/call') {
    calls++;
    if (!params.task || params.task.ttl !== 5000) throw new Error('Missing legacy task ttl');
    if (mode === 'disconnect') { process.exit(0); return; }
    if (mode === 'secret-error') {
      send({ jsonrpc: '2.0', id, error: { code: -32603, message: process.env.EXPLICIT_TOKEN, data: { secret: process.env.EXPLICIT_TOKEN } } }); return;
    }
    result = mode === 'inline' ? { content: [], structuredContent: { answer: 42 } } : { task: task() };
  } else if (method === 'tasks/get') {
    if (mode === 'notify') send({ jsonrpc: '2.0', method: 'notifications/tasks/status', params: task('completed', params.taskId) });
    if (mode === 'notify-later') setTimeout(() => send({ jsonrpc: '2.0', method: 'notifications/tasks/status', params: task('completed', params.taskId) }), 25);
    result = { ...task('completed', params.taskId), statusMessage: JSON.stringify({ calls, searches, cancelled }) };
  } else if (method === 'tasks/result') {
    result = { content: [], structuredContent: mode === 'bad-output' ? { answer: 'wrong' } : {
      answer: 42, ambientRemoved: !process.env.AMBIENT_TOKEN && !process.env.AMBIENT_KEY && !process.env.DSH_FIXTURE_PRIVATE,
      explicitApplied: process.env.EXPLICIT_TOKEN === 'explicit-fixture-secret', marker: process.env.FIXTURE_MARKER,
    } };
  } else if (method === 'tasks/cancel') {
    cancelled++;
    if (mode === 'cancel-fails') { send({ jsonrpc: '2.0', id, error: { code: -32603, message: process.env.EXPLICIT_TOKEN } }); return; }
    result = task('cancelled', params.taskId);
  } else throw new Error('Unexpected method ' + method);
  send({ jsonrpc: '2.0', id, result });
}
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  handle(request).catch(error => send({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: error.message } }));
});
`;

function config(mode = '', extra = {}) {
  return { name: 'local-fixture', transport: 'stdio', command: process.execPath,
    args: ['--input-type=module', '-e', fixture], allowedTools: ['raw_task'],
    startupTimeoutMs: 2000, requestTimeoutMs: 1000,
    env: { FIXTURE_MODE: mode, EXPLICIT_TOKEN: 'explicit-fixture-secret', FIXTURE_MARKER: 'isolated' }, ...extra };
}
async function connect(t, mode, extra) {
  const connection = await openConnection(config(mode, extra));
  t.after(() => connection.close());
  return connection;
}
const create = connection => connection.createTask('raw_task', { count: 1 }, { ttl: 5000 });

test('full tools/list pagination and exact allowlist, task creation/get/result/cancel', async t => {
  const connection = await connect(t);
  assert.deepEqual(Object.keys(connection).sort(), ['cancelTask', 'capabilities', 'close', 'createTask', 'getResult', 'getTask', 'listTaskTools', 'resolveTool', 'revision', 'waitForUpdate'].sort());
  assert.equal((await connection.resolveTool('raw_task')).execution.taskSupport, 'optional');
  await assert.rejects(connection.resolveTool('raw'), /allowedTools/);
  const tools = await connection.listTaskTools();
  assert.equal(tools.length, 1);
  tools[0].execution.taskSupport = 'forbidden';
  const receipt = await create(connection);
  assert.equal(receipt.task.taskId, 'made-1');
  const status = await connection.getTask(receipt.task.taskId);
  assert.equal(status.status, 'completed');
  assert.equal((await connection.getResult(receipt.task.taskId)).structuredContent.answer, 42);
  assert.match(await connection.cancelTask(receipt.task.taskId), /acknowledged/);
  assert.equal(JSON.parse((await connection.getTask(receipt.task.taskId)).statusMessage).cancelled, 1);
  await connection.close();
  await connection.close();
  await assert.rejects(connection.getTask(receipt.task.taskId), /closed/);
});

test('BM25 metadata fallback is read-only, exact, allowlisted and keeps execution/input schemas', async t => {
  const connection = await connect(t, 'metadata');
  const tool = await connection.resolveTool('raw_task');
  assert.deepEqual(tool.inputSchema.required, ['count']);
  assert.equal(tool.execution.taskSupport, 'optional');
  await create(connection);
  assert.equal(JSON.parse((await connection.getTask('made-1')).statusMessage).searches, 1);
});

for (const mode of ['near-match', 'unsafe-search']) test(`rejects unsafe/mismatched metadata: ${mode}`, async t => {
  const connection = await connect(t, mode);
  await assert.rejects(create(connection), /Exact|read-only/);
});
for (const mode of ['cycle', 'too-many']) test(`guards tools/list pagination: ${mode}`, async t => {
  const connection = await connect(t, mode);
  await assert.rejects(connection.resolveTool('raw_task'), /cycle|100 pages/);
});

test('AJV input preflight rejects invalid arguments before any tools/call', async t => {
  const connection = await connect(t);
  for (const args of [{ count: '1' }, { count: 0 }, {}, { count: 1, extra: true }]) {
    await assert.rejects(connection.createTask('raw_task', args, { ttl: 5000 }), /inputSchema/);
  }
  assert.equal((await create(connection)).task.taskId, 'made-1');
});
for (const mode of ['forbidden', 'no-task-cap']) test(`enforces raw execution + server capability: ${mode}`, async t => {
  const connection = await connect(t, mode);
  assert.deepEqual(await connection.listTaskTools(), []);
  await assert.rejects(create(connection), /taskSupport|tasks.requests.tools.call/);
  assert.equal(JSON.parse((await connection.getTask('inspect')).statusMessage).calls, 0);
});

test('task IDs and discovery description have explicit bounds', async t => {
  const bad = await connect(t, 'bad-id');
  await assert.rejects(create(bad), /taskId/);
  await assert.rejects(bad.getTask(''), /taskId/);
  await assert.rejects(bad.getResult('x'.repeat(513)), /taskId/);
  assert.match(await bad.cancelTask(''), /failed/);
  const described = await connect(t, 'long-description');
  assert.equal((await described.resolveTool('raw_task')).description.length, 8192);
});

test('inline response remains raw CallToolResult instead of requiring a task receipt', async t => {
  const connection = await connect(t, 'inline');
  assert.deepEqual(await create(connection), { content: [], structuredContent: { answer: 42 } });
});
test('getResult validates advertised structured output and rejects unowned tasks', async t => {
  const connection = await connect(t, 'bad-output');
  const receipt = await create(connection);
  await assert.rejects(connection.getResult(receipt.task.taskId), /outputSchema/);
  await assert.rejects(connection.getResult('other-connection-task'), /not owned/);
});

test('output validator is not replaced by input schema sharing its remote $id', async t => {
  const connection = await connect(t, 'schema-collision');
  const receipt = await create(connection);
  assert.equal((await connection.getResult(receipt.task.taskId)).structuredContent.answer, 42);
});

test('notifications increment revision; snapshot-before-get prevents lost wakeup', async t => {
  const connection = await connect(t, 'notify');
  const receipt = await create(connection);
  const revision = connection.revision;
  await connection.getTask(receipt.task.taskId);
  // Ensure SDK asynchronous notification dispatch has run, without relying on wall-clock timing.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(connection.revision, revision + 1);
  const controller = new AbortController();
  const wait = connection.waitForUpdate(revision, 10000, controller.signal);
  await wait;
});
test('notification wakes an already-registered waiter and aborted waits stop', async t => {
  const connection = await connect(t, 'notify-later');
  const receipt = await create(connection);
  await connection.getTask(receipt.task.taskId);
  await connection.waitForUpdate(connection.revision, 1000);
  assert.equal(connection.revision, 1);
  const controller = new AbortController();
  const waiting = connection.waitForUpdate(connection.revision, 10000, controller.signal);
  controller.abort(new Error('stop waiting'));
  await assert.rejects(waiting, /stop waiting/);
});

test('unsupported and failed cancellation return diagnostics, never cleanup exceptions', async t => {
  const unsupported = await connect(t, 'no-cancel');
  assert.match(await unsupported.cancelTask('a'), /unsupported/);
  assert.equal(JSON.parse((await unsupported.getTask('inspect')).statusMessage).cancelled, 0);
  const failed = await connect(t, 'cancel-fails');
  const result = await failed.cancelTask('a');
  assert.match(result, /failed.*REDACTED/);
  assert.ok(!result.includes('explicit-fixture-secret'));
});
test('cancellation owns its signal and works after creation signal abort', async t => {
  const connection = await connect(t);
  const controller = new AbortController();
  const receipt = await connection.createTask('raw_task', { count: 1 }, { ttl: 5000, signal: controller.signal });
  controller.abort(new Error('job stopped'));
  assert.match(await connection.cancelTask(receipt.task.taskId), /acknowledged/);
});

test('ambient credentials scrubbed, explicit env applied; connections are isolated', async t => {
  const keys = ['AMBIENT_TOKEN', 'AMBIENT_KEY', 'DSH_FIXTURE_PRIVATE'];
  const original = keys.map(key => process.env[key]);
  for (const key of keys) process.env[key] = 'ambient-fixture-secret';
  t.after(() => keys.forEach((key, index) => original[index] === undefined ? delete process.env[key] : process.env[key] = original[index]));
  const first = await connect(t);
  const second = await connect(t);
  const a = await create(first);
  const b = await create(second);
  assert.equal(a.task.taskId, 'made-1');
  assert.equal(b.task.taskId, 'made-1');
  const data = (await first.getResult(a.task.taskId)).structuredContent;
  assert.equal(data.ambientRemoved, true);
  assert.equal(data.explicitApplied, true);
  assert.equal(data.marker, 'isolated');
  assert.ok(!JSON.stringify(first).includes('explicit-fixture-secret'));
});
test('request failures redact secrets and omit SDK error data/cause', async t => {
  const connection = await connect(t, 'secret-error');
  await assert.rejects(create(connection), error => {
    assert.match(error.message, /REDACTED/);
    assert.ok(!error.message.includes('explicit-fixture-secret'));
    assert.equal(error.data, undefined);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('startup/request deadlines, preaborted startup and transport loss are bounded', async t => {
  await assert.rejects(openConnection(config('startup-hang', { startupTimeoutMs: 80 })), /deadline|timed out/);
  const controller = new AbortController();
  controller.abort(new Error('already stopped'));
  await assert.rejects(openConnection(config(), controller.signal), /already stopped/);
  const hanging = await connect(t, 'request-hang', { requestTimeoutMs: 80 });
  await assert.rejects(hanging.resolveTool('raw_task'), /deadline|timed out/);
  const lost = await connect(t, 'disconnect');
  await assert.rejects(create(lost), /closed|Connection/);
});

test('StreamableHTTP uses SDK initialization, headers and exactly one task POST', async t => {
  let creations = 0;
  const auth = 'Bearer local-http-secret';
  const server = createServer(async (req, res) => {
    assert.equal(req.url, '/private-mcp-fixture');
    assert.equal(req.headers.authorization, auth);
    if (req.method === 'GET') { res.writeHead(405).end(); return; }
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    if (request.id === undefined) { res.writeHead(202).end(); return; }
    let result;
    if (request.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {}, tasks: { requests: { tools: { call: {} } } } }, serverInfo: { name: 'local-http', version: '1' } };
    else if (request.method === 'tools/list') result = { tools: [{ name: 'raw_task', inputSchema: { type: 'object' }, execution: { taskSupport: 'required' } }] };
    else if (request.method === 'tools/call') {
      creations++;
      assert.deepEqual(request.params.task, { ttl: 5000 });
      res.writeHead(500, { 'Content-Type': 'text/plain' }).end('local-http-secret'); return;
    } else throw new Error('Unexpected HTTP method');
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/private-mcp-fixture`;
  const { servers: [configured] } = Config({ servers: [{ name: 'http', transport: 'streamable-http',
    url, headers: { Authorization: auth }, allowedTools: ['raw_task'], startupTimeoutMs: 2000, requestTimeoutMs: 1000 }] });
  assert.equal(configured.url, url);
  const connection = await openConnection(configured);
  t.after(() => connection.close());
  await assert.rejects(create(connection), error => !error.message.includes('local-http-secret'));
  assert.equal(creations, 1);
  await connection.close();
});
