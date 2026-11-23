import { ZipFile } from './vendor/yazl.cjs';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { once } from 'node:events';
export const CHUNK_BYTES = 64 * 1024;
const EMPTY = new Uint8Array();

export class ExportError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'ExportError';
    this.code = code;
    this.status = status;
  }
}

export function safeFilename(sessionId) {
  return `dsh-session-${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}-with-project.zip`;
}

export function validSessionId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ExportError('invalid-session', 'Missing or invalid sessionId.', 400);
  }
  return value;
}

function safeSegment(name) {
  // Never let a filesystem entry introduce an archive path or a traversal.
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..' || /[\\/\u0000-\u001f\u007f]/u.test(name)) {
    throw new ExportError('unsafe-path', 'The project contains a filename that cannot be safely archived.');
  }
  return name;
}

export async function projectRoot(fs, cwd, signal) {
  signal.throwIfAborted();
  const root = await fs.resolve(cwd, { signal });
  const info = await fs.stat(root, signal);
  if (info?.type !== 'directory') {
    throw new ExportError('project-unavailable', 'The session project directory is unavailable.', 404);
  }
  return root;
}

/** All ordinary project files, including hidden/ignored files; no links are followed. */
export async function* projectEntries(fs, root, signal) {
  const skipped = [];
  yield { path: 'project/', data: EMPTY };
  async function* walk(directory, relative, depth) {
    signal.throwIfAborted();
    if (depth > 256) throw new ExportError('project-depth', 'The project directory nesting is too deep.');
    const entries = await fs.listDir(directory, signal);
    for (const entry of entries) {
      signal.throwIfAborted();
      const name = safeSegment(entry.name);
      const path = `${relative}${name}`;
      const sourcePath = `${directory.displayPath.replace(/[\\/]+$/u, '')}/${name}`;
      const info = await fs.lstat(sourcePath, {}, signal);
      if (info === undefined) throw new ExportError('project-changed', 'A project file disappeared during export. Retry when project changes have finished.');
      if (info.type === 'symlink' || info.type === 'other') {
        skipped.push(`${path}\t${info.type === 'symlink' ? 'symbolic link / junction (not followed)' : 'special file (not a regular file)'}`);
        continue;
      }
      const target = await fs.resolve(sourcePath, { signal });
      if (!fs.contains(root, target)) throw new ExportError('outside-project', 'A project path resolved outside the project directory.');
      if (info.type === 'directory') {
        yield { path: `project/${path}/`, data: EMPTY };
        yield* walk(target, `${path}/`, depth + 1);
      } else {
        yield { path: `project/${path}`, chunks: fileChunks(fs, target, info, signal) };
      }
    }
  }
  yield* walk(root, '', 0);
  if (skipped.length > 0) {
    yield { path: 'project-export-notes.txt', content: `Symbolic links, junctions and special files are not followed or copied.\nAll ordinary files (including hidden and ignored files) are included.\n\n${skipped.join('\n')}\n` };
  }
}

async function* fileChunks(fs, target, before, signal) {
  if (!Number.isSafeInteger(before.size) || before.size < 0) throw new ExportError('file-size', 'A project file has no supported byte size.');
  const current = await fs.stat(target, signal);
  if (current?.type !== 'file' || current.version !== before.version || current.size !== before.size) {
    throw new ExportError('project-changed', 'A project file changed during export. Retry when project changes have finished.');
  }
  let offset = 0;
  while (offset < before.size) {
    signal.throwIfAborted();
    const data = await fs.readByteRange(target, { offset, length: Math.min(CHUNK_BYTES, before.size - offset) }, signal);
    if (data.byteLength === 0 || data.byteLength > Math.min(CHUNK_BYTES, before.size - offset)) {
      throw new ExportError('project-changed', 'A project file changed during export. Retry when project changes have finished.');
    }
    offset += data.byteLength;
    yield data;
  }
  const after = await fs.stat(target, signal);
  if (after?.type !== 'file' || after.version !== before.version || after.size !== before.size) {
    throw new ExportError('project-changed', 'A project file changed during export. Retry when project changes have finished.');
  }
}

/** Encode bounded text chunks without splitting a UTF-16 surrogate pair. */
async function* textChunks(content) {
  const encoder = new TextEncoder();
  let offset = 0;
  while (offset < content.length) {
    let end = Math.min(offset + CHUNK_BYTES, content.length);
    if (end < content.length && /[\uD800-\uDBFF]/u.test(content[end - 1])) end -= 1;
    yield encoder.encode(content.slice(offset, end));
    offset = end;
  }
}

async function* entryChunks(entry) {
  if ('content' in entry) yield* textChunks(entry.content);
  else if ('data' in entry) {
    for (let i = 0; i < entry.data.byteLength; i += CHUNK_BYTES) yield entry.data.subarray(i, i + CHUNK_BYTES);
  } else {
    for await (const chunk of entry.chunks) {
      for (let i = 0; i < chunk.byteLength; i += CHUNK_BYTES) yield chunk.subarray(i, i + CHUNK_BYTES);
    }
  }
}

/** ZIP64-capable ZIP stream. Only metadata grows with file count, not file bytes. */
export function streamZip(entries, signal, { compressionLevel = 6, forceZip64Format = false } = {}) {
  const consumer = new AbortController();
  const combined = AbortSignal.any([signal, consumer.signal]);
  const zip = new ZipFile();
  let source;
  let closing = Promise.resolve();
  const fail = error => {
    consumer.abort(error instanceof Error ? error : new Error('Project export cancelled.'));
    source?.destroy(consumer.signal.reason);
    closing = zip.abort(consumer.signal.reason).catch(() => {});
  };
  const onAbort = () => fail(combined.reason);
  zip.on('error', fail);
  zip.outputStream.on('close', () => {
    combined.removeEventListener('abort', onAbort);
    if (!zip.outputStream.readableEnded) fail(new Error('Project export cancelled.'));
  });
  // Readable.toWeb owns an error listener before any production starts.
  const web = Readable.toWeb(zip.outputStream, { strategy: { highWaterMark: CHUNK_BYTES, size: chunk => chunk.byteLength } });
  combined.addEventListener('abort', onAbort, { once: true });
  const outputDone = finished(zip.outputStream, { cleanup: true }).catch(() => {});
  const producing = (async () => {
    try {
      combined.throwIfAborted();
      const seen = new Set();
      for await (const entry of entries(combined)) {
        combined.throwIfAborted();
        if (!entry.path || entry.path.startsWith('/') || /^[A-Za-z]:/u.test(entry.path) || /\\|[\u0000-\u001f\u007f]/u.test(entry.path)
          || entry.path.split('/').some(part => part === '..' || part === '.')) {
          throw new ExportError('unsafe-path', 'An archive entry has an unsafe path.');
        }
        if (seen.has(entry.path)) throw new ExportError('duplicate-path', 'Duplicate archive path.');
        seen.add(entry.path);
        if (entry.path.endsWith('/')) {
          zip.addEmptyDirectory(entry.path);
        } else {
          source = Readable.from(entryChunks(entry), { objectMode: false, highWaterMark: CHUNK_BYTES });
          const complete = finished(source, { cleanup: true });
          complete.catch(() => {}); // Also observed if addReadStream rejects synchronously.
          zip.addReadStream(source, entry.path, { compressionLevel, forceZip64Format });
          await complete;
          source = undefined;
        }
        // yazl applies .pipe() backpressure to payloads. Also bound runs of empty directories.
        if (zip.outputStream.writableNeedDrain) await once(zip.outputStream, 'drain', { signal: combined });
      }
      combined.throwIfAborted();
      zip.end({ forceZip64Format });
    } catch (error) { fail(error); }
  })();
  const settled = (async () => { await outputDone; await producing; await closing; })();
  const reader = web.getReader();
  let cancelled = false;
  const result = new ReadableStream({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (cancelled) return;
        if (next.done) { reader.releaseLock(); controller.close(); }
        else controller.enqueue(next.value);
      } catch (error) { if (!cancelled) controller.error(error); }
    },
    async cancel(reason) {
      cancelled = true;
      fail(reason);
      await reader.cancel(reason).catch(() => {});
      await settled;
      reader.releaseLock();
    },
  }, { highWaterMark: CHUNK_BYTES, size: chunk => chunk.byteLength });
  Object.defineProperty(result, 'settled', { value: settled });
  return result;
}

export async function* streamChunks(stream) {
  const reader = stream.getReader();
  let complete = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) { complete = true; return; }
      yield value;
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
