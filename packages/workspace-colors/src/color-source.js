import { PALETTE } from '../palette.js';

// Optional read-only Client integration. Consumers receive colors, not palette
// indices, RPC or mutation methods, and never need to know how they are stored.
export function createWorkspaceColorSource(store) {
  const listeners = new Set();
  const project = value => Object.freeze({
    generation: value.generation,
    revision: value.revision,
    colors: Object.freeze(Object.fromEntries(Object.entries(value.colors).flatMap(([id, index]) => {
      const color = PALETTE.find(item => item.index === index);
      return color ? [[id, color.hex]] : [];
    }))),
  });
  let snapshot = project(store.getSnapshot());
  const unsubscribe = store.subscribe(() => {
    snapshot = project(store.getSnapshot());
    for (const listener of [...listeners]) listener();
  });
  return {
    source: Object.freeze({
      getSnapshot: () => snapshot,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    }),
    dispose() { unsubscribe(); listeners.clear(); },
  };
}
