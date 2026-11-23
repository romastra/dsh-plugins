window.__ModuleLoader__.load({
  id: '@local/sound-notifications',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'sound-notifications';
    const DEFAULTS = { approvalEnabled: true, completionEnabled: true, volume: 50, approvalCount: 5, intervalSeconds: 10, repeatPauseMinutes: 5, repeatCount: 2, completionCount: 4, completionIntervalSeconds: 0.5, requestSound: '', questionSound: '', completionSound: '' };
    const DICTS = {
      en: { title: 'Sound notifications', description: 'Notifications for approvals, answer selectors and end of work: the built-in bell or three custom audio files. Auto Review stays silent.', approval: 'Approval requests and answer selectors', completion: 'Successful completion', deliveryConnecting: 'Connecting completion notifications…', deliveryReady: 'Completion notifications connected', deliveryRetry: 'Completion notifications disconnected; retrying. Sound previews do not test this channel.', completionCount: 'Completion signals', completionInterval: 'Completion interval (seconds)', completionHint: 'Victory only after a successful stop, a completed or absent Goal, and no open current-turn ToDos. Otherwise the question sound repeats until acknowledged. Automatic continuation rounds stay silent. The interval is measured between signal starts: 4 signals at 0.5 seconds sound at 0, 0.5, 1 and 1.5 seconds.', testCompletion: 'Test completion sequence', volume: 'Volume (%)', count: 'Signals per reminder series', interval: 'Pause within a series (seconds)', repeatPause: 'Pause between series (minutes)', repeatCount: 'Additional series (0 = none)', hint: 'The first series starts immediately. The long pause starts after its last signal. Additional series: 2 means 3 series in total. Answering or any click/key inside that chat stops its current notification; sidebar chat-list clicks do not. New events can notify again. Preferences are saved for this profile.', test: 'Test access sound', testQuestion: 'Test question sound', requestSound: 'Sound for approval and access requests', questionSound: 'Sound for questions and work needing attention', completionSound: 'Victory sound for successful completion', builtinSound: 'Built-in crystal bell', useBuiltin: 'Use built-in bell', audioHint: 'Choose separate files for access requests, questions and completion, then Save. Access requests and questions share volume, repetition counts and timing. A copy is stored in DSH and survives restart or moving the original. WAV, MP3, OGG, M4A, AAC, FLAC or WebM if decodable here; up to 10 MiB and 30 seconds. Each signal restarts its file; a short interval truncates a longer clip.', audioSize: 'Choose a nonempty audio file up to 10 MiB.', audioDuration: 'Audio must be no longer than 30 seconds.', audioInvalid: 'Could not load this audio. Choose another supported file.', audioFallback: 'The custom sound is unavailable; notifications use the built-in bell.', enable: 'Enable notification sound', locked: 'Your browser is blocking autoplay. An ordinary click or key press on the page enables sound.', ready: 'Sound is ready', unsupported: 'Audio is not supported by this browser.', failed: 'Sound could not play. Check browser audio permissions and whether this tab is muted.', saveError: 'Could not save. Try again.', save: 'Save', saved: 'Saved', loading: 'Loading settings…', reset: 'Restore defaults' },
      ru: { title: 'Звуковые оповещения', description: 'Оповещения для подтверждений, выбора ответа и окончания работы: колокольчик или три разных аудиофайла. Auto Review остаётся беззвучным.', approval: 'Подтверждения и выбор ответа', completion: 'Успешное завершение работы', deliveryConnecting: 'Подключаю оповещения об окончании работы…', deliveryReady: 'Оповещения об окончании работы подключены', deliveryRetry: 'Канал окончания работы недоступен; повторяю подключение. Проверка звука не проверяет этот канал.', completionCount: 'Сигналов при завершении задачи', completionInterval: 'Интервал сигналов завершения (секунды)', completionHint: 'Победный звук: работа завершилась успешно, Goal выполнен или не задан, открытых ToDo текущего хода нет. Иначе — повторы звука вопросов до подтверждения внимания. Промежуточные автоматические раунды беззвучны. Интервал — между началами сигналов: 4 сигнала с интервалом 0,5 с прозвучат в 0, 0,5, 1 и 1,5 с.', testCompletion: 'Проверить завершение', volume: 'Громкость (%)', count: 'Сигналов в одной серии', interval: 'Пауза внутри серии (секунды)', repeatPause: 'Пауза между сериями (минуты)', repeatCount: 'Дополнительных серий (0 = нет)', hint: 'Первая серия начинается сразу. Длинная пауза отсчитывается от её последнего сигнала. 2 дополнительные серии = 3 серии всего. Ответ или любой клик/клавиша внутри этого чата снимают текущее оповещение; клик в списке чатов — нет. Новые события снова могут звучать. Настройки сохраняются в этом профиле.', test: 'Проверить доступ', testQuestion: 'Проверить вопрос', requestSound: 'Звук запросов доступа и подтверждений', questionSound: 'Звук вопросов и остановки, требующей внимания', completionSound: 'Победный звук успешного завершения', builtinSound: 'Встроенный стеклянный колокольчик', useBuiltin: 'Встроенный звук', audioHint: 'Выберите файлы для доступа, вопросов и завершения, затем нажмите «Сохранить». Громкость, число повторов и интервалы у доступа и вопросов общие. Копии хранятся в DSH и сохраняются после перезапуска или переноса оригинала. WAV, MP3, OGG, M4A, AAC, FLAC или WebM, если формат поддерживается; до 10 МиБ и 30 секунд. Каждый сигнал запускает файл заново; короткий интервал обрезает длинную запись.', audioSize: 'Выберите непустой аудиофайл размером до 10 МиБ.', audioDuration: 'Длительность звука не должна превышать 30 секунд.', audioInvalid: 'Не удалось загрузить этот звук. Выберите другой поддерживаемый аудиофайл.', audioFallback: 'Пользовательский звук недоступен; оповещения используют встроенный колокольчик.', enable: 'Включить звук оповещений', locked: 'Браузер блокирует автозвук. Обычный клик или нажатие клавиши на странице включит его.', ready: 'Звук готов', unsupported: 'Этот браузер не поддерживает воспроизведение звука.', failed: 'Не удалось воспроизвести звук. Проверьте разрешения браузера и не отключён ли звук вкладки.', saveError: 'Не удалось сохранить. Повторите попытку.', save: 'Сохранить', saved: 'Сохранено', loading: 'Загружаю настройки…', reset: 'По умолчанию' },
      zh: { title: '声音通知', description: '为手动审批、等待回答的选项卡和已完成任务播放柔和铃声。自动审核保持静音。', approval: '审批请求与回答选项', completion: '成功完成工作', deliveryConnecting: '正在连接工作结束通知…', deliveryReady: '工作结束通知已连接', deliveryRetry: '工作结束通知已断开，正在重试。声音预览不会测试此连接。', completionCount: '完成铃声次数', completionInterval: '完成铃声间隔（秒）', completionHint: '仅工作成功停止、目标完成或未设置且当前轮无未完成待办时播放成功声音。其他停止使用提问提醒，直到确认关注。自动继续轮次保持静音。间隔从每声的开始计算：4 声、0.5 秒间隔将在 0、0.5、1 和 1.5 秒播放。', testCompletion: '测试完成铃声序列', volume: '音量（%）', count: '每组审批铃声次数', interval: '组内间隔（秒）', repeatPause: '组间暂停（分钟）', repeatCount: '额外组数（0 = 不重复）', hint: '第一组立即开始。长暂停从每组最后一声起计算。2 个额外组表示总共 3 组。回答或聊天内任意点击/按键可停止当前通知；侧栏会话列表点击不会。新事件可再次提醒。设置保存在当前配置中。', test: '测试审批声音', testQuestion: '测试提问声音', requestSound: '审批与访问请求声音', questionSound: '用户提问与计划审核声音', completionSound: '工作结束声音', builtinSound: '内置水晶铃声', useBuiltin: '使用内置铃声', audioHint: '分别选择访问请求、提问和完成声音后保存。访问请求和提问共用音量、重复次数及间隔。DSH 保存副本，重启或移动原文件不会丢失。支持可解码的 WAV、MP3、OGG、M4A、AAC、FLAC 或 WebM；最大 10 MiB、30 秒。每声重新播放文件；短间隔会截断较长音频。', audioSize: '请选择不超过 10 MiB 的非空音频。', audioDuration: '音频不能超过 30 秒。', audioInvalid: '无法加载音频，请选择其他支持的文件。', audioFallback: '自定义声音不可用，通知使用内置铃声。', enable: '启用通知声音', locked: '浏览器阻止自动播放。在页面正常点击或按键即可启用声音。', ready: '声音已就绪', unsupported: '此浏览器不支持音频。', failed: '无法播放声音。请检查浏览器权限和标签页静音设置。', saveError: '保存失败，请重试。', save: '保存', saved: '已保存', loading: '正在加载设置…', reset: '恢复默认值' },
    };

    // The authenticated RPC carrier works for HTTP and Desktop IPC alike.
    // Tokens name one observed interaction, never a whole chat or future turn.
    function attentionToken(sessionId, kind, value) { return JSON.stringify([sessionId, kind, String(value)]); }
    function validAttentionToken(sessionId, token) {
      if (typeof sessionId !== 'string' || !sessionId.length || sessionId.length > 256 || typeof token !== 'string' || token.length > 2048) return false;
      try {
        const tuple = JSON.parse(token);
        return Array.isArray(tuple) && tuple.length === 3 && tuple[0] === sessionId && ['approval', 'question', 'plan-review', 'terminal'].includes(tuple[1]) && typeof tuple[2] === 'string' && tuple[2].length > 0 && JSON.stringify(tuple) === token;
      } catch { return false; }
    }
    function validSharedState(state) {
      return Number.isSafeInteger(state?.revision) && state.revision >= 0 && Array.isArray(state.acknowledged) && state.acknowledged.every(row => Array.isArray(row?.tokens) && typeof row.sessionId === 'string' && row.tokens.every(token => validAttentionToken(row.sessionId, token))) && Array.isArray(state.terminals) && state.terminals.every(event => event?.type === 'completed' && typeof event.id === 'string' && event.id.length > 0 && typeof event.sessionId === 'string' && event.sessionId.length > 0);
    }
    function createCompletionReceiver({ call, completed, clear = () => {}, reset = () => {}, sharedState = () => {}, ready = () => {}, suspend = () => {}, audio = () => 'locked', onStatus = () => {}, later = setTimeout, cancel = clearTimeout }) {
      const clientId = Date.now() + ':' + Math.random().toString(36).slice(2);
      const acknowledgements = new Map();
      let controller;
      let generation;
      let cursor;
      let received;
      let state;
      let acknowledgementPump;
      let watchReady = false;
      let acknowledgementFailed = false;
      function publishStatus() { onStatus(watchReady && !acknowledgementFailed ? 'deliveryReady' : 'deliveryRetry'); }
      function pause(signal, ms) {
        return new Promise(resolve => {
          let timer;
          function done() { if (timer !== undefined) cancel(timer); signal.removeEventListener('abort', done); resolve(); }
          signal.addEventListener('abort', done, { once: true });
          if (signal.aborted) done(); else timer = later(done, ms);
        });
      }
      function responseValue(response, acknowledgement = false) {
        if (!response?.ok) throw new Error(response?.error?.message ?? 'Completion channel refused');
        const data = response.value;
        if (typeof data?.generation !== 'string' || !Number.isSafeInteger(data.cursor) || data.cursor < 0 || !Array.isArray(data.events)) throw new Error('Invalid completion response');
        if ((data.protocol === 2 || acknowledgement) && (data.protocol !== 2 || !validSharedState(data.state))) throw new Error('Shared acknowledgements require protocol 2');
        return data;
      }
      function acceptState(data, baseline = false) {
        // ACKs must NEVER advance the watch cursor or replace its generation.
        // An older parallel response cannot restore cleared or superseded work.
        if (data.protocol !== 2 || data.generation !== generation || (state && data.state.revision < state.revision)) return;
        state = data.state;
        sharedState(state, { generation, baseline });
      }
      function currentTerminal(event) {
        return state?.terminals.some(row => row.sessionId === event.sessionId && row.id === event.id) && !state.acknowledged.some(row => row.sessionId === event.sessionId && row.tokens.includes(attentionToken(event.sessionId, 'terminal', event.id)));
      }
      async function run(signal) {
        let delay = 500;
        while (!signal.aborted) {
          try {
            const data = responseValue(await call({ protocol: 2, clientId, ...(generation === undefined ? {} : { generation, cursor }), ...(received === undefined ? {} : { received }), audio: audio() }, signal));
            if (signal.aborted) break;
            const continuing = generation === data.generation;
            if (!continuing) {
              suspend();
              if (generation !== undefined) reset();
              state = undefined;
            }
            generation = data.generation; cursor = data.cursor;
            acceptState(data, !continuing);
            // Reconcile baseline before enabling pending-card playback.
            ready(); watchReady = true; publishStatus(); delay = 500;
            if (continuing) for (const event of data.events) {
              if (event.type === 'clear-attention' && typeof event.sessionId === 'string') { if (data.protocol !== 2) clear(event.sessionId); continue; }
              if (event.type !== 'completed' || typeof event.id !== 'string') continue;
              if (data.protocol === 2 && !currentTerminal(event)) continue;
              completed(event.id, event); received = event.id;
            }
          } catch (error) {
            if (signal.aborted) break;
            suspend(); watchReady = false; publishStatus();
            console.warn('sound-notifications: completion delivery retry:', error.message);
            await pause(signal, delay); delay = Math.min(10000, delay * 2);
          }
        }
      }
      async function flushAcknowledgements(signal) {
        let delay = 500;
        while (!signal.aborted && acknowledgements.size) {
          const [sessionId, queued] = acknowledgements.entries().next().value;
          const tokens = [...queued].slice(0, 256);
          try {
            const data = responseValue(await call({ action: 'acknowledge', protocol: 2, clientId, sessionId, tokens }, signal), true);
            if (signal.aborted) break;
            acceptState(data);
            for (const token of tokens) queued.delete(token);
            if (!queued.size) acknowledgements.delete(sessionId);
            acknowledgementFailed = false; if (watchReady) publishStatus(); delay = 500;
          } catch (error) {
            if (signal.aborted) break;
            acknowledgementFailed = true; publishStatus();
            console.warn('sound-notifications: acknowledgement retry:', error.message);
            await pause(signal, delay); delay = Math.min(10000, delay * 2);
          }
        }
      }
      function sendAcknowledgements() {
        const signal = controller?.signal;
        if (!signal || signal.aborted || acknowledgementPump === signal || !acknowledgements.size) return;
        acknowledgementPump = signal;
        void flushAcknowledgements(signal).finally(() => { if (acknowledgementPump === signal) acknowledgementPump = undefined; if (controller?.signal === signal && !signal.aborted) sendAcknowledgements(); });
      }
      return {
        acknowledge(sessionId, tokens) {
          const exact = [...new Set(Array.isArray(tokens) ? tokens : [])].filter(token => validAttentionToken(sessionId, token));
          if (!exact.length) return;
          let queued = acknowledgements.get(sessionId);
          if (!queued) acknowledgements.set(sessionId, queued = new Set());
          for (const token of exact) queued.add(token);
          sendAcknowledgements();
        },
        start() { if (controller) return; controller = new AbortController(); suspend(); watchReady = false; onStatus('deliveryConnecting'); void run(controller.signal); sendAcknowledgements(); },
        stop() { controller?.abort(); controller = undefined; },
      };
    }

    // One timer observes the winning pending interaction in each session.
    // Approval availability is a getter; question availability is an observable
    // snapshot and may change without replacing the root session-status object.
    // Never answer, dismiss or modify an interaction just to observe it.
    function supportedInteraction(request) {
      return request?.kind === 'approval' || ((request?.kind === 'question' || request?.kind === 'plan-review') && request.review === undefined && typeof request.getSnapshot === 'function' && typeof request.subscribe === 'function');
    }
    function awaitingInteraction(request) {
      if (request.kind === 'attention') return true;
      if (request.kind === 'approval') return request.answerable === true;
      const snapshot = request.getSnapshot();
      return snapshot?.closed === false && (snapshot.channel === 'waterfall' || snapshot.channel === 'rpc');
    }
    // Completion and its preview share the exact same cancellable sequence.
    // Each callback emits at most one signal: throttled timers never catch up
    // with an audible burst. Blocked completion audio is not replayed later.
    function createSignalSequence({ play, later = setTimeout, cancel = clearTimeout }) {
      let timer;
      let disposed = false;
      function stop() { if (timer !== undefined) cancel(timer); timer = undefined; }
      return {
        stop,
        dispose() { disposed = true; stop(); },
        start({ count, intervalSeconds, volume, sound = '', kind = 'completion', sessionId, onComplete }) {
          stop();
          if (disposed) return;
          let remaining = count;
          function emit() {
            timer = undefined;
            if (remaining <= 0 || !play(volume, undefined, kind, sound, sessionId)) { onComplete?.(); return; }
            remaining--;
            if (remaining > 0) timer = later(emit, intervalSeconds * 1000);
            else if (onComplete) timer = later(() => { timer = undefined; onComplete(); }, intervalSeconds * 1000);
          }
          emit();
        },
      };
    }
    // Completed budgets remain remembered when another pending interaction
    // temporarily obscures a card or a named request is replayed on reconnect.
    function createNotifier({ play, stop = () => {}, clock = () => Date.now(), later = setTimeout, cancel = clearTimeout, playbackReady = true }) {
      let settings = { ...DEFAULTS, approvalEnabled: false, completionEnabled: false };
      const pending = new Map();
      const attention = new Map();
      const terminals = new Map();
      const acknowledged = new Map();
      let sounding = new Map();
      const subscriptions = new Map();
      const budgets = new Map();
      const completions = new Set();
      const completionSequence = createSignalSequence({ play, later, cancel });
      const completionQueue = [];
      const completionAttention = new Map();
      const reminderEligible = new Set();
      const attentionListeners = new Set();
      const readonlySnapshot = entries => {
        const map = new Map(entries);
        for (const method of ['set', 'delete', 'clear']) Object.defineProperty(map, method, { value() { throw new TypeError('Attention snapshots are read-only'); } });
        return Object.freeze(map);
      };
      let attentionSnapshot = readonlySnapshot([]);
      const attentionSource = Object.freeze({
        getSnapshot: () => attentionSnapshot,
        subscribe(fn) { if (disposed) return () => {}; attentionListeners.add(fn); return () => attentionListeners.delete(fn); },
      });
      // Pure observation: reading the bridge never unlocks audio or spends a budget.
      function publishAttention() {
        const next = new Map();
        if (!disposed) {
          for (const sessionId of completionAttention.keys()) next.set(sessionId, { kind: 'completion', reminderActive: Boolean(settings.completionEnabled && settings.volume > 0 && [activeCompletion, ...completionQueue].some(row => row?.sessionId === sessionId)) });
          // A live interaction takes precedence over an older terminal notice.
          for (const [sessionId, request] of [...attention, ...pending]) {
            const id = identity(sessionId, request);
            if (awaitingInteraction(request) && !acknowledged.has(id)) next.set(sessionId, { kind: request.kind, reminderActive: reminderEligible.has(id), ...(request.reason === 'error' ? { reason: 'error' } : {}) });
          }
        }
        if (next.size === attentionSnapshot.size && [...next].every(([id, row]) => attentionSnapshot.get(id)?.kind === row.kind && attentionSnapshot.get(id)?.reminderActive === row.reminderActive && attentionSnapshot.get(id)?.reason === row.reason)) return;
        attentionSnapshot = readonlySnapshot([...next].map(([id, row]) => [id, Object.freeze(row)]));
        for (const listener of [...attentionListeners]) listener();
      }
      let completionActive = false;
      let activeCompletion;
      function isCurrentCompletion(id, event = {}) {
        return !disposed && terminals.get(event.sessionId)?.id === id && !acknowledged.has(attentionToken(event.sessionId, 'terminal', id));
      }
      function nextCompletion() {
        if (!playbackReady) { completionActive = false; activeCompletion = undefined; publishAttention(); return; }
        let next;
        do { next = completionQueue.shift(); } while (next && next.token && !isCurrentCompletion(next.id, next));
        completionActive = next !== undefined; activeCompletion = next;
        if (next) completionSequence.start({ ...next, onComplete: nextCompletion });
        publishAttention();
      }
      function resumeCompletions() { if (playbackReady && !completionActive && completionQueue.length) nextCompletion(); }
      function stopCompletions() {
        completionSequence.stop(); completionQueue.length = 0; completionActive = false;
        if (activeCompletion) stop('completion', activeCompletion.sessionId);
        activeCompletion = undefined;
      }
      // Remove only terminal tokens that match. Defer advancing the queue until
      // the complete snapshot/ACK transaction is applied, so stale rows cannot ring.
      function removeTerminals(sessionId, tokens) {
        const matches = id => !tokens || tokens.has(attentionToken(sessionId, 'terminal', id));
        if (terminals.has(sessionId) && matches(terminals.get(sessionId).id)) terminals.delete(sessionId);
        if (attention.has(sessionId) && matches(attention.get(sessionId).key)) attention.delete(sessionId);
        let stopCompletion = false;
        if (completionAttention.has(sessionId) && matches(completionAttention.get(sessionId))) { completionAttention.delete(sessionId); stopCompletion = true; }
        for (let i = completionQueue.length - 1; i >= 0; i--) if (completionQueue[i].sessionId === sessionId && matches(completionQueue[i].id)) completionQueue.splice(i, 1);
        if (activeCompletion?.sessionId === sessionId && matches(activeCompletion.id)) {
          completionSequence.stop(); completionActive = false; activeCompletion = undefined; stopCompletion = true;
        }
        if (stopCompletion) stop('completion', sessionId);
      }
      function observeCompletion(id, event = {}) {
        if (disposed || completions.has(id) || !event.sessionId || acknowledged.has(attentionToken(event.sessionId, 'terminal', id))) return false;
        if (terminals.get(event.sessionId)?.id === id) return true;
        removeTerminals(event.sessionId);
        terminals.set(event.sessionId, { ...event, id });
        // Observed/preparing and baseline terminals are read-only until a live
        // completion explicitly enables playback after its audio preparation.
        if (event.outcome === 'attention') attention.set(event.sessionId, { kind: 'attention', key: id, silent: true, ...(event.reason === 'error' ? { reason: 'error' } : {}) });
        else { completionAttention.set(event.sessionId, id); trim(completionAttention, 1000); }
        resumeCompletions(); tick();
        return true;
      }
      function getAcknowledgementTokens(sessionId) {
        if (!sessionId || disposed) return [];
        const tokens = new Set();
        const request = pending.get(sessionId);
        if (request && awaitingInteraction(request)) tokens.add(identity(sessionId, request));
        const terminal = terminals.get(sessionId);
        if (terminal) tokens.add(attentionToken(sessionId, 'terminal', terminal.id));
        for (const row of [activeCompletion, ...completionQueue]) if (row?.sessionId === sessionId && row.token) tokens.add(row.token);
        return [...tokens].filter(token => !acknowledged.has(token));
      }
      function applyAcknowledgementTokens(sessionId, tokens) {
        const exact = new Set((Array.isArray(tokens) ? tokens : []).filter(token => validAttentionToken(sessionId, token)));
        for (const token of exact) acknowledged.set(token, true);
        removeTerminals(sessionId, exact);
      }
      function acknowledgeTokens(sessionId, tokens) {
        if (disposed || !sessionId) return;
        applyAcknowledgementTokens(sessionId, tokens);
        resumeCompletions(); tick();
      }
      function reconcileSharedState(state) {
        if (disposed || !validSharedState(state)) return;
        // Keep optimistic local tombstones while their RPC is queued. Shared
        // snapshots add confirmations, never resurrect locally acknowledged work.
        for (const row of state.acknowledged) applyAcknowledgementTokens(row.sessionId, row.tokens);
        const next = new Map(state.terminals.map(event => [event.sessionId, event]));
        for (const [sessionId, event] of terminals) {
          const current = next.get(sessionId);
          if (current?.id !== event.id || acknowledged.has(attentionToken(sessionId, 'terminal', event.id))) removeTerminals(sessionId);
        }
        for (const [sessionId, event] of next) {
          if (terminals.get(sessionId)?.id === event.id || acknowledged.has(attentionToken(sessionId, 'terminal', event.id))) continue;
          terminals.set(sessionId, { ...event });
          if (event.outcome === 'attention') attention.set(sessionId, { kind: 'attention', key: event.id, silent: true, ...(event.reason === 'error' ? { reason: 'error' } : {}) });
          else completionAttention.set(sessionId, event.id);
        }
        resumeCompletions(); tick();
      }
      let timer;
      let disposed = false;
      function trim(map, limit) { while (map.size > limit) map.delete(map.keys().next().value); }
      function identity(sessionId, request) { return attentionToken(sessionId, request.kind === 'attention' ? 'terminal' : request.kind, request.callId ?? request.key); }
      function tick() {
        if (timer !== undefined) cancel(timer);
        timer = undefined;
        const previous = sounding; sounding = new Map(); reminderEligible.clear();
        if (disposed || !playbackReady || !settings.approvalEnabled || settings.volume === 0) { for (const {kind, sessionId} of previous.values()) stop(kind, sessionId); publishAttention(); return; }
        let delay = Infinity;
        for (const [sessionId, request] of [...pending, ...attention]) {
          if (!awaitingInteraction(request) || request.silent) continue;
          const kind = request.kind === 'approval' ? 'request' : 'question';
          const sound = kind === 'request' ? settings.requestSound : settings.questionSound;
          const id = identity(sessionId, request);
          if (acknowledged.has(id)) continue;
          sounding.set(kind + ':' + sessionId, {kind, sessionId});
          let budget = budgets.get(id);
          if (!budget) { budget = { series: 0, count: 0, last: -Infinity }; budgets.set(id, budget); trim(budgets, 1000); }
          // Repeat pauses start after the last signal, not the first.
          const nextAt = () => {
            if (budget.series > settings.repeatCount) return Infinity;
            if (budget.count < settings.approvalCount) return budget.last + settings.intervalSeconds * 1000;
            if (budget.series >= settings.repeatCount) return Infinity;
            return budget.last + settings.repeatPauseMinutes * 60000;
          };
          const due = nextAt();
          if (due <= clock()) {
            const startsSeries = budget.count >= settings.approvalCount;
            if (play(settings.volume, id + ':' + (budget.series + Number(startsSeries)) + ':' + (startsSeries ? 0 : budget.count), kind, sound, sessionId)) {
              if (startsSeries) { budget.series++; budget.count = 0; }
              budget.count++; budget.last = clock();
            } else continue; // A gesture, not polling, retries blocked audio.
          }
          // A sleeping page never catches up with an audible burst.
          const next = nextAt();
          if (Number.isFinite(next)) { reminderEligible.add(id); delay = Math.min(delay, Math.max(1, next - clock())); }
        }
        for (const [key, {kind, sessionId}] of previous) if (!sounding.has(key)) stop(kind, sessionId);
        if (Number.isFinite(delay)) timer = later(tick, delay);
        publishAttention();
      }
      return {
        attentionSource, observeCompletion, isCurrentCompletion,
        getAcknowledgementTokens, acknowledgeTokens, reconcileSharedState,
        setPlaybackReady(value) { playbackReady = Boolean(value); resumeCompletions(); tick(); },
        updateSettings(value) {
          settings = { ...DEFAULTS, ...value };
          if (!settings.completionEnabled || settings.volume === 0) stopCompletions();
          tick();
        },
        updatePending(status) {
          if (disposed) return;
          const next = new Map();
          for (const [id, value] of status) {
            const request = value.pendingInteraction;
            if (supportedInteraction(request)) next.set(id, request);
          }
          for (const [id, entry] of subscriptions) {
            if (next.get(id) === entry.request) continue;
            entry.dispose(); subscriptions.delete(id);
          }
          pending.clear();
          for (const [id, request] of next) {
            pending.set(id, request);
            if (request.kind !== 'approval' && !subscriptions.has(id)) subscriptions.set(id, { request, dispose: request.subscribe(tick) });
          }
          tick();
        },
        unlock: tick,
        acknowledge(sessionId) { const tokens = getAcknowledgementTokens(sessionId); acknowledgeTokens(sessionId, tokens); return tokens; },
        clearAttention(sessionId) { removeTerminals(sessionId); resumeCompletions(); tick(); },
        resetTerminalAttention() { terminals.clear(); attention.clear(); completionAttention.clear(); stopCompletions(); tick(); },
        completed(id, event = {}) {
          if (disposed || completions.has(id)) return;
          if (event.sessionId && !observeCompletion(id, event)) return;
          completions.add(id); trim(completions, 500);
          if (event.outcome === 'attention') {
            const request = attention.get(event.sessionId);
            if (request?.key === id) request.silent = false;
            tick(); return;
          }
          if (settings.completionEnabled && settings.volume > 0) {
            completionQueue.push({ id, token: event.sessionId ? attentionToken(event.sessionId, 'terminal', id) : undefined, sessionId: event.sessionId, count: settings.completionCount, intervalSeconds: settings.completionIntervalSeconds, volume: settings.volume, sound: settings.completionSound });
            resumeCompletions();
          }
          publishAttention();
        },
        dispose() {
          disposed = true;
          for (const {kind, sessionId} of sounding.values()) stop(kind, sessionId);
          sounding.clear();
          stopCompletions(); completionSequence.dispose();
          if (timer !== undefined) cancel(timer);
          for (const entry of subscriptions.values()) entry.dispose();
          subscriptions.clear(); pending.clear(); attention.clear(); terminals.clear(); acknowledged.clear(); budgets.clear(); completions.clear(); completionAttention.clear(); reminderEligible.clear();
          publishAttention(); attentionListeners.clear();
        },
      };
    }

    // Crystal chime: consonant, sine-based resonances instead of a metallic
    // strike. Raised-cosine edges have no abrupt slope/click; the very quiet
    // delayed fifth and reflections add a little luminous, futuristic space.
    function synthesizeBell(rate) {
      const duration = 1.8;
      const data = new Float32Array(Math.ceil(rate * duration));
      const fundamental = 1174.6590716696303; // D6 — light, clear, not piercing.
      const modes = [
        [1, 1, 2.8, 0, .024],
        [2, .16, 4.0, 0, .018],
        [3, .025, 5.5, 0, .015],
        [1.5, .075, 3.6, .045, .045],
      ];
      const fade = (position) => .5 - .5 * Math.cos(Math.PI * Math.max(0, Math.min(1, position)));
      const voice = (time) => {
        if (time < 0) return 0;
        return modes.reduce((sum, [ratio, amplitude, decay, delay, attack]) => {
          const local = time - delay;
          if (local <= 0) return sum;
          return sum + amplitude * fade(local / attack) * Math.exp(-decay * local) * Math.sin(2 * Math.PI * fundamental * ratio * local);
        }, 0);
      };
      let peak = 0;
      for (let i = 0; i < data.length; i++) {
        const time = i / rate;
        const tail = fade((duration - time) / .22);
        data[i] = tail * (voice(time) + .065 * voice(time - .083) + .035 * voice(time - .137));
        peak = Math.max(peak, Math.abs(data[i]));
      }
      // More headroom and a gentler reference level; the user's volume setting
      // remains exactly the same gain multiplier (50% = 0.5).
      if (peak > 0) for (let i = 0; i < data.length; i++) data[i] *= .50 / peak;
      return data;
    }

    const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
    function soundName(reference) { try { return JSON.parse(reference).name || ''; } catch { return ''; } }
    function bytesToBase64(bytes) {
      let text = '';
      for (let offset = 0; offset < bytes.length; offset += 32768) text += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      return btoa(text);
    }
    function base64ToBytes(data) { const text = atob(data); return Uint8Array.from(text, char => char.charCodeAt(0)); }
    function createBell(onStatus, { loadSound, onSoundError = () => {} } = {}) {
      let context;
      let buffer;
      let disposed = false;
      let status = 'locked';
      let lastSound = -Infinity;
      let lastKind;
      const custom = new Map();
      const pinned = new Set();
      function trimCustom() {
        for (const key of custom.keys()) { if (custom.size <= 8) break; if (!pinned.has(key)) custom.delete(key); }
      }
      const nodes = new Map();
      const publish = (value) => { if (status !== value) { status = value; onStatus(value); } };
      function getContext() {
        if (disposed) return;
        if (context) return context;
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) { publish('unsupported'); return; }
        context = new AudioContext();
        context.onstatechange = () => publish(context.state === 'running' ? 'ready' : 'locked');
        const rate = context.sampleRate;
        const samples = synthesizeBell(rate);
        buffer = context.createBuffer(1, samples.length, rate);
        buffer.getChannelData(0).set(samples);
        return context;
      }
      async function decodeSound(data) {
        if (disposed) throw new Error('disposed');
        if (!data.byteLength || data.byteLength > MAX_AUDIO_BYTES) throw new Error('audioSize');
        const audio = getContext();
        if (!audio) throw new Error('unsupported');
        const array = ArrayBuffer.isView(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data.slice(0);
        let decoded;
        try { decoded = await audio.decodeAudioData(array); } catch { throw new Error('audioInvalid'); }
        if (!Number.isFinite(decoded.duration) || decoded.duration <= 0) throw new Error('audioInvalid');
        if (decoded.duration > 30) throw new Error('audioDuration');
        if (disposed) throw new Error('disposed');
        return decoded;
      }
      function rememberSound(reference, decoded) {
        if (disposed || !reference) return;
        custom.delete(reference); custom.set(reference, { buffer: decoded, promise: Promise.resolve(decoded) });
        trimCustom();
      }
      async function prepareSound(reference) {
        if (!reference) return;
        const found = custom.get(reference); if (found && !found.failed) return found.promise;
        const entry = { loading: true };
        entry.promise = (async () => {
          if (!loadSound) throw new Error('audioUnavailable');
          const bytes = await loadSound(reference);
          const decoded = await decodeSound(bytes);
          if (!disposed) entry.buffer = decoded;
          return decoded;
        })().catch(error => { entry.failed = true; throw error; }).finally(() => { entry.loading = false; queueMicrotask(() => { if (!disposed && status === 'ready') onStatus('ready'); }); });
        custom.set(reference, entry);
        trimCustom();
        // The caller displays an error; automatic playback keeps the built-in
        // bell as a safe fallback instead of losing the notification.
        return entry.promise;
      }
      function stopKind(kind) {
        if (!context) return;
        for (const [source, entry] of nodes) {
          if (entry.kind !== kind || entry.stopping) continue;
          entry.stopping = true;
          try {
            const now = context.currentTime;
            entry.gain.gain.cancelScheduledValues(now);
            entry.gain.gain.setValueAtTime(entry.gain.gain.value, now);
            entry.gain.gain.linearRampToValueAtTime(0, now + .02);
            source.stop(now + .03);
          } catch {}
        }
      }
      return {
        decodeSound, rememberSound, prepareSound,
        stop: stopKind,
        setReferences(references) { pinned.clear(); for (const reference of references) if (reference) pinned.add(reference); trimCustom(); },
        get status() { return status; },
        async unlock() {
          try {
            const audio = getContext();
            if (!audio) return false;
            // Resume is initiated synchronously within the actual trusted gesture.
            if (audio.state !== 'running') await audio.resume();
            if (disposed) return false;
            publish(audio.state === 'running' ? 'ready' : 'locked');
            return audio.state === 'running';
          } catch { publish('failed'); return false; }
        },
        play(volume, kind = 'request', reference = '') {
          if (disposed || volume <= 0) return false;
          if (!context || context.state !== 'running') { publish('locked'); return false; }
          if (reference && !custom.has(reference)) {
            void prepareSound(reference).catch(() => onSoundError(kind));
            return false;
          }
          if (reference && custom.get(reference)?.loading) return false;
          // Coalesce only simultaneous requests, never the configurable short
          // completion interval (minimum 100ms). Keep ample timer-jitter margin.
          if (kind === lastKind && Date.now() - lastSound < 50) return true;
          try {
            const source = context.createBufferSource();
            const gain = context.createGain();
            gain.gain.value = Math.max(0, Math.min(100, volume)) / 100;
            const selected = reference ? custom.get(reference)?.buffer : undefined;
            if (reference && !selected) onSoundError(kind);
            source.buffer = selected ?? buffer;
            source.connect(gain); gain.connect(context.destination);
            // Fade an earlier chime's quiet tail before retriggering. Short
            // intervals cannot accumulate voices or cut a waveform abruptly.
            stopKind(kind);
            nodes.set(source, { gain, kind });
            source.onended = () => { source.disconnect(); gain.disconnect(); nodes.delete(source); };
            source.start(); lastSound = Date.now(); lastKind = kind; publish('ready'); return true;
          } catch { publish('failed'); return false; }
        },
        dispose() {
          disposed = true;
          for (const source of nodes.keys()) { try { source.stop(); } catch {} }
          nodes.clear(); custom.clear();
          if (context) { context.onstatechange = null; void context.close().catch(() => {}); }
        },
      };
    }

    function BellIcon({ size = 20 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: 'M5 17h14c-2-3-2-5-2-9a5 5 0 0 0-10 0c0 4 0 6-2 9Zm5 4h4M12 1v2' }));
    }
    const CSS = `
.dsh-bell-settings{color:var(--dsw-alias-label-primary);font:inherit;display:flex;flex-direction:column;gap:16px;min-width:0}
.dsh-bell-settings h3{font-size:16px;line-height:24px;font-weight:500;margin:0}
.dsh-bell-description{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);margin:0}
.dsh-bell-row{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:34px;font-size:14px;line-height:22px}
.dsh-bell-settings input[type=number]{box-sizing:border-box;width:90px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;padding:6px 8px}
.dsh-bell-settings input[type=checkbox]{width:18px;height:18px;accent-color:var(--dsw-alias-brand-primary);flex:none}
.dsh-bell-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.dsh-bell-button{font:inherit;font-size:13px;line-height:20px;cursor:pointer;display:inline-flex;align-items:center;gap:7px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}
.dsh-bell-button:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-bell-button:focus-visible,.dsh-bell-settings input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dsh-bell-button:disabled{opacity:.5;cursor:default}
.dsh-bell-audio{display:flex;flex-direction:column;gap:8px;min-width:0}
.dsh-bell-audio label{display:flex;flex-direction:column;gap:8px;min-width:0}
.dsh-bell-filename{overflow-wrap:anywhere;min-width:0}
.dsh-bell-audio-title{font-size:14px;line-height:22px}
.dsh-bell-audio input[type=file]{font:inherit;font-size:13px;max-width:100%;color:var(--dsw-alias-label-secondary)}
.dsh-bell-audio input[type=file]::file-selector-button{font:inherit;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 10px;margin-right:10px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);cursor:pointer}
.dsh-bell-error{color:var(--dsw-alias-state-error-primary);font-size:13px}
.dsh-bell-dock{display:flex;align-items:center;gap:8px;justify-content:center;padding:4px 8px;font-size:12px;color:var(--dsw-alias-label-secondary);flex-wrap:wrap}
`;
    function Settings({ settingsForm: form, bell, notifier, statusSource, deliverySource, audioSource, audioRpc, t }) {
      const snapshot = React.useSyncExternalStore((fn) => form.subscribe(fn), () => form.getSnapshot());
      const status = React.useSyncExternalStore(statusSource.subscribe, statusSource.getSnapshot);
      const delivery = React.useSyncExternalStore(deliverySource.subscribe, deliverySource.getSnapshot);
      const audioMessage = React.useSyncExternalStore(audioSource.subscribe, audioSource.getSnapshot);
      const [draft, setDraft] = React.useState(() => ({ ...DEFAULTS, ...snapshot.value }));
      const [dirty, setDirty] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [message, setMessage] = React.useState('');
      const [audioError, setAudioError] = React.useState('');
      const mounted = React.useRef(false);
      React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
      const revision = React.useRef(snapshot.revision);
      const preview = React.useRef();
      React.useEffect(() => {
        const sequence = createSignalSequence({ play: (volume, _id, kind, reference) => bell.play(volume, kind, reference) });
        preview.current = sequence;
        return () => { sequence.dispose(); bell.stop('preview-request'); bell.stop('preview-completion'); if (preview.current === sequence) preview.current = undefined; };
      }, [bell]);
      function testSound(key) {
        const sequence = preview.current;
        const completion = key === 'completionSound';
        const reference = draft[key];
        setAudioError('');
        void Promise.all([bell.unlock(), bell.prepareSound(reference)]).then(([ok]) => {
          if (!ok || !sequence || preview.current !== sequence) return;
          sequence.stop(); bell.stop('preview-request'); bell.stop('preview-completion');
          if (completion) sequence.start({ count: draft.completionCount, intervalSeconds: draft.completionIntervalSeconds, volume: draft.volume, sound: reference, kind: 'preview-completion' });
          else bell.play(draft.volume, 'preview-request', reference);
        }).catch(error => { if (mounted.current) setAudioError(error.message === 'audioDuration' ? 'audioDuration' : 'audioInvalid'); });
      }
      React.useEffect(() => { if (!dirty) { setDraft({ ...DEFAULTS, ...snapshot.value }); revision.current = snapshot.revision; } }, [snapshot, dirty]);
      function change(key, value) { setDraft((prev) => ({ ...prev, [key]: value })); setDirty(true); setMessage(''); }
      async function save(value = draft) {
        setBusy(true); setMessage('');
        try {
          const ok = await form.mutate(Object.entries(value).map(([key, value]) => ({ op: 'set', path: [key], value })), revision.current);
          if (!ok) { revision.current = form.getSnapshot().revision; throw new Error('Rejected'); }
          setDraft(value); setDirty(false); setMessage('saved');
        } catch { setMessage('saveError'); } finally { setBusy(false); }
      }
      async function selectAudio(key, file) {
        if (!file) return;
        setAudioError(''); setBusy(true);
        try {
          if (!file.size || file.size > MAX_AUDIO_BYTES) throw new Error('audioSize');
          if (!/\.(wav|mp3|ogg|m4a|aac|flac|webm)$/i.test(file.name)) throw new Error('audioInvalid');
          const bytes = new Uint8Array(await file.arrayBuffer());
          const decoded = await bell.decodeSound(bytes);
          const uploaded = await audioRpc({ action: 'upload', name: file.name, data: bytesToBase64(bytes) });
          if (!mounted.current) return;
          bell.rememberSound(uploaded.reference, decoded);
          change(key, uploaded.reference);
        } catch (error) {
          if (mounted.current) setAudioError(['audioSize', 'audioDuration'].includes(error.message) ? error.message : 'audioInvalid');
        } finally { if (mounted.current) setBusy(false); }
      }
      function audioFile(key, label) {
        return h('div', { className: 'dsh-bell-audio', key },
          h('label', null, h('span', { className: 'dsh-bell-audio-title' }, t(label)),
            h('input', { type: 'file', accept: '.wav,.mp3,.ogg,.m4a,.aac,.flac,.webm,audio/*', disabled: busy || !snapshot.writable, onChange: event => { const file = event.target.files?.[0]; event.target.value = ''; void selectAudio(key, file); } })),
          h('div', { className: 'dsh-bell-actions' }, h('span', { className: 'dsh-bell-description dsh-bell-filename' }, soundName(draft[key]) || t('builtinSound')),
            h('button', { type: 'button', className: 'dsh-bell-button', disabled: busy || !valid, onClick: () => testSound(key) }, h(BellIcon, { size: 16 }), t(key === 'completionSound' ? 'testCompletion' : key === 'questionSound' ? 'testQuestion' : 'test')),
            h('button', { type: 'button', className: 'dsh-bell-button', disabled: busy || !draft[key] || !snapshot.writable, onClick: () => change(key, '') }, t('useBuiltin'))));
      }
      function number(key, min, max) {
        return h('label', { className: 'dsh-bell-row', key }, t({ approvalCount: 'count', intervalSeconds: 'interval', repeatPauseMinutes: 'repeatPause', repeatCount: 'repeatCount', completionCount: 'completionCount', completionIntervalSeconds: 'completionInterval', volume: 'volume' }[key]), h('input', { type: 'number', min, max, step: ['volume', 'completionIntervalSeconds'].includes(key) ? 'any' : 1, value: draft[key], disabled: busy, onChange: (event) => change(key, event.target.value === '' ? '' : Number(event.target.value)) }));
      }
      const valid = Number.isFinite(draft.volume) && draft.volume >= 0 && draft.volume <= 100 && Number.isInteger(draft.approvalCount) && draft.approvalCount >= 1 && draft.approvalCount <= 20 && Number.isInteger(draft.intervalSeconds) && draft.intervalSeconds >= 1 && draft.intervalSeconds <= 300 && Number.isInteger(draft.repeatPauseMinutes) && draft.repeatPauseMinutes >= 1 && draft.repeatPauseMinutes <= 1440 && Number.isInteger(draft.repeatCount) && draft.repeatCount >= 0 && draft.repeatCount <= 20 && Number.isInteger(draft.completionCount) && draft.completionCount >= 1 && draft.completionCount <= 20 && Number.isFinite(draft.completionIntervalSeconds) && draft.completionIntervalSeconds >= 0.1 && draft.completionIntervalSeconds <= 10;
      return h('section', { className: 'dsh-bell-settings' }, h('style', null, CSS),
        h('h3', null, t('title')), h('p', { className: 'dsh-bell-description' }, t('description')),
        ...[['approvalEnabled', 'approval'], ['completionEnabled', 'completion']].map(([key, label]) => h('label', { className: 'dsh-bell-row', key }, t(label), h('input', { type: 'checkbox', role: 'switch', 'aria-checked': draft[key], checked: draft[key], disabled: busy, onChange: (event) => change(key, event.target.checked) }))),
        number('volume', 0, 100),
        audioFile('requestSound', 'requestSound'), audioFile('questionSound', 'questionSound'), audioFile('completionSound', 'completionSound'),
        h('p', { className: 'dsh-bell-description' }, t('audioHint')),
        number('approvalCount', 1, 20), number('intervalSeconds', 1, 300),
        number('repeatPauseMinutes', 1, 1440), number('repeatCount', 0, 20),
        h('p', { className: 'dsh-bell-description' }, t('hint')),
        number('completionCount', 1, 20), number('completionIntervalSeconds', 0.1, 10),
        h('p', { className: 'dsh-bell-description' }, t('completionHint')),
        h('div', { className: 'dsh-bell-actions' },
          h('button', { type: 'button', className: 'dsh-bell-button', disabled: busy || !valid || !dirty || !snapshot.writable, onClick: () => void save() }, t('save')),
          h('button', { type: 'button', className: 'dsh-bell-button', disabled: busy || !snapshot.writable, onClick: () => { setDraft({ ...DEFAULTS }); setDirty(true); setMessage(''); } }, t('reset'))),
        h('p', { className: 'dsh-bell-description', role: 'status' }, t(snapshot.status !== 'ready' ? 'loading' : status)),
        h('p', { className: delivery === 'deliveryRetry' ? 'dsh-bell-error' : 'dsh-bell-description', role: 'status' }, t(delivery)),
        (audioError || audioMessage) && h('p', { role: 'alert', className: 'dsh-bell-error' }, t(audioError || audioMessage)),
        message && h('p', { role: 'status', className: message === 'saveError' ? 'dsh-bell-error' : 'dsh-bell-description' }, t(message)));
    }
    // The manager owns the title, breadcrumb and row form. Use our shared
    // namespace controller (under a distinct prop) on both bundle/row pages.
    function PluginSettings(props) {
      if (props.view === 'summary') return props.t('description');
      return h(Settings, props);
    }
    function chatGestureSession(event, selectedSession) {
      if (!event.isTrusted || !['click', 'keydown'].includes(event.type) || !selectedSession) return;
      if (event.type === 'keydown' && (['Control', 'Shift', 'Tab'].includes(event.key) || event.ctrlKey)) return;
      const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
      if (target?.closest?.('[data-chat-switcher], [data-no-attention-ack]') || event.composedPath?.().some(node => node?.hasAttribute?.('data-chat-switcher') || node?.hasAttribute?.('data-no-attention-ack'))) return;
      const boundary = target?.closest?.('[data-conversation-content][data-conversation-session]');
      const sessionId = boundary?.dataset?.conversationSession;
      return sessionId === selectedSession ? sessionId : undefined;
    }
    function registerAttentionBridge(source, target = window) {
      const changed = () => target.dispatchEvent(new target.CustomEvent('dsh:sound-attention-changed'));
      target.__DSH_SOUND_ATTENTION__ = source;
      changed();
      return () => {
        // A replacement may already own the global during a hot reload.
        if (target.__DSH_SOUND_ATTENTION__ !== source) return;
        delete target.__DSH_SOUND_ATTENTION__;
        changed();
      };
    }
    function Dock({ statusSource, bell, notifier, t }) {
      const status = React.useSyncExternalStore(statusSource.subscribe, statusSource.getSnapshot);
      if (status === 'ready') return null;
      return h('div', { className: 'dsh-bell-dock' }, h('style', null, CSS),
        h('span', null, t(status)), status !== 'unsupported' && h('button', { type: 'button', className: 'dsh-bell-button', onClick: () => { void bell.unlock().then((ok) => { if (ok) notifier.unlock(); }); } }, h(BellIcon, { size: 14 }), t('enable')));
    }

    return {
      inject: ['slots', 'locale', 'configForms', 'uiSession', 'connection'],
      createNotifier,
      registerAttentionBridge,
      createCompletionReceiver,
      createSignalSequence,
      createBell,
      chatGestureSession,
      synthesizeBell,
      apply(ctx) {
        for (const [locale, dict] of Object.entries(DICTS)) ctx.effect(() => ctx.locale.register(NS, locale, dict));
        const form = ctx.configForms.get('sound-notifications');
        const sessionStatusSource = ctx.uiSession?.sessionStatus;
        const selectedSessionSource = ctx.uiSession?.adapter?.current;
        const rpc = ctx.connection?.rpc;
        let status = 'locked';
        const listeners = new Set();
        const statusSource = { getSnapshot: () => status, subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); } };
        let delivery = 'deliveryConnecting';
        const deliveryListeners = new Set();
        const deliverySource = { getSnapshot: () => delivery, subscribe: fn => { deliveryListeners.add(fn); return () => deliveryListeners.delete(fn); } };
        let audioMessage = '';
        const audioListeners = new Set();
        const audioSource = { getSnapshot: () => audioMessage, subscribe: fn => { audioListeners.add(fn); return () => audioListeners.delete(fn); } };
        const audioRpc = async (payload) => {
          const response = await rpc.call('/api', 'sound-notifications/audio', payload);
          if (!response.ok) throw new Error(response.error.message);
          return response.value;
        };
        const publishAudio = value => { audioMessage = value; for (const listener of audioListeners) listener(); };
        let notifier;
        const bell = createBell((value) => {
          status = value;
          for (const listener of listeners) listener();
          // A browser may resume a previously blocked context asynchronously.
          // Defer the retry so it cannot reenter a notifier tick mid-signal.
          if (value === 'ready') queueMicrotask(() => notifier?.unlock());
        }, {
          loadSound: async reference => base64ToBytes((await audioRpc({ action: 'read', reference })).data),
          onSoundError: () => publishAudio('audioFallback'),
        });
        let deliveryEpoch = 0;
        notifier = createNotifier({ playbackReady: false, play: (volume, _id, kind, reference, sessionId) => bell.play(volume, `${kind}:${sessionId ?? ''}`, reference), stop: (kind, sessionId) => bell.stop(`${kind}:${sessionId ?? ''}`) });
        ctx.effect(() => {
          let active = true;
          let sharedReady = false;
          const syncPending = () => { if (active) notifier.updatePending(sessionStatusSource.getSnapshot()); };
          const unregisterAttention = registerAttentionBridge(notifier.attentionSource);
          const activate = () => {
            const snapshot = form.getSnapshot();
            if (!active || snapshot.status !== 'ready' || snapshot.value.volume <= 0 || !(snapshot.value.approvalEnabled || snapshot.value.completionEnabled)) return;
            if (bell.status !== 'ready') void bell.unlock().then((ok) => { if (ok && active) notifier.unlock(); });
          };
          const receiver = createCompletionReceiver({
            call: (payload, signal) => rpc.call('/api', 'sound-notifications/events', payload, signal),
            sharedState: state => notifier.reconcileSharedState(state),
            suspend: () => { sharedReady = false; notifier.setPlaybackReady(false); },
            ready: () => { if (!sharedReady) { sharedReady = true; notifier.setPlaybackReady(true); } },
            completed: (id, event) => {
              if (!notifier.observeCompletion(id, event)) return;
              const receivedEpoch = deliveryEpoch;
              const reference = form.getSnapshot().value?.[event.outcome === 'attention' ? 'questionSound' : 'completionSound'] ?? '';
              void Promise.all([bell.unlock(), bell.prepareSound(reference).catch(() => publishAudio('audioFallback'))]).then(() => { if (active && receivedEpoch === deliveryEpoch && notifier.isCurrentCompletion(id, event)) notifier.completed(id, event); });
            },
            clear: sessionId => notifier.clearAttention(sessionId),
            reset: () => { deliveryEpoch++; notifier.resetTerminalAttention(); },
            audio: () => bell.status,
            onStatus: value => { delivery = value; for (const listener of deliveryListeners) listener(); },
          });
          const acknowledge = sessionId => {
            if (!sessionId) return;
            const tokens = notifier.acknowledge(sessionId);
            if (tokens.length) receiver.acknowledge(sessionId, tokens);
          };
          let soundGeneration = 0;
          const syncSettings = () => {
            const snapshot = form.getSnapshot();
            if (snapshot.status !== 'ready') return;
            const generation = ++soundGeneration;
            const references = [...new Set([snapshot.value.requestSound, snapshot.value.questionSound, snapshot.value.completionSound].filter(Boolean))];
            bell.setReferences(references);
            // Begin all independent loads before enabling request playback. A
            // loading buffer consumes no reminder budget; its settlement wakes
            // the notifier. Neither file delays the other or the delivery channel.
            const loading = references.map(reference => bell.prepareSound(reference));
            notifier.updateSettings(snapshot.value); activate(); receiver.start();
            if (!references.length) { publishAudio(''); return; }
            void Promise.allSettled(loading).then(results => { if (active && generation === soundGeneration) publishAudio(results.some(result => result.status === 'rejected') ? 'audioFallback' : ''); });
          };
          const offSettings = form.subscribe(syncSettings);
          const offPending = sessionStatusSource.subscribe(syncPending);
          syncSettings(); syncPending();
          // Try immediately at startup, on page restore, and on an ordinary
          // trusted interaction. No separate 'enable sound' click is needed
          // where autoplay is allowed; never pretend permission was persisted.
          const gesture = (event) => { if (event.isTrusted) activate(); };
          const chatGesture = event => {
            if (!active) return;
            const selected = selectedSessionSource.getSnapshot().key;
            const sessionId = chatGestureSession(event, selected);
            if (sessionId) acknowledge(sessionId);
          };
          document.addEventListener('click', chatGesture, true);
          document.addEventListener('keydown', chatGesture, true);
          const visible = () => { if (document.visibilityState === 'visible') activate(); };
          document.addEventListener('pointerdown', gesture, { capture: true, passive: true });
          document.addEventListener('keydown', gesture, true);
          document.addEventListener('touchend', gesture, { capture: true, passive: true });
          document.addEventListener('visibilitychange', visible);
          window.addEventListener('pageshow', activate);
          return () => {
            active = false;
            offSettings(); offPending(); receiver.stop(); notifier.dispose(); unregisterAttention(); bell.dispose(); listeners.clear(); deliveryListeners.clear(); audioListeners.clear();
            document.removeEventListener('click', chatGesture, true); document.removeEventListener('keydown', chatGesture, true);
            document.removeEventListener('pointerdown', gesture, true); document.removeEventListener('keydown', gesture, true);
            document.removeEventListener('touchend', gesture, true); document.removeEventListener('visibilitychange', visible);
            window.removeEventListener('pageshow', activate);
          };
        });
        for (const [name, key] of [
          ['plugins.bundle.config', '@local/sound-notifications'],
          ['plugins.row.config', '@local/sound-notifications#sound-notifications'],
        ]) ctx.slots.inject(name, () => ctx.slots.register({
          name, key, locale: NS,
          inject: () => ({ settingsForm: form, bell, notifier, statusSource, deliverySource, audioSource, audioRpc }),
        }, PluginSettings));
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: 'sound-notifications-unlock', order: 95, locale: NS,
          inject: () => ({ bell, notifier, statusSource }),
        }, Dock));
      },
    };
  },
});
