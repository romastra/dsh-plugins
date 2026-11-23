import { PALETTE, workspaceColorRules } from '../palette.js';
import { COPY } from './copy.js';
import { createColorMenu } from './menu.js';
import { createColorStore } from './store.js';
import { createWorkspaceColorSource } from './color-source.js';
import { SESSION_HIERARCHY_CSS, sessionColorRules, sessionWorkspaceIds } from './session-colors.js';

export function createPlugin(React) {
  const h = React.createElement;
  return {
    inject: ['slots', 'locale', 'connection', 'contextMenus'],
    apply(ctx) {
      const NS = 'local.workspace-colors';
      for (const [language, copy] of Object.entries(COPY)) ctx.effect(() => ctx.locale.register(NS, language, copy));
      const t = ctx.locale.bind(NS);
      const store = createColorStore({
        async call(payload, signal) {
          const result = await ctx.connection.rpc.call('/api', 'workspace-colors/operate', payload, signal);
          if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
          return result.value;
        },
      });
      const sharedColors = createWorkspaceColorSource(store);
      ctx.effect(() => () => sharedColors.dispose(), 'workspace-colors: read-only color source');
      ctx.provide('workspaceColorSource', sharedColors.source);
      ctx.effect(() => { store.start(); return () => store.dispose(); }, 'workspace-colors: live colors');
      const save = async input => {
        try {
          await store.save(input);
          ctx.contextMenus.notify(t(input.color === null ? 'cleared' : 'saved'), true);
        } catch (error) {
          const key = error.code === 'conflict' ? 'conflict' : error.code === 'workspace-not-found' ? 'missing' : 'failure';
          ctx.contextMenus.notify(t(key), false);
        }
      };
      let menuRegistered = false;
      let stylesMounted = 0;
      let resolvedMenus = 0;
      ctx.effect(() => {
        const dispose = ctx.contextMenus.register({
          id: 'local.workspace-colors', target: 'workspace', order: 250,
          observe: () => [store, ctx.locale],
          async resolve(target, signal) {
            if (typeof target.workspaceId !== 'string') return [];
            const snapshot = await store.refresh(signal);
            resolvedMenus++;
            return createColorMenu({ workspaceId: target.workspaceId, current: snapshot.colors[target.workspaceId] ?? null, t, save });
          },
        });
        menuRegistered = true;
        return () => { menuRegistered = false; dispose(); };
      }, 'workspace-colors: Workspace menu');

      let rowWorkspaces = [];
      function RowStyles({ useWorkspaces }) {
        const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
        const workspaces = useWorkspaces(value => value.items);
        const css = React.useMemo(() => workspaceColorRules(snapshot.colors) + '\n' + SESSION_HIERARCHY_CSS + '\n' + sessionColorRules(snapshot.colors, workspaces), [snapshot, workspaces]);
        React.useEffect(() => { stylesMounted++; return () => { stylesMounted--; }; }, []);
        React.useEffect(() => { rowWorkspaces = workspaces; return () => { rowWorkspaces = []; }; }, [workspaces]);
        return h('style', { 'data-workspace-colors': '1.1.0' }, css);
      }
      // Component-owned stylesheet only; no observers, DOM mutation or replacement of the browser.
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'local.workspace-colors', order: 15 }, RowStyles));

      function Swatch({ icon }) {
        const color = PALETTE.find(item => String(item.index) === icon?.src);
        return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': true },
          h('rect', { x: 2, y: 2, width: 12, height: 12, rx: 3, fill: color?.hex ?? 'none', stroke: 'var(--dsw-alias-label-secondary)', strokeWidth: 1 }));
      }
      function NoColor() {
        return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, 'aria-hidden': true },
          h('circle', { cx: 8, cy: 8, r: 5.5 }), h('path', { d: 'M4 12 12 4' }));
      }
      function PaletteIcon() {
        return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': true },
          ...['#3eb849', '#8076f1', '#db6559', '#65dbef'].map((color, index) => h('rect', { key: color, x: 1.5 + (index % 2) * 7, y: 1.5 + Math.floor(index / 2) * 7, width: 6, height: 6, rx: 1.3, fill: color })));
      }
      ctx.slots.inject('contextMenu.icon', () => {
        const disposers = [
          ['workspace-colors.swatch', Swatch], ['workspace-colors.none', NoColor], ['workspace-colors.palette', PaletteIcon],
        ].map(([key, component]) => ctx.slots.register({ name: 'contextMenu.icon', key }, component));
        return () => { for (const dispose of disposers.reverse()) dispose(); };
      });
      // Diagnostics read the real connected page, without opening a menu or selecting an action.
      ctx.inject(['cordisInspect'], scope => scope.effect(() => scope.get('cordisInspect').register({
        manifest: {
          id: 'WorkspaceColors', description: 'Read-only loaded MSX color and Workspace menu readiness.',
          methods: [{ name: 'status', description: 'Read Client version, saved-color stream and actual row matching counts; no settings are changed.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            outputSchema: { type: 'object', description: 'Loaded version, persistence readiness, registrations and aggregate row-style evidence.' } }],
        },
        async query(method) {
          if (method !== 'status') throw new Error('Unknown method');
          const state = store.getSnapshot();
          const rows = [...document.querySelectorAll('[data-sidebar-list-area] [data-row-key^="workspace:"]')];
          const colored = rows.filter(row => Object.hasOwn(state.colors, row.getAttribute('data-row-key').slice(10)));
          const membership = sessionWorkspaceIds(rowWorkspaces);
          const sessions = [...document.querySelectorAll('[data-sidebar-list-area] [data-row-key^="session:"]')];
          const coloredSessions = sessions.filter(row => Object.hasOwn(state.colors, membership.get(row.getAttribute('data-row-key').slice(8))));
          const groupedSessions = sessions.filter(row => row.closest('[style*="--dsh-workspace-indent"]'));
          return { version: '1.1.0', persistence: 'profile-domain', ...store.status(), menuRegistered, paletteSize: PALETTE.length, stylesMounted, resolvedMenus,
            sharedColorSource: ctx.get('workspaceColorSource') === sharedColors.source,
            visibleWorkspaceRows: rows.length, matchingColoredRows: colored.length,
            paintedRows: colored.filter(row => window.getComputedStyle(row).backgroundImage.includes('linear-gradient')).length,
            visibleSessionRows: sessions.length, matchingColoredSessionRows: coloredSessions.length,
            paintedSessionRows: coloredSessions.filter(row => window.getComputedStyle(row).backgroundImage.includes('linear-gradient')).length,
            groupedSessionRows: groupedSessions.length,
            indentedSessionRows: groupedSessions.filter(row => window.getComputedStyle(row).getPropertyValue('--wc-session-paint-inset').trim() !== '').length,
            sessionIndentStep: 12,
          };
        },
      }), 'workspace-colors: read-only readiness'));
    },
  };
}
