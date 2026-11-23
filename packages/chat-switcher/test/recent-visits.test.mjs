import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecentVisits, RECENT_VISITS_KEY, RECENT_VISIT_TTL } from '../src/recent-visits.js';

function memoryStorage(initial) {
  const data = new Map(initial === undefined ? [] : [[RECENT_VISITS_KEY, initial]]);
  const reads = [], writes = [];
  return { data, reads, writes,
    getItem(key) { reads.push(key); return data.get(key) ?? null; },
    setItem(key, value) { writes.push([key, value]); data.set(key, value); },
  };
}
function fixture(initial, at = RECENT_VISIT_TTL) {
  let now = at, samples = 0;
  const storage = memoryStorage(initial);
  const visits = createRecentVisits({ storage, now: () => { samples++; return now; } });
  return { visits, storage, setTime: next => now = next, get samples() { return samples; } };
}
const sorted = ids => [...ids].sort();

test('explicit visit persists under its own v1 key and survives a new instance', () => {
  const f = fixture(); assert.equal(f.visits.record('chat-a'), true);
  assert.deepEqual(JSON.parse(f.storage.data.get(RECENT_VISITS_KEY)), [['chat-a', RECENT_VISIT_TTL]]);
  const reloaded = createRecentVisits({ storage: f.storage, now: () => RECENT_VISIT_TTL + 1 });
  assert.deepEqual([...reloaded.getRecentIds()], ['chat-a']);
  assert.equal(reloaded.nextExpiry(), RECENT_VISIT_TTL * 2);
  assert.equal(reloaded.size, 1);
});
test('timestamp zero is valid: 59:59.999 is recent, exactly 60 minutes is not', () => {
  let now = 0;
  const visits = createRecentVisits({ now: () => now });
  assert.equal(visits.record('zero'), true);
  now = RECENT_VISIT_TTL - 1; assert.deepEqual([...visits.getRecentIds()], ['zero']);
  assert.equal(visits.nextExpiry(), RECENT_VISIT_TTL);
  now = RECENT_VISIT_TTL; assert.deepEqual([...visits.getRecentIds()], []);
  assert.equal(visits.nextExpiry(), null); assert.equal(visits.size, 0);
});
test('load applies the exact expiry boundary without refreshing old timestamps', () => {
  const f = fixture(JSON.stringify([['expired', 0], ['recent', 1]]), RECENT_VISIT_TTL);
  assert.deepEqual([...f.visits.getRecentIds()], ['recent']);
  assert.equal(f.visits.nextExpiry(), RECENT_VISIT_TTL + 1);
  assert.equal(f.storage.writes.length, 0, 'loading/getters must not stamp or rewrite stored visits');
});
test('recording arrival or departure refreshes only that explicit visit and postpones its expiry', () => {
  const f = fixture(); f.visits.record('a');
  f.setTime(RECENT_VISIT_TTL + 100); f.visits.record('b');
  f.setTime(RECENT_VISIT_TTL + 200); f.visits.record('a');
  assert.deepEqual(JSON.parse(f.storage.data.get(RECENT_VISITS_KEY)), [['a', RECENT_VISIT_TTL + 200], ['b', RECENT_VISIT_TTL + 100]]);
  assert.equal(f.visits.nextExpiry(['a']), RECENT_VISIT_TTL * 2 + 200);
  assert.equal(f.visits.nextExpiry(['b']), RECENT_VISIT_TTL * 2 + 100);
});
test('the legacy MRU id list is never read or migrated into fabricated current ages', () => {
  const storage = memoryStorage(); storage.data.set('@local/chat-switcher/mru/v1', JSON.stringify(['legacy-a', 'legacy-b']));
  const visits = createRecentVisits({ storage, now: () => 100 });
  assert.deepEqual([...visits.getRecentIds()], []);
  assert.deepEqual(storage.reads, [RECENT_VISITS_KEY]);
  assert.equal(visits.record('real-visit'), true);
  assert.deepEqual(JSON.parse(storage.data.get('@local/chat-switcher/mru/v1')), ['legacy-a', 'legacy-b']);
  assert.deepEqual([...visits.getRecentIds()], ['real-visit']);
});
test('missing, corrupt or wrong-shaped storage safely starts with memory only', () => {
  for (const raw of [undefined, '', 'not-json', '{', 'null', '{}', '{"visits":[["a",10]]}', '["old-id-only"]', '[NaN]', 42, { toString() { assert.fail('must not coerce storage data'); } }]) {
    const storage = memoryStorage(raw), visits = createRecentVisits({ storage, now: () => 100 });
    assert.deepEqual([...visits.getRecentIds()], []); assert.equal(visits.record('new'), true);
    assert.deepEqual([...visits.getRecentIds()], ['new']);
  }
});
test('invalid tuple ids and timestamps are ignored without numeric or string coercion', () => {
  const tuples = [
    ['valid', 0], ['', 1], [1, 1], [null, 1], [{ id: 'object' }, 1], ['string-time', '1'], ['null-time', null],
    ['negative', -1], ['fraction', 1.5], ['missing'], ['extra', 1, 2], ['unsafe', Number.MAX_SAFE_INTEGER + 1], ['nan', NaN], ['infinity', Infinity],
  ];
  const f = fixture(JSON.stringify(tuples), 100);
  assert.deepEqual([...f.visits.getRecentIds()], ['valid']);
});
test('only real nonempty string ids may be explicitly recorded', () => {
  const f = fixture();
  const invalid = [null, undefined, 0, 1, NaN, false, '', {}, [], { toString() { assert.fail('must not coerce ids'); } }];
  for (const id of invalid) assert.equal(f.visits.record(id), false);
  assert.equal(f.visits.size, 0); assert.equal(f.storage.writes.length, 0);
  assert.equal(f.visits.record('0'), true); assert.equal(f.visits.record(' whitespace '), true);
  assert.deepEqual(sorted(f.visits.getRecentIds()), [' whitespace ', '0']);
});
test('duplicate persisted ids retain the newest valid timestamp', () => {
  const f = fixture(JSON.stringify([['a', 10], ['b', 30], ['a', 40], ['a', 20], ['b', 30]]), 100);
  assert.deepEqual([...f.visits.getRecentIds()], ['a', 'b']);
  assert.equal(f.visits.nextExpiry(['a']), RECENT_VISIT_TTL + 40);
  assert.equal(f.visits.nextExpiry(['b']), RECENT_VISIT_TTL + 30);
});
test('prototype-like ids and hostile strings are safe Map keys and round-trip as strings', () => {
  const names = ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'a\"}];alert(1)//'];
  const f = fixture(JSON.stringify(names.map(id => [id, 10])), 100);
  assert.deepEqual(sorted(f.visits.getRecentIds()), [...names].sort());
  for (const id of names) assert.equal(f.visits.record(id), true);
  const loaded = createRecentVisits({ storage: f.storage, now: () => 101 });
  assert.deepEqual(sorted(loaded.getRecentIds()), [...names].sort());
  assert.equal({}.polluted, undefined);
});
test('future stored timestamps are ignored, not clamped to now', () => {
  const f = fixture(JSON.stringify([['past', 99], ['future', 101]]), 100);
  assert.deepEqual([...f.visits.getRecentIds()], ['past']);
  f.setTime(101); assert.deepEqual([...f.visits.getRecentIds()], ['past'], 'discarded future record does not reappear when the clock catches up');
  assert.equal(f.visits.nextExpiry(['future']), null);
});
test('clock rollback drops now-future in-memory entries without fabricating their ages', () => {
  const f = fixture(undefined, 1000); f.visits.record('at-1000');
  f.setTime(999); assert.deepEqual([...f.visits.getRecentIds()], []); assert.equal(f.visits.size, 0);
  f.setTime(1000); assert.deepEqual([...f.visits.getRecentIds()], []);
  f.setTime(500); assert.equal(f.visits.record('new-explicit'), true);
  assert.deepEqual(JSON.parse(f.storage.data.get(RECENT_VISITS_KEY)), [['new-explicit', 500]]);
});
test('invalid, fractional or throwing clock does not invent a visit or expiry', () => {
  for (const now of [() => null, () => NaN, () => Infinity, () => -1, () => 1.5, () => '100', () => { throw Error('clock unavailable'); }]) {
    const storage = memoryStorage(), visits = createRecentVisits({ storage, now });
    assert.equal(visits.record('a'), false); assert.deepEqual([...visits.getRecentIds()], []);
    assert.equal(visits.nextExpiry(), null); assert.equal(storage.writes.length, 0);
  }
});
test('temporary unavailable clock is fail-closed without destroying otherwise valid cached visits', () => {
  const f = fixture(undefined, 1000); f.visits.record('a');
  f.setTime(NaN); assert.deepEqual([...f.visits.getRecentIds()], []); assert.equal(f.visits.nextExpiry(), null); assert.equal(f.visits.record('b'), false);
  f.setTime(1001); assert.deepEqual([...f.visits.getRecentIds()], ['a']);
});
test('elapsed time is sampled fresh for each query, without a timer or polling', () => {
  const f = fixture(undefined, 100); f.visits.record('a');
  f.setTime(101); f.visits.record('b');
  f.setTime(RECENT_VISIT_TTL + 100); assert.deepEqual([...f.visits.getRecentIds()], ['b']);
  assert.equal(f.visits.nextExpiry(), RECENT_VISIT_TTL + 101);
  f.setTime(RECENT_VISIT_TTL + 101); assert.equal(f.visits.nextExpiry(), null); assert.deepEqual([...f.visits.getRecentIds()], []);
});
test('loading more than 1000 entries keeps only the most recent timestamps', () => {
  const entries = Array.from({ length: 1200 }, (_, index) => ['chat-' + index, index]);
  const f = fixture(JSON.stringify(entries), 2000);
  assert.equal(f.visits.size, 1000); assert.equal(f.visits.getRecentIds().has('chat-199'), false); assert.equal(f.visits.getRecentIds().has('chat-200'), true);
  f.visits.record('new'); const persisted = JSON.parse(f.storage.data.get(RECENT_VISITS_KEY));
  assert.equal(persisted.length, 1000); assert.deepEqual(persisted[0], ['new', 2000]);
  assert.equal(f.visits.getRecentIds().has('chat-200'), false);
});
test('recording many visits keeps memory and JSON bounded to 1000 without event-history growth', () => {
  let now = 0; const storage = memoryStorage(), visits = createRecentVisits({ storage, now: () => now });
  for (let i = 0; i < 1010; i++) { now = i; visits.record('chat-' + i); }
  assert.equal(visits.size, 1000); assert.equal(JSON.parse(storage.data.get(RECENT_VISITS_KEY)).length, 1000);
  assert.equal(visits.getRecentIds().has('chat-9'), false); assert.equal(visits.getRecentIds().has('chat-10'), true);
});
test('custom smaller limit retains newest timestamps and stable input order for exact ties', () => {
  const storage = memoryStorage(JSON.stringify([['old', 1], ['first-tie', 10], ['second-tie', 10], ['newest', 20]]));
  const visits = createRecentVisits({ storage, now: () => 100, limit: 3 });
  assert.deepEqual([...visits.getRecentIds()], ['newest', 'first-tie', 'second-tie']);
  visits.record('explicit'); assert.deepEqual([...visits.getRecentIds()], ['explicit', 'newest', 'first-tie']);
});
test('load and update do not mutate a supplied iterable or a returned Set', () => {
  const f = fixture(JSON.stringify([['a', 1], ['b', 2]]), 100);
  const set = f.visits.getRecentIds(); set.clear(); set.add('fabricated');
  assert.deepEqual([...f.visits.getRecentIds()], ['b', 'a']);
  const input = Object.freeze(['b', 'a', 'missing']); const copy = [...input]; f.visits.nextExpiry(input);
  assert.deepEqual(input, copy);
});
test('nextExpiry considers only the relevant supplied subset, not pins/hot/current that callers omit', () => {
  const f = fixture(JSON.stringify([['pin', 0], ['hot', 10], ['current', 20], ['recent-idle', 30], ['other-idle', 40]]), 100);
  assert.equal(f.visits.nextExpiry(), RECENT_VISIT_TTL);
  assert.equal(f.visits.nextExpiry(new Set(['recent-idle', 'other-idle'])), RECENT_VISIT_TTL + 30);
  assert.equal(f.visits.nextExpiry(['other-idle']), RECENT_VISIT_TTL + 40);
  assert.equal(f.visits.nextExpiry([]), null); assert.equal(f.visits.nextExpiry(['missing']), null);
});
test('nextExpiry accepts a generator of valid ids, ignores duplicates/invalid ids, and returns a finite epoch', () => {
  const f = fixture(JSON.stringify([['a', 10], ['b', 20]]), 100);
  function* subset() { yield 'b'; yield {}; yield null; yield 'missing'; yield 'b'; }
  assert.equal(f.visits.nextExpiry(subset()), RECENT_VISIT_TTL + 20);
  assert.equal(Number.isFinite(f.visits.nextExpiry(['a'])), true);
  assert.equal(f.visits.nextExpiry(null), null); assert.equal(f.visits.nextExpiry({}), null);
});
test('nextExpiry drops already expired records rather than returning a deadline in the past', () => {
  const f = fixture(JSON.stringify([['a', 10], ['b', 20]]), 100);
  f.setTime(RECENT_VISIT_TTL + 10);
  assert.equal(f.visits.nextExpiry(['a', 'b']), RECENT_VISIT_TTL + 20);
  assert.deepEqual([...f.visits.getRecentIds()], ['b']);
});
test('each public time-dependent operation samples now once, not once per key', () => {
  const f = fixture(JSON.stringify(Array.from({ length: 100 }, (_, i) => ['id-' + i, i])), 200);
  assert.equal(f.samples, 1);
  f.visits.getRecentIds(); assert.equal(f.samples, 2);
  f.visits.nextExpiry(['id-0', 'id-10', 'id-20']); assert.equal(f.samples, 3);
  f.visits.record('explicit'); assert.equal(f.samples, 4);
  void f.visits.size; f.visits.clear(); assert.equal(f.samples, 4);
});
test('increasing clock inside a single operation cannot make per-key expiry decisions inconsistent', () => {
  let now = RECENT_VISIT_TTL - 1;
  const storage = memoryStorage(JSON.stringify([['a', 0], ['b', 0]]));
  const visits = createRecentVisits({ storage, now: () => now++ });
  now = RECENT_VISIT_TTL - 1;
  assert.deepEqual([...visits.getRecentIds()], ['a', 'b']);
  now = RECENT_VISIT_TTL - 1; assert.equal(visits.nextExpiry(['a', 'b']), RECENT_VISIT_TTL);
});
test('storage read/write denial and absent storage all preserve useful bounded memory behavior', () => {
  for (const storage of [undefined, { getItem() { throw Error('denied'); }, setItem() { throw Error('quota'); } }, { getItem: () => null, setItem() { throw Error('quota'); } }]) {
    const visits = createRecentVisits({ storage, now: () => 100, limit: 2 });
    assert.equal(visits.record('a'), true); assert.equal(visits.record('b'), true);
    assert.deepEqual([...visits.getRecentIds()], ['a', 'b']); assert.equal(visits.nextExpiry(), RECENT_VISIT_TTL + 100);
  }
});
test('clear is memory-only teardown and never deletes or empties storage', () => {
  const f = fixture(undefined, 100); f.visits.record('a');
  const original = f.storage.data.get(RECENT_VISITS_KEY), writes = f.storage.writes.length;
  f.visits.clear(); assert.equal(f.visits.size, 0); assert.deepEqual([...f.visits.getRecentIds()], []); assert.equal(f.visits.nextExpiry(), null);
  assert.equal(f.storage.writes.length, writes); assert.equal(f.storage.data.get(RECENT_VISITS_KEY), original);
  assert.deepEqual([...createRecentVisits({ storage: f.storage, now: () => 101 }).getRecentIds()], ['a']);
});
