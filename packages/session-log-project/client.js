/* Session Log with Project: plain-data menu action and a window-local status notice.
 * The native anchor hand-off follows DSH's MIT-licensed session-log-export controller.
 * Runtime imports deliberately use only the baseline React module.
 */
window.__ModuleLoader__.load({
  id: '@local/session-log-project',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'session-log-project';
    const ROUTE = 'api/session.project-export';
    const dictionaries = {
      en: {
        'menu.label': 'Session Log with Project',
        'notice.preparingTitle': 'Preparing session and project',
        'notice.preparing': 'Preparing the ZIP download. Closing this notice does not cancel the operation.',
        'notice.startedTitle': 'Download started',
        'notice.started': 'The ZIP has been handed to the browser. Check browser downloads for progress or completion.',
        'notice.errorTitle': 'Could not start the download',
        'notice.session': 'Session: {sessionId}',
        'notice.close': 'Close',
        'notice.hint': 'Includes hidden and ignored project files. Check for secrets before sharing.',
        'error.network': 'Could not reach the export service. Check the connection and try again.',
        'error.http': 'The export service refused the request (HTTP {status}). Try again or check access.',
        'error.denied': 'You do not have permission to export this session or project.',
        'error.missing': 'The session, project, or export endpoint is unavailable.',
      },
      ru: {
        'menu.label': 'Session Log with Project',
        'notice.preparingTitle': 'Подготовка сессии и проекта',
        'notice.preparing': 'Подготавливается скачивание ZIP. Закрытие уведомления не отменяет операцию.',
        'notice.startedTitle': 'Скачивание запущено',
        'notice.started': 'ZIP передан браузеру. Прогресс и завершение проверяйте в загрузках браузера.',
        'notice.errorTitle': 'Не удалось запустить скачивание',
        'notice.session': 'Сессия: {sessionId}',
        'notice.close': 'Закрыть',
        'notice.hint': 'Включает скрытые и игнорируемые файлы проекта. Проверьте секреты перед передачей.',
        'error.network': 'Не удалось связаться с сервисом экспорта. Проверьте соединение и повторите попытку.',
        'error.http': 'Сервис экспорта отклонил запрос (HTTP {status}). Повторите попытку или проверьте доступ.',
        'error.denied': 'Нет разрешения на экспорт этой сессии или проекта.',
        'error.missing': 'Сессия, проект или маршрут экспорта недоступны.',
      },
      zh: {
        'menu.label': 'Session Log with Project',
        'notice.preparingTitle': '正在准备会话和项目',
        'notice.preparing': '正在准备 ZIP 下载。关闭此通知不会取消操作。',
        'notice.startedTitle': '下载已启动',
        'notice.started': 'ZIP 已交给浏览器。请在浏览器下载列表中查看进度或完成状态。',
        'notice.errorTitle': '无法启动下载',
        'notice.session': '会话：{sessionId}',
        'notice.close': '关闭',
        'notice.hint': '包含隐藏和被忽略的项目文件。分享前请检查是否含有密钥。',
        'error.network': '无法连接到导出服务。请检查连接后重试。',
        'error.http': '导出服务拒绝了请求（HTTP {status}）。请重试或检查访问权限。',
        'error.denied': '您没有导出此会话或项目的权限。',
        'error.missing': '会话、项目或导出端点不可用。',
      },
    };
    const styles = `
      .slp-notice {
        position: fixed; right: max(20px, env(safe-area-inset-right));
        bottom: max(24px, env(safe-area-inset-bottom)); z-index: 1300;
        box-sizing: border-box; width: min(390px, calc(100vw - 32px));
        max-height: calc(100dvh - 32px); overflow: auto;
        padding: 16px; border: 1px solid var(--dsw-alias-border-l2);
        border-radius: 12px; background: var(--dsw-alias-bg-base);
        color: var(--dsw-alias-label-primary); font-family: inherit;
        font-size: 13px; line-height: 1.5; pointer-events: auto;
      }
      .slp-notice-heading { display: flex; gap: 12px; align-items: start; }
      .slp-notice-title { margin: 0; flex: 1; font-size: 14px; font-weight: 600; }
      .slp-notice-session { margin: 6px 0; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
      .slp-notice-description { margin: 0; }
      .slp-notice-close {
        flex: none; padding: 3px 8px; border: 1px solid var(--dsw-alias-border-l2);
        border-radius: 6px; background: transparent; color: var(--dsw-alias-label-primary);
        font: inherit; cursor: pointer;
      }
      .slp-notice-close:hover { background: var(--dsw-alias-bg-layer-2); }
      .slp-notice-close:focus-visible { outline: 2px solid var(--dsw-alias-label-primary); outline-offset: 2px; }
    `;

    function DownloadIcon() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.35, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true },
      h('path', { d: 'M8 2v8m-3-3 3 3 3-3M3 11v2h10v-2' }));
    }

    // A notice is intentionally non-modal: it neither moves focus nor blocks the composer.
    function StatusNotice({ useSessionLogProject, dismiss, t }) {
      const bySession = useSessionLogProject(state => state.bySession);
      const pending = Object.entries(bySession).filter(([, value]) => value.open)
        .sort((left, right) => left[1].order - right[1].order)[0];
      if (!pending) return null;
      const [sessionId, entry] = pending;
      const title = t(entry.status === 'preparing' ? 'notice.preparingTitle'
        : entry.status === 'started' ? 'notice.startedTitle' : 'notice.errorTitle');
      const description = entry.status === 'preparing' ? t('notice.preparing')
        : entry.status === 'started' ? t('notice.started')
          : t(entry.errorKey, entry.httpStatus === undefined ? {} : { status: entry.httpStatus });
      return h(React.Fragment, null,
        h('style', null, styles),
        h('section', { className: 'slp-notice', key: `${sessionId}:${entry.order}`,
          role: entry.status === 'error' ? 'alert' : 'status', 'aria-atomic': true,
          'aria-label': t('menu.label') },
        h('div', { className: 'slp-notice-heading' },
          h('h2', { className: 'slp-notice-title' }, title),
          h('button', { type: 'button', className: 'slp-notice-close',
            onClick: () => dismiss(sessionId) }, t('notice.close'))),
        h('p', { className: 'slp-notice-session' }, t('notice.session', { sessionId })),
        h('p', { className: 'slp-notice-description' }, description),
        h('p', { className: 'slp-notice-session' }, t('notice.hint'))));
    }

    return {
      inject: ['slots', 'locale', 'contextMenus'],
      apply(ctx) {
        let disposed = false;
        let sequence = 0;
        let snapshot = { bySession: {} };
        const listeners = new Set();
        const active = new Map();
        const store = {
          getSnapshot: () => snapshot,
          subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        };
        const publish = (sessionId, entry) => {
          if (disposed) return;
          snapshot = { bySession: { ...snapshot.bySession, [sessionId]: entry } };
          for (const listener of [...listeners]) listener();
        };
        const remove = (sessionId) => {
          if (disposed || snapshot.bySession[sessionId] === undefined) return;
          const bySession = { ...snapshot.bySession };
          delete bySession[sessionId];
          snapshot = { bySession };
          for (const listener of [...listeners]) listener();
        };
        const dismiss = (sessionId) => {
          const entry = snapshot.bySession[sessionId];
          if (entry && entry.open) {
            if (entry.status === 'preparing') publish(sessionId, { ...entry, open: false });
            else remove(sessionId);
          }
        };
        const download = (sessionId) => {
          if (disposed) return Promise.resolve();
          const existing = active.get(sessionId);
          if (existing) return existing.done;
          const operation = { abort: new AbortController(), done: undefined };
          const order = sequence++;
          active.set(sessionId, operation);
          publish(sessionId, { order, open: true, status: 'preparing' });
          operation.done = (async () => {
            try {
              const route = `${ROUTE}?${new URLSearchParams({ sessionId }).toString()}`;
              const response = await fetch(route, { method: 'HEAD', credentials: 'same-origin',
                redirect: 'error', signal: operation.abort.signal });
              if (disposed || operation.abort.signal.aborted) return;
              if (!response.ok) {
                // Never display server bodies, exception strings, host paths, or stack traces.
                const status = response.status;
                const errorKey = status === 401 || status === 403 ? 'error.denied'
                  : status === 404 ? 'error.missing' : 'error.http';
                publish(sessionId, { order, open: snapshot.bySession[sessionId]?.open ?? false,
                  status: 'error', errorKey, httpStatus: status });
                return;
              }
              const anchor = document.createElement('a');
              anchor.href = route;
              anchor.download = `dsh-session-${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}-with-project.zip`;
              // Native navigation streams GET to the browser download manager without a Blob in JS memory.
              anchor.click();
              publish(sessionId, { order, open: snapshot.bySession[sessionId]?.open ?? false, status: 'started' });
            } catch (_error) {
              if (!disposed && !operation.abort.signal.aborted) {
                publish(sessionId, { order, open: snapshot.bySession[sessionId]?.open ?? false,
                  status: 'error', errorKey: 'error.network' });
              }
            } finally {
              if (active.get(sessionId) === operation) active.delete(sessionId);
              if (snapshot.bySession[sessionId]?.open === false) remove(sessionId);
            }
          })();
          return operation.done;
        };
        ctx.effect(() => () => {
          disposed = true;
          const operations = [...active.values()];
          for (const operation of operations) operation.abort.abort();
          active.clear();
          listeners.clear();
          return Promise.allSettled(operations.map(operation => operation.done));
        }, 'session-log-project: abort outstanding preflights');
        ctx.effect(() => ctx.locale.register(NS, dictionaries), 'session-log-project: dictionaries');
        const t = ctx.locale.bind(NS);
        ctx.slots.inject('contextMenu.icon', () => ctx.slots.register({
          name: 'contextMenu.icon', key: 'session-log-project.download',
        }, DownloadIcon));
        ctx.effect(() => ctx.contextMenus.register({
          id: 'session-log-project.export', target: 'sessionHeader', order: 101,
          observe: () => [store, ctx.locale],
          resolve: ({ sessionId }) => [{
            id: 'download', label: t('menu.label'), icon: { key: 'session-log-project.download' },
            disabled: snapshot.bySession[sessionId]?.status === 'preparing',
            run: () => download(sessionId),
          }],
        }), 'session-log-project: Session header action');
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'session-log-project.status', locale: NS,
          inject: () => ({ hooks: { sessionLogProject: store }, dismiss }),
        }, StatusNotice));
      },
    };
  },
});
