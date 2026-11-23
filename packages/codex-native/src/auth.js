// A surface adapter only: the registered authorization service owns OAuth and commit.
// No credential reads, runtime imports, storage, network, or provider-error logging.
const MAX_TTL = 15 * 60 * 1000;
const MAX_HISTORY = 16;
const MAX_NOTICES = 8;
const MESSAGE = 'Continue signing in with OpenAI.';
const INPUT_MESSAGES = {
  text: 'Enter the authorization code or callback URL from your browser.',
  secret: 'Enter the requested authorization value.',
  select: 'Choose an authorization option.',
  confirm: 'Confirm to continue signing in.',
};
const AUTHORIZE_PARAMS = new Set([
  'response_type', 'client_id', 'redirect_uri', 'scope', 'code_challenge',
  'code_challenge_method', 'state', 'id_token_add_organizations',
  'codex_cli_simplified_flow', 'originator', 'prompt', 'login_hint',
]);

function safeError(code) {
  const error = new Error('Authorization interaction could not continue.');
  error.code = code;
  return error;
}

function safeUrl(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[<>\s\u0000-\u001f\u007f]/u.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'auth.openai.com' || url.port || url.username || url.password || url.hash) return undefined;
    if (url.pathname === '/oauth/authorize' || url.pathname === '/authorize') {
      for (const name of url.searchParams.keys()) if (!AUTHORIZE_PARAMS.has(name)) return undefined;
    } else if (url.pathname === '/codex/device' || url.pathname === '/device') {
      if (url.search) return undefined;
    } else return undefined;
    return url.href;
  } catch { return undefined; }
}

function providerErrorCode(error) {
  // Never propagate a provider's message, stack, cause, or arbitrary code.
  try {
    switch (error?.code) {
      case 'NO_FLOW': case 'UNKNOWN_METHOD': return 'AUTH_UNAVAILABLE';
      case 'ALREADY_IN_FLIGHT': return 'AUTH_BUSY';
      case 'NOT_COMMITTED': return 'AUTH_NOT_COMMITTED';
      default: return 'AUTH_FAILED';
    }
  } catch { return 'AUTH_FAILED'; }
}

/**
 * Public snapshots contain no answers or credentials. Callbacks receive no
 * authorization result; the host's official flow has already committed it.
 * timers is optional dependency injection for deterministic lifecycle tests.
 */
export function createAuthBroker({
  authorization,
  key = 'llm-pi-ai/openai-codex',
  now = Date.now,
  idFactory = () => globalThis.crypto.randomUUID(),
  timeoutMs = MAX_TTL,
  timers = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout },
  onStarting = () => {},
  onAuthorized = () => {},
} = {}) {
  if (!authorization || typeof authorization.begin !== 'function' || typeof key !== 'string' || !key ||
      typeof now !== 'function' || typeof idFactory !== 'function' ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TTL ||
      typeof timers?.setTimeout !== 'function' || typeof timers?.clearTimeout !== 'function' ||
      typeof onStarting !== 'function' || typeof onAuthorized !== 'function') throw safeError('INVALID_CONFIG');

  const records = new Map();
  let current;
  let running = false;
  let disposed = false;

  function snapshot(record) {
    if (!record) return { state: 'idle' };
    return {
      id: record.id,
      state: record.state,
      prompts: record.prompt ? [{
        ...record.prompt.public,
        ...(record.prompt.public.options ? { options: record.prompt.public.options.map(option => ({ ...option })) } : {}),
      }] : [],
      notices: record.notices.map(notice => ({ ...notice })),
      ...(record.errorCode ? { errorCode: record.errorCode } : {}),
    };
  }

  function clearPrompt(record, rejection) {
    const pending = record.prompt;
    record.prompt = undefined;
    if (!pending) return;
    pending.cleanup();
    if (rejection) pending.reject(rejection);
  }

  function finish(record, state, errorCode) {
    if (record.state !== 'pending') return;
    record.state = state;
    record.errorCode = errorCode;
    record.expires = now() + timeoutMs;
    timers.clearTimeout(record.timer);
    record.timer = undefined;
    clearPrompt(record, safeError('AUTH_WITHDRAWN'));
    record.notices = [];
    if (state !== 'complete') record.controller.abort(safeError('AUTH_WITHDRAWN'));
  }

  function purge() {
    const time = now();
    for (const [id, record] of records) {
      if (record.state === 'pending' && time >= record.deadline) finish(record, 'error', 'AUTH_TIMEOUT');
      if (record.state !== 'pending' && time >= record.expires) {
        records.delete(id);
        if (current === record) current = undefined;
      }
    }
  }

  function requireRecord(id) {
    purge();
    const record = typeof id === 'string' ? records.get(id) : undefined;
    if (!record) throw safeError('AUTH_NOT_FOUND');
    return record;
  }

  function uniqueId() {
    for (let attempt = 0; attempt < 8; attempt++) {
      const id = idFactory();
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(id)) throw safeError('INVALID_ID');
      if (!records.has(id)) return id;
    }
    throw safeError('INVALID_ID');
  }

  function notify(record, notice) {
    purge();
    if (record.state !== 'pending') return;
    const url = safeUrl(notice?.url);
    const devicePage = url === 'https://auth.openai.com/codex/device' || url === 'https://auth.openai.com/device';
    const code = devicePage && typeof notice?.code === 'string' && /^[A-Z0-9][A-Z0-9-]{3,31}$/u.test(notice.code) ? notice.code : undefined;
    const publicNotice = {
      message: code && url ? 'Enter this code on the OpenAI verification page.' : MESSAGE,
      ...(url ? { url } : {}),
      ...(code && url ? { code } : {}),
    };
    record.notices.push(publicNotice);
    if (record.notices.length > MAX_NOTICES) record.notices.shift();
  }

  function prompt(record, request) {
    // Attach a rejection handler immediately, even if a provider neglects to await.
    let promise;
    try {
      purge();
      if (record.state !== 'pending') throw safeError('AUTH_WITHDRAWN');
      if (record.prompt) {
        finish(record, 'error', 'AUTH_CONCURRENT_PROMPT');
        throw safeError('AUTH_CONCURRENT_PROMPT');
      }
      const kind = request?.kind;
      if (typeof kind !== 'string' || !Object.hasOwn(INPUT_MESSAGES, kind) || ++record.promptCount > 128) {
        finish(record, 'error', 'AUTH_UNSUPPORTED_PROMPT');
        throw safeError('AUTH_UNSUPPORTED_PROMPT');
      }
      const options = [];
      const values = new Map();
      if (kind === 'select') {
        if (!Array.isArray(request.options) || request.options.length < 1 || request.options.length > 32) {
          finish(record, 'error', 'AUTH_UNSUPPORTED_PROMPT');
          throw safeError('AUTH_UNSUPPORTED_PROMPT');
        }
        for (let index = 0; index < request.options.length; index++) {
          const option = request.options[index];
          // Native pi-ai supplies {id,label}; other seam clients use {value,label}.
          // Ambiguous dual representations fail closed rather than choosing one.
          const nativeValue = option?.id ?? option?.value;
          if (!option || (option.id !== undefined && option.value !== undefined && option.id !== option.value) ||
              typeof nativeValue !== 'string' || nativeValue.length > 1024 || nativeValue.length < 1 ||
              [...values.values()].includes(nativeValue)) {
            finish(record, 'error', 'AUTH_UNSUPPORTED_PROMPT');
            throw safeError('AUTH_UNSUPPORTED_PROMPT');
          }
          // Opaque public IDs and fixed known labels prevent provider text leaking.
          const value = 'option-' + (index + 1);
          const label = nativeValue === 'browser' ? 'Browser login' :
            nativeValue === 'device_code' ? 'Device code login' : 'Option ' + (index + 1);
          options.push({ id: value, label });
          values.set(value, nativeValue);
        }
      }
      const signal = request.signal;
      if (signal && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) throw safeError('AUTH_UNSUPPORTED_PROMPT');
      if (signal?.aborted) throw safeError('AUTH_WITHDRAWN');
      const publicPrompt = { id: record.id + '.' + record.promptCount, type: kind === 'text' ? 'input' : kind, message: INPUT_MESSAGES[kind], ...(kind === 'select' ? { options } : {}) };
      promise = new Promise((resolve, reject) => {
        const withdrawn = () => {
          if (record.prompt?.public.id === publicPrompt.id) clearPrompt(record, safeError('AUTH_WITHDRAWN'));
        };
        record.prompt = { public: publicPrompt, values, resolve, reject, cleanup: () => signal?.removeEventListener('abort', withdrawn) };
        signal?.addEventListener('abort', withdrawn, { once: true });
        if (signal?.aborted) withdrawn();
      });
    } catch (error) {
      const withdrawn = record.state !== 'pending' || request?.signal?.aborted === true;
      if (!withdrawn) finish(record, 'error', 'AUTH_UNSUPPORTED_PROMPT');
      promise = Promise.reject(safeError(withdrawn ? 'AUTH_WITHDRAWN' : 'AUTH_INTERACTION_FAILED'));
    }
    promise.catch(() => {});
    return promise;
  }

  function start() {
    purge();
    if (disposed) throw safeError('AUTH_DISPOSED');
    if (running || current?.state === 'pending') throw safeError('AUTH_BUSY');
    const record = {
      id: uniqueId(), state: 'pending', notices: [], promptCount: 0,
      controller: new AbortController(), deadline: now() + timeoutMs,
    };
    records.set(record.id, record);
    current = record;
    while (records.size > MAX_HISTORY) records.delete(records.keys().next().value);
    running = true;
    record.timer = timers.setTimeout(() => finish(record, 'error', 'AUTH_TIMEOUT'), timeoutMs);
    record.timer?.unref?.();
    // Every branch is handled; neither provider failures nor hook failures escape.
    Promise.resolve().then(async () => {
      try {
        if (record.state !== 'pending') return;
        await onStarting();
        purge();
        if (record.state !== 'pending') return;
        const result = await authorization.begin({
          key, method: 'oauth', signal: record.controller.signal,
          interaction: { notify: notice => notify(record, notice), prompt: request => prompt(record, request) },
        });
        purge();
        if (record.state !== 'pending') return;
        if (result?.status === 'cancelled') return finish(record, 'cancelled');
        if (result?.status !== 'authorized') return finish(record, 'error', 'AUTH_NOT_COMMITTED');
        await onAuthorized();
        purge();
        if (record.state === 'pending') finish(record, 'complete');
      } catch (error) {
        finish(record, 'error', providerErrorCode(error));
      } finally { running = false; }
    }).catch(() => {
      // Defense against a broken injected clock/timer; do not expose its error.
      running = false;
    });
    return snapshot(record);
  }

  function poll(id) { return snapshot(requireRecord(id)); }
  function answer(id, promptId, answerValue) {
    const record = requireRecord(id);
    const pending = record.prompt;
    if (record.state !== 'pending' || !pending || pending.public.id !== promptId) throw safeError('AUTH_PROMPT_MISMATCH');
    const kind = pending.public.type;
    let value = answerValue;
    if (kind === 'confirm') {
      if (typeof value !== 'boolean') throw safeError('AUTH_INVALID_ANSWER');
    } else {
      if (typeof value !== 'string' || value.length < 1 || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) throw safeError('AUTH_INVALID_ANSWER');
      if (kind === 'select') {
        if (!pending.values.has(value)) throw safeError('AUTH_INVALID_ANSWER');
        value = pending.values.get(value);
      }
    }
    clearPrompt(record);
    pending.resolve(value);
    return snapshot(record);
  }
  function cancel(id) {
    const record = requireRecord(id);
    finish(record, 'cancelled');
    return snapshot(record);
  }
  function status() { purge(); return snapshot(current); }
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const record of records.values()) finish(record, 'cancelled');
    records.clear();
    current = undefined;
  }
  return { start, poll, answer, cancel, status, dispose, isRunning: () => running };
}
