export function applyMicrophoneCopy(dicts) {
  Object.assign(dicts.en, {
    'mic.choose': 'Choose microphone',
    'mic.current': 'Microphone: {name}',
    'mic.system': 'System default',
    'mic.systemNamed': 'System default · {name}',
    'mic.reveal': 'Show microphone names',
    'mic.revealing': 'Waiting for microphone access…',
    'mic.namesHint': 'Permission may be needed to display device names. This does not start dictation.',
    'mic.namesUnavailable': 'The browser did not provide any named microphones.',
    'mic.listLoading': 'Looking for microphones…',
    'mic.retryList': 'Refresh list',
    'mic.notListed': '{name} is not in the list. Reconnect it or choose another microphone.',
    'mic.storageFailed': 'Could not save the choice. It will apply until the page is closed or reloaded.',
    'error.micSelectedMissing': 'The selected microphone is unavailable. Reconnect it or use the arrow next to the microphone to choose another one.',
    'error.micPinUnsupported': 'This browser cannot open a specific microphone. Choose System default to use the browser’s microphone.',
    'error.micPinMismatch': 'The browser returned a different microphone. Recording did not start.',
    'error.micBusy': 'Could not open the microphone. It may be in use by another app.',
    'error.micOpen': 'Could not open the microphone. Check its connection and permissions.',
    'error.micList': 'Could not load the microphone list.',
  });
  Object.assign(dicts.ru, {
    'mic.choose': 'Выбрать микрофон',
    'mic.current': 'Микрофон: {name}',
    'mic.system': 'Системный по умолчанию',
    'mic.systemNamed': 'По умолчанию · {name}',
    'mic.reveal': 'Показать названия микрофонов',
    'mic.revealing': 'Ожидание доступа к микрофону…',
    'mic.namesHint': 'Для отображения названий может понадобиться разрешение. Диктовка при этом не начнётся.',
    'mic.namesUnavailable': 'Браузер не показал ни одного микрофона с названием.',
    'mic.listLoading': 'Ищу микрофоны…',
    'mic.retryList': 'Обновить список',
    'mic.notListed': 'Микрофона «{name}» нет в списке. Подключите его снова или выберите другой.',
    'mic.storageFailed': 'Не удалось сохранить выбор. Он действует до закрытия или обновления страницы.',
    'error.micSelectedMissing': 'Выбранный микрофон недоступен. Подключите его снова или выберите другой через стрелку рядом с микрофоном.',
    'error.micPinUnsupported': 'Браузер не позволяет открыть конкретный микрофон. Выберите «Системный по умолчанию», чтобы записывать с микрофона браузера.',
    'error.micPinMismatch': 'Браузер открыл не тот микрофон. Запись не началась.',
    'error.micBusy': 'Не удалось открыть микрофон. Возможно, его использует другое приложение.',
    'error.micOpen': 'Не удалось открыть микрофон. Проверьте его подключение и разрешения.',
    'error.micList': 'Не удалось загрузить список микрофонов.',
  });
  Object.assign(dicts.zh, {
    'mic.choose': '选择麦克风',
    'mic.current': '麦克风：{name}',
    'mic.system': '系统默认',
    'mic.systemNamed': '系统默认 · {name}',
    'mic.reveal': '显示麦克风名称',
    'mic.revealing': '正在等待麦克风权限…',
    'mic.namesHint': '显示设备名称可能需要授权。授权不会开始听写。',
    'mic.namesUnavailable': '浏览器未提供任何有名称的麦克风。',
    'mic.listLoading': '正在查找麦克风…',
    'mic.retryList': '刷新列表',
    'mic.notListed': '列表中没有「{name}」。请重新连接或选择其他麦克风。',
    'mic.storageFailed': '无法保存选择。它将在关闭或刷新页面前生效。',
    'error.micSelectedMissing': '所选麦克风不可用。请重新连接，或用麦克风旁的箭头选择其他设备。',
    'error.micPinUnsupported': '此浏览器无法打开指定的麦克风。请选择「系统默认」。',
    'error.micPinMismatch': '浏览器打开了其他麦克风。录音未开始。',
    'error.micBusy': '无法打开麦克风，可能正被其他应用使用。',
    'error.micOpen': '无法打开麦克风。请检查连接和权限。',
    'error.micList': '无法加载麦克风列表。',
  });
}

export function microphoneLabels({ catalog, preference }, t) {
  const system = catalog.defaultLabel ? t('mic.systemNamed', { name: catalog.defaultLabel }) : t('mic.system');
  const selected = catalog.inputs.find(input => input.id === preference?.id);
  return { system, current: selected?.label ?? preference?.label ?? system, listed: Boolean(selected) };
}

function validCssZoom(value) {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

export function microphoneMenuPlacement(rect, { left = 0, top = 0, width, height }, contentZoom = 1) {
  const zoom = validCssZoom(contentZoom);
  const marginX = Math.min(8, width / 8);
  const marginY = Math.min(8, height / 8);
  const minX = left + marginX;
  const maxX = left + width - marginX;
  const minY = top + marginY;
  const maxY = top + height - marginY;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const gap = 6 * zoom;
  const menuWidth = Math.min(330 * zoom, maxX - minX);
  const x = clamp(rect.right - menuWidth, minX, maxX - menuWidth);
  const upperEdge = clamp(rect.top - gap, minY, maxY);
  const lowerEdge = clamp(rect.bottom + gap, minY, maxY);
  const above = upperEdge - minY;
  const below = maxY - lowerEdge;
  const visibleHeight = maxY - minY;
  // On a keyboard-shortened screen an anchored strip may be too short to use.
  // Fall back to a scrollable panel inside the viewport, even if it overlaps the trigger.
  const anchored = Math.max(above, below) >= Math.min(96 * zoom, visibleHeight);
  const opensUp = anchored && (above >= 180 * zoom || above > below);
  const y = !anchored ? minY : opensUp ? upperEdge : lowerEdge;
  const room = !anchored ? visibleHeight : opensUp ? above : below;
  // The body portal cancels UI Zoom on its positioning box. DOMRect, viewport
  // bounds and fixed left/top/size therefore all use viewport CSS pixels.
  return {
    left: x,
    top: y,
    width: menuWidth,
    maxHeight: Math.min(360 * zoom, room),
    transform: opensUp ? 'translateY(-100%)' : undefined,
  };
}

function microphoneVisualViewport() {
  const vv = window.visualViewport;
  return vv && vv.width > 0 && vv.height > 0
    ? { left: vv.offsetLeft, top: vv.offsetTop, width: vv.width, height: vv.height }
    : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
}

function microphoneUiZoom() {
  // UI Zoom publishes the factor and its inverse in the same :root style commit.
  return validCssZoom(Number(window.getComputedStyle(document.documentElement).getPropertyValue('--dsh-ui-zoom-factor')));
}

let lastMicrophoneMenuLayout = null;

function measureMicrophoneMenu(menu) {
  const box = menu.getBoundingClientRect();
  const { left, top, width, height } = microphoneVisualViewport();
  const tolerance = 1; // Allow subpixel rounding of the border box.
  const roundZoom = value => Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
  return {
    fitsViewport: box.width > 0 && box.height > 0 && box.left >= left - tolerance && box.top >= top - tolerance
      && box.right <= left + width + tolerance && box.bottom <= top + height + tolerance,
    uiZoomPercent: Math.round(microphoneUiZoom() * 1000) / 10,
    positioningZoom: roundZoom(menu.currentCSSZoom),
    contentZoom: roundZoom(menu.firstElementChild?.currentCSSZoom),
  };
}

export function microphoneMenuLayoutStatus() {
  const menu = document.body.querySelector('.dsh-lp-device-menu');
  return { open: menu ? measureMicrophoneMenu(menu) : null, last: lastMicrophoneMenuLayout };
}

export function createMicrophonePicker(React, ReactDOM, onMount) {
  const h = React.createElement;
  const { useEffect, useId, useLayoutEffect, useRef, useState } = React;
  function position(trigger) {
    return microphoneMenuPlacement(trigger.getBoundingClientRect(), microphoneVisualViewport(), microphoneUiZoom());
  }

  return function MicrophonePicker({ model, snapshot, labels, t, disabled }) {
    const id = useId();
    const trigger = useRef(null);
    const panel = useRef(null);
    const owner = useRef(Symbol('microphone picker'));
    const [placement, setPlacement] = useState(null);
    const expanded = Boolean(placement) && !disabled;
    const close = (restoreFocus = false) => {
      model.cancelReveal(owner.current);
      setPlacement(null);
      if (restoreFocus) trigger.current?.focus({ preventScroll: true });
    };

    useEffect(onMount, []);
    useEffect(() => { if (disabled) setPlacement(null); }, [disabled]);
    useLayoutEffect(() => {
      if (!expanded) return;
      const ownerKey = owner.current;
      const onOutside = event => {
        if (panel.current?.contains(event.target) || trigger.current?.contains(event.target)) return;
        model.cancelReveal(ownerKey);
        setPlacement(null);
      };
      const update = () => {
        const anchor = trigger.current;
        if (!anchor?.isConnected) return;
        const next = position(anchor);
        setPlacement(previous => previous && Object.keys(next).some(key => next[key] !== previous[key]) ? next : previous);
      };
      panel.current?.focus({ preventScroll: true });
      window.addEventListener('pointerdown', onOutside, true);
      window.addEventListener('focusin', onOutside, true);
      window.addEventListener('resize', update);
      window.addEventListener('scroll', update, true);
      const viewport = window.visualViewport;
      viewport?.addEventListener('resize', update);
      viewport?.addEventListener('scroll', update);
      // Changing document CSS zoom can reflow the root without a window resize.
      const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
      observer?.observe(document.documentElement);
      if (trigger.current) observer?.observe(trigger.current);
      return () => {
        observer?.disconnect();
        window.removeEventListener('pointerdown', onOutside, true);
        window.removeEventListener('focusin', onOutside, true);
        window.removeEventListener('resize', update);
        window.removeEventListener('scroll', update, true);
        viewport?.removeEventListener('resize', update);
        viewport?.removeEventListener('scroll', update);
        model.cancelReveal(ownerKey);
      };
    }, [expanded, model]);
    useLayoutEffect(() => {
      if (expanded && panel.current) lastMicrophoneMenuLayout = measureMicrophoneMenu(panel.current);
    }, [expanded, placement, snapshot]);

    const { catalog, preference, status, revealing, revealError, storageFailed } = snapshot;
    const mayNeedPermission = status === 'ready' && (catalog.hidden || !catalog.inputs.length);
    const select = (value) => {
      if (model.select(value) && !model.getSnapshot().storageFailed) close(true);
    };
    const option = (value, name) => {
      const selected = value === (preference?.id ?? null);
      return h('button', { key: value ?? 'system', type: 'button', className: 'dsh-lp-device-option',
        'aria-pressed': selected, disabled: revealing, onClick: () => select(value),
      }, h('span', { className: 'dsh-lp-device-check', 'aria-hidden': true }, selected ? '✓' : ''), name);
    };
    const caption = `${t('mic.choose')} · ${t('mic.current', { name: labels.current })}`;
    return h(React.Fragment, null,
      h('button', {
        type: 'button', ref: trigger, disabled, className: 'dsh-lp-mic dsh-lp-device-trigger',
        'aria-label': caption, 'aria-haspopup': 'dialog', 'aria-expanded': expanded,
        'aria-controls': expanded ? id : undefined, title: caption,
        onClick: () => {
          if (expanded) { close(true); return; }
          setPlacement(position(trigger.current));
          void model.refresh();
        },
        onKeyDown: event => {
          if (event.key === 'Escape' && expanded) { event.preventDefault(); event.stopPropagation(); close(true); }
        },
      }, h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('path', { d: 'm4 6 4 4 4-4', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }))),
      expanded ? ReactDOM.createPortal(h('div', {
        id, ref: panel, role: 'dialog', 'aria-labelledby': `${id}-title`, tabIndex: -1,
        className: 'dsh-lp-device-menu', style: placement,
        onKeyDown: event => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close(true);
          } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            const buttons = [...panel.current.querySelectorAll('button:not(:disabled)')];
            if (!buttons.length) return;
            const index = buttons.indexOf(document.activeElement);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
              : event.key === 'ArrowDown' ? (index + 1) % buttons.length : index < 1 ? buttons.length - 1 : index - 1;
            event.preventDefault();
            event.stopPropagation();
            buttons[next].focus();
          }
        },
      },
      h('div', { className: 'dsh-lp-device-content' },
       h('div', { id: `${id}-title`, className: 'dsh-lp-device-title' }, t('mic.choose')),
      h('div', { className: 'dsh-lp-device-options' }, option(null, labels.system), ...catalog.inputs.map(input => option(input.id, input.label))),
      preference && !labels.listed
        ? h('p', { className: 'dsh-lp-device-info', role: 'status' }, t(status === 'ready' && !catalog.hidden ? 'mic.notListed' : 'mic.current', { name: preference.label })) : null,
      status === 'loading' && !revealing ? h('p', { className: 'dsh-lp-device-info', role: 'status' }, t('mic.listLoading')) : null,
      status === 'error' || status === 'unsupported' ? h('p', { className: 'dsh-lp-device-info', role: 'status' }, t(status === 'error' ? 'error.micList' : 'error.micUnsupported')) : null,
      revealError ? h('p', { className: 'dsh-lp-device-info', role: 'alert' }, t(revealError)) : null,
      storageFailed ? h('p', { className: 'dsh-lp-device-info', role: 'status' }, t('mic.storageFailed')) : null,
      mayNeedPermission && !revealing ? h('p', { className: 'dsh-lp-device-info' }, t('mic.namesHint')) : null,
      model.canReveal && (revealing || mayNeedPermission || status === 'error')
        ? h('button', { type: 'button', className: 'dsh-lp-button dsh-lp-device-action', 'aria-disabled': revealing,
          onClick: async event => {
            if (revealing) return;
            const revealButton = event.currentTarget;
            await model.reveal(owner.current);
            const active = document.activeElement;
            if (panel.current && (active === revealButton || active === document.body) && model.getSnapshot().catalog.inputs.length) {
              panel.current.querySelector('.dsh-lp-device-option[aria-pressed="true"], .dsh-lp-device-option')?.focus({ preventScroll: true });
            }
          },
        }, t(revealing ? 'mic.revealing' : 'mic.reveal')) : null,
      status === 'error' && !revealing
        ? h('button', { type: 'button', className: 'dsh-lp-button dsh-lp-device-action', onClick: () => { void model.refresh(); } }, t('mic.retryList')) : null,
      )), document.body) : null,
    );
  };
}
