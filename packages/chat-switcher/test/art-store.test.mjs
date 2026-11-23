import test from 'node:test';
import assert from 'node:assert/strict';
import { createMosaicArtRuntime, getMosaicArtStore, waitForMosaicArt, disposeMosaicArtRuntime, getMosaicArtHealth } from '../src/art-store.js';
import { HYBRID_SEED_DOMAIN } from '../src/image-variant.js';
import { getMosaicBaseDataUrl, getMosaicDataUrl, getMosaicCanvasColor } from '../src/mosaic.js';

const hybrid = id => JSON.stringify([HYBRID_SEED_DOMAIN, `chat-${id}`, 'salt']);
const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>';
const uri = value => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(value);
const readyUri = uri(svg);
const microtasks = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

// Lifecycle oracles for owned timer/Worker/Blob/URL APIs, not a DOM/React renderer.
function environmentOracle(behavior = {}) {
  let now = 0, nextId = 0;
  const timers = new Map(), workers = [], blobs = [], created = [], revoked = [], cleared = [];
  const clock = {
    get now() { return now; },
    timers,
    runNext() {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      assert.ok(next, 'an owned timer must exist');
      const [id, timer] = next; timers.delete(id); now = timer.at; timer.callback(); return timer;
    },
    advance(milliseconds) {
      const end = now + milliseconds;
      while ([...timers.values()].some(timer => timer.at <= end)) clock.runNext();
      now = end;
    },
  };
  const environment = {
    setTimeout(callback, delay) { const id = nextId++; timers.set(id, { callback, delay, at: now + delay }); return id; },
    clearTimeout(id) { cleared.push(id); timers.delete(id); },
    Blob: class {
      constructor(parts, options) { if (behavior.blobThrows) throw new Error('Blob blocked'); this.parts = parts; this.options = options; blobs.push(this); }
    },
    Worker: class {
      constructor(url, options) {
        if (behavior.workerThrows) throw new Error('Worker blocked by CSP');
        this.url = url; this.options = options; this.messages = []; this.terminated = 0;
        this.onmessage = null; this.onerror = null; this.onmessageerror = null; workers.push(this);
      }
      postMessage(message) { if (behavior.postThrows) throw new Error('postMessage failed'); this.messages.push(message); }
      terminate() { this.terminated++; }
      reply(value = readyUri, id = this.messages.at(-1)?.id) { this.onmessage?.({ data: { id, uri: value } }); }
      error() { this.onerror?.({ preventDefault() { behavior.prevented = true; } }); }
    },
    URL: {
      createObjectURL(blob) { if (behavior.urlThrows) throw new Error('Blob URLs blocked'); const url = `blob:owned-${created.length}`; created.push({ url, blob }); return url; },
      revokeObjectURL(url) { revoked.push(url); },
    },
    get document() { throw new Error('art store must not touch DOM'); },
    get localStorage() { throw new Error('art store must not persist preferences'); },
    get OffscreenCanvas() { throw new Error('no canvas rendering in art store'); },
  };
  if (behavior.noWorker) delete environment.Worker;
  return { environment, clock, workers, blobs, created, revoked, cleared, behavior };
}

function fixture({ behavior = {}, dependencies = {}, limits = {} } = {}) {
  const oracle = environmentOracle(behavior);
  const calls = { base: [], legacy: [], color: [], async: [], aborted: 0 };
  const deps = {
    baseUri(seed) { calls.base.push(seed); return uri(`<svg data-base="${calls.base.length}"/>`); },
    legacyUri(seed) { calls.legacy.push(seed); return `EXACT legacy bytes \u0000 ${seed}`; },
    color(seed) { calls.color.push(seed); return '#123456'; },
    async createSvgAsync(seed, { yieldControl, shouldAbort }) {
      calls.async.push(seed);
      for (let i = 0; i < 3; i++) {
        if (shouldAbort()) { calls.aborted++; return null; }
        await yieldControl();
      }
      if (shouldAbort()) { calls.aborted++; return null; }
      return svg;
    },
    workerSource: 'self.onmessage = () => {};',
    workerTimeout: 80, fallbackTimeout: 120, pollInterval: 20,
    ...dependencies, ...limits,
  };
  const runtime = createMosaicArtRuntime(oracle.environment, deps);
  return { ...oracle, runtime, calls, deps,
    async tick() { const timer = oracle.clock.runNext(); await microtasks(); return timer; },
    async until(predicate, maximum = 200) {
      for (let i = 0; i < maximum; i++) {
        await microtasks();
        if (predicate()) return;
        assert.ok(oracle.clock.timers.size, 'pending async work must retain a bounded owned timer');
        oracle.clock.runNext();
      }
      assert.fail('bounded oracle exceeded its step limit');
    },
  };
}

function assertQuiescent(f) {
  assert.equal(f.runtime.getHealth().activeJobs, 0);
  assert.equal(f.runtime.getHealth().queued, 0);
  assert.equal(f.clock.timers.size, 0);
}

test('hybrid stores/snapshots are stable and cheap until subscribed or awaited', () => {
  const f = fixture(), seed = hybrid('lazy');
  const store = f.runtime.getStore(seed), first = store.getSnapshot();
  assert.equal(f.runtime.getStore(seed), store); assert.equal(store.getSnapshot(), first);
  assert.deepEqual(first, { uri: uri('<svg data-base="1"/>'), color: '#123456', status: 'pending' });
  assert.ok(Object.isFrozen(store)); assert.ok(Object.isFrozen(first));
  assert.throws(() => { first.status = 'ready'; }, TypeError);
  assert.equal(f.calls.legacy.length, 0); assert.equal(f.calls.async.length, 0);
  assert.equal(f.workers.length, 0); assert.equal(f.created.length, 0);
  assert.equal(f.runtime.getHealth().pending, 0); assertQuiescent(f); f.runtime.dispose();
});

test('legacy artwork stays byte exact and cached, with no Worker/async/timer even when subscribed/awaited', async () => {
  const f = fixture(), seed = 'legacy exact \u0000 Ω';
  const store = f.runtime.getStore(seed), expected = `EXACT legacy bytes \u0000 ${seed}`;
  assert.equal(store.getSnapshot().uri, expected); assert.equal(store.getSnapshot().status, 'legacy');
  const off = store.subscribe(() => assert.fail('legacy snapshot cannot change'));
  assert.equal(await f.runtime.waitForArt(seed), expected);
  assert.equal(f.runtime.getStore(seed), store); assert.equal(f.calls.legacy.length, 1);
  assert.equal(f.calls.base.length, 0); assert.equal(f.calls.async.length, 0);
  assert.equal(f.workers.length, 0); assertQuiescent(f); off(); f.runtime.dispose();
});

test('same-seed subscribers and raster waiters deduplicate to one Worker request and independently unsubscribe', async () => {
  const f = fixture(), seed = hybrid('dedup'), store = f.runtime.getStore(seed);
  let notifications = 0; const callback = () => notifications++;
  const off1 = store.subscribe(callback), off2 = store.subscribe(callback);
  const wait1 = f.runtime.waitForArt(seed), wait2 = f.runtime.waitForArt(seed);
  assert.equal(f.workers.length, 0); await f.tick();
  assert.equal(f.workers.length, 1); assert.deepEqual(f.workers[0].messages, [{ id: 1, seed }]);
  assert.equal(f.created.length, 1); assert.deepEqual(f.blobs[0].parts, [f.deps.workerSource]);
  assert.deepEqual(f.blobs[0].options, { type: 'text/javascript' });
  f.workers[0].reply();
  assert.equal(await wait1, readyUri); assert.equal(await wait2, readyUri);
  assert.equal(notifications, 2); assert.equal(store.getSnapshot().status, 'ready');
  off1(); off1(); off2(); assertQuiescent(f);
  assert.equal(f.workers[0].terminated, 0);
  f.runtime.dispose(); assert.equal(f.workers[0].terminated, 1); assert.deepEqual(f.revoked, ['blob:owned-0']);
});

test('different seeds use a serial queue and reuse exactly one alive Worker/Blob URL', async () => {
  const f = fixture(), a = f.runtime.getStore(hybrid('a')), b = f.runtime.getStore(hybrid('b'));
  const offA = a.subscribe(() => {}), offB = b.subscribe(() => {});
  await f.tick(); assert.equal(f.workers.length, 1); assert.equal(f.workers[0].messages.length, 1);
  f.workers[0].reply(); await f.tick();
  assert.equal(a.getSnapshot().status, 'ready'); assert.equal(b.getSnapshot().status, 'pending');
  assert.equal(f.workers.length, 1); assert.equal(f.workers[0].messages.length, 2); assert.equal(f.created.length, 1);
  f.workers[0].reply(uri('<svg data-stale="true"/>'), 1);
  assert.equal(b.getSnapshot().status, 'pending');
  f.workers[0].reply(); assert.equal(b.getSnapshot().status, 'ready');
  offA(); offB(); assertQuiescent(f); f.runtime.dispose();
});

test('unsubscribe before initial scheduling cancels timer id zero and never constructs a Worker', () => {
  const f = fixture(), store = f.runtime.getStore(hybrid('not-mounted'));
  const off = store.subscribe(() => assert.fail('cancelled observer notified'));
  const queued = [...f.clock.timers.values()][0].callback;
  off(); off(); queued();
  assert.equal(f.workers.length, 0); assert.equal(store.getSnapshot().status, 'pending');
  assertQuiescent(f); f.runtime.dispose();
});

test('last subscriber cancellation terminates work; stale messages/timers cannot affect a new request', async () => {
  const f = fixture(), a = f.runtime.getStore(hybrid('old')), b = f.runtime.getStore(hybrid('new'));
  const offA = a.subscribe(() => assert.fail('old snapshot painted')); await f.tick();
  const oldWorker = f.workers[0], staleMessage = oldWorker.onmessage;
  const staleTimeout = [...f.clock.timers.values()][0].callback;
  offA(); assert.equal(oldWorker.terminated, 1); assertQuiescent(f);
  const offB = b.subscribe(() => {}); await f.tick();
  assert.equal(f.workers.length, 2); assert.equal(f.created.length, 1);
  assert.equal(f.workers[1].url, oldWorker.url);
  staleMessage({ data: { id: 1, uri: uri('<svg data-old="true"/>') } }); staleTimeout();
  assert.equal(a.getSnapshot().status, 'pending'); assert.equal(b.getSnapshot().status, 'pending');
  assert.equal(f.workers[1].terminated, 0); f.workers[1].reply();
  assert.equal(b.getSnapshot().uri, readyUri); offB(); assertQuiescent(f); f.runtime.dispose();
});

test('removing a queued seed never cancels the active seed or computes the removed artwork', async () => {
  const f = fixture(), a = f.runtime.getStore(hybrid('keep')), b = f.runtime.getStore(hybrid('remove'));
  const offA = a.subscribe(() => {}), offB = b.subscribe(() => {}); await f.tick();
  offB(); assert.equal(f.runtime.getHealth().queued, 0); assert.equal(f.workers[0].terminated, 0);
  f.workers[0].reply(); assert.equal(a.getSnapshot().status, 'ready');
  assert.equal(b.getSnapshot().status, 'pending'); assert.equal(f.workers[0].messages.length, 1);
  offA(); assertQuiescent(f); f.runtime.dispose();
});

test('cooperative fallback enters only after a macrotask, yields bounded chunks and never calls full sync hybrid rendering', async () => {
  const f = fixture({ behavior: { noWorker: true } }), store = f.runtime.getStore(hybrid('cooperative'));
  const initial = store.getSnapshot(), off = store.subscribe(() => {});
  assert.equal(f.calls.async.length, 0); await f.tick();
  assert.equal(f.calls.async.length, 0, 'even async setup waits for an initial zero-delay yield');
  await f.until(() => store.getSnapshot().status === 'ready');
  assert.equal(store.getSnapshot().uri, readyUri); assert.notEqual(store.getSnapshot(), initial);
  assert.equal(f.calls.async.length, 1); assert.equal(f.calls.legacy.length, 0);
  off(); assertQuiescent(f); f.runtime.dispose();
});

test('real cooperative engine integrates through owned yields and produces full hybrid rather than its base placeholder', async () => {
  const oracle = environmentOracle({ noWorker: true }), runtime = createMosaicArtRuntime(oracle.environment);
  const seed = hybrid('real-cooperative'), store = runtime.getStore(seed), base = store.getSnapshot().uri;
  const wait = runtime.waitForArt(seed);
  try {
    for (let i = 0; i < 256 && store.getSnapshot().status === 'pending'; i++) {
      await microtasks();
      if (store.getSnapshot().status !== 'pending') break;
      oracle.clock.runNext();
    }
    await microtasks();
    assert.equal(store.getSnapshot().status, 'ready');
    const result = await wait;
    assert.equal(result, store.getSnapshot().uri); assert.notEqual(result, base);
    assert.match(decodeURIComponent(result.slice(result.indexOf(',') + 1)), /^<svg\b/);
    assert.equal(runtime.getHealth().activeJobs, 0); assert.equal(oracle.clock.timers.size, 0);
  } finally { runtime.dispose(); }
});

for (const failure of ['noWorker', 'urlThrows', 'blobThrows', 'workerThrows', 'postThrows', 'error', 'messageerror', 'reply-error', 'invalid-uri']) {
  test(`Worker ${failure} transitions to the cooperative full-art fallback`, async () => {
    const behavior = { [failure]: true }, f = fixture({ behavior });
    const seed = hybrid(failure), store = f.runtime.getStore(seed), wait = f.runtime.waitForArt(seed);
    await f.tick();
    if (failure === 'error') f.workers[0].error();
    if (failure === 'messageerror') f.workers[0].onmessageerror();
    if (failure === 'reply-error') f.workers[0].onmessage({ data: { id: 1, error: 'worker failed' } });
    if (failure === 'invalid-uri') f.workers[0].reply('https://must-not-fetch.invalid/image.svg');
    await f.until(() => store.getSnapshot().status !== 'pending');
    assert.equal(await wait, readyUri); assert.equal(store.getSnapshot().status, 'ready');
    assert.equal(f.calls.async.length, 1); assert.equal(f.calls.legacy.length, 0);
    for (const worker of f.workers) assert.equal(worker.terminated, 1);
    assertQuiescent(f); f.runtime.dispose();
    assert.equal(f.revoked.length, f.created.length);
  });
}

test('Worker watchdog is bounded and an old completion after timeout cannot replace cooperative artwork', async () => {
  const f = fixture(), store = f.runtime.getStore(hybrid('timeout'));
  const off = store.subscribe(() => {}); await f.tick();
  const staleMessage = f.workers[0].onmessage;
  assert.equal([...f.clock.timers.values()][0].delay, 80); await f.tick();
  assert.equal(f.workers[0].terminated, 1);
  staleMessage({ data: { id: 1, uri: uri('<svg data-late="true"/>') } });
  await f.until(() => store.getSnapshot().status === 'ready');
  assert.equal(store.getSnapshot().uri, readyUri); off(); assertQuiescent(f); f.runtime.dispose();
});

for (const failure of ['throw', 'reject', 'null', 'not-svg', 'never-settles']) {
  test(`cooperative ${failure} fails closed to base artwork and resolves raster waits with null`, async () => {
    const createSvgAsync = () => {
      if (failure === 'throw') throw new Error('setup failed');
      if (failure === 'reject') return Promise.reject(new Error('render failed'));
      if (failure === 'never-settles') return new Promise(() => {});
      return Promise.resolve(failure === 'null' ? null : 'not an SVG');
    };
    const f = fixture({ behavior: { noWorker: true }, dependencies: { createSvgAsync } });
    const seed = hybrid(failure), store = f.runtime.getStore(seed), base = store.getSnapshot().uri;
    const wait = f.runtime.waitForArt(seed);
    await f.until(() => store.getSnapshot().status === 'fallback');
    assert.equal(await wait, null); assert.equal(await f.runtime.waitForArt(seed), null);
    assert.equal(store.getSnapshot().uri, base); assertQuiescent(f); f.runtime.dispose();
  });
}

test('false/throwing needed predicates never create work or read/render a seed', async () => {
  const f = fixture();
  assert.equal(await f.runtime.waitForArt(hybrid('unused'), () => false), null);
  assert.equal(await f.runtime.waitForArt(hybrid('bad-predicate'), () => { throw new Error('gone'); }), null);
  assert.equal(f.calls.base.length, 0); assert.equal(f.workers.length, 0); assertQuiescent(f); f.runtime.dispose();
});

test('cached and just-completed wait results recheck need/disposal at asynchronous delivery', async () => {
  const f = fixture(); let needed = true;
  const legacy = f.runtime.waitForArt('legacy-delivery', () => needed);
  needed = false; assert.equal(await legacy, null);
  needed = true;
  const seed = hybrid('delivery'), wait = f.runtime.waitForArt(seed, () => needed);
  await f.tick(); f.workers[0].reply(); needed = false;
  assert.equal(await wait, null);
  assert.equal(f.runtime.getStore(seed).getSnapshot().status, 'ready');
  needed = true;
  const cached = f.runtime.waitForArt(seed, () => needed); f.runtime.dispose();
  assert.equal(await cached, null); assertQuiescent(f);
});

test('shared needed polling removes a stale queued raster request without disrupting active UI art', async () => {
  const f = fixture(), active = f.runtime.getStore(hybrid('visible'));
  const off = active.subscribe(() => {}); let needed = true;
  const wait = f.runtime.waitForArt(hybrid('queued-stale'), () => needed); await f.tick();
  needed = false; f.clock.advance(20); await microtasks();
  assert.equal(await wait, null); assert.equal(f.runtime.getHealth().queued, 0);
  assert.equal(f.workers[0].terminated, 0); assert.equal(f.workers[0].messages.length, 1);
  f.workers[0].reply(); off(); assertQuiescent(f); f.runtime.dispose();
});

test('last raster waiter becoming unnecessary cancels an active Worker and rejects all late returns', async () => {
  const f = fixture(), seed = hybrid('waiter-gone'), store = f.runtime.getStore(seed); let needed = true;
  const wait = f.runtime.waitForArt(seed, () => needed); await f.tick();
  const stale = f.workers[0].onmessage; needed = false; f.clock.advance(20); await microtasks();
  assert.equal(await wait, null); assert.equal(f.workers[0].terminated, 1);
  stale({ data: { id: 1, uri: readyUri } }); assert.equal(store.getSnapshot().status, 'pending');
  assertQuiescent(f); f.runtime.dispose();
});

test('cooperative work aborts on last waiter loss at a yield and releases every owned timer', async () => {
  const f = fixture({ behavior: { noWorker: true } }), seed = hybrid('yield-abort'); let needed = true;
  const store = f.runtime.getStore(seed), wait = f.runtime.waitForArt(seed, () => needed);
  await f.tick(); await f.tick(); assert.equal(f.calls.async.length, 1);
  needed = false; await f.tick(); await microtasks();
  assert.equal(await wait, null); assert.equal(store.getSnapshot().status, 'pending');
  assert.equal(f.calls.aborted, 1); assertQuiescent(f); f.runtime.dispose();
});

test('a stale waiter does not cancel a still-subscribed UI consumer of the same seed', async () => {
  const f = fixture(), seed = hybrid('shared-visible'), store = f.runtime.getStore(seed); let needed = true;
  const off = store.subscribe(() => {}), wait = f.runtime.waitForArt(seed, () => needed);
  await f.tick(); needed = false; f.clock.advance(20); await microtasks();
  assert.equal(await wait, null); assert.equal(f.workers[0].terminated, 0);
  f.workers[0].reply(); assert.equal(store.getSnapshot().status, 'ready'); off(); assertQuiescent(f); f.runtime.dispose();
});

test('a needed raster waiter keeps shared work alive after the last React subscriber leaves', async () => {
  const f = fixture(), seed = hybrid('raster-retained'), store = f.runtime.getStore(seed);
  const off = store.subscribe(() => {}), wait = f.runtime.waitForArt(seed);
  await f.tick(); off(); assert.equal(f.workers[0].terminated, 0);
  f.workers[0].reply(); assert.equal(await wait, readyUri); assertQuiescent(f); f.runtime.dispose();
});

for (const phase of ['worker', 'cooperative']) {
  test(`dispose cancels active ${phase}, queued consumers, late callbacks and retained promises`, async () => {
    let finishSvg;
    const f = fixture({ behavior: { noWorker: phase === 'cooperative' },
      dependencies: { createSvgAsync: () => new Promise(resolve => { finishSvg = resolve; }) } });
    const a = hybrid(`dispose-${phase}`), b = hybrid(`queued-${phase}`), store = f.runtime.getStore(a);
    let notices = 0; const off = store.subscribe(() => notices++);
    const waitA = f.runtime.waitForArt(a), waitB = f.runtime.waitForArt(b);
    await f.tick(); if (phase === 'cooperative') await f.tick();
    const staleTimers = [...f.clock.timers.values()].map(value => value.callback);
    const staleMessage = f.workers[0]?.onmessage;
    f.runtime.dispose(); f.runtime.dispose();
    assert.equal(await waitA, null); assert.equal(await waitB, null); assertQuiescent(f);
    for (const callback of staleTimers) callback();
    staleMessage?.({ data: { id: 1, uri: readyUri } }); finishSvg?.(svg); await microtasks(); off();
    assert.equal(notices, 0); assert.equal(store.getSnapshot().status, 'pending');
    assert.equal(await f.runtime.waitForArt(a), null); assertQuiescent(f);
    for (const worker of f.workers) assert.equal(worker.terminated, 1);
    assert.equal(f.revoked.length, f.created.length);
    store.subscribe(() => assert.fail('disposed store resumed')); assertQuiescent(f);
  });
}

test('bounded idle LRU preserves active/pending stores and recomputes only evicted entries', async () => {
  const f = fixture({ limits: { cacheLimit: 3 } });
  const protectedSeed = hybrid('protected'), protectedStore = f.runtime.getStore(protectedSeed);
  const off = protectedStore.subscribe(() => {}); await f.tick();
  const evicted = f.runtime.getStore('legacy-0');
  for (let i = 1; i <= 10; i++) f.runtime.getStore(`legacy-${i}`);
  assert.equal(f.runtime.getHealth().cached, 4);
  assert.equal(f.runtime.getStore(protectedSeed), protectedStore);
  assert.notEqual(f.runtime.getStore('legacy-0'), evicted);
  assert.equal(f.workers[0].messages.length, 1);
  f.workers[0].reply(); off(); assert.ok(f.runtime.getHealth().cached <= 3);
  assertQuiescent(f); f.runtime.dispose();
});

test('an old evicted store handle rejoins a current same-seed entry without duplicate jobs or stale snapshots', async () => {
  const f = fixture({ limits: { cacheLimit: 1 } }), seed = hybrid('orphan');
  const old = f.runtime.getStore(seed); f.runtime.getStore('evict-old');
  const current = f.runtime.getStore(seed); assert.notEqual(current, old);
  let notices = 0;
  const offOld = old.subscribe(() => notices++), offCurrent = current.subscribe(() => notices++);
  assert.equal(old.getSnapshot(), current.getSnapshot()); await f.tick();
  assert.equal(f.workers[0].messages.length, 1); f.workers[0].reply();
  assert.equal(notices, 2); assert.equal(old.getSnapshot(), current.getSnapshot());
  offOld(); offCurrent(); assertQuiescent(f); f.runtime.dispose();
});

test('64 queued/active jobs stay bounded while deferred mounted seeds eventually receive full artwork', async () => {
  const f = fixture(), stores = [], cleanups = [];
  for (let i = 0; i < 70; i++) {
    const store = f.runtime.getStore(hybrid(`cap-${i}`)); stores.push(store); cleanups.push(store.subscribe(() => {}));
  }
  const deferredBase = stores[69].getSnapshot().uri;
  assert.equal(f.runtime.getHealth().queued, 64); assert.equal(f.runtime.getHealth().pending, 70);
  assert.ok(stores.every(store => store.getSnapshot().status === 'pending'));
  const wait = f.runtime.waitForArt(hybrid('cap-69'));
  await f.tick(); assert.equal(f.runtime.getHealth().queued, 63); assert.equal(f.runtime.getHealth().activeJobs, 1);
  assert.equal(f.workers.length, 1); assert.equal(f.workers[0].messages.length, 1);
  assert.equal([...f.clock.timers.values()].filter(timer => timer.delay === 0).length, 0, 'a full active queue must not busy-pump');
  f.workers[0].reply();
  assert.equal(f.runtime.getHealth().queued, 64, 'first completion immediately admits the oldest deferred seed');
  assert.equal(stores[69].getSnapshot().status, 'pending'); assert.equal(stores[69].getSnapshot().uri, deferredBase);
  for (let i = 1; i < 70; i++) {
    await f.tick();
    assert.ok(f.runtime.getHealth().queued + f.runtime.getHealth().activeJobs <= 64);
    f.workers[0].reply();
  }
  assert.equal(await wait, readyUri); assert.equal(stores[69].getSnapshot().status, 'ready');
  assert.ok(stores.every(store => store.getSnapshot().uri === readyUri));
  assert.deepEqual(f.workers[0].messages.map(message => message.seed), Array.from({ length: 70 }, (_, i) => hybrid(`cap-${i}`)));
  for (const off of cleanups) off();
  assertQuiescent(f); assert.ok(f.runtime.getHealth().cached <= 32); f.runtime.dispose();
});

test('releasing a queued mount admits deferred ownership without cancelling the active Worker', async () => {
  const f = fixture(), cleanups = [];
  for (let i = 0; i < 65; i++) cleanups.push(f.runtime.getStore(hybrid(`release-cap-${i}`)).subscribe(() => {}));
  await f.tick(); assert.equal(f.runtime.getHealth().queued, 63);
  cleanups[1]();
  assert.equal(f.runtime.getHealth().queued, 63, 'the newly freed slot is filled by the deferred mount');
  assert.equal(f.runtime.getHealth().pending, 64); assert.equal(f.workers[0].terminated, 0);
  for (let i = 2; i < 65; i++) { f.workers[0].reply(); await f.tick(); }
  f.workers[0].reply();
  assert.equal(f.workers[0].messages.at(-1).seed, hybrid('release-cap-64'));
  assert.ok(!f.workers[0].messages.some(message => message.seed === hybrid('release-cap-1')));
  for (const off of cleanups) off(); assertQuiescent(f); f.runtime.dispose();
});

test('cooperative failures refill capacity so deferred seeds are actually attempted rather than permanently starved', async () => {
  let attempted = 0;
  const f = fixture({ behavior: { noWorker: true }, dependencies: { createSvgAsync() { attempted++; throw new Error('render failed'); } } });
  const cleanups = [];
  for (let i = 0; i < 65; i++) cleanups.push(f.runtime.getStore(hybrid(`failure-cap-${i}`)).subscribe(() => {}));
  const last = f.runtime.getStore(hybrid('failure-cap-64')), wait = f.runtime.waitForArt(hybrid('failure-cap-64'));
  assert.equal(last.getSnapshot().status, 'pending');
  await f.until(() => last.getSnapshot().status === 'fallback', 300);
  assert.equal(attempted, 65); assert.equal(await wait, null);
  for (const off of cleanups) off(); assertQuiescent(f); f.runtime.dispose();
});

test('deferred last-owner cancellation and plugin disposal settle waiters without ever admitting invisible seeds', async () => {
  const f = fixture(), cleanups = [];
  for (let i = 0; i < 64; i++) cleanups.push(f.runtime.getStore(hybrid(`owned-cap-${i}`)).subscribe(() => {}));
  let needed = true;
  const cancelled = f.runtime.waitForArt(hybrid('deferred-cancel'), () => needed);
  const disposed = f.runtime.waitForArt(hybrid('deferred-dispose'));
  const deferred = f.runtime.getStore(hybrid('deferred-cancel'));
  await f.tick(); needed = false; f.clock.advance(20); await microtasks();
  assert.equal(await cancelled, null); assert.equal(deferred.getSnapshot().status, 'pending');
  assert.equal(f.runtime.getHealth().queued, 63); assert.equal(f.workers[0].messages.length, 1);
  assert.equal([...f.clock.timers.values()].filter(timer => timer.delay === 0).length, 0);
  f.runtime.dispose(); assert.equal(await disposed, null);
  for (const off of cleanups) off(); assertQuiescent(f);
});

test('throwing observers cannot strand a subsequent queued job and health never exposes seeds/URIs', async () => {
  const f = fixture(), a = f.runtime.getStore(hybrid('throws')), b = f.runtime.getStore(hybrid('next'));
  const offA = a.subscribe(() => { throw new Error('observer failed'); }), offB = b.subscribe(() => {});
  await f.tick(); f.workers[0].reply(); await f.tick(); f.workers[0].reply();
  assert.equal(b.getSnapshot().status, 'ready');
  for (const value of Object.values(f.runtime.getHealth())) assert.ok(typeof value === 'number' || typeof value === 'boolean');
  assert.doesNotMatch(JSON.stringify(f.runtime.getHealth()), /chat-|data:image|salt/);
  offA(); offB(); assertQuiescent(f); f.runtime.dispose();
});

test('production shared API preserves real legacy bytes, starts lazily, scopes environments and disposes all runtimes', async () => {
  disposeMosaicArtRuntime();
  const one = environmentOracle(), two = environmentOracle(), seed = hybrid('public');
  const legacy = getMosaicArtStore('legacy public exact Ω', one.environment);
  assert.equal(legacy.getSnapshot().uri, getMosaicDataUrl('legacy public exact Ω'));
  assert.equal(await waitForMosaicArt('legacy public exact Ω', one.environment), legacy.getSnapshot().uri);
  const a = getMosaicArtStore(seed, one.environment), b = getMosaicArtStore(seed, two.environment);
  assert.equal(a, getMosaicArtStore(seed, one.environment)); assert.notEqual(a, b);
  assert.equal(a.getSnapshot().uri, getMosaicBaseDataUrl(seed)); assert.equal(a.getSnapshot().color, getMosaicCanvasColor(seed));
  assert.equal(one.workers.length, 0); assert.equal(two.workers.length, 0);
  const offA = a.subscribe(() => {}), offB = b.subscribe(() => {}), wait = waitForMosaicArt(seed, one.environment);
  one.clock.runNext(); two.clock.runNext();
  assert.equal(one.workers.length, 1); assert.equal(two.workers.length, 1);
  one.workers[0].reply(); assert.equal(await wait, readyUri);
  assert.equal(getMosaicArtHealth().activeJobs, 1);
  disposeMosaicArtRuntime(); offA(); offB();
  assert.equal(one.clock.timers.size, 0); assert.equal(two.clock.timers.size, 0);
  assert.equal(one.workers[0].terminated, 1); assert.equal(two.workers[0].terminated, 1);
  assert.equal(one.revoked.length, 1); assert.equal(two.revoked.length, 1);
  assert.deepEqual(getMosaicArtHealth(), { ready: 0, pending: 0, fallback: 0, cached: 0, queued: 0, activeJobs: 0, workerActive: 0, workerAlive: 0 });
  assert.notEqual(getMosaicArtStore(seed, one.environment), a, 'a later plugin activation receives a fresh inert runtime');
  disposeMosaicArtRuntime();
});
