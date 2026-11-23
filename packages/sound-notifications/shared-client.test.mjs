import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { installCompletionChannel, COMPLETION_ENDPOINT } from './completion-channel.js';

const clientSource = readFileSync(new URL('./client.js', import.meta.url), 'utf8');
const token = (sessionId, kind, value) => JSON.stringify([sessionId, kind, String(value)]);
const terminal = (sessionId, id, outcome = 'success') => ({ type: 'completed', sessionId, id, outcome });
const snapshot = (revision = 0, acknowledged = [], terminals = []) => ({ revision, acknowledged, terminals });
const frame = (cursor, state = snapshot(), events = [], generation = 'host') => ({ ok: true, value: { protocol: 2, generation, cursor, events, state } });
const flush = async () => { for (let i = 0; i < 64; i++) await Promise.resolve(); };

function clockFixture() {
  let now = 0, serial = 0;
  const timers = new Map();
  return {
    timers, now: () => now, jump(to) { now = to; },
    later(fn, delay = 0) { const id = ++serial; timers.set(id, { fn, at: now + delay }); return id; },
    cancel(id) { timers.delete(id); },
    advance(to) {
      for (;;) {
        const entry = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry || entry[1].at > to) break;
        timers.delete(entry[0]); now = entry[1].at; entry[1].fn();
      }
      now = to;
    },
  };
}
function loadClient({ window = {}, document, clock = clockFixture() } = {}) {
  let plugin;
  const warnings = [];
  window.__ModuleLoader__ = { load(def) { plugin = def.factory(() => ({})); } };
  vm.runInNewContext(clientSource, { window, document, Date: { now: clock.now }, setTimeout: clock.later, clearTimeout: clock.cancel, queueMicrotask, AbortController, atob, console: { warn: (...args) => warnings.push(args) } });
  return { plugin, warnings, clock, window };
}
function approval(callId = 'S1') { return { kind: 'approval', callId, key: 'approval:' + callId, answerable: true, answer() { assert.fail('notification ACK must not authorize access'); } }; }
function question(callId = 'S1', kind = 'question') {
  return { kind, callId, key: kind + ':' + callId, getSnapshot: () => ({ closed: false, channel: 'rpc' }), subscribe: () => () => {}, answer() { assert.fail('notification ACK must not answer a question'); } };
}
function notifierFixture(options = {}) {
  const loaded = loadClient(), sounds = [], stops = [];
  const notifier = loaded.plugin.createNotifier({ clock: loaded.clock.now, later: loaded.clock.later, cancel: loaded.clock.cancel, play(volume, id, kind, reference, sessionId) { sounds.push({ at: loaded.clock.now(), volume, id, kind, reference, sessionId }); return true; }, stop(kind, sessionId) { stops.push({ kind, sessionId }); }, ...options });
  notifier.updateSettings({ approvalCount: 3, intervalSeconds: 1, repeatCount: 0, completionCount: 3, completionIntervalSeconds: .5 });
  return { ...loaded, sounds, stops, notifier };
}
function transportFixture() {
  const requests = [];
  function call(payload, signal) {
    return new Promise((resolve, reject) => {
      const row = { payload, signal, settled: false };
      const aborted = () => row.reject(new Error('aborted'));
      const finish = callback => value => { if (row.settled) return; row.settled = true; signal?.removeEventListener('abort', aborted); callback(value); };
      row.resolve = finish(resolve); row.reject = finish(reject);
      signal?.addEventListener('abort', aborted, { once: true });
      requests.push(row);
      if (signal?.aborted) aborted();
    });
  }
  const pending = action => requests.find(row => !row.settled && (row.payload.action ?? 'watch') === action);
  return { requests, call, watch: () => pending('watch'), ack: () => pending('acknowledge') };
}
function receiverFixture(options = {}) {
  const loaded = loadClient(), wire = transportFixture(), states = [], events = [], statuses = [];
  const receiver = loaded.plugin.createCompletionReceiver({ call: wire.call, completed: (id, event) => events.push({ id, event }), sharedState: (state, metadata) => states.push({ state, metadata }), onStatus: value => statuses.push(value), later: loaded.clock.later, cancel: loaded.clock.cancel, ...options });
  return { ...loaded, wire, receiver, states, events, statuses };
}

test('canonical exact request ACKs survive delimiters, never answer controls, and cannot mute a replacement or another chat', () => {
  const f = notifierFixture();
  const sessionId = 'chat:"漢字:a';
  f.notifier.updatePending(new Map([[sessionId, { pendingInteraction: approval('call:"漢:a') }], ['other', { pendingInteraction: approval('call:"漢:a') }]]));
  const old = token(sessionId, 'approval', 'call:"漢:a');
  assert.deepEqual(Array.from(f.notifier.getAcknowledgementTokens(sessionId)), [old]);
  f.notifier.acknowledgeTokens(sessionId, [token('other', 'approval', 'call:"漢:a'), ' ["x"]']);
  assert.equal(f.notifier.attentionSource.getSnapshot().has(sessionId), true);
  f.notifier.acknowledgeTokens(sessionId, [old]);
  assert.equal(f.notifier.attentionSource.getSnapshot().has(sessionId), false);
  assert.equal(f.notifier.attentionSource.getSnapshot().has('other'), true);
  f.notifier.updatePending(new Map([[sessionId, { pendingInteraction: question('call:"漢:a') }], ['other', { pendingInteraction: approval('call:"漢:a') }]]));
  const before = f.sounds.length, stopped = f.stops.length;
  f.notifier.acknowledgeTokens(sessionId, [old]);
  assert.equal(f.stops.length, stopped, 'stale approval ACK must not fade the new question');
  assert.equal(f.notifier.attentionSource.getSnapshot().get(sessionId).kind, 'question');
  f.clock.advance(1000);
  assert.equal(f.sounds.length, before + 2, 'both the replacement and the unrelated chat still notify');
  f.notifier.acknowledge(sessionId);
  f.notifier.updatePending(new Map([[sessionId, { pendingInteraction: question('new', 'plan-review') }]]));
  assert.equal(f.notifier.attentionSource.getSnapshot().get(sessionId).kind, 'plan-review');
  f.notifier.dispose();
});

test('baseline tombstones precede pending playback while terminal snapshots stay read-only and silent', () => {
  const f = notifierFixture({ playbackReady: false });
  f.notifier.updatePending(new Map([['chat', { pendingInteraction: approval('S1') }]]));
  assert.equal(f.notifier.attentionSource.getSnapshot().get('chat').reminderActive, false);
  assert.equal(f.sounds.length, 0);
  f.notifier.reconcileSharedState(snapshot(5, [{ sessionId: 'chat', tokens: [token('chat', 'approval', 'S1')] }], [terminal('done', 'old-success'), { ...terminal('stopped', 'old-error', 'attention'), reason: 'error' }]));
  f.notifier.setPlaybackReady(true); f.notifier.unlock(); f.clock.advance(200000);
  assert.equal(f.sounds.length, 0, 'neither an acknowledged card nor baseline terminals may replay');
  const source = f.notifier.attentionSource, view = source.getSnapshot();
  assert.equal(view.has('chat'), false);
  assert.equal(view.get('done').kind, 'completion'); assert.equal(view.get('stopped').reason, 'error');
  assert.equal(view.get('done').reminderActive, false); assert.equal(view.get('stopped').reminderActive, false);
  assert.throws(() => view.clear(), /read-only/); assert.equal(Object.isFrozen(view.get('done')), true);
  for (let i = 0; i < 10; i++) assert.equal(source.getSnapshot(), view);
  f.notifier.updatePending(new Map([['chat', { pendingInteraction: approval('S2') }]]));
  assert.equal(f.sounds.length, 1, 'a new prompt gets its own budget');
  f.notifier.dispose();
});

test('stale S1 ACK cannot cancel S2 queued completion or stop another session', () => {
  const f = notifierFixture();
  f.notifier.completed('other', terminal('other', 'other'));
  f.notifier.completed('S1', terminal('chat', 'S1'));
  f.notifier.completed('S2', terminal('chat', 'S2'));
  const stopped = f.stops.length;
  f.notifier.acknowledgeTokens('chat', [token('chat', 'terminal', 'S1')]);
  assert.equal(f.stops.length, stopped);
  assert.deepEqual(Array.from(f.notifier.getAcknowledgementTokens('chat')), [token('chat', 'terminal', 'S2')]);
  f.clock.advance(4000);
  assert.equal(f.sounds.filter(row => row.sessionId === 'other').length, 3);
  assert.equal(f.sounds.filter(row => row.sessionId === 'chat').length, 3);
  assert.equal(f.notifier.attentionSource.getSnapshot().get('chat').reminderActive, false);
  const before = f.stops.length;
  f.notifier.acknowledgeTokens('chat', [token('chat', 'terminal', 'S1')]); assert.equal(f.stops.length, before);
  f.notifier.acknowledgeTokens('chat', [token('chat', 'terminal', 'S2')]);
  assert.equal(f.stops.at(-1).sessionId, 'chat', 'matching ACK also fades the final audible tail');
  assert.equal(f.notifier.attentionSource.getSnapshot().has('other'), true);
  f.notifier.dispose();
});

test('shared ACK atomically removes active and queued completion playback without playing cleared rows', () => {
  const f = notifierFixture();
  f.notifier.completed('a', terminal('a', 'a')); f.notifier.completed('b', terminal('b', 'b')); f.notifier.completed('c', terminal('c', 'c'));
  f.notifier.reconcileSharedState(snapshot(4, [{ sessionId: 'a', tokens: [token('a', 'terminal', 'a')] }, { sessionId: 'b', tokens: [token('b', 'terminal', 'b')] }], [terminal('a', 'a'), terminal('b', 'b'), terminal('c', 'c')]));
  assert.deepEqual(f.sounds.map(row => row.sessionId), ['a', 'c']);
  f.clock.advance(3000);
  assert.equal(f.sounds.filter(row => row.sessionId === 'b').length, 0);
  assert.equal(f.sounds.filter(row => row.sessionId === 'c').length, 3);
  f.notifier.dispose();
});

test('ACK responses never advance watch cursor; older snapshots/events cannot roll back current state', async () => {
  const f = receiverFixture(); f.receiver.start();
  f.wire.watch().resolve(frame(0)); await flush();
  const waiting = f.wire.watch(); assert.equal(waiting.payload.cursor, 0); assert.equal(waiting.payload.protocol, 2);
  f.receiver.acknowledge('chat', [token('chat', 'approval', 'S1')]);
  assert.equal(f.wire.ack().payload.protocol, 2);
  const current = terminal('chat', 'S2');
  f.wire.ack().resolve(frame(99, snapshot(5, [{ sessionId: 'chat', tokens: [token('chat', 'approval', 'S1')] }], [current]))); await flush();
  assert.equal(f.wire.watch(), waiting);
  waiting.resolve(frame(1, snapshot(3, [], [terminal('chat', 'S1')]), [terminal('chat', 'S1'), { type: 'clear-attention', sessionId: 'chat' }])); await flush();
  assert.deepEqual(f.states.map(row => row.state.revision), [0, 5]); assert.equal(f.events.length, 0);
  assert.equal(f.wire.watch().payload.cursor, 1, 'ACK cursor99 must not skip journal events');
  f.wire.watch().resolve(frame(99, snapshot(5, [], [current]), [current])); await flush();
  assert.deepEqual(f.events.map(row => row.id), ['S2']);
  f.receiver.stop(); await flush();
});

test('late ACK from a replaced Host cannot replace new-generation baseline or cursor', async () => {
  const f = receiverFixture(); f.receiver.start(); f.wire.watch().resolve(frame(10, snapshot(7))); await flush();
  f.receiver.acknowledge('chat', [token('chat', 'approval', 'S1')]); const oldAck = f.wire.ack();
  f.wire.watch().resolve(frame(0, snapshot(0, [], [terminal('chat', 'new')]), [], 'new-host')); await flush();
  oldAck.resolve(frame(100, snapshot(100, [], [terminal('chat', 'old')] ))); await flush();
  assert.equal(f.states.at(-1).metadata.generation, 'new-host');
  assert.equal(f.states.at(-1).state.terminals[0].id, 'new');
  assert.equal(f.wire.watch().payload.generation, 'new-host'); assert.equal(f.wire.watch().payload.cursor, 0);
  assert.equal(f.events.length, 0, 'baseline terminal is read-only');
  f.receiver.stop(); await flush();
});

test('transient failure and legacy ok response retain exact ACK queue until a v2 commit; teardown cancels retry', async () => {
  const f = receiverFixture(); f.receiver.start(); f.wire.watch().resolve(frame(0)); await flush();
  const first = token('chat', 'approval', 'S1'), next = token('chat', 'question', 'S2');
  f.receiver.acknowledge('chat', [first]); f.receiver.acknowledge('chat', [first, next]);
  assert.equal(f.wire.requests.filter(row => row.payload.action === 'acknowledge').length, 1);
  f.wire.ack().reject(new Error('temporary disconnect')); await flush();
  assert.equal(f.statuses.at(-1), 'deliveryRetry');
  f.clock.advance(500); await flush(); assert.deepEqual(Array.from(f.wire.ack().payload.tokens), [first, next]);
  f.wire.ack().resolve({ ok: true, value: { generation: 'host', cursor: 800, events: [] } }); await flush();
  assert.equal(f.statuses.at(-1), 'deliveryRetry', 'an old endpoint ignoring action must not confirm ACK');
  f.clock.advance(1500); await flush();
  assert.deepEqual(Array.from(f.wire.ack().payload.tokens), [first, next]);
  f.wire.ack().resolve(frame(2, snapshot(1, [{ sessionId: 'chat', tokens: [first, next] }]))); await flush();
  assert.equal(f.wire.ack(), undefined); assert.equal(f.statuses.at(-1), 'deliveryReady');
  f.receiver.acknowledge('other', [token('other', 'terminal', 'x')]); f.wire.ack().reject(new Error('offline')); await flush();
  const calls = f.wire.requests.length; f.receiver.stop(); await flush();
  assert.equal(f.clock.timers.size, 0); f.clock.advance(100000); await flush(); assert.equal(f.wire.requests.length, calls);
});

test('ACK tokens added while a commit is in flight remain queued for a separate exact commit', async () => {
  const f = receiverFixture(); f.receiver.start(); f.wire.watch().resolve(frame(0)); await flush();
  const a = token('chat', 'approval', 'a'), b = token('chat', 'question', 'b');
  f.receiver.acknowledge('chat', [a]); const first = f.wire.ack(); f.receiver.acknowledge('chat', [b]);
  first.resolve(frame(1, snapshot(1, [{ sessionId: 'chat', tokens: [a] }]))); await flush();
  assert.deepEqual(Array.from(f.wire.ack().payload.tokens), [b]);
  f.wire.ack().resolve(frame(2, snapshot(2, [{ sessionId: 'chat', tokens: [a, b] }]))); await flush();
  assert.equal(f.wire.ack(), undefined); f.receiver.stop(); await flush();
});

function gatedReceiverFixture(pending) {
  const f = notifierFixture({ playbackReady: false }), wire = transportFixture();
  f.notifier.updatePending(pending);
  const receiver = f.plugin.createCompletionReceiver({ call: wire.call, completed: (id, event) => f.notifier.completed(id, event), sharedState: value => f.notifier.reconcileSharedState(value), ready: () => f.notifier.setPlaybackReady(true), suspend: () => f.notifier.setPlaybackReady(false), reset: () => f.notifier.resetTerminalAttention(), later: f.clock.later, cancel: f.clock.cancel });
  receiver.start();
  return { ...f, wire, receiver, dispose() { receiver.stop(); f.notifier.dispose(); } };
}

test('new-generation reset gates due pending P1 before its tombstone snapshot is reconciled', async t => {
  const f = gatedReceiverFixture(new Map([['chat', { pendingInteraction: approval('P1') }]])); t.after(() => f.dispose());
  f.wire.watch().resolve(frame(0)); await flush(); assert.equal(f.sounds.length, 1);
  f.clock.jump(1000); // Timer is due but has not executed, as in a background tab.
  f.wire.watch().resolve(frame(0, snapshot(0, [{ sessionId: 'chat', tokens: [token('chat', 'approval', 'P1')] }]), [], 'replacement-host')); await flush();
  assert.equal(f.sounds.length, 1, 'reset must not tick a due card before applying the replacement snapshot');
  assert.equal(f.notifier.attentionSource.getSnapshot().has('chat'), false);
});

test('same-generation disconnect gates due pending replay and unlock until authoritative reconnect snapshot', async t => {
  const f = gatedReceiverFixture(new Map([['chat', { pendingInteraction: approval('P1') }]])); t.after(() => f.dispose());
  f.wire.watch().resolve(frame(0)); await flush(); assert.equal(f.sounds.length, 1);
  f.wire.watch().reject(new Error('offline')); await flush(); f.clock.jump(1000);
  f.notifier.updatePending(new Map([['chat', { pendingInteraction: approval('P1') }]])); f.notifier.unlock();
  assert.equal(f.sounds.length, 1, 'a root-store replay or asynchronous audio resume must stay gated');
  f.clock.advance(1000); await flush();
  f.wire.watch().resolve(frame(1, snapshot(1, [{ sessionId: 'chat', tokens: [token('chat', 'approval', 'P1')] }]))); await flush();
  assert.equal(f.sounds.length, 1); assert.equal(f.notifier.attentionSource.getSnapshot().has('chat'), false);
});

test('ACK-only storage failure does not gate unrelated notifications on a healthy watch', async t => {
  const f = gatedReceiverFixture(new Map([['chat', { pendingInteraction: approval('P1') }], ['other', { pendingInteraction: approval('P2') }]])); t.after(() => f.dispose());
  f.wire.watch().resolve(frame(0)); await flush();
  f.receiver.acknowledge('chat', f.notifier.acknowledge('chat')); f.wire.ack().reject(new Error('storage temporarily unavailable')); await flush();
  f.clock.advance(1000); await flush();
  assert.equal(f.sounds.filter(row => row.sessionId === 'other').length, 2);
  assert.equal(f.sounds.filter(row => row.sessionId === 'chat').length, 1);
});

function hostFixture() {
  let now = 0, route; const effects = [], timers = new Map(), calls = []; let serial = 0;
  const channel = installCompletionChannel({ effect(fn) { effects.push(fn()); }, connection: { fetch: { register(value) { route = value; return () => {}; } } } }, { now: () => now, later(fn) { const id = ++serial; timers.set(id, fn); return id; }, cancel: id => timers.delete(id) });
  return { channel, calls,
    advance(to) { now = to; channel.status(); },
    async call(payload, signal) {
      calls.push(payload);
      const request = new Request('http://test/api/' + COMPLETION_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: String(calls.length), method: COMPLETION_ENDPOINT, payload }), ...(signal ? { signal } : {}) });
      return (await (await route.fetch(request)).json()).result;
    },
    dispose() { for (const cleanup of effects.reverse()) cleanup?.(); },
  };
}
function syncedClient(host, pending) {
  const f = notifierFixture({ playbackReady: false });
  f.notifier.updatePending(pending);
  const receiver = f.plugin.createCompletionReceiver({ call: host.call, sharedState: value => f.notifier.reconcileSharedState(value), ready: () => f.notifier.setPlaybackReady(true), completed: (id, event) => f.notifier.completed(id, event), reset: () => f.notifier.resetTerminalAttention(), later: f.clock.later, cancel: f.clock.cancel });
  receiver.start();
  return { ...f, receiver, acknowledge(sessionId) { const tokens = f.notifier.acknowledge(sessionId); if (tokens.length) receiver.acknowledge(sessionId, tokens); }, dispose() { receiver.stop(); f.notifier.dispose(); } };
}

test('phone gesture silences laptop via authoritative Host with no echo; reload and reconnect beyond journal retain pending ACK', async t => {
  const host = hostFixture(); const pending = new Map([['chat', { pendingInteraction: approval('S1') }], ['other', { pendingInteraction: question('Q1') }]]);
  const phone = syncedClient(host, pending), laptop = syncedClient(host, pending);
  t.after(() => { phone.dispose(); laptop.dispose(); host.dispose(); });
  await flush(); assert.equal(phone.sounds.length, 2); assert.equal(laptop.sounds.length, 2);
  phone.acknowledge('chat'); await flush();
  assert.equal(phone.notifier.attentionSource.getSnapshot().has('chat'), false);
  assert.equal(laptop.notifier.attentionSource.getSnapshot().has('chat'), false);
  assert.equal(laptop.notifier.attentionSource.getSnapshot().has('other'), true);
  assert.equal(host.calls.filter(row => row.action === 'acknowledge').length, 1, 'remote reconciliation never echoes an ACK');
  laptop.clock.advance(3000);
  assert.equal(laptop.sounds.filter(row => row.sessionId === 'chat').length, 1);
  assert.equal(laptop.sounds.filter(row => row.sessionId === 'other').length, 3);
  laptop.receiver.stop(); host.advance(130000); laptop.receiver.start(); await flush();
  assert.equal(laptop.notifier.attentionSource.getSnapshot().has('chat'), false);
  const reload = syncedClient(host, new Map([['chat', { pendingInteraction: approval('S1') }]])); t.after(() => reload.dispose()); await flush();
  assert.equal(reload.sounds.length, 0, 'baseline must reconcile tombstones before pending playback');
  assert.equal(reload.notifier.attentionSource.getSnapshot().size, 0);
  assert.equal(host.calls.filter(row => row.action === 'acknowledge').length, 1);
});

function appliedFixture({ pending = new Map(), settings = {} } = {}) {
  const clock = clockFixture(), sounds = [], stopped = [], events = transportFixture(), audio = transportFixture(), cleanups = [], slots = [];
  const handlers = new Map(), formListeners = new Set();
  const document = { visibilityState: 'visible', addEventListener(type, fn) { let set = handlers.get(type); if (!set) handlers.set(type, set = new Set()); set.add(fn); }, removeEventListener(type, fn) { handlers.get(type)?.delete(fn); } };
  const window = new EventTarget(); window.CustomEvent = CustomEvent;
  window.AudioContext = class {
    state = 'running'; sampleRate = 8000; get currentTime() { return clock.now() / 1000; }
    createBuffer(_channels, length) { return { getChannelData: () => new Float32Array(length) }; }
    async decodeAudioData() { return { duration: 1 }; }
    createBufferSource() { const row = { connect() {}, disconnect() {}, start() { sounds.push({ at: clock.now() }); }, stop() { stopped.push({ at: clock.now() }); } }; return row; }
    createGain() { return { gain: { value: 1, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
    async close() {}
  };
  const loaded = loadClient({ window, document, clock });
  const value = { approvalEnabled: true, completionEnabled: true, volume: 50, approvalCount: 3, intervalSeconds: 1, repeatCount: 0, completionCount: 3, completionIntervalSeconds: .5, requestSound: '', questionSound: '', completionSound: '', ...settings };
  loaded.plugin.apply({
    effect(fn) { cleanups.push(fn()); }, locale: { register() {} },
    configForms: { get: () => ({ getSnapshot: () => ({ status: 'ready', value }), subscribe(fn) { formListeners.add(fn); return () => formListeners.delete(fn); } }) },
    uiSession: { sessionStatus: { getSnapshot: () => pending, subscribe: () => () => {} }, adapter: { current: { getSnapshot: () => ({ key: 'chat' }) } } },
    slots: { inject(_name, fn) { fn(); }, register(options) { slots.push(options); } },
    connection: { rpc: { call(_api, method, payload, signal) { return method.endsWith('/audio') ? audio.call(payload, signal) : events.call(payload, signal); } } },
  });
  const props = slots[0].inject();
  return { ...loaded, events, audio, sounds, stopped, ...props,
    click() { const boundary = { dataset: { conversationSession: 'chat' } }; const target = { nodeType: 1, closest: selector => selector === '[data-conversation-content][data-conversation-session]' ? boundary : null }; for (const fn of handlers.get('click') ?? []) fn({ type: 'click', isTrusted: true, target }); },
    dispose() { for (const cleanup of cleanups.reverse()) cleanup?.(); },
  };
}

test('applied client does not play pending cards before baseline; trusted gesture before baseline is queued locally', async t => {
  const f = appliedFixture({ pending: new Map([['chat', { pendingInteraction: approval('S1') }]]) }); t.after(() => f.dispose());
  await flush(); assert.equal(f.sounds.length, 0); assert.equal(f.window.__DSH_SOUND_ATTENTION__.getSnapshot().get('chat').reminderActive, false);
  f.click(); assert.equal(f.window.__DSH_SOUND_ATTENTION__.getSnapshot().has('chat'), false);
  assert.deepEqual(Array.from(f.events.ack().payload.tokens), [token('chat', 'approval', 'S1')]);
  f.events.watch().resolve(frame(0)); await flush(); assert.equal(f.sounds.length, 0, 'optimistic ACK survives the pre-commit baseline');
  f.events.ack().resolve(frame(1, snapshot(1, [{ sessionId: 'chat', tokens: [token('chat', 'approval', 'S1')] }]))); await flush(); assert.equal(f.sounds.length, 0);
});

test('applied remote exact ACK during terminal audio preparation cannot resurrect success or attention', async t => {
  for (const outcome of ['success', 'attention']) {
    const f = appliedFixture({ settings: { completionSound: 'slow', questionSound: 'slow' } }); t.after(() => f.dispose());
    f.events.watch().resolve(frame(0)); await flush();
    const event = terminal('chat', 'S1', outcome);
    f.events.watch().resolve(frame(1, snapshot(1, [], [event]), [event])); await flush();
    assert.equal(f.window.__DSH_SOUND_ATTENTION__.getSnapshot().has('chat'), true); assert.equal(f.sounds.length, 0);
    f.events.watch().resolve(frame(2, snapshot(2, [{ sessionId: 'chat', tokens: [token('chat', 'terminal', 'S1')] }], [event]), [{ type: 'acknowledged', sessionId: 'chat', tokens: [token('chat', 'terminal', 'S1')] }])); await flush();
    assert.equal(f.window.__DSH_SOUND_ATTENTION__.getSnapshot().has('chat'), false);
    f.audio.requests[0].resolve({ ok: true, value: { data: 'AQ==' } }); await flush(); f.clock.advance(4000); await flush();
    assert.equal(f.sounds.length, 0); assert.equal(f.events.requests.filter(row => row.payload.action === 'acknowledge').length, 0, 'remote ACK must never echo');
  }
});

test('terminal preparation settling during watch disconnect cannot start audio before ACK reconnect snapshot', async t => {
  const f = appliedFixture({ settings: { completionSound: 'slow' } }); t.after(() => f.dispose());
  f.events.watch().resolve(frame(0)); await flush(); const event = terminal('chat', 'S1');
  f.events.watch().resolve(frame(1, snapshot(1, [], [event]), [event])); await flush();
  f.events.watch().reject(new Error('watch offline')); await flush();
  f.audio.requests[0].resolve({ ok: true, value: { data: 'AQ==' } }); await flush();
  assert.equal(f.sounds.length, 0, 'settled preparation waits for authoritative watch reconciliation');
  f.clock.advance(500); await flush();
  f.events.watch().resolve(frame(2, snapshot(2, [{ sessionId: 'chat', tokens: [token('chat', 'terminal', 'S1')] }], [event]))); await flush();
  f.clock.advance(3000); await flush(); assert.equal(f.sounds.length, 0);
  assert.equal(f.window.__DSH_SOUND_ATTENTION__.getSnapshot().has('chat'), false);
});

test('applied stale S1 ACK during S2 audio preparation cannot cancel S2 after the shared buffer resolves', async t => {
  const f = appliedFixture({ settings: { completionSound: 'slow' } }); t.after(() => f.dispose());
  f.events.watch().resolve(frame(0)); await flush();
  const first = terminal('chat', 'S1'), next = terminal('chat', 'S2');
  f.events.watch().resolve(frame(1, snapshot(1, [], [first]), [first])); await flush();
  f.events.watch().resolve(frame(2, snapshot(2, [], [next]), [next])); await flush();
  f.events.watch().resolve(frame(3, snapshot(3, [{ sessionId: 'chat', tokens: [token('chat', 'terminal', 'S1')] }], [next]), [{ type: 'acknowledged', sessionId: 'chat', tokens: [token('chat', 'terminal', 'S1')] }])); await flush();
  assert.equal(f.notifier.isCurrentCompletion('S1', first), false); assert.equal(f.notifier.isCurrentCompletion('S2', next), true);
  f.audio.requests[0].resolve({ ok: true, value: { data: 'AQ==' } }); await flush();
  assert.equal(f.sounds.length, 1, 'only S2 begins after async preparation');
  f.clock.advance(1600); await flush(); assert.equal(f.sounds.length, 3);
  assert.equal(f.window.__DSH_SOUND_ATTENTION__.getSnapshot().get('chat').kind, 'completion');
});
