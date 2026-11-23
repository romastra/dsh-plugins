// DSH 0.2.2-rc.3 compatibility: only the public, matched PendingQuestion carrier.
// No Client-package runtime imports, DOM discovery, Host mutations, or question auto-send.
export const QUESTION_DRAFT_PREFIX = 'local-parakeet.question-drafts.v1:';

export function questionRecommended(label) {
  const suffix = /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i;
  return { label: String(label).replace(suffix, ''), recommended: suffix.test(String(label)) };
}

export function questionFingerprint(questions) {
  return JSON.stringify(questions.map(q => ({
    id: q.id, question: q.question, header: q.header, detail: q.detail,
    options: q.options ?? [], multiSelect: q.multiSelect === true,
  })));
}

export function questionStorageKey(pending) {
  return QUESTION_DRAFT_PREFIX + JSON.stringify([pending.sessionId, pending.key]);
}

export function questionInitialProgress(questions) {
  return {
    index: 0,
    drafts: questions.map(q => ({
      selected: (q.multiSelect ? (q.options ?? []) : (q.options ?? []).slice(0, 1))
        .filter(option => questionRecommended(option.label).recommended).map(option => option.label),
      custom: '', skipped: false,
    })),
  };
}

export function questionValidProgress(progress, questions) {
  if (!progress || !Number.isInteger(progress.index) || progress.index < 0 || progress.index >= questions.length ||
      !Array.isArray(progress.drafts) || progress.drafts.length !== questions.length ||
      (progress.wait !== undefined && !['editing', 'waiting'].includes(progress.wait))) return false;
  return progress.drafts.every((draft, index) => {
    if (!draft || !Array.isArray(draft.selected) || typeof draft.custom !== 'string' || typeof draft.skipped !== 'boolean') return false;
    const labels = (questions[index].options ?? []).map(option => option.label);
    if (draft.selected.some(label => typeof label !== 'string' || !labels.includes(label)) ||
        new Set(draft.selected).size !== draft.selected.length) return false;
    if (!questions[index].multiSelect && (draft.selected.length > 1 || (draft.custom !== '' && draft.selected.length > 0))) return false;
    return !draft.skipped || (draft.custom === '' && draft.selected.length === 0);
  });
}

export function questionAnswered(draft) {
  return draft.selected.length > 0 || draft.custom.trim() !== '';
}

export function questionAnswerBatch(questions, progress) {
  if (!questionValidProgress(progress, questions)) throw new Error('Invalid question draft');
  const missing = progress.drafts.findIndex(draft => !draft.skipped && !questionAnswered(draft));
  if (missing >= 0) {
    const error = new Error('Question is incomplete');
    error.code = 'QUESTION_INCOMPLETE';
    error.index = missing;
    throw error;
  }
  return { answers: questions.map((question, index) => {
    const draft = progress.drafts[index];
    if (draft.skipped) return { id: question.id, selected: [] };
    const custom = draft.custom.trim();
    return {
      id: question.id,
      selected: custom === '' || question.multiSelect === true ? [...draft.selected] : [],
      ...(custom === '' ? {} : { custom }),
    };
  }) };
}

export function selectVoiceQuestion(owner) {
  const pending = owner?.pendingInteraction;
  if (!owner?.sessionId || !pending || pending.sessionId !== owner.sessionId || pending.kind !== 'question' ||
      typeof pending.key !== 'string' || pending.review !== undefined || !Array.isArray(pending.questions) || pending.questions.length === 0) return null;
  if (pending.questions.some(q => !q || typeof q.id !== 'string' || typeof q.question !== 'string' || q.intent !== undefined ||
      (q.options !== undefined && (!Array.isArray(q.options) || q.options.some(o => !o || typeof o.label !== 'string'))))) return null;
  if (new Set(pending.questions.map(q => q.id)).size !== pending.questions.length) return null;
  for (const method of ['getSnapshot', 'subscribe', 'answer', 'dismiss', 'holdFocus', 'releaseFocus', 'engage', 'takeTime']) {
    if (typeof pending[method] !== 'function') return null;
  }
  try { return pending.getSnapshot()?.closed === false ? pending : null; } catch { return null; }
}

// Own namespace deliberately does not impersonate dsh.user-questions.drafts.v1.
// Native unsubmitted drafts do not migrate automatically; closing this presentation
// retains its own request-fingerprinted draft and leaves native storage untouched.
export function createQuestionDraftController(pending, { storage } = {}) {
  let progress = questionInitialProgress(pending.questions);
  let phase = 'plain';
  let disposed = false;
  let navigationVersion = 0;
  const revisions = pending.questions.map(() => 0);
  const listeners = new Set();
  const key = questionStorageKey(pending);
  const fingerprint = questionFingerprint(pending.questions);
  try {
    const saved = JSON.parse(storage?.getItem(key) ?? 'null');
    if (saved?.version === 1 && saved.fingerprint === fingerprint && questionValidProgress(saved.progress, pending.questions)) {
      progress = saved.progress;
    }
  } catch { /* Storage is optional; the in-memory draft remains usable. */ }
  let stateSnapshot = { progress, phase };
  const emit = () => {
    stateSnapshot = { progress, phase };
    for (const listener of [...listeners]) listener();
  };
  const persist = () => {
    try { storage?.setItem(key, JSON.stringify({ version: 1, fingerprint, progress })); } catch { /* Memory fallback. */ }
  };
  const live = () => !disposed && pending.getSnapshot()?.closed === false;
  const write = (next, engage = false) => {
    if (!live() || phase !== 'plain' || !questionValidProgress(next, pending.questions)) return false;
    if (engage) {
      pending.engage();
      next = { ...next, wait: progress.wait ?? 'editing' };
    }
    for (let index = 0; index < revisions.length; index += 1) {
      if (next.drafts[index].custom !== progress.drafts[index].custom) revisions[index] += 1;
    }
    if (next.index !== progress.index) navigationVersion += 1;
    progress = next;
    persist();
    emit();
    return true;
  };
  const controller = {
    pending,
    getProgress: () => progress,
    getSnapshot: () => stateSnapshot,
    getPhase: () => phase,
    activate() { if (disposed) { disposed = false; emit(); } },
    revision: index => revisions[index],
    navigationVersion: () => navigationVersion,
    live,
    ready: () => live() && ['waterfall', 'rpc'].includes(pending.getSnapshot().channel),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    resumeWait() {
      if (progress.wait === 'waiting') pending.takeTime();
      else if (progress.wait === 'editing') pending.engage();
    },
    setPhase(next) { if (disposed || phase === next) return; phase = next; emit(); },
    custom(index, text) {
      if (index !== progress.index || typeof text !== 'string') return false;
      const current = progress.drafts[index];
      if (current.custom === text) return live() && phase === 'plain';
      return write({ ...progress, drafts: progress.drafts.map((draft, i) => i === index ? {
        selected: pending.questions[index].multiSelect ? [...draft.selected] : [], custom: text, skipped: false,
      } : draft) }, true);
    },
    choose(label) {
      const index = progress.index;
      const question = pending.questions[index];
      if (!(question.options ?? []).some(option => option.label === label)) return false;
      const current = progress.drafts[index];
      const draft = question.multiSelect ? {
        ...current, skipped: false,
        selected: current.selected.includes(label) ? current.selected.filter(item => item !== label) : [...current.selected, label],
      } : { selected: [label], custom: '', skipped: false };
      return write({ ...progress,
        index: !question.multiSelect && index < pending.questions.length - 1 ? index + 1 : index,
        drafts: progress.drafts.map((item, i) => i === index ? draft : item),
      }, true);
    },
    navigate(index) {
      if (!Number.isInteger(index) || index < 0 || index >= pending.questions.length) return false;
      return write({ ...progress, index });
    },
    skip() {
      const index = progress.index;
      return write({ ...progress,
        index: Math.min(index + 1, pending.questions.length - 1),
        drafts: progress.drafts.map((draft, i) => i === index ? { selected: [], custom: '', skipped: true } : draft),
      }, true);
    },
    takeTime() {
      if (!live()) return;
      pending.takeTime();
      progress = { ...progress, wait: 'waiting' };
      persist(); emit();
    },
    clear() { try { storage?.removeItem(key); } catch { /* Memory remains scoped to this mount. */ } },
    dispose() { disposed = true; emit(); listeners.clear(); },
  };
  return controller;
}

let qvFieldGeneration = 0;
export function createQuestionField(controller, { readSelection, onSubmit, notify } = {}) {
  const index = controller.getProgress().index;
  const navigationVersion = controller.navigationVersion();
  const pending = controller.pending;
  const generation = ++qvFieldGeneration;
  const targetKey = 'local-parakeet:question:' + JSON.stringify([pending.sessionId, pending.key, pending.questions[index].id, generation]);
  let disposed = false;
  let cached;
  const localListeners = new Set();
  const current = () => !disposed && controller.live() && controller.getProgress().index === index && controller.navigationVersion() === navigationVersion;
  const snapshot = () => {
    const draft = controller.getProgress().drafts[index].custom;
    const draftRev = controller.revision(index);
    const phase = current() && controller.ready() ? controller.getPhase() : 'submitting';
    if (!cached || cached.draft !== draft || cached.draftRev !== draftRev || cached.phase !== phase) {
      cached = { draft, draftRev, phase, occurrences: [] };
    }
    return cached;
  };
  const input = {
    targetKind: 'question',
    state: {
      getSnapshot: snapshot,
      subscribe(listener) { localListeners.add(listener); return () => localListeners.delete(listener); },
    },
    submit(...args) { if (current() && controller.getPhase() === 'plain') return onSubmit?.(...args); },
    notify(level, text) { if (current()) notify?.(level, text); },
  };
  const publish = () => { for (const listener of [...localListeners]) listener(); };
  let unsubscribe = controller.subscribe(publish);
  const captureInsertion = () => {
    const state = snapshot();
    if (state.phase !== 'plain') return undefined;
    const selection = readSelection?.();
    const start = Math.max(0, Math.min(state.draft.length, Number.isInteger(selection?.start) ? selection.start : state.draft.length));
    const end = Math.max(start, Math.min(state.draft.length, Number.isInteger(selection?.end) ? selection.end : start));
    return { start, end, draftRev: state.draftRev };
  };
  const actions = {
    captureInsertion,
    setDraft(text) { return current() && snapshot().phase === 'plain' && controller.custom(index, text); },
    insertText(text, span) {
      const state = snapshot();
      if (!current() || state.phase !== 'plain' || typeof text !== 'string' || !span || span.draftRev !== state.draftRev ||
          !Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < 0 || span.end < span.start || span.end > state.draft.length) return false;
      return controller.custom(index, state.draft.slice(0, span.start) + text + state.draft.slice(span.end));
    },
    submit(...args) { return input.submit(...args); },
  };
  return {
    targetKey, input, inputActions: actions,
    resolveInput: id => id === targetKey && current() && controller.ready() && controller.getPhase() === 'plain' ? input : undefined,
    activate() {
      if (!disposed) return;
      disposed = false;
      unsubscribe = controller.subscribe(publish);
      publish();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      for (const listener of [...localListeners]) listener();
      localListeners.clear();
    },
  };
}

const qvCopy = {
  en: { title: 'Questions', other: 'Other / free response', placeholder: 'Type or dictate your answer', next: 'Next', submit: 'Submit answers', skip: 'Skip', prev: 'Previous question', following: 'Next question', close: 'Close questions', minimize: 'Minimize', expand: 'Expand', recommended: 'Recommended', takeTime: 'Take time', paused: 'Paused · {seconds}s', counting: '{seconds}s remaining', held: 'Take your time', continued: 'Agent continued · you can still answer', waiting: 'Connecting answer channel…', incomplete: 'Answer or skip every question before submitting.', unanswered: 'Enter an answer or skip this question.', unavailable: 'The question is no longer ready for an answer.', resubmit: 'The agent continued. Review and submit the answers again.', sent: 'Answers sent; waiting for confirmation…', hint: 'Dictation only edits this answer. Submit answers yourself.', detail: 'Question details', voice: 'Dictate this answer' },
  ru: { title: 'Вопросы', other: 'Другое / свободный ответ', placeholder: 'Введите или надиктуйте ответ', next: 'Далее', submit: 'Отправить ответы', skip: 'Пропустить', prev: 'Предыдущий вопрос', following: 'Следующий вопрос', close: 'Закрыть вопросы', minimize: 'Свернуть', expand: 'Развернуть', recommended: 'Рекомендуется', takeTime: 'Не торопиться', paused: 'Пауза · {seconds} с', counting: 'Осталось {seconds} с', held: 'Можно не торопиться', continued: 'Агент продолжил работу · ответить ещё можно', waiting: 'Подключение канала ответа…', incomplete: 'Ответьте на каждый вопрос или пропустите его.', unanswered: 'Введите ответ или пропустите вопрос.', unavailable: 'Вопрос пока не готов принять ответ или уже закрыт.', resubmit: 'Агент продолжил работу. Проверьте и отправьте ответы ещё раз.', sent: 'Ответы отправлены; ждём подтверждения…', hint: 'Диктовка меняет только этот ответ. Отправка — вручную.', detail: 'Подробности вопроса', voice: 'Надиктовать этот ответ' },
  zh: { title: '问题', other: '其他 / 自由回答', placeholder: '输入或听写回答', next: '下一步', submit: '提交回答', skip: '跳过', prev: '上一题', following: '下一题', close: '关闭问题', minimize: '收起', expand: '展开', recommended: '推荐', takeTime: '慢慢回答', paused: '已暂停 · {seconds} 秒', counting: '剩余 {seconds} 秒', held: '可以慢慢回答', continued: '助手已继续，仍可回答', waiting: '正在连接回答通道…', incomplete: '请回答或跳过每个问题后再提交。', unanswered: '请输入回答或跳过此题。', unavailable: '问题尚未准备好接收回答或已关闭。', resubmit: '助手已继续。请检查并重新提交回答。', sent: '回答已发送，正在等待确认…', hint: '听写只编辑当前回答。请手动提交回答。', detail: '问题详情', voice: '听写此回答' },
};
const qvFallbackLocale = { active: 'en', revision: 0 };
const qvStyle = `
.dsh-lpq-frame{display:flex;justify-content:center;padding:6px calc(var(--dsh-composer-side-clearance,12px) + 16px) 10px;color:var(--dsw-alias-label-primary)}
.dsh-lpq-card{box-sizing:border-box;display:flex;flex-direction:column;width:100%;max-width:var(--dsh-chat-content-width,760px);max-height:min(60vh,520px);border:1px solid var(--dsw-alias-border-l1);border-radius:16px;background:var(--dsw-alias-bg-layer-2);font:inherit;overflow:hidden}
.dsh-lpq-card *{box-sizing:border-box}.dsh-lpq-header,.dsh-lpq-footer{display:flex;align-items:center;gap:8px;padding:12px 16px;flex:none;flex-wrap:wrap}.dsh-lpq-header{border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsh-lpq-heading{font-size:12px;color:var(--dsw-alias-label-secondary);margin-right:auto}.dsh-lpq-body{padding:12px 16px;overflow:auto;min-height:0;display:flex;flex-direction:column;gap:12px}.dsh-lpq-title{font-size:16px;line-height:22px;margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.dsh-lpq-detail{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:20px}
.dsh-lpq-choices{display:flex;flex-direction:column;gap:6px}.dsh-lpq-choice{display:flex;align-items:flex-start;gap:10px;min-height:40px;width:100%;text-align:left;padding:8px 10px}.dsh-lpq-choice[aria-checked=true]{border-color:var(--dsw-alias-brand-primary)}.dsh-lpq-choice-copy{display:flex;flex-direction:column;gap:3px;min-width:0;overflow-wrap:anywhere;white-space:pre-wrap}.dsh-lpq-description,.dsh-lpq-hint,.dsh-lpq-countdown{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}.dsh-lpq-badge{font-size:11px;color:var(--dsw-alias-brand-primary);margin-left:8px}.dsh-lpq-text{display:flex;flex-direction:column;gap:6px}.dsh-lpq-text label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsh-lpq-answer-row{display:flex;gap:8px;align-items:flex-end}.dsh-lpq-answer{flex:1;min-width:0;min-height:54px;max-height:180px;resize:vertical;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;color:inherit;font:inherit;line-height:22px;padding:8px}.dsh-lpq-mic{padding:0;margin:0;min-width:28px;border:0}.dsh-lpq-footer{border-top:1px solid var(--dsw-alias-border-l1)}.dsh-lpq-pager{display:flex;gap:8px;align-items:center}.dsh-lpq-feedback{font-size:12px;line-height:18px;flex:1 1 160px;overflow-wrap:anywhere}.dsh-lpq-button{appearance:none;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:13px;line-height:20px;padding:5px 10px;cursor:pointer}.dsh-lpq-button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}.dsh-lpq-button:focus-visible,.dsh-lpq-answer:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.dsh-lpq-button:disabled{opacity:.5;cursor:default}.dsh-lpq-primary{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);border-color:transparent}.dsh-lpq-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary)}
@media(pointer:coarse){.dsh-lpq-answer{font-size:max(16px,1em)}.dsh-lpq-button{min-height:36px}}@media(max-width:480px){.dsh-lpq-frame{padding-left:12px;padding-right:12px}.dsh-lpq-header,.dsh-lpq-footer{padding:10px 12px}.dsh-lpq-body{padding:10px 12px}}
`;

export function createQuestionVoice(React, { MicButton, StatusRow, locale, controls }) {
  const h = React.createElement;
  const { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } = React;
  function QuestionCard({ pending }) {
    const [model] = useState(() => {
      let storage;
      try { storage = globalThis.localStorage; } catch { /* Optional browser storage. */ }
      return createQuestionDraftController(pending, { storage });
    });
    const modelState = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
    const progress = modelState.progress;
    const navigationVersion = model.navigationVersion();
    const readCard = useCallback(() => pending.getSnapshot(), [pending]);
    const subCard = useCallback(listener => pending.subscribe(listener), [pending]);
    const card = useSyncExternalStore(subCard, readCard, readCard);
    const subLocale = useCallback(listener => locale?.subscribe?.(listener) ?? (() => {}), []);
    const readLocale = useCallback(() => locale?.getSnapshot?.() ?? locale?.getLocale?.() ?? qvFallbackLocale, []);
    const localeState = useSyncExternalStore(subLocale, readLocale, readLocale);
    const t = (key, vars = {}) => {
      const texts = { en: qvCopy.en[key], ru: qvCopy.ru[key], zh: qvCopy.zh[key] };
      const translated = locale?.bind?.('local-parakeet.question')?.(key);
      let text = translated && translated !== key ? translated : qvCopy[String(localeState.active ?? 'en').split('-')[0]]?.[key] ?? texts.en;
      for (const [name, value] of Object.entries(vars)) text = text.replaceAll(`{${name}}`, String(value));
      return text;
    };
    const [feedback, setFeedback] = useState(null);
    const [minimized, setMinimized] = useState(false);
    const [transitioning, setTransitioning] = useState(false);
    const [voiceActive, setVoiceActive] = useState(false);
    const textarea = useRef(null);
    const body = useRef(null);
    const surface = useRef(null);
    const voiceActiveRef = useRef(false);
    const occurrenceId = useId();
    const alive = useRef(true);
    const actionLock = useRef(false);
    const sentVia = useRef(null);
    const actionRef = useRef(null);
    const field = useMemo(() => createQuestionField(model, {
      readSelection: () => ({ start: textarea.current?.selectionStart, end: textarea.current?.selectionEnd }),
      onSubmit: action => actionRef.current?.(action),
      notify: (_level, text) => { if (alive.current) setFeedback({ text }); },
    }), [model, progress.index, navigationVersion]);
    const fieldRef = useRef(field);
    fieldRef.current = field;
    const phase = model.getPhase();
    const locked = phase !== 'plain' || transitioning;
    const question = pending.questions[progress.index];
    const draft = progress.drafts[progress.index];
    const canAnswer = card.channel !== 'none' && !card.closed;
    const current = () => alive.current && model.live() && fieldRef.current === field;
    const cancelCapture = async () => {
      const control = controls.get(field.targetKey);
      await control?.cancel?.();
      control?.discard?.();
    };
    const abandonThen = async action => {
      if (actionLock.current || locked || !current()) return;
      actionLock.current = true;
      setTransitioning(true);
      try {
        await cancelCapture();
        if (current()) await action();
      } catch (error) {
        if (current()) setFeedback({ text: error?.message ?? String(error) });
      } finally {
        actionLock.current = false;
        if (alive.current) setTransitioning(false);
      }
    };
    const send = async () => {
      if (!current() || model.getPhase() !== 'plain') return;
      let answer;
      try { answer = questionAnswerBatch(pending.questions, model.getProgress()); }
      catch (error) {
        if (error.code === 'QUESTION_INCOMPLETE') { model.navigate(error.index); setFeedback({ key: 'incomplete' }); return; }
        setFeedback({ text: error.message }); return;
      }
      if (!model.ready()) { setFeedback({ key: 'unavailable' }); return; }
      sentVia.current = pending.getSnapshot().channel;
      model.setPhase('submitting');
      setFeedback({ key: 'sent' });
      try {
        await pending.answer(answer);
        if (!alive.current || !model.live()) return;
        if (sentVia.current === 'rpc') {
          model.setPhase('plain');
          await pending.dismiss();
        }
      } catch (error) {
        if (!alive.current || !model.live()) return;
        sentVia.current = null;
        model.setPhase('plain');
        setFeedback({ text: error?.message ?? String(error) });
      }
    };
    actionRef.current = action => {
      if (!current() || model.getPhase() !== 'plain' || !action || typeof action !== 'object') return;
      setFeedback(null);
      const latest = model.getProgress();
      if (action.kind === 'navigate') model.navigate(action.index);
      else if (action.kind === 'submit') void send();
      else if (action.kind === 'continue') {
        if (!questionAnswered(latest.drafts[latest.index])) { setFeedback({ key: 'unanswered' }); return; }
        if (latest.index < pending.questions.length - 1) model.navigate(latest.index + 1);
        else void send();
      }
    };
    const useVirtualInput = selector => {
      const state = useSyncExternalStore(field.input.state.subscribe, field.input.state.getSnapshot, field.input.state.getSnapshot);
      return selector(state);
    };
    useEffect(() => {
      alive.current = true;
      model.activate();
      model.resumeWait();
      return () => {
        alive.current = false;
        pending.releaseFocus();
        if (pending.getSnapshot().closed) model.clear();
        model.dispose();
      };
    }, [model, pending]);
    useEffect(() => {
      // The underlying native composer remains mounted beneath this takeover.
      // A sentinel disables its global dictation shortcuts without reading its DOM.
      const marker = { questionSession: pending.sessionId };
      const key = `question-surface:${pending.sessionId}:${pending.key}:${occurrenceId}`;
      controls.set(key, marker);
      void Promise.resolve(controls.get(pending.sessionId)?.cancel?.()).catch(() => {});
      return () => { if (controls.get(key) === marker) controls.delete(key); };
    }, [pending, occurrenceId]);
    useEffect(() => {
      if (!card.closed) return;
      model.clear();
      field.dispose();
      void controls.get(field.targetKey)?.cancel?.();
      controls.get(field.targetKey)?.discard?.();
    }, [card.closed, field, model]);
    useEffect(() => {
      if (sentVia.current === 'waterfall' && card.state === 'continued') {
        sentVia.current = null;
        model.setPhase('plain');
        setFeedback({ key: 'resubmit' });
      }
    }, [card.state, model]);
    useEffect(() => {
      field.activate();
      if (body.current) body.current.scrollTop = 0;
      return () => {
        field.dispose();
        void controls.get(field.targetKey)?.cancel?.();
        controls.get(field.targetKey)?.discard?.();
      };
    }, [field]);
    useEffect(() => {
      const release = () => pending.releaseFocus();
      const refocus = () => {
        if (voiceActiveRef.current || surface.current?.contains(document.activeElement)) pending.holdFocus();
      };
      const visibility = () => { if (document.hidden) release(); else refocus(); };
      window.addEventListener('blur', release);
      window.addEventListener('focus', refocus);
      document.addEventListener('visibilitychange', visibility);
      return () => {
        window.removeEventListener('blur', release);
        window.removeEventListener('focus', refocus);
        document.removeEventListener('visibilitychange', visibility);
      };
    }, [pending]);
    if (card.closed) return null;
    const button = (label, props = {}) => h('button', { type: 'button', className: 'dsh-lpq-button', disabled: locked, ...props }, label);
    let wait = '';
    if (card.state === 'continued') wait = t('continued');
    else if (['waiting', 'editing'].includes(card.waitState)) wait = t('held');
    else if (card.countdown) wait = t(card.countdown.running ? 'counting' : 'paused', { seconds: Math.ceil(card.countdown.remainingMs / 1000) });
    else if (!canAnswer) wait = t('waiting');
    const titleId = 'dsh-lpq-' + encodeURIComponent(occurrenceId) + '-' + progress.index;
    return h('div', { className: 'dsh-lpq-frame', 'data-local-parakeet-question': pending.key },
      h('style', null, qvStyle),
      h('section', {
        ref: surface, className: 'dsh-lpq-card', 'aria-labelledby': titleId, 'aria-busy': phase !== 'plain',
        onFocusCapture: event => { if (!event.currentTarget.contains(event.relatedTarget)) pending.holdFocus(); },
        onBlurCapture: event => { if (!event.currentTarget.contains(event.relatedTarget) && !voiceActive) pending.releaseFocus(); },
      },
      h('header', { className: 'dsh-lpq-header' },
        h('span', { className: 'dsh-lpq-heading' }, question.header ?? t('title')),
        wait ? h('span', { className: 'dsh-lpq-countdown', role: 'status' }, wait) : null,
        card.countdown && ['counting', 'focused'].includes(card.waitState) ? button(t('takeTime'), { onClick: () => model.takeTime() }) : null,
        button(minimized ? '⌄' : '⌃', { 'aria-label': t(minimized ? 'expand' : 'minimize'), 'aria-expanded': !minimized, onClick: () => { void abandonThen(() => setMinimized(value => !value)); } }),
        button('×', { 'aria-label': t('close'), onClick: () => { void abandonThen(() => pending.dismiss()); } })),
      minimized ? h('h2', { className: 'dsh-lpq-title', id: titleId, style: { padding: '12px 16px' } }, question.question) : h(React.Fragment, null,
        h('div', { className: 'dsh-lpq-body', ref: body },
          h('h2', { className: 'dsh-lpq-title', id: titleId }, question.question),
          question.detail ? h('details', { className: 'dsh-lpq-detail', key: question.id }, h('summary', null, t('detail')), h('div', null, question.detail)) : null,
          (question.options ?? []).length > 0 ? h('div', { className: 'dsh-lpq-choices', role: question.multiSelect ? 'group' : 'radiogroup', 'aria-labelledby': titleId },
            ...question.options.map((option, index) => {
              const display = questionRecommended(option.label);
              const selected = draft.selected.includes(option.label);
              return h('button', {
                key: index, type: 'button', className: 'dsh-lpq-button dsh-lpq-choice', role: question.multiSelect ? 'checkbox' : 'radio',
                'aria-checked': selected, disabled: locked,
                onClick: () => { void abandonThen(() => { model.choose(option.label); setFeedback(null); }); },
                onKeyDown: event => { if (event.key === 'Enter' && !event.nativeEvent?.isComposing) { event.preventDefault(); field.input.submit({ kind: 'submit' }); } },
              }, h('span', { 'aria-hidden': true }, question.multiSelect ? (selected ? '☑' : '☐') : String(index + 1)),
              h('span', { className: 'dsh-lpq-choice-copy' }, h('span', null, display.label, display.recommended ? h('span', { className: 'dsh-lpq-badge' }, t('recommended')) : null),
                option.description ? h('span', { className: 'dsh-lpq-description' }, option.description) : null));
            })) : null,
          h('div', { className: 'dsh-lpq-text' },
            h('label', { htmlFor: titleId + '-answer' }, t('other')),
            h('div', { className: 'dsh-lpq-answer-row' },
              h('textarea', {
                ref: textarea, id: titleId + '-answer', className: 'dsh-lpq-answer', value: draft.custom, placeholder: t('placeholder'), disabled: locked, rows: 2,
                onChange: event => { model.custom(progress.index, event.target.value); setFeedback(null); },
                onKeyDown: event => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing && event.nativeEvent?.keyCode !== 229) {
                    event.preventDefault(); field.input.submit({ kind: 'continue' });
                  }
                },
              }),
              h('fieldset', { className: 'dsh-lpq-mic', disabled: locked || !canAnswer, 'aria-label': t('voice') },
                canAnswer ? h(MicButton, {
                  key: field.targetKey, sessionId: field.targetKey, inputActions: field.inputActions, resolveInput: field.resolveInput, locale,
                  useInput: useVirtualInput, targetKind: 'question', micLabel: t('voice'),
                  onActiveChange: active => {
                    voiceActiveRef.current = active;
                    if (alive.current) setVoiceActive(active);
                    if (active) pending.holdFocus();
                    else if (!surface.current?.contains(document.activeElement)) pending.releaseFocus();
                  },
                }) : null)),

            h('span', { className: 'dsh-lpq-hint' }, t('hint')),
            h(StatusRow, { key: field.targetKey, sessionId: field.targetKey, inputActions: field.inputActions, useInput: useVirtualInput, locale }))),
        h('footer', { className: 'dsh-lpq-footer' },
          h('div', { className: 'dsh-lpq-pager' },
            button('‹', { 'aria-label': t('prev'), disabled: locked || progress.index === 0, onClick: () => field.input.submit({ kind: 'navigate', index: progress.index - 1 }) }),
            h('span', null, `${progress.index + 1} / ${pending.questions.length}`),
            button('›', { 'aria-label': t('following'), disabled: locked || progress.index === pending.questions.length - 1, onClick: () => field.input.submit({ kind: 'navigate', index: progress.index + 1 }) })),
          h('span', { className: 'dsh-lpq-feedback', role: 'status' }, feedback ? (feedback.key ? t(feedback.key) : feedback.text) : ''),
          button(t('skip'), { onClick: () => { void abandonThen(async () => { const last = model.getProgress().index === pending.questions.length - 1; model.skip(); setFeedback(null); if (last) await send(); }); } }),
          button(t(progress.index === pending.questions.length - 1 ? 'submit' : 'next'), {
            className: 'dsh-lpq-button dsh-lpq-primary',
            disabled: locked || (!questionAnswered(draft) && !voiceActive) || (progress.index === pending.questions.length - 1 && !canAnswer),
            onClick: () => field.input.submit({ kind: 'continue' }),
          })))));
  }
  function Component({ matched, sessionId }) {
    if (matched?.sessionId !== sessionId) return null;
    return h(QuestionCard, { key: matched.key, pending: matched });
  }
  return { select: selectVoiceQuestion, Component };
}
