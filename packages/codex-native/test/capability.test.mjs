import test from 'node:test';
import assert from 'node:assert/strict';
import { createCapabilityCache } from '../src/capability.js';
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const catalog = fast => new Map([['model', { fast }]]);
const unavailable = error => error?.code === 'CODEX_FAST_CHECK_UNAVAILABLE' && error.message === 'Fast capability could not be checked.';
function fixture(loader, extra = {}) {
  let time = 1000;
  const calls = [];
  const cache = createCapabilityCache({ load(scope, options) { calls.push({ scope, signal: options.signal }); return loader(scope, options); }, now: () => time, ttlMs: 100, retryMs: 30, ...extra });
  return { cache, calls, advance(ms) { time += ms; } };
}

test('unknown sync state and singleflight await with exact TTL boundary', async () => {
  const pending = deferred();
  const f = fixture(() => pending.promise);
  assert.deepEqual(f.cache.get('scope', 'model'), { available: null, stale: true, checkedAt: null, refreshing: false });
  const a = f.cache.ensure('scope', { model: 'model' });
  const b = f.cache.ensure('scope', { model: 'model' });
  assert.equal(f.cache.get('scope', 'model').refreshing, true);
  await flush(); assert.equal(f.calls.length, 1);
  pending.resolve(catalog(true)); await Promise.all([a, b]);
  assert.deepEqual(f.cache.get('scope', 'model'), { available: true, stale: false, checkedAt: 1000, refreshing: false });
  f.advance(99); await f.cache.ensure('scope', { model: 'model' });
  assert.equal(f.calls.length, 1);
  f.advance(1); assert.equal(f.cache.get('scope', 'model').stale, true);
  f.cache.dispose();
});

test('stale positive continues immediately and revalidates in background to explicit false', async () => {
  const pending = deferred(); let call = 0;
  const f = fixture(() => ++call === 1 ? catalog(true) : pending.promise);
  await f.cache.ensure('scope', { model: 'model' }); f.advance(100);
  await f.cache.ensure('scope', { model: 'model' });
  assert.deepEqual(f.cache.get('scope', 'model'), { available: true, stale: true, checkedAt: 1000, refreshing: true });
  await f.cache.ensure('scope', { model: 'model' });
  assert.equal(f.calls.length, 2);
  pending.resolve(catalog(false)); await flush();
  assert.deepEqual(f.cache.get('scope', 'model'), { available: false, stale: false, checkedAt: 1100, refreshing: false });
  f.cache.dispose();
});

test('stale selected negative waits despite another model positive', async () => {
  const pending = deferred(); let count = 0;
  const f = fixture(() => ++count === 1 ? new Map([['model', { fast: false }], ['other', { fast: true }]]) : pending.promise);
  await f.cache.ensure('scope', { model: 'model' }); f.advance(100);
  let settled = false;
  const checking = f.cache.ensure('scope', { model: 'model' }).then(() => { settled = true; });
  await flush(); assert.equal(settled, false);
  assert.equal(f.cache.get('scope', 'model').available, false);
  pending.resolve(catalog(true)); await checking;
  assert.equal(f.cache.get('scope', 'model').available, true);
  f.cache.dispose();
});

test('fresh explicit false stays false with no downgrade action or unnecessary load', async () => {
  const f = fixture(() => catalog(false));
  await f.cache.ensure('scope', { model: 'model' });
  await f.cache.ensure('scope', { model: 'model' });
  assert.equal(f.calls.length, 1);
  assert.equal(f.cache.get('scope', 'model').available, false);
  f.cache.dispose();
});

test('failed stale positive stays available but stale and retry backoff prevents storms', async () => {
  let count = 0;
  const f = fixture(() => { if (++count === 1) return catalog(true); throw new Error('untrusted provider detail'); });
  await f.cache.ensure('scope', { model: 'model' }); f.advance(100);
  await f.cache.ensure('scope', { model: 'model' }); await flush();
  assert.deepEqual(f.cache.get('scope', 'model'), { available: true, stale: true, checkedAt: 1000, refreshing: false, error: 'CODEX_FAST_CHECK_UNAVAILABLE' });
  for (let i = 0; i < 8; i++) await f.cache.ensure('scope', { model: 'model' });
  assert.equal(f.calls.length, 2);
  f.advance(29); await f.cache.ensure('scope', { model: 'model' }); assert.equal(f.calls.length, 2);
  f.advance(1); await f.cache.ensure('scope', { model: 'model' }); await flush(); assert.equal(f.calls.length, 3);
  f.cache.dispose();
});

test('unknown failures and stale negative failures reject safe typed error with backoff', async () => {
  const f = fixture(() => Promise.reject({ message: 'untrusted', code: 'untrusted' }));
  await assert.rejects(f.cache.ensure('scope', { model: 'model' }), unavailable);
  await assert.rejects(f.cache.ensure('scope', { model: 'model' }), unavailable);
  assert.equal(f.calls.length, 1);
  assert.equal(f.cache.get('scope', 'model').available, null);
  f.advance(30); await assert.rejects(f.cache.ensure('scope', { model: 'model' }), unavailable);
  assert.equal(f.calls.length, 2); f.cache.dispose();
  let count = 0;
  const g = fixture(() => { if (++count === 1) return catalog(false); throw new Error('untrusted'); });
  await g.cache.ensure('scope', { model: 'model' }); g.advance(100);
  await assert.rejects(g.cache.ensure('scope', { model: 'model' }), unavailable);
  assert.equal(g.cache.get('scope', 'model').available, false);
  assert.equal(g.cache.get('scope', 'model').stale, true); g.cache.dispose();
});

test('force awaits even stale positive and joins existing scope flight', async () => {
  let count = 0; const pending = deferred();
  const f = fixture(() => ++count === 1 ? catalog(true) : pending.promise);
  await f.cache.ensure('scope', { model: 'model' }); f.advance(100);
  await f.cache.ensure('scope', { model: 'model' });
  let finished = false;
  const force = f.cache.ensure('scope', { model: 'model', force: true }).then(() => { finished = true; });
  await flush(); assert.equal(finished, false); assert.equal(f.calls.length, 2);
  pending.resolve(catalog(false)); await force;
  assert.equal(f.cache.get('scope', 'model').available, false); f.cache.dispose();
});

test('missing model is unknown, awaits loader, and failure backoff is model-specific', async () => {
  const f = fixture(() => new Map([['other', { fast: true }]]));
  await assert.rejects(f.cache.ensure('scope', { model: 'model' }), unavailable);
  assert.equal(f.cache.get('scope', 'model').available, null);
  assert.equal(f.cache.get('scope', 'model').stale, true);
  await f.cache.ensure('scope', { model: 'other' });
  await assert.rejects(f.cache.ensure('scope', { model: 'model' }), unavailable);
  assert.equal(f.calls.length, 1);
  f.advance(30); await assert.rejects(f.cache.ensure('scope', { model: 'model' }), unavailable);
  assert.equal(f.calls.length, 2); f.cache.dispose();
});

test('scope account generation isolation has no global busy gate', async () => {
  const old = deferred();
  const f = fixture(scope => scope === 'account-a-generation-1' ? old.promise : catalog(false));
  const a = f.cache.ensure('account-a-generation-1', { model: 'model' });
  await f.cache.ensure('account-b-generation-2', { model: 'model' });
  assert.equal(f.cache.get('account-b-generation-2', 'model').available, false);
  assert.equal(f.cache.get('account-a-generation-1', 'model').available, null);
  old.resolve(catalog(true)); await a;
  assert.equal(f.cache.get('account-a-generation-1', 'model').available, true);
  assert.equal(f.cache.get('account-b-generation-2', 'model').available, false);
  f.cache.dispose();
});

test('invalidation aborts old loader, rejects waiter, discards late response even same scope', async () => {
  const old = deferred(); let calls = 0;
  const f = fixture(() => ++calls === 1 ? old.promise : catalog(false));
  const first = f.cache.ensure('scope', { model: 'model' }); await flush();
  f.cache.invalidate();
  assert.equal(f.calls[0].signal.aborted, true);
  await assert.rejects(first, unavailable);
  await f.cache.ensure('scope', { model: 'model' });
  old.resolve(catalog(true)); await flush();
  assert.equal(f.cache.get('scope', 'model').available, false);
  assert.equal(f.cache.get('scope', 'model').checkedAt, 1000); f.cache.dispose();
});

test('caller abort cancels only its waiter, not shared load or another caller', async () => {
  const pending = deferred(); const controller = new AbortController();
  const f = fixture(() => pending.promise);
  const a = f.cache.ensure('scope', { model: 'model', signal: controller.signal });
  const b = f.cache.ensure('scope', { model: 'model' });
  await flush(); controller.abort(); await assert.rejects(a, unavailable);
  assert.equal(f.calls[0].signal.aborted, false);
  pending.resolve(catalog(true)); await b;
  assert.equal(f.cache.get('scope', 'model').available, true); f.cache.dispose();
});

test('disposal aborts loads, clears snapshots, refuses ensure and contains late rejection', async () => {
  const pending = deferred();
  const f = fixture(() => pending.promise);
  const waiting = f.cache.ensure('scope', { model: 'model' }); await flush();
  f.cache.dispose(); f.cache.dispose();
  await assert.rejects(waiting, unavailable);
  assert.equal(f.calls[0].signal.aborted, true);
  assert.equal(f.cache.get('scope', 'model').available, null);
  await assert.rejects(f.cache.ensure('scope', { model: 'model' }), unavailable);
  pending.reject(new Error('late untrusted failure')); await flush();
});

test('strict catalog validation avoids coercion, copies values and never exposes raw fields', async () => {
  for (const bad of [undefined, {}, [], new Map([['model', { fast: 'true' }]]), new Map([['model', { fast: null }]]), new Map([['', { fast: true }]])]) {
    const f = fixture(() => bad);
    await assert.rejects(f.cache.ensure('scope', { model: 'model' }), unavailable);
    assert.equal(f.cache.get('scope', 'model').available, null); f.cache.dispose();
  }
  const value = { fast: true, token: 'untrusted-detail' }, source = new Map([['model', value]]);
  const f = fixture(() => source);
  await f.cache.ensure('scope', { model: 'model' });
  value.fast = false; source.clear();
  assert.equal(f.cache.get('scope', 'model').available, true);
  assert.equal(JSON.stringify(f.cache.get('scope', 'model')).includes('untrusted-detail'), false);
  f.cache.dispose();
});

test('TTL shorter than retry interval still revalidates known successful entries', async () => {
  for (const fast of [true, false]) {
    const f = fixture(() => catalog(fast), { ttlMs: 10, retryMs: 100 });
    await f.cache.ensure('scope', { model: 'model' });
    f.advance(10); await f.cache.ensure('scope', { model: 'model' }); await flush();
    assert.equal(f.calls.length, 2);
    assert.equal(f.cache.get('scope', 'model').stale, false); f.cache.dispose();
  }
});

test('preaborted and malformed caller signals fail safely before creating a load', async () => {
  const controller = new AbortController(); controller.abort();
  const f = fixture(() => catalog(true));
  for (const signal of [controller.signal, {}]) {
    await assert.rejects(f.cache.ensure('scope', { model: 'model', signal }), unavailable);
  }
  assert.equal(f.calls.length, 0); f.cache.dispose();
});

test('Retry-After cooldown is bounded and force cannot bypass provider throttle', async () => {
  for (const [hint, delay] of [[300000, 300000], [1, 30], [86400001, 86400000], [NaN, 30], [Infinity, 30], [-1, 30], ['300000', 30]]) {
    const f = fixture(() => Promise.reject({ retryAfterMs: hint, message: 'untrusted throttle body' }));
    await assert.rejects(f.cache.ensure('scope', { model: 'model' }), unavailable);
    f.advance(delay - 1);
    await assert.rejects(f.cache.ensure('scope', { model: 'model', force: true }), unavailable);
    assert.equal(f.calls.length, 1);
    f.advance(1);
    await assert.rejects(f.cache.ensure('scope', { model: 'model', force: true }), unavailable);
    assert.equal(f.calls.length, 2);
    assert.equal(JSON.stringify(f.cache.get('scope', 'model')).includes('untrusted'), false);
    f.cache.dispose();
  }
});

test('throttled stale positive continues automatically while force respects cooldown', async () => {
  let count = 0;
  const f = fixture(() => { if (++count === 1) return catalog(true); throw { retryAfterMs: 300000 }; });
  await f.cache.ensure('scope', { model: 'model' }); f.advance(100);
  await f.cache.ensure('scope', { model: 'model' }); await flush();
  for (let i = 0; i < 5; i++) await f.cache.ensure('scope', { model: 'model' });
  await assert.rejects(f.cache.ensure('scope', { model: 'model', force: true }), unavailable);
  assert.equal(f.calls.length, 2);
  assert.equal(f.cache.get('scope', 'model').available, true);
  assert.equal(f.cache.get('scope', 'model').stale, true);
  f.advance(300000); await f.cache.ensure('scope', { model: 'model' }); await flush();
  assert.equal(f.calls.length, 3); f.cache.dispose();
});

test('force bypasses successful TTL but never failure cooldown', async () => {
  const f = fixture(() => catalog(true));
  await f.cache.ensure('scope', { model: 'model' });
  await f.cache.ensure('scope', { model: 'model', force: true });
  assert.equal(f.calls.length, 2); f.cache.dispose();
});

test('scope-wide background ensure supports optional model and handles refresh rejection', async () => {
  let calls = 0;
  const f = fixture(() => { if (++calls === 1) return catalog(true); throw new Error('untrusted'); });
  await f.cache.ensure('scope'); f.advance(100);
  await f.cache.ensure('scope'); await flush();
  assert.equal(f.cache.get('scope', 'model').available, true);
  assert.equal(f.cache.get('scope', 'model').stale, true);
  await assert.rejects(f.cache.ensure('scope', { force: true }), unavailable);
  assert.equal(f.calls.length, 2);
  f.advance(30); await assert.rejects(f.cache.ensure('scope', { force: true }), unavailable);
  assert.equal(f.calls.length, 3); f.cache.dispose();
});
