import assert from 'node:assert/strict';
import test from 'node:test';
import { unzipSync, strFromU8 } from 'fflate';
import * as logApi from '@deepseek-ai/dsh-session-log-export';
import { projectEntries, projectRoot, streamZip, streamChunks, validSessionId, safeFilename } from '../archive.js';
import { createExportService, EXPORT_PATH } from '../service.js';

const enc = new TextEncoder();
const abort = () => new AbortController().signal;
const readZip = async stream => unzipSync(new Uint8Array(await new Response(stream).arrayBuffer()));

function fixtureFs() {
  const nodes = new Map([
    ['/work', { type: 'directory' }],
    ['/work/.env', { type: 'file', data: enc.encode('SECRET=local\n') }],
    ['/work/src', { type: 'directory' }],
    ['/work/src/проект 😀.txt', { type: 'file', data: enc.encode('Привет 😀\r\n') }],
    ['/work/empty', { type: 'directory' }],
    ['/work/zero.bin', { type: 'file', data: new Uint8Array() }],
    ['/work/binary.bin', { type: 'file', data: Uint8Array.from([0, 255, 128, 0, 7, 10, 13]) }],
    ['/work/outside-link', { type: 'symlink' }],
    ['/work/pipe', { type: 'other' }],
    ['/work/node_modules', { type: 'directory' }],
    ['/work/node_modules/dep.js', { type: 'file', data: enc.encode('ignored but included') }],
  ]);
  const counts = { list: 0, read: 0, maxRead: 0, bytes: 0 };
  const target = value => ({ targetKey: value, displayPath: value });
  const info = node => node && ({ type: node.type, version: node.version ?? 'v1', ...(node.type === 'file' ? { size: node.data.length } : {}) });
  return {
    nodes, counts,
    async resolve(path) { return target(path); },
    contains(parent, child) { return child.targetKey === parent.targetKey || child.targetKey.startsWith(`${parent.targetKey}/`); },
    async stat(value) { return info(nodes.get(value.targetKey)); },
    async lstat(path) { return info(nodes.get(path)); },
    async listDir(value) {
      counts.list++;
      const prefix = `${value.targetKey}/`;
      return [...nodes].filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
        .map(([path, node]) => ({ name: path.slice(prefix.length), type: node.type, target: target(path) }));
    },
    async readByteRange(value, range, signal) {
      signal?.throwIfAborted(); counts.read++; counts.maxRead = Math.max(counts.maxRead, range.length);
      const data = nodes.get(value.targetKey).data.slice(range.offset, range.offset + range.length);
      counts.bytes += data.length;
      return data;
    },
  };
}

function fixtureContext() {
  const fs = fixtureFs();
  const flushed = [];
  const header = id => ({ version: 4, id, createdAt: 1, cwd: '/initial', isSeeded: false, delegationDepth: id === 'root' ? 0 : 1 });
  const fileRef = { attachmentId: `sha256:${'a'.repeat(64)}`, name: 'attached.bin', bytes: 4 };
  const rootEvents = [{ seq: 0, time: 1, type: 'user/message', surfaceOp: 'append', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Hello' }, { type: 'file', attachment: fileRef }] } }];
  const childEvents = [{ seq: 0, time: 2, type: 'session/title', data: { title: 'Child' } }];
  const ctx = {
    fs, flushed,
    sessionPersistence: {
      async open(id) {
        if (!['root', 'child'].includes(id)) throw new Error('missing fixture session');
        return { header: header(id), async read() { return { events: id === 'root' ? rootEvents : childEvents }; }, async close() {} };
      },
    },
    sessionQuery: {
      async inspectSession(id, getter) { return getter({ id, header: header(id), effective: '/work' }); },
      async traceSession() { return { descendants: [{ session: { header: header('child') }, descendants: [] }] }; },
    },
    workingDirectory: { get(session) { return session.effective; } },
    sessions: { get(id) { return { id }; }, async flush(session) { flushed.push(session.id); } },
    attachments: {
      async *readFileStream() { yield Uint8Array.from([1, 2]); yield Uint8Array.from([3, 4]); },
      async saveFileStream({ data, name }) {
        const chunks = []; for await (const chunk of data) chunks.push(chunk);
        ctx.saved = Buffer.concat(chunks);
        return { attachmentId: 'sha256:test', bytes: ctx.saved.length, name };
      },
      fileHostPath() { return '/stored/export.zip'; },
    },
    logger: { warn() {} },
    get(name) { return this[name]; },
  };
  return ctx;
}

function req(method = 'GET', query = 'sessionId=root', signal) {
  return new Request(`http://127.0.0.1${EXPORT_PATH}?${query}`, { method, signal });
}

test('full project: hidden, ignored, binary, Unicode and empty directories; links do not leak', async () => {
  const fs = fixtureFs();
  const root = await projectRoot(fs, '/work', abort());
  const zip = await readZip(streamZip(signal => projectEntries(fs, root, signal), abort()));
  assert.equal(strFromU8(zip['project/.env']), 'SECRET=local\n');
  assert.equal(strFromU8(zip['project/src/проект 😀.txt']), 'Привет 😀\r\n');
  assert.deepEqual(zip['project/binary.bin'], Uint8Array.from([0, 255, 128, 0, 7, 10, 13]));
  assert.equal(zip['project/zero.bin'].length, 0);
  assert.equal(zip['project/empty/'].length, 0);
  assert.equal(strFromU8(zip['project/node_modules/dep.js']), 'ignored but included');
  assert.equal(zip['project/outside-link'], undefined);
  assert.equal(zip['project/pipe'], undefined);
  assert.match(strFromU8(zip['project-export-notes.txt']), /outside-link.*symbolic link/u);
  assert.match(strFromU8(zip['project-export-notes.txt']), /pipe.*special file/u);
});

test('same ZIP includes canonical log, descendants, stored attachments and current (not initial) project', async () => {
  const ctx = fixtureContext();
  const service = createExportService(ctx, logApi);
  const response = await service.response(req());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.match(response.headers.get('content-disposition'), /root-with-project\.zip/u);
  const zip = await readZip(response.body);
  assert.match(strFromU8(zip[logApi.SESSION_LOG_FILENAME]), /"type":"session"/u);
  assert.match(strFromU8(zip[logApi.SESSION_LOG_FILENAME]), /Hello/u);
  assert.match(strFromU8(zip[`subagents/child/${logApi.SESSION_LOG_FILENAME}`]), /Child/u);
  const attachment = Object.keys(zip).find(name => name.endsWith('/attached.bin'));
  assert.deepEqual(zip[attachment], Uint8Array.from([1, 2, 3, 4]));
  assert.ok(zip['project/.env']);
  assert.deepEqual(ctx.flushed, ['root', 'child']);
  service.dispose();
});

test('tool and UI use the same archive content; a save consumes the entire ZIP', async () => {
  const ctx = fixtureContext(); const service = createExportService(ctx, logApi);
  const ui = await readZip((await service.response(req())).body);
  const saved = await service.save('root', abort());
  const tool = unzipSync(ctx.saved);
  assert.deepEqual(Object.keys(tool), Object.keys(ui));
  for (const name of Object.keys(ui)) assert.deepEqual(tool[name], ui[name], name);
  assert.equal(saved.filePath, '/stored/export.zip');
  assert.equal(saved.attachment.bytes, ctx.saved.length);
  assert.equal(saved.projectDirectory, '/work');
  service.dispose();
});

test('HEAD checks root log and project without walking/compressing project files', async () => {
  const ctx = fixtureContext(); const service = createExportService(ctx, logApi);
  const response = await service.response(req('HEAD'));
  assert.equal(response.status, 200); assert.equal(response.body, null);
  assert.equal(ctx.fs.counts.list, 0); assert.equal(ctx.fs.counts.read, 0);
  service.dispose();
});

test('missing/duplicate/invalid IDs and missing project fail before download', async () => {
  const ctx = fixtureContext(); const service = createExportService(ctx, logApi);
  for (const query of ['', 'sessionId=', 'sessionId=root&sessionId=child', 'sessionId=%00']) {
    assert.equal((await service.response(req('GET', query))).status, 400);
  }
  ctx.fs.nodes.delete('/work');
  assert.equal((await service.response(req('HEAD'))).status, 404);
  service.dispose();
});

test('root session absence is 404 and unexpected preparation failures are sanitized', async () => {
  const ctx = fixtureContext();
  const absentApi = { ...logApi, async readSessionLogText() { return undefined; } };
  const absent = createExportService(ctx, absentApi);
  assert.equal((await absent.response(req())).status, 404); absent.dispose();
  ctx.sessionQuery.inspectSession = async () => { throw new Error('private host path /very/private'); };
  const failed = createExportService(ctx, logApi);
  const response = await failed.response(req());
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /private/u); failed.dispose();
});

test('changing or disappearing files fail loudly, never produce a successful partial ZIP', async () => {
  const fs = fixtureFs(); const original = fs.readByteRange;
  fs.readByteRange = async (...args) => { const data = await original(...args); fs.nodes.get(args[0].targetKey).version = 'v2'; return data; };
  const root = await projectRoot(fs, '/work', abort());
  await assert.rejects(readZip(streamZip(signal => projectEntries(fs, root, signal), abort())), /changed/u);
});

test('filesystem read denial and path traversal are not silently skipped', async () => {
  const fs = fixtureFs(); const root = await projectRoot(fs, '/work', abort());
  fs.readByteRange = async () => { throw new Error('read denied'); };
  await assert.rejects(readZip(streamZip(signal => projectEntries(fs, root, signal), abort())), /read denied/u);
  fs.listDir = async () => [{ name: '../outside', type: 'file' }];
  await assert.rejects(readZip(streamZip(signal => projectEntries(fs, root, signal), abort())), /safely archived/u);
});

test('project bytes stream in bounded chunks, with binary fidelity', async () => {
  const fs = fixtureFs(); const bytes = Uint8Array.from({ length: 300000 }, (_, i) => (i * 17) & 255);
  fs.nodes.set('/work/large.bin', { type: 'file', data: bytes });
  const root = await projectRoot(fs, '/work', abort());
  const zip = await readZip(streamZip(signal => projectEntries(fs, root, signal), abort()));
  assert.deepEqual(zip['project/large.bin'], bytes);
  assert.ok(fs.counts.maxRead <= 65536);
});

test('UTF-16 text boundary preserves emoji in the session log', async () => {
  const content = `${'x'.repeat(65535)}😀${'y'.repeat(65536)}`;
  const zip = await readZip(streamZip(async function* () { yield { path: 'log.txt', content }; }, abort()));
  assert.equal(strFromU8(zip['log.txt']), content);
});

test('ZIP64 end records and file descriptors are supported', async () => {
  const entries = async function* () { yield { path: 'test.txt', content: 'ZIP64 content' }; };
  const bytes = new Uint8Array(await new Response(streamZip(entries, abort(), { forceZip64Format: true })).arrayBuffer());
  assert.ok(Buffer.from(bytes).includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])));
  assert.ok(Buffer.from(bytes).includes(Buffer.from([0x50, 0x4b, 0x06, 0x07])));
  assert.equal(strFromU8(unzipSync(bytes)['test.txt']), 'ZIP64 content');
});

test('unsafe standard-log entry paths are refused too', async () => {
  for (const path of ['../escape', '/absolute', 'C:/absolute', 'dir/../escape', 'bad\\\\path']) {
    await assert.rejects(readZip(streamZip(async function* () { yield { path, content: 'x' }; }, abort())), /unsafe/u);
  }
});

test('consumer cancellation stops the producer and closes the active file stream', async () => {
  let reads = 0; let closed = false;
  const entries = async function* () {
    yield { path: 'large.bin', chunks: (async function* () {
      try { for (let i = 0; i < 100; i++) { reads++; yield new Uint8Array(65536).fill(i); } }
      finally { closed = true; }
    })() };
  };
  const stream = streamZip(entries, abort(), { compressionLevel: 0 });
  const reader = stream.getReader();
  // A ZIP header may arrive before the file generator has ever been opened.
  // Cancel after actual payload reads to test active-file cleanup.
  while (reads === 0) { const next = await reader.read(); assert.equal(next.done, false); }
  await reader.cancel();
  assert.ok(reads > 0 && reads < 100); assert.equal(closed, true);
});

test('unload/request cancellation stops future preparation and file reads', async () => {
  const ctx = fixtureContext(); const service = createExportService(ctx, logApi);
  service.dispose();
  await assert.rejects(service.response(req()), /unloaded/u);
  const c = new AbortController(); c.abort(new Error('test abort'));
  const second = createExportService(ctx, logApi);
  await assert.rejects(second.save('root', c.signal), /test abort/u); second.dispose();
});

test('IDs cannot inject a download filename or header', () => {
  assert.equal(safeFilename('../hello"\r\n'), 'dsh-session-___hello___-with-project.zip');
  assert.throws(() => validSessionId(''), /invalid/u);
  assert.throws(() => validSessionId('bad\n'), /invalid/u);
});

test('stream adapter cancels its source when the attachment store stops early', async () => {
  let cancelled = false;
  const source = new ReadableStream({ pull(c) { c.enqueue(Uint8Array.from([1])); }, cancel() { cancelled = true; } });
  for await (const _ of streamChunks(source)) break;
  assert.equal(cancelled, true);
});
