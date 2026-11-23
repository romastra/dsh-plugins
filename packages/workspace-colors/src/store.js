export function createColorStore({ call, later = setTimeout, cancel = clearTimeout, retryMs = 1500 }) {
  let state = { generation: '', revision: 0, colors: {} };
  let ready = false;
  let errorCode = null;
  let disposed = false;
  const listeners = new Set();
  const controller = new AbortController();
  let running;
  function accept(next) {
    if (!next || typeof next.generation !== 'string' || !Number.isSafeInteger(next.revision) || !next.colors || Array.isArray(next.colors)) throw new Error('Invalid Workspace color snapshot');
    if (state.generation === next.generation && next.revision < state.revision) return;
    const changed = !ready || next.generation !== state.generation || next.revision !== state.revision || JSON.stringify(next.colors) !== JSON.stringify(state.colors);
    state = next; ready = true; errorCode = null;
    if (changed) for (const listener of [...listeners]) listener();
  }
  function delay() {
    return new Promise(resolve => {
      const done = () => { cancel(timer); controller.signal.removeEventListener('abort', done); resolve(); };
      const timer = later(done, retryMs);
      controller.signal.addEventListener('abort', done, { once: true });
      if (controller.signal.aborted) done();
    });
  }
  async function watch() {
    while (!disposed) {
      try {
        accept(await call({ action: 'watch', generation: state.generation, revision: state.revision }, controller.signal));
      } catch (error) {
        if (disposed || controller.signal.aborted) break;
        errorCode = error.code ?? 'connection-failed';
        await delay();
      }
    }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    accept,
    start() { if (!running) running = watch(); },
    async refresh(signal) { const next = await call({ action: 'watch' }, signal); accept(next); return state; },
    async save(input) { const result = await call({ action: 'set', ...input }, controller.signal); accept(result.snapshot); return result; },
    status: () => ({ ready, errorCode, generation: state.generation, revision: state.revision, coloredWorkspaces: Object.keys(state.colors).length }),
    async dispose() { disposed = true; controller.abort(); listeners.clear(); await running; },
  };
}
