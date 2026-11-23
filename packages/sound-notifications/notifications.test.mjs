import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import { installHost, validatePatch, DEFAULTS } from './host-runtime.js';

let plugin;
vm.runInNewContext(readFileSync(new URL('./client.js', import.meta.url), 'utf8'), { window: { __ModuleLoader__: { load(def) { plugin = def.factory(() => ({})); } } }, setTimeout, clearTimeout, queueMicrotask, Date, console, AbortController });
function timerFixture(blocked = false, settings = { repeatCount: 0 }) {
  let time = 0, next = 0;
  const timers = new Map(), sounds = [];
  const notifier = plugin.createNotifier({ clock: () => time, play(volume) { if (blocked) return false; sounds.push({ time, volume }); return true; }, later(fn, delay) { const id = ++next; timers.set(id, { fn, time: time + delay }); return id; }, cancel(id) { timers.delete(id); } });
  notifier.updateSettings({ ...DEFAULTS, ...settings });
  const pending = (request = { kind: 'approval', answerable: true, key: 'a', callId: 'call' }) => notifier.updatePending(new Map(request ? [['session', { pendingInteraction: request }]] : []));
  function advance(to) { while (true) { const row = [...timers].sort((a, b) => a[1].time - b[1].time)[0]; if (!row || row[1].time > to) break; timers.delete(row[0]); time = row[1].time; row[1].fn(); } time = to; }
  // Run each already-scheduled timer once at a late wall-clock time (sleep /
  // browser throttling), rather than replaying all its missed deadlines.
  function lateWake(to) { time = to; const ready = [...timers]; timers.clear(); for (const [, timer] of ready) timer.fn(); }
  return { notifier, pending, advance, lateWake, sounds, timers, unblock() { blocked = false; notifier.unlock(); } };
}
function questionFixture(kind = 'question', initial = { channel: 'waterfall', closed: false }, extra = {}) {
  let snapshot = initial;
  const listeners = new Set();
  const request = { kind, key: 'question:s:call', callId: 'call', getSnapshot: () => snapshot, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, ...extra };
  return { request, get subscribers() { return listeners.size; }, change(next) { snapshot = { ...snapshot, ...next }; for (const fn of [...listeners]) fn(); } };
}
test('answer selectors have the exact same bell cadence, volume, pauses and total budget as approvals', () => {
  const approval = timerFixture(false, {}), selector = timerFixture(false, {});
  const q = questionFixture(); approval.pending(); selector.pending(q.request);
  approval.advance(10000000); selector.advance(10000000);
  assert.deepEqual(selector.sounds, approval.sounds); assert.equal(selector.sounds.length, 15);
  selector.notifier.dispose(); assert.equal(q.subscribers, 0);
});
test('selector waits for its answer channel, including an asynchronous attach without a root-store change', () => {
  const f = timerFixture(), q = questionFixture('question', { channel: 'none', closed: false });
  f.pending(q.request); f.advance(5000); assert.equal(f.sounds.length, 0);
  q.change({ channel: 'waterfall' }); assert.equal(f.sounds.length, 1); assert.equal(f.sounds[0].time, 5000);
  f.advance(45000); assert.equal(f.sounds.length, 5); f.notifier.dispose();
});
test('selector answer, cancellation or closing stops all remaining series immediately', () => {
  for (const change of [{ channel: 'none' }, { closed: true }]) {
    const f = timerFixture(false, {}), q = questionFixture();
    f.pending(q.request); f.advance(60000); assert.equal(f.sounds.length, 5);
    q.change(change); assert.equal(f.timers.size, 0);
    f.advance(10000000); assert.equal(f.sounds.length, 5); f.notifier.dispose();
  }
});
test('read-only history cards, unknown controls and closed selectors never ring', () => {
  const f = timerFixture();
  for (const q of [questionFixture('question', { channel: 'none', closed: false }, { review: { answers: [] } }), questionFixture('question', { channel: 'none', closed: false }), questionFixture('question', { channel: 'rpc', closed: true }), questionFixture('dropdown')]) f.pending(q.request);
  f.advance(10000000); assert.equal(f.sounds.length, 0); f.notifier.dispose();
});
test('plan-review and continued answerable selectors use the same bounded reminders', () => {
  for (const kind of ['question', 'plan-review']) {
    const f = timerFixture(), q = questionFixture(kind, { channel: 'rpc', closed: false });
    f.pending(q.request); f.advance(10000000); assert.equal(f.sounds.length, 5); f.notifier.dispose();
  }
});
test('repeated root snapshots do not duplicate selector subscriptions; hide and unload release them', () => {
  const f = timerFixture(), q = questionFixture();
  f.pending(q.request); f.pending(q.request); assert.equal(q.subscribers, 1); assert.equal(f.sounds.length, 1);
  f.pending(null); assert.equal(q.subscribers, 0); assert.equal(f.timers.size, 0);
  f.pending(q.request); assert.equal(q.subscribers, 1); assert.equal(f.sounds.length, 1);
  f.notifier.dispose(); assert.equal(q.subscribers, 0); q.change({ channel: 'rpc' }); assert.equal(f.timers.size, 0);
});
test('selector replacing approval with the same callId gets its own budget, not inherited exhaustion', () => {
  const f = timerFixture(); f.pending(); f.advance(50000); assert.equal(f.sounds.length, 5);
  const q = questionFixture(); f.pending(q.request); assert.equal(f.sounds.length, 6);
  f.advance(10000000); assert.equal(f.sounds.length, 10); f.notifier.dispose();
});
test('selector respects approval switch, zero volume and blocked autoplay without consuming its budget', () => {
  const f = timerFixture(true), q = questionFixture(); f.pending(q.request); assert.equal(f.sounds.length, 0);
  f.notifier.updateSettings({ ...DEFAULTS, repeatCount: 0, approvalEnabled: false }); f.unblock(); assert.equal(f.sounds.length, 0);
  f.notifier.updateSettings({ ...DEFAULTS, repeatCount: 0, volume: 0 }); assert.equal(f.sounds.length, 0);
  f.notifier.updateSettings({ ...DEFAULTS, repeatCount: 0 }); f.advance(10000000); assert.equal(f.sounds.length, 5); f.notifier.dispose();
});
test('reopening or replaying the same selector does not restart its long-cycle budget', () => {
  const f = timerFixture(false, {}), q = questionFixture(); f.pending(q.request); f.advance(40000);
  f.pending(null); assert.equal(q.subscribers, 0); f.advance(330000);
  const replay = questionFixture(); f.pending(replay.request); f.advance(10000000);
  assert.equal(f.sounds.length, 15); assert.equal(f.sounds[5].time, 340000); f.notifier.dispose();
});
test('crystal bell has smooth edges, headroom and a fading tail at browser sample rates', () => {
  for (const rate of [44100, 48000]) {
    const data = plugin.synthesizeBell(rate);
    assert.equal(data.length, Math.ceil(rate * 1.8));
    let peak = 0, jump = 0, sum = 0;
    for (let i = 0; i < data.length; i++) {
      assert.ok(Number.isFinite(data[i]));
      peak = Math.max(peak, Math.abs(data[i]));
      if (i > 0) jump = Math.max(jump, Math.abs(data[i] - data[i - 1]));
      sum += data[i];
    }
    assert.ok(peak > .49 && peak <= .501, `safe peak: ${peak}`);
    assert.ok(jump < .12, `no abrupt sample jumps: ${jump}`);
    assert.equal(data[0], 0);
    assert.ok(Math.abs(data.at(-1)) < 1e-8, 'tail finishes without a click');
    assert.ok(Math.abs(sum / data.length) < .001, 'no DC offset');
    const rms = (start, end) => {
      const samples = data.subarray(Math.floor(start * rate), Math.floor(end * rate));
      return Math.sqrt(samples.reduce((total, value) => total + value * value, 0) / samples.length);
    };
    assert.ok(rms(0, .003) < rms(.025, .06) * .04, 'gentle onset');
    assert.ok(rms(1.5, 1.7) < rms(.1, .3) * .05, 'quiet trailing shimmer');
  }
});
test('five bells at 0/10/20/30/40s, all at half volume', () => {
  const f = timerFixture(); f.pending(); f.advance(100000);
  assert.deepEqual(f.sounds, [0, 10000, 20000, 30000, 40000].map(time => ({ time, volume: 50 })));
  assert.equal(f.timers.size, 0);
});
test('actual bell player does not swallow signals at the supported one-second interval', async () => {
  let time = 0, localPlugin, actualSounds = 0, tailFades = 0;
  class AudioContext {
    state = 'running'; sampleRate = 8000;
    get currentTime() { return time / 1000; }
    createBuffer(_channels, length) { const data = new Float32Array(length); return { getChannelData: () => data }; }
    createBufferSource() { return { connect() {}, disconnect() {}, start() { actualSounds++; }, stop() {} }; }
    createGain() { return { gain: { value: 1, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() { tailFades++; } }, connect() {}, disconnect() {} }; }
    async close() {}
  }
  vm.runInNewContext(readFileSync(new URL('./client.js', import.meta.url), 'utf8'), {
    window: { AudioContext, __ModuleLoader__: { load(def) { localPlugin = def.factory(() => ({})); } } },
    Date: { now: () => time }, setTimeout, clearTimeout, queueMicrotask, console,
  });
  const bell = localPlugin.createBell(() => {}); await bell.unlock();
  for (time = 0; time <= 4000; time += 1000) assert.equal(bell.play(50), true);
  assert.equal(actualSounds, 5); assert.ok(tailFades > 0);
  for (const step of [500, 100]) {
    actualSounds = 0;
    const start = time;
    for (let i = 0; i < 4; i++) { time = start + i * step; assert.equal(bell.play(50), true); }
    assert.equal(actualSounds, 4, `all four completion bells audible at ${step}ms`);
    time += 200;
  }
  bell.dispose();
});
test('custom request and completion buffers stay distinct in real playback and fall back safely', async () => {
  let localPlugin, time = 0, fallback = 0, loads = 0;
  const starts = [], stops = [];
  class AudioContext {
    state = 'running'; sampleRate = 8000; currentTime = 0;
    createBuffer(_channels, length) { const data = new Float32Array(length); return { name: 'builtin', getChannelData: () => data }; }
    async decodeAudioData(array) { return { name: `custom-${new Uint8Array(array)[0]}`, duration: 1 }; }
    createBufferSource() { const node = { buffer: null, connect() {}, disconnect() {}, start() { starts.push(this.buffer.name); }, stop() { stops.push(this.buffer.name); } }; return node; }
    createGain() { return { gain: { value: 1, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
    async close() {}
  }
  vm.runInNewContext(readFileSync(new URL('./client.js', import.meta.url), 'utf8'), { window: { AudioContext, __ModuleLoader__: { load(def) { localPlugin = def.factory(() => ({})); } } }, Date: { now: () => time }, setTimeout, clearTimeout, queueMicrotask, console });
  const bell = localPlugin.createBell(() => {}, { loadSound: async ref => { loads++; if (ref === 'unavailable-ref') throw new Error('unavailable'); return new Uint8Array([ref === 'request-ref' ? 1 : 2]); }, onSoundError: () => fallback++ });
  await bell.unlock(); await Promise.all([bell.prepareSound('request-ref'), bell.prepareSound('completion-ref')]); await bell.prepareSound('request-ref'); assert.equal(loads, 2);
  bell.play(50, 'request', 'request-ref'); bell.play(50, 'completion', 'completion-ref');
  assert.deepEqual(starts, ['custom-1', 'custom-2']); assert.deepEqual(stops, [], 'different types never truncate each other');
  time = 700; bell.play(50, 'completion', 'completion-ref'); assert.deepEqual(stops, ['custom-2']);
  await assert.rejects(bell.prepareSound('unavailable-ref'), /unavailable/);
  time = 1400; bell.play(50, 'request', 'unavailable-ref'); assert.equal(starts.at(-1), 'builtin'); assert.equal(fallback, 1); bell.dispose();
});
test('saved audio survives preview churn, retryable load failures recover, and long clips stop by type', async () => {
  let localPlugin, loads = 0, time = 0, ready = 0;
  const starts = [], stops = [];
  class AudioContext {
    state = 'running'; sampleRate = 8000; currentTime = 0;
    createBuffer(_channels, length) { const data = new Float32Array(length); return { name: 'builtin', getChannelData: () => data }; }
    async decodeAudioData(array) { return { name: `custom-${new Uint8Array(array)[0]}`, duration: 30 }; }
    createBufferSource() { return { buffer: null, connect() {}, disconnect() {}, start() { starts.push(this.buffer.name); }, stop() { stops.push(this.buffer.name); } }; }
    createGain() { return { gain: { value: 1, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
    async close() {}
  }
  vm.runInNewContext(readFileSync(new URL('./client.js', import.meta.url), 'utf8'), { window: { AudioContext, __ModuleLoader__: { load(def) { localPlugin = def.factory(() => ({})); } } }, Date: { now: () => time }, setTimeout, clearTimeout, queueMicrotask, console });
  const bell = localPlugin.createBell(value => { if (value === 'ready') ready++; }, { loadSound: async () => { loads++; if (loads === 1) throw new Error('temporary read failure'); return new Uint8Array([7]); } });
  await bell.unlock(); await assert.rejects(bell.prepareSound('active-request'), /temporary/); await bell.prepareSound('active-request'); assert.equal(loads, 2);
  bell.setReferences(['active-request']);
  for (let i = 0; i < 12; i++) bell.rememberSound(`draft-${i}`, { name: `preview-${i}`, duration: 1 });
  time = 100; bell.play(50, 'request', 'active-request'); assert.equal(starts.at(-1), 'custom-7'); assert.equal(loads, 2, 'active reference pinned across draft previews');
  time = 200; bell.play(50, 'completion', ''); bell.stop('request'); assert.deepEqual(stops, ['custom-7']);
  bell.stop('request'); assert.deepEqual(stops, ['custom-7'], 'stop remains idempotent'); bell.stop('completion'); assert.equal(stops.at(-1), 'builtin'); assert.ok(ready >= 2); bell.dispose();
});
test('one failed sound cannot consume or permanently silence a different loading request', async () => {
  let localPlugin, release, notifier;
  let sounds = 0;
  class AudioContext {
    state = 'running'; sampleRate = 8000; currentTime = 0;
    createBuffer(_channels, length) { const data = new Float32Array(length); return { getChannelData: () => data }; }
    async decodeAudioData() { return { duration: 1 }; }
    createBufferSource() { return { connect() {}, disconnect() {}, start() { sounds++; }, stop() {} }; }
    createGain() { return { gain: { value: 1, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
    async close() {}
  }
  vm.runInNewContext(readFileSync(new URL('./client.js', import.meta.url), 'utf8'), { window: { AudioContext, __ModuleLoader__: { load(def) { localPlugin = def.factory(() => ({})); } } }, Date, setTimeout, clearTimeout, queueMicrotask, console });
  const bell = localPlugin.createBell(value => { if (value === 'ready') queueMicrotask(() => notifier?.unlock()); }, { loadSound: ref => ref === 'slow' ? new Promise(resolve => { release = resolve; }) : Promise.reject(new Error('failed')) });
  await bell.unlock();
  const slow = bell.prepareSound('slow'), failed = bell.prepareSound('failed').catch(() => {});
  notifier = localPlugin.createNotifier({ play: (volume, _id, kind, ref) => bell.play(volume, kind, ref) });
  notifier.updateSettings({ ...DEFAULTS, requestSound: 'slow', approvalCount: 1, repeatCount: 0 });
  notifier.updatePending(new Map([['s', { pendingInteraction: { kind: 'approval', answerable: true, callId: 'loading' } }]]));
  await failed; assert.equal(sounds, 0); release(new Uint8Array([1])); await slow;
  for (let i = 0; i < 8; i++) await Promise.resolve(); assert.equal(sounds, 1); notifier.dispose(); bell.dispose();
});
test('custom decoding rejects oversize, damaged and overlong audio before replacing any selection', async () => {
  let localPlugin, duration = 31, broken = false;
  class AudioContext {
    state = 'running'; sampleRate = 8000;
    createBuffer(_channels, length) { const data = new Float32Array(length); return { getChannelData: () => data }; }
    async decodeAudioData() { if (broken) throw new Error('decode failed'); return { duration }; }
    async close() {}
  }
  vm.runInNewContext(readFileSync(new URL('./client.js', import.meta.url), 'utf8'), { window: { AudioContext, __ModuleLoader__: { load(def) { localPlugin = def.factory(() => ({})); } } }, Date, setTimeout, clearTimeout, queueMicrotask, console });
  const bell = localPlugin.createBell(() => {});
  await assert.rejects(bell.decodeSound(new Uint8Array(0)), /audioSize/);
  await assert.rejects(bell.decodeSound(new Uint8Array(10 * 1024 * 1024 + 1)), /audioSize/);
  await assert.rejects(bell.decodeSound(new Uint8Array([1])), /audioDuration/);
  duration = 1; broken = true; await assert.rejects(bell.decodeSound(new Uint8Array([1])), /audioInvalid/);
  broken = false; assert.equal((await bell.decodeSound(new Uint8Array([1]))).duration, 1); bell.dispose();
});
test('notifier routes request and completion references without changing cadence or volume', () => {
  const calls = [], timers = new Map(); let time = 0, id = 0;
  const notifier = plugin.createNotifier({ play(volume, _id, kind, ref) { calls.push({ volume, kind, ref, time }); return true; }, clock: () => time, later(fn, delay) { timers.set(++id, { fn, at: time + delay }); return id; }, cancel: id => timers.delete(id) });
  notifier.updateSettings({ ...DEFAULTS, requestSound: 'req', completionSound: 'done', repeatCount: 0 });
  notifier.updatePending(new Map([['s', { pendingInteraction: { kind: 'approval', answerable: true, callId: 'a' } }]])); notifier.completed('end');
  assert.deepEqual(calls.slice(0, 2), [{ volume: 50, kind: 'request', ref: 'req', time: 0 }, { volume: 50, kind: 'completion', ref: 'done', time: 0 }]);
  const first = [...timers.values()].sort((a,b) => a.at - b.at)[0]; time = first.at; first.fn(); assert.equal(calls.at(-1).ref, 'done'); assert.equal(time, 500); notifier.dispose();
});
test('audio activation is silent and immediately resumes when browser allows autoplay', async () => {
  let localPlugin, resumes = 0, sounds = 0;
  class AudioContext {
    state = 'suspended'; sampleRate = 8000;
    createBuffer(_channels, length) { const data = new Float32Array(length); return { getChannelData: () => data }; }
    async resume() { resumes++; this.state = 'running'; this.onstatechange?.(); }
    createBufferSource() { sounds++; return {}; }
    async close() {}
  }
  vm.runInNewContext(readFileSync(new URL('./client.js', import.meta.url), 'utf8'), {
    window: { AudioContext, __ModuleLoader__: { load(def) { localPlugin = def.factory(() => ({})); } } },
    Date, setTimeout, clearTimeout, queueMicrotask, console,
  });
  const bell = localPlugin.createBell(() => {});
  assert.equal(await bell.unlock(), true); assert.equal(bell.status, 'ready');
  assert.equal(resumes, 1); assert.equal(sounds, 0, 'activation must not emit a test bell');
  bell.dispose();
});
test('blocked autoplay stays honest and a later permitted interaction can resume it', async () => {
  let localPlugin, permitted = false;
  class AudioContext {
    state = 'suspended'; sampleRate = 8000;
    createBuffer(_channels, length) { const data = new Float32Array(length); return { getChannelData: () => data }; }
    async resume() { if (permitted) { this.state = 'running'; this.onstatechange?.(); } }
    async close() {}
  }
  vm.runInNewContext(readFileSync(new URL('./client.js', import.meta.url), 'utf8'), {
    window: { AudioContext, __ModuleLoader__: { load(def) { localPlugin = def.factory(() => ({})); } } },
    Date, setTimeout, clearTimeout, queueMicrotask, console,
  });
  const bell = localPlugin.createBell(() => {});
  assert.equal(await bell.unlock(), false); assert.equal(bell.status, 'locked');
  assert.equal(bell.play(50), false); permitted = true;
  assert.equal(await bell.unlock(), true); assert.equal(bell.status, 'ready'); bell.dispose();
});
test('default long cycle is three bounded five-bell series with five-minute quiet gaps', () => {
  const f = timerFixture(false, {}); f.pending(); f.advance(10000000);
  const expected = [0, 340000, 680000].flatMap(start => [0, 10000, 20000, 30000, 40000].map(offset => ({ time: start + offset, volume: 50 })));
  assert.deepEqual(f.sounds, expected);
  assert.equal(f.timers.size, 0);
});
test('ten-minute pause and three extra series are independently configurable', () => {
  const f = timerFixture(false, { approvalCount: 2, intervalSeconds: 7, repeatPauseMinutes: 10, repeatCount: 3 });
  f.pending(); f.advance(10000000);
  assert.deepEqual(f.sounds.map(sound => sound.time), [0, 7000, 607000, 614000, 1214000, 1221000, 1821000, 1828000]);
  assert.equal(f.timers.size, 0);
});
test('zero extra series preserves the original one-series behavior', () => {
  const f = timerFixture(); f.pending(); f.advance(10000000); assert.equal(f.sounds.length, 5); assert.equal(f.timers.size, 0);
});
test('answer or withdrawal during a long pause cancels all later series', () => {
  for (const answer of [false, true]) {
    const f = timerFixture(false, {}); const request = { kind: 'approval', key: 'a', answerable: true };
    f.pending(request); f.advance(60000);
    if (answer) request.answerable = false; else f.pending(null);
    f.advance(10000000); assert.equal(f.sounds.length, 5); assert.equal(f.timers.size, 0);
  }
});
test('unload during long pause and disabling approvals stop all future reminders', () => {
  for (const unload of [false, true]) {
    const f = timerFixture(false, {}); f.pending(); f.advance(60000);
    if (unload) f.notifier.dispose(); else f.notifier.updateSettings({ ...DEFAULTS, approvalEnabled: false });
    f.advance(10000000); assert.equal(f.sounds.length, 5); assert.equal(f.timers.size, 0);
  }
});
test('shortening a long pause starts only one new series, without catch-up bursts', () => {
  const f = timerFixture(false, {}); f.pending(); f.advance(120000);
  f.notifier.updateSettings({ ...DEFAULTS, repeatPauseMinutes: 1, repeatCount: 1 });
  assert.equal(f.sounds.length, 6); assert.equal(f.sounds.at(-1).time, 120000);
  f.advance(10000000); assert.equal(f.sounds.length, 10); assert.equal(f.timers.size, 0);
});
test('late wake after sleep cannot replay missed signals or series in a burst', () => {
  const f = timerFixture(false, {}); f.pending(); f.lateWake(3600000);
  assert.equal(f.sounds.length, 2); assert.equal(f.sounds.at(-1).time, 3600000);
  assert.equal(f.timers.size, 1); f.notifier.dispose();
});
test('one signal per series still honors the long pause and total budget', () => {
  const f = timerFixture(false, { approvalCount: 1, repeatCount: 2, repeatPauseMinutes: 1 });
  f.pending(); f.advance(10000000); assert.deepEqual(f.sounds.map(sound => sound.time), [0, 60000, 120000]); assert.equal(f.timers.size, 0);
});
test('temporarily obscured or replayed approval does not reset its series budget', () => {
  const f = timerFixture(false, {}); f.pending(); f.advance(40000); f.pending(null);
  f.advance(330000); f.pending({ kind: 'approval', key: 'replayed', callId: 'call', answerable: true });
  f.advance(10000000); assert.equal(f.sounds.length, 15); assert.equal(f.sounds[5].time, 340000); assert.equal(f.timers.size, 0);
});
test('answer, reject, withdrawal and live answerable getter stop repeats', () => {
  const f = timerFixture(); const req = { kind: 'approval', key: 'a', answerable: true };
  f.pending(req); req.answerable = false; f.advance(50000); assert.equal(f.sounds.length, 1);
  f.pending(null); assert.equal(f.timers.size, 0);
});
test('Auto Review/no pending and unsupported interactions stay silent', () => {
  const f = timerFixture(); f.pending(null); f.pending({ kind: 'question', key: 'q', answerable: true }); f.advance(50000); assert.equal(f.sounds.length, 0);
});
test('rerender, temporary obscuring and reconnect callId do not restart budget', () => {
  const f = timerFixture(); f.pending(); f.advance(50000); f.pending(null); f.pending({ kind: 'approval', key: 'new-key', callId: 'call', answerable: true }); f.advance(100000); assert.equal(f.sounds.length, 5);
});
test('new request starts a fresh budget; dispose cancels timers', () => {
  const f = timerFixture(); f.pending(); f.pending({ kind: 'approval', key: 'b', answerable: true }); assert.equal(f.sounds.length, 2); f.notifier.dispose(); f.advance(50000); assert.equal(f.sounds.length, 2); assert.equal(f.timers.size, 0);
});
test('blocked autoplay consumes no budget and retries only on unlock', () => {
  const f = timerFixture(true); f.pending(); f.advance(20000); assert.equal(f.timers.size, 0); f.unblock(); f.advance(60000); assert.equal(f.sounds.length, 5);
});
test('live settings change count, interval, volume and switches', () => {
  const f = timerFixture(); f.notifier.updateSettings({ ...DEFAULTS, approvalCount: 2, intervalSeconds: 3, volume: 25 }); f.pending(); f.advance(9000); assert.deepEqual(f.sounds, [{ time: 0, volume: 25 }, { time: 3000, volume: 25 }]);
  f.notifier.updateSettings({ ...DEFAULTS, approvalEnabled: false }); f.pending({ kind: 'approval', key: 'c', answerable: true }); f.advance(30000); assert.equal(f.sounds.length, 2);
});
test('completion plays four distinct half-second bells once per event', () => {
  const f = timerFixture(); f.notifier.completed('a'); f.notifier.completed('a'); f.advance(10000);
  assert.deepEqual(f.sounds, [0, 500, 1000, 1500].map(time => ({ time, volume: 50 })));
  assert.equal(f.timers.size, 0); f.notifier.completed('a'); f.advance(20000); assert.equal(f.sounds.length, 4);
});
test('completion count and fractional start interval are independent of approval reminders', () => {
  const f = timerFixture(false, { completionCount: 3, completionIntervalSeconds: .25, volume: 25 });
  f.notifier.completed('a'); f.advance(5000);
  assert.deepEqual(f.sounds, [0, 250, 500].map(time => ({ time, volume: 25 })));
  f.notifier.updateSettings({ ...DEFAULTS, completionCount: 1 }); f.notifier.completed('b'); f.advance(10000);
  assert.equal(f.sounds.length, 4); assert.equal(f.timers.size, 0);
});
test('completion is canceled by disable, zero volume or disposal and never resumes an old event', () => {
  for (const kind of ['disable', 'mute', 'dispose']) {
    const f = timerFixture(); f.notifier.completed('a'); f.advance(600); assert.equal(f.sounds.length, 2);
    if (kind === 'dispose') f.notifier.dispose();
    else f.notifier.updateSettings({ ...DEFAULTS, ...(kind === 'disable' ? { completionEnabled: false } : { volume: 0 }) });
    f.advance(10000); assert.equal(f.sounds.length, 2); assert.equal(f.timers.size, 0);
    if (kind !== 'dispose') { f.notifier.updateSettings(DEFAULTS); f.notifier.completed('a'); f.advance(20000); assert.equal(f.sounds.length, 2); }
  }
});
test('disabled, muted and browser-blocked completion events do not get replayed later', () => {
  for (const settings of [{ completionEnabled: false }, { volume: 0 }, {}]) {
    const f = timerFixture(true, settings); f.notifier.completed('a'); f.advance(5000); f.unblock();
    f.notifier.updateSettings(DEFAULTS); f.notifier.completed('a'); f.advance(10000);
    assert.equal(f.sounds.length, 0); assert.equal(f.timers.size, 0);
  }
});
test('distinct completions queue four bells each and late wake never catches up in a burst', () => {
  const f = timerFixture(); f.notifier.completed('a'); f.advance(250); f.notifier.completed('b'); f.advance(5000);
  assert.deepEqual(f.sounds.map(x => x.time), [0, 500, 1000, 1500, 2000, 2500, 3000, 3500]);
  const late = timerFixture(); late.notifier.completed('a'); late.lateWake(100000);
  assert.equal(late.sounds.length, 2); late.advance(100999); assert.equal(late.sounds.length, 3);
  late.advance(101000); assert.equal(late.sounds.length, 4);
});
test('changes to completion count and interval apply to the next sequence, without restarting the current one', () => {
  const f = timerFixture(); f.notifier.completed('a'); f.advance(600);
  f.notifier.updateSettings({ ...DEFAULTS, completionCount: 2, completionIntervalSeconds: 2 }); f.advance(5000);
  assert.deepEqual(f.sounds.map(x => x.time), [0, 500, 1000, 1500]);
  f.notifier.completed('b'); f.advance(10000);
  assert.deepEqual(f.sounds.slice(4).map(x => x.time), [5000, 7000]);
});
test('preview uses the same sequence, cancels on replacement and cannot restart after disposal', () => {
  const timers = new Map(), sounds = []; let index = 0;
  const preview = plugin.createSignalSequence({ play: volume => { sounds.push(volume); return true; }, later(fn) { timers.set(++index, fn); return index; }, cancel(id) { timers.delete(id); } });
  preview.start({ count: 4, intervalSeconds: .5, volume: 50 }); assert.equal(timers.size, 1);
  preview.start({ count: 2, intervalSeconds: .1, volume: 25 }); assert.equal(timers.size, 1);
  preview.dispose(); assert.equal(timers.size, 0);
  preview.start({ count: 4, intervalSeconds: .5, volume: 50 }); assert.equal(timers.size, 0); assert.deepEqual(sounds, [50, 25]);
});
function hostFixture() {
  const events = new Map(), effects = [], sent = [], settings = { ...DEFAULTS }, timers = new Map();
  let tool, handler, goal, routeDisposed = false, next = 0;
  const agent = { id: 's', status: 'idle', session: { id: 's', header: {} }, inbox: { nextTurn: [], nextStep: [] }, whenIdle: async () => {} };
  const later = fn => { timers.set(++next, fn); return next; };
  const ctx = {
    logger: { warn() {} },
    agents: { get: id => id === agent.id ? agent : undefined, list: () => [agent] },
    settings: { describe: () => [{ ns: 'sound-notifications', revision: 1 }], update: async (_ns, patch) => Object.assign(settings, patch) },
    tools: { register(def) { if (def.name === 'sound_notifications_settings') tool = def; } },
    connection: { fetch: { register(route) {
      assert.deepEqual(route.methods, ['POST']);
      if (route.path === '/api/sound-notifications/events') { handler = route.fetch; return () => { routeDisposed = true; }; }
      assert.equal(route.path, '/api/sound-notifications/audio'); return () => {};
    } } },
    get: key => key === 'goals' ? { get: () => goal } : undefined,
    on(name, fn) { events.set(name, fn); }, effect(fn) { effects.push(fn()); },
  };
  installHost(ctx, Object.fromEntries(Object.keys(DEFAULTS).map(key => [key, { get: () => settings[key] }])), { later, cancel: id => timers.delete(id) });
  const call = async (payload, signal = new AbortController().signal) => {
    const response = await handler(new Request('http://dsh.internal/api/sound-notifications/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'test-call', method: 'sound-notifications/events', payload }), signal }));
    return (await response.json()).result;
  };
  const emit = (kind = 'completed', seq = 1, reason = {}) => events.get('session/event')(agent.session, { type: 'turn/end', seq, data: { reason: { kind, ...reason } } });
  let generation, cursor;
  async function flush() {
    if (!generation) { const baseline = await call({ clientId: 'test' }); generation = baseline.value.generation; cursor = baseline.value.cursor; }
    for (const [id, fn] of [...timers]) { timers.delete(id); fn(); }
    for (let i = 0; i < 16; i++) await Promise.resolve();
    const status = await tool.execute({ action: 'status' });
    if (status.delivery.cursor > cursor) {
      const result = await call({ clientId: 'test', generation, cursor }); cursor = result.value.cursor; sent.push(...result.value.events);
    }
  }
  return { events, emit, flush, call, sent, tool, agent, ctx, timers, settings, get routeDisposed() { return routeDisposed; }, setGoal(value) { goal = value; }, dispose() { for (const fn of effects.reverse()) fn?.(); } };
}
test('logical terminal notices survive disabled sound families without producing audio', async () => {
  for (const reason of ['completed', 'error', 'blocked', 'aborted']) {
    const f = hostFixture(); f.settings.approvalEnabled = false; f.settings.completionEnabled = false;
    f.emit(reason); await f.flush(); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].reason, reason);
    const client = timerFixture(false, { approvalEnabled:false, completionEnabled:false });
    client.notifier.completed('muted-'+reason, f.sent[0]);
    assert.equal(client.sounds.length,0);
    assert.equal(client.notifier.attentionSource.getSnapshot().get('s').kind, reason === 'completed' ? 'completion' : 'attention');
    assert.equal(client.notifier.attentionSource.getSnapshot().get('s').reminderActive,false);
    client.notifier.dispose(); f.dispose();
  }
});
test('error reason is retained privately in a read-only bridge without calling generic attention an error', () => {
  const f=timerFixture(false,{approvalEnabled:false,completionEnabled:false});
  f.notifier.observeCompletion('error',{sessionId:'e',outcome:'attention',reason:'error'});
  f.notifier.observeCompletion('blocked',{sessionId:'b',outcome:'attention',reason:'blocked'});
  const snapshot=f.notifier.attentionSource.getSnapshot();
  assert.equal(snapshot.get('e').reason,'error');assert.equal(snapshot.get('b').reason,undefined);
  assert.equal(Object.isFrozen(snapshot.get('e')),true);assert.equal(f.sounds.length,0);f.notifier.dispose();
});
test('host releases its authenticated RPC channel and pending timers on unload', async () => {
  const f = hostFixture(); assert.equal(f.routeDisposed, false); f.emit(); f.dispose(); assert.equal(f.routeDisposed, true); assert.equal(f.timers.size, 0);
});
test('terminal stops notify for every outcome, independently of Goal success', async () => {
  for (const goal of [undefined, { phase: 'active', activation: 'disarmed' }, { phase: 'complete' }, { phase: 'paused' }, { phase: 'blocked' }]) {
    for (const reason of ['completed', 'error', 'aborted', 'max-tokens', 'blocked', 'interrupted']) {
      const f = hostFixture(); f.setGoal(goal); f.emit(reason); await f.flush();
      assert.equal(f.sent.length, 1, `${goal?.phase ?? 'no goal'} / ${reason}`); assert.equal(f.sent[0].reason, reason); f.dispose();
    }
  }
});
test('armed active Goal stays silent between rounds and rings when disarmed/blocked without a new turn', async () => {
  for (const stopped of [{ phase: 'active', activation: 'disarmed' }, { phase: 'blocked', activation: 'disarmed' }, { phase: 'complete' }]) {
    const f = hostFixture(); f.setGoal({ phase: 'active', activation: 'armed' }); f.emit(); await f.flush(); assert.equal(f.sent.length, 0);
    f.setGoal(stopped); f.events.get('goal/changed')({ agent: f.agent }); await f.flush(); assert.equal(f.sent.length, 1); f.dispose();
  }
});
test('explicit stop or error rings even if Goal remains armed, but teardown and forks are silent', async () => {
  const f = hostFixture(); f.setGoal({ phase: 'active', activation: 'armed' }); f.emit('error'); await f.flush(); assert.equal(f.sent.length, 1);
  f.emit('aborted', 2, { reason: { kind: 'disposed' } }); f.emit('forked', 3); await f.flush(); assert.equal(f.sent.length, 1); f.dispose();
});
test('host excludes subagents, stale Session identities and candidates superseded by a new turn', async () => {
  const f = hostFixture(); f.agent.session.header.origin = 'subagent'; f.emit(); await f.flush(); assert.equal(f.sent.length, 0);
  delete f.agent.session.header.origin;
  f.events.get('session/event')({ id: 's' }, { type: 'turn/end', seq: 1, data: { reason: { kind: 'completed' } } }); await f.flush(); assert.equal(f.sent.length, 0);
  f.emit(); f.events.get('session/event')(f.agent.session, { type: 'turn/start' }); await f.flush(); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].type, 'clear-attention'); f.dispose();
});
test('a running parent or pending next turn suppresses interim completion until the actual final idle', async () => {
  const f = hostFixture(); f.agent.status = 'running'; f.emit(); await f.flush(); assert.equal(f.sent.length, 0);
  f.agent.status = 'idle'; f.events.get('agent/status')({ agent: f.agent, status: 'idle' }); await f.flush(); assert.equal(f.sent.length, 1); f.dispose();
});
test('fresh client baseline never replays old events; retained cursor recovers a brief disconnect', async () => {
  const f = hostFixture(); const first = await f.call({ clientId: 'observer' });
  f.emit('completed'); await f.flush();
  const recovery = await f.call({ clientId: 'observer', generation: first.value.generation, cursor: first.value.cursor }); assert.equal(recovery.value.events.length, 1);
  const fresh = await f.call({ clientId: 'new-page' }); assert.equal(fresh.value.events.length, 0);
  const invalid = await f.call({ clientId: 'invalid', cursor: -1 }); assert.equal(invalid.ok, false); f.dispose();
});
test('real Host terminal event travels over the selected RPC carrier into the notification sequence', async () => {
  const f = hostFixture(), audio = timerFixture(false, { completionCount: 5, completionIntervalSeconds: .7 });
  const received = [], statuses = [];
  const receiver = plugin.createCompletionReceiver({ call: (payload, signal) => f.call(payload, signal), completed(id) { received.push(id); audio.notifier.completed(id); }, audio: () => 'ready', onStatus: status => statuses.push(status) });
  receiver.start(); for (let i = 0; i < 12; i++) await Promise.resolve();
  f.emit('completed'); await f.flush(); for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(received.length, 1); assert.equal(statuses.includes('deliveryReady'), true);
  audio.advance(10000); assert.deepEqual(audio.sounds.map(x => x.time), [0, 700, 1400, 2100, 2800]);
  const health = await f.tool.execute({ action: 'status' }); assert.equal(health.delivery.clients.some(client => client.received === received[0]), true);
  receiver.stop(); f.dispose();
});
test('Host long poll releases immediately on cancellation', async () => {
  const f = hostFixture(), abort = new AbortController(); const baseline = await f.call({ clientId: 'abort' });
  const poll = f.call({ clientId: 'abort', generation: baseline.value.generation, cursor: baseline.value.cursor }, abort.signal);
  abort.abort(new Error('test canceled')); await assert.rejects(poll, /test canceled/); f.dispose();
});
test('receiver does not start before settings readiness and contains retry after teardown', async () => {
  let calls = 0; const statuses = [];
  const receiver = plugin.createCompletionReceiver({ call: async () => { calls++; throw new Error('unavailable'); }, completed() { assert.fail('no delivery'); }, onStatus: value => statuses.push(value), later() { return 1; }, cancel() {} });
  assert.equal(calls, 0); receiver.start(); for (let i = 0; i < 4; i++) await Promise.resolve();
  assert.equal(calls, 1); assert.equal(statuses.includes('deliveryRetry'), true); receiver.stop();
  for (let i = 0; i < 4; i++) await Promise.resolve(); assert.equal(calls, 1);
});
test('tool and UI share settings service; validate ranges and unknown fields', async () => {
  const f = hostFixture();
  const initial = await f.tool.execute({ action: 'get' }); assert.equal(initial.settings.volume, 50);
  await f.tool.execute({ action: 'update', settings: { volume: 25, intervalSeconds: 5, repeatPauseMinutes: 10, repeatCount: 3 } });
  const updated = (await f.tool.execute({ action: 'get' })).settings; assert.equal(updated.volume, 25); assert.equal(updated.repeatPauseMinutes, 10); assert.equal(updated.repeatCount, 3);
  await f.tool.execute({ action: 'update', settings: { completionCount: 6, completionIntervalSeconds: .25 } });
  const completion = (await f.tool.execute({ action: 'get' })).settings; assert.equal(completion.completionCount, 6); assert.equal(completion.completionIntervalSeconds, .25);
  assert.equal(f.tool.parameters.properties.settings.properties.completionIntervalSeconds.type, 'number');
  await f.tool.execute({ action: 'update', settings: { ...DEFAULTS } }); assert.equal((await f.tool.execute({ action: 'get' })).settings.volume, 50);
  for (const patch of [{ volume: 101 }, { approvalCount: 1.5 }, { intervalSeconds: 0 }, { repeatPauseMinutes: 0 }, { repeatPauseMinutes: 1441 }, { repeatPauseMinutes: 2.5 }, { repeatCount: -1 }, { repeatCount: 21 }, { repeatCount: 1.5 }, { surprise: true }, { toString: 1 }, { approvalEnabled: 1 }, { completionCount: 0 }, { completionCount: 21 }, { completionCount: 1.5 }, { completionIntervalSeconds: .09 }, { completionIntervalSeconds: 11 }, { completionIntervalSeconds: NaN }]) assert.throws(() => validatePatch(patch)); f.dispose();
});
test('settings register on the plugin bundle and Configure row, not General', () => {
  const registrations = [];
  const sharedForm = { getSnapshot: () => ({ status: 'ready', value: DEFAULTS }) };
  // Service-contract unit test only; no React/DOM rendering or fake preview.
  const ctx = {
    effect() {},
    locale: { register() {} },
    configForms: { get(namespace) { assert.equal(namespace, 'sound-notifications'); return sharedForm; } },
    slots: { inject(_name, register) { return register(); }, register(options, component) { registrations.push({ options, component }); return () => {}; } },
  };
  plugin.apply(ctx);
  const bundle = registrations.find(({ options }) => options.name === 'plugins.bundle.config');
  const row = registrations.find(({ options }) => options.name === 'plugins.row.config');
  assert.equal(bundle.options.key, '@local/sound-notifications');
  assert.equal(row.options.key, '@local/sound-notifications#sound-notifications');
  assert.equal(bundle.options.inject().settingsForm, sharedForm);
  assert.equal(row.options.inject().settingsForm, sharedForm);
  assert.equal(bundle.component, row.component);
  assert.equal(bundle.component({ view: 'summary', t: key => key }), 'description');
  assert.equal(registrations.some(({ options }) => options.name === 'settings.general.item'), false);
});
test('questions and plan review use a third file with identical cadence and independent cancellation', () => {
  for (const questionKind of ['question', 'plan-review']) {
    const calls = [], stops = [], timers = new Map(); let time = 0, id = 0;
    const notifier = plugin.createNotifier({ play(volume, _id, kind, ref) { calls.push({ time, volume, kind, ref }); return true; }, stop: kind => stops.push(kind), clock: () => time, later(fn, delay) { timers.set(++id, { fn, at: time + delay }); return id; }, cancel: key => timers.delete(key) });
    notifier.updateSettings({ ...DEFAULTS, requestSound: 'access', questionSound: 'question', completionSound: 'done', repeatCount: 0 });
    const q = questionFixture(questionKind);
    notifier.updatePending(new Map([['a', { pendingInteraction: { kind: 'approval', answerable: true, callId: 'access' } }], ['q', { pendingInteraction: q.request }]]));
    function advance(to) { while (true) { const row = [...timers].sort((a,b) => a[1].at - b[1].at)[0]; if (!row || row[1].at > to) break; timers.delete(row[0]); time = row[1].at; row[1].fn(); } time = to; }
    advance(40000);
    const access = calls.filter(call => call.kind === 'request'), questions = calls.filter(call => call.kind === 'question');
    assert.equal(access.length, 5); assert.equal(questions.length, 5);
    assert.deepEqual(questions.map(({time,volume}) => ({time,volume})), access.map(({time,volume}) => ({time,volume})));
    assert.ok(questions.every(call => call.ref === 'question')); assert.ok(access.every(call => call.ref === 'access'));
    stops.length = 0; q.change({ closed: true }); assert.ok(stops.includes('question')); assert.ok(!stops.includes('request'));
    notifier.dispose();
  }
});
test('each of three file selectors places its preview immediately after its filename', () => {
  let localPlugin;
  const registrations = [], effects = [];
  const React = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children }; },
    useSyncExternalStore(_subscribe, get) { return get(); },
    useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}]; },
    useRef(value) { return { current: value }; }, useEffect() {},
  };
  vm.runInNewContext(readFileSync(new URL('./client.js', import.meta.url), 'utf8'), { window: { __ModuleLoader__: { load(def) { localPlugin = def.factory(() => React); } } }, setTimeout, clearTimeout, queueMicrotask, Date, console, AbortController });
  const form = { getSnapshot: () => ({ status: 'ready', value: DEFAULTS, writable: true, revision: 1 }) };
  localPlugin.apply({ effect(fn) { effects.push(fn); }, locale: { register() {} }, configForms: { get: () => form }, slots: { inject(_name, fn) { fn(); }, register(options, component) { registrations.push({ options, component }); } } });
  const entry = registrations.find(row => row.options.name === 'plugins.bundle.config');
  const wrapped = entry.component({ ...entry.options.inject(), view: 'page', t: key => key });
  const tree = wrapped.type(wrapped.props);
  const files = tree.children.filter(node => node?.props?.className === 'dsh-bell-audio');
  assert.equal(files.length, 3);
  for (const file of files) {
    const actions = file.children[1];
    assert.match(actions.children[0].props.className, /dsh-bell-filename/);
    assert.equal(actions.children[1].type, 'button'); assert.equal(typeof actions.children[1].props.onClick, 'function');
    assert.equal(actions.children[2].children[0], 'useBuiltin');
  }
  const footer = tree.children.find(node => node?.props?.className === 'dsh-bell-actions');
  assert.deepEqual(footer.children.map(node => node.children[0]), ['save', 'reset']);
});
test('attention stops repeat like questions and acknowledge cancels only one session without answering', () => {
  let time = 0, next = 0; const timers = new Map(), calls = [], stops = [];
  const notifier = plugin.createNotifier({ clock: () => time, play(volume, _id, kind, ref, sessionId) { calls.push({time,volume,kind,ref,sessionId}); return true; }, stop: (kind, sessionId) => stops.push({kind,sessionId}), later(fn, delay) { timers.set(++next, {fn,at:time+delay}); return next; }, cancel: id => timers.delete(id) });
  notifier.updateSettings({...DEFAULTS, questionSound:'attention-file', completionSound:'victory-file', repeatCount:0});
  notifier.completed('a1', {outcome:'attention',sessionId:'a'}); notifier.completed('b1', {outcome:'attention',sessionId:'b'});
  assert.deepEqual(calls.map(call => call.ref), ['attention-file','attention-file']);
  notifier.acknowledge('a');
  function advance(to) { while (true) { const row = [...timers].sort((a,b)=>a[1].at-b[1].at)[0]; if(!row || row[1].at>to) break; timers.delete(row[0]); time=row[1].at; row[1].fn(); } time=to; }
  advance(40000); assert.equal(calls.filter(call=>call.sessionId==='a').length,1); assert.equal(calls.filter(call=>call.sessionId==='b').length,5);
  notifier.completed('a1', {outcome:'attention',sessionId:'a'}); assert.equal(calls.filter(call=>call.sessionId==='a').length,1);
  notifier.completed('a2', {outcome:'attention',sessionId:'a'}); assert.equal(calls.at(-1).sessionId,'a');
  notifier.clearAttention('a'); advance(80000); assert.equal(calls.filter(call=>call.sessionId==='a').length,2);
  const q = questionFixture(); notifier.updatePending(new Map([['q',{pendingInteraction:q.request}]])); const count=calls.length;
  notifier.acknowledge('q'); assert.equal(q.request.getSnapshot().closed,false); notifier.updatePending(new Map([['q',{pendingInteraction:q.request}]])); advance(120000); assert.equal(calls.length,count);
  const newer=questionFixture('question',undefined,{callId:'new-question'}); notifier.updatePending(new Map([['q',{pendingInteraction:newer.request}]])); assert.equal(calls.length,count+1);
  notifier.dispose(); assert.ok(stops.some(stop=>stop.sessionId==='a'));
});
test('victory queued playback and audible tails can be acknowledged per chat', () => {
  const calls=[], stopped=[]; let next=0; const timers=new Map();
  const notifier=plugin.createNotifier({play(_v,_id,kind,ref,sessionId){calls.push({kind,ref,sessionId});return true;},stop:(kind,sessionId)=>stopped.push({kind,sessionId}),later(fn){timers.set(++next,fn);return next;},cancel:id=>timers.delete(id)});
  notifier.updateSettings({...DEFAULTS,completionSound:'win',completionCount:4});
  notifier.completed('a',{outcome:'success',sessionId:'a'}); notifier.completed('b',{outcome:'success',sessionId:'b'}); notifier.completed('a2',{outcome:'success',sessionId:'a'});
  notifier.acknowledge('a'); assert.deepEqual(calls.map(call=>call.sessionId),['a','b']);
  assert.ok(stopped.some(row=>row.kind==='completion'&&row.sessionId==='a')); notifier.dispose();
});
test('only trusted clicks and keyboard input inside the selected chat acknowledge, never sidebar selection', () => {
  const body={dataset:{conversationSession:'chat-a'}};
  const target={nodeType:1,closest(selector){return selector==='[data-conversation-content][data-conversation-session]' ? body : null;}};
  for(const type of ['click','keydown']) assert.equal(plugin.chatGestureSession({isTrusted:true,type,target},'chat-a'),'chat-a');
  assert.equal(plugin.chatGestureSession({isTrusted:false,type:'click',target},'chat-a'),undefined);
  assert.equal(plugin.chatGestureSession({isTrusted:true,type:'mousemove',target},'chat-a'),undefined);
  assert.equal(plugin.chatGestureSession({isTrusted:true,type:'click',target},'chat-b'),undefined);
  assert.equal(plugin.chatGestureSession({isTrusted:true,type:'click',target:{nodeType:1,closest:()=>null}},'chat-a'),undefined);
});
test('authenticated receiver preserves outcome metadata and clears stale attention on a new turn', async () => {
  const received=[], cleared=[]; let call=0;
  const receiver=plugin.createCompletionReceiver({ call: async (_payload, signal) => {
    if (++call===1) return {ok:true,value:{generation:'g',cursor:0,events:[]}};
    if(call===2) return {ok:true,value:{generation:'g',cursor:2,events:[{type:'completed',id:'stop',sessionId:'a',outcome:'attention',openTodos:1,goalPhase:'active'},{type:'clear-attention',sessionId:'a'}]}};
    return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));
  }, completed:(id,event)=>received.push({id,event}),clear:sessionId=>cleared.push(sessionId)});
  receiver.start(); for(let i=0;i<12;i++) await Promise.resolve(); receiver.stop();
  assert.equal(received.length,1); assert.equal(received[0].event.outcome,'attention'); assert.equal(received[0].event.openTodos,1); assert.deepEqual(cleared,['a']);
});
test('attention source is read-only, stable, side-effect-free and change-driven', () => {
  const f = timerFixture(); const source = f.notifier.attentionSource;
  let changes = 0; const off = source.subscribe(() => changes++);
  const empty = source.getSnapshot(); assert.equal(source.getSnapshot(), empty);
  assert.equal(changes, 0); assert.equal(f.sounds.length, 0); assert.equal(f.timers.size, 0);
  f.pending(); const first = source.getSnapshot();
  assert.notEqual(first, empty); assert.equal(first.get('session').kind, 'approval'); assert.equal(first.get('session').reminderActive, true);
  assert.equal(changes, 1); const timers = f.timers.size, sounds = f.sounds.length;
  for (let i = 0; i < 20; i++) assert.equal(source.getSnapshot(), first);
  assert.equal(f.timers.size, timers); assert.equal(f.sounds.length, sounds);
  assert.throws(() => first.clear(), /read-only/); assert.throws(() => first.set('fake', {}), /read-only/);
  assert.throws(() => { first.get('session').kind = 'fake'; }, TypeError);
  f.pending(); assert.equal(source.getSnapshot(), first); assert.equal(changes, 1);
  off(); f.notifier.acknowledge('session'); assert.equal(changes, 1); assert.equal(source.getSnapshot().size, 0);
  f.notifier.dispose();
});
test('muting disabling and exhausting reminders preserve unacknowledged attention', () => {
  const f = timerFixture(); const source = f.notifier.attentionSource;
  f.pending(); f.advance(40000);
  assert.equal(source.getSnapshot().get('session').reminderActive, false);
  f.notifier.updateSettings({ ...DEFAULTS, repeatCount: 0, volume: 0 });
  assert.equal(source.getSnapshot().get('session').kind, 'approval');
  assert.equal(source.getSnapshot().get('session').reminderActive, false);
  f.notifier.completed('stop-muted', { outcome: 'attention', sessionId: 'stopped' });
  assert.equal(source.getSnapshot().get('stopped').kind, 'attention'); assert.equal(source.getSnapshot().get('stopped').reminderActive, false);
  f.notifier.updateSettings({ ...DEFAULTS, repeatCount: 0, approvalEnabled: false });
  assert.equal(source.getSnapshot().get('stopped').reminderActive, false);
  f.notifier.updateSettings({ ...DEFAULTS, repeatCount: 0 });
  assert.equal(source.getSnapshot().get('stopped').reminderActive, true);
  assert.equal(source.getSnapshot().get('session').reminderActive, false, 'old exhausted budget is not restarted');
  f.notifier.acknowledge('stopped'); assert.equal(source.getSnapshot().has('stopped'), false);
  f.notifier.clearAttention('session'); assert.equal(source.getSnapshot().has('session'), true, 'new-turn clear does not answer an existing approval');
  f.notifier.dispose();
});
test('blocked autoplay preserves attention with inactive reminders and resumes only on unlock', () => {
  const f = timerFixture(true); const source = f.notifier.attentionSource;
  f.pending(); assert.equal(source.getSnapshot().get('session').reminderActive, false); assert.equal(f.timers.size, 0);
  f.notifier.completed('stop', { outcome: 'attention', sessionId: 'stopped' });
  assert.equal(source.getSnapshot().get('stopped').reminderActive, false);
  f.unblock(); assert.equal(source.getSnapshot().get('stopped').reminderActive, true); assert.equal(f.sounds.length, 2);
  f.notifier.dispose();
});
test('question and plan review source tracks answer-channel changes and acknowledgment without answering', () => {
  for (const kind of ['question', 'plan-review']) {
    const f = timerFixture(), q = questionFixture(kind, { channel: 'none', closed: false }); const source = f.notifier.attentionSource;
    f.pending(q.request); assert.equal(source.getSnapshot().size, 0);
    q.change({ channel: 'rpc' }); assert.equal(source.getSnapshot().get('session').kind, kind);
    q.change({ closed: true }); assert.equal(source.getSnapshot().size, 0);
    q.change({ closed: false }); f.notifier.acknowledge('session'); assert.equal(source.getSnapshot().size, 0);
    assert.equal(q.request.getSnapshot().closed, false); f.pending(q.request); assert.equal(source.getSnapshot().size, 0);
    f.notifier.dispose(); assert.equal(q.subscribers, 0);
  }
});
test('completion source tracks active and queued playback then retained inactive notices', () => {
  const f = timerFixture(false, { completionCount: 2, completionIntervalSeconds: 0.5 }); const source = f.notifier.attentionSource;
  f.notifier.completed('a', { sessionId: 'a' }); f.notifier.completed('b', { sessionId: 'b' });
  assert.equal(source.getSnapshot().get('a').kind, 'completion'); assert.equal(source.getSnapshot().get('a').reminderActive, true);
  assert.equal(source.getSnapshot().get('b').reminderActive, true);
  f.advance(1000); assert.equal(source.getSnapshot().get('a').reminderActive, false); assert.equal(source.getSnapshot().get('b').reminderActive, true);
  f.advance(2000); assert.equal(source.getSnapshot().get('b').reminderActive, false);
  f.notifier.acknowledge('a'); assert.equal(source.getSnapshot().has('a'), false);
  f.notifier.updateSettings({ ...DEFAULTS, volume: 0 }); f.notifier.completed('muted', { sessionId: 'muted' });
  assert.equal(source.getSnapshot().get('muted').reminderActive, false);
  f.notifier.clearAttention('b'); assert.equal(source.getSnapshot().has('b'), false); f.notifier.dispose();
});
test('terminal observation does not wait for audio and reset clears terminals but keeps live interactions', () => {
  const f = timerFixture(); const source = f.notifier.attentionSource; f.pending(); const count = f.sounds.length;
  f.notifier.observeCompletion('stop', { outcome: 'attention', sessionId: 'stopped' });
  f.notifier.observeCompletion('done', { sessionId: 'done' });
  assert.equal(f.sounds.length, count); assert.equal(source.getSnapshot().get('stopped').kind, 'attention');
  assert.equal(source.getSnapshot().get('done').kind, 'completion'); assert.equal(source.getSnapshot().get('done').reminderActive, false);
  f.notifier.resetTerminalAttention(); assert.deepEqual([...source.getSnapshot().keys()], ['session']); f.notifier.dispose();
});
test('disposal publishes one empty snapshot and releases all subscriptions and timers', () => {
  const f = timerFixture(), q = questionFixture(); f.pending(q.request); const source = f.notifier.attentionSource;
  let changes = 0; source.subscribe(() => changes++); f.notifier.dispose();
  assert.equal(changes, 1); assert.equal(source.getSnapshot().size, 0); assert.equal(q.subscribers, 0); assert.equal(f.timers.size, 0);
  const empty = source.getSnapshot(); source.subscribe(() => changes++); f.notifier.dispose();
  q.change({ channel: 'none' }); f.notifier.completed('late', { sessionId: 'late' });
  assert.equal(changes, 1); assert.equal(source.getSnapshot(), empty);
});
test('global bridge announces registration and removal without coupling replacement lifetime', () => {
  const target = new EventTarget(); target.CustomEvent = CustomEvent;
  const seen = []; target.addEventListener('dsh:sound-attention-changed', () => seen.push(target.__DSH_SOUND_ATTENTION__));
  const a = timerFixture(), b = timerFixture();
  const removeA = plugin.registerAttentionBridge(a.notifier.attentionSource, target);
  const removeB = plugin.registerAttentionBridge(b.notifier.attentionSource, target);
  assert.equal(seen[0], a.notifier.attentionSource); assert.equal(seen[1], b.notifier.attentionSource);
  removeA(); assert.equal(target.__DSH_SOUND_ATTENTION__, b.notifier.attentionSource); assert.equal(seen.length, 2);
  removeB(); assert.equal(target.__DSH_SOUND_ATTENTION__, undefined); assert.equal(seen.length, 3);
  removeB(); assert.equal(seen.length, 3); a.notifier.dispose(); b.notifier.dispose();
});
test('switcher and navigation gestures never acknowledge a chat', () => {
  const body = { dataset: { conversationSession: 'chat' } };
  const target = { nodeType: 1, closest: selector => selector === '[data-conversation-content][data-conversation-session]' ? body : null };
  for (const key of ['Control', 'Shift', 'Tab']) assert.equal(plugin.chatGestureSession({ isTrusted: true, type: 'keydown', key, target }, 'chat'), undefined);
  for (const key of ['Tab', 'ArrowDown', 'Enter', 'Escape']) assert.equal(plugin.chatGestureSession({ isTrusted: true, type: 'keydown', key, ctrlKey: true, target }, 'chat'), undefined);
  const modal = { nodeType: 1, closest: () => body };
  assert.equal(plugin.chatGestureSession({ isTrusted: true, type: 'click', target: modal }, 'chat'), undefined);
  const shadow = { hasAttribute: attr => attr === 'data-no-attention-ack' };
  assert.equal(plugin.chatGestureSession({ isTrusted: true, type: 'keydown', key: 'Enter', target, composedPath: () => [target, shadow] }, 'chat'), undefined);
  assert.equal(plugin.chatGestureSession({ isTrusted: true, type: 'keydown', key: 'a', target }, 'chat'), 'chat');
});
test('receiver resets terminal attention only when an established host generation changes', async () => {
  let call = 0, resets = 0;
  const receiver = plugin.createCompletionReceiver({ completed() {}, reset: () => resets++, call: async (_payload, signal) => {
    if (++call <= 3) return { ok: true, value: { generation: call < 3 ? 'old' : 'new', cursor: 0, events: [] } };
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  } });
  receiver.start(); for (let i = 0; i < 12; i++) await Promise.resolve(); receiver.stop(); assert.equal(resets, 1);
});
test('applied bridge records muted terminal events before deferred audio and clears stale preparations', async () => {
  for (const mode of ['new-turn', 'new-host']) {
    let localPlugin, releaseEvents, releaseAudio; const cleanups = [];
    const win = new EventTarget(); win.CustomEvent = CustomEvent;
    win.__ModuleLoader__ = { load(def) { localPlugin = def.factory(() => ({})); } };
    const doc = new EventTarget(); let registrations = 0;
    win.addEventListener('dsh:sound-attention-changed', () => registrations++);
    vm.runInNewContext(readFileSync(new URL('./client.js', import.meta.url), 'utf8'), { window: win, document: doc, setTimeout, clearTimeout, queueMicrotask, Date, console, AbortController, atob });
    let calls = 0;
    localPlugin.apply({
      effect(fn) { cleanups.push(fn()); }, locale: { register() {} }, slots: { inject() {} },
      configForms: { get: () => ({ getSnapshot: () => ({ status: 'ready', value: { ...DEFAULTS, volume: 0, questionSound: 'slow' } }), subscribe: () => () => {} }) },
      uiSession: { sessionStatus: { getSnapshot: () => new Map(), subscribe: () => () => {} }, adapter: { current: { getSnapshot: () => ({ key: 'chat' }) } } },
      connection: { rpc: { call(_api, route, _payload, signal) {
        if (route.endsWith('/audio')) return new Promise(resolve => { releaseAudio = resolve; });
        if (++calls === 1) return Promise.resolve({ ok: true, value: { generation: 'old', cursor: 0, events: [] } });
        return new Promise((resolve, reject) => { releaseEvents = resolve; signal.addEventListener('abort', () => reject(new Error('disposed')), { once: true }); });
      } } },
    });
    const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
    await flush(); const source = win.__DSH_SOUND_ATTENTION__; assert.equal(registrations, 1);
    releaseEvents({ ok: true, value: { generation: 'old', cursor: 1, events: [{ type: 'completed', id: 'stop', outcome: 'attention', sessionId: 'chat' }] } });
    await flush(); assert.equal(source.getSnapshot().get('chat').kind, 'attention'); assert.equal(source.getSnapshot().get('chat').reminderActive, false);
    releaseEvents({ ok: true, value: { generation: mode === 'new-host' ? 'new' : 'old', cursor: 2, events: mode === 'new-turn' ? [{ type: 'clear-attention', sessionId: 'chat' }] : [] } });
    await flush(); assert.equal(source.getSnapshot().size, 0);
    releaseAudio({ ok: true, value: { data: '' } }); await flush(); assert.equal(source.getSnapshot().size, 0, 'settled preparation cannot restore a cleared event');
    for (const cleanup of cleanups.reverse()) cleanup?.(); await flush();
    assert.equal(win.__DSH_SOUND_ATTENTION__, undefined); assert.equal(registrations, 2); assert.equal(source.getSnapshot().size, 0);
  }
});
test('manifest contains all runtime and display assets; original icon valid SVG', () => {
  const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url)));
  for (const file of manifest.files.filter(file => !file.includes('*'))) assert.ok(existsSync(new URL(file, import.meta.url)), file);
  for (const locale of ['en', 'ru', 'zh']) { const dict = JSON.parse(readFileSync(new URL(`./locale/${locale}.json`, import.meta.url))); assert.ok(dict.meta.title && dict.meta.description); }
  assert.match(readFileSync(new URL('./icon.svg', import.meta.url), 'utf8'), /<svg[^>]+xmlns="http:\/\/www.w3.org\/2000\/svg"/);
});
