/** DSH Host adapter for the already installed shared Windows Parakeet queue. */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

export const inject = ['webServer'];
export const VERSION = '1.0.0';
const ROUTE = '/local-parakeet';
const BRIDGE = fileURLToPath(new URL('./native_bridge.py', import.meta.url));
const MAX_AUDIO = 20 * 1024 * 1024;
export const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
export const MAX_BRIDGE_JSON_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT = MAX_BRIDGE_JSON_BYTES + 2; // Python canonical JSON plus Windows CRLF.
const ADMISSION = Symbol.for('dsh.local-parakeet.transcription-admission.v1');
const sharedAdmissions = globalThis[ADMISSION] ?? (globalThis[ADMISSION] = new Map());
if (!(sharedAdmissions instanceof Map)) throw new Error('Invalid shared Parakeet admission registry');

export class HttpError extends Error {
  constructor(status, message, code = 'failed') { super(message); this.name = 'HttpError'; this.status = status; this.code = code; }
}

export function resolveSettings(raw = {}, runtime = {}) {
  const platform = runtime.platform ?? process.platform;
  const env = runtime.env ?? process.env;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid Parakeet configuration');
  if (raw.threads !== undefined && raw.threads !== 6) throw new Error('The shared worker is fixed to six CPU threads');
  if (raw.maxRecordingSeconds !== undefined && raw.maxRecordingSeconds !== 120) throw new Error('This dictation UI is capped at 120 seconds');
  const base = env.LOCALAPPDATA || win32.join(runtime.home ?? homedir(), 'AppData', 'Local');
  const candidate = raw.workerRoot ?? win32.join(base, 'OpenClawASR');
  if (typeof candidate !== 'string' || !win32.isAbsolute(candidate) || candidate.startsWith('\\\\') || candidate.includes('\0')) throw new Error('workerRoot must be an absolute local Windows directory');
  const root = win32.resolve(candidate);
  const maxAudioBytes = raw.maxAudioBytes ?? MAX_AUDIO;
  if (!Number.isInteger(maxAudioBytes) || maxAudioBytes < 512 || maxAudioBytes > MAX_AUDIO) throw new Error('Invalid audio size limit');
  return Object.freeze({ root, python: win32.join(root, 'venv', 'Scripts', 'python.exe'), platform, maxAudioBytes,
    threads: 6, maxRecordingSeconds: 120, maxSegmentSeconds: 20, maxWaiters: 8,
    statusTimeoutMs: 15000, prepareTimeoutMs: 45000, transcribeTimeoutMs: 250000 });
}

export function bridgeEnvironment(env = process.env) {
  const clean = {};
  for (const name of ['SystemRoot', 'WINDIR', 'SystemDrive', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'LOCALAPPDATA', 'USERPROFILE']) {
    if (typeof env[name] === 'string') clean[name] = env[name];
  }
  clean.PATH = win32.join(env.SystemRoot || env.WINDIR || 'C:\\Windows', 'System32');
  clean.OMP_NUM_THREADS = '6'; clean.OPENBLAS_NUM_THREADS = '1'; clean.MKL_NUM_THREADS = '1'; clean.NUMEXPR_NUM_THREADS = '1';
  return clean;
}

function bridgeFailure(code) {
  const value = typeof code === 'string' && /^[a-z0-9_-]{1,80}$/.test(code) ? code : 'bridge_failed';
  if (/timeout|deadline/.test(value)) return new HttpError(504, 'Распознавание Parakeet не уложилось в отведённое время. Запись сохранена для повторной попытки.', value);
  if (/busy|queue_full/.test(value)) return new HttpError(503, 'Общий распознаватель занят. Повторите попытку немного позже.', value);
  if (/audio|wav|duration|too_large|too_short/.test(value)) return new HttpError(400, 'Parakeet получил неподдерживаемую или слишком длинную WAV-запись.', value);
  if (/empty/.test(value)) return new HttpError(422, 'Parakeet не распознал речь в записи.', value);
  if (/missing|manifest|identity|owner|install|runtime|config|unsupported/.test(value)) return new HttpError(503, 'Не удалось проверить установленный Windows-worker Parakeet. Проверьте его состояние; повторная загрузка модели не выполняется.', value);
  return new HttpError(502, 'Windows-worker Parakeet не завершил распознавание. Запись доступна для повторной попытки.', value);
}

export function createBridgeRunner(settings, dependencies = {}) {
  const spawnChild = dependencies.spawn ?? spawn;
  const fileExists = dependencies.exists ?? existsSync;
  return (mode, audio) => new Promise((resolve, reject) => {
    if (!['status', 'prepare', 'transcribe'].includes(mode)) { reject(new HttpError(500, 'Недопустимая операция bridge.', 'bridge_mode')); return; }
    if (settings.platform !== 'win32' || !fileExists(settings.python)) { reject(bridgeFailure('runtime_missing')); return; }
    const timeout = mode === 'status' ? settings.statusTimeoutMs : mode === 'prepare' ? settings.prepareTimeoutMs : settings.transcribeTimeoutMs;
    let child;
    try { child = spawnChild(settings.python, ['-X', 'utf8', '-I', '-B', BRIDGE, mode, '--root', settings.root], { windowsHide: true, env: bridgeEnvironment(dependencies.env ?? process.env), stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { reject(bridgeFailure('bridge_spawn')); return; }
    let settled = false, stdout = '', stderrBytes = 0, timer;
    const fail = error => { if (settled) return; settled = true; clearTimeout(timer); reject(error); };
    timer = setTimeout(() => {
      // Only this stdlib bridge helper is addressed; NEVER terminate the shared worker or its process tree.
      fail(bridgeFailure('bridge_timeout'));
      try { child.kill(); } catch { /* exited */ }
    }, timeout);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (settled) return;
      stdout += chunk;
      if (Buffer.byteLength(stdout) > MAX_OUTPUT) { fail(bridgeFailure('bridge_output_limit')); try { child.kill(); } catch {} }
    });
    // Drain bounded diagnostics, but neither private transcripts nor exception text enter logs/UI.
    child.stderr.on('data', chunk => { stderrBytes = Math.min(stderrBytes + chunk.length, 65536); });
    child.on('error', () => fail(bridgeFailure('bridge_spawn')));
    child.on('close', code => {
      if (settled) return;
      let payload;
      const wire = stdout.endsWith(String.fromCharCode(13,10)) ? stdout.slice(0,-2) : stdout.endsWith(String.fromCharCode(10)) ? stdout.slice(0,-1) : stdout;
      if (Buffer.byteLength(wire) > MAX_BRIDGE_JSON_BYTES) { fail(bridgeFailure('bridge_output_limit')); return; }
      try { payload = JSON.parse(wire); } catch { fail(bridgeFailure('bridge_protocol')); return; }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) { fail(bridgeFailure('bridge_protocol')); return; }
      if (code !== 0 || payload.ok !== true) { fail(bridgeFailure(payload.code)); return; }
      if (mode === 'transcribe' && (typeof payload.text !== 'string' || Buffer.byteLength(payload.text) > MAX_TRANSCRIPT_BYTES)) { fail(bridgeFailure('bridge_text_limit')); return; }
      settled = true; clearTimeout(timer); resolve(payload);
    });
    child.stdin.on('error', () => fail(bridgeFailure('bridge_stdin')));
    child.stdin.end(mode === 'transcribe' ? audio : undefined);
  });
}

/** One active transcription per gate; status/prepare metadata helpers deliberately bypass admission. */
export function createRequestGate(maxWaiters = 8) {
  let active = false, disposed = false;
  const pending = [];
  const activate = item => {
    active = true; item.signal?.removeEventListener('abort', item.abort);
    let released = false;
    item.resolve(() => { if (released) return; released = true; active = false; pump(); });
  };
  const pump = () => { if (active || disposed) return; while (pending.length) { const item = pending.shift(); if (!item.signal?.aborted) { activate(item); break; } } };
  return {
    acquire(signal) {
      if (disposed) return Promise.reject(new HttpError(503, 'Плагин остановлен.', 'disposed'));
      if (signal?.aborted) return Promise.reject(new HttpError(499, 'Запрос отменён.', 'cancelled'));
      if (active && pending.length >= maxWaiters) return Promise.reject(new HttpError(429, 'Слишком много запросов диктовки. Повторите позже.', 'queue_full'));
      return new Promise((resolve, reject) => {
        const item = { signal, resolve, reject, abort: null };
        item.abort = () => { const index = pending.indexOf(item); if (index >= 0) { pending.splice(index, 1); reject(new HttpError(499, 'Запрос отменён.', 'cancelled')); } };
        if (!active) activate(item); else { pending.push(item); signal?.addEventListener('abort', item.abort, { once: true }); }
      });
    },
    dispose() { disposed = true; for (const item of pending.splice(0)) { item.signal?.removeEventListener('abort', item.abort); item.reject(new HttpError(503, 'Плагин остановлен.', 'disposed')); } },
    snapshot() { return { active, queued: pending.length, disposed }; },
  };
}

export function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin) {
    let parsed; try { parsed = new URL(origin); } catch { throw new HttpError(403, 'Недопустимый Origin.', 'origin'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.host !== req.headers.host) throw new HttpError(403, 'Голосовой ввод доступен только со страницы DSH.', 'origin');
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Межсайтовый запрос запрещён.', 'origin');
}

export async function readBody(req, limit) {
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) > limit)) throw new HttpError(413, 'Запись превышает допустимый размер.', 'audio_too_large');
  const chunks = []; let bytes = 0;
  for await (const piece of req) { const chunk = Buffer.isBuffer(piece) ? piece : Buffer.from(piece); bytes += chunk.length; if (bytes > limit) throw new HttpError(413, 'Запись превышает допустимый размер.', 'audio_too_large'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}

function sendJson(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.end(); return; }
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(body);
}

export function createController(config, dependencies = {}) {
  const settings = resolveSettings(config, dependencies.runtime);
  const run = dependencies.runBridge ?? createBridgeRunner(settings, dependencies);
  const admissionKey = settings.root.toLowerCase();
  if (!sharedAdmissions.has(admissionKey)) sharedAdmissions.set(admissionKey, createRequestGate(settings.maxWaiters));
  const gate = sharedAdmissions.get(admissionKey);
  const lifecycle = new AbortController();
  const state = { disposed: false, preparing: null, statusPromise: null, cached: null, cachedAt: 0, phase: 'idle', error: '' };
  const statusShape = info => ({ ready: info.ready === true, preparing: state.preparing !== null, phase: state.preparing ? 'checking' : info.ready ? 'ready' : 'error', message: info.ready ? 'Установленная модель Parakeet готова; worker запускается по запросу.' : 'Не удалось проверить установленный Windows-worker Parakeet.', error: state.error, model: 'nvidia-parakeet-tdt-0.6b-v3-int8', language: 'auto', dataRoot: settings.root, maxRecordingSeconds: 120, estimatedModelMb: 0, engine: 'sherpa-onnx', device: 'cpu', threads: 6, maxSegmentSeconds: 20, running: info.running === true, modelReady: info.modelReady === true, sharedWorker: true, idleTimeoutSeconds: 900, version: VERSION });
  async function status(force = false) {
    if (state.disposed) return statusShape({ ready: false });
    if (!force && state.cached && Date.now() - state.cachedAt < 1000) return statusShape(state.cached);
    if (!state.statusPromise) state.statusPromise = run('status').then(info => { state.cached = info; state.cachedAt = Date.now(); state.error = ''; return info; }).catch(error => { state.cached = { ready: false }; state.cachedAt = Date.now(); state.error = error instanceof HttpError ? error.message : 'Проверка Windows-worker завершилась ошибкой.'; return state.cached; }).finally(() => { state.statusPromise = null; });
    return statusShape(await state.statusPromise);
  }
  async function prepare() {
    if (!state.preparing) {
      state.phase = 'checking'; state.error = '';
      state.preparing = run('prepare').then(info => { state.cached = info; state.cachedAt = Date.now(); return info; }).catch(error => { state.error = error instanceof HttpError ? error.message : 'Проверка установки не удалась.'; throw error; }).finally(() => { state.preparing = null; });
    }
    await state.preparing; return statusShape(state.cached ?? { ready: false });
  }
  async function transcribe(req, res) {
    const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!['audio/wav', 'application/octet-stream'].includes(contentType)) throw new HttpError(415, 'Ожидается WAV-аудио.', 'audio_type');
    const controller = new AbortController();
    const abandon = () => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', abandon); res.once('close', abandon);
    let release;
    try {
      const audio = await readBody(req, settings.maxAudioBytes);
      if (audio.length < 512) throw new HttpError(400, 'Запись слишком короткая.', 'audio_too_short');
      release = await gate.acquire(AbortSignal.any([controller.signal, lifecycle.signal]));
      if (state.disposed) throw new HttpError(503, 'Плагин остановлен.', 'disposed');
      const result = await run('transcribe', audio);
      if (typeof result.text !== 'string' || Buffer.byteLength(result.text) > MAX_TRANSCRIPT_BYTES) throw new HttpError(502, 'Недопустимый размер текста Parakeet.', 'bridge_text_limit');
      if (!result.text.trim()) throw new HttpError(422, 'Parakeet не распознал речь в записи.', 'empty');
      if (!controller.signal.aborted && !state.disposed) sendJson(res, 200, { text: result.text.trim(), language: 'auto', duration: result.duration ?? null, inferenceSeconds: result.inferenceSeconds ?? null, windows: result.windows ?? null, cacheHit: result.cacheHit === true });
    } finally { req.removeListener('aborted', abandon); res.removeListener('close', abandon); release?.(); }
  }
  async function handle(req, res) {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname !== ROUTE && !url.pathname.startsWith(ROUTE + '/')) { sendJson(res, 404, { error: 'Not found' }); return; }
      const route = url.pathname.slice(ROUTE.length) || '/';
      if (route === '/status' && req.method === 'GET') { sendJson(res, 200, await status()); return; }
      if (['/prepare', '/transcribe'].includes(route) && req.method === 'POST') { assertSameOrigin(req); if (route === '/prepare') sendJson(res, 200, await prepare()); else await transcribe(req, res); return; }
      if (['/status', '/prepare', '/transcribe'].includes(route)) { res.setHeader('allow', route === '/status' ? 'GET' : 'POST'); sendJson(res, 405, { error: 'Method not allowed' }); return; }
      sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      const safe = error instanceof HttpError ? error : new HttpError(500, 'Ошибка локального голосового ввода Parakeet.', 'failed');
      if (safe.status >= 500) dependencies.logger?.warn?.('local-parakeet request failed: %s', safe.code);
      sendJson(res, safe.status, { error: safe.message, code: safe.code });
    }
  }
  return { settings, handle, status, prepare, inspect: () => ({ ...gate.snapshot(), disposed: state.disposed }), dispose() { state.disposed = true; lifecycle.abort(); /* Keep global admission until old active work completes; never stop shared ASR. */ } };
}

export function apply(ctx, config) {
  const controller = createController(config, { logger: ctx.logger });
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler: controller.handle }));
  ctx.effect(() => () => controller.dispose());
  ctx.logger.info('local-parakeet: shared NVIDIA Parakeet Windows queue; six CPU; lazy model startup; no additional ASR server');
}
