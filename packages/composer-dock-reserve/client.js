window.__ModuleLoader__.load({
  id: '@local/composer-dock-reserve',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const dockSelector = '[data-composer-dock]';
    // DSH rc.5 places its own anchored context meter directly after the dock entries.
    const nativeSelector = 'span[style*="--dsh-context-"]';
    const marker = 'data-composer-context-space';
    const css = `
      [${marker}] { display: none; }
      @supports (anchor-name: --dsh-context-space-check) {
        ${dockSelector}:not(:has(> ${nativeSelector})) [${marker}][data-ready="true"] {
          display: inline-flex;
          flex: none;
          align-items: center;
          gap: 6px;
          box-sizing: border-box;
          padding: 1px 8px;
          font-family: inherit;
          font-size: var(--dsh-content-font-size-secondary, 13px);
          font-variant-numeric: tabular-nums;
          line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
          white-space: nowrap;
          visibility: hidden;
          pointer-events: none;
          user-select: none;
        }
        [${marker}]::before { content: ''; flex: none; inline-size: 14px; block-size: 14px; }
      }
    `;
    const slot = 'conversation.composer.dock';

    function readingFor(pressure) {
      const used = pressure?.projectedTokens ?? pressure?.pressureTokens;
      const capacity = pressure?.contextWindow;
      if (!Number.isFinite(used) || !Number.isFinite(capacity) || capacity <= 0) return null;
      return `${Math.min(100, Math.round(used / capacity * 100))}%`;
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        let lastSwap = null;
        const mounted = new Set();
        const nativeIsPresent = dock => Boolean(dock.querySelector(`:scope > ${nativeSelector}`));
        const reservesSpace = node => node.getClientRects().length !== 0;

        function Reserve({ sessionId, useProjection }) {
          const current = readingFor(useProjection('contextPressure'));
          const last = React.useRef(null);
          const ref = React.useRef(null);
          const reading = current ?? (last.current && last.current.sessionId === sessionId ? last.current.reading : null);
          React.useLayoutEffect(() => {
            if (current != null || last.current?.sessionId !== sessionId) last.current = { sessionId, reading: current };
          }, [sessionId, current]);
          const hasReading = reading != null;
          React.useLayoutEffect(() => {
            const node = ref.current;
            if (!node) return;
            const dock = node.closest(dockSelector);
            const entry = { node, dock, hasReading };
            mounted.add(entry);
            if (!dock || !hasReading) return () => { mounted.delete(entry); };
            let baseline = null;
            let wasReserving = false;
            const observeSwap = () => {
              if (!node.isConnected) return;
              const reserving = reservesSpace(node);
              const native = nativeIsPresent(dock);
              if (native || (reserving && !wasReserving && baseline)) {
                const { width, height } = dock.getBoundingClientRect();
                if (native && !reserving && width && height) baseline = { width, height };
                else if (reserving && !wasReserving && baseline) {
                  const comparable = Boolean(width && height && Math.abs(width - baseline.width) <= 1);
                  lastSwap = { comparable, sameHeight: comparable ? Math.abs(height - baseline.height) <= 1 : null };
                }
              }
              wasReserving = reserving;
            };
            const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(observeSwap) : null;
            observer?.observe(node);
            observer?.observe(dock);
            observeSwap();
            return () => { observer?.disconnect(); mounted.delete(entry); };
          }, [hasReading, sessionId]);
          return h(React.Fragment, null,
            h('style', null, css),
            h('span', { [marker]: '', 'data-ready': String(hasReading), ref, 'aria-hidden': true }, h('span', null, reading)),
          );
        }

        ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, id: 'composer-context-space', order: 10000 }, Reserve));
        ctx.inject(['cordisInspect'], scope => {
          scope.effect(() => scope.get('cordisInspect').register({
            manifest: {
              id: 'ComposerDockReserve',
              description: 'Read-only mounting and height check for the native context meter spacer.',
              methods: [{
                name: 'status', description: 'Read whether the meter/spacer is present and whether the last switch kept the same height.',
                inputSchema: { type: 'object', properties: { touchOnly: { type: 'boolean' } }, additionalProperties: false },
                outputSchema: { type: 'object', description: 'Version, number of mounted spacers and a height comparison. No context readings, coordinates, audio or draft text.' },
              }],
            },
            query(method, input) {
              if (method !== 'status') throw new Error('Unknown method');
              const touch = navigator.maxTouchPoints > 0;
              if (input?.touchOnly && !touch) throw new Error('not-touch-page');
              const entries = [...mounted];
              return { version: '1.0.1', touch, mounted: entries.length,
                withReading: entries.filter(entry => entry.hasReading).length,
                docks: entries.filter(entry => Boolean(entry.dock)).length,
                direct: entries.filter(({ node, dock }) => node.parentElement === dock).length,
                nativeMeters: entries.filter(({ dock }) => dock && nativeIsPresent(dock)).length,
                reserving: entries.filter(({ node }) => reservesSpace(node)).length,
                lastSwap,
              };
            },
          }), 'composer: read-only context space evidence');
        });
      },
    };
  },
});
