/** Local, version-bounded DSH 0.2.2-rc.3 navigation hotfix. No browser files are copied. */
export const RETAIN_SOURCE = 'draftPreservation';
const FROZEN = new Set(['adjudicating', 'submitting', 'sending']);

/** Find a public method's unwrapped descriptor (Cordis traces method reads). */
function methodDescriptor(object, key) {
  for (let owner = object; owner; owner = Object.getPrototypeOf(owner)) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (descriptor) return descriptor;
  }
  throw new Error(`draft-preservation: missing public method ${key}`);
}

/** Preserve the exact named blank's preset, without changing workspace navigation policy. */
export function preserveReusedPreset(sessions) {
  const own = Object.getOwnPropertyDescriptor(sessions, 'create');
  const descriptor = methodDescriptor(sessions, 'create');
  const original = descriptor.value;
  if (typeof original !== 'function') throw new Error('draft-preservation: sessions.create is not a method');
  function create(options, ...rest) {
    let effective = options;
    if (options?.sessionId !== undefined && options.agentPreset === undefined) {
      const summary = sessions.list.getSnapshot().byId[options.sessionId];
      const binding = sessions.binding(options.sessionId);
      const current = binding?.session.getSnapshot();
      if (summary?.blank === true && (current === undefined || (current.blank && !current.removed))) {
        const live = binding?.session.projections.faceOf('agentPreset').getSnapshot();
        const preset = typeof live === 'string' ? live : summary.projectionValues?.agentPreset;
        if (typeof preset === 'string' && preset !== '') effective = { ...options, agentPreset: preset };
      }
    }
    // Preserve the caller/receiver, errors, result and all other options. Do not silently
    // fall back to a different preset if the recorded one is no longer available.
    return Reflect.apply(original, this, [effective, ...rest]);
  }
  Object.defineProperty(sessions, 'create', { ...descriptor, value: create, configurable: true, writable: true });
  return {
    active: () => Object.getOwnPropertyDescriptor(sessions, 'create')?.value === create,
    dispose() {
      // Do not remove another extension's subsequently installed wrapper.
      if (Object.getOwnPropertyDescriptor(sessions, 'create')?.value !== create) return;
      if (own) Object.defineProperty(sessions, 'create', own);
      else Reflect.deleteProperty(sessions, 'create');
    },
  };
}

/**
 * Own exact Client generations while an attachment or an admitting submission needs them.
 * The normal Conversation input, upload queue, previews and serializers stay the sole owners.
 */
export function createDraftLifetimes({ sessions, conversation, defer = queueMicrotask, report = console.error }) {
  const records = new Map();
  let alive = true;
  let retainedEver = 0;

  function isCurrent(record) {
    return alive && !record.disposed && sessions.binding(record.binding.sessionId) === record.binding;
  }
  function needsOwner(record) {
    const input = record.input.state.getSnapshot();
    return input.attachmentIds.length > 0 || FROZEN.has(input.phase) || record.pendingFlush;
  }
  function disposeRecord(record) {
    if (record.disposed) return;
    record.disposed = true;
    records.delete(record.binding);
    for (const off of record.offs) off();
    record.offs.length = 0;
    const reference = record.reference;
    record.reference = undefined;
    reference?.release();
  }
  function scheduleRelease(record) {
    if (record.releaseQueued) return;
    record.releaseQueued = true;
    defer(() => {
      record.releaseQueued = false;
      if (!isCurrent(record)) { disposeRecord(record); return; }
      if (needsOwner(record)) return;
      const reference = record.reference;
      record.reference = undefined;
      // Release outside input publication/onAccept. Recheck above: a new paste or
      // a new attempt must not be cancelled by an older queued release.
      reference?.release();
    });
  }
  function reconcile(record) {
    if (!isCurrent(record)) { disposeRecord(record); return; }
    if (record.binding.session.getSnapshot().removed) { disposeRecord(record); return; }
    if (!needsOwner(record)) { if (record.reference) scheduleRelease(record); return; }
    if (record.reference || record.acquiring) return;
    record.acquiring = true;
    try {
      const reference = sessions.retain(record.binding.sessionId, { source: RETAIN_SOURCE });
      if (reference.binding !== record.binding) {
        reference.release();
        throw new Error('draft-preservation: Session generation changed during acquisition');
      }
      record.reference = reference;
      retainedEver += 1;
      // Readiness is independent of ownership. Early release rejects its waiter.
      void reference.ready.catch(() => {});
    } finally {
      record.acquiring = false;
    }
  }
  function safelyReconcile(record) {
    try { reconcile(record); } catch (error) { report('[draft-preservation]', error); }
  }
  function observe(binding) {
    if (!alive || records.has(binding)) return;
    const input = conversation.input.for(binding.ctx);
    const record = {
      binding, input, reference: undefined, offs: [], disposed: false,
      acquiring: false, releaseQueued: false, mounts: 0, pendingFlush: false,
      revision: input.state.getSnapshot().draftRev,
    };
    records.set(binding, record);
    record.offs.push(input.state.subscribe(() => {
      const revision = input.state.getSnapshot().draftRev;
      // Core's semantic draft writer belongs to the mounted Conversation view.
      // If an offscreen acceptance clears the draft, retain its cleared shell
      // until remount flushes it, rather than resurrecting the old saved text.
      if (record.reference && record.mounts === 0 && revision !== record.revision) record.pendingFlush = true;
      record.revision = revision;
      safelyReconcile(record);
    }));
    record.offs.push(binding.session.subscribe(() => { safelyReconcile(record); }));
    // Forced Controller/generation teardown also removes our subscriptions.
    const offScope = binding.ctx.effect(() => () => { disposeRecord(record); }, 'draft-preservation: input lifetime');
    record.offs.push(() => { void offScope(); });
    // provide.resolve can run inside UiSession.materialize; avoid reentrant retention there.
    defer(() => { if (!record.disposed) safelyReconcile(record); });
  }
  function mounted(sessionId, inputActions) {
    const binding = sessions.binding(sessionId);
    const record = records.get(binding);
    if (!record || !isCurrent(record)) return () => {};
    record.mounts += 1;
    let mounted = true;
    // Wait for the sibling DefaultConversationViews effect to attach the writer.
    defer(() => {
      if (!mounted || !isCurrent(record)) return;
      inputActions.persistDraft();
      record.pendingFlush = false;
      safelyReconcile(record);
    });
    return () => {
      if (!mounted) return;
      mounted = false;
      record.mounts -= 1;
    };
  }
  return {
    observe,
    mounted,
    status() {
      const result = { observedSessions: records.size, retainedSessions: 0, attachments: 0, inFlight: 0, awaitingDraftFlush: 0, acquisitions: retainedEver };
      for (const record of records.values()) {
        const state = record.input.state.getSnapshot();
        if (record.reference) result.retainedSessions += 1;
        result.attachments += state.attachmentIds.length;
        if (FROZEN.has(state.phase)) result.inFlight += 1;
        if (record.pendingFlush) result.awaitingDraftFlush += 1;
      }
      return result;
    },
    dispose() {
      if (!alive) return;
      alive = false;
      for (const record of [...records.values()]) disposeRecord(record);
    },
  };
}
