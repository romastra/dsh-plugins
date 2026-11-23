import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rename, writeFile, open, symlink, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { MAX_AUDIO_BYTES, validateSoundReference, installCustomAudio } from './custom-audio.js';

const ENDPOINT = 'sound-notifications/audio';
const ID = `sha256:${'a'.repeat(64)}`;
const hash = data => `sha256:${createHash('sha256').update(data).digest('hex')}`;
function reference(data, name = 'bell.wav') {
  return JSON.stringify({ attachmentId: hash(data), name, bytes: data.length });
}
function wav(size = 48) {
  const data = Buffer.alloc(size);
  data.write('RIFF', 0);
  data.writeUInt32LE(size - 8, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(8000, 24);
  data.writeUInt32LE(16000, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(size - 44, 40);
  return data;
}
function m4a() {
  const data = Buffer.alloc(24);
  data.writeUInt32BE(24);
  data.write('ftypM4A ', 4);
  data.write('isommp42', 16);
  return data;
}
const FORMATS = [
  ['wav', wav()],
  ['mp3', Buffer.from([255, 251, 144, 100, 0, 0, 0, 0])],
  ['mp3', Buffer.from([73, 68, 51, 4, 0, 0, 0, 0, 0, 0])],
  ['ogg', Buffer.concat([Buffer.from('OggS'), Buffer.alloc(23)])],
  ['m4a', m4a()],
  ['aac', Buffer.from([255, 241, 80, 128, 0, 255, 252])],
  ['flac', Buffer.from('fLaC\x80\x00\x00\x00', 'latin1')],
  ['webm', Buffer.from([26, 69, 223, 163, 159, 66, 130, 132, 119, 101, 98, 109])],
];

function createStore() {
  const files = new Map();
  return {
    files,
    saves: [],
    reads: [],
    async saveFile({ data, name }) {
      assert.ok(data instanceof Uint8Array);
      const copy = Buffer.from(data);
      const ref = { attachmentId: hash(copy), name, bytes: copy.length };
      files.set(ref.attachmentId, copy);
      this.saves.push({ ref, data: copy });
      return { ...ref };
    },
    async *readFileStream(ref, signal) {
      this.reads.push({ ref, signal });
      const data = files.get(ref.attachmentId);
      if (!data) throw new Error('not found at C:\\private\\attachment-storage');
      for (let offset = 0; offset < data.length; offset += 7) {
        if (signal?.aborted) throw signal.reason;
        yield data.subarray(offset, Math.min(offset + 7, data.length));
      }
    },
  };
}
function fixture(t, attachments = createStore()) {
  const routes = [], effects = [];
  let unregisters = 0, registrationsInEffect = 0, insideEffect = false;
  const ctx = {
    attachments,
    effect(callback) {
      insideEffect = true;
      try { effects.push(callback()); } finally { insideEffect = false; }
    },
    connection: {
      fetch: {
        register(route) {
          assert.ok(insideEffect, 'route must be owned by ctx.effect');
          registrationsInEffect++;
          routes.push(route);
          return async () => { unregisters++; };
        },
      },
      rpc: { intercept() { assert.fail('Gateway owns the RPC interceptor'); } },
    },
    settings: { update() { assert.fail('upload/import must not apply settings'); } },
    tools: { register() { assert.fail('module must not register tools'); } },
  };
  const api = installCustomAudio(ctx);
  assert.deepEqual(Object.keys(api).sort(), ['importFile', 'read']);
  assert.equal(routes.length, 1);
  assert.equal(registrationsInEffect, 1);
  let disposed = false;
  async function dispose() {
    if (disposed) return;
    disposed = true;
    for (const cleanup of effects.toReversed()) await cleanup();
  }
  t.after(dispose);
  async function raw(body, { method = 'POST', headers = { 'Content-Type': 'application/json' }, signal } = {}) {
    const request = new Request(`http://localhost/api/${ENDPOINT}`, { method, headers, ...(method === 'GET' || method === 'HEAD' ? {} : { body }), signal });
    const response = await routes[0].fetch(request);
    const message = await response.json();
    assert.equal(message.type, 'server-response');
    assert.equal(typeof message.rpcId, 'string');
    return { response, message };
  }
  async function call(payload, rpcId = randomUUID()) {
    const result = await raw(JSON.stringify({ type: 'client-request', rpcId, method: ENDPOINT, payload }));
    assert.equal(result.message.rpcId, rpcId);
    return { ...result, result: result.message.result };
  }
  return { api, routes, attachments, call, raw, dispose, get unregisters() { return unregisters; } };
}
function errorResult(result, code) {
  assert.equal(result.ok, false);
  assert.equal(typeof result.error.message, 'string');
  assert.ok(result.error.message.length > 0);
  assert.deepEqual(result.error.details, {});
  if (code) assert.equal(result.error.code, code);
}
async function tempDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-custom-audio-test-'));
  const absolute = await realpath(directory);
  // Verify the resolved absolute target before any recursive test cleanup.
  assert.equal(dirname(absolute).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
  assert.ok(absolute.split(/[\\/]/).at(-1).startsWith('dsh-custom-audio-test-'));
  t.after(async () => {
    assert.equal(await realpath(directory), absolute);
    await rm(absolute, { recursive: true, force: true });
  });
  return absolute;
}

test('strict references canonicalize only the exact durable attachment shape', () => {
  const ref = { attachmentId: ID, name: 'My bell.WAV', bytes: MAX_AUDIO_BYTES };
  assert.equal(MAX_AUDIO_BYTES, 10485760);
  assert.equal(validateSoundReference(''), '');
  assert.equal(validateSoundReference(JSON.stringify({ bytes: ref.bytes, name: ref.name, attachmentId: ref.attachmentId }, null, 2)), JSON.stringify(ref));
  assert.equal(validateSoundReference(JSON.stringify({ ...ref, name: 'Колокольчик 🔔.ogg', bytes: 1 })), JSON.stringify({ attachmentId: ID, name: 'Колокольчик 🔔.ogg', bytes: 1 }));
  const bad = [
    undefined, null, {}, 0, [], ' ', '{}', 'null', '[]', 'true', 'not json',
    'C:\\audio\\bell.wav', '/tmp/bell.wav', 'https://example.test/bell.wav', 'data:audio/wav;base64,UklGRg==',
    JSON.stringify({ ...ref, attachmentId: 'sha256:../outside' }),
    JSON.stringify({ ...ref, attachmentId: `sha256:${'A'.repeat(64)}` }),
    JSON.stringify({ ...ref, attachmentId: `${ID}0` }),
    JSON.stringify({ ...ref, path: '/tmp/bell.wav' }),
    JSON.stringify({ ...ref, data: 'UklGRg==' }),
    JSON.stringify({ attachmentId: ID, name: 'bell.wav' }),
    JSON.stringify({ attachmentId: ID, bytes: 10 }),
    JSON.stringify({ name: 'bell.wav', bytes: 10 }),
    JSON.stringify({ ...ref, bytes: 0 }), JSON.stringify({ ...ref, bytes: -1 }),
    JSON.stringify({ ...ref, bytes: 1.5 }), JSON.stringify({ ...ref, bytes: MAX_AUDIO_BYTES + 1 }),
    JSON.stringify({ ...ref, bytes: '48' }), JSON.stringify({ ...ref, bytes: null }),
    `{"attachmentId":"${ID}","name":"old.wav","name":"bell.wav","bytes":48}`,
    `{"attachmentId":"${ID}","name":"old.wav","na\\u006de":"bell.wav","bytes":48}`,
    ' '.repeat(4097),
  ];
  for (const value of bad) assert.throws(() => validateSoundReference(value), undefined, String(value));
});

test('reference names reject traversal, host paths, unsafe basenames and unsupported extensions', () => {
  const invalid = [
    '', '.', '..', '../bell.wav', '..\\bell.wav', '/bell.wav', '\\bell.wav',
    'C:\\bell.wav', 'C:bell.wav', '//server/share/bell.wav', 'bell.wav:stream',
    'bell\u0000.wav', 'bell\n.wav', 'bell\t.wav', 'bell\u202e.wav', 'bell\ud800.wav',
    'bell?.wav', 'bell*.wav', 'bell|.wav', 'bell<.wav', 'bell>.wav', 'bell".wav',
    ' bell.wav', 'bell.wav ', 'bell.wav.', 'con.wav', 'NUL.mp3', 'COM1.ogg', 'lpt9.webm',
    `${'a'.repeat(197)}.wav`, 'bell.exe', 'bell.txt', 'bell', 'bell.aiff',
  ];
  for (const name of invalid) {
    assert.throws(() => validateSoundReference(JSON.stringify({ attachmentId: ID, name, bytes: 48 })), undefined, name);
  }
  assert.doesNotThrow(() => validateSoundReference(JSON.stringify({ attachmentId: ID, name: `${'a'.repeat(196)}.wav`, bytes: 48 })));
});

test('Fetch upload/read uses exact authenticated Connection route and canonical envelopes', async t => {
  const f = fixture(t);
  assert.equal(f.routes[0].path, '/api/sound-notifications/audio');
  assert.deepEqual(f.routes[0].methods, ['POST']);
  assert.equal(f.routes[0].requestBody, 'streaming');
  const data = wav();
  const uploaded = await f.call({ action: 'upload', name: 'request.wav', data: data.toString('base64') }, 'upload-1');
  assert.equal(uploaded.response.status, 200);
  assert.deepEqual(uploaded.result, { ok: true, value: { reference: reference(data, 'request.wav'), name: 'request.wav', bytes: data.length } });
  const read = await f.call({ action: 'read', reference: uploaded.result.value.reference }, 'read-1');
  assert.equal(read.response.status, 200);
  assert.deepEqual(read.result, { ok: true, value: { name: 'request.wav', bytes: data.length, data: data.toString('base64') } });
  assert.deepEqual(f.attachments.reads[0].ref, JSON.parse(uploaded.result.value.reference));
  assert.ok(f.attachments.reads[0].signal instanceof AbortSignal);
});

test('request and completion uploads keep independent durable references without applying Settings', async t => {
  const f = fixture(t);
  const requestData = wav();
  const completionData = wav();
  completionData[47] = 64;
  const request = await f.call({ action: 'upload', name: 'request.wav', data: requestData.toString('base64') });
  const completion = await f.call({ action: 'upload', name: 'completion.wav', data: completionData.toString('base64') });
  assert.equal(request.result.ok, true);
  assert.equal(completion.result.ok, true);
  assert.notEqual(request.result.value.reference, completion.result.value.reference);
  assert.equal((await f.api.read(request.result.value.reference)).data, requestData.toString('base64'));
  assert.equal((await f.api.read(completion.result.value.reference)).data, completionData.toString('base64'));
  assert.equal(f.attachments.saves.length, 2);
});

test('all supported extensions require matching recognizable audio headers', async t => {
  const f = fixture(t);
  for (const [extension, data] of FORMATS) {
    const name = `bell.${extension.toUpperCase()}`;
    const upload = await f.call({ action: 'upload', name, data: data.toString('base64') });
    assert.equal(upload.result.ok, true, name);
    assert.equal(upload.result.value.reference, reference(data, name));
    assert.deepEqual(await f.api.read(upload.result.value.reference), { name, bytes: data.length, data: data.toString('base64') });
  }
  const invalid = [
    ['bell.wav', Buffer.from('RIFF0000AVI ')],
    ['bell.wav', Buffer.from('WAVE')],
    ['bell.mp3', Buffer.from([255, 241, 80, 128, 0, 255, 252])],
    ['bell.mp3', Buffer.from([73, 68, 51, 255, 0, 0, 0, 0, 0, 0])],
    ['bell.ogg', Buffer.from('OggS\x01', 'latin1')],
    ['bell.m4a', Buffer.from('0000ftypxxxx0000')],
    ['bell.aac', Buffer.from([255, 251, 144, 100, 0, 0, 0])],
    ['bell.flac', Buffer.from('FLAC')],
    ['bell.webm', Buffer.from([26, 69, 223])],
    ['bell.exe', wav()], ['../bell.wav', wav()], ['bell.wav', Buffer.from('%PDF-1.7')],
  ];
  const saved = f.attachments.saves.length;
  for (const [name, data] of invalid) errorResult((await f.call({ action: 'upload', name, data: data.toString('base64') })).result);
  assert.equal(f.attachments.saves.length, saved);
});

test('canonical base64 rejects malformed alphabet, whitespace, padding and data URLs', async t => {
  const f = fixture(t);
  const canonical = wav().toString('base64');
  const invalid = [null, 0, {}, [], '', '====', 'A===', 'AA=A', 'A', 'AA', 'AAA',
    'AB==', 'AAB=', '-_8=', '////\n', `${canonical}\n`, ` ${canonical}`, `${canonical}=`, `data:audio/wav;base64,${canonical}`];
  for (const data of invalid) {
    errorResult((await f.call({ action: 'upload', name: 'bell.wav', data })).result, 'invalid-base64');
  }
  assert.equal(f.attachments.saves.length, 0);
});

test('10 MiB boundary is enforced before saving or unbounded reads', async t => {
  const f = fixture(t);
  const limit = wav(MAX_AUDIO_BYTES);
  const accepted = await f.call({ action: 'upload', name: 'large.wav', data: limit.toString('base64') });
  assert.equal(accepted.result.ok, true);
  assert.equal(accepted.result.value.bytes, MAX_AUDIO_BYTES);
  const tooLarge = wav(MAX_AUDIO_BYTES + 1);
  errorResult((await f.call({ action: 'upload', name: 'large.wav', data: tooLarge.toString('base64') })).result, 'invalid-size');
  errorResult((await f.call({ action: 'upload', name: 'large.wav', data: `${limit.toString('base64')}AAAA` })).result, 'invalid-base64');
  assert.equal(f.attachments.saves.length, 1);
});

test('agent-side import stores a durable copy that survives moving and replacing the source', async t => {
  const directory = await tempDirectory(t);
  const source = join(directory, 'source.wav');
  const moved = join(directory, 'moved.wav');
  assert.equal(resolve(source), source);
  assert.equal(resolve(moved), moved);
  assert.equal(dirname(moved), directory);
  const original = wav();
  await writeFile(source, original);
  const store = createStore();
  const f = fixture(t, store);
  const imported = await f.api.importFile(source);
  assert.deepEqual(imported, { reference: reference(original, 'source.wav'), name: 'source.wav', bytes: original.length });
  // Both absolute move targets were checked above; only disposable test fixtures move.
  await rename(source, moved);
  await writeFile(source, Buffer.from('no longer audio'));
  await writeFile(moved, Buffer.from('changed independently'));
  await f.dispose();
  const reloaded = fixture(t, store);
  assert.deepEqual(await reloaded.api.read(imported.reference), { name: 'source.wav', bytes: original.length, data: original.toString('base64') });
  assert.equal(store.saves.length, 1);
});

test('agent-side import validates extension, regular files, bounds, missing files and cancellation', async t => {
  const directory = await tempDirectory(t);
  const f = fixture(t);
  const directoryPath = join(directory, 'folder.wav');
  await mkdir(directoryPath);
  const cases = [
    ['bad.wav', Buffer.from('not audio'), 'unsupported-format'],
    ['bell.exe', wav(), 'unsupported-format'],
    ['empty.wav', Buffer.alloc(0), 'invalid-size'],
  ];
  for (const [name, bytes, code] of cases) {
    const path = join(directory, name);
    await writeFile(path, bytes);
    await assert.rejects(f.api.importFile(path), { code });
  }
  const largePath = join(directory, 'large.wav');
  const handle = await open(largePath, 'w');
  try { await handle.truncate(MAX_AUDIO_BYTES + 1); } finally { await handle.close(); }
  await assert.rejects(f.api.importFile(largePath), { code: 'invalid-size' });
  await assert.rejects(f.api.importFile(directoryPath), { code: 'invalid-file' });
  await assert.rejects(f.api.importFile(join(directory, 'missing.wav')), { code: 'invalid-file' });
  for (const path of ['', null, {}, '\0.wav']) await assert.rejects(f.api.importFile(path), { code: 'invalid-file' });
  const controller = new AbortController();
  const reason = new Error('stopped before import');
  controller.abort(reason);
  await assert.rejects(f.api.importFile(join(directory, 'missing.wav'), controller.signal), error => error === reason);
  assert.equal(f.attachments.saves.length, 0);
});

test('agent-side import refuses symbolic-link sources', async t => {
  const directory = await tempDirectory(t);
  const target = join(directory, 'target.wav');
  const link = join(directory, 'link.wav');
  await writeFile(target, wav());
  try { await symlink(target, link, 'file'); }
  catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'ENOSYS') {
      t.skip('This system does not grant file-symlink creation');
      return;
    }
    throw error;
  }
  const f = fixture(t);
  await assert.rejects(f.api.importFile(link), { code: 'invalid-file' });
  assert.equal(f.attachments.saves.length, 0);
});

test('read verifies bounded attachment chunks, final length, content hash and audio signature', async t => {
  const original = wav();
  const canonical = reference(original);
  let closed = false;
  const oversized = fixture(t, {
    async *readFileStream() {
      try { yield Buffer.alloc(original.length + 1); assert.fail('must stop at declared length'); }
      finally { closed = true; }
    },
  });
  await assert.rejects(oversized.api.read(canonical), { code: 'attachment-mismatch' });
  assert.equal(closed, true);
  const badChunks = [
    [original.subarray(0, original.length - 1)],
    [Buffer.alloc(original.length)],
    ['not Uint8Array'],
    [],
  ];
  for (const chunks of badChunks) {
    const f = fixture(t, { async *readFileStream() { yield* chunks; } });
    await assert.rejects(f.api.read(canonical), { code: 'attachment-mismatch' });
  }
  const badHeader = Buffer.from('not an audio file');
  const storedInvalid = fixture(t, { async *readFileStream() { yield badHeader; } });
  await assert.rejects(storedInvalid.api.read(reference(badHeader)), { code: 'unsupported-format' });
  const f = fixture(t);
  await assert.rejects(f.api.read(''), { code: 'invalid-reference' });
  await assert.rejects(f.api.read(JSON.stringify({ attachmentId: ID, name: 'bell.wav', bytes: MAX_AUDIO_BYTES + 1 })), { code: 'invalid-size' });
  assert.equal(f.attachments.reads.length, 0);
});

test('read copies reusable attachment buffers and passes AbortSignal through', async t => {
  const data = wav();
  const controller = new AbortController();
  let observedSignal;
  const f = fixture(t, {
    async *readFileStream(_ref, signal) {
      observedSignal = signal;
      const reused = Buffer.alloc(8);
      for (let offset = 0; offset < data.length; offset += reused.length) {
        const bytes = Math.min(reused.length, data.length - offset);
        data.copy(reused, 0, offset, offset + bytes);
        yield reused.subarray(0, bytes);
        reused.fill(255);
      }
    },
  });
  assert.deepEqual(await f.api.read(reference(data), controller.signal), { name: 'bell.wav', bytes: data.length, data: data.toString('base64') });
  assert.equal(observedSignal, controller.signal);
  controller.abort(new Error('stopped'));
  await assert.rejects(f.api.read(reference(data), controller.signal), error => error === controller.signal.reason);
});

test('cancellation stops attachment reads and uploads without returning a usable selection', async t => {
  const data = wav();
  const controller = new AbortController();
  const reason = new Error('cancelled during read');
  let closed = false;
  const f = fixture(t, {
    async *readFileStream(_ref, signal) {
      assert.equal(signal, controller.signal);
      try {
        yield data.subarray(0, 8);
        controller.abort(reason);
        yield data.subarray(8);
        assert.fail('aborted read must stop iteration');
      } finally { closed = true; }
    },
  });
  await assert.rejects(f.api.read(reference(data), controller.signal), error => error === reason);
  assert.equal(closed, true);
  const uploadController = new AbortController();
  let saves = 0;
  const uploader = fixture(t, {
    async saveFile({ data: bytes, name }) {
      saves++;
      uploadController.abort(new Error('cancelled during save'));
      return { attachmentId: hash(bytes), name, bytes: bytes.length };
    },
  });
  const body = JSON.stringify({ type: 'client-request', rpcId: 'cancel-save', method: ENDPOINT, payload: { action: 'upload', name: 'bell.wav', data: data.toString('base64') } });
  const cancelled = await uploader.raw(body, { signal: uploadController.signal });
  errorResult(cancelled.message.result, 'aborted');
  assert.equal(saves, 1);
});

test('upload rejects attachment service references that do not identify the saved bytes', async t => {
  const data = wav();
  for (const ref of [
    { attachmentId: ID, name: 'bell.wav', bytes: data.length },
    { attachmentId: hash(data), name: 'bell.wav', bytes: data.length - 1 },
    { attachmentId: hash(data), name: '../bell.wav', bytes: data.length },
    { attachmentId: hash(data), name: 'bell.wav', bytes: data.length, path: '/tmp/private' },
  ]) {
    const f = fixture(t, { async saveFile() { return ref; } });
    errorResult((await f.call({ action: 'upload', name: 'bell.wav', data: data.toString('base64') })).result);
  }
});

test('malformed Fetch envelopes and payloads return structured errors without generic file access', async t => {
  const f = fixture(t);
  const envelope = { type: 'client-request', rpcId: 'bad-1', method: ENDPOINT, payload: { action: 'upload', name: 'bell.wav', data: wav().toString('base64') } };
  const invalidMessages = [
    null, [], 0, 'hello', {}, { ...envelope, type: 'server-request' },
    { ...envelope, rpcId: 1 }, { ...envelope, method: 'attachments/read' },
    { ...envelope, url: 'file:///private.wav' },
    { type: 'client-request', rpcId: 'bad-1', method: ENDPOINT },
  ];
  for (const message of invalidMessages) {
    const result = await f.raw(JSON.stringify(message));
    assert.equal(result.response.status, 400);
    errorResult(result.message.result, 'bad-request');
  }
  const badPayloads = [
    null, [], {}, { action: 'importFile', filePath: 'C:\\private.wav' },
    { action: 'upload', name: 'bell.wav' }, { action: 'upload', data: 'UklGRg==' },
    { action: 'upload', name: 'bell.wav', data: 'UklGRg==', path: 'C:\\private.wav' },
    { action: 'read' }, { action: 'read', reference: '', url: 'file:///private.wav' },
    { action: 'read', reference: '/etc/passwd' }, { action: 'read', reference: 'https://example.test/bell.wav' },
    { action: 'read', reference: { attachmentId: ID, name: 'bell.wav', bytes: 48 } },
  ];
  for (const payload of badPayloads) errorResult((await f.call(payload)).result);
  for (const body of ['{', '', 'undefined']) {
    const result = await f.raw(body);
    assert.equal(result.response.status, 400);
    errorResult(result.message.result, 'bad-request');
  }
  const invalidUtf8 = await f.raw(Buffer.from([255, 254]));
  assert.equal(invalidUtf8.response.status, 400);
  errorResult(invalidUtf8.message.result, 'bad-request');
  const wrongType = await f.raw(JSON.stringify(envelope), { headers: { 'Content-Type': 'text/plain' } });
  assert.equal(wrongType.response.status, 415);
  errorResult(wrongType.message.result, 'bad-request');
  const wrongMethod = await f.raw('', { method: 'GET' });
  assert.equal(wrongMethod.response.status, 405);
  assert.equal(wrongMethod.response.headers.get('Allow'), 'POST');
  const jsonType = await f.raw(JSON.stringify(envelope), { headers: { 'Content-Type': 'Application/JSON; charset=utf-8' } });
  assert.equal(jsonType.message.result.ok, true);
  assert.equal(f.attachments.saves.length, 1);
});

test('Fetch request JSON reading is bounded even without Content-Length', async t => {
  const f = fixture(t);
  const maxRequestBytes = 4 * Math.ceil(MAX_AUDIO_BYTES / 3) + 4096;
  const oversized = await f.raw('x', { headers: { 'Content-Type': 'application/json', 'Content-Length': String(maxRequestBytes + 1) } });
  assert.equal(oversized.response.status, 413);
  errorResult(oversized.message.result, 'invalid-size');
  const streamed = await f.raw(' '.repeat(maxRequestBytes + 1));
  assert.equal(streamed.response.status, 413);
  errorResult(streamed.message.result, 'invalid-size');
  assert.equal(f.attachments.saves.length, 0);
});

test('storage failures are redacted and effect cleanup unregisters and disables operations', async t => {
  const data = wav();
  const f = fixture(t, {
    async saveFile() { throw new Error('private C:\\Users\\secret.wav credential'); },
    async *readFileStream() { throw new Error('private /home/secret.wav'); },
  });
  const failedSave = await f.call({ action: 'upload', name: 'bell.wav', data: data.toString('base64') });
  errorResult(failedSave.result, 'storage-failed');
  assert.ok(!JSON.stringify(failedSave.message).includes('private'));
  const failedRead = await f.call({ action: 'read', reference: reference(data) });
  errorResult(failedRead.result, 'storage-failed');
  assert.ok(!JSON.stringify(failedRead.message).includes('/home'));
  await f.dispose();
  assert.equal(f.unregisters, 1);
  await assert.rejects(f.api.read(reference(data)), { code: 'unavailable' });
  await assert.rejects(f.api.importFile('bell.wav'), { code: 'unavailable' });
  errorResult((await f.call({ action: 'read', reference: reference(data) })).result, 'unavailable');
});
