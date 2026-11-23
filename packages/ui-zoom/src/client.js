import { ZOOM_MIN, ZOOM_MAX, LOG_STEP, formatZoom, positionToPercent, percentToPosition, neutralPosition } from './scale.js';
import { createLocalZoomPreference } from './local-preference.js';
import { sliderGeometry, popupPosition, pointerPosition, inverseZoom, thumbGrabOffset } from './geometry.js';
import { zoomAction, zoomStyle } from './core.js';
import { createZoomController } from './controller.js';
import { createZoomPopup } from './popup.js';
import { createCoordinateCompatibility } from './coordinates.js';

const PANEL_ID = 'dsh-ui-zoom-panel-v6';
const COPY = {
  en: {
    title: 'Interface zoom',
    description: 'Saved only in this browser. Ctrl/Cmd + Shift + plus / minus; Ctrl/Cmd + Shift + 0 restores 100%.',
    localOnly: 'Zoom currently works in this tab only; it has not been saved in browser storage.',
    decrease: 'Zoom out', increase: 'Zoom in', reset: 'Reset to 100%',
    open: 'Open zoom slider', close: 'Close zoom slider', resetShort: 'Reset', dragHint: 'Drag the circle',
    current: 'Interface zoom: {percent}%', error: 'Zoom works in this tab, but the browser could not save it locally. Check site storage permissions.',
    loading: 'Zoom settings are not available yet.', saving: 'Saving…',
    sliderHelp: 'Drag vertically. Arrow keys change one logarithmic step. Home: 50%; End: 300%; Escape: close. The numbers on the right are fixed scale labels; dragging snaps at 100%.',
  },
  ru: {
    title: 'Масштаб интерфейса',
    description: 'Сохраняется только в этом браузере. Ctrl/Cmd + Shift + плюс / минус; Ctrl/Cmd + Shift + 0 — сброс до 100%.',
    localOnly: 'Масштаб действует в этой вкладке, но пока не сохранён в браузере.',
    decrease: 'Уменьшить масштаб', increase: 'Увеличить масштаб', reset: 'Сбросить до 100%',
    open: 'Открыть слайдер масштаба', close: 'Закрыть слайдер масштаба', resetShort: 'Сброс', dragHint: 'Тяните кружок',
    current: 'Масштаб интерфейса: {percent}%', error: 'Масштаб действует в этой вкладке, но браузер не смог сохранить его локально. Проверьте разрешения на хранение данных.',
    loading: 'Настройка масштаба пока недоступна.', saving: 'Сохранение…',
    sliderHelp: 'Перетаскивайте по вертикали. Стрелки меняют один логарифмический шаг. Home — 50%; End — 300%; Escape — закрыть. Числа справа — неподвижная шкала; при перетаскивании есть прилипание к 100%.',
  },
  zh: {
    title: '界面缩放', description: '仅保存在当前浏览器。Ctrl/Cmd + Shift + 加号 / 减号；Ctrl/Cmd + Shift + 0 恢复 100%。',
    localOnly: '缩放目前仅在当前标签页生效，尚未保存至浏览器存储。',
    decrease: '缩小', increase: '放大', reset: '重置为 100%', open: '打开缩放滑块', close: '关闭缩放滑块', resetShort: '重置', dragHint: '拖动圆形滑块',
    current: '界面缩放：{percent}%', error: '缩放已在当前标签页生效，但无法在浏览器中保存。请检查网站存储权限。',
    loading: '缩放设置暂不可用。', saving: '正在保存…',
    sliderHelp: '垂直拖动。方向键调整一个对数步长。Home：50%；End：300%；Escape：关闭。右侧数字是固定刻度；拖动时在 100% 吸附。',
  },
};

const STYLE = `
.dsh-ui-zoom-row { display:flex; align-items:center; flex-wrap:wrap; gap:12px; padding:16px 0; border-bottom:.5px solid var(--dsw-alias-border-l2); }
.dsh-ui-zoom-copy { flex:1 1 170px; min-width:0; }
.dsh-ui-zoom-title { color:var(--dsw-alias-label-primary); font-size:14px; line-height:22px; }
.dsh-ui-zoom-desc { color:var(--dsw-alias-label-secondary); font-size:12px; line-height:18px; margin-top:4px; }
.dsh-ui-zoom-controls { display:flex; align-items:center; gap:6px; color:var(--dsw-alias-label-primary); font-size:14px; line-height:22px; }
.dsh-ui-zoom-button { display:inline-flex; align-items:center; justify-content:center; min-width:30px; height:32px; padding:0 8px; border:0; border-radius:8px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); font:inherit; cursor:pointer; }
.dsh-ui-zoom-button:hover:not(:disabled) { background:var(--dsw-alias-bg-layer-1); }
.dsh-ui-zoom-button:disabled { opacity:.4; cursor:default; }
.dsh-ui-zoom-button:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; }
.dsh-ui-zoom-value { min-width:5ch; text-align:center; font-variant-numeric:tabular-nums; }
.dsh-ui-zoom-tool { display:inline-flex; flex:none; align-items:center; justify-content:center; width:30px; height:30px; padding:0; border:0; border-radius:8px; background:transparent; color:var(--dsw-alias-label-secondary); cursor:pointer; -webkit-app-region:no-drag; }
.dsh-ui-zoom-tool:hover:not(:disabled), .dsh-ui-zoom-tool[aria-expanded='true'] { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); }
.dsh-ui-zoom-tool:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; }
.dsh-ui-zoom-tool:disabled { opacity:.35; cursor:default; }
.dsh-ui-zoom-tool svg { display:block; pointer-events:none; }
.dsh-ui-zoom-error { flex-basis:100%; font-size:12px; line-height:18px; color:var(--dsw-alias-state-error-primary); }
.dsh-ui-zoom-notice { position:fixed; right:16px; bottom:16px; max-width:calc(100% - 32px); box-sizing:border-box; padding:10px 12px; border:1px solid var(--dsw-alias-border-l2); border-radius:12px; background:var(--dsw-alias-bg-overlay); color:var(--dsw-alias-label-primary); font-size:13px; line-height:20px; pointer-events:none; }
.dsh-ui-zoom-popup { position:fixed; box-sizing:border-box; overflow-y:auto; overscroll-behavior:contain; scrollbar-width:thin; display:flex; flex-direction:column; align-items:center; padding:12px; border-radius:12px; background:var(--dsw-alias-bg-overlay); color:var(--dsw-alias-label-primary); box-shadow:0 0 0 1px var(--dsw-alias-border-l2); pointer-events:auto; z-index:50; -webkit-app-region:no-drag; animation:dsh-ui-zoom-open 120ms ease-out; }
.dsh-ui-zoom-popup-head { flex:none; width:100%; height:44px; text-align:center; }
.dsh-ui-zoom-popup-value { height:24px; font-size:16px; line-height:24px; font-weight:600; font-variant-numeric:tabular-nums; }
.dsh-ui-zoom-hint { margin-top:4px; color:var(--dsw-alias-label-secondary); font-size:11px; line-height:16px; white-space:nowrap; }
.dsh-ui-zoom-well { position:relative; flex:none; width:100%; margin:8px 0; user-select:none; -webkit-user-select:none; }
.dsh-ui-zoom-rail { position:absolute; left:50%; top:0; height:100%; transform:translateX(-50%); cursor:ns-resize; touch-action:none; outline:none; }
.dsh-ui-zoom-rail[aria-disabled='true'] { opacity:.45; cursor:default; }
.dsh-ui-zoom-track { position:absolute; left:50%; transform:translateX(-50%); border-radius:999px; corner-shape:round; overflow:hidden; background:color-mix(in srgb, var(--dsw-alias-label-primary) 35%, var(--dsw-alias-bg-overlay)); pointer-events:none; }
.dsh-ui-zoom-track-fill { position:absolute; left:0; right:0; bottom:0; border-radius:inherit; background:color-mix(in srgb, var(--dsw-alias-brand-primary) 50%, var(--dsw-alias-label-primary)); }
.dsh-ui-zoom-references { position:absolute; inset:0; pointer-events:none; }
.dsh-ui-zoom-reference { position:absolute; display:flex; align-items:center; gap:4px; height:16px; transform:translateY(-50%); color:var(--dsw-alias-label-secondary); font-size:11px; line-height:16px; font-variant-numeric:tabular-nums; white-space:nowrap; cursor:default; }
.dsh-ui-zoom-reference::before { content:''; flex:none; width:5px; height:1px; background:currentColor; }
.dsh-ui-zoom-reference[data-reference='neutral'] { font-weight:600; }
.dsh-ui-zoom-well[data-neutral='true'] .dsh-ui-zoom-reference[data-reference='neutral'] { color:var(--dsw-alias-label-primary); }
.dsh-ui-zoom-thumb { position:absolute; left:50%; display:flex; align-items:center; justify-content:center; transform:translate(-50%,-50%); box-sizing:border-box; border:2px solid var(--dsw-alias-label-primary); border-radius:50%; corner-shape:round; background:var(--dsw-alias-bg-overlay); color:var(--dsw-alias-label-primary); box-shadow:0 1px 3px color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent); pointer-events:none; transition:box-shadow 100ms ease; }
.dsh-ui-zoom-grip { display:block; width:12px; height:12px; }
.dsh-ui-zoom-rail[data-dragging='true'] .dsh-ui-zoom-thumb { box-shadow:0 0 0 5px color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent); }
.dsh-ui-zoom-rail:focus-visible .dsh-ui-zoom-thumb { outline:2px solid var(--dsw-alias-label-primary); outline-offset:4px; }
.dsh-ui-zoom-popup-reset { display:inline-flex; align-items:center; justify-content:center; flex:none; box-sizing:border-box; min-width:72px; height:44px; padding:0 16px; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; background:transparent; color:var(--dsw-alias-label-primary); font-size:12px; line-height:20px; cursor:pointer; }
.dsh-ui-zoom-popup-reset:hover:not(:disabled) { background:var(--dsw-alias-bg-layer-2); }
.dsh-ui-zoom-popup-reset:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; }
.dsh-ui-zoom-popup-reset:disabled { opacity:.4; cursor:default; }
@keyframes dsh-ui-zoom-open { from { opacity:0; transform:translateY(-6px); } to { opacity:1; transform:translateY(0); } }
@media (prefers-reduced-motion: reduce) { .dsh-ui-zoom-popup { animation:none; } .dsh-ui-zoom-thumb { transition:none; } }
`;

export function createPlugin(React) {
  const h = React.createElement;
  return {
    inject: ['slots', 'locale', 'shortcuts'],
    apply(ctx) {
      for (const [locale, dict] of Object.entries(COPY)) ctx.effect(() => ctx.locale.register('local.ui-zoom', locale, dict));
      const t = ctx.locale.bind('local.ui-zoom');
      const preference = createLocalZoomPreference({
        getStorage: () => window.localStorage,
        subscribeStorage(listener) {
          window.addEventListener('storage', listener);
          return () => window.removeEventListener('storage', listener);
        },
      });
      const controller = createZoomController(preference);
      const popup = createZoomPopup();
      ctx.effect(() => () => { popup.dispose(); controller.dispose(); preference.dispose(); });
      let coordinates;
      ctx.effect(() => {
        coordinates = createCoordinateCompatibility({ document, view: window });
        return () => { coordinates.dispose(); coordinates = undefined; };
      }, 'ui-zoom: viewport-coordinate compatibility');
      // Read-only diagnostics identify the answering page; no Host operation can set its zoom.
      ctx.inject(['cordisInspect'], scope => {
        scope.effect(() => scope.get('cordisInspect').register({
          manifest: {
            id: 'UiZoom', description: 'Read-only browser-local zoom and storage health; no global zoom operation.',
            methods: [{
              name: 'status', description: 'Read the answering page’s local zoom, storage status and loaded version.',
              inputSchema: { type: 'object', properties: {}, additionalProperties: false },
              outputSchema: { type: 'object', description: 'Local percentage, browser-origin scope, storage health and version.' },
            }],
          },
          async query(method) {
            if (method !== 'status') throw new Error('Unknown method.');
            const local = preference.getSnapshot();
            const documentStyle = window.getComputedStyle(document.documentElement);
            const documentZoom = Number.parseFloat(documentStyle.zoom);
            return { version: '1.5.0', scope: 'browser-origin', storage: 'localStorage', origin: window.location.origin,
              runtime: ctx.shortcuts.runtime, platform: ctx.shortcuts.platform,
              percent: controller.getSnapshot().percent, localPercent: local.value.percent,
              persistent: local.persistent, problem: local.problem, stepLog: LOG_STEP,
              documentZoom: Number.isFinite(documentZoom) ? documentZoom : null,
              geometryFactor: Number.parseFloat(documentStyle.getPropertyValue('--dsh-ui-zoom-factor')) || 1,
              geometryInverse: Number.parseFloat(documentStyle.getPropertyValue('--dsh-ui-zoom-inverse')) || 1,
              coordinates: coordinates?.status() ?? { installed: false },
              cssSupport: { zoom: window.CSS.supports('zoom', '1'), anchor: window.CSS.supports('position-anchor', '--probe'),
                lineHeightUnit: window.CSS.supports('line-height', '1lh') },
            };
          },
        }), 'ui-zoom: browser-local status');
      });
      const useZoom = () => React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
      const usePopup = () => React.useSyncExternalStore(popup.subscribe, popup.getSnapshot, popup.getSnapshot);
      const useLocale = () => React.useSyncExternalStore(fn => ctx.locale.subscribe(fn), () => ctx.locale.getSnapshot(), () => ctx.locale.getSnapshot());
      const change = action => { void controller.change(action); };
      const text = state => t('current').replace('{percent}', formatZoom(state.percent));

      function ZoomPanel({ anchor }) {
        const state = useZoom();
        useLocale();
        const panelRef = React.useRef(null);
        const railRef = React.useRef(null);
        const trackRef = React.useRef(null);
        const dragRef = React.useRef(null);
        const [dragPosition, setDragPosition] = React.useState(null);
        const [viewport, setViewport] = React.useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
        const geometry = sliderGeometry(viewport.height);
        const visibleHeight = Math.min(geometry.panelHeight, Math.max(1, viewport.height - 16));
        const placement = popupPosition(viewport.width, viewport.height, anchor, { ...geometry, panelHeight: visibleHeight });
        const enabled = state.ready && state.writable;
        const position = dragPosition ?? percentToPosition(state.percent);
        const center = p => geometry.hit / 2 + (1 - p) * geometry.length;

        const finishDrag = event => {
          const drag = dragRef.current;
          if (!drag || (event && event.pointerId !== drag.id)) return;
          dragRef.current = null;
          if (railRef.current?.hasPointerCapture(drag.id)) railRef.current.releasePointerCapture(drag.id);
          setDragPosition(null);
          void controller.commit();
        };
        const moveDrag = event => {
          const drag = dragRef.current;
          if (!drag || event.pointerId !== drag.id || !trackRef.current) return;
          event.preventDefault();
          const value = pointerPosition(event.clientY - drag.offset, trackRef.current.getBoundingClientRect());
          setDragPosition(value);
          controller.preview(positionToPercent(value));
        };
        const startDrag = event => {
          if (!enabled || event.button !== 0 || event.isPrimary === false || dragRef.current || !trackRef.current) return;
          event.preventDefault();
          event.currentTarget.focus({ preventScroll: true });
          const rect = trackRef.current.getBoundingClientRect();
          const currentCenter = rect.top + (1 - percentToPosition(controller.getSnapshot().percent)) * rect.height;
          const offset = thumbGrabOffset(event.clientY, currentCenter, geometry.hit);
          dragRef.current = { id: event.pointerId, offset };
          event.currentTarget.setPointerCapture(event.pointerId);
          moveDrag(event);
        };
        const onSliderKey = event => {
          if (!enabled || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
          const action = ({ ArrowUp: 'in', ArrowRight: 'in', ArrowDown: 'out', ArrowLeft: 'out' })[event.key];
          if (!action && event.key !== 'Home' && event.key !== 'End') return;
          event.preventDefault();
          event.stopPropagation();
          finishDrag();
          if (action) change(action);
          else void controller.set(event.key === 'Home' ? ZOOM_MIN : ZOOM_MAX);
        };

        React.useLayoutEffect(() => { railRef.current?.focus({ preventScroll: true }); }, []);
        React.useEffect(() => {
          const resize = () => setViewport(old => old.width === window.innerWidth && old.height === window.innerHeight
            ? old : { width: window.innerWidth, height: window.innerHeight });
          const outside = event => {
            if (!panelRef.current?.contains(event.target) && !popup.containsOpener(event.target)) popup.close(false);
          };
          const escape = event => {
            if (event.key !== 'Escape' || event.isComposing) return;
            event.preventDefault(); event.stopPropagation(); popup.close(true);
          };
          const blur = () => popup.close(false);
          window.addEventListener('resize', resize);
          window.addEventListener('blur', blur);
          document.addEventListener('pointerdown', outside, true);
          document.addEventListener('focusin', outside);
          document.addEventListener('keydown', escape, true);
          return () => {
            window.removeEventListener('resize', resize);
            window.removeEventListener('blur', blur);
            document.removeEventListener('pointerdown', outside, true);
            document.removeEventListener('focusin', outside);
            document.removeEventListener('keydown', escape, true);
            // A dismissal during pointer capture still commits the last visible value once.
            if (dragRef.current) { dragRef.current = null; void controller.commit(); }
          };
        }, []);

        return h('div', {
          id: PANEL_ID, ref: panelRef, className: 'dsh-ui-zoom-popup', role: 'dialog', 'aria-label': t('title'),
          style: { left: placement.left, top: placement.top, width: geometry.panelWidth, height: geometry.panelHeight, maxHeight: visibleHeight, zoom: inverseZoom(state.percent) },
          'data-ui-zoom-panel': '1.5.0',
        },
          h('div', { className: 'dsh-ui-zoom-popup-head' },
            h('div', { className: 'dsh-ui-zoom-popup-value', 'aria-hidden': true }, `${formatZoom(state.percent)}%`),
            h('div', { className: 'dsh-ui-zoom-hint', id: `${PANEL_ID}-hint` }, t('dragHint')),
          ),
          // Only the central strip is interactive. Fixed scale labels are its siblings.
          h('div', { className: 'dsh-ui-zoom-well', 'data-neutral': state.percent === 100,
            style: { height: geometry.length + geometry.hit } },
            h('div', {
              ref: railRef, className: 'dsh-ui-zoom-rail', role: 'slider', tabIndex: enabled ? 0 : -1,
              'aria-label': t('title'), 'aria-describedby': `${PANEL_ID}-hint`, 'aria-orientation': 'vertical',
              'aria-valuemin': ZOOM_MIN, 'aria-valuemax': ZOOM_MAX, 'aria-valuenow': state.percent,
              'aria-valuetext': `${formatZoom(state.percent)}%`, 'aria-disabled': !enabled, 'data-dragging': dragPosition !== null,
              title: t('sliderHelp'), style: { width: geometry.hit },
              onPointerDown: startDrag, onPointerMove: moveDrag, onPointerUp: finishDrag,
              onPointerCancel: finishDrag, onLostPointerCapture: finishDrag, onKeyDown: onSliderKey,
            },
              h('div', { ref: trackRef, className: 'dsh-ui-zoom-track', 'aria-hidden': true,
                style: { top: geometry.hit / 2, height: geometry.length, width: geometry.track } },
                h('div', { className: 'dsh-ui-zoom-track-fill', style: { height: `${position * 100}%` } }),
              ),
              h('div', { className: 'dsh-ui-zoom-thumb', 'aria-hidden': true,
                style: { top: center(position), width: geometry.thumb, height: geometry.thumb } },
                h('svg', { className: 'dsh-ui-zoom-grip', viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
                  strokeWidth: 1.5, strokeLinecap: 'round', 'aria-hidden': true, focusable: false },
                  h('path', { d: 'M5 6h6M5 10h6' }),
                ),
              ),
            ),
            h('div', { className: 'dsh-ui-zoom-references', 'aria-hidden': true },
              [
                { id: 'max', value: ZOOM_MAX, position: 1 },
                { id: 'neutral', value: 100, position: neutralPosition },
                { id: 'min', value: ZOOM_MIN, position: 0 },
              ].map(mark => h('div', { key: mark.id, className: 'dsh-ui-zoom-reference', 'data-reference': mark.id,
                style: { top: center(mark.position), left: `calc(50% + ${geometry.hit / 2 + 8}px)` },
              }, `${formatZoom(mark.value)}%`)),
            ),
          ),
          h('button', { type: 'button', className: 'dsh-ui-zoom-popup-reset', title: t('reset'), 'aria-label': t('reset'),
            disabled: !enabled, onClick: () => { finishDrag(); change('reset'); } }, t('resetShort')),
        );
      }

      function Overlay() {
        const state = useZoom();
        const view = usePopup();
        useLocale();
        const [visible, setVisible] = React.useState(false);
        React.useEffect(() => {
          if (state.notice === 0) return;
          setVisible(true);
          const timer = setTimeout(() => setVisible(false), state.error ? 8000 : 2400);
          return () => clearTimeout(timer);
        }, [state.notice, state.error]);
        React.useLayoutEffect(() => { window.dispatchEvent(new Event('resize')); }, [state.percent]);
        const message = state.error ? t(state.ready ? 'error' : 'loading') : text(state);
        return h(React.Fragment, null,
          h('style', { 'data-ui-zoom': 'style-v6' }, STYLE + '\n' + zoomStyle(state.percent)),
          view.open && h(ZoomPanel, { key: view.serial, anchor: view.anchor }),
          visible && (!view.open || state.error) && h('div', { className: 'dsh-ui-zoom-notice', role: 'status', 'aria-live': 'polite', 'aria-atomic': true }, message),
        );
      }

      function ZoomGlyph() {
        return h('svg', { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
          strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false },
          h('circle', { cx: 10, cy: 10, r: 6.5, strokeWidth: 2 }),
          h('path', { d: 'M14.8 14.8 20.6 20.6', strokeWidth: 2.4 }),
        );
      }
      function Toolbar() {
        const state = useZoom();
        const view = usePopup();
        useLocale();
        const buttonRef = React.useRef(null);
        React.useEffect(() => {
          const element = buttonRef.current;
          return () => popup.detach(element);
        }, []);
        return h('button', {
          ref: buttonRef, type: 'button', className: 'dsh-ui-zoom-tool',
          'aria-label': t(view.open ? 'close' : 'open'), 'aria-haspopup': 'dialog', 'aria-expanded': view.open, 'aria-controls': PANEL_ID,
          title: `${t(view.open ? 'close' : 'open')} · ${state.ready ? `${formatZoom(state.percent)}%` : t('loading')}`,
          disabled: !state.ready || !state.writable, onClick: event => popup.toggle(event.currentTarget),
        }, h(ZoomGlyph));
      }
      function SettingsRow() {
        const state = useZoom();
        useLocale();
        const id = React.useId();
        const enabled = state.ready && state.writable;
        const button = (action, label, content, disabled) => h('button', {
          type: 'button', className: 'dsh-ui-zoom-button', title: t(label), 'aria-label': t(label),
          disabled: !enabled || disabled, onClick: () => change(action),
        }, content);
        return h('div', { className: 'dsh-ui-zoom-row' },
          h('div', { className: 'dsh-ui-zoom-copy' },
            h('div', { id, className: 'dsh-ui-zoom-title' }, t('title')),
            h('div', { className: 'dsh-ui-zoom-desc' }, t(!state.ready ? 'loading' : state.persistent === false ? 'localOnly' : 'description')),
          ),
          h('div', { className: 'dsh-ui-zoom-controls', role: 'group', 'aria-labelledby': id },
            button('out', 'decrease', '−', state.percent <= ZOOM_MIN),
            h('output', { className: 'dsh-ui-zoom-value', 'aria-label': t('title'), 'aria-busy': state.pending }, state.ready ? `${formatZoom(state.percent)}%` : '—'),
            button('in', 'increase', '+', state.percent >= ZOOM_MAX),
            button('reset', 'reset', '100%', false),
          ),
          state.error && h('div', { className: 'dsh-ui-zoom-error', role: 'status' }, t(state.ready ? 'error' : 'loading')),
        );
      }

      ctx.effect(() => {
        const mac = ctx.shortcuts.platform === 'macos';
        const onKeyDown = event => {
          const action = zoomAction(event, mac);
          if (action === undefined) return;
          event.preventDefault(); event.stopPropagation();
          if (!event.repeat) change(action);
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
      }, 'ui-zoom: shifted zoom shortcuts');
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'local.ui-zoom:1.5.0', order: 20 }, Overlay));
      ctx.slots.inject('settings.general.item', () => ctx.slots.register({ name: 'settings.general.item', id: 'local.ui-zoom:1.5.0', order: 10.5 }, SettingsRow));
      ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities', id: 'local.ui-zoom.toolbar:1.5.0', order: -10,
      }, Toolbar));
    },
  };
}
