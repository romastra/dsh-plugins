window.__ModuleLoader__.load({
  id: '@local/composer-placeholder',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const DEFAULT = 'msg or task; / for cmd; @ for file or sess';
    const COPY = {
      en: { title: 'Composer placeholder', field: 'Placeholder text', help: 'Shown when the composer is empty. An empty value hides the hint. Saved for all browsers in this profile; drafts and command hints are unchanged.', save: 'Save', saving: 'Saving…', saved: 'Saved', error: 'Could not save. Your text is still in this form. Check the connection, then save again to replace the latest saved value.', loading: 'Loading settings…', unavailable: 'Settings are unavailable.' },
      ru: { title: 'Подсказка composer', field: 'Текст плейсхолдера', help: 'Показывается в пустом поле ввода. Пустое значение скрывает подсказку. Настройка общая для всех браузеров этого профиля; черновики и подсказки команд не изменяются.', save: 'Сохранить', saving: 'Сохранение…', saved: 'Сохранено', error: 'Не удалось сохранить. Введённый текст остаётся в этой форме. Проверьте соединение и нажмите «Сохранить» ещё раз, чтобы заменить последнее сохранённое значение.', loading: 'Загрузка настроек…', unavailable: 'Настройки недоступны.' },
    };
    return {
      inject: ['configForms', 'slots', 'locale'],
      apply(ctx) {
        for (const [locale, dict] of Object.entries(COPY)) {
          ctx.effect(() => ctx.locale.register('local.composer-placeholder', locale, dict));
        }
        const t = ctx.locale.bind('local.composer-placeholder');
        const form = ctx.configForms.get('composer-placeholder');
        ctx.effect(() => {
          const originals = new Map();
          let text = DEFAULT;
          function update() {
            for (const node of document.querySelectorAll('[data-composer-placeholder]')) {
              if (node.childNodes.length !== 1 || node.firstChild.nodeType !== 3) continue;
              const child = node.firstChild;
              const previous = originals.get(child);
              if (!previous || child.data !== previous.rendered) {
                originals.set(child, { original: child.data, rendered: text });
              } else previous.rendered = text;
              if (child.data !== text) child.data = text;
            }
            for (const child of originals.keys()) {
              if (!child.isConnected) originals.delete(child);
            }
          }
          const sync = () => {
            const state = form.getSnapshot();
            if (state.status === 'ready' && typeof state.value?.placeholder === 'string') {
              text = state.value.placeholder;
              update();
            }
          };
          const observer = new MutationObserver(records => {
            // Ignore unrelated token streaming and edits in the settings form.
            if (records.some(record => record.target.parentElement?.closest('[data-composer-placeholder]')
                || (record.type === 'childList' && [...record.addedNodes].some(node => node.nodeType === 1
                  && (node.matches('[data-composer-placeholder]') || node.querySelector('[data-composer-placeholder]')))))) update();
          });
          observer.observe(document.body, { subtree: true, childList: true, characterData: true });
          const unsubscribe = form.subscribe(sync);
          sync();
          update();
          return () => {
            unsubscribe();
            observer.disconnect();
            for (const [child, value] of originals) {
              if (child.isConnected && child.data === value.rendered) child.data = value.original;
            }
            originals.clear();
          };
        });

        function Settings() {
          React.useSyncExternalStore(fn => ctx.locale.subscribe(fn), () => ctx.locale.getSnapshot());
          const state = React.useSyncExternalStore(fn => form.subscribe(fn), () => form.getSnapshot());
          const [draft, setDraft] = React.useState(null);
          const [revision, setRevision] = React.useState(undefined);
          const [pending, setPending] = React.useState(false);
          const [notice, setNotice] = React.useState('');
          const id = React.useId();
          const ready = state.status === 'ready';
          const value = draft ?? state.value?.placeholder ?? '';
          async function save(event) {
            event.preventDefault();
            if (pending || !ready || !state.writable) return;
            setPending(true);
            setNotice('');
            try {
              const ok = await form.mutate([{ op: 'set', path: ['placeholder'], value }], revision ?? state.revision);
              if (ok) { setDraft(null); setRevision(undefined); setNotice('saved'); }
              else { setRevision(form.getSnapshot().revision); setNotice('error'); }
            } catch { setRevision(form.getSnapshot().revision); setNotice('error'); }
            finally { setPending(false); }
          }
          const control = { width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', font: 'inherit' };
          return h('form', { onSubmit: save, style: { maxWidth: 640, padding: 24, color: 'var(--dsw-alias-label-primary)', fontSize: 14 } },
            h('h2', { style: { fontSize: 18, margin: '0 0 20px' } }, t('title')),
            h('label', { htmlFor: id, style: { display: 'block', marginBottom: 8 } }, t('field')),
            h('textarea', { id, rows: 3, value, disabled: !ready || !state.writable || pending, 'aria-describedby': `${id}-help`, style: { ...control, resize: 'vertical' }, onChange: event => {
              if (draft === null) setRevision(state.revision);
              setDraft(event.target.value); setNotice('');
            } }),
            h('p', { id: `${id}-help`, style: { color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.5 } }, t('help')),
            h('button', { type: 'submit', disabled: !ready || !state.writable || pending || draft === null, style: { ...control, width: 'auto', cursor: 'pointer', opacity: !ready || !state.writable || pending || draft === null ? 0.5 : 1 } }, t(pending ? 'saving' : 'save')),
            h('p', { role: 'status', 'aria-live': 'polite' }, notice ? t(notice) : !ready || !state.writable ? t(state.status === 'loading' ? 'loading' : 'unavailable') : ''),
          );
        }
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: '@local/composer-placeholder' }, Settings));
      },
    };
  },
});
