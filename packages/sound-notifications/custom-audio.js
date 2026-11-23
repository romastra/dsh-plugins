import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { createHash } from 'node:crypto';

export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const ENDPOINT = 'sound-notifications/audio';
const MAX_BASE64_LENGTH = 4 * Math.ceil(MAX_AUDIO_BYTES / 3);
const MAX_REQUEST_BYTES = MAX_BASE64_LENGTH + 4096;
const EXTENSIONS = new Set(['.wav', '.mp3', '.ogg', '.m4a', '.aac', '.flac', '.webm']);

class AudioError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AudioError';
    this.code = code;
  }
}
const fail = (code, message) => { throw new AudioError(code, message); };
function checkAbort(signal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Audio operation cancelled', 'AbortError');
}
function validName(name) {
  if (typeof name !== 'string' || !name || name.length > 200 || name !== name.trim()
      || /[<>:"/\\|?*\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u.test(name)
      || /[. ]$/.test(name) || name === '.' || name === '..'
      || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:[ .]|$)/i.test(name)) {
    fail('invalid-name', 'Audio name must be a safe basename of at most 200 characters');
  }
  if (!EXTENSIONS.has(extname(name).toLowerCase())) {
    fail('unsupported-format', 'Supported audio extensions: wav, mp3, ogg, m4a, aac, flac, webm');
  }
  return name;
}
function validSize(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_AUDIO_BYTES) {
    fail('invalid-size', 'Audio must contain 1 to 10485760 bytes (10 MiB)');
  }
}
function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
// Count only object-level separators, not colons inside escaped JSON strings.
// JSON.parse alone would silently accept duplicate reference fields.
function referenceFieldCount(text) {
  let quoted = false, escaped = false, depth = 0, count = 0;
  for (const char of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') depth--;
    else if (char === ':' && depth === 1) count++;
  }
  return count;
}

/** The empty string selects the built-in sound; other values are durable file references. */
export function validateSoundReference(value) {
  if (value === '') return '';
  if (typeof value !== 'string' || value.length > 4096) fail('invalid-reference', 'Expected a custom audio reference or an empty string');
  let ref;
  try { ref = JSON.parse(value); } catch { fail('invalid-reference', 'Custom audio reference must be JSON'); }
  if (!exactKeys(ref, ['attachmentId', 'name', 'bytes']) || referenceFieldCount(value) !== 3
      || typeof ref.attachmentId !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(ref.attachmentId)) {
    fail('invalid-reference', 'Custom audio reference must contain exactly attachmentId, name and bytes');
  }
  validName(ref.name);
  validSize(ref.bytes);
  return JSON.stringify({ attachmentId: ref.attachmentId, name: ref.name, bytes: ref.bytes });
}

function starts(data, text, offset = 0) {
  return data.length >= offset + text.length && data.toString('latin1', offset, offset + text.length) === text;
}
function mp3Header(data) {
  if (data.length >= 10 && starts(data, 'ID3') && data[3] >= 2 && data[3] <= 4 && data[4] !== 255
      && !(data[6] & 128) && !(data[7] & 128) && !(data[8] & 128) && !(data[9] & 128)) return true;
  return data.length >= 4 && data[0] === 255 && (data[1] & 224) === 224
    && ((data[1] >> 3) & 3) !== 1 && ((data[1] >> 1) & 3) === 1
    && (data[2] >> 4) !== 15 && ((data[2] >> 2) & 3) !== 3;
}
function aacHeader(data) {
  if (data.length < 7 || data[0] !== 255 || (data[1] & 246) !== 240 || ((data[2] >> 2) & 15) > 12) return false;
  const headerBytes = data[1] & 1 ? 7 : 9;
  const frameBytes = ((data[3] & 3) << 11) | (data[4] << 3) | (data[5] >> 5);
  return data.length >= headerBytes && frameBytes >= headerBytes;
}
function m4aHeader(data) {
  if (data.length < 16 || !starts(data, 'ftyp', 4)) return false;
  const boxBytes = data.readUInt32BE(0);
  if (boxBytes < 16 || boxBytes > data.length || boxBytes % 4) return false;
  const brands = new Set(['M4A ', 'M4B ', 'M4P ', 'F4A ', 'F4B ', 'isom', 'iso2', 'mp41', 'mp42', 'dash']);
  if (brands.has(data.toString('latin1', 8, 12))) return true;
  for (let offset = 16; offset < boxBytes; offset += 4) {
    if (brands.has(data.toString('latin1', offset, offset + 4))) return true;
  }
  return false;
}
function validateAudio(name, data) {
  validName(name);
  validSize(data.length);
  // These are recognizable container/header checks, not decoding or duration checks.
  // The Client must decode audio and enforce the 30-second duration limit separately.
  const matches = {
    '.wav': () => (starts(data, 'RIFF') || starts(data, 'RIFX') || starts(data, 'RF64')) && starts(data, 'WAVE', 8),
    '.mp3': () => mp3Header(data),
    '.ogg': () => starts(data, 'OggS') && data.length >= 5 && data[4] === 0,
    '.m4a': () => m4aHeader(data),
    '.aac': () => aacHeader(data),
    '.flac': () => starts(data, 'fLaC'),
    '.webm': () => data.length >= 4 && data[0] === 26 && data[1] === 69 && data[2] === 223 && data[3] === 163,
  };
  if (!matches[extname(name).toLowerCase()]()) fail('unsupported-format', 'Audio header does not match its supported file extension');
}
function decodeBase64(data) {
  if (typeof data !== 'string' || !data || data.length > MAX_BASE64_LENGTH || data.length % 4
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) fail('invalid-base64', 'Audio data must be canonical base64 within the 10 MiB limit');
  const bytes = data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
  validSize(bytes);
  const decoded = Buffer.from(data, 'base64');
  if (decoded.toString('base64') !== data) fail('invalid-base64', 'Audio data must be canonical base64');
  return decoded;
}
function digest(data) { return `sha256:${createHash('sha256').update(data).digest('hex')}`; }

async function readLocalFile(filePath, signal) {
  checkAbort(signal);
  if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) fail('invalid-file', 'Expected a local audio file path');
  const name = validName(basename(filePath));
  let handle;
  try {
    // Reject links, directories and special files before opening; check the opened
    // handle as well. NOFOLLOW/NONBLOCK close link/FIFO races where supported.
    const initial = await lstat(filePath);
    checkAbort(signal);
    if (!initial.isFile()) fail('invalid-file', 'Audio source must be a regular file, not a link or directory');
    validSize(initial.size);
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const before = await handle.stat();
    checkAbort(signal);
    if (!before.isFile() || initial.dev !== before.dev || initial.ino !== before.ino) fail('invalid-file', 'Audio source changed while opening');
    validSize(before.size);
    const data = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < data.length) {
      checkAbort(signal);
      const { bytesRead } = await handle.read(data, offset, Math.min(65536, data.length - offset), offset);
      if (!bytesRead) fail('invalid-file', 'Audio source changed while reading');
      offset += bytesRead;
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, offset);
    const after = await handle.stat();
    checkAbort(signal);
    if (extra.bytesRead || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      fail('invalid-file', 'Audio source changed while reading');
    }
    validateAudio(name, data);
    return { name, data };
  } catch (error) {
    checkAbort(signal);
    if (error instanceof AudioError) throw error;
    throw new AudioError('invalid-file', 'Could not read a regular local audio file', error);
  } finally {
    if (handle) await handle.close();
  }
}

async function readRequestJson(request) {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_REQUEST_BYTES)) fail('invalid-size', 'Audio request exceeds the upload limit');
  if (!request.body) fail('bad-request', 'Expected a JSON request body');
  const reader = request.body.getReader();
  const chunks = [];
  let bytes = 0, finished = false;
  const aborted = () => { void reader.cancel(request.signal.reason).catch(() => {}); };
  request.signal.addEventListener('abort', aborted, { once: true });
  try {
    while (true) {
      checkAbort(request.signal);
      const chunk = await reader.read();
      checkAbort(request.signal);
      if (chunk.done) { finished = true; break; }
      bytes += chunk.value.byteLength;
      if (bytes > MAX_REQUEST_BYTES) fail('invalid-size', 'Audio request exceeds the upload limit');
      chunks.push(Buffer.from(chunk.value));
    }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
      return JSON.parse(text);
    } catch { fail('bad-request', 'Expected valid UTF-8 JSON'); }
  } finally {
    request.signal.removeEventListener('abort', aborted);
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Stores immutable copies; importing/uploading never applies Settings selections. */
export function installCustomAudio(ctx) {
  const attachments = ctx.attachments;
  let disposed = false;
  function available(signal) {
    checkAbort(signal);
    if (disposed) fail('unavailable', 'Custom audio service has unloaded');
  }
  async function save(name, data, signal) {
    available(signal);
    validateAudio(name, data);
    let stored;
    try { stored = await attachments.saveFile({ data, name }); }
    catch (error) {
      checkAbort(signal);
      throw new AudioError('storage-failed', 'Could not store custom audio', error);
    }
    available(signal);
    const reference = validateSoundReference(JSON.stringify(stored));
    const ref = JSON.parse(reference);
    if (ref.bytes !== data.length || ref.attachmentId !== digest(data)) fail('attachment-mismatch', 'Stored audio reference does not match the submitted bytes');
    return { reference, name: ref.name, bytes: ref.bytes };
  }
  async function importFile(filePath, signal) {
    available(signal);
    const { name, data } = await readLocalFile(filePath, signal);
    return save(name, data, signal);
  }
  async function read(reference, signal) {
    available(signal);
    const canonical = validateSoundReference(reference);
    if (!canonical) fail('invalid-reference', 'The built-in sound has no custom audio attachment');
    const ref = JSON.parse(canonical);
    const data = Buffer.alloc(ref.bytes);
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      for await (const chunk of attachments.readFileStream(ref, signal)) {
        available(signal);
        if (!(chunk instanceof Uint8Array)) fail('attachment-mismatch', 'Stored audio returned invalid bytes');
        const end = bytes + chunk.byteLength;
        if (end > ref.bytes || end > MAX_AUDIO_BYTES) fail('attachment-mismatch', 'Stored audio exceeds its declared byte length');
        // One bounded destination also handles tiny or backend-reused chunks
        // without retaining an unbounded list of per-chunk allocations.
        data.set(chunk, bytes);
        hash.update(data.subarray(bytes, end));
        bytes = end;
      }
    } catch (error) {
      checkAbort(signal);
      if (error instanceof AudioError) throw error;
      throw new AudioError('storage-failed', 'Could not read stored custom audio', error);
    }
    available(signal);
    if (bytes !== ref.bytes || `sha256:${hash.digest('hex')}` !== ref.attachmentId) fail('attachment-mismatch', 'Stored audio does not match its reference');
    validateAudio(ref.name, data);
    return { name: ref.name, bytes, data: data.toString('base64') };
  }
  async function operation(payload, signal) {
    available(signal);
    if (payload?.action === 'upload' && exactKeys(payload, ['action', 'name', 'data'])) {
      validName(payload.name);
      return save(payload.name, decodeBase64(payload.data), signal);
    }
    if (payload?.action === 'read' && exactKeys(payload, ['action', 'reference'])) return read(payload.reference, signal);
    fail('bad-request', 'Expected upload {name, data} or read {reference}');
  }
  function failure(error, signal) {
    if (signal?.aborted) return { ok: false, error: { code: 'aborted', message: 'Audio operation cancelled', details: {} } };
    if (error instanceof AudioError) return { ok: false, error: { code: error.code, message: error.message, details: {} } };
    return { ok: false, error: { code: 'audio-failed', message: 'Custom audio operation failed', details: {} } };
  }
  // The Connection Fetch registry provides authentication for HTTP and Desktop
  // carriers. Gateway owns the single RPC interceptor; this module never uses it.
  ctx.effect(() => {
    const unregister = ctx.connection.fetch.register({
      path: `/api/${ENDPOINT}`, methods: ['POST'], requestBody: 'streaming',
      async fetch(request) {
        let rpcId = '';
        const response = (result, status = 200, headers) => Response.json({ type: 'server-response', rpcId, result }, { status, headers });
        if (request.method !== 'POST') return response(failure(new AudioError('bad-request', 'POST required')), 405, { Allow: 'POST' });
        if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
          return response(failure(new AudioError('bad-request', 'application/json required')), 415);
        }
        let message;
        try { message = await readRequestJson(request); }
        catch (error) { return response(failure(error, request.signal), error instanceof AudioError && error.code === 'invalid-size' ? 413 : 400); }
        if (typeof message?.rpcId === 'string') rpcId = message.rpcId;
        if (!exactKeys(message, ['type', 'rpcId', 'method', 'payload']) || message.type !== 'client-request'
            || typeof message.rpcId !== 'string' || message.method !== ENDPOINT) {
          return response(failure(new AudioError('bad-request', 'Invalid custom audio request envelope')), 400);
        }
        try { return response({ ok: true, value: await operation(message.payload, request.signal) }); }
        catch (error) { return response(failure(error, request.signal)); }
      },
    });
    return () => { disposed = true; return unregister(); };
  });
  return { importFile, read };
}
