import { buildEffortView, selectionAt, stopPercent } from './choices.js';

export function createPlugin(React) {
  const h = React.createElement;
  const NS = 'local.reasoning-depth';
  const DICTS = {
    en: {
      title: 'Reasoning depth', chooseLevel: 'Choose level', serverDefaultHint: 'No explicit effort is selected. The server decides; no exact level is reported. Choose a listed level to set it explicitly.',
      hint: 'Drag or click to choose a level. Arrow keys change one step; Home and End choose the endpoints.',
      saving: 'Saving…', error: 'Could not change reasoning depth',
      sessionInUse: 'Close other DSH instances using this session and try again.',
      unavailable: 'Reasoning depth is currently read-only.',
    },
    ru: {
      title: 'Глубина рассуждений', chooseLevel: 'Выберите уровень', serverDefaultHint: 'Явный уровень не выбран. Решение остаётся серверу; точный уровень не сообщается. Выберите один из доступных уровней.',
      hint: 'Перетащите бегунок или нажмите на шкалу. Стрелки меняют уровень, Home и End выбирают крайние положения.',
      saving: 'Сохранение…', error: 'Не удалось изменить глубину рассуждений',
      sessionInUse: 'Закройте другие экземпляры DSH, использующие этот сеанс, и повторите попытку.',
      unavailable: 'Сейчас глубина рассуждений доступна только для чтения.',
    },
    zh: {
      title: '推理深度', chooseLevel: '选择级别', serverDefaultHint: '未选择具体推理级别，服务器自行决定。请选择一个已列出的级别。',
      hint: '拖动或点击选择档位。方向键逐档调整，Home 和 End 选择两端。',
      saving: '正在保存…', error: '无法更改推理深度',
      sessionInUse: '请关闭正在使用此会话的其他 DSH 实例，然后重试。',
      unavailable: '当前推理深度为只读。',
    },
  };
  const CSS = `
/* The dock also owns the native statistics and context meter: wrap only this occurrence. */
[data-composer-dock]:has(.rds-wrap) { flex-wrap:wrap; width:100%; max-width:var(--dsh-composer-card-max-width); row-gap:4px; }
/* The Hero omits composer.dock. Its input.dock contribution follows the resident card in flex flow. */
.rds-hero { order:100; align-self:center; box-sizing:border-box; width:calc(100% - 2 * var(--dsh-composer-side-clearance)); max-width:var(--dsh-composer-card-max-width); margin-top:4px; }
/* During blank-to-chat transitions the normal dock wins, so never show two sliders. */
:has(> .rds-hero):has([data-composer-dock] .rds-wrap) > .rds-hero { display:none; }
.rds-wrap { width:100%; min-width:0; flex:0 0 100%; box-sizing:border-box; container:reasoning-depth / inline-size; }
.rds-panel { --rds-white:var(--dsw-static-white, #fff); --rds-blue:var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-1); width:calc(100% - 4 * var(--dsh-composer-dock-inset)); max-width:calc(var(--dsh-composer-card-max-width) - 4 * var(--dsh-composer-dock-inset)); margin-inline:auto; border:1px solid var(--dsw-alias-border-l1); border-radius:18px; corner-shape:round; box-sizing:border-box; font:inherit; }
.rds-row { display:grid; grid-template-columns:auto minmax(60px,1fr) auto; align-items:center; column-gap:12px; min-height:26px; padding:0 10px; }
.rds-label { display:flex; align-items:center; gap:6px; min-width:0; font-size:12px; line-height:18px; font-weight:500; white-space:nowrap; }
.rds-brain { flex:none; color:var(--dsw-alias-label-secondary); }
.rds-range { min-width:0; position:relative; height:26px; border-radius:6px; direction:ltr; }
.rds-input { position:relative; z-index:2; display:block; appearance:none; -webkit-appearance:none; width:100%; height:26px; margin:0; padding:0; border:0; border-radius:6px; outline:none; background:transparent; cursor:pointer; accent-color:var(--rds-blue); touch-action:pan-y; }
.rds-input::-webkit-slider-runnable-track { height:9.333px; border:1px solid color-mix(in srgb,var(--rds-blue) 18%,var(--dsw-alias-border-l1)); border-radius:999px; corner-shape:round; background:linear-gradient(to right,color-mix(in srgb,var(--rds-blue) 86%,var(--dsw-alias-bg-layer-1)),var(--rds-blue) var(--rds-fill),var(--dsw-alias-bg-layer-2) var(--rds-fill)); }
.rds-input::-moz-range-track { height:7.333px; border:1px solid color-mix(in srgb,var(--rds-blue) 18%,var(--dsw-alias-border-l1)); border-radius:999px; corner-shape:round; background:linear-gradient(to right,color-mix(in srgb,var(--rds-blue) 86%,var(--dsw-alias-bg-layer-1)),var(--rds-blue) var(--rds-fill),var(--dsw-alias-bg-layer-2) var(--rds-fill)); }
.rds-input::-webkit-slider-thumb { appearance:none; -webkit-appearance:none; width:16px; height:16px; margin-top:-4.333px; border:2px solid var(--rds-blue); border-radius:50%; corner-shape:round; background:var(--rds-white); box-shadow:0 1px 4px color-mix(in srgb,var(--dsw-alias-bg-base) 32%,transparent),0 0 0 1px color-mix(in srgb,var(--dsw-alias-bg-overlay) 30%,transparent); transition:box-shadow 120ms ease; }
.rds-input::-moz-range-thumb { width:12px; height:12px; border:2px solid var(--rds-blue); border-radius:50%; corner-shape:round; background:var(--rds-white); box-shadow:0 1px 4px color-mix(in srgb,var(--dsw-alias-bg-base) 32%,transparent); transition:box-shadow 120ms ease; }
.rds-input:enabled:hover::-webkit-slider-thumb { box-shadow:0 0 0 4px color-mix(in srgb,var(--rds-blue) 14%,transparent); }
.rds-input:enabled:hover::-moz-range-thumb { box-shadow:0 0 0 4px color-mix(in srgb,var(--rds-blue) 14%,transparent); }
.rds-range:has(.rds-input:focus-visible) { outline:2px solid var(--rds-blue); outline-offset:2px; }
.rds-input:disabled { cursor:default; }
.rds-panel[data-readonly="true"] .rds-range { opacity:.55; }
.rds-stops { position:absolute; z-index:3; inset:0 8px; pointer-events:none; }
.rds-stop { position:absolute; top:50%; width:4px; height:4px; border-radius:50%; corner-shape:round; transform:translate(-50%,-50%); background:var(--rds-white); opacity:1; }
.rds-stop[data-filled="true"] { background:var(--rds-white); opacity:1; }
.rds-stop[data-selected="true"] { opacity:0; }
.rds-value-wrap { display:grid; grid-template-areas:"value"; border-inline-start:1px solid var(--dsw-alias-border-l2); padding-inline-start:10px; min-width:54px; box-sizing:content-box; }
.rds-value { grid-area:value; display:block; box-sizing:border-box; min-width:54px; max-width:132px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-align:center; border:1px solid color-mix(in srgb,var(--rds-blue) 22%,var(--dsw-alias-border-l1)); border-radius:999px; corner-shape:round; padding:0 9px; color:var(--dsw-alias-label-primary); background:color-mix(in srgb,var(--rds-blue) 10%,var(--dsw-alias-bg-layer-2)); font-size:12px; font-weight:500; line-height:18px; font-variant-numeric:tabular-nums; }
/* All names share one invisible grid cell: reserve the widest label, not the selected one. */
.rds-value-size { display:grid; visibility:hidden; pointer-events:none; user-select:none; }
.rds-value-size > span { grid-area:1 / 1; min-width:0; overflow:hidden; }
.rds-panel[data-busy="true"] .rds-value { opacity:.65; }
/* No thumb may pretend the first level is active when effort was never specified. */
.rds-panel[data-unset="true"] .rds-input::-webkit-slider-thumb { opacity:0; }
.rds-panel[data-unset="true"] .rds-input::-moz-range-thumb { opacity:0; }
.rds-panel[data-unset="true"] .rds-value { color:var(--dsw-alias-label-secondary); }
.rds-error { padding:0 14px 10px; color:var(--dsw-alias-state-error-primary); font-size:12px; overflow-wrap:anywhere; }
.rds-sr { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; border:0; }
@container reasoning-depth (max-width:420px) {
  .rds-row { grid-template-columns:16px minmax(30px,1fr) auto; column-gap:8px; padding:0 8px; }
  .rds-label-text { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
  .rds-value-wrap { padding-inline-start:8px; min-width:46px; }
  .rds-value { min-width:46px; max-width:92px; padding-inline:6px; }
}
@media (pointer:coarse) { .rds-input { height:36px; margin-block:-5px; } }
@media (prefers-reduced-motion:reduce) { .rds-input::-webkit-slider-thumb { transition:none; } .rds-input::-moz-range-thumb { transition:none; } }
@media (forced-colors:active) {
  .rds-input { appearance:auto; -webkit-appearance:auto; }
  .rds-stops { display:none; }
}
`;

  function Brain() {
    return h('svg', { className: 'rds-brain', width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.65, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
      h('path', { d: 'M12 6a3 3 0 0 0-5.8-1A4 4 0 0 0 4 12a4 4 0 0 0 2.5 6.8A3 3 0 0 0 12 20V6Zm0 0a3 3 0 0 1 5.8-1A4 4 0 0 1 20 12a4 4 0 0 1-2.5 6.8A3 3 0 0 1 12 20' }),
      h('path', { d: 'M7 9a3 3 0 0 1 1.5 2.5M5 13a3 3 0 0 1 3 1M8 18a3 3 0 0 1 1-2M17 9a3 3 0 0 0-1.5 2.5M19 13a3 3 0 0 0-3 1M16 18a3 3 0 0 0-1-2' }));
  }

  function Slider({ directory, allowed, t }) {
    const subscribe = React.useCallback(fn => directory.store.subscribe(fn), [directory]);
    const getSnapshot = React.useCallback(() => directory.store.getSnapshot(), [directory]);
    const state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const [draft, setDraft] = React.useState(null);
    const [error, setError] = React.useState(null);
    const [saving, setSaving] = React.useState(false);
    const draftRef = React.useRef(null);
    const pointer = React.useRef(false);
    const keyboard = React.useRef(false);
    const inFlight = React.useRef(false);
    const mounted = React.useRef(true);
    const id = React.useId();
    const view = buildEffortView(state);
    const baseline = JSON.stringify(view?.selection ?? null);
    const key = view?.key;
    const busy = saving || state.pending !== null;
    const disabled = !allowed || busy || (state.status !== 'ready' && state.status !== 'error') || ((view?.choices.length ?? 0) < 2 && !view?.selectionRequired);

    React.useEffect(() => {
      mounted.current = true;
      directory.load().catch(() => {});
      return () => { mounted.current = false; };
    }, [directory]);
    React.useEffect(() => {
      draftRef.current = null;
      setDraft(null);
      pointer.current = false;
      keyboard.current = false;
      setError(null);
    }, [key, baseline]);

    function clearDraft() {
      draftRef.current = null;
      setDraft(null);
    }
    async function commit(nextDraft = draftRef.current) {
      clearDraft();
      if (!nextDraft || !allowed || inFlight.current) return;
      const latestState = directory.store.getSnapshot();
      const latest = buildEffortView(latestState);
      // An external model/effort switch invalidates the gesture, never switches it back.
      if (!latest || latest.key !== nextDraft.key || JSON.stringify(latest.selection) !== nextDraft.baseline || latestState.pending !== null || (latestState.status !== 'ready' && latestState.status !== 'error')) return;
      if (latest.index === nextDraft.index) return;
      const selection = selectionAt(latest, nextDraft.index);
      if (!selection) return;
      inFlight.current = true;
      setSaving(true);
      setError(null);
      try {
        const result = await directory.select(selection);
        if (mounted.current && !result?.ok) setError(result?.error?.code === 'session/writer-held' ? t('sessionInUse') : `${t('error')}${result?.error?.message ? `: ${result.error.message}` : ''}`);
      } catch (cause) {
        if (mounted.current) setError(`${t('error')}: ${cause instanceof Error ? cause.message : String(cause)}`);
      } finally {
        inFlight.current = false;
        if (mounted.current) setSaving(false);
      }
    }
    function preview(event) {
      if (disabled || !view) return;
      const index = Number(event.currentTarget.value);
      if (!selectionAt(view, index)) return;
      const next = { key: view.key, baseline, index };
      draftRef.current = next;
      setDraft(next);
      // Assistive technology may change the native range without a pointer/key gesture.
      if (!pointer.current && !keyboard.current) void commit(next);
    }
    function finishPointer() {
      if (!pointer.current) return;
      pointer.current = false;
      void commit();
    }
    function cancelGesture() {
      pointer.current = false;
      keyboard.current = false;
      clearDraft();
    }
    const rangeKeys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'];
    if (!view) return null; // Models without advertised efforts get no misleading control.
    const index = draft?.key === key && draft.baseline === baseline ? draft.index : view.index;
    const current = view.choices[index] ?? { name: t('chooseLevel'), description: t('serverDefaultHint') };
    const progress = index < 0 ? 0 : stopPercent(index, view.choices.length);
    const levels = view.choices.map(item => item.name).join(' · ');
    const title = `${t('title')}: ${current.name}\n${levels}\n${allowed ? t('hint') : t('unavailable')}`;
    return h('section', { className: 'rds-wrap', 'aria-label': t('title'), 'data-reasoning-depth': '1.0.6' },
      h('style', null, CSS),
      h('div', { className: 'rds-panel', 'data-busy': String(busy), 'data-readonly': String(!allowed), 'data-unset': String(index < 0) },
        h('div', { className: 'rds-row' },
          h('label', { className: 'rds-label', htmlFor: id, title: t('title') }, h(Brain), h('span', { className: 'rds-label-text' }, t('title'))),
          h('div', { className: 'rds-range', style: { '--rds-fill': `calc(${progress}% + ${8 - progress * 0.16}px)` } },
            h('input', {
              id, className: 'rds-input', type: 'range', min: 0, max: Math.max(1, view.choices.length - 1), step: 1,
              value: Math.max(0, index), disabled, title,
              'aria-valuetext': current.name, 'aria-describedby': `${id}-hint${error ? ` ${id}-error` : ''}`, 'aria-busy': busy,
              onChange: preview,
              onPointerDown: event => {
                if (!disabled) {
                  pointer.current = true;
                  event.currentTarget.setPointerCapture(event.pointerId);
                  if (view.selectionRequired && !draftRef.current) {
                    const rect = event.currentTarget.getBoundingClientRect();
                    const ratio = rect.width > 0 ? Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) : 0;
                    preview({ currentTarget: { value: String(Math.round(ratio * (view.choices.length - 1))) } });
                  }
                }
              },
              onPointerUp: finishPointer, onPointerCancel: cancelGesture,
              onLostPointerCapture: () => { if (pointer.current) cancelGesture(); },
              onKeyDown: event => {
                if (event.key === 'Escape' && draftRef.current) { event.preventDefault(); cancelGesture(); }
                else if (rangeKeys.includes(event.key) && !disabled) {
                  keyboard.current = true;
                  if (view.selectionRequired && !draftRef.current) {
                    event.preventDefault();
                    preview({ currentTarget: { value: String(event.key === 'End' ? view.choices.length - 1 : 0) } });
                  }
                }
              },
              onKeyUp: event => { if (rangeKeys.includes(event.key)) { keyboard.current = false; void commit(); } },
              onBlur: () => { pointer.current = false; keyboard.current = false; void commit(); },
            }),
            h('div', { className: 'rds-stops', 'aria-hidden': true }, ...view.choices.map((choice, stop) => h('span', {
              key: choice.id ?? 'provider-default', className: 'rds-stop', 'data-effort-id': choice.id ?? '',
              'data-filled': String(stop <= index), 'data-selected': String(stop === index),
              style: { left: `${stopPercent(stop, view.choices.length)}%` },
            }))),
          ),
          h('div', { className: 'rds-value-wrap' },
            h('span', { className: 'rds-value rds-value-size', 'aria-hidden': true },
              ...view.choices.map(choice => h('span', { key: choice.id ?? 'provider-default' }, choice.name)), h('span', null, t('chooseLevel'))),
            h('output', { className: 'rds-value', htmlFor: id, title: current.description ?? current.name, 'aria-live': 'off' }, current.name)),
        ),
        error ? h('div', { id: `${id}-error`, className: 'rds-error', role: 'alert' }, error) : null,
        h('span', { id: `${id}-hint`, className: 'rds-sr' }, t('hint')),
        h('span', { className: 'rds-sr', role: 'status' }, busy ? t('saving') : ''),
      ));
  }

  return {
    inject: ['slots', 'locale', 'modelDirectories'],
    apply(ctx) {
      for (const [locale, dict] of Object.entries(DICTS)) ctx.effect(() => ctx.locale.register(NS, locale, dict), `reasoning-depth: ${locale}`);
      const t = ctx.locale.bind(NS);
      const localeSubscribe = fn => ctx.locale.subscribe(fn);
      const localeSnapshot = () => ctx.locale.getSnapshot();
      function Dock(props) {
        React.useSyncExternalStore(localeSubscribe, localeSnapshot, localeSnapshot);
        const unavailable = props.useSession(session => session.removed || session.subagent !== null);
        const allowed = props.useAccess('session/selectModel');
        if (unavailable) return null;
        return h(BoundSlider, { key: props.sessionId, sessionId: props.sessionId, allowed });
      }
      function BoundSlider({ sessionId, allowed }) {
        const directory = React.useMemo(() => ctx.modelDirectories.directoryFor(sessionId), [sessionId]);
        return h(Slider, { directory, allowed, t });
      }
      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock', id: 'reasoning-depth-1.0.6', order: -10, locale: NS,
      }, Dock));
      function HeroDock(props) {
        const blank = props.useSession(session => session.blank && !session.removed && session.subagent === null);
        if (!blank) return null;
        return h('div', { className: 'rds-hero', 'data-reasoning-depth-hero': '1.0.6' }, h(Dock, props));
      }
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock', id: 'reasoning-depth-hero-1.0.6', order: 100, locale: NS,
      }, HeroDock));
      // Match TodoPanel's theme radius. GoalBar's background pseudo-element inherits it.
      function GoalPanelCorners() {
        return h('style', { 'data-goal-panel-corners': '1.0.4' },
          '[data-goal-bar] > div { border-radius:var(--dsw-radius-lg); }');
      }
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock', id: 'goal-panel-corners-1.0.4', order: -100,
      }, GoalPanelCorners));
    },
  };
}
