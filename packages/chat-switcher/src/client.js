import { createSwitcher, visit } from './controller.js';
import { createPriorityOrder } from './priorities.js';
import { createRecentVisits } from './recent-visits.js';
import { readCandidates, currentSession, bindKeys } from './adapter.js';
import { CSS_TEXT, HOVER_CSS_TEXT, IMAGE_ACTION_CSS, PULL_CSS_TEXT } from './styles.js';
import { bindPullGesture, bindDismissGesture, browseKey, createSwipeDiagnostics, PULL_THRESHOLD } from './pull.js';
import { captureCurtain, captureCardCurtain, bindCurtain, CURTAIN_CSS } from './transition.js';
import { createSessionActions, createSessionMenu, SESSION_MENU_CSS } from './session-menu.js';
import { bindModalAreaStyle, createModalAreaTracker } from './modal-area.js';
import { tensionModel, TENSION_CSS } from './tension.js';
import { getMosaicCanvasColor } from './mosaic.js';
import { getMosaicArtStore, disposeMosaicArtRuntime, getMosaicArtHealth } from './art-store.js';
import { bindComposerSpacing, composerIdentityCss, composerMenuVisibilityCss, readComposerAppearance } from './composer.js';
import { chatBackdropCss } from './backdrop.js';
import { createChatThemeSource, createChatPaletteRuntime, readChatPaletteSource } from './palette-runtime.js';
import { getRasterWallpaperStore } from './raster.js';
import { createIdentityClient, IDENTITY_ENDPOINT } from './identity.js';
import { chatIndicator, liveInteractionKind } from './status.js';
import { readCardMeta } from './card-meta.js';
import { createWorkspaceColorBridge, workspaceColor, workspaceTintStyle, WORKSPACE_TINT_CSS } from './workspace-tint.js';
import { bindTaskFit, TASK_FIT_CSS, TASK_SHADOW_COLOR } from './task-fit.js';
import { bindComposerDoubleActivation } from './double-activation.js';

export function createPlugin(React) {
  const h = React.createElement;
  const NS = 'chat-switcher';
  let tensionSerial = 0;
  const { SessionMenu, useCardContext } = createSessionMenu(React);
  const emptyMenuRows = Object.freeze([]);
  const emptyMenuSource = { getSnapshot: () => emptyMenuRows, subscribe: () => () => {} };
  const DICTS = {
    ru: { title: 'Переключение чатов', enabled: 'Ctrl+Tab между закреплёнными, работающими и требующими внимания чатами', delay: 'Задержка превью (мс)', hint: 'Короткое Ctrl+Tab — самый приоритетный чат после текущего. Удерживайте Ctrl для превью; Tab — дальше, Shift+Tab — назад. Отпустите Ctrl для перехода, Esc — отмена.', preview: 'Превью без загрузки истории: папка проекта и текущее состояние. Полные заголовки переносятся. Порядок: текущий чат → запросы и вопросы → ошибки → готовая работа → остальные по последнему посещению. Внутри событийных групп раньше появившиеся идут первыми.', desktop: 'Только Desktop. В браузере Ctrl+Tab остаётся браузеру.', save: 'Сохранить', saved: 'Сохранено', error: 'Не удалось сохранить. Повторите попытку.', openError: 'Не удалось открыть чат', loading: 'Настройки загружаются…', pinned: 'Закреплён', candidates: 'Переключение чатов', unread: 'Непрочитанное завершение', failed: 'Ошибка', running: 'Работает', idle: 'Ожидает', attention: 'Нужно внимание', approval: 'Запрос доступа', question: 'Нужен ответ', 'plan-review': 'Нужно проверить план', completion: 'Готово', bell: 'Оповещение активно', silent: 'Без повторов', folder: 'Папка не задана', noBridge: 'Состояние звуковых оповещений недоступно', none: 'Нет подходящих чатов' },
    en: { title: 'Chat switcher', enabled: 'Ctrl+Tab between pinned, working and attention chats', delay: 'Preview delay (ms)', hint: 'Quick Ctrl+Tab: the highest-priority chat after the current one. Hold Ctrl for previews; Tab: next, Shift+Tab: previous. Release Ctrl to open, Esc to cancel.', preview: 'Lightweight previews use the project folder and live status; no history is loaded. Full titles wrap. Order: current chat, requests/questions, errors, completed work, then remaining chats by last visit. Earlier events come first within each event group.', desktop: 'Desktop only. In a browser, Ctrl+Tab belongs to the browser.', save: 'Save', saved: 'Saved', error: 'Could not save. Please retry.', openError: 'Could not open chat', loading: 'Loading settings…', pinned: 'Pinned', candidates: 'Chat switcher', unread: 'Unread completion', failed: 'Error', running: 'Working', idle: 'Idle', attention: 'Needs attention', approval: 'Access request', question: 'Answer needed', 'plan-review': 'Plan review needed', completion: 'Done', bell: 'Notification active', silent: 'No reminders', folder: 'No project folder', noBridge: 'Sound notification state unavailable', none: 'No eligible chats' },
  };
  for (const [locale, words] of Object.entries({
    ru: { paletteHint: 'Акцентные цвета интерфейса следуют рисунку активного чата. Цвета ошибок, предупреждений и успеха остаются штатными. Флажок ниже управляет только Ctrl+Tab.', imageChange: 'Изменить рисунок и цвета чата', imageBusy: 'Меняю изображение…', imageRenderFallback: 'Фрактальная заливка недоступна — показана базовая мозаика', imageConnecting: 'Изображения чатов: нет связи с сервером', imageError: 'Не удалось изменить изображение', paletteFallback: 'Акцентная палитра недоступна — используются штатные цвета' },
    en: { paletteHint: 'Interface accent colors follow the active chat image. Error, warning and success colors stay unchanged. The checkbox below controls Ctrl+Tab only.', imageChange: 'Change chat image and colors', imageBusy: 'Changing image…', imageRenderFallback: 'Fractal fill unavailable — showing the base mosaic', imageConnecting: 'Chat images: server disconnected', imageError: 'Could not change chat image', paletteFallback: 'Accent palette unavailable — using the original theme colors' },
  })) Object.assign(DICTS[locale], words);
  Object.assign(DICTS.ru, { pullEnabled: 'Свайпы: выбор чата и быстрый переход', close: 'Закрыть', touchHint: 'В чате свайп справа налево открывает превью без выделения. Слева направо показывает рисунок следующего по приоритету чата и при отпускании переключает на него без окна. В модалке свайп слева направо или «Закрыть» возвращает в текущий чат. Короткий свайп или откат отменяет действие. Вертикальная прокрутка остаётся обычной.', desktop: 'Ctrl+Tab доступен только в Desktop; жесты работают и в браузере на телефоне.', paletteHint: 'Акцентные цвета интерфейса следуют рисунку активного чата. Цвета ошибок, предупреждений и успеха остаются штатными. Флажки ниже отдельно управляют Ctrl+Tab и жестами.' });
  Object.assign(DICTS.en, { pullEnabled: 'Swipes: chat previews and quick switching', close: 'Close', touchHint: 'In a chat, swipe right to left to open unselected previews. Swipe left to right to preview the next-priority chat image and switch to it on release without a dialog. In the dialog, swipe left to right or use Close to return to the current chat. A short swipe or reversal cancels. Vertical scrolling stays native.', desktop: 'Ctrl+Tab is Desktop only; swipe gestures also work in a phone browser.', paletteHint: 'Interface accent colors follow the active chat image. Error, warning and success colors stay unchanged. The checkboxes below control Ctrl+Tab and swipe gestures separately.' });
  Object.assign(DICTS.ru, { newSession: 'New Session', sessionActions: 'Действия чата', actionsLoading: 'Загрузка действий…', actionsNone: 'Нет доступных действий', actionsFailed: 'Не удалось загрузить действия чата' });
  Object.assign(DICTS.en, { newSession: 'New Session', sessionActions: 'Session actions', actionsLoading: 'Loading actions…', actionsNone: 'No actions available', actionsFailed: 'Could not load session actions' });
  Object.assign(DICTS.ru, { defaultWorkspace: 'Рабочая область по умолчанию', ungrouped: 'Разгруппировано', preview: 'Превью без загрузки истории: Workspace над изображением, название чата под ним, первая TODO-задача в работе сверху внутри картинки, статусы снизу. Если список TODO пуст или отсутствует, показывается последняя доступная цель этого чата. Приоритеты и переходы остаются прежними.' });
  Object.assign(DICTS.en, { defaultWorkspace: 'Default workspace', ungrouped: 'Ungrouped', preview: 'Lightweight previews show the Workspace above the image, chat title below, the first in-progress TODO at the top of the image, and statuses at its bottom. If the TODO list is empty or absent, show this chat’s latest available goal. Ordering and switching stay unchanged.' });
  const CSS = CSS_TEXT + HOVER_CSS_TEXT + IMAGE_ACTION_CSS + PULL_CSS_TEXT + TENSION_CSS + CURTAIN_CSS + SESSION_MENU_CSS + TASK_FIT_CSS + WORKSPACE_TINT_CSS + `
.cs-new-session{display:flex;align-items:center;justify-content:center;gap:8px;flex:1;min-height:44px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:10px 14px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-weight:600;cursor:pointer}
.cs-new-session:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.cs-new-session:disabled{opacity:.5;cursor:default}
.cs-new-session svg{width:18px;height:18px;flex:none}
.cs-sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.cs-workspace-name{margin:0 0 8px;font-size:.85em;font-weight:600;line-height:1.35;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.cs-dialog .cs-preview-content{position:absolute;inset:0;height:auto;gap:8px;justify-content:space-between}
.cs-preview-statuses{display:flex;flex-wrap:wrap;align-items:flex-end;gap:5px;margin-top:auto;min-width:0}
.cs-dialog .cs-preview-statuses>:is(.cs-state,.cs-preview-tag){margin:0;padding:5px 7px;border-radius:6px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 60%,transparent);color:var(--dsw-alias-label-primary);font-size:11px;line-height:1.3;max-width:100%;overflow-wrap:anywhere}
.cs-preview-statuses .cs-preview-tag{display:inline-flex;gap:3px;align-items:center}
`;

  function Settings({ settingsForm: form, t }) {
    const snapshot = React.useSyncExternalStore(form.subscribe, form.getSnapshot);
    const [draft, setDraft] = React.useState(null);
    const [busy, setBusy] = React.useState(false);
    const [message, setMessage] = React.useState('');
    const baseline = React.useRef(null);
    const value = draft ?? snapshot.value ?? { enabled: true, delayMs: 250 };
    const change = patch => { if (draft === null) baseline.current = snapshot.revision; setDraft({ ...value, ...patch }); setMessage(''); };
    const valid = Number.isInteger(value.delayMs) && value.delayMs >= 0 && value.delayMs <= 2000;
    const save = async () => {
      setBusy(true); setMessage('');
      try {
        if (!await form.mutate(Object.entries(value).map(([key, value]) => ({ op: 'set', path: [key], value })), baseline.current)) throw new Error('conflict');
        setDraft(null); setMessage('saved');
      } catch { baseline.current = form.getSnapshot().revision; setMessage('error'); }
      finally { setBusy(false); }
    };
    return h('section', { className: 'cs-settings' }, h('style', null, CSS), h('h3', null, t('title')),
      h('p', null, t('hint')), h('p', null, t('touchHint')), h('p', null, t('preview')), h('p', null, t('paletteHint')), h('p', null, t('desktop')),
      h('label', null, h('input', { type: 'checkbox', checked: value.enabled, disabled: busy || !snapshot.writable, onChange: e => change({ enabled: e.target.checked }) }), ' ', t('enabled')),
      h('label', null, h('input', { type: 'checkbox', checked: value.pullEnabled !== false, disabled: busy || !snapshot.writable, onChange: e => change({ pullEnabled: e.target.checked }) }), ' ', t('pullEnabled')),
      h('label', null, t('delay'), h('input', { type: 'number', min: 0, max: 2000, step: 1, value: value.delayMs, disabled: busy || !snapshot.writable, onChange: e => change({ delayMs: e.target.value === '' ? '' : Number(e.target.value) }) })),
      h('button', { type: 'button', disabled: busy || !valid || draft === null || !snapshot.writable, onClick: save }, t('save')),
      h('p', { role: 'status' }, snapshot.status !== 'ready' ? t('loading') : message ? t(message) : ''));
  }
  function PluginSettings(props) { return props.view === 'summary' ? props.t('preview') : h(Settings, props); }
  function useImageSeed(identities, sessionId) {
    return React.useSyncExternalStore(identities.subscribe, () => identities.seed(sessionId));
  }
  const emptyArtSnapshot = Object.freeze({ uri: '', color: null, status: 'legacy' });
  const emptyArtStore = { getSnapshot: () => emptyArtSnapshot, subscribe: () => () => {} };
  function useMosaicArt(seed) {
    const store = React.useMemo(() => typeof seed === 'string' && seed ? getMosaicArtStore(seed) : emptyArtStore, [seed]);
    return React.useSyncExternalStore(store.subscribe, store.getSnapshot);
  }
  const currentArtUri = seed => getMosaicArtStore(seed).getSnapshot().uri;
  function ComposerIdentity({ sessionId, identities }) {
    const seed = useImageSeed(identities, sessionId);
    const art = useMosaicArt(seed);
    const wallpaperStore = React.useMemo(() => getRasterWallpaperStore(seed), [seed]);
    const wallpaper = React.useSyncExternalStore(wallpaperStore.subscribe, wallpaperStore.getSnapshot);
    const css = React.useMemo(() => composerIdentityCss(sessionId, seed, art.uri) + composerMenuVisibilityCss(sessionId) + chatBackdropCss(sessionId, wallpaper, seed), [sessionId, seed, art.uri, wallpaper]);
    const styleRef = React.useRef(null);
    React.useLayoutEffect(() => bindComposerSpacing(styleRef.current), [sessionId]);
    return css ? h('style', { ref: styleRef, 'data-cs-composer-image': sessionId, 'data-cs-wallpaper-kind': wallpaper?.kind }, css) : null;
  }
  function ActiveChatPalette({ source, identities, themeSource, paletteRuntime }) {
    const sessionId = React.useSyncExternalStore(source.subscribe, () => source.getSnapshot().currentId);
    const seed = useImageSeed(identities, sessionId);
    const color = React.useMemo(() => sessionId ? getMosaicCanvasColor(seed) : null, [sessionId, seed]);
    const theme = React.useSyncExternalStore(themeSource.subscribe, themeSource.getSnapshot);
    const [applied, setApplied] = React.useState(paletteRuntime.getSnapshot);
    const styleRef = React.useRef(null);
    const probeRef = React.useRef(null);
    React.useLayoutEffect(() => {
      // A local layout-effect update also covers the first mount, before an
      // external-store passive subscription exists, without a native-color flash.
      setApplied(paletteRuntime.update(color, () => readChatPaletteSource({ view: window, body: document.body, styleElement: styleRef.current, probe: probeRef.current })));
    }, [paletteRuntime, color, theme]);
    React.useLayoutEffect(() => () => paletteRuntime.update(null), [paletteRuntime]);
    return h(React.Fragment, null,
      h('style', { ref: styleRef, 'data-cs-chat-palette': '1.16.1', 'data-cs-palette-status': applied.status, 'data-cs-palette-chat': sessionId ?? '', 'data-cs-palette-colors': applied.count, 'data-cs-palette-y-error': applied.maxYError }, applied.css),
      h('span', { ref: probeRef, hidden: true, 'aria-hidden': true, 'data-cs-palette-probe': true }));
  }
  function MosaicImage({ sessionId, identities }) {
    const seed = useImageSeed(identities, sessionId);
    const src = useMosaicArt(seed).uri;
    return h('img', { className: 'cs-mosaic', src, alt: '', 'aria-hidden': true, draggable: false, decoding: 'async', loading: 'lazy' });
  }
  function ImagePalette({ sessionId, identities, paletteRuntime, t, blank = false }) {
    const view = React.useSyncExternalStore(identities.subscribe, identities.getSnapshot);
    const palette = React.useSyncExternalStore(paletteRuntime.subscribe, paletteRuntime.getSnapshot);
    const art = useMosaicArt(useImageSeed(identities, sessionId));
    const busy = view.busy.has(sessionId) || art.status === 'pending';
    const error = view.errors.get(sessionId);
    const actionTitle = busy ? t('imageBusy') : view.status !== 'ready' ? t('imageConnecting') : t('imageChange');
    const title = actionTitle + (palette.status === 'fallback' ? '\n' + t('paletteFallback') : '') + (art.status === 'fallback' ? '\n' + t('imageRenderFallback') : '');
    return h('span', { className: 'cs-image-action' + (blank ? ' cs-blank-image-action' : '') },
      h('style', null, IMAGE_ACTION_CSS),
      h('button', { type: 'button', className: 'cs-image-palette', title, 'aria-label': t('imageChange'), 'aria-busy': busy, disabled: busy || view.status !== 'ready', onClick: () => { void identities.regenerate(sessionId, view.records.get(sessionId)?.salt ?? null, view.records.get(sessionId)?.variant ?? 'legacy').catch(() => {}); } },
        h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
          h('path', { d: 'M12 3a9 9 0 1 0 0 18h1.4c1.5 0 2.2-1.8 1.1-2.8l-.6-.5a1.5 1.5 0 0 1 1-2.7H17a4 4 0 0 0 4-4c0-4.4-4-8-9-8Z' }),
          ...[[7,10.5],[10,7],[14.5,7.2],[17,10.5]].map(([cx,cy],index) => h('circle', { key:index, cx, cy, r:1, fill:'currentColor', stroke:'none' })))),

      error && h('span', { className: 'cs-image-error', role: 'alert' }, t('imageError'), ': ', error));
  }
  function BlankImagePalette({ source, identities, paletteRuntime, t }) {
    const view = React.useSyncExternalStore(source.subscribe, source.getSnapshot);
    const current = Object.values(view.byId).find(row => (row.retainedBy?.mainView ?? 0) > 0);
    return current?.blank === true ? h(ImagePalette, { sessionId: current.id, identities, paletteRuntime, t, blank: true }) : null;
  }
  function StatusDot({ state, t, row = false }) {
    const label = t(state.kind) + (state.reminderActive ? ' · ' + t('bell') : '');
    return h('span', { className: row ? 'cs-row-indicator' : 'cs-indicator', 'data-state': state.kind, role: row ? 'img' : undefined, title: label, 'aria-label': row ? label : undefined },
      h('span', { className: 'cs-status-dot', 'data-state': state.kind, 'aria-hidden': true }),
      !row && h('span', null, t(state.kind)), state.reminderActive && h('span', { className: 'cs-reminder', 'aria-hidden': true }, '♬'));
  }
  function TaskLabel({ text }) {
    const frame = React.useRef(null), label = React.useRef(null);
    React.useLayoutEffect(() => bindTaskFit({ frame: frame.current, text: label.current, view: window, document }), [text]);
    return h('div', { className: 'cs-task-area', title: text },
      h('div', { className: 'cs-task-fit', ref: frame,
        onPointerDown: event => { if (event.currentTarget.dataset.taskOverflow === 'true') event.stopPropagation(); },
        onClick: event => { if (event.currentTarget.dataset.taskOverflow === 'true') event.stopPropagation(); },
        onKeyDown: event => { if (event.currentTarget.dataset.taskOverflow === 'true') event.stopPropagation(); } }, 
        h('span', { className: 'cs-active-task', ref: label }, text)));
  }
  // One shared card for the keyboard overlay and native Workspace hover cards.
  function ChatCard({ item, state, t, identities, workspaceColors, hover = false, cardMeta, onContext, previewRef, ...props }) {
    const press = useCardContext({ onOpen: onContext });
    const colors = React.useSyncExternalStore(workspaceColors.subscribe, workspaceColors.getSnapshot);
    const workspaceId = cardMeta?.workspaceId ?? null;
    const color = workspaceColor(colors, workspaceId);
    const workspace = cardMeta?.workspaceTitle === 'default-workspace' ? t('defaultWorkspace') : cardMeta?.workspaceTitle || t('ungrouped');
    return h('div', { ...props, ...press, 'data-cs-context-card': typeof onContext === 'function' ? '' : undefined, className: hover ? 'cs-card cs-hover-card' : 'cs-card', 'data-state': state.kind, 'data-workspace-id': workspaceId ?? undefined, 'data-cs-workspace-tinted': color ? 'true' : undefined, style: workspaceTintStyle(color), ...(hover ? { 'data-no-attention-ack': '' } : {}) },
      !hover && h('div', { className: 'cs-workspace-name', title: workspace }, workspace),
      h('div', { className: 'cs-preview', ref: previewRef },
        h(MosaicImage, { sessionId: item.id, identities }),
        !hover && h('div', { className: 'cs-mosaic-shade', 'aria-hidden': true }),
        h('div', { className: 'cs-preview-content' },
          !hover && cardMeta?.activeTask && h(TaskLabel, { text: cardMeta.activeTask }),
          hover ? h('span', { className: 'cs-state' }, h(StatusDot, { state, t }))
          : h('div', { className: 'cs-preview-statuses' },
            h('span', { className: 'cs-state' }, h(StatusDot, { state, t })),
            item.pinned && h('span', { className: 'cs-preview-tag', role: 'img', title: t('pinned'), 'aria-label': t('pinned') }, '⌖')))),
      h('div', { className: 'cs-title' }, item.title || item.displayTitle || item.id),
      hover && h('div', { className: 'cs-badges' }, item.pinned && h('span', null, '⌖ ', t('pinned')), state.reminderActive && h('span', null, '♬ ', t('bell'))));
  }
  function HoverPreview({ sessionId, source, identities, workspaceColors, t }) {
    const view = React.useSyncExternalStore(source.subscribe, source.getSnapshot);
    // Hover works for every sidebar chat, including idle/unpinned and archived;
    // it must not expand the root-only Ctrl+Tab candidate set or open the session.
    const row = view.byId[sessionId];
    if (!row) return null; // Keep the native fallback when metadata disappeared.
    const item = { ...row, pinned: view.pinnedIds.has(sessionId) };
    const state = chatIndicator(item, view.status.get(sessionId), view.attention.get(sessionId));
    const cardMeta = readCardMeta({ byId: view.byId }, { items: view.workspaceItems }, [sessionId]).get(sessionId);
    return h(ChatCard, { item, state, t, identities, workspaceColors, cardMeta, hover: true });
  }
  function RowBadge({ sessionId, source, t }) {
    const view = React.useSyncExternalStore(source.subscribe, source.getSnapshot);
    const item = view.items.find(row => row.id === sessionId) ?? {};
    const state = chatIndicator(item, view.status.get(sessionId), view.attention.get(sessionId));
    return state.kind === 'idle' ? null : h(StatusDot, { state, t, row: true });
  }
  function CircleGlyph({ model, image }) {
    const clip = React.useRef(null);
    if (clip.current === null) clip.current = 'cs-tension-image-' + (++tensionSerial);
    return h(React.Fragment, null,
      h('circle', { className: 'cs-tension-head', r: 27 }),
      h('circle', { className: 'cs-tension-track', r: 29 }),
      h('circle', { className: 'cs-tension-progress', r: 29, strokeDasharray: model.dash, transform: 'rotate(-90)' }),
      image ? h(React.Fragment, null,
        h('defs', null, h('clipPath', { id: clip.current }, h('circle', { r: 24 }))),
        h('image', { href: image, x: -24, y: -24, width: 48, height: 48, clipPath: 'url(#' + clip.current + ')', preserveAspectRatio: 'xMidYMid slice' }))
      : h(React.Fragment, null,
        h('rect', { className: 'cs-tension-window', x: -16, y: -14, width: 32, height: 28, rx: 4 }),
        h('path', { className: 'cs-tension-window', d: 'M-16-6H16' }),
        ...[[-10,-2],[4,-2],[-10,6],[4,6]].map(([x,y]) => h('rect', { key: x + ':' + y, className: 'cs-tension-tile', x, y, width: 6, height: 6, rx: 1 }))));
  }
  function TensionIndicator({ progress, side, image }) {
    if (!progress) return null;
    const model = tensionModel(progress.distance, progress.ready);
    const headX = side === 'right' ? 140 - model.reach : model.reach;
    return h('div', { className: 'cs-tension', 'data-side': side, 'data-ready': progress.ready, 'data-glyph': image ? 'chat-image' : 'preview-window', 'data-chat-switcher': '', 'data-no-attention-ack': '', 'aria-hidden': true, style: { opacity: model.opacity } },
      h('svg', { className: 'cs-tension-head-svg', viewBox: '0 0 140 176', focusable: false },
        h('g', { transform: 'translate(' + headX + ' 88) scale(' + model.scale + ')' }, h(CircleGlyph, { model, image }))));
  }
  function supportsCurtainLayer() { return typeof window.HTMLElement?.prototype?.showPopover === 'function'; }
  function Curtain({ curtain, onDone }) {
    const host = React.useRef(null), bubble = React.useRef(null);
    React.useLayoutEffect(() => {
      if (!curtain) return;
      return bindCurtain({ host: host.current, bubble: bubble.current, view: window, circle: curtain.circle, target: curtain.target, shape: curtain.shape, radius: curtain.radius, crop: curtain.crop, onDone: () => onDone(curtain.id) });
    }, [curtain, onDone]);
    if (!curtain) return null;
    return h('div', { ref: host, className: 'cs-curtain', popover: supportsCurtainLayer() ? 'manual' : undefined, 'data-cs-curtain': '', 'data-chat-switcher': '', 'data-no-attention-ack': '', 'aria-hidden': true },
      h('div', { ref: bubble, className: 'cs-curtain-bubble', 'data-shape': curtain.shape ?? 'circle' },
        curtain.shape === 'card'
          ? h(React.Fragment, null, h('img', { className: 'cs-mosaic', src: curtain.image, alt: '', draggable: false }), h('div', { className: 'cs-mosaic-shade' }))
          : h('svg', { viewBox: '-32 -32 64 64', focusable: false }, h(CircleGlyph, { model: tensionModel(PULL_THRESHOLD, true), image: curtain.image }))));
  }
  function PullFrame({ children, pull, identities }) {
    const frame = React.useRef(null);
    const area = React.useRef(null);
    const currentId = React.useSyncExternalStore(pull.subscribe, pull.getSession);
    const [progress, setProgress] = React.useState(null);
    const targetId = progress?.action === 'quick' ? progress.targetId : null;
    const targetSeed = useImageSeed(identities, targetId);
    const targetArt = useMosaicArt(targetSeed);
    const targetImage = targetId ? targetArt.uri : null;
    React.useLayoutEffect(() => {
      const offGesture = bindPullGesture({ target: frame.current, document, view: window, ...pull, changed: setProgress,
        beforeComplete: context => captureCurtain({ owner: frame.current?.querySelector('.cs-tension'), area: area.current, view: window,
          distance: context.distance, side: context.action === 'quick' ? 'left' : 'right',
          image: context.action === 'quick' && context.targetId ? currentArtUri(identities.seed(context.targetId)) : null }),
      });
      const offObserve = pull.observeFrame(frame.current);
      return () => { offGesture(); offObserve(); };
    }, [pull, identities]);
    React.useLayoutEffect(() => pull.observeArea(frame.current, area.current), [pull, currentId]);
    return h('div', { ref: frame, className: 'cs-pull-frame', 'data-cs-pull-frame': '' },
      children,
      h('div', { ref: area, className: 'cs-modal-area', 'data-cs-modal-area': '', 'aria-hidden': true }),
      h(TensionIndicator, { progress, side: progress?.action === 'quick' ? 'left' : 'right', image: targetImage }));
  }
  function Overlay({ source, identities, workspaceColors, cancel, open, controller, swipeDiagnostics, startCurtain, finishCurtain, canDismiss, openContext, closeContext, performContextAction, newSession, registerSelectionCapture, t, useRemoteAccess = () => true }) {
    const view = React.useSyncExternalStore(source.subscribe, source.getSnapshot);
    const dialog = React.useRef(null);
    const list = React.useRef(null);
    const previews = React.useRef(null);
    if (previews.current === null) previews.current = new Map();
    const snapshotCard = id => {
      try { return captureCardCurtain({ preview: previews.current.get(id), clip: list.current, view: window, image: currentArtUri(identities.seed(id)) }); }
      catch { return null; }
    };
    const previewRefFor = id => {
      let attached = null;
      return node => {
        if (node) { attached = node; previews.current.set(id, node); }
        else if (previews.current.get(id) === attached) previews.current.delete(id);
      };
    };
    React.useLayoutEffect(() => registerSelectionCapture(snapshotCard), [registerSelectionCapture, identities]);
    const [dismiss, setDismiss] = React.useState(null);
    const [areaStyle, setAreaStyle] = React.useState(null);
    const visible = !!view.cycle?.visible;
    const browsing = visible && view.cycle.mode === 'browse';
    const curtain = h(Curtain, { curtain: view.curtain, onDone: finishCurtain });
    const popoverCurtain = supportsCurtainLayer();
    const canCreate = useRemoteAccess('session/create') !== false;
    const menuSource = view.contextMenu?.occurrence?.source ?? emptyMenuSource;
    const menuRows = React.useSyncExternalStore(menuSource.subscribe, menuSource.getSnapshot);
    const menuModel = React.useMemo(() => view.contextMenu ? { id: view.contextMenu.token, anchor: view.contextMenu.anchor, actions: menuRows } : null, [view.contextMenu?.token, view.contextMenu?.anchor, menuRows]);
    const chooseAction = actionId => {
      if (!['session.pin/pin','session.id/copy'].includes(actionId)) {
        if (dialog.current?.open) dialog.current.close();
        controller.abort();
      }
      performContextAction(actionId);
    };
    const currentSeed = useImageSeed(identities, view.currentId);
    const dismissArt = useMosaicArt(browsing && dismiss && view.currentId ? currentSeed : null);
    const dismissImage = browsing && dismiss && view.currentId ? dismissArt.uri : null;
    React.useLayoutEffect(() => {
      if (!browsing) return;
      return bindDismissGesture({ target: dialog.current, document, view: window, canClose: canDismiss,
        beforeComplete: context => captureCurtain({ owner: dialog.current?.querySelector('.cs-tension'), area: dialog.current, view: window, distance: context.distance, side: 'left', image: view.currentId ? currentArtUri(identities.seed(view.currentId)) : null }),
        close: prepared => { startCurtain(prepared); controller.abort(); }, changed: setDismiss, trace: event => swipeDiagnostics.trace('dismiss', event) });
    }, [browsing, controller, swipeDiagnostics, startCurtain, canDismiss, identities, view.currentId]);
    React.useLayoutEffect(() => {
      const node = dialog.current;
      if (!node || !visible) return;
      if (!node.open) node.showModal();
      list.current?.focus({ preventScroll: true });
      return () => { if (node.open) node.close(); };
    }, [visible]);
    React.useLayoutEffect(() => {
      if (!visible || !dialog.current) return;
      return bindModalAreaStyle({ view: window, getArea: () => view.modalArea, changed: setAreaStyle,
        getZoom: () => {
          const nativeZoom = dialog.current?.currentCSSZoom;
          return Number.isFinite(nativeZoom) && nativeZoom > 0 ? nativeZoom : Number.parseFloat(window.getComputedStyle(document.documentElement).zoom) || 1;
        },
      });
    }, [visible, view.modalArea]);
    React.useLayoutEffect(() => {
      if (visible) list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }, [visible, view.cycle?.index, view.cycle?.keyboardSelection, areaStyle]);
    const selected = view.cycle?.keyboardSelection === true ? view.cycle.items[view.cycle.index] : undefined;
    return h(React.Fragment, null, h('style', { 'data-chat-switcher-version': '1.16.1' }, CSS),
      view.error && h('div', { className: 'cs-error', role: 'alert', 'data-chat-switcher': '' }, t('openError')),
      (popoverCurtain || !visible) && curtain,
      visible && h('dialog', { ref: dialog, className: 'cs-dialog' + (areaStyle ? ' cs-chat-area' : ''), style: areaStyle ?? undefined, role: 'dialog', 'data-shortcut-modal': visible ? NS : undefined, 'data-chat-switcher': '', 'data-no-attention-ack': '', 'data-cs-mode': view.cycle.mode, 'aria-modal': visible ? true : undefined, 'aria-labelledby': 'cs-title', onCancel: e => { e.preventDefault(); cancel(); }, onClick: e => { if (e.target === dialog.current) cancel(); } },
        !popoverCurtain && curtain,
        h('header', null, h('h2', { id: 'cs-title', className: 'cs-sr-only' }, t('candidates')),
          h('button', { type: 'button', className: 'cs-new-session', disabled: !canCreate, onClick: () => { if (!canCreate) return; if (dialog.current?.open) dialog.current.close(); newSession(); } },
            h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, 'aria-hidden': true }, h('circle', { cx: 12, cy: 12, r: 8 }), h('path', { d: 'M12 8v8M8 12h8' })), t('newSession')),
          browsing && h('button', { type: 'button', className: 'cs-close', onClick: cancel }, t('close'))),
        browsing && h(TensionIndicator, { progress: dismiss, side: 'left', image: dismissImage }),
        h('div', { className: 'cs-grid', role: 'listbox', tabIndex: 0, ref: list, onKeyDown: e => { if (view.cycle.mode === 'browse') browseKey(e, controller, view.cycle.items.length); }, 'aria-label': t('candidates'), 'aria-activedescendant': selected ? 'cs-option-' + selected.id : undefined },
          ...(view.cycle?.items ?? []).map((frozen, index) => {
            const item = view.items.find(row => row.id === frozen.id) ?? frozen;
            const attention = view.attention.get(item.id);
            const status = view.status.get(item.id);
            const state = chatIndicator(item, status, attention);
            return h(ChatCard, { key: item.id, item, state, t, identities, workspaceColors, cardMeta: view.cardMeta.get(item.id), id: 'cs-option-' + item.id, role: 'option', 'aria-selected': view.cycle.keyboardSelection === true && index === view.cycle.index, previewRef: previewRefFor(item.id), onClick: () => open(item.id, snapshotCard(item.id)), onContext: point => openContext(item.id, point) });
          })),
        !view.bridge && h('p', { className: 'cs-note', role: 'status' }, t('noBridge'))),
      h(SessionMenu, { model: menuModel, onClose: closeContext, onAction: chooseAction, busy: !!view.contextMenu && !view.contextMenu.ready, error: view.contextMenu?.error ? t('actionsFailed') : '', t }));
  }
  return {
    inject: ['slots', 'locale', 'sessions', 'workspaces', 'uiWorkspace', 'uiSession', 'layout', 'configForms', 'connection', 'theme', 'contextMenus'],
    apply(ctx) {
      ctx.effect(() => bindComposerDoubleActivation({ document, getSession: () => currentSession(ctx.sessions) }));
      for (const [locale, dict] of Object.entries(DICTS)) ctx.effect(() => ctx.locale.register(NS, locale, dict));
      const form = ctx.configForms.get(NS);
      const sessionActions = createSessionActions({ contextMenus: ctx.contextMenus, uiWorkspace: ctx.uiWorkspace, workspaces: ctx.workspaces });
      const rpc = ctx.connection?.rpc;
      ctx.effect(() => () => disposeMosaicArtRuntime());
      const identities = createIdentityClient({ call: rpc ? (payload, signal) => rpc.call('/api', IDENTITY_ENDPOINT, payload, signal) : undefined });
      ctx.effect(() => { identities.start(); return () => identities.stop(); });
      const noTheme = Object.freeze({ revision: 0 });
      const themeSource = createChatThemeSource({ read: () => ctx.theme?.getTheme?.() ?? noTheme, listen: listener => ctx.on?.('theme/change', listener) ?? (() => {}) });
      const paletteRuntime = createChatPaletteRuntime({ onError: message => console.warn('[chat-switcher] ' + message) });
      ctx.effect(() => () => { themeSource.dispose(); paletteRuntime.dispose(); });
      const workspaceColors = createWorkspaceColorBridge();
      ctx.effect(() => () => workspaceColors.dispose());
      // Only this child scope depends on the optional provider. The switcher,
      // its frozen cycle and all native actions survive provider unload/reload.
      ctx.inject?.(['workspaceColorSource'], scope => {
        scope.effect(() => workspaceColors.connect(scope.get('workspaceColorSource')), 'chat-switcher: optional Workspace colors');
      });
      let view = { cycle: null, curtain: null, contextMenu: null, modalArea: null, currentId: null, items: [], byId: {}, workspaceItems: [], cardMeta: new Map(), pinnedIds: new Set(), status: new Map(), attention: new Map(), bridge: false, error: false };
      const listeners = new Set();
      const source = { getSnapshot: () => view, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } };
      const publish = patch => { view = { ...view, ...patch }; for (const listener of listeners) listener(); };
      let controller;
      let alive = true, curtainSerial = 0, menuSerial = 0;
      let selectionCapture = null;
      const registerSelectionCapture = capture => {
        selectionCapture = capture;
        return () => { if (selectionCapture === capture) selectionCapture = null; };
      };
      const startCurtain = prepared => {
        if (!alive) return;
        const circle = prepared?.circle;
        if (!circle || ![circle.left,circle.top,circle.width,circle.height].every(Number.isFinite) || circle.width <= 0 || circle.height <= 0) return;
        const target = view.modalArea;
        // Freeze the destination before abort/navigation can replace the chat HOC.
        const validTarget = target && [target.left,target.top,target.width,target.height].every(Number.isFinite) && target.width > 0 && target.height > 0;
        publish({ curtain: { id: ++curtainSerial, circle: { ...circle }, target: validTarget ? { ...target } : null, shape: prepared.shape === 'card' ? 'card' : 'circle', radius: Number.isFinite(prepared.radius) ? prepared.radius : 0, crop: prepared.crop ? { ...prepared.crop } : null, image: typeof prepared.image === 'string' ? prepared.image : null } });
      };
      const finishCurtain = id => { if (alive && view.curtain?.id === id) publish({ curtain: null }); };
      const canDismiss = () => view.contextMenu === null;
      const closeContext = () => {
        const menu = view.contextMenu;
        if (!menu) return;
        publish({ contextMenu: null }); menu.occurrence?.dispose();
      };
      ctx.effect(() => () => view.contextMenu?.occurrence?.dispose());
      const openContext = (id, point) => {
        if (!view.cycle?.visible || view.contextMenu?.id === id) return;
        const item = readEligible().find(row => row.id === id);
        if (!item) return;
        closeContext(); controller.browse({ pointer: true });
        let occurrence = null, error = false;
        try { occurrence = sessionActions.resolve(item); } catch { error = true; }
        const token = ++menuSerial;
        publish({ curtain: null, contextMenu: { id, token, anchor: { x: point?.x, y: point?.y }, occurrence, ready: !occurrence, error } });
        if (occurrence) Promise.resolve(occurrence.ready).then(() => {
          if (alive && view.contextMenu?.token === token) publish({ contextMenu: { ...view.contextMenu, ready: true } });
        }, () => {
          if (alive && view.contextMenu?.token === token) publish({ contextMenu: { ...view.contextMenu, ready: true, error: true } });
        });
      };
      const performContextAction = actionId => {
        const menu = view.contextMenu;
        if (!menu) return false;
        let selected = false;
        try { if (readEligible().some(row => row.id === menu.id)) selected = menu.occurrence?.select(actionId) === true; }
        catch { publish({ error: true }); }
        finally { closeContext(); }
        return selected;
      };
      const newSession = () => {
        closeContext(); controller.abort(); publish({ curtain: null, error: false });
        try { Promise.resolve(sessionActions.newSession()).catch(() => { if (alive) publish({ error: true }); }); }
        catch { publish({ error: true }); }
      };
      const open = (id, prepared = null) => {
        if (!alive) return;
        const eligible = readEligible().some(row => row.id === id);
        if (eligible && prepared) startCurtain(prepared);
        controller.abort();
        if (!eligible) return;
        publish({ error: false });
        try { Promise.resolve(ctx.uiWorkspace.openSession(id)).catch(() => { if (alive) publish({ error: true }); }); }
        catch { publish({ error: true }); }
      };
      const chooseCard = (id, prepared) => {
        if (!alive || !view.cycle?.visible || view.contextMenu !== null || !view.cycle.items.some(row => row.id === id)) return;
        open(id, prepared);
      };
      let history = [];
      const storageKey = '@local/chat-switcher/mru/v1';
      try { const stored = JSON.parse(window.localStorage.getItem(storageKey)); if (Array.isArray(stored)) history = [...new Set(stored.filter(id => typeof id === 'string'))].slice(0, 1000); } catch { /* unavailable storage is memory-only */ }
      const recentVisits = createRecentVisits({ storage: { getItem: key => window.localStorage.getItem(key), setItem: (key, value) => window.localStorage.setItem(key, value) } });
      ctx.effect(() => () => recentVisits.clear());
      const visitLater = setTimeout, visitCancel = clearTimeout;
      let recentTimer = null, syncView = () => {};
      const readStatus = () => ctx.uiSession.sessionStatus.getSnapshot();
      const readAttention = () => window.__DSH_SOUND_ATTENTION__?.getSnapshot?.() ?? new Map();
      const readEligible = () => readCandidates(ctx.sessions, ctx.workspaces, readStatus(), readAttention(), currentSession(ctx.sessions), recentVisits.getRecentIds());
      const priorities = createPriorityOrder();
      ctx.effect(() => () => priorities.clear());
      const getItems = () => priorities.order(readEligible(), { currentId: currentSession(ctx.sessions), history, status: readStatus(), attention: readAttention() });
      const scheduleRecentExpiry = () => {
        if (recentTimer !== null) visitCancel(recentTimer);
        recentTimer = null;
        const base = new Set(readCandidates(ctx.sessions, ctx.workspaces, readStatus(), readAttention(), currentSession(ctx.sessions)).map(row => row.id));
        const recentOnly = view.items.filter(row => !base.has(row.id)).map(row => row.id);
        const fresh = recentVisits.getRecentIds();
        const stale = recentOnly.some(id => !fresh.has(id));
        const next = recentVisits.nextExpiry(recentOnly);
        if (stale || next !== null) {
          recentTimer = visitLater(() => { recentTimer = null; syncView(); }, stale ? 1 : Math.max(1, next - Date.now()));
          recentTimer?.unref?.();
        }
      };
      controller = createSwitcher({ getItems, getCurrent: () => currentSession(ctx.sessions), commit: open,
        beforeCommit: (id, cycle) => cycle.visible && view.contextMenu === null ? selectionCapture?.(id) : null,
        delay: () => form.getSnapshot().value?.delayMs ?? 250, changed: cycle => publish({ cycle, ...(cycle?.mode === 'hold' ? { curtain: null } : {}) }) });
      const swipeDiagnostics = createSwipeDiagnostics();
      const modalAreas = createModalAreaTracker({ getCurrent: () => view.currentId, onChange: modalArea => publish({ modalArea }), view: window });
      ctx.effect(() => () => modalAreas.dispose());
      const pull = {
        observeArea: (frame, area) => modalAreas.register(frame, area),
        observeFrame: frame => swipeDiagnostics.observe(frame),
        trace: event => swipeDiagnostics.trace('open', event),
        enabled: () => form.getSnapshot().status === 'ready' && form.getSnapshot().value?.pullEnabled !== false,
        getSession: () => view.currentId,
        canOpen: () => view.cycle === null && view.curtain === null && view.contextMenu === null && view.items.length > 0,
        getNext: () => view.items.find(row => row.id !== view.currentId)?.id ?? null,
        isEligible: id => view.items.some(row => row.id === id),
        quick: (id, prepared) => {
          if (view.cycle !== null || view.curtain !== null || view.contextMenu !== null || id === view.currentId || !readEligible().some(row => row.id === id)) return;
          open(id, prepared);
        },
        open: prepared => {
          if (view.cycle !== null || view.curtain !== null || view.contextMenu !== null) return;
          startCurtain(prepared); publish({ error: false }); controller.browse();
        },
        subscribe: fn => { const a = source.subscribe(fn), b = form.subscribe(fn); return () => { a(); b(); }; },
      };
      ctx.inject?.(['cordisInspect'], scope => {
        scope.effect(() => scope.get('cordisInspect').register({
          manifest: { id: 'ChatSwitcher', description: 'Read-only swipe readiness and aggregate event reasons. No chat contents or coordinates.', methods: [{
            name: 'status', description: 'Read this page’s loaded version, gesture readiness and latest aggregate swipe result.',
            inputSchema: { type: 'object', properties: { touchOnly: { type: 'boolean', description: 'Only a touch-capable page may answer; ordinary Desktop pages decline.' } }, additionalProperties: false },
            outputSchema: { type: 'object', description: 'Version, page origin, readiness flags, frame metrics and bounded gesture counters.' },
          }] },
          async query(method, input) {
            if (method !== 'status') throw new Error('Unknown method');
            if (input?.touchOnly && !(window.navigator?.maxTouchPoints > 0)) throw new Error('not-touch-page');
            const modal = document.querySelector('dialog[open][data-chat-switcher]');
            const bounds = modal?.getBoundingClientRect();
            const colorSnapshot = workspaceColors.getSnapshot();
            // Diagnostic reads are bounded to cards owned by this plugin; no
            // Workspace ids, titles, tasks or provider records leave the page.
            const tintedCards = Array.from(document.querySelectorAll?.('.cs-card[data-cs-workspace-tinted="true"]') ?? []);
            const tintBackgrounds = new Set();
            for (const card of tintedCards.slice(0, 100)) {
              try { const value = window.getComputedStyle?.(card)?.backgroundColor; if (value) tintBackgrounds.add(value); } catch { /* Detached card. */ }
            }
            return { version: '1.16.1', origin: window.location?.origin ?? null,
              workspaceColorSourceActive: colorSnapshot.active,
              workspaceTintedCandidates: [...view.cardMeta.values()].filter(meta => workspaceColor(colorSnapshot, meta.workspaceId)).length,
              mountedWorkspaceTintedCards: tintedCards.length, workspaceTintComputedBackgrounds: [...tintBackgrounds].slice(0, 16),
              workspaceTintSupported: window.CSS?.supports?.('background', 'color-mix(in srgb,#000000 18%,#ffffff)') === true,
              formStatus: form.getSnapshot().status, hybridArt: getMosaicArtHealth(), hybridMode: 'on-explicit-reroll', fractalPresence: 'seed-parameter-toggle', gestureEnabled: pull.enabled(), candidates: view.items.length, mode: view.cycle?.mode ?? null,
              keyboardSelection: view.cycle?.keyboardSelection === true, selectedCards: modal?.querySelectorAll('[role="option"][aria-selected="true"]').length ?? 0,
              composerSwipe: 'native-editor-quick-swipe',
              composerAppearance: readComposerAppearance(document, window),
              gestureDirections: { browse: 'right-to-left', dismiss: 'left-to-right', quick: 'left-to-right' },
              releaseTransition: 'zoom-to-chat-center-ease-out-280ms', selectionTransition: 'modal-preview-same-animation', curtainTopLayer: supportsCurtainLayer(), curtainActive: view.curtain !== null,
              contextMenuOpen: view.contextMenu !== null, nativeSessionActions: typeof ctx.contextMenus?.resolve === 'function', nativeNewSession: typeof ctx.uiWorkspace?.startSession === 'function',
              ordering: 'current-requests-errors-completed-mru', trackedPrioritySessions: priorities.size,
              recentWindowMinutes: 60, trackedRecentVisits: recentVisits.size,
              modalArea: view.modalArea, modalBounds: bounds ? { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height } : null,
              modalZoom: modal?.currentCSSZoom ?? null, indicator: 'large-circles-no-edge',
              cardLayout: 'workspace-image-title', taskSource: 'native-cached-todos-or-latest-goal-if-no-todos', taskLabels: [...view.cardMeta.values()].filter(row => row.activeTask !== null).length,
              taskFit: 'maximal-owned-layout-font', taskShadow: 'opposite-black-white-zero-offset', taskShadowSupport: window.CSS?.supports?.('color', TASK_SHADOW_COLOR) === true, taskFontSizes: Array.from(modal?.querySelectorAll?.('.cs-active-task[data-task-fit]') ?? []).slice(0,100).map(node => Number.parseFloat(node.style.fontSize)).filter(Number.isFinite),
              ...swipeDiagnostics.status(window, view.currentId) };
          },
        }), 'chat-switcher: swipe diagnostics');
      });
      ctx.effect(() => {
        let lastCurrent;
        let pendingSignature = '';
        const interactionOffs = new Map();
        const requestSignature = status => [...status].map(([id, row]) => id + ':' + (liveInteractionKind(row?.pendingInteraction) ?? '')).join('|');
        const sync = () => {
          if (!alive) return;
          const current = currentSession(ctx.sessions);
          if (current !== lastCurrent) {
            closeContext(); controller.abort();
            if (lastCurrent) recentVisits.record(lastCurrent);
            lastCurrent = current;
            // Arrival and departure mark actual presence, even after a long stay.
            // Status changes alone do not manufacture visits or reorder MRU.
            if (current) {
              recentVisits.record(current);
              history = visit(history, current).slice(0, 1000);
              try { window.localStorage.setItem(storageKey, JSON.stringify(history)); } catch { /* memory-only */ }
            }
          }
          const status = readStatus();
          const requests = new Set([...status.values()].map(row => row?.pendingInteraction).filter(Boolean));
          for (const [request, off] of interactionOffs) if (!requests.has(request)) { off(); interactionOffs.delete(request); }
          for (const request of requests) if (!interactionOffs.has(request) && typeof request.subscribe === 'function') {
            try { interactionOffs.set(request, request.subscribe(sync)); } catch { /* disposed request */ }
          }
          pendingSignature = requestSignature(status);
          controller.reconcile();
          const items = getItems();
          if (view.contextMenu && !items.some(row => row.id === view.contextMenu.id)) closeContext();
          const catalog = ctx.sessions.list.getSnapshot(), workspace = ctx.workspaces.list.getSnapshot();
          publish({ currentId: current, items, byId: catalog.byId, workspaceItems: workspace.items ?? [], cardMeta: readCardMeta(catalog, workspace, items.map(row => row.id)), pinnedIds: new Set(workspace.pinnedSessionIds ?? []), status, attention: readAttention(), bridge: !!window.__DSH_SOUND_ATTENTION__ });
          modalAreas.refresh();
          scheduleRecentExpiry();
        };
        syncView = sync;
        const offSessions = ctx.sessions.list.subscribe(sync);
        const offWorkspaces = ctx.workspaces.list.subscribe(sync);
        const offStatus = ctx.uiSession.sessionStatus.subscribe(sync);
        const offSettings = form.subscribe(() => {
          const value = form.getSnapshot().value;
          if (view.cycle?.mode === 'browse' ? value?.pullEnabled === false : !value?.enabled) {
            closeContext(); if (view.curtain) publish({ curtain: null }); controller.abort();
          }
        });
        let offAttention = () => {};
        const bindAttention = () => {
          offAttention();
          offAttention = window.__DSH_SOUND_ATTENTION__?.subscribe(sync) ?? (() => {});
          sync();
        };
        window.addEventListener('dsh:sound-attention-changed', bindAttention);
        bindAttention();
        // Approval answerability is a getter, not always an observable. Poll
        // only its lightweight semantic signature; never load session history.
        const pendingPoll = setInterval(() => { if (alive && requestSignature(readStatus()) !== pendingSignature) sync(); }, 250);
        pendingPoll?.unref?.();
        const enabled = () => view.contextMenu === null && document.documentElement.dataset.platform !== undefined && form.getSnapshot().value?.enabled === true;
        const offKeys = bindKeys({ target: window, document, controller, hasCycle: () => view.cycle !== null && view.contextMenu === null, getMode: () => view.cycle?.mode, enabled });
        const closeTransient = () => { closeContext(); if (view.curtain) publish({ curtain: null }); };
        const hideTransient = () => { if (document.visibilityState === 'hidden') closeTransient(); };
        window.addEventListener('blur', closeTransient); document.addEventListener('visibilitychange', hideTransient);
        return () => {
          alive = false; window.removeEventListener('blur', closeTransient); document.removeEventListener('visibilitychange', hideTransient); clearInterval(pendingPoll); if (recentTimer !== null) visitCancel(recentTimer); offKeys(); offSessions(); offWorkspaces(); offStatus(); offSettings(); offAttention();
          for (const off of interactionOffs.values()) off(); interactionOffs.clear();
          window.removeEventListener('dsh:sound-attention-changed', bindAttention); listeners.clear();
        };
      });
      ctx.slots.inject('conversation.hero.frame', () => ctx.slots.register({ name: 'conversation.hero.frame', id: NS + ':pull:1.16.1', order: -100, locale: NS, inject: () => ({ pull, identities }) }, PullFrame));
      ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({ name: 'conversation.input.overlay', id: NS + ':image-style:1.16.1', inject: () => ({ identities }) }, ComposerIdentity));
      ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'chat-image', order: 100, locale: NS, inject: () => ({ identities, paletteRuntime }) }, ImagePalette));
      // The native header omits utilities before the first message. Its otherwise
      // empty leading slot supplies the same action; scoped grid CSS places it
      // immediately before the untouched native corner opener, without an overlay.
      ctx.slots.inject('conversation.header.leading', () => ctx.slots.register({ name: 'conversation.header.leading', locale: NS, inject: () => ({ source, identities, paletteRuntime }) }, BlankImagePalette));
      ctx.slots.inject('sidebar.session.row.trailing', () => ctx.slots.register({ name: 'sidebar.session.row.trailing', id: NS, locale: NS, inject: () => ({ source }) }, RowBadge));
      ctx.slots.inject('sidebar.session.row.hover', () => ctx.slots.register({ name: 'sidebar.session.row.hover', id: NS, order: -100, locale: NS, inject: () => ({ source, identities, workspaceColors }) }, HoverPreview));
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: NS, locale: NS, inject: () => ({ source, identities, workspaceColors, cancel: controller.abort, open: chooseCard, controller, swipeDiagnostics, startCurtain, finishCurtain, canDismiss, openContext, closeContext, performContextAction, newSession, registerSelectionCapture }) }, Overlay));
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: NS + ':body-palette:1.16.1', inject: () => ({ source, identities, themeSource, paletteRuntime }) }, ActiveChatPalette));
      for (const [name, key] of [['plugins.bundle.config', '@local/chat-switcher'], ['plugins.row.config', '@local/chat-switcher#chat-switcher']]) ctx.slots.inject(name, () => ctx.slots.register({ name, key, locale: NS, inject: () => ({ settingsForm: form }) }, PluginSettings));
      ctx.slots.inject('settings.general.item', () => ctx.slots.register({ name: 'settings.general.item', id: NS, order: 85, locale: NS, inject: () => ({ settingsForm: form }) }, Settings));
    },
  };
}
