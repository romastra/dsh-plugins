// Generated from src/client.js; uses the existing DSH module loader.
window.__ModuleLoader__.load({id:'@local/codex-native',factory(require){
// Plain ESM factory; the packaging layer owns window.__ModuleLoader__.
const PROVIDER = 'openai-codex';
const NS = 'local.codex-native';
const ENDPOINTS = new Set(['status', 'speed', 'setSpeed', 'authStart', 'authPoll', 'authAnswer', 'authCancel', 'capabilitiesRefresh', 'usage']);
const EXT_ACTIONS = ['cloudCompaction','setCloudCompaction','usageV2','usageHistory','usageProfile','quotaForecast','quotaPreferences','setQuotaPreferences','clearQuotaForecast','resetInspect','resetPrepare','resetCancel','resetConsume','resetOperationStatus','resetReconcile','resetRecoveryPrepare'];
for (const action of EXT_ACTIONS) ENDPOINTS.add(action);
const EXT_READS = new Set(['cloudCompaction','usageV2','usageHistory','usageProfile','quotaForecast','quotaPreferences','resetInspect','resetOperationStatus','resetReconcile']);
const AUTH_STATES = new Set(['idle', 'pending', 'complete', 'cancelled', 'error']);
const SPEEDS = Object.freeze(['standard', 'fast', 'ultrafast']);
const LOCAL_SPEED_ERROR = new Set(['CODEX_ULTRAFAST_UNSUPPORTED', 'CODEX_ULTRAFAST_CHECK_UNAVAILABLE']);
const text = (value, max = 4000) => typeof value === 'string' ? value.slice(0, max) : '';

/** Links are data, never HTML or navigation commands. OAuth callbacks may only be loopback. */
function safeAuthUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'auth.openai.com' || url.port || url.username || url.password || url.hash) return null;
    if (!['/oauth/authorize', '/codex/device', '/activate', '/device'].includes(url.pathname)) return null;
    for (const key of url.searchParams.keys()) {
      if (/^(next|url|redirect|redirect_url|return|returnTo|continue)$/i.test(key)) return null;
    }
    for (const callback of url.searchParams.getAll('redirect_uri')) {
      const target = new URL(callback);
      if (!['http:', 'https:'].includes(target.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || target.username || target.password) return null;
    }
    return url.href;
  } catch { return null; }
}

/** Only project the public contract: never render arbitrary status fields, tokens or errors. */
function publicAuth(value) {
  return {
    id: text(value?.id, 256) || null,
    state: AUTH_STATES.has(value?.state) ? value.state : 'idle',
    prompts: Array.isArray(value?.prompts) ? value.prompts.slice(0, 1).map(prompt => ({
      id: text(prompt?.id, 256), type: text(prompt?.type, 32), message: text(prompt?.message),
      options: Array.isArray(prompt?.options) ? prompt.options.slice(0, 100).filter(option => typeof option?.id === 'string').map(option => ({ id: text(option.id, 256), label: text(option.label, 500) })) : [],
    })).filter(prompt => prompt.id) : [],
    notices: Array.isArray(value?.notices) ? value.notices.slice(0, 20).map(notice => ({
      message: text(notice?.message), code: text(notice?.code, 128), url: safeAuthUrl(notice?.url),
    })) : [],
  };
}

function speedView(value) {
  if (!value || !SPEEDS.includes(value.tier)) throw new Error('INVALID_RESPONSE');
  const booleanOrUnknown = available => typeof available === 'boolean' ? available : null;
  return { tier: value.tier, fastAvailable: booleanOrUnknown(value.fastAvailable), ultrafastAvailable: booleanOrUnknown(value.ultrafastAvailable) };
}

function speedChoices(value) {
  return SPEEDS.filter(tier => tier !== 'ultrafast' || value?.ultrafastAvailable === true || value?.tier === 'ultrafast');
}

function canChooseSpeed(tier, value) {
  return SPEEDS.includes(tier) && (tier === 'ultrafast' ? value?.ultrafastAvailable === true : tier === 'fast' ? value?.fastAvailable !== false : true);
}

/** Nonce stays in this closure only; no browser storage, URLs, console output or tokens. */
function createCodexApi(rpc, { timeoutMs = 30000, later = setTimeout, cancel = clearTimeout } = {}) {
  let nonce = null;
  let statusFlight = null;
  let revision = null;
  let generation = 0;
  const revisionListeners = new Set();
  const latestRequests = new Map(), pendingReads = new Set();
  const validRevision = v => typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(v);
  const validRequestId = id => typeof id === 'string' && id.length > 0 && id.length <= 160;
  const stale = () => Object.assign(new Error('RPC_FAILED'), { code: 'QUOTA_STALE_REPLY' });
  function adoptRevision(value) {
    if (value === revision) return;
    revision = value; ++generation;
    for (const controller of pendingReads) controller.abort();
    for (const fn of revisionListeners) fn();
  }
  async function call(endpoint, args = {}, signal) {
    if (!ENDPOINTS.has(endpoint)) throw new Error('INVALID_ENDPOINT');
    if (signal?.aborted) throw stale();
    const controller = new AbortController();
    let timer, onAbort;
    const deadline = new Promise((_, reject) => {
      onAbort = () => { reject(stale()); controller.abort(); };
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = later(() => { reject(new Error('RPC_FAILED')); controller.abort(); }, timeoutMs);
    });
    try {
      // Bound unary calls too: a suspended phone or a lost HTTP response must
      // not leave the shared status/polling store busy forever. A timeout is
      // ambiguous and never qualifies for an automatic mutation replay.
      const reply = await Promise.race([rpc.call('/api', 'codex-native.' + endpoint, args, controller.signal), deadline]);
      if (reply?.ok !== true || !reply.value || typeof reply.value !== 'object') {
        const error = new Error('RPC_FAILED');
        const code = reply?.error?.code;
        if (code === 'NONCE_REQUIRED' || LOCAL_SPEED_ERROR.has(code) || typeof code === 'string' && /^(CLOUD|QUOTA|RESET)_[A-Z0-9_]{2,60}$/u.test(code)) error.code = code;
        if (EXT_ACTIONS.includes(endpoint) && reply?.error?.details && typeof reply.error.details === 'object') {
          const d = reply.error.details;
          error.details = {
            viewRevision: validRevision(d.viewRevision) ? d.viewRevision : undefined,
            requestId: validRequestId(d.requestId) ? d.requestId : undefined,
            messageKey: error.code && d.messageKey === error.code ? error.code : undefined,
            retryable: d.retryable === true,
            outcome: ['not-dispatched', 'known', 'uncertain'].includes(d.outcome) ? d.outcome : undefined,
            operationId: validRevision(d.operationId) ? d.operationId : undefined,
            retryAt: dateMilliseconds(d.retryAt) ? d.retryAt : undefined,
          };
        }
        throw error;
      }
      return reply.value;
    } finally { cancel(timer); signal?.removeEventListener('abort', onAbort); }
  }
  async function status() {
    if (statusFlight) return statusFlight;
    statusFlight = (async () => {
      const value = await call('status');
      nonce = typeof value.nonce === 'string' && value.nonce.length > 0 ? value.nonce : null;
      adoptRevision(validRevision(value.viewRevision) ? value.viewRevision : null);
      return { authenticated: value.authenticated === true, auth: publicAuth(value.auth), ready: nonce !== null, ...(revision ? {viewRevision:revision} : {}) };
    })();
    try { return await statusFlight; } finally { statusFlight = null; }
  }
  async function mutation(endpoint, args) {
    if (!nonce) throw new Error('STATUS_REQUIRED');
    const attemptedNonce = nonce;
    try { return await call(endpoint, { ...args, nonce: attemptedNonce }); }
    catch (error) {
      if (error.code !== 'NONCE_REQUIRED') throw error;
      // The server rejected before mutation. Never replay an accepted/general-failure operation.
      if (nonce === attemptedNonce) await status();
      if (!nonce) throw new Error('STATUS_REQUIRED');
      return call(endpoint, { ...args, nonce });
    }
  }
  async function extended(endpoint, args = {}, { signal } = {}) {
    if (!EXT_ACTIONS.includes(endpoint)) throw new Error('INVALID_ENDPOINT');
    const read = EXT_READS.has(endpoint);
    const key = JSON.stringify([endpoint, args.sessionId, args.model, args.operationId, args.challengeId, args.creditRef, args.limitId, args.windowSeconds]);
    const ticket = Symbol(); latestRequests.set(key, ticket);
    const current = () => latestRequests.get(key) === ticket && !signal?.aborted;
    const startingGeneration = revision === null ? null : generation;
    try {
      if (!current()) throw stale();
      if (!nonce || !revision || statusFlight) await status();
      if (!current() || !read && startingGeneration !== null && generation !== startingGeneration) throw stale();
      if (!nonce || !revision) throw Object.assign(new Error('RPC_FAILED'), { code: 'QUOTA_AUTH_REQUIRED' });
      for (let attempt = 0; ; ++attempt) {
        const sentGeneration = generation, sentRevision = revision, sentNonce = nonce;
        const controller = read ? new AbortController() : null;
        const forwardAbort = () => controller.abort();
        if (controller) {
          pendingReads.add(controller);
          signal?.addEventListener('abort', forwardAbort, { once: true });
        }
        let value, failure;
        try {
          value = await call(endpoint, { ...args, viewRevision: sentRevision, nonce: sentNonce }, controller?.signal);
        } catch (error) { failure = error; }
        finally {
          if (controller) {
            pendingReads.delete(controller);
            signal?.removeEventListener('abort', forwardAbort);
          }
        }
        // The same fence covers successes, typed failures and the retry. Do not let
        // a response from an obsolete ticket bootstrap status or publish anything.
        if (!current() || generation !== sentGeneration) throw stale();
        const from = failure ? failure?.details?.viewRevision : value?.viewRevision;
        const requestId = failure ? failure?.details?.requestId : value?.requestId;
        const nonceRequired = failure?.code === 'NONCE_REQUIRED';
        if (!failure || from) {
          if (!validRevision(from) || !validRequestId(requestId)) throw stale();
          if (from === sentRevision && !nonceRequired) {
            if (failure) throw failure;
            return value;
          }
        } else if (!nonceRequired) {
          // A transport failure has no envelope. A typed, revisioned failure
          // without its metadata cannot be presented as the current outcome.
          if (failure?.details || /^(CLOUD|QUOTA|RESET)_/u.test(failure?.code ?? '')) throw stale();
          throw failure;
        }
        if (attempt !== 0) throw stale();
        // Only status is authoritative. An unfamiliar reply triggers a shared
        // bootstrap, not a change of account or an automatic mutation replay.
        await status();
        if (!current() || !revision || !nonce) throw stale();
        if (!read) {
          if (nonceRequired && generation === sentGeneration) throw failure;
          throw stale();
        }
        if (generation === sentGeneration && (!nonceRequired || nonce === sentNonce)) throw stale();
      }
    } finally { if (latestRequests.get(key) === ticket) latestRequests.delete(key); }
  }
  return {
    status, extended, revision:()=>revision, subscribeRevision(fn){revisionListeners.add(fn);return ()=>revisionListeners.delete(fn);},
    async speed(sessionId, selection) {
      if (selection?.provider !== PROVIDER || typeof selection.model !== 'string') return null;
      if (!nonce) await status();
      return speedView(await call('speed', { sessionId, model: selection.model }));
    },
    async setSpeed(sessionId, selection, tier, fastAvailable, ultrafastAvailable) {
      if (selection?.provider !== PROVIDER || typeof selection.model !== 'string' || !canChooseSpeed(tier, { fastAvailable, ultrafastAvailable })) throw new Error('SPEED_UNAVAILABLE');
      return speedView(await mutation('setSpeed', { sessionId, model: selection.model, tier }));
    },
    async usage(sessionId, selection) {
      if (selection?.provider !== PROVIDER || typeof selection.model !== 'string') return null;
      if (!nonce) await status();
      return usageView(await mutation('usage', { sessionId, model: selection.model }));
    },
    async capabilitiesRefresh() {
      const value = await mutation('capabilitiesRefresh', {});
      if (value.checked !== true || !Number.isSafeInteger(value.models) || value.models < 0) throw new Error('INVALID_RESPONSE');
      return { checked: true, models: value.models };
    },
    authStart: () => mutation('authStart', {}).then(publicAuth),
    authPoll: id => mutation('authPoll', { id }).then(publicAuth),
    authAnswer: (id, promptId, answer) => mutation('authAnswer', { id, promptId, answer }).then(publicAuth),
    authCancel: id => mutation('authCancel', { id }).then(publicAuth),
  };
}

/** Poll only an already-active flow, single flight, and discard replies superseded by a user action. */
function createAuthStore(api, { later = setTimeout, cancel = clearTimeout, interval = 1500, onAuthChange = () => {} } = {}) {
  let state = { ready: false, authenticated: false, auth: publicAuth(null), busy: false, error: false, capabilities: null };
  const listeners = new Set();
  let timer;
  let epoch = 0;
  let disposed = false;
  let locked = false;
  let polling = false;
  let statusRetry = false;
  let retryDelay = 1000;
  function publish(patch) {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }
  function stopTimer() { if (timer !== undefined) cancel(timer); timer = undefined; }
  function accept(auth) {
    if (disposed) return;
    const previous = state.auth.state;
    publish({ auth, authenticated: auth.state === 'complete' || state.authenticated });
    if (previous !== auth.state && (previous === 'pending' || auth.state === 'pending' || auth.state === 'complete')) onAuthChange();
  }
  function schedule() {
    stopTimer();
    if (disposed || locked || polling) return;
    if (statusRetry) { timer = later(loadStatus, retryDelay); retryDelay = Math.min(30000, retryDelay * 2); }
    else if (state.ready && state.auth.state === 'pending' && state.auth.id) timer = later(poll, interval);
  }
  async function poll() {
    timer = undefined;
    if (disposed || locked || polling || state.auth.state !== 'pending' || !state.auth.id) return;
    polling = true;
    const generation = epoch;
    try {
      const auth = await api.authPoll(state.auth.id);
      if (!disposed && generation === epoch) { accept(auth); publish({ error: false }); }
    } catch { if (!disposed && generation === epoch) { statusRetry = true; publish({ error: true, ready: false }); } }
    finally { polling = false; schedule(); }
  }
  async function run(action) {
    if (disposed || locked) return false;
    locked = true; ++epoch; stopTimer();
    publish({ busy: true, error: false });
    try { await action(); return !disposed; }
    catch {
      // The action may have reached the Host before the response was lost.
      // Recover by reading status; never auto-submit the action a second time.
      if (!disposed) { statusRetry = true; publish({ error: true, ready: false }); }
      return false;
    }
    finally { locked = false; publish({ busy: false }); schedule(); }
  }
  function loadStatus() {
    return run(async () => {
      try { const value = await api.status(); publish(value); statusRetry = !value.ready; retryDelay = 1000; }
      catch (error) { statusRetry = true; throw error; }
    });
  }
  return {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot: () => state,
    resume() { disposed = false; },
    load: loadStatus,
    checkCapabilities: () => run(async () => {
      if (!state.ready || !state.authenticated || state.auth.state === 'pending') throw new Error('NOT_READY');
      publish({ capabilities: null });
      const capabilities = await api.capabilitiesRefresh();
      const value = await api.status();
      publish({ ...value, capabilities });
    }),
    start: () => run(async () => { if (!state.ready || state.auth.state === 'pending') throw new Error('NOT_READY'); accept(await api.authStart()); }),
    answer: (promptId, answer) => run(async () => {
      const prompt = state.auth.prompts.find(item => item.id === promptId);
      if (!state.ready || state.auth.state !== 'pending' || !state.auth.id || !prompt) throw new Error('NOT_READY');
      if (prompt.type === 'confirm' ? typeof answer !== 'boolean' : typeof answer !== 'string' || !answer.length || answer.length > 8192) throw new Error('INVALID_ANSWER');
      if (prompt.type === 'select' && !prompt.options.some(option => option.id === answer)) throw new Error('INVALID_ANSWER');
      if (!['input', 'secret', 'select', 'confirm'].includes(prompt.type)) throw new Error('INVALID_ANSWER');
      accept(await api.authAnswer(state.auth.id, prompt.id, answer));
    }),
    cancel: () => run(async () => { if (!state.ready || state.auth.state !== 'pending' || !state.auth.id) throw new Error('NOT_READY'); accept(await api.authCancel(state.auth.id)); }),
    dispose() { disposed = true; ++epoch; stopTimer(); listeners.clear(); },
  };
}

const DICTS = {
  en: {
    localeCode: 'en', lastCompleted: 'Last completed response', noCompleted: 'No completed native response yet', actualTier: 'Server tier', throughput: 'Decode speed', tokensPerSecond: 'tok/s', throughputHint: 'Output tokens / decode time of this completed response; no session totals or time to first token.', tierPriority: 'Fast reported', tierUltrafast: 'Ultrafast reported', tierUnconfirmed: 'Requested speed not confirmed', tierUnknown: 'Unknown', requestedSpeed: 'Requested speed',
    title: 'Codex OAuth', description: 'Separate native openai-codex connection. Existing codex accounts and models are not changed.',
    connected: 'Connected', disconnected: 'Not connected', start: 'Sign in with OpenAI', cancel: 'Cancel sign-in',
    idle: 'Sign-in is not running', pending: 'Waiting for sign-in', complete: 'Sign-in completed', cancelled: 'Sign-in cancelled', error: 'Sign-in failed',
    failure: 'Connection temporarily unavailable. Reconnecting automatically; your settings are unchanged.', unavailable: 'The secure sign-in service is unavailable.',
    loading: 'Loading status…', working: 'Working…', open: 'Open official OpenAI sign-in', code: 'Device code', submit: 'Submit once', yes: 'Yes', no: 'No',
    inputHint: 'Sensitive one-time input. It is sent only to the current sign-in prompt and is not saved in browser storage. Do not paste tokens.',
    unsupportedPrompt: 'This sign-in prompt is not supported. Cancel and retry in a supported client.', choose: 'Choose an option',
    standardDetail: 'Default speed', fastDetail: 'Priority processing', quota: 'Codex usage', used: 'used', resets: 'resets in', sessionWindow: 'Session', weeklyWindow: 'Weekly', otherWindow: 'Other window', usageUnknown: 'Usage unavailable', usageStale: 'Updating automatically; last known usage may be stale', checkedAt: 'Checked', close: 'Close',
    speed: 'Speed', standard: 'Standard', fast: 'Fast', ultrafast: 'Ultrafast', speedHint: 'For this model in this session. Faster modes use more of your allowance; requested speed is not guaranteed by the server.',
    ultrafastDetail: 'Highest speed · uses more of your allowance', ultrafastUnavailable: 'The Codex account catalog did not list Ultrafast for this model.', ultrafastUnchecked: 'Ultrafast availability could not be verified. Retry or choose Standard or Fast.',
    unknown: 'Fast availability is unknown; Fast is disabled.', unsupported: 'Fast is unavailable for this model/account.', speedFailure: 'Could not update Codex Speed. The last choice is unchanged; retry this option or wait for automatic reconnection.',
  },
  ru: {
    localeCode: 'ru', lastCompleted: 'Последний завершённый ответ', noCompleted: 'Пока нет завершённого native-ответа', actualTier: 'Серверный tier', throughput: 'Скорость генерации', tokensPerSecond: 'ток/с', throughputHint: 'Выходные токены / время декодирования этого завершённого ответа, без итогов сеанса и ожидания первого токена.', tierPriority: 'Сервер указал Fast', tierUltrafast: 'Сервер указал Ultrafast', tierUnconfirmed: 'Запрошенная скорость не подтверждена', tierUnknown: 'Неизвестно', requestedSpeed: 'Запрошенная скорость',
    title: 'Codex OAuth', description: 'Отдельное native-подключение openai-codex. Существующие аккаунты и модели codex не изменяются.',
    connected: 'Подключено', disconnected: 'Не подключено', start: 'Войти через OpenAI', cancel: 'Отменить вход',
    idle: 'Вход не запущен', pending: 'Ожидание входа', complete: 'Вход завершён', cancelled: 'Вход отменён', error: 'Ошибка входа',
    failure: 'Связь временно недоступна. Подключение восстанавливается автоматически; настройки сохранены.', unavailable: 'Защищённый сервис входа недоступен.',
    loading: 'Загрузка статуса…', working: 'Выполнение…', open: 'Открыть официальный вход OpenAI', code: 'Код устройства', submit: 'Отправить один раз', yes: 'Да', no: 'Нет',
    inputHint: 'Секретный одноразовый ввод. Отправляется только текущему запросу входа, без сохранения в хранилище браузера. Не вставляйте токены.',
    unsupportedPrompt: 'Этот запрос входа не поддерживается. Отмените вход и повторите в поддерживаемом клиенте.', choose: 'Выберите вариант',
    standardDetail: 'Обычная скорость', fastDetail: 'Приоритетная обработка', quota: 'Использование Codex', used: 'использовано', resets: 'сброс через', sessionWindow: 'Сеанс', weeklyWindow: 'Неделя', otherWindow: 'Другое окно', usageUnknown: 'Данные использования недоступны', usageStale: 'Обновляется автоматически; последние данные могут быть устаревшими', checkedAt: 'Проверено', close: 'Закрыть',
    speed: 'Скорость', standard: 'Standard', fast: 'Fast', ultrafast: 'Ultrafast', speedHint: 'Для этой модели в текущем сеансе. Ускоренные режимы расходуют больше лимита; сервер не гарантирует запрошенную скорость.',
    ultrafastDetail: 'Максимальная скорость · повышенный расход лимита', ultrafastUnavailable: 'Каталог Codex для этого аккаунта не указал Ultrafast у модели.', ultrafastUnchecked: 'Не удалось проверить Ultrafast. Повторите или выберите Standard либо Fast.',
    unknown: 'Поддержка Fast неизвестна; Fast отключён.', unsupported: 'Fast недоступен для этой модели/аккаунта.', speedFailure: 'Не удалось обновить скорость Codex. Последний выбор сохранён; повторите выбор или дождитесь автоматического подключения.',
  },
};
// OAuth settings only: composer controls must never inherit form rules.
const CSS = `.cn-panel{display:grid;gap:12px;max-width:700px;color:var(--dsw-alias-label-primary);font:inherit}
.cn-actions{display:flex;flex-wrap:wrap;gap:8px}
.cn-panel button,.cn-panel select,.cn-panel input{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 10px}
.cn-panel button:disabled{opacity:.55}
.cn-panel :focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.cn-panel p{margin:0}
.cn-notice{overflow-wrap:anywhere;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px;display:grid;gap:6px}
.cn-prompt{display:grid;gap:8px}
.cn-hint{font-size:12px;color:var(--dsw-alias-label-secondary)}
.cn-error{color:var(--dsw-alias-state-error-primary)}
.cn-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
`;

/** Only fixed, dynamic inline values stay inline; chrome and CSS Anchor
 * Positioning live in SPEED_CSS/QUOTA_CSS and mirror the shipped Harness
 * menu/stat-dialog material (0.2.2-rc.3). */
const SPEED_STYLES = { root: { display: 'inline-flex' } };
const COMPOSER_TRIGGER_CSS = `
:is(.cn-speed,.cn-cloud){position:relative;display:inline-flex;min-width:0}
:is(.cn-speed,.cn-cloud)>:is(.cn-speed-trigger,.cn-cloud-trigger){border:0.5px solid var(--dsw-alias-border-l3,var(--dsw-alias-border-l1));border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;padding:2px 8px;cursor:pointer;white-space:nowrap}
:is(.cn-speed,.cn-cloud)>:is(.cn-speed-trigger,.cn-cloud-trigger):hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
:is(.cn-speed,.cn-cloud)>:is(.cn-speed-trigger,.cn-cloud-trigger):active:not(:disabled),.cn-cloud>.cn-cloud-trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-bg-layer-2))}
:is(.cn-speed,.cn-cloud)>:is(.cn-speed-trigger,.cn-cloud-trigger):disabled{opacity:0.4;cursor:default}
:is(.cn-speed,.cn-cloud)>:is(.cn-speed-trigger,.cn-cloud-trigger):focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary,Highlight));outline-offset:2px}
/* DSH 0.2.2-rc.5's composer sets these inherited variables from actual control-row demand. */
.cn-trigger-text{display:var(--dsh-composer-model-text-display,block)}
.cn-trigger-glyph{display:var(--dsh-composer-model-icon-display,none);inline-size:16px;block-size:18px;margin-inline:-3px}
`;
const SPEED_GLYPHS = Object.freeze({
  // Side-profile passenger car: the two wheel arches leave room for the wheels.
  standard: 'M1.4 9.5 3.7 9l1.6-3a1.6 1.6 0 0 1 1.4-.8h4.1a1.6 1.6 0 0 1 1.4.8l1.5 2.7 2.5.6c.8.2 1.3.9 1.3 1.7v2h-2a2 2 0 0 0-4 0h-5a2 2 0 0 0-4 0H1v-2.4c0-.5.1-.9.4-1.1ZM4.5 11.8a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Zm9 0a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Z',
  // Passenger plane seen from above.
  fast: 'M8 2.4a1 1 0 0 1 2 0V6l6 4v1.6l-6-1.8v3.3l2 1.5v1.5l-3-1-3 1v-1.5l2-1.5V9.8L2 11.6V10l6-4V2.4Z',
  // Rocket with a porthole and exhaust.
  ultrafast: 'M16.4 1.7c-3.7-.5-6.6.7-8.7 3.5L4.9 5.6 2.5 8l3.1.6-.4.8 3.4 3.4.8-.4.6 3.1 2.4-2.4.4-2.8c2.8-2.1 4-5 3.6-8.6ZM11.9 4.4a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3ZM4.5 11.3c-1.6.3-2.7 2-3 5.2 3.2-.3 4.9-1.4 5.2-3l-2.2-2.2Z',
  unknown: 'M4 8.25h10v1.5H4z',
});
function speedGlyph(tier) { return typeof tier === 'string' && Object.hasOwn(SPEED_GLYPHS, tier) ? tier : 'unknown'; }

function ComposerTriggerGlyph({ h, kind, checked }) {
  const props = { className: 'cn-trigger-glyph', 'data-glyph': kind, viewBox: '0 0 18 18', 'aria-hidden': true, focusable: 'false' };
  if (kind === 'cloud') {
    return h('svg', { ...props, fill: 'none', stroke: 'currentColor', strokeWidth: 1.45, strokeLinecap: 'round', strokeLinejoin: 'round' },
      h('path', { d: 'M5 14h8.5a3.5 3.5 0 0 0 .2-7A4.8 4.8 0 0 0 4.5 8a3 3 0 0 0 .5 6Z' }),
      checked ? h('path', { d: 'm7 10 1.6 1.7L11.5 9' }) : null);
  }
  return h('svg', { ...props, fill: 'currentColor' }, h('path', { d: SPEED_GLYPHS[kind], fillRule: 'evenodd' }));
}

const SPEED_CSS = `${COMPOSER_TRIGGER_CSS}
/* Body portal + CSS anchor placement; mirrors the shipped composer model menu. */
.cn-speed-menu{box-sizing:border-box;position:fixed;z-index:1100;margin:0;padding:4px;border:0;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter, none);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);display:flex;flex-direction:column;gap:2px;height:fit-content;width:fit-content;min-width:min(220px,calc(100vw - 24px));max-width:min(420px,calc(100vw - 24px));max-height:min(360px,calc(100dvh - 96px));overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);position-area:none;top:max(12px,var(--dsh-frame-overlay-top,12px));left:12px;right:anchor(right);bottom:calc(anchor(top) + 4px);align-self:safe end;justify-self:safe end;position-try-fallbacks:--cn-speed-opposite,--cn-speed-viewport;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.cn-speed-item{display:flex;align-items:flex-start;gap:6px;width:100%;min-height:34px;padding:5px 7px;border:none;border-radius:var(--dsw-radius-md, 8px);background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.cn-speed-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.cn-speed-item:focus-visible{outline:none;background:var(--dsw-alias-interactive-bg-hover)}
.cn-speed-item:disabled{color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-tertiary));cursor:default}
.cn-speed-item[aria-checked=true] .cn-speed-item-name{color:var(--dsw-alias-label-primary)}
.cn-speed-item-check{display:grid;place-items:center;flex:0 0 14px;color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px}
.cn-speed-item-text{display:flex;flex-direction:column;min-width:0;flex:1}
.cn-speed-item-name{font-size:13px;line-height:18px;color:inherit}
.cn-speed-item-description{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.cn-speed-note{margin:4px 7px;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.cn-speed-error{margin:4px 7px;font-size:12px;line-height:16px;color:var(--dsw-alias-state-error-primary)}
@position-try --cn-speed-opposite{position-area:none;top:max(12px,calc(anchor(bottom) + 4px));bottom:12px;left:12px;right:12px;margin:0;align-self:safe start;justify-self:safe end}
@position-try --cn-speed-viewport{position-area:none;inset:max(12px,var(--dsh-frame-overlay-top,12px)) 12px 12px;margin:0;align-self:safe start;justify-self:safe end}
`;

/** Composer quota pill with the shipped stat-dialog material and CSS Anchor
 * Positioning (the Host removed useAnchoredPosition in 0.2.2-alpha.2). */
const QUOTA_CSS = `
.cn-usage{display:inline-flex;min-width:0;max-width:100%;flex:0 1 auto;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}
.cn-usage .cn-usage-pill{box-sizing:border-box;max-width:100%;display:inline-flex;align-items:center;gap:6px;padding:1px 8px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;corner-shape:round;cursor:pointer}
.cn-usage .cn-usage-pill:hover,.cn-usage .cn-usage-pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.cn-usage-label{min-width:0;overflow:hidden;text-overflow:ellipsis}
.cn-usage-glyph{display:inline-flex;align-items:center;justify-content:center;flex:none;width:14px;height:14px}
.cn-usage-glyph svg{width:14px;height:14px;flex:none}
.cn-usage-panel{position:fixed;z-index:1100;box-sizing:border-box;width:max-content;min-width:min(300px,calc(100vw - 24px));max-width:min(440px,calc(100vw - 24px));padding:16px;border:0;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter, none);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);font-family:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:default;max-height:calc(100dvh - 12px - max(12px,var(--dsh-frame-overlay-top,12px)));overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);position-area:none;top:max(12px,var(--dsh-frame-overlay-top,12px));bottom:max(12px,calc(anchor(top) + 8px));left:max(12px,anchor(left));right:12px;position-try-fallbacks:--cn-usage-window,--cn-usage-opposite,--cn-usage-wide-opposite,--cn-usage-tall,--cn-usage-viewport;align-self:end;justify-self:start;height:fit-content;min-height:0;margin:0}
.cn-usage-title{display:flex;justify-content:space-between;gap:16px;margin-bottom:8px;color:var(--dsw-alias-label-primary);font-weight:500}
.cn-usage-title-label{display:inline-flex;align-items:center;gap:6px;min-width:0}
.cn-usage-title-label svg{width:14px;height:14px;flex:none}
.cn-usage-title-value{font-variant-numeric:tabular-nums}
.cn-usage-title-rule{margin-bottom:10px;border-top:0.5px solid var(--dsw-alias-border-l2)}
.cn-usage-details{display:grid;grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0;color:var(--dsw-alias-label-tertiary)}
.cn-usage-details dt,.cn-usage-details dd{min-width:0;margin:0}
.cn-usage-details dd{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right}
.cn-usage-reset,.cn-usage-meta{color:var(--dsw-alias-label-tertiary)}
.cn-usage-bar{grid-column:1 / -1;height:3px;border-radius:1.5px;overflow:hidden;background:var(--dsw-alias-border-l2);margin:0 0 2px}
.cn-usage-bar-fill{height:100%;border-radius:1.5px}
.cn-usage-last{margin-top:12px}
.cn-usage-last .cn-usage-details{grid-template-columns:minmax(76px,auto) minmax(0,1fr)}
.cn-usage-last dd{overflow-wrap:anywhere}
.cn-usage-panel p{margin:4px 0 0;overflow-wrap:anywhere}
.cn-usage .cn-usage-pill:focus-visible,.cn-usage-panel :focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
@position-try --cn-usage-window{position-area:none;top:max(12px,var(--dsh-frame-overlay-top,12px));bottom:max(12px,calc(anchor(top) + 8px));left:12px;right:12px;margin:0;align-self:safe end;justify-self:safe end}
@position-try --cn-usage-opposite{position-area:none;top:max(12px,calc(anchor(bottom) + 8px));bottom:12px;left:max(12px,anchor(left));right:12px;margin:0;align-self:start;justify-self:start}
@position-try --cn-usage-wide-opposite{position-area:none;top:max(12px,calc(anchor(bottom) + 8px));bottom:12px;left:12px;right:12px;margin:0;align-self:start;justify-self:safe end}
@position-try --cn-usage-tall{position-area:none;top:max(12px,var(--dsh-frame-overlay-top,12px));bottom:12px;left:max(12px,anchor(left));right:12px;margin:0;align-self:safe start;justify-self:start}
@position-try --cn-usage-viewport{position-area:none;inset:max(12px,var(--dsh-frame-overlay-top,12px)) 12px 12px;margin:0;align-self:safe start;justify-self:safe end}
`;

const EMPTY_STORE = { current: null, pending: null };
const noopSubscribe = () => () => {};
const emptySnapshot = () => EMPTY_STORE;

const LAST_RESPONSE_KEY = 'codex-native/last-response';
const REPORTED_TIERS = new Set(['priority', 'ultrafast', 'default', 'auto', 'flex', 'scale']);

/** A small reference-counted external store: one request/timer per session+model. */
function createPollingStore(load, { later = setTimeout, cancel = clearTimeout, now = Date.now, interval = 30000, focusMs = 500 } = {}) {
  let state = { value: null, busy: false, error: false };
  const listeners = new Set();
  let users = 0, epoch = 0, timer, flight, controller, lastRead = -Infinity, forcedFlight = false;
  const emit = patch => { state = { ...state, ...patch }; for (const fn of listeners) fn(); };
  const clear = () => { if (timer !== undefined) cancel(timer); timer = undefined; };
  const schedule = () => {
    clear();
    const delay = typeof interval === 'function' ? interval(state.value, now()) : Math.min(30000, interval);
    if (users) timer = later(() => { timer = undefined; void refresh(); }, Math.min(delay, 2_147_483_647));
  };
  function run(action, force = false) {
    if (flight) return flight;
    clear(); const version = ++epoch; controller = new AbortController(); const signal = controller.signal;
    forcedFlight = force;
    emit({ busy: true, error: false });
    const request = Promise.resolve().then(() => { if (signal.aborted || version !== epoch) throw new Error("CANCELLED"); return action(signal); }).then(value => {
      if (version === epoch) { emit({ value, error: false }); lastRead = now(); }
      return version === epoch;
    }, error => { if (version === epoch) emit({ error: LOCAL_SPEED_ERROR.has(error?.code) ? error.code : true }); return false; }).finally(() => {
      if (version !== epoch) return;
      flight = null; controller = null; emit({ busy: false }); schedule();
    });
    flight = request;
    return request;
  }
  function refresh({ focus = false, force = false } = {}) {
    if (flight && (!force || forcedFlight)) return flight;
    if (focus && now() - lastRead < focusMs) return Promise.resolve(true);
    if (flight) { ++epoch; controller?.abort(); flight = null; }
    return run(signal => load(signal, { force }), force);
  }
  return {
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, getSnapshot: () => state,
    refresh, update: action => flight ? Promise.resolve(false) : run(action),
    replace(value) { clear(); ++epoch; controller?.abort(); controller=null; flight=null; lastRead=now(); emit({value,busy:false,error:false});schedule(); },
    reset() { clear(); ++epoch; controller?.abort(); controller=null;flight=null;lastRead=-Infinity;emit({value:null,busy:false,error:false});if(users)queueMicrotask(()=>{if(users)void refresh();}); },
    acquire() { users++; if (users === 1) void refresh(); let released = false; return () => {
      if (released) return; released = true; users = Math.max(0, users - 1); if (!users) { clear(); ++epoch; controller?.abort(); controller = null; flight = null; emit({ busy: false }); }
    }; },
    dispose() { users = 0; clear(); ++epoch; controller?.abort(); controller = null; flight = null; listeners.clear(); },
  };
}

function usageView(value) {
  const windows = Array.isArray(value?.windows) ? value.windows.filter(window =>
    ['session', 'weekly', 'other', 'unknown'].includes(window?.kind) && Number.isFinite(window.usedPercent) && window.usedPercent >= 0 && window.usedPercent <= 100
    && Number.isFinite(window.remainingPercent) && window.remainingPercent >= 0 && window.remainingPercent <= 100).map(window => ({
      kind: window.kind, usedPercent: window.usedPercent, remainingPercent: window.remainingPercent,
      resetAt: Number.isFinite(window.resetAt) && window.resetAt >= 0 ? window.resetAt : null,
      windowSeconds: Number.isFinite(window.windowSeconds) && window.windowSeconds > 0 ? window.windowSeconds : null,
    })) : [];
  return { state: value?.state === 'available' && windows.length ? 'available' : 'unknown', windows,
    checkedAt: Number.isFinite(value?.checkedAt) && value.checkedAt >= 0 && value.checkedAt <= 8_640_000_000_000_000 ? value.checkedAt : null, stale: value?.stale === true };
}

const dateMilliseconds = value => Number.isFinite(value) && value >= 0 && value <= 8_640_000_000_000_000;
const uiLocale = value => typeof value === 'string' && /^ru(?:-|$)/i.test(value) ? 'ru' : 'en';

function resetLabel(resetAt, now, locale = 'en') {
  if (!dateMilliseconds(resetAt) || resetAt <= now) return '—';
  const minutes = Math.max(1, Math.floor((resetAt - now) / 60000));
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60);
  const [d, h, m] = uiLocale(locale) === 'ru' ? ['д', 'ч', 'мин'] : ['d', 'h', 'm'];
  return days ? days + d + ' ' + hours + h : hours ? hours + h + ' ' + minutes % 60 + m : minutes + m;
}

/** Same two-window compact readout as subscriptions, always USED rather than remaining. */
function formatUsageBadge(value, { now = Date.now(), locale = 'en' } = {}) {
  const usage = usageView(value);
  const windows = usage.state === 'available' ? usage.windows.map(window => ({ ...window, reset: resetLabel(window.resetAt, now, locale) })) : [];
  const parts = windows.slice(0, 2).map(window => window.reset + ' ' + Math.round(window.usedPercent) + '%');
  if (windows.length > 2) parts.push('+' + (windows.length - 2));
  return { label: 'Codex ' + (parts.join(' · ') || '—'), windows, stale: usage.stale, checkedAt: usage.checkedAt };
}

/** Missing named windows are unknown, never a fabricated zero-percent quota. */
function quotaSnapshotStatus({ value, busy, error }) {
  const code = typeof value?.errorCode === 'string' && /^(QUOTA|RESET)_[A-Z0-9_]{2,60}$/u.test(value.errorCode) ? value.errorCode : null;
  if (error || code && code !== 'QUOTA_NOT_PROVIDED') return { kind: 'error', code };
  if (!value && busy) return { kind: 'loading' };
  if (code === 'QUOTA_NOT_PROVIDED' || value?.state === 'unavailable') return { kind: 'unavailable' };
  if (value?.stale) return { kind: 'stale' };
  return { kind: 'ready' };
}

function quotaPercent(value, locale, unknown = '—') {
  return Number.isFinite(value) && value >= 0 && value <= 100
    ? new Intl.NumberFormat(uiLocale(locale), { style: 'percent', maximumFractionDigits: 2 }).format(value / 100)
    : unknown;
}

function quotaPollDelay(value, now) {
  // Mirrors the Host usage-cache cadence; only main windows determine it.
  const used = (Array.isArray(value?.windows) ? value.windows : []).reduce((max, w) => Number.isFinite(w?.usedPercent) && w.usedPercent <= 100 ? Math.max(max,w.usedPercent) : max, 0);
  const delay = used >= 99 ? 5000 : used >= 90 ? 15000 : used >= 75 ? 30000 : 60000;
  return Math.max(delay, dateMilliseconds(value?.retryAt) ? value.retryAt - now : 0);
}

function quotaWarnings(value) {
  if (value?.stale || value?.errorCode || !Array.isArray(value?.warnings)) return [];
  return value.warnings.filter(w => Number.isFinite(w?.windowSeconds) && w.windowSeconds > 0
    && Number.isFinite(w.remainingPercent) && w.remainingPercent >= 0 && w.remainingPercent <= 100
    && Number.isFinite(w.threshold) && w.threshold >= w.remainingPercent && w.threshold <= 100
    && dateMilliseconds(w.resetAt));
}

function composerUsageSnapshot(value) {
  return { ...value, state: value?.state === 'available' || value?.state === 'partial' ? 'available' : 'unknown' };
}

function quotaDetailWindows(windows) {
  const rows = [...windows];
  for (const kind of ['session', 'weekly']) {
    if (!rows.some(window => window.kind === kind)) rows.push({ kind, usedPercent: null, resetAt: null, reset: '—' });
  }
  return rows;
}

function usageBarColor(usedPercent) {
  if (usedPercent === null || !Number.isFinite(usedPercent)) return null;
  if (usedPercent >= 95) return 'var(--dsw-alias-state-error-primary)';
  if (usedPercent >= 80) return 'var(--dsw-alias-state-warn-label)';
  return 'var(--dsw-alias-state-success-primary)';
}

/** Only the host's safe last-response projection is consumed here. Never read replay or UI node timing. */
function lastResponseView(value) {
  const last = value?.last;
  if (last?.version !== 1 || typeof last.messageId !== 'string' || !last.messageId
    || !Number.isSafeInteger(last.eventSeq) || last.eventSeq < 0
    || !Number.isSafeInteger(last.turn) || last.turn < 0 || !Number.isSafeInteger(last.step) || last.step < 0) return null;
  const positive = number => Number.isFinite(number) && number > 0 ? number : null;
  const outputTokens = positive(last.outputTokens), decodeMs = positive(last.decodeMs);
  const rate = outputTokens !== null && decodeMs !== null ? outputTokens * 1000 / decodeMs : null;
  return {
    version: 1, eventSeq: last.eventSeq, messageId: text(last.messageId, 256), turn: last.turn, step: last.step,
    model: text(last.model, 256) || null, completedAt: dateMilliseconds(last.completedAt) ? last.completedAt : null,
    reportedTier: REPORTED_TIERS.has(last.reportedTier) ? last.reportedTier : null,
    requestedSpeed: SPEEDS.includes(last.requestedSpeed) ? last.requestedSpeed : null, outputTokens, decodeMs,
    tokensPerSecond: Number.isFinite(rate) && rate > 0 ? rate : null,
  };
}

/** A report never derives from the request, catalog or measured throughput. */
function reportedTierLabel(tier, locale = 'en', requested = null) {
  const dict = DICTS[uiLocale(locale)];
  const expected = requested === 'ultrafast' ? 'ultrafast' : requested === 'fast' ? 'priority' : null;
  if (expected !== null && tier !== expected) return dict.tierUnconfirmed;
  if (tier === 'priority') return dict.tierPriority;
  if (tier === 'ultrafast') return dict.tierUltrafast;
  return REPORTED_TIERS.has(tier) ? tier : dict.tierUnknown;
}

function createPlugin(React, ReactDOM = {}) {
  const h = React.createElement;
  const UsageIcon = props => h('svg', { ...props, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: '1.2', strokeLinecap: 'round' },
    h('ellipse', { cx: 8, cy: 4, rx: 5.3, ry: 2.3 }),
    h('path', { d: 'M2.7 4v7.8a5.3 2.3 0 0 0 10.6 0V4M2.7 8a5.3 2.3 0 0 0 10.6 0' }));
  function useDismissOnOutsidePointer(anchor, open, setOpen, overlay) {
    React.useEffect(() => {
      if (!open) return;
      const document = anchor.current?.ownerDocument;
      const onPointer = event => {
        const path = event.composedPath();
        if (!path.includes(anchor.current) && !path.includes(overlay.current)) setOpen(false);
      };
      document?.addEventListener('pointerdown', onPointer, true);
      return () => document?.removeEventListener('pointerdown', onPointer, true);
    }, [anchor, open, setOpen, overlay]);
  }
  return {
    inject: ['connection', 'slots', 'locale', 'modelDirectories'],
    apply(ctx) {
      for (const [language, dict] of Object.entries(DICTS)) ctx.effect(() => ctx.locale.register(NS, language, dict), 'codex-native: ' + language);
      const t = ctx.locale.bind(NS);
      const api = createCodexApi(ctx.connection.rpc);
      function useLocale() {
        React.useSyncExternalStore(fn => ctx.locale.subscribe(fn), () => ctx.locale.getSnapshot(), () => ctx.locale.getSnapshot());
      }
      function Prompt({ store, prompt, busy }) {
        const [answer, setAnswer] = React.useState('');
        const id = React.useId();
        const submit = event => {
          event.preventDefault();
          const value = answer;
          setAnswer(''); // Clear before even starting the RPC; never retain answers in the store.
          void store.answer(prompt.id, value);
        };
        if (prompt.type === 'confirm') return h('div', { className: 'cn-prompt' },
          h('p', null, prompt.message), h('div', { className: 'cn-actions' },
            h('button', { type: 'button', disabled: busy, onClick: () => { void store.answer(prompt.id, true); } }, t('yes')),
            h('button', { type: 'button', disabled: busy, onClick: () => { void store.answer(prompt.id, false); } }, t('no'))));
        if (!['input', 'secret', 'select'].includes(prompt.type)) return h('p', { role: 'alert' }, t('unsupportedPrompt'));
        return h('form', { className: 'cn-prompt', onSubmit: submit, autoComplete: 'off' },
          h('label', { htmlFor: id }, prompt.message),
          prompt.type === 'select'
            ? h('select', { id, value: answer, disabled: busy, required: true, onChange: event => setAnswer(event.target.value) },
              h('option', { value: '', disabled: true }, t('choose')), ...prompt.options.map(option => h('option', { key: option.id, value: option.id }, option.label)))
            : h('input', { id, type: 'password', value: answer, disabled: busy, required: true, maxLength: 8192, autoComplete: 'off', spellCheck: false, autoCapitalize: 'none', 'aria-describedby': id + '-hint', onChange: event => setAnswer(event.target.value) }),
          h('p', { id: id + '-hint', className: 'cn-hint' }, t('inputHint')),
          h('button', { type: 'submit', disabled: busy || !answer }, t('submit')));
      }
      function Settings() {
        useLocale();
        const store = React.useMemo(() => createAuthStore(api, { onAuthChange: () => { void api.status().catch(() => {}); } }), []);
        const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
        React.useEffect(() => { store.resume(); void store.load(); return () => store.dispose(); }, [store]);
        const active = state.auth.state === 'pending';
        return h('section', { className: 'cn-panel', 'aria-label': t('title'), 'aria-busy': state.busy },
          h('style', null, CSS), h('h2', null, t('title')), h('p', null, t('description')),
          h('p', { role: 'status' }, state.ready ? t(state.authenticated ? 'connected' : 'disconnected') : t(state.busy ? 'loading' : 'unavailable')),
          h('p', { role: 'status', 'aria-live': 'polite' }, t(state.auth.state)),
          h('div', { className: 'cn-actions' },
            h('button', { type: 'button', disabled: state.busy || !state.ready || active, onClick: () => { void store.start(); } }, t('start')),
            active ? h('button', { type: 'button', disabled: state.busy || !state.ready, onClick: () => { void store.cancel(); } }, t('cancel')) : null),
          ...state.auth.notices.map((notice, index) => h('div', { className: 'cn-notice', key: index },
            notice.message ? h('p', null, notice.message) : null,
            notice.code ? h('p', null, t('code') + ': ', h('code', null, notice.code)) : null,
            notice.url ? h('a', { href: notice.url, target: '_blank', rel: 'noopener noreferrer', referrerPolicy: 'no-referrer' }, t('open')) : null)),
          active ? state.auth.prompts.map(prompt => h(Prompt, { key: state.auth.id + ':' + prompt.id, store, prompt, busy: state.busy })) : null,
          state.error ? h('p', { role: 'alert', className: 'cn-error' }, t('failure')) : null);
      }
      const speedStores = new Map();
      function sharedStore(map, sessionId, model, load) {
        const key = JSON.stringify([sessionId, model]);
        if (!map.has(key)) map.set(key, createPollingStore(load));
        return map.get(key);
      }
      ctx.effect(() => () => { for (const store of speedStores.values()) store.dispose(); speedStores.clear(); }, 'codex-native: automatic status stores');
      function useSelection(directory) {
        const subscribe = React.useCallback(fn => directory?.store.subscribe(fn) ?? noopSubscribe(), [directory]);
        const snapshot = React.useCallback(() => directory?.store.getSnapshot() ?? emptySnapshot(), [directory]);
        return React.useSyncExternalStore(subscribe, snapshot, snapshot);
      }
      function useAutomatic(store, enabled = true) {
        const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
        React.useEffect(() => enabled ? store.acquire() : undefined, [store, enabled]);
        return state;
      }
      function Speed({ sessionId, directory }) {
        useLocale();
        const models = useSelection(directory);
        const model = models.current?.provider === PROVIDER ? models.current.model : null;
        const store = React.useMemo(() => sharedStore(speedStores, sessionId, model, () => model ? api.speed(sessionId, { provider: PROVIDER, model }) : Promise.resolve(null)), [sessionId, model]);
        const state = useAutomatic(store);
        const active = React.useRef(store); active.current = store;
        React.useEffect(() => { active.current = store; return () => { active.current = null; }; }, [store]);
        const [openStore, setOpenStore] = React.useState(null);
        const open = openStore === store;
        const setOpen = React.useCallback(value => { setOpenStore(value ? store : null); }, [store]);
        const focusedStore = React.useRef(null), restoreStore = React.useRef(null);
        const mutatingStores = React.useRef(new Set());
        const [, mutationChanged] = React.useState(0);
        const changing = mutatingStores.current.has(store);
        const root = React.useRef(null), menu = React.useRef(null);
        const trigger = React.useRef(null);
        const id = React.useId();
        const anchorName = '--cn-speed-' + id.replaceAll(':', '');
        React.useEffect(() => { setOpen(false); restoreStore.current = null; }, [store]);
        useDismissOnOutsidePointer(root, open, setOpen, menu);
        React.useEffect(() => {
          if (!open) { focusedStore.current = null; return; }
          // Opening may refresh and temporarily disable every row. Wait for an
          // enabled target once; later polls must not steal keyboard navigation.
          if (state.busy || models.pending != null || focusedStore.current === store) return;
          const element = menu.current;
          const selected = element?.querySelector('[role="menuitemradio"][aria-checked="true"]:not(:disabled)')
            ?? element?.querySelector('[role="menuitemradio"]:not(:disabled)');
          if (!selected) return;
          selected.focus({ preventScroll: true }); focusedStore.current = store;
        }, [open, store, state.busy, models.pending]);
        React.useEffect(() => {
          if (restoreStore.current !== store || open || changing || models.pending != null) return;
          // Wait until the mutation-disabled trigger is enabled in the DOM.
          restoreStore.current = null; trigger.current?.focus({ preventScroll: true });
        }, [open, store, changing, models.pending]);
        if (!model) return null;
        const close = () => { restoreStore.current = store; setOpen(false); };
        const choose = async tier => {
          if (active.current !== store || mutatingStores.current.has(store) || state.busy || models.pending != null || !canChooseSpeed(tier, state.value)) return;
          if (tier === state.value?.tier) { close(); return; }
          mutatingStores.current.add(store); mutationChanged(version => version + 1);
          let success = false;
          try { success = await store.update(() => api.setSpeed(sessionId, { provider: PROVIDER, model }, tier, state.value?.fastAvailable, state.value?.ultrafastAvailable)); }
          finally {
            mutatingStores.current.delete(store);
            if (active.current !== null) mutationChanged(version => version + 1);
          }
          if (success && active.current === store) close();
        };
        const triggerLabel = t('speed') + ' · ' + (state.value ? t(state.value.tier) : '—');
        const triggerName = state.value ? triggerLabel : t('speed') + ' · ' + t(state.busy ? 'loading' : 'unavailable');
        const ultraUnavailable = state.value?.ultrafastAvailable === false;
        const errorKey = state.error === 'CODEX_ULTRAFAST_UNSUPPORTED' ? 'ultrafastUnavailable'
          : state.error === 'CODEX_ULTRAFAST_CHECK_UNAVAILABLE' ? 'ultrafastUnchecked' : 'speedFailure';
        const detailKey = tier => tier === 'ultrafast' ? (canChooseSpeed(tier, state.value) ? 'ultrafastDetail' : ultraUnavailable ? 'ultrafastUnavailable' : 'ultrafastUnchecked')
          : tier === 'fast' ? (canChooseSpeed(tier, state.value) ? 'fastDetail' : 'unsupported') : 'standardDetail';
        const onKeyDown = event => {
          if (event.key === 'Escape') { event.preventDefault(); close(); }
          if (open && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault(); const items = [...(menu.current?.querySelectorAll('[role="menuitemradio"]:not(:disabled)') ?? [])];
            if (!items.length) return;
            const current = items.indexOf(menu.current?.ownerDocument.activeElement);
            const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
            items[index]?.focus();
          }
        };
        const stopPropagation = event => { event.stopPropagation(); };
        const body = root.current?.ownerDocument?.body;
        const popup = open ? h('div', { ref: menu, id, role: 'menu', className: 'cn-speed-menu',
          style: { positionAnchor: anchorName }, 'aria-label': t('speed'),
          onPointerDown: stopPropagation, onMouseDown: stopPropagation, onClick: stopPropagation,
          onKeyDown: event => { event.stopPropagation(); onKeyDown(event); }, onKeyUp: stopPropagation,
        }, ...speedChoices(state.value).map(tier => h('button', { key: tier, type: 'button', role: 'menuitemradio', className: 'cn-speed-item', 'aria-checked': state.value?.tier === tier,
          disabled: state.busy || !canChooseSpeed(tier, state.value), onClick: () => { void choose(tier); },
        }, h('span', { className: 'cn-speed-item-check', 'aria-hidden': true }, state.value?.tier === tier ? '✓' : ''),
          h('span', { className: 'cn-speed-item-text' }, h('span', { className: 'cn-speed-item-name' }, t(tier)),
            h('span', { className: 'cn-speed-item-description' }, t(detailKey(tier)))))),
          ultraUnavailable && state.value?.tier !== 'ultrafast' && !state.error
            ? h('div', { role: 'presentation', className: 'cn-speed-note' }, t('ultrafastUnavailable')) : null,
          state.error ? h('p', { role: 'alert', className: 'cn-speed-error' }, t(errorKey)) : null) : null;
        return h('div', { className: 'cn-speed', style: { ...SPEED_STYLES.root, anchorName }, ref: root, onKeyDown }, h('style', null, SPEED_CSS),
          h('button', { ref: trigger, type: 'button', className: 'cn-speed-trigger', title: triggerName + '\n' + t('speedHint'), 'aria-label': triggerName, 'aria-haspopup': 'menu', 'aria-controls': open && body ? id : undefined, 'aria-expanded': open, 'aria-busy': state.busy, disabled: changing || models.pending != null,
            onFocus: () => { void store.refresh({ focus: true }); }, onClick: () => { setOpen(!open); if (!open) void store.refresh({ focus: true }); },
            onKeyDown: event => { if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setOpen(true); void store.refresh({ focus: true }); } },
          }, h('span', { className: 'cn-trigger-text' }, triggerLabel), h(ComposerTriggerGlyph, { h, kind: speedGlyph(state.value?.tier) })),
          popup && body && typeof ReactDOM.createPortal === 'function' ? ReactDOM.createPortal(popup, body) : null);
      }
      function Usage({ sessionId, directory, useProjection }) {
        useLocale();
        const locale = uiLocale(t('localeCode'));
        const models = useSelection(directory);
        const provider = models.current?.provider;
        const model = provider === PROVIDER ? models.current.model : null;
        const ownerRevision = React.useSyncExternalStore(api.subscribeRevision, api.revision, api.revision);
        // Keep the legacy popover, but read the same revision-bearing Codex
        // snapshot as Settings. The v1 wire response cannot fence account data.
        const store = accountStore('usageV2');
        const state = useAutomatic(store, Boolean(model));
        // The keyed host hook carries a server-safe per-session view, not cumulative tokens or timing.
        const last = lastResponseView(typeof useProjection === 'function' ? useProjection(LAST_RESPONSE_KEY) : null);
        const scope = JSON.stringify([sessionId, provider, model, ownerRevision]);
        const [openScope, setOpenScope] = React.useState(null);
        const open = Boolean(model) && openScope === scope;
        const anchor = React.useRef(null), trigger = React.useRef(null), panel = React.useRef(null);
        const focusedScope = React.useRef(null);
        const activeScope = React.useRef(scope); activeScope.current = scope;
        const id = React.useId();
        const anchorName = '--cn-usage-' + id.replaceAll(':', '');
        const close = React.useCallback(() => { setOpenScope(null); }, []);
        React.useEffect(() => { setOpenScope(null); activeScope.current = scope; return () => { activeScope.current = null; }; }, [scope]);
        useDismissOnOutsidePointer(anchor, open, close, panel);
        React.useEffect(() => {
          if (!open) { focusedScope.current = null; return; }
          // The portal renders with CSS anchor placement; focus once per opening.
          // Resize/projection updates must not steal keyboard navigation.
          if (focusedScope.current === scope) return;
          const element = panel.current;
          if (!element) return;
          element.focus({ preventScroll: true });
          focusedScope.current = scope;
        }, [open, scope]);
        React.useEffect(() => {
          if (!open) return;
          const document = anchor.current?.ownerDocument;
          const button = trigger.current;
          const onKeyDown = event => {
            if (event.key !== 'Escape' || event.defaultPrevented || document?.querySelector('dialog:modal')) return;
            event.preventDefault(); event.stopPropagation(); close();
          };
          document?.addEventListener('keydown', onKeyDown);
          return () => {
            document?.removeEventListener('keydown', onKeyDown);
            if (button?.isConnected !== false) button?.focus({ preventScroll: true });
          };
        }, [open, scope, close]);
        if (!model) return null;
        const L = words();
        const snapshot = state.value?.viewRevision === ownerRevision ? state.value : null;
        const view = formatUsageBadge(composerUsageSnapshot(snapshot), { locale });
        const status = quotaSnapshotStatus({ ...state, value: snapshot }).kind;
        const notice = status === 'error' ? [L.issue, view.windows.length ? t('usageStale') : null].filter(Boolean).join(' · ')
          : status === 'stale' ? t('usageStale') : status === 'loading' ? L.loading : null;
        const windowLabel = window => window.kind === 'unknown' ? L.unknown : t(window.kind === 'session' ? 'sessionWindow' : window.kind === 'weekly' ? 'weeklyWindow' : 'otherWindow');
        const rows = quotaDetailWindows(view.windows);
        const localTime = timestamp => dateMilliseconds(timestamp) ? new Date(timestamp).toLocaleString(locale) : '—';
        const time = timestamp => dateMilliseconds(timestamp) ? h('time', { dateTime: new Date(timestamp).toISOString() }, localTime(timestamp)) : '—';
        const tooltip = [t('quota'), ...view.windows.map(window => windowLabel(window) + ': ' + Math.round(window.usedPercent) + '% ' + t('used') + ' · ' + t('resets') + ' ' + window.reset + (dateMilliseconds(window.resetAt) ? ' (' + localTime(window.resetAt) + ')' : '')),
          !view.windows.length ? t('usageUnknown') : '', notice ?? '',
          view.checkedAt === null ? '' : t('checkedAt') + ' ' + localTime(view.checkedAt)].filter(Boolean).join('\n');
        const icon = () => h('span', { className: 'cn-usage-glyph', 'aria-hidden': true }, h(UsageIcon, { width: 14, height: 14, 'aria-hidden': true, focusable: false }));
        const tier = last?.reportedTier ?? null;
        const requested = last?.requestedSpeed ?? null;
        const tierText = reportedTierLabel(tier, locale, requested);
        const rate = last?.tokensPerSecond;
        const body = anchor.current?.ownerDocument?.body;
        const headline = view.windows.length ? Math.max(...view.windows.map(window => Math.round(window.usedPercent))) + '% ' + t('used') : t('usageUnknown');
        const dialog = open ? h('div', { ref: panel, id, role: 'dialog', 'aria-modal': false, 'aria-label': t('quota'), className: 'cn-usage-panel', tabIndex: -1,
          style: { positionAnchor: anchorName },
        }, h('div', { className: 'cn-usage-title' }, h('span', { className: 'cn-usage-title-label' }, icon(), t('quota')),
          h('span', { className: 'cn-usage-title-value' }, headline)),
          h('div', { className: 'cn-usage-title-rule', 'aria-hidden': true }),
          h('section', { 'aria-label': t('quota') }, h('dl', { className: 'cn-usage-details' }, ...rows.map((window, index) => {
              const known = Number.isFinite(window.usedPercent);
              return h(React.Fragment, { key: window.kind + ':' + index }, h('dt', null, windowLabel(window)),
                h('dd', null, known ? Math.round(window.usedPercent) + '% ' + t('used') : '—',
                  known ? h('span', { className: 'cn-usage-reset' }, ' · ' + t('resets') + ' ' + window.reset) : null),
                h('div', { className: 'cn-usage-bar', 'aria-hidden': true, 'data-quota-kind': window.kind },
                  known ? h('div', { className: 'cn-usage-bar-fill', style: { width: window.usedPercent + '%', background: usageBarColor(window.usedPercent) } }) : null));
            })),
            !view.windows.length ? h('p', { className: 'cn-usage-meta' }, t('usageUnknown')) : null,
            notice ? h('p', { role: status === 'error' ? 'alert' : 'status', className: 'cn-usage-meta' }, notice) : null,
            h('p', { className: 'cn-usage-meta' }, t('checkedAt') + ': ', time(view.checkedAt))),
          h('div', { className: 'cn-usage-last', 'data-cn-last-response': true, 'aria-labelledby': id + '-last' },
            h('div', { className: 'cn-usage-title' }, h('span', { id: id + '-last', className: 'cn-usage-title-label' }, t('lastCompleted'))),
            h('div', { className: 'cn-usage-title-rule', 'aria-hidden': true }),
            last ? h('p', { className: 'cn-usage-meta' }, last.model ?? '—', ' · ', time(last.completedAt)) : h('p', { className: 'cn-usage-meta' }, t('noCompleted')),
            h('dl', { className: 'cn-usage-details' }, h('dt', null, t('actualTier')),
              h('dd', null, tier !== null
                ? h(React.Fragment, null, h('code', null, tier), tierText !== tier ? ' · ' + tierText : null)
                : h(React.Fragment, null, t('tierUnknown'), tierText !== t('tierUnknown') ? ' · ' + tierText : null)),
              requested ? h(React.Fragment, null, h('dt', null, t('requestedSpeed')), h('dd', null, t(requested))) : null,
              h('dt', null, t('throughput')),
              h('dd', { title: t('throughputHint') }, rate == null ? '—' : new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(rate), h('span', { className: 'cn-usage-reset' }, ' ' + t('tokensPerSecond')))))) : null;
        return h('span', { ref: anchor, className: 'cn-usage', 'data-composer-stat': 'codex-native', style: { anchorName } }, h('style', null, QUOTA_CSS),
          h('button', { ref: trigger, type: 'button', className: 'cn-usage-pill', title: tooltip, 'aria-label': t('quota') + ' · ' + view.label,
            'aria-haspopup': 'dialog', 'aria-controls': open ? id : undefined, 'aria-expanded': open,
            onFocus: () => { if (activeScope.current === scope) void store.refresh({ focus: true }); },
            onClick: () => { if (activeScope.current !== scope) return; setOpenScope(open ? null : scope); if (!open) void store.refresh({ focus: true }); },
          }, icon(), h('span', { className: 'cn-usage-label' }, view.label)),
          dialog && body && typeof ReactDOM.createPortal === 'function' ? ReactDOM.createPortal(dialog, body) : null);
      }

      const RU_EXT={cloud:'Облачное сжатие Codex',threshold:'Порог (токены, пусто — автоматически)',next:'Применяется со следующего запроса',save:'Сохранить',off:'Выключено',waiting:'Checkpoint пока не получен',reused:'Checkpoint использован',attachedToFinish:'Checkpoint приложен к ответу',saved:'Checkpoint записан в журнал',received:'Checkpoint получен',budget:'Недоступно для контекста этого вызова',fallback:'Использована обычная история',quota:'Квоты и Credits',refresh:'Обновить',loading:'Загрузка…',stale:'Данные устарели; ожидается обновление',unknown:'Не предоставляется или неизвестно',zero:'Нет доступных карточек',balance:'Баланс Credits',spend:'Ограничения расходования',history:'История за 7 дней',profile:'Статистика аккаунта',forecast:'Прогноз',enableForecast:'Сохранять историю прогноза (выключение не очищает её)',retry:'Ждать подтверждённого сброса основных квот Codex, включая недельную; выключение отменяет ожидание',alerts:'Предупреждения',important:'Важные',early:'Ранние',custom:'Свои пороги',short:'Короткое окно, %',long:'Длинное окно, %',clear:'Очистить только историю прогноза',askClear:'Очистить историю прогноза текущей авторизации?',rates:'Если сохранится наблюдавшийся темп',calibrating:'Недостаточно данных',survives:'Хватит до сброса',yes:'Да',no:'Нет',approximate:'Приблизительно',incomplete:'Неполное покрытие',daily:'Дневные токены; пропуск дня не означает ноль',missing:'нет данных',cards:'Карточки сброса',use:'Использовать карточку',recovery:'Повторить тот же запрос',reconcile:'Обновить состояние (только чтение)',pending:'Операции сброса',confirm:'Подтверждение сброса',close:'Закрыть',ack:'Я понимаю, что запрос может израсходовать один доступный сброс',earlyReset:'Квота ещё не исчерпана. Это запрос на досрочный сброс.',sending:'Запрос уже отправляется; закрытие не отменяет расходование. Результат будет сохранён.',uncertain:'Результат не подтверждён. Не начинайте новый сброс для этой карточки.',managed:'Использование карточки доступно в Desktop, который владеет этой авторизацией.',reset:'Сервер подтвердил сброс',nothing_to_reset:'Сервер сообщил, что сбрасывать нечего',no_credit:'Сервер сообщил, что карточка недоступна',already_redeemed:'Карточка уже использована; новый сброс не подтверждён',mismatch:'Сервер указал карточки, но не перечислил доступных к использованию.',remaining:'осталось',expires:'Действует до',recoverAt:'Восстановление',checked:'Проверено',quotaWarning:'Остаток Codex ниже порога',modelBucket:'Показана общая квота Codex; квота отдельной модели не подтверждена',issue:'Не удалось выполнить действие',expired:'Срок подтверждения истёк; подготовьте новое',requestUncertain:'Ответ не получен. Обновите журнал перед дальнейшими действиями.'};
      const EN_EXT={cloud:'Codex cloud compaction',threshold:'Threshold (tokens; blank for automatic)',next:'Applies to the next model request',save:'Save',off:'Off',waiting:'No checkpoint yet',reused:'Checkpoint used',attachedToFinish:'Checkpoint attached to response',saved:'Checkpoint committed to the session log',received:'Checkpoint received',budget:'Unavailable for this request’s context budget',fallback:'Full history used',quota:'Quotas and credits',refresh:'Refresh',loading:'Loading…',stale:'Data is stale; waiting for an update',unknown:'Unavailable or unknown',zero:'No reset cards available',balance:'Credit balance',spend:'Spending limits',history:'Seven-day history',profile:'Account statistics',forecast:'Forecast',enableForecast:'Keep forecast history (turning it off does not erase history)',retry:'Wait for a confirmed reset of the main Codex quotas, including the weekly quota; turning it off cancels an active wait',alerts:'Warnings',important:'Important',early:'Early',custom:'Custom',short:'Short window, %',long:'Long window, %',clear:'Clear forecast history only',askClear:'Clear forecast history for the current authorization?',rates:'Assuming the observed pace continues',calibrating:'Insufficient data',survives:'Enough until reset',yes:'Yes',no:'No',approximate:'Approximate',incomplete:'Partial coverage',daily:'Daily tokens; missing days do not mean zero use',missing:'no data',cards:'Reset cards',use:'Use card',recovery:'Repeat the same request',reconcile:'Refresh observations (read only)',pending:'Reset operations',confirm:'Confirm reset',close:'Close',ack:'I understand this request may use one available reset',earlyReset:'Quota is not exhausted. This requests an early reset.',sending:'The request is being sent. Closing will not cancel it; the result will be recorded.',uncertain:'Outcome unconfirmed. Do not start a new reset for this card.',managed:'Reset cards are managed by the Desktop instance that owns this authorization.',reset:'Server confirmed the reset',nothing_to_reset:'The server reported nothing to reset',no_credit:'The server reported no available card',already_redeemed:'Already redeemed; a new reset was not confirmed',mismatch:'The server reported cards but did not list a usable one.',remaining:'remaining',expires:'Expires',recoverAt:'Resets',checked:'Checked',quotaWarning:'Codex remaining quota crossed the threshold',modelBucket:'General Codex quota; the model’s separate meter is not confirmed',issue:'Could not complete the action',expired:'Confirmation expired; prepare a new one',requestUncertain:'No reply received. Refresh the operations before taking another action.'};
      const QUOTA_WORDS = {
        en: { cloudShort: 'Cloud', cloudOn: 'On', lowQuota: 'Low quota', thresholdLabel: 'warning threshold', retryAtLabel: 'Next retry after', inventoryIssue: 'Could not read the reset card inventory', reportsUnavailable: 'This report is not provided', usageSections: { codex: 'Codex', additional: 'Additional quotas', codeReview: 'Code review', credits: 'Credits', spending: 'Spending limits', resets: 'Reset cards', chatPass: 'ChatPass' } },
        ru: { cloudShort: 'Сжатие', cloudOn: 'Включено', lowQuota: 'Квота заканчивается', thresholdLabel: 'порог предупреждения', retryAtLabel: 'Повтор после', inventoryIssue: 'Не удалось прочитать список карточек сброса', reportsUnavailable: 'Отчёт не предоставляется', usageSections: { codex: 'Codex', additional: 'Дополнительные квоты', codeReview: 'Проверка кода', credits: 'Credits', spending: 'Ограничения расходования', resets: 'Карточки сброса', chatPass: 'ChatPass' } },
      };
      function words(){const locale=uiLocale(t('localeCode'));return {...(locale==='ru'?RU_EXT:EN_EXT),...QUOTA_WORDS[locale]};}
      const EXT_STYLE=`
.cn-extra{color:var(--dsw-alias-label-primary,CanvasText);overflow-wrap:anywhere}
.cn-extra h3{margin:12px 0 5px}.cn-extra p{margin:5px 0}
.cn-extra :is(button,input:not([type=checkbox]),select){color:inherit;font:inherit;background:var(--dsw-alias-bg-layer-2,Canvas);border:1px solid var(--dsw-alias-border-l1,ButtonBorder);border-radius:var(--dsw-radius-sm,6px);padding:4px 8px}
.cn-extra button{cursor:pointer}.cn-extra button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2,Canvas))}.cn-extra button:disabled{opacity:.55;cursor:default}
.cn-extra input[type=checkbox]{accent-color:var(--dsw-alias-brand-primary,Highlight)}
.cn-extra-row,.cn-extra-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:6px 0}
.cn-extra-actions{justify-content:flex-end;margin:14px 0 0}
.cn-extra-list{padding-inline-start:20px;max-height:260px;overflow:auto}
.cn-extra-dialog{box-sizing:border-box;position:fixed;inset:0;margin:auto;inline-size:min(440px,calc(100vw - 32px));max-inline-size:calc(100vw - 32px);max-block-size:calc(100vh - 32px);max-block-size:calc(100dvh - 32px);overflow:auto;overscroll-behavior:contain;padding:16px;border:1px solid var(--dsw-alias-border-l1,ButtonBorder);border-radius:var(--dsw-radius-lg,10px);color:var(--dsw-alias-label-primary,CanvasText);background:Canvas;background:linear-gradient(var(--dsw-alias-bg-layer-1,Canvas),var(--dsw-alias-bg-layer-1,Canvas)),Canvas;box-shadow:var(--dsw-elevation-prominent)}
.cn-extra-dialog::backdrop{background:var(--dsw-alias-bg-mask-1,revert)}
.cn-extra-dialog h2{font:inherit;font-weight:600;font-size:16px;margin:0 0 10px}
.cn-extra-warn{color:var(--dsw-alias-state-warn-primary,CanvasText)}
.cn-extra input[type=number]{max-width:min(130px,100%)}
.cn-extra :is(button,input,select):focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary,Highlight));outline-offset:2px}
.cn-calendar{display:grid;grid-template-columns:repeat(auto-fill,minmax(105px,1fr));gap:3px;max-height:220px;overflow:auto;padding:2px}
.cn-calendar span{display:grid;padding:3px 5px;border-radius:3px;background:var(--dsw-alias-bg-layer-2,Canvas)}
`;
      const extStores=new Map();
      function accountStore(endpoint,args={},id=''){
        const key=endpoint+':'+id;
        if(!extStores.has(key))extStores.set(key,createPollingStore((signal, { force }) => api.extended(endpoint, force ? { ...args, force: true } : args, { signal }),{interval:endpoint==='usageV2'?quotaPollDelay:15000}));
        return extStores.get(key);
      }
      ctx.effect(()=>{const stop=api.subscribeRevision(()=>{for(const s of extStores.values())s.reset();});return()=>{stop();for(const s of extStores.values())s.dispose();extStores.clear();};},'codex-native: quota and cloud views');
      function date(x){return dateMilliseconds(x)?new Date(x).toLocaleString(t('localeCode')):words().unknown;}
      function extError(code,L){if(code==='RESET_UNCERTAIN')return L.uncertain;if(code==='RESET_MANAGED_BY_DESKTOP'||code==='QUOTA_MANAGED_BY_DESKTOP')return L.managed;if(code==='RESET_EXPIRED')return L.expired;return code==='QUOTA_STALE_REPLY'?L.refresh:L.issue+(code?' ('+code+')':'');}
      function safeCloudStatus(status,L){const labels={off:L.off,waiting:L.waiting,missing:L.waiting,reused:L.reused,received:L.received,attachedToFinish:L.attachedToFinish,saved:L.saved,'budget-unavailable':L.budget};return !status ? L.unknown : Object.hasOwn(labels,status.reason) ? labels[status.reason] : L.fallback;}
      function useScopedActivity(revision) {
        const lifetime = React.useRef(null);
        React.useEffect(() => {
          const controller = new AbortController(); lifetime.current = controller;
          return () => controller.abort();
        }, [revision]);
        return () => {
          const signal = lifetime.current?.signal;
          return { signal, current: () => Boolean(signal && !signal.aborted && revision === api.revision()) };
        };
      }
      function Modal({title,close,label,children,dialogId,returnFocus,actions}){
        const ref=React.useRef(null),id=React.useId();
        React.useEffect(()=>{
          const element=ref.current;
          if(!element?.isConnected)return;
          const previous=returnFocus?.current??element.ownerDocument.activeElement;
          if(!element.open)element.showModal();
          return()=>{if(element.open)element.close();if(previous?.isConnected)previous.focus({preventScroll:true});};
        },[returnFocus]);
        return h('dialog',{ref,id:dialogId,className:'cn-extra-dialog cn-extra','aria-labelledby':id,onCancel:e=>{e.preventDefault();close();}},
          h('style',null,EXT_STYLE),h('h2',{id},title),children,
          h('div',{className:'cn-extra-actions'},h('button',{type:'button',onClick:close},label),actions));
      }
      function CloudControl({sessionId,directory}){
        const model=useSelection(directory).current;
        const revision=React.useSyncExternalStore(api.subscribeRevision,api.revision,api.revision);
        return model?.provider===PROVIDER ? h(CloudEditor,{key:JSON.stringify([sessionId,model.model,revision]),sessionId,model:model.model,revision}) : null;
      }
      function CloudEditor({sessionId,model,revision}) {
        useLocale();const L=words();
        const store=accountStore('cloudCompaction',{sessionId,model},JSON.stringify([sessionId,model]));
        const state=useAutomatic(store);
        const [open,show]=React.useState(false),[mode,setMode]=React.useState('off'),[threshold,setThreshold]=React.useState(''),[busy,setBusy]=React.useState(false),[error,setError]=React.useState(null);
        const activity=useScopedActivity(revision), sending=React.useRef(false);
        const trigger=React.useRef(null), dialogId=React.useId();
        const s=state.value?.viewRevision===revision ? state.value : null;
        const status=s?.status && (!s.status.model || s.status.model===model) ? s.status : null;
        const effective=status?.threshold??s?.budgetPreview;
        const valid=!threshold.trim()||/^\d+$/u.test(threshold)&&Number.isSafeInteger(Number(threshold))&&Number(threshold)>=1000;
        function restore(value){setMode(value?.policy?.mode??'off');setThreshold(value?.policy?.thresholdTokens?.toString()??'');}
        const save=async()=>{
          const scope=activity();if(sending.current||!valid||!s||!scope.current())return;
          sending.current=true;setBusy(true);setError(null);
          try {
            const value=await api.extended('setCloudCompaction',{sessionId,mode,thresholdTokens:threshold.trim()?Number(threshold):null},scope);
            if(scope.current()) { store.replace({ ...s, ...value, budgetPreview: null }); show(false); void store.refresh(); }
          } catch(e) {
            if(scope.current()){restore(store.getSnapshot().value);setError(e?.code??'RPC_FAILED');}
          } finally { sending.current=false;if(scope.current())setBusy(false); }
        };
        const enabled=s?.policy?.mode==='cloud';
        const cloudLabel=L.cloudShort+' — '+L.cloud+' · '+(s?enabled?L.cloudOn+' · '+safeCloudStatus(status,L):L.off:L.unknown);
        const body=trigger.current?.ownerDocument?.body;
        const popup=open?h(Modal,{title:L.cloud,close:()=>show(false),label:L.close,dialogId,returnFocus:trigger,
          actions:h('button',{type:'button',disabled:busy||!s||!valid,onClick:save},busy?L.loading:L.save)},
          h('p',null,L.next),h('p',{role:'status'},safeCloudStatus(status,L),Number.isFinite(effective)?' · '+effective.toLocaleString(t('localeCode'))+' tok':''),
          h('label',{className:'cn-extra-row'},h('input',{type:'checkbox',role:'switch',checked:mode==='cloud',onChange:e=>setMode(e.target.checked?'cloud':'off')}),L.cloud),
          h('label',{className:'cn-extra-row'},L.threshold,h('input',{type:'number',min:1000,step:1,value:threshold,onChange:e=>setThreshold(e.target.value),'aria-invalid':!valid})),
          error?h('p',{role:'alert'},extError(error,L)):null):null;
        return h('span',{className:'cn-cloud'},h('style',null,COMPOSER_TRIGGER_CSS),
          h('button',{ref:trigger,className:'cn-cloud-trigger',type:'button',title:cloudLabel,'aria-label':cloudLabel,
            'aria-haspopup':'dialog','aria-expanded':open,'aria-controls':open?dialogId:undefined,
            onClick:()=>{restore(s);setError(null);show(true);}},
            h('span',{className:'cn-trigger-text'},L.cloudShort+(enabled?' ✓':'')), h(ComposerTriggerGlyph,{h,kind:'cloud',checked:enabled})),
          popup&&body&&typeof ReactDOM.createPortal==='function'?ReactDOM.createPortal(popup,body):null);
      }
      function Windows({data,L}){
        const percent = value => quotaPercent(value,t('localeCode'));
        const quantity = (value,label) => percent(value)==='—' ? L.unknown : `${percent(value)} ${label}`;
        const kind = w => w.kind==='session'?t('sessionWindow'):w.kind==='weekly'?t('weeklyWindow'):w.kind==='other'?t('otherWindow'):L.unknown;
        const resetTime = value => dateMilliseconds(value) ? h('time',{title:date(value),dateTime:new Date(value).toISOString()},date(value)) : L.unknown;
        return h('div',null,...(data?.rateLimits??[]).map(limit=>h('section',{key:limit.id},h('h3',null,limit.name??limit.id),...(limit.windows??[]).map((w,n)=>h('p',{key:n},`${kind(w)}: ${quantity(w.usedPercent,t('used'))} · ${quantity(w.remainingPercent,L.remaining)} · `,resetTime(w.resetAt))))),
          data?.chatPass?h('section',null,h('h3',null,'ChatPass'),...(data.chatPass.windows??[]).map((w,i)=>h('p',{key:i},quantity(w.remainingPercent,L.remaining),' · ',resetTime(w.resetAt)))):null);
      }
      function QuotaSettings(){
        const revision=React.useSyncExternalStore(api.subscribeRevision,api.revision,api.revision);
        return h(QuotaAccountView,{key:revision??'bootstrap',revision});
      }
      function QuotaAccountView({revision}){
        useLocale();const L=words();
        const activity=useScopedActivity(revision);
        const usageStore=accountStore('usageV2');const inventoryStore=accountStore('resetInspect');const prefStore=accountStore('quotaPreferences');const forecastStore=accountStore('quotaForecast');
        const usage=useAutomatic(usageStore),inventory=useAutomatic(inventoryStore),prefs=useAutomatic(prefStore),forecast=useAutomatic(forecastStore);
        const [reports,setReports]=React.useState(false);const historyStore=accountStore('usageHistory'),profileStore=accountStore('usageProfile');
        const history=React.useSyncExternalStore(historyStore.subscribe,historyStore.getSnapshot,historyStore.getSnapshot),profile=React.useSyncExternalStore(profileStore.subscribe,profileStore.getSnapshot,profileStore.getSnapshot);
        React.useEffect(()=>{if(!reports)return;const stop=[historyStore.acquire(),profileStore.acquire()];return()=>stop.forEach(x=>x());},[reports,historyStore,profileStore]);
        const [challenge,setChallenge]=React.useState(null),[ack,setAck]=React.useState(false),[clock,setClock]=React.useState(Date.now()),[busy,setBusy]=React.useState(false),[feedback,setFeedback]=React.useState(null),[result,setResult]=React.useState(null),[clear,setClear]=React.useState(false);
        const inFlight=React.useRef(false), preparedAt=React.useRef(null);
        React.useEffect(()=>{if(!challenge)return;const timer=setInterval(()=>setClock(Date.now()),200);return()=>clearInterval(timer);},[challenge]);
        const owned=state=>state.value?.viewRevision===revision ? state.value : null;
        const u=owned(usage),p=owned(prefs)?.preferences,inv=owned(inventory);
        function refresh(force=true){
          if(!activity().current())return;
          for(const store of [usageStore,inventoryStore,...(reports?[historyStore,profileStore]:[])])void store.refresh({force});
        }
        async function action(endpoint,args,accept){
          const scope=activity();if(inFlight.current||!revision||!scope.current())return;
          inFlight.current=true;setBusy(true);setFeedback(null);
          try{const value=await api.extended(endpoint,args,scope);if(scope.current())accept?.(value);}
          catch(e){if(scope.current()){
            const code=e?.code;
            setFeedback(endpoint==='resetConsume'&&(!code||code==='QUOTA_STALE_REPLY')?'LOST':code??'RPC_FAILED');
            if(endpoint==='resetConsume'){setChallenge(null);setAck(false);refresh();}
          }}
          finally{inFlight.current=false;if(scope.current())setBusy(false);}
        }
        function prepare(card,operation){void action(operation?'resetRecoveryPrepare':'resetPrepare',operation?{operationId:operation.operationId}:{creditRef:card.creditRef},c=>{preparedAt.current=performance.now();setClock(Date.now());setAck(false);setChallenge(c);});}
        function hide(){
          const c=challenge, scope=activity();setChallenge(null);setAck(false);
          if(c&&!inFlight.current&&c.viewRevision===revision&&scope.current())void api.extended('resetCancel',{challengeId:c.challengeId},scope).catch(()=>{});
        }
        function canConfirm(now){return !!challenge&&ack&&!busy&&now>=challenge.readyAt&&now<challenge.confirmBy&&preparedAt.current!==null&&performance.now()-preparedAt.current>=5000;}
        function confirm(){if(canConfirm(Date.now()))void action('resetConsume',{challengeId:challenge.challengeId,acknowledged:true},value=>{setChallenge(null);setAck(false);setResult(value);refresh();});}
        function change(patch){void action('setQuotaPreferences',{patch},value=>{prefStore.replace(value);void forecastStore.refresh();});}
        const checkbox=(key,message)=>h('label',{className:'cn-extra-row',key},h('input',{type:'checkbox',checked:p[key],disabled:busy||prefs.value?.ownerManaged,onChange:e=>void change({[key]:e.target.checked})}),message);
        const stateText=(s,issue=L.issue)=>{
          const {kind}=quotaSnapshotStatus({ ...s, value: owned(s) });
          const value=owned(s);
          return kind==='error' ? [issue,value?.stale||dateMilliseconds(value?.checkedAt)?L.stale:null,dateMilliseconds(value?.retryAt)?L.retryAtLabel+' '+date(value.retryAt):null].filter(Boolean).join(' · ')
            : kind==='loading' ? L.loading : kind==='stale' ? L.stale : kind==='unavailable' ? L.reportsUnavailable : null;
        };
        const percent=x=>quotaPercent(x,t('localeCode'),L.unknown);
        const warnings=quotaWarnings(u);
        const forecastData=owned(forecast);
        function showReports(){
          if(!reports)return null;const a=owned(history)?.data,b=owned(profile)?.data;
          const periods=a?.periods??[],days=b?.days??[],daily=new Map(days.map(d=>[d.date,d.tokens]));
          const end=days.length?Date.parse(days.at(-1).date):null;
          const calendar=end===null?[]:Array.from({length:Math.min(120,Math.floor((end-Date.parse(days[0].date))/86400000)+1)},(_,i)=>new Date(end-i*86400000).toISOString().slice(0,10)).reverse();
          return h('div',null,h('h3',null,L.history),h('p',null,stateText(history)??(!a?L.unknown:[a.approximate?L.approximate:'',!a.coverageComplete?L.incomplete:'',a.asOf?L.checked+' '+date(a.asOf):''].filter(Boolean).join(' · '))),
          h('ul',{className:'cn-extra-list'},...periods.map((v,i)=>h('li',{key:i},`${date(v.startsAt)} — ${date(v.endsAt)} · ${percent(v.usedPercent)}`,v.complete?'':' · '+L.incomplete,...Object.entries(v.breakdowns).map(([k,rows])=>h('details',{key:k},h('summary',null,k),...rows.map((r,j)=>h('p',{key:j},r.key+' · '+percent(r.percent)))))))),
          h('h3',null,L.profile),h('p',null,stateText(profile)??(!b?L.unknown:L.daily)),b?h('dl',null,...Object.entries(b).filter(([k,v])=>k!=='days'&&['string','number'].includes(typeof v)).map(([k,v])=>h(React.Fragment,{key:k},h('dt',null,k.replace(/([A-Z])/g,' $1')),h('dd',null,v)))):null,
          h('div',{className:'cn-calendar','aria-label':L.daily},...calendar.map(d=>h('span',{key:d,title:d+' · '+(daily.get(d)??L.missing)},d,h('small',null,daily.has(d)?daily.get(d).toLocaleString(t('localeCode')):L.missing)))));
        }
        return h('section',{className:'cn-extra'},h('style',null,EXT_STYLE),h('h2',null,L.quota),h('button',{type:'button',onClick:()=>refresh()},L.refresh),h('p',{role:'status'},stateText(usage)??(u?.checkedAt?L.checked+' '+date(u.checkedAt):L.unknown)),
          h(Windows,{data:u,L}),...(u?.sectionErrors??[]).filter(x=>Object.hasOwn(L.usageSections,x.section)).map(x=>h('p',{key:x.section,role:'status'},`${L.usageSections[x.section]}: ${L.unknown}`)),
           ...warnings.map(w=>h('p',{key:w.id,role:'status',className:'cn-extra-warn'},`${L.lowQuota} · ${w.windowSeconds<=21600?t('sessionWindow'):t('weeklyWindow')}: ${percent(w.remainingPercent)} ${L.remaining} (${L.thresholdLabel}: ${percent(w.threshold)}) · ${date(w.resetAt)}`)),
          h('h3',null,L.balance),h('p',null,u?.credits?.unlimited?'∞':u?.credits?.balance??L.unknown,u?.credits?.expiresAt?' · '+L.expires+' '+date(u.credits.expiresAt):''),
          ...(u?.credits?[['Local',u.credits.approxLocalMessages],['Cloud',u.credits.approxCloudMessages]].filter(([,v])=>v).map(([label,r])=>h('p',{key:label},`${label}: ${r.join('–')} · ${L.approximate}`)):[]),
          h('h3',null,L.spend),h('p',null,u?.rateLimitReachedType??'',u?.spendControlReached===true?' · '+L.spend:''),h('p',null,u?.individualLimit?`${u.individualLimit.used??L.unknown} / ${u.individualLimit.limit??L.unknown} · ${percent(u.individualLimit.remainingPercent)} · ${date(u.individualLimit.resetAt)}`:L.unknown),
          h('h3',null,L.cards),h('p',{role:'status'},stateText(inventory,L.inventoryIssue)??(inv?.inventoryState!=='available'||!Number.isSafeInteger(inv.availableCount)||inv.availableCount<0?L.unknown:inv.mismatch?L.mismatch:inv.availableCount===0?L.zero:String(inv.availableCount))),inv?.ownerManaged?h('p',null,L.managed):null,
          ...(inv?.cards??[]).map(card=>h('div',{className:'cn-extra-row',key:card.creditRef},h('span',null,card.name??L.cards,card.expiresAt?' · '+date(card.expiresAt):''),h('button',{type:'button',disabled:busy||inv.ownerManaged||inv.inventoryState!=='available'||inv.stale||!!inv.errorCode||!!inv.journalError,onClick:()=>prepare(card)},L.use))),
          h('h3',null,L.pending),inv?.journalError?h('p',{role:'alert'},extError(inv.journalError,L)):null,
          ...(inv?.operations??[]).map(op=>h('div',{className:'cn-extra-row',key:op.operationId},h('span',null,date(op.createdAt)+' · '+(L[op.resultCode]??(op.state==='uncertain'?L.uncertain:op.state))),op.state==='uncertain'?h(React.Fragment,null,h('button',{type:'button',disabled:busy,onClick:()=>void action('resetReconcile',{operationId:op.operationId},()=>refresh(false))},L.reconcile),h('button',{type:'button',disabled:busy,onClick:()=>void prepare(null,op)},L.recovery)):null)),
          feedback?h('p',{role:'alert'},feedback==='LOST'?L.requestUncertain:extError(feedback,L)):null,result?h('p',{role:'status'},L[result.resultCode]??L.unknown):null,
          challenge?h(Modal,{title:L.confirm,close:hide,label:L.close},h('p',null,challenge.kind==='recovery'?L.recovery:challenge.name??L.cards),challenge.description?h('p',null,challenge.description):null,h(Windows,{data:u,L}),u?.windows?.some(w=>w.remainingPercent>0)?h('p',null,L.earlyReset):null,
            h('p',null,L.expires+': '+date(challenge.confirmBy)),h('label',{className:'cn-extra-row'},h('input',{type:'checkbox',checked:ack,disabled:busy,onChange:e=>setAck(e.target.checked)}),L.ack),
            busy?h('p',{role:'status'},L.sending):null,h('button',{type:'button',disabled:!canConfirm(clock),onClick:confirm},(challenge.kind==='recovery'?L.recovery:L.use)+(clock<challenge.readyAt?' · '+Math.ceil((challenge.readyAt-clock)/1000)+'s':''))):null,
          h('details',{onToggle:e=>setReports(e.currentTarget.open)},h('summary',null,L.history+' / '+L.profile),showReports()),
          h('h3',null,L.forecast),p?h(React.Fragment,null,checkbox('forecastEnabled',L.enableForecast),checkbox('autoQuotaRetry',L.retry),
          h('label',{className:'cn-extra-row'},L.alerts,h('select',{value:p.quotaAlerts,disabled:busy||prefs.value?.ownerManaged,onChange:e=>void change({quotaAlerts:e.target.value})},...['off','important','early','custom'].map(x=>h('option',{key:x,value:x},L[x])))),
          p.quotaAlerts==='custom'?h('form',{className:'cn-extra-row',onSubmit:e=>{e.preventDefault();const form=new FormData(e.currentTarget);void change({shortWarningThreshold:Number(form.get('short')),longWarningThreshold:Number(form.get('long'))});}},h('label',null,L.short,h('input',{name:'short',type:'number',required:true,min:1,max:100,defaultValue:p.shortWarningThreshold})),h('label',null,L.long,h('input',{name:'long',type:'number',required:true,min:1,max:100,defaultValue:p.longWarningThreshold})),h('button',{type:'submit',disabled:busy||prefs.value?.ownerManaged},L.save)):null,
          h('button',{type:'button',disabled:busy||prefs.value?.ownerManaged,onClick:()=>setClear(true)},L.clear)):h('p',null,L.unknown),
          clear?h(Modal,{title:L.clear,close:()=>setClear(false),label:L.close},h('p',null,L.askClear),h('button',{type:'button',disabled:busy,onClick:()=>void action('clearQuotaForecast',{acknowledged:true},()=>{setClear(false);void forecastStore.refresh();})},L.clear)):null,
          p?.forecastEnabled?h('div',null,h('p',null,stateText(forecast)??(forecastData?.persistenceFailed?L.issue+' · '+L.forecast:L.rates+' · '+L.approximate)),...(forecastData?.rows??[]).map(r=>{
             const duration=Number.isFinite(r.windowSeconds)?Math.round(r.windowSeconds/360)/10+' h':L.unknown;
             const pace=r.estimate?.pacePerHour;
             const exhaustion=dateMilliseconds(r.exhaustionFrom)&&dateMilliseconds(r.exhaustionTo)?date(r.exhaustionFrom)+' – '+date(r.exhaustionTo):date(r.exhaustionAt);
             const survives=r.estimate?.survivesReset;
             const estimate=r.estimate?.status==='ready' ? `${Number.isFinite(pace)?pace.toLocaleString(t('localeCode'),{maximumFractionDigits:2})+'%/h':L.unknown} · ${exhaustion} · ${L.survives}: ${survives==='yes'||survives==='no'?L[survives]:L.calibrating}` : L.calibrating;
             return h('p',{key:r.limitId+':'+r.windowSeconds},r.limitId+' · '+duration+' · '+estimate,dateMilliseconds(r.lastObservedAt)?' · '+L.checked+' '+date(r.lastObservedAt):'');
           })):null);
      }
      ctx.slots.inject('settings.section', () => ctx.slots.register({name:'settings.section',id:'codex-native-quota',order:92,locale:NS,label:()=>words().quota},QuotaSettings));
      ctx.slots.inject('conversation.input.right', () => ctx.slots.register({name:'conversation.input.right',id:'codex-native-cloud',order:2,locale:NS,inject:sessionId=>({sessionId,directory:ctx.modelDirectories.directoryFor(sessionId)})},CloudControl));
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'codex-native', order: 91, label: () => t('title'), locale: NS }, Settings));
      ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right', id: 'codex-native-speed', order: 1, locale: NS,
        inject: sessionId => ({ sessionId, directory: ctx.modelDirectories.directoryFor(sessionId) }),
      }, Speed));
      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({ name: 'conversation.composer.dock', id: 'codex-native-usage', order: 10, locale: NS,
        inject: sessionId => ({ sessionId, directory: ctx.modelDirectories.directoryFor(sessionId) }),
      }, Usage));

    },
  };
}

return createPlugin(require('react'), require('react-dom'));
}});
