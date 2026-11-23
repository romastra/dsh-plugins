window.__ModuleLoader__.load({
  id: '@local/draft-preservation',
  factory(require) {
    const React = require('react');
    function DraftPersistenceBridge({ sessionId, inputActions, lifetimes }) {
      React.useEffect(() => lifetimes.mounted(sessionId, inputActions), [sessionId, inputActions, lifetimes]);
      return null;
    }
    return {
      inject: ['sessions', 'conversation', 'uiSession', 'slots', 'workspaces'],
      apply(ctx) {
        const sessions = ctx.get('sessions');
        const conversation = ctx.get('conversation');
        const uiSession = ctx.get('uiSession');
        const slots = ctx.get('slots');
        const workspaces = ctx.get('workspaces');
        let lifetimes;
        let preset;
        ctx.effect(() => {
          preset = preserveReusedPreset(sessions, workspaces);
          lifetimes = createDraftLifetimes({ sessions, conversation, workspaces });
          return () => { lifetimes.dispose(); preset.dispose(); };
        }, 'draft-preservation: navigation hotfix');
        ctx.effect(() => uiSession.provide({
          resolve(binding) { lifetimes.observe(binding); return {}; },
        }), 'draft-preservation: observe inputs');
        slots.inject('conversation.input.overlay', () => slots.register({
          name: 'conversation.input.overlay', id: 'draft-preservation:1.0.0',
          inject: () => ({ lifetimes }),
        }, DraftPersistenceBridge));
        ctx.inject(['cordisInspect'], scope => {
          scope.effect(() => scope.get('cordisInspect').register({
            manifest: {
              id: 'DraftPreservation',
              description: 'Read-only navigation hotfix status. No draft text, file contents or names are exposed.',
              methods: [{
                name: 'status', description: 'Read the loaded version and aggregate draft lifetime counters.',
                inputSchema: { type: 'object', properties: {}, additionalProperties: false },
                outputSchema: { type: 'object', description: 'Version, preset-reuse protection, and aggregate Client lifetime counters.' },
              }],
            },
            async query(method) {
              if (method !== 'status') throw new Error('Unknown method');
              return { version: '1.0.0', origin: globalThis.location?.origin ?? null, presetReuseProtected: preset.active(), persistence: 'current-page-navigation', ...lifetimes.status() };
            },
          }), 'draft-preservation: inspect status');
        });
      },
    };
  },
});
