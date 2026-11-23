import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import test from 'node:test';
import { createDraftLifetimes, preserveReusedPreset, RETAIN_SOURCE } from '../src/preservation.js';

// These are data/lifetime fakes, not React/DOM emulation. Each retained generation
// owns its original File registry; dropping its final reference destroys that registry.
function store(initial) {
  let value = initial;
  const listeners = new Set();
  const source = {
    getSnapshot: () => value,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      value = next;
      for (const listener of [...listeners]) if (listeners.has(listener)) listener();
    },
    patch(patch) { source.set({ ...value, ...patch }); },
    subscriberCount: () => listeners.size,
  };
  return source;
}

function scope() {
  const effects = new Set();
  let disposed = false;
  return {
    effect(start) {
      assert.equal(disposed, false, 'a disposed generation cannot acquire effects');
      const cleanup = start();
      let active = true;
      const stop = () => {
        if (!active) return;
        active = false;
        effects.delete(stop);
        cleanup?.();
      };
      effects.add(stop);
      return stop;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const stop of [...effects].reverse()) stop();
    },
    effectCount: () => effects.size,
  };
}

function image(id, name = `${id}.png`) {
  return { kind: 'image', id, file: new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' }), previewUrl: `blob:${id}` };
}

function lifetimeHarness(t, { withoutWorkspaces = false } = {}) {
  const bindings = new Map();
  const units = new Map();
  const byContext = new Map();
  const registry = new Map();
  const queued = [];
  const reports = [];
  const acquisitions = [];
  const releases = [];
  const list = store({ phase: 'ready', ids: [], byId: {} });
  const workspaces = { list: store({ phase: 'ready', items: [], archivedSessionIds: [] }) };
  const h = { registry, queued, reports, acquisitions, releases, workspaces, onRetain: undefined };

  function project(unit) {
    const previous = list.getSnapshot();
    const retainedBy = {};
    for (const reference of unit.references) retainedBy[reference.source] = (retainedBy[reference.source] ?? 0) + 1;
    list.set({
      ...previous,
      ids: previous.ids.includes(unit.id) ? previous.ids : [...previous.ids, unit.id],
      byId: { ...previous.byId, [unit.id]: {
        id: unit.id, blank: unit.session.getSnapshot().blank,
        projectionValues: { agentPreset: unit.preset }, retainedBy,
      } },
    });
  }

  function destroy(unit) {
    if (!unit.live) return;
    unit.live = false;
    if (bindings.get(unit.id) === unit.binding) bindings.delete(unit.id);
    for (const id of unit.input.state.getSnapshot().attachmentIds) registry.delete(id);
    unit.ctx.dispose();
    unit.references.clear();
  }

  function referenceFor(unit, source, notify = true) {
    assert.equal(unit.live, true, 'retaining a dead generation is invalid');
    let released = false;
    const reference = {
      source,
      sessionId: unit.id,
      get binding() {
        if (released || !unit.live) throw new Error('released reference');
        return unit.binding;
      },
      ready: Promise.resolve(unit.binding),
      release() {
        if (released) return;
        released = true;
        unit.references.delete(reference);
        releases.push({ unit, source });
        if (unit.live && unit.references.size === 0) destroy(unit);
        else if (unit.live) project(unit);
      },
    };
    unit.references.add(reference);
    acquisitions.push({ unit, source });
    if (notify) {
      project(unit);
      h.onRetain?.(unit, reference);
    }
    return reference;
  }

  const sessions = {
    list,
    binding: id => bindings.get(id),
    retain(id, { source }) {
      const binding = bindings.get(id);
      assert.ok(binding, `no retained generation for ${id}`);
      return referenceFor(units.get(binding), source);
    },
  };
  const conversation = { input: { for(ctx) {
    const unit = byContext.get(ctx);
    assert.ok(unit?.live, 'input lookup must address a live exact generation');
    return unit.input;
  } } };
  const life = createDraftLifetimes({
    sessions, conversation, ...withoutWorkspaces ? {} : { workspaces },
    defer: task => queued.push(task), report: (...args) => reports.push(args),
  });
  t.after(() => life.dispose());
  Object.assign(h, { sessions, conversation, life });

  h.flushOne = () => queued.shift()?.();
  h.flush = () => {
    let remaining = 100;
    while (queued.length) {
      assert.ok(remaining-- > 0, 'deferred lifetime work must converge');
      h.flushOne();
    }
  };
  h.ownerCount = unit => [...unit.references].filter(reference => reference.source === RETAIN_SOURCE).length;
  h.ownerAcquisitions = () => acquisitions.filter(entry => entry.source === RETAIN_SOURCE).length;
  h.make = (id = 'draft', { draft = '', attachments = [], phase = 'plain', blank = true, preset = 'cordis' } = {}) => {
    assert.equal(bindings.has(id), false, 'create a fresh generation, not an accidental replacement');
    const ctx = scope();
    const state = store({ draft, draftRev: 0, attachmentIds: attachments.map(attachment => attachment.id), phase });
    const session = Object.assign(store({ blank, removed: false }), {
      projections: { faceOf: () => ({ getSnapshot: () => preset }) },
    });
    const binding = { sessionId: id, ctx, session };
    const unit = {
      id, binding, ctx, session, input: { state }, preset,
      live: true, references: new Set(),
      persistedDraft: draft, writerAttached: false, persistenceCalls: 0,
      mainReference: undefined,
    };
    units.set(binding, unit);
    byContext.set(ctx, unit);
    bindings.set(id, binding);
    for (const attachment of attachments) {
      registry.set(attachment.id, attachment);
    }
    // The Controller's exact-generation scope disposer is older than the observer.
    ctx.effect(() => () => destroy(unit));
    unit.mainReference = referenceFor(unit, 'mainView', false);
    project(unit);
    unit.setInput = patch => {
      const previous = state.getSnapshot();
      const next = { ...previous, ...patch };
      if ('draft' in patch && patch.draft !== previous.draft && !('draftRev' in patch)) next.draftRev = previous.draftRev + 1;
      state.set(next);
      if (unit.writerAttached) unit.persistedDraft = next.draft;
    };
    unit.add = (...attachmentsToAdd) => {
      for (const attachment of attachmentsToAdd) {
        registry.set(attachment.id, attachment);
      }
      unit.setInput({ attachmentIds: [...state.getSnapshot().attachmentIds, ...attachmentsToAdd.map(attachment => attachment.id)] });
    };
    unit.remove = idToRemove => {
      unit.setInput({ attachmentIds: state.getSnapshot().attachmentIds.filter(candidate => candidate !== idToRemove) });
      registry.delete(idToRemove);
    };
    unit.resolve = () => state.getSnapshot().attachmentIds.map(attachmentId => registry.get(attachmentId)).filter(Boolean);
    return unit;
  };
  h.mount = unit => {
    unit.writerAttached = true;
    const unmount = life.mounted(unit.id, { persistDraft() {
      unit.persistenceCalls += 1;
      if (unit.writerAttached) unit.persistedDraft = unit.input.state.getSnapshot().draft;
    } });
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      unit.writerAttached = false;
      unmount();
    };
  };
  h.away = unit => {
    const reference = unit.mainReference;
    unit.mainReference = undefined;
    reference?.release();
  };
  h.back = unit => { unit.mainReference = sessions.retain(unit.id, { source: 'mainView' }); };
  h.forceDispose = unit => destroy(unit);
  h.archive = unit => {
    const snapshot = workspaces.list.getSnapshot();
    workspaces.list.set({ ...snapshot, archivedSessionIds: [...new Set([...snapshot.archivedSessionIds, unit.id])] });
  };
  return h;
}

function presetHarness(t, { rows, live, invoke, own = true } = {}) {
  const calls = [];
  const result = { sessionId: 'same-session-result' };
  const original = function create(options, ...rest) {
    calls.push({ options, rest, receiver: this });
    return invoke ? invoke(options, calls.length, this) : result;
  };
  const prototype = {};
  Object.defineProperty(prototype, 'create', { value: original, configurable: true, writable: true, enumerable: false });
  const sessions = Object.create(prototype);
  sessions.list = store({ byId: rows ?? { draft: { blank: true, projectionValues: { agentPreset: 'cordis' } } } });
  const bindings = new Map();
  for (const [id, value] of Object.entries(live ?? {})) {
    const state = store({ blank: true, removed: false, ...value });
    const preset = store(value.preset);
    bindings.set(id, { session: Object.assign(state, { projections: { faceOf: () => preset } }) });
  }
  sessions.binding = id => bindings.get(id);
  if (own) Object.defineProperty(sessions, 'create', { value: original, configurable: true, writable: true, enumerable: false });
  const originalOwn = Object.getOwnPropertyDescriptor(sessions, 'create');
  const workspaces = { list: store({ archivedSessionIds: [] }) };
  const patch = preserveReusedPreset(sessions, workspaces);
  t.after(() => patch.dispose());
  return { sessions, bindings, calls, result, original, originalOwn, patch, workspaces };
}

function presetError(code) {
  return Object.assign(new Error(code), { name: 'SessionCreateError', rpcError: { code } });
}

test('original clipboard Files, descriptors, IDs and pick order survive navigation', t => {
  const h = lifetimeHarness(t);
  const first = image('first', 'clipboard.png');
  const second = image('second', 'clipboard.png');
  const unit = h.make('draft', { draft: 'unsent', attachments: [first, second] });
  h.life.observe(unit.binding);
  h.flush();
  h.away(unit);
  assert.equal(unit.live, true);
  h.back(unit);
  assert.equal(h.sessions.binding(unit.id), unit.binding);
  assert.deepEqual(unit.input.state.getSnapshot().attachmentIds, ['first', 'second']);
  assert.equal(unit.resolve()[0], first);
  assert.equal(unit.resolve()[1], second);
  assert.equal(unit.resolve()[0].file, first.file);
  assert.equal(unit.resolve()[1].file, second.file);
  assert.equal(h.ownerCount(unit), 1);
});

for (const status of ['ready', 'error']) {
  test(`mixed image and generic File preserve native upload identity through ${status} offscreen`, t => {
    const h = lifetimeHarness(t);
    const photo = image('mixed-image');
    const document = { kind: 'file', id: 'mixed-file', file: new File(['PDF'], 'report.pdf', { type: 'application/pdf' }) };
    const pending = { status: 'uploading', loaded: 0, total: 3 };
    const uploads = store({ [document.id]: pending });
    h.conversation.fileUploads = uploads;
    for (const method of ['createDrafts', 'retryFileUpload', 'rebindDraftFiles', 'serializeDraftAttachments']) {
      h.conversation[method] = () => assert.fail(`navigation must not call ${method}`);
    }
    document.file.arrayBuffer = () => assert.fail('navigation must not reread or serialize File bytes');
    const unit = h.make('draft', { attachments: [photo, document] });
    h.life.observe(unit.binding);
    h.flush();
    h.away(unit);
    assert.equal(h.conversation.fileUploads, uploads);
    assert.equal(uploads.getSnapshot()[document.id], pending);
    const settled = status === 'ready'
      ? { status: 'ready', receiptId: 'same-session-receipt', file: { id: 'stored-file' } }
      : { status: 'error', message: 'upload interrupted' };
    uploads.set({ [document.id]: settled }); // The original upload owner completes while offscreen.
    h.back(unit);
    h.flush();
    assert.equal(h.conversation.fileUploads, uploads);
    assert.equal(uploads.getSnapshot()[document.id], settled);
    assert.deepEqual(unit.input.state.getSnapshot().attachmentIds, [photo.id, document.id]);
    assert.equal(unit.resolve()[0], photo);
    assert.equal(unit.resolve()[1], document);
    assert.equal(unit.resolve()[1].file, document.file);
    assert.equal(h.ownerAcquisitions(), 1);
  });
}

test('two independent bindings never exchange drafts or attachments', t => {
  const h = lifetimeHarness(t);
  const a = h.make('a', { draft: 'A', attachments: [image('a-image')] });
  const b = h.make('b', { draft: 'B', attachments: [image('b-image')] });
  h.life.observe(a.binding);
  h.life.observe(b.binding);
  h.flush();
  h.away(a);
  assert.deepEqual(b.input.state.getSnapshot().attachmentIds, ['b-image']);
  h.back(a);
  assert.equal(a.input.state.getSnapshot().draft, 'A');
  assert.deepEqual(a.input.state.getSnapshot().attachmentIds, ['a-image']);
  assert.equal(h.life.status().retainedSessions, 2);
});

test('removing one attachment does not restore it on return', t => {
  const h = lifetimeHarness(t);
  const unit = h.make('draft', { attachments: [image('removed'), image('kept')] });
  h.life.observe(unit.binding);
  h.flush();
  unit.remove('removed');
  h.away(unit);
  h.flush();
  h.back(unit);
  assert.deepEqual(unit.input.state.getSnapshot().attachmentIds, ['kept']);
  assert.equal(h.registry.has('removed'), false);
});

test('removing the final attachment releases ownership without resurrection', t => {
  const h = lifetimeHarness(t);
  const unit = h.make('draft', { attachments: [image('last')] });
  h.life.observe(unit.binding);
  h.flush();
  unit.remove('last');
  assert.equal(h.ownerCount(unit), 1, 'release is deferred outside input publication');
  h.flush();
  assert.equal(h.ownerCount(unit), 0);
  h.away(unit);
  assert.equal(unit.live, false);
  const reopened = h.make('draft');
  h.life.observe(reopened.binding);
  h.flush();
  assert.deepEqual(reopened.resolve(), []);
  assert.equal(h.ownerCount(reopened), 0);
});

test('offscreen acceptance retains the cleared shell until mounted persistence flush', t => {
  const h = lifetimeHarness(t);
  const unit = h.make('draft', { draft: 'already sent', attachments: [image('sent')] });
  h.life.observe(unit.binding);
  const unmount = h.mount(unit);
  h.flush();
  unit.setInput({ phase: 'sending' });
  unmount();
  h.away(unit);
  unit.setInput({ phase: 'plain', draft: '', attachmentIds: [] });
  h.registry.delete('sent'); // Echo retirement releases the consumed descriptor.
  h.flush();
  assert.equal(unit.persistedDraft, 'already sent', 'native writer is absent offscreen');
  assert.equal(h.life.status().awaitingDraftFlush, 1);
  assert.equal(h.ownerCount(unit), 1);
  h.back(unit);
  const finalUnmount = h.mount(unit);
  assert.equal(unit.persistedDraft, 'already sent');
  h.flush();
  assert.equal(unit.persistedDraft, '');
  assert.equal(unit.persistenceCalls, 2);
  assert.equal(h.life.status().awaitingDraftFlush, 0);
  assert.equal(h.ownerCount(unit), 0);
  assert.deepEqual(unit.resolve(), []);
  finalUnmount();
  h.away(unit);
  const reopened = h.make('draft', { draft: unit.persistedDraft });
  assert.equal(reopened.input.state.getSnapshot().draft, '');
});

test('unmount before a scheduled flush does not acknowledge offscreen sent text', t => {
  const h = lifetimeHarness(t);
  const unit = h.make('draft', { draft: 'sent', phase: 'sending' });
  h.life.observe(unit.binding);
  h.flush();
  h.away(unit);
  unit.setInput({ phase: 'plain', draft: '' });
  h.back(unit);
  const unmount = h.mount(unit);
  unmount();
  h.away(unit);
  h.flush();
  assert.equal(unit.persistenceCalls, 0);
  assert.equal(unit.persistedDraft, 'sent');
  assert.equal(h.life.status().awaitingDraftFlush, 1);
  assert.equal(unit.live, true);
});

test('failed mounted persistence keeps pendingFlush and reports the exact failure', t => {
  const h = lifetimeHarness(t);
  const unit = h.make('draft', { draft: 'sent', phase: 'sending' });
  h.life.observe(unit.binding);
  h.flush();
  h.away(unit);
  unit.setInput({ phase: 'plain', draft: '' });
  const error = new Error('native persistence unavailable');
  const unmount = h.life.mounted(unit.id, { persistDraft() { throw error; } });
  assert.doesNotThrow(() => h.flush());
  assert.equal(h.life.status().awaitingDraftFlush, 1);
  assert.equal(h.life.status().errors, 1);
  assert.equal(h.ownerCount(unit), 1);
  assert.ok(h.reports.some(args => args.includes(error)));
  unmount();
  const finalUnmount = h.mount(unit);
  h.flush();
  assert.equal(unit.persistedDraft, '');
  assert.equal(h.life.status().awaitingDraftFlush, 0);
  finalUnmount();
});

test('a refused offscreen send preserves the same draft and original File', t => {
  const h = lifetimeHarness(t);
  const attachment = image('retry');
  const unit = h.make('draft', { draft: 'retry me', attachments: [attachment] });
  h.life.observe(unit.binding);
  h.flush();
  unit.setInput({ phase: 'sending' });
  h.away(unit);
  unit.setInput({ phase: 'plain' });
  h.flush();
  h.back(unit);
  assert.equal(unit.input.state.getSnapshot().draft, 'retry me');
  assert.equal(unit.resolve()[0].file, attachment.file);
  assert.equal(h.life.status().awaitingDraftFlush, 0);
  assert.equal(h.ownerCount(unit), 1);
});

test('plain text-only drafts do not acquire extra references', t => {
  const h = lifetimeHarness(t);
  const unit = h.make('draft', { draft: 'text is persisted by core' });
  h.life.observe(unit.binding);
  h.flush();
  unit.setInput({ draft: 'new text' });
  h.flush();
  assert.equal(h.ownerAcquisitions(), 0);
  h.away(unit);
  assert.equal(unit.live, false);
  assert.equal(h.life.status().observedSessions, 0);
});

for (const phase of ['adjudicating', 'submitting', 'sending']) {
  test(`${phase} is retained even without attachment IDs`, t => {
    const h = lifetimeHarness(t);
    const unit = h.make('draft', { draft: '/command arguments', phase });
    h.life.observe(unit.binding);
    h.flush();
    h.away(unit);
    assert.equal(unit.live, true);
    assert.equal(h.life.status().inFlight, 1);
    assert.equal(h.ownerCount(unit), 1);
    unit.setInput({ phase: 'plain' }); // Refused/handled attempt; document is unchanged.
    h.flush();
    assert.equal(unit.live, false);
    assert.equal(h.life.status().retainedSessions, 0);
  });
}

test('duplicate materialization and synchronous retain reentry acquire only once', t => {
  const h = lifetimeHarness(t);
  const unit = h.make('draft', { attachments: [image('one')] });
  h.onRetain = () => {
    h.life.observe(unit.binding);
    unit.input.state.set(unit.input.state.getSnapshot());
  };
  h.life.observe(unit.binding);
  h.life.observe(unit.binding);
  assert.equal(h.ownerAcquisitions(), 0, 'initial materialization must not synchronously retain');
  h.flush();
  assert.equal(h.ownerAcquisitions(), 1);
  assert.equal(h.ownerCount(unit), 1);
  assert.equal(unit.input.state.subscriberCount(), 1);
  assert.equal(unit.session.subscriberCount(), 1);
});

test('offscreen acceptance during synchronous acquisition still requires a persistence flush', t => {
  const h = lifetimeHarness(t);
  const unit = h.make('draft', { draft: 'sent during retain', phase: 'sending' });
  h.onRetain = () => unit.setInput({ phase: 'plain', draft: '', attachmentIds: [] });
  h.life.observe(unit.binding);
  h.flush();
  h.onRetain = undefined;
  h.away(unit);
  assert.equal(unit.live, true);
  assert.equal(unit.persistedDraft, 'sent during retain');
  assert.equal(h.life.status().awaitingDraftFlush, 1);
  h.back(unit);
  const unmount = h.mount(unit);
  h.flush();
  assert.equal(unit.persistedDraft, '');
  assert.equal(h.life.status().awaitingDraftFlush, 0);
  assert.equal(h.ownerCount(unit), 0);
  unmount();
});

test('an older deferred release cannot cancel a newer pasted attachment', t => {
  const h = lifetimeHarness(t);
  const unit = h.make('draft', { attachments: [image('old')] });
  h.life.observe(unit.binding);
  h.flush();
  unit.remove('old');
  unit.add(image('new'));
  h.flush();
  h.away(unit);
  assert.equal(unit.live, true);
  assert.deepEqual(unit.input.state.getSnapshot().attachmentIds, ['new']);
  assert.equal(h.ownerCount(unit), 1);
  assert.equal(h.ownerAcquisitions(), 1);
});

test('an older deferred release cannot cancel a newer submission phase', t => {
  const h = lifetimeHarness(t);
  const unit = h.make('draft', { attachments: [image('old')] });
  h.life.observe(unit.binding);
  h.flush();
  unit.remove('old');
  unit.setInput({ phase: 'sending' });
  h.flush();
  h.away(unit);
  assert.equal(unit.live, true);
  assert.equal(h.life.status().inFlight, 1);
  assert.equal(h.ownerAcquisitions(), 1);
});

test('mounted acceptance releases promptly after the native writer has saved the empty draft', t => {
  const h = lifetimeHarness(t);
  const unit = h.make('draft', { draft: 'sent', attachments: [image('sent-mounted')] });
  h.life.observe(unit.binding);
  h.mount(unit);
  h.flush();
  unit.setInput({ phase: 'sending' });
  unit.setInput({ phase: 'plain', draft: '', attachmentIds: [] });
  h.flush();
  assert.equal(unit.persistedDraft, '');
  assert.equal(h.life.status().awaitingDraftFlush, 0);
  assert.equal(h.ownerCount(unit), 0);
});

test('forced scope disposal unsubscribes the old generation before same-ID replacement', t => {
  const h = lifetimeHarness(t);
  const old = h.make('same-id', { attachments: [image('old-generation')] });
  h.life.observe(old.binding);
  h.flush();
  h.forceDispose(old);
  assert.equal(old.input.state.subscriberCount(), 0);
  assert.equal(old.session.subscriberCount(), 0);
  assert.equal(h.registry.has('old-generation'), false);
  const replacement = h.make('same-id', { attachments: [image('new-generation')] });
  h.life.observe(replacement.binding);
  h.flush();
  old.input.state.set({ ...old.input.state.getSnapshot(), phase: 'sending' });
  h.flush();
  assert.equal(h.ownerCount(replacement), 1);
  assert.equal(h.life.status().observedSessions, 1);
  assert.equal(h.life.status().attachments, 1);
});

test('removed Sessions release ownership and subscriptions', t => {
  const h = lifetimeHarness(t);
  const unit = h.make('draft', { attachments: [image('removed-session')] });
  h.life.observe(unit.binding);
  h.flush();
  unit.session.patch({ removed: true });
  h.flush();
  assert.equal(h.ownerCount(unit), 0);
  assert.equal(h.life.status().observedSessions, 0);
  assert.equal(unit.input.state.subscriberCount(), 0);
});

test('already archived Sessions never acquire ownership', t => {
  const h = lifetimeHarness(t);
  const unit = h.make('draft', { attachments: [image('archived')] });
  h.archive(unit);
  h.life.observe(unit.binding);
  h.flush();
  assert.equal(h.ownerAcquisitions(), 0);
  assert.equal(h.life.status().retainedSessions, 0);
});

test('archiving a retained offscreen draft releases its generation and bytes', t => {
  const h = lifetimeHarness(t);
  const unit = h.make('draft', { attachments: [image('archived-offscreen')] });
  h.life.observe(unit.binding);
  h.flush();
  h.away(unit);
  h.archive(unit);
  h.flush();
  assert.equal(unit.live, false);
  assert.equal(h.registry.has('archived-offscreen'), false);
  assert.equal(h.life.status().observedSessions, 0);
});

test('archive during synchronous acquisition releases the just-acquired reference', t => {
  const h = lifetimeHarness(t);
  const unit = h.make('draft', { attachments: [image('archive-race')] });
  h.onRetain = () => h.archive(unit);
  h.life.observe(unit.binding);
  h.flush();
  assert.equal(h.ownerCount(unit), 0);
  assert.equal(h.life.status().observedSessions, 0);
  assert.equal(unit.input.state.subscriberCount(), 0);
  assert.deepEqual(h.reports, []);
});

test('forced disposal during acquisition leaves no dangling extra reference', t => {
  const h = lifetimeHarness(t);
  const unit = h.make('draft', { attachments: [image('scope-race')] });
  h.onRetain = () => h.forceDispose(unit);
  h.life.observe(unit.binding);
  h.flush();
  assert.equal(unit.live, false);
  assert.equal(h.ownerCount(unit), 0);
  assert.equal(h.life.status().observedSessions, 0);
  assert.equal(h.life.status().errors, 0);
  assert.deepEqual(h.reports, []);
});

test('plugin unload releases all owned references and queued work cannot reacquire', t => {
  const h = lifetimeHarness(t);
  const a = h.make('a', { attachments: [image('unload-a')] });
  const b = h.make('b', { phase: 'sending', draft: 'in progress' });
  h.life.observe(a.binding);
  h.life.observe(b.binding);
  h.flush();
  h.away(a);
  a.setInput({ draft: 'offscreen revision' });
  h.life.dispose();
  h.life.dispose();
  h.flush();
  assert.equal(a.live, false);
  assert.equal(h.ownerCount(b), 0);
  assert.equal(h.life.status().observedSessions, 0);
  assert.equal(a.input.state.subscriberCount(), 0);
  assert.equal(b.session.subscriberCount(), 0);
  assert.equal(h.workspaces.list.subscriberCount(), 0);
  assert.equal(a.ctx.effectCount(), 0);
  assert.equal(b.ctx.effectCount(), 1, 'only the Controller scope disposer remains');
  h.life.observe(b.binding);
  b.setInput({ attachmentIds: ['do-not-reacquire'] });
  h.flush();
  assert.equal(h.life.status().retainedSessions, 0);
});

test('dispose before initial deferred reconciliation never acquires a reference', t => {
  const h = lifetimeHarness(t);
  const unit = h.make('draft', { attachments: [image('never-acquired')] });
  h.life.observe(unit.binding);
  h.life.dispose();
  h.flush();
  assert.equal(h.ownerAcquisitions(), 0);
  assert.equal(unit.input.state.subscriberCount(), 0);
});

test('optional Workspace service is not required for ordinary ownership', t => {
  const h = lifetimeHarness(t, { withoutWorkspaces: true });
  const unit = h.make('draft', { attachments: [image('no-workspaces')] });
  h.life.observe(unit.binding);
  h.flush();
  assert.equal(h.ownerCount(unit), 1);
  assert.deepEqual(h.reports, []);
});

test('acquisition failure is reported without escaping the observer callback', t => {
  const h = lifetimeHarness(t);
  const unit = h.make('draft', { attachments: [image('retain-failure')] });
  const error = new Error('retention unavailable');
  h.sessions.retain = () => { throw error; };
  h.life.observe(unit.binding);
  assert.doesNotThrow(() => h.flush());
  assert.equal(h.ownerCount(unit), 0);
  assert.ok(h.reports.some(args => args.includes(error)));
});

test('preset wrapper clones only auto-augmented requests without mutating their contents', async t => {
  const h = presetHarness(t);
  const nested = {};
  const request = Object.freeze({ sessionId: 'draft', workspaceId: 'workspace', nested });
  assert.equal(await h.sessions.create(request), h.result);
  assert.notEqual(h.calls[0].options, request);
  assert.deepEqual(h.calls[0].options, { ...request, agentPreset: 'cordis' });
  assert.equal(h.calls[0].options.nested, nested);
  assert.equal(Object.hasOwn(request, 'agentPreset'), false);
});

test('live recorded preset wins over a stale listed preset', async t => {
  const h = presetHarness(t, { live: { draft: { preset: 'live-custom' } } });
  await h.sessions.create({ sessionId: 'draft' });
  assert.equal(h.calls[0].options.agentPreset, 'live-custom');
});

test('listed recorded preset is used when no retained binding exists', async t => {
  const h = presetHarness(t);
  await h.sessions.create({ sessionId: 'draft' });
  assert.equal(h.calls[0].options.agentPreset, 'cordis');
});

test('listed preset remains a fallback while the live projection is unavailable', async t => {
  const h = presetHarness(t, { live: { draft: { preset: undefined } } });
  await h.sessions.create({ sessionId: 'draft' });
  assert.equal(h.calls[0].options.agentPreset, 'cordis');
});

test('explicit preset requests are passed through by identity', async t => {
  const h = presetHarness(t, { live: { draft: { preset: 'different' } } });
  const request = Object.freeze({ sessionId: 'draft', agentPreset: 'explicit-custom' });
  await h.sessions.create(request);
  assert.equal(h.calls[0].options, request);
});

test('genuinely new unnamed Sessions retain the configured Host-default behavior', async t => {
  const h = presetHarness(t);
  const request = { workspaceId: 'workspace' };
  await h.sessions.create(request);
  await h.sessions.create();
  assert.equal(h.calls[0].options, request);
  assert.equal(h.calls[1].options, undefined);
});

test('a listed started Session is never augmented', async t => {
  const h = presetHarness(t, { rows: { draft: { blank: false, projectionValues: { agentPreset: 'old' } } } });
  const request = { sessionId: 'draft' };
  await h.sessions.create(request);
  assert.equal(h.calls[0].options, request);
});

test('live started or removed state overrides stale listed blankness', async t => {
  for (const current of [{ blank: false }, { removed: true }]) {
    const h = presetHarness(t, { live: { draft: { ...current, preset: 'old' } } });
    const request = { sessionId: 'draft' };
    await h.sessions.create(request);
    assert.equal(h.calls[0].options, request);
  }
});

test('unknown identities and absent or empty recorded presets are not augmented', async t => {
  for (const rows of [{}, { draft: { blank: true } }, { draft: { blank: true, projectionValues: { agentPreset: '' } } }]) {
    const h = presetHarness(t, { rows });
    const request = { sessionId: 'draft' };
    await h.sessions.create(request);
    assert.equal(h.calls[0].options, request);
  }
});

test('archived named blanks are not auto-augmented', async t => {
  const h = presetHarness(t);
  h.workspaces.list.set({ archivedSessionIds: ['draft'] });
  const request = { sessionId: 'draft' };
  await h.sessions.create(request);
  assert.equal(h.calls[0].options, request);
});

test('preset wrapper remains backward compatible without the optional Workspace service', async t => {
  const h = presetHarness(t);
  h.patch.dispose();
  const withoutWorkspaces = preserveReusedPreset(h.sessions);
  t.after(() => withoutWorkspaces.dispose());
  await h.sessions.create({ sessionId: 'draft' });
  assert.equal(h.calls[0].options.agentPreset, 'cordis');
});

test('wrapper preserves the original receiver, trailing arguments and result identity', async t => {
  const h = presetHarness(t);
  const receiver = { caller: true };
  const extra = {};
  assert.equal(await h.sessions.create.call(receiver, { sessionId: 'draft' }, extra, 7), h.result);
  assert.equal(h.calls[0].receiver, receiver);
  assert.deepEqual(h.calls[0].rest, [extra, 7]);
});

for (const code of ['agent-preset/not-found', 'agent-preset/invalid']) {
  test(`auto-added ${code} retries the exact original request once`, async t => {
    const unavailable = presetError(code);
    const h = presetHarness(t, { invoke: (options, count) => {
      if (count === 1) throw unavailable;
      return 'default-fallback-result';
    } });
    const request = Object.freeze({ sessionId: 'draft', workspaceId: 'workspace' });
    assert.equal(await h.sessions.create(request), 'default-fallback-result');
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[0].options.agentPreset, 'cordis');
    assert.equal(h.calls[1].options, request);
  });
}

test('fallback makes at most two calls and preserves the exact second error', async t => {
  const first = presetError('agent-preset/not-found');
  const second = presetError('agent-preset/invalid');
  const h = presetHarness(t, { invoke: (options, count) => { throw count === 1 ? first : second; } });
  await assert.rejects(h.sessions.create({ sessionId: 'draft' }), error => error === second);
  assert.equal(h.calls.length, 2);
});

test('asynchronously rejected auto-added preset also uses the transparent fallback', async t => {
  const h = presetHarness(t, { invoke: (options, count) => count === 1
    ? Promise.reject(presetError('agent-preset/invalid')) : Promise.resolve('recovered') });
  const request = { sessionId: 'draft' };
  assert.equal(await h.sessions.create(request), 'recovered');
  assert.equal(h.calls[1].options, request);
});

test('explicit preset refusals retain their exact error and are never retried', async t => {
  const error = presetError('agent-preset/not-found');
  const h = presetHarness(t, { invoke: () => { throw error; } });
  const request = { sessionId: 'draft', agentPreset: 'explicit' };
  await assert.rejects(h.sessions.create(request), observed => observed === error);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].options, request);
});

test('unrelated auto-added request errors are not masked by default fallback', async t => {
  const error = presetError('session/writer-held');
  const h = presetHarness(t, { invoke: () => Promise.reject(error) });
  await assert.rejects(h.sessions.create({ sessionId: 'draft' }), observed => observed === error);
  assert.equal(h.calls.length, 1);
});

test('dispose restores an existing own method descriptor exactly and is idempotent', async t => {
  const h = presetHarness(t);
  assert.equal(h.patch.active(), true);
  h.patch.dispose();
  h.patch.dispose();
  assert.equal(h.patch.active(), false);
  assert.deepEqual(Object.getOwnPropertyDescriptor(h.sessions, 'create'), h.originalOwn);
  const request = { sessionId: 'draft' };
  await h.sessions.create(request);
  assert.equal(h.calls[0].options, request);
});

test('dispose removes its own shadow and restores inherited method lookup', async t => {
  const h = presetHarness(t, { own: false });
  assert.equal(Object.hasOwn(h.sessions, 'create'), true);
  h.patch.dispose();
  assert.equal(Object.hasOwn(h.sessions, 'create'), false);
  assert.equal(h.sessions.create, h.original);
  const request = { sessionId: 'draft' };
  await h.sessions.create(request);
  assert.equal(h.calls[0].options, request);
});

test('dispose preserves a newer foreign wrapper but disables its captured old hotfix closure', async t => {
  const h = presetHarness(t);
  const captured = h.sessions.create;
  const foreign = function newer(options, ...rest) { return Reflect.apply(captured, this, [options, ...rest]); };
  h.sessions.create = foreign;
  assert.equal(h.patch.active(), false);
  h.patch.dispose();
  assert.equal(h.sessions.create, foreign);
  const request = { sessionId: 'draft' };
  await h.sessions.create(request);
  assert.equal(h.calls[0].options, request, 'unloaded hotfix must be transparent even under a newer wrapper');
});
