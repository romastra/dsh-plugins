import test from 'node:test';
import assert from 'node:assert/strict';
import { createPriorityOrder } from '../src/priorities.js';
import { createSwitcher, orderCandidates } from '../src/controller.js';

const ids = rows => rows.map(row => row.id);
const rows = (...names) => names.map(id => ({ id }));
const notices = entries => new Map(entries.map(([id, kind, rest = {}]) => [id, { kind, reminderActive: false, ...rest }]));
function question(callId, kind = 'question') {
  let value = { closed: false, channel: 'rpc' };
  return { kind, ...(callId === undefined ? {} : { callId }), getSnapshot: () => value,
    answer() { assert.fail('sorter must never answer'); }, dismiss() { assert.fail('sorter must never dismiss'); },
    subscribe() { assert.fail('sorter must never subscribe per chat'); }, set(next) { value = next; } };
}
function harness(at = 1000) {
  let now = at, samples = 0;
  const sorter = createPriorityOrder({ now: () => { samples++; return now; } });
  return { ...sorter, sorter, setTime: value => now = value, get samples() { return samples; },
    order: (items, context) => sorter.order(items, context), get size() { return sorter.size; } };
}

test('all five ranks: current, requests, exact errors, proven completions, then MRU others', () => {
  const sorter = createPriorityOrder({ now: () => 1000 });
  const items = rows('pin', 'done', 'error', 'request', 'current', 'working', 'stop', 'unread');
  items[0].pinned = true; items[5].running = true; items[7].completionUnread = true;
  const attention = notices([['request', 'question'], ['error', 'attention', { reason: 'error' }], ['done', 'completion'], ['stop', 'attention']]);
  const result = sorter.order(items, { currentId: 'current', history: ['working', 'unread', 'pin', 'stop', 'done', 'error', 'request'], attention });
  assert.deepEqual(ids(result), ['current', 'request', 'error', 'done', 'working', 'unread', 'pin', 'stop']);
  assert.equal(result[0], items[4], 'the current supplied row is preserved even when idle and unpinned');
});
test('sorter never invents or fetches a missing current item', () => {
  const sorter = createPriorityOrder({ now: () => 0 });
  assert.deepEqual(ids(sorter.order(rows('pin', 'hot'), { currentId: 'not-supplied', attention: notices([['hot', 'question']]) })), ['hot', 'pin']);
  assert.deepEqual(sorter.order([], { currentId: 'missing' }), []);
});
test('quick Ctrl+Tab chooses the hottest chat after current without changing the controller', () => {
  const sorter = createPriorityOrder({ now: () => 100 });
  const items = rows('current', 'previous', 'error', 'request');
  const attention = notices([['request', 'approval'], ['error', 'attention', { reason: 'error' }]]);
  const commits = [], snapshots = [];
  const controller = createSwitcher({ getItems: () => sorter.order(items, { currentId: 'current', history: ['current', 'previous', 'error', 'request'], attention }), getCurrent: () => 'current', commit: id => commits.push(id), changed: value => snapshots.push(value), later: () => 1, cancel() {} });
  controller.next(); assert.equal(snapshots.at(-1).items[snapshots.at(-1).index].id, 'request'); controller.release();
  assert.deepEqual(commits, ['request']);
});
test('the three hot categories use earliest published appearance, with MRU ties', () => {
  const sorter = createPriorityOrder({ now: () => 1000 });
  const items = rows('q-new', 'e-new', 'd-new', 'q-old', 'e-old', 'd-old', 'q-tie');
  const attention = notices([
    ['q-new', 'question', { eventId: 'q2', occurredAt: 20 }], ['q-old', 'approval', { eventId: 'q1', occurredAt: 10 }], ['q-tie', 'plan-review', { eventId: 'q3', occurredAt: 10 }],
    ['e-new', 'attention', { reason: 'error', eventId: 'e2', occurredAt: 40 }], ['e-old', 'attention', { reason: 'error', eventId: 'e1', occurredAt: 30 }],
    ['d-new', 'completion', { eventId: 'd2', occurredAt: 60 }], ['d-old', 'completion', { eventId: 'd1', occurredAt: 50 }],
  ]);
  assert.deepEqual(ids(sorter.order(items, { attention, history: ['q-tie', 'q-old'] })), ['q-tie', 'q-old', 'q-new', 'e-old', 'e-new', 'd-old', 'd-new']);
});
test('current is always first, including when it has an older or lower priority signal', () => {
  const sorter = createPriorityOrder({ now: () => 0 });
  const attention = notices([['current', 'completion', { occurredAt: 100 }], ['question', 'question', { occurredAt: 10 }]]);
  assert.deepEqual(ids(sorter.order(rows('question', 'current'), { currentId: 'current', attention })), ['current', 'question']);
});
test('rank four exactly preserves existing unique MRU and unvisited input ordering', () => {
  const items = [{ id: 'a', pinned: true }, { id: 'b', running: true }, { id: 'c' }, { id: 'a', title: 'duplicate' }, { id: 'd' }];
  const history = ['missing', 'c', 'b', 'c'];
  assert.deepEqual(createPriorityOrder().order(items, { history }), orderCandidates(items, history));
});
test('ordinary status labels, all unread flags and generic stops are not proof of successful completion or error', () => {
  const items = [
    { id: 'status-error', status: 'error' }, { id: 'status-done', status: 'done' }, { id: 'row-unread', completionUnread: true },
    { id: 'status-unread' }, { id: 'stopped' }, { id: 'blocked' }, { id: 'aborted' }, { id: 'max-tokens' }, { id: 'plain' },
  ];
  const status = new Map([['status-unread', { completionUnread: true }], ['status-error', { kind: 'error', failed: true }]]);
  const attention = notices([['stopped', 'attention'], ['blocked', 'attention', { reason: 'blocked' }], ['aborted', 'attention', { reason: 'aborted' }], ['max-tokens', 'attention', { reason: 'max-tokens' }]]);
  const history = ['plain', 'max-tokens', 'aborted', 'blocked', 'stopped', 'status-unread', 'row-unread', 'status-done', 'status-error'];
  assert.deepEqual(ids(createPriorityOrder().order(items, { status, attention, history })), history);
});
test('successful completion remains its own semantic signal even when unread is absent', () => {
  const items = [{ id: 'completion', completionUnread: false }, { id: 'unread', completionUnread: true }];
  assert.deepEqual(ids(createPriorityOrder().order(items, { history: ['unread', 'completion'], attention: notices([['completion', 'completion']]) })), ['completion', 'unread']);
});
test('highest category wins, and an old lower-category event cannot age a new question', () => {
  const f = harness(100), a = question('a'), b = question('b');
  const items = rows('a', 'b', 'error');
  let status = new Map([['b', { pendingInteraction: b }]]);
  const attention = notices([['a', 'completion', { occurredAt: 0 }], ['error', 'attention', { reason: 'error', occurredAt: 1 }]]);
  f.order(items, { status, attention }); f.setTime(200); status = new Map([...status, ['a', { pendingInteraction: a }]]);
  assert.deepEqual(ids(f.order(items, { status, attention, history: ['a', 'b', 'error'] })), ['b', 'a', 'error']);
});
test('multiple request signals use the earliest relevant first appearance only', () => {
  const sorter = createPriorityOrder({ now: () => 1000 });
  const status = new Map([['a', { pendingInteraction: question('a') }]]);
  const attention = notices([['a', 'question', { occurredAt: 10 }], ['b', 'approval', { occurredAt: 20 }]]);
  assert.deepEqual(ids(sorter.order(rows('b', 'a'), { status, attention })), ['a', 'b']);
});
test('approval, question and plan review are peers when actionable', () => {
  const status = new Map([
    ['approval', { pendingInteraction: { kind: 'approval', callId: 'a', answerable: true } }],
    ['question', { pendingInteraction: question('q') }], ['plan', { pendingInteraction: question('p', 'plan-review') }],
  ]);
  assert.deepEqual(ids(createPriorityOrder({ now: () => 100 }).order(rows('other', 'approval', 'question', 'plan'), { status, history: ['plan', 'question', 'approval', 'other'] })), ['plan', 'question', 'approval', 'other']);
});
test('closed, automatic, already reviewed, unanswerable and disposed requests do not get rank one', () => {
  const q = question('q'); q.set({ closed: true, channel: 'rpc' });
  const automatic = question('a'); automatic.set({ closed: false, channel: 'local' });
  const reviewed = question('p', 'plan-review'); reviewed.review = {};
  const disposed = question('d'); disposed.getSnapshot = () => { throw Error('disposed'); };
  const items = rows('closed', 'auto', 'reviewed', 'approval', 'disposed', 'plain');
  const status = new Map([['closed', { pendingInteraction: q }], ['auto', { pendingInteraction: automatic }], ['reviewed', { pendingInteraction: reviewed }], ['approval', { pendingInteraction: { kind: 'approval', answerable: false } }], ['disposed', { pendingInteraction: disposed }]]);
  assert.deepEqual(ids(createPriorityOrder().order(items, { status, history: ['plain'] })), ['plain', 'closed', 'auto', 'reviewed', 'approval', 'disposed']);
});
test('live closure removes request age and reappearance starts a fresh observed episode', () => {
  const f = harness(100), q = question('q'), other = question('other'); const items = rows('q', 'other');
  const status = new Map([['q', { pendingInteraction: q }]]);
  f.order(items, { status }); f.setTime(200); status.set('other', { pendingInteraction: other }); f.order(items, { status });
  q.set({ closed: true, channel: 'rpc' }); assert.deepEqual(ids(f.order(items, { status })), ['other', 'q']); assert.equal(f.size, 1);
  q.set({ closed: false, channel: 'rpc' }); f.setTime(300); assert.deepEqual(ids(f.order(items, { status })), ['other', 'q']);
});
test('stable request callId preserves age through plain status/request metadata rerenders', () => {
  const f = harness(100), items = rows('old', 'new');
  let status = new Map([['old', { pendingInteraction: question('same') }]]);
  f.order(items, { status }); f.setTime(200); status = new Map([...status, ['new', { pendingInteraction: question('new') }]]); f.order(items, { status });
  f.setTime(9999); status.set('old', { arbitrary: 'rerender', pendingInteraction: question('same') });
  assert.deepEqual(ids(f.order(items, { status, history: ['new', 'old'] })), ['old', 'new']);
});
test('request key and stable object fallback retain age without accumulating object IDs', () => {
  for (const useKey of [false, true]) {
    const f = harness(100), old = question(), items = rows('old', 'new'); if (useKey) old.key = 'stable';
    const status = new Map([['old', { pendingInteraction: old }]]); f.order(items, { status });
    f.setTime(200); status.set('new', { pendingInteraction: question('new') }); f.order(items, { status });
    f.setTime(9000); if (useKey) status.set('old', { pendingInteraction: { ...question(), key: 'stable' } });
    assert.deepEqual(ids(f.order(items, { status, history: ['new', 'old'] })), ['old', 'new']); assert.equal(f.size, 2);
  }
});
test('replacement request identifiers or source objects reset only that event age', () => {
  for (const kind of ['callId', 'object']) {
    const f = harness(100), items = rows('a', 'b');
    const status = new Map([['a', { pendingInteraction: question(kind === 'callId' ? 'a1' : undefined) }]]);
    f.order(items, { status }); f.setTime(200); status.set('b', { pendingInteraction: question('b') }); f.order(items, { status });
    f.setTime(300); status.set('a', { pendingInteraction: question(kind === 'callId' ? 'a2' : undefined) });
    assert.deepEqual(ids(f.order(items, { status })), ['b', 'a']); assert.equal(f.size, 2);
  }
});
test('identityless bridge events use continuous first observation, not changing row identity/reminder state', () => {
  const f = harness(100), items = rows('old', 'new');
  f.order(items, { attention: notices([['old', 'attention', { reason: 'error' }]]) });
  f.setTime(200); f.order(items, { attention: notices([['old', 'attention', { reason: 'error', reminderActive: true }], ['new', 'attention', { reason: 'error' }]]) });
  f.setTime(10000);
  assert.deepEqual(ids(f.order(items, { history: ['new', 'old'], attention: notices([['old', 'attention', { reason: 'error', reminderActive: false }], ['new', 'attention', { reason: 'error', reminderActive: true }]]) })), ['old', 'new']);
});
test('preexisting notices first seen together get one shared observation time and MRU tie, not invented history', () => {
  let clock = 100;
  const sorter = createPriorityOrder({ now: () => ++clock });
  const items = rows('a', 'b', 'c');
  assert.deepEqual(ids(sorter.order(items, { history: ['c', 'b', 'a'], attention: notices([['a', 'completion'], ['b', 'completion'], ['c', 'completion']]) })), ['c', 'b', 'a']);
  assert.equal(clock, 101, 'a single clock sample avoids array-order fabricated chronology');
});
test('same-kind replacement on a legacy identityless bridge cannot be distinguished and keeps its episode age', () => {
  const f = harness(100), items = rows('a', 'b');
  f.order(items, { attention: notices([['a', 'question']]) }); f.setTime(200);
  f.order(items, { attention: notices([['a', 'question'], ['b', 'question']]) }); f.setTime(300);
  assert.deepEqual(ids(f.order(items, { history: ['b', 'a'], attention: notices([['a', 'question'], ['b', 'question']]) })), ['a', 'b']);
});
test('clearing a notice then reappearing, or changing its kind, gives it a new observed age', () => {
  for (const kindChange of [false, true]) {
    const f = harness(100), items = rows('a', 'b');
    f.order(items, { attention: notices([['a', 'question']]) }); f.setTime(200);
    f.order(items, { attention: notices([['a', 'question'], ['b', 'question']]) });
    if (!kindChange) f.order(items, { attention: notices([['b', 'question']]) });
    f.setTime(300);
    assert.deepEqual(ids(f.order(items, { attention: notices([['a', kindChange ? 'approval' : 'question'], ['b', 'question']]) })), ['b', 'a']);
  }
});
test('new running turn with no terminal notice clears completion cache', () => {
  const f = harness(100), items = [{ id: 'a' }, { id: 'b' }];
  f.order(items, { attention: notices([['a', 'completion']]) }); assert.equal(f.size, 1);
  f.order(items, { status: new Map([['a', { running: true }]]) }); assert.equal(f.size, 0);
  f.setTime(200); f.order(items, { attention: notices([['b', 'completion']]) });
  f.setTime(300); assert.deepEqual(ids(f.order(items, { attention: notices([['a', 'completion'], ['b', 'completion']]) })), ['b', 'a']);
});
test('optional eventId distinguishes same-category replacement while stable IDs survive row rerenders', () => {
  const f = harness(100), items = rows('a', 'b');
  f.order(items, { attention: notices([['a', 'completion', { eventId: 'a1' }]]) }); f.setTime(200);
  f.order(items, { attention: notices([['a', 'completion', { eventId: 'a1' }], ['b', 'completion', { eventId: 'b1' }]]) }); f.setTime(300);
  assert.deepEqual(ids(f.order(items, { history: ['b', 'a'], attention: notices([['a', 'completion', { eventId: 'a1', reminderActive: true }], ['b', 'completion', { eventId: 'b1' }]]) })), ['a', 'b']);
  assert.deepEqual(ids(f.order(items, { attention: notices([['a', 'completion', { eventId: 'a2' }], ['b', 'completion', { eventId: 'b1' }]]) })), ['b', 'a']);
});
test('valid published timestamp zero is oldest; occurredAt wins over receivedAt, not metadata update time', () => {
  const sorter = createPriorityOrder({ now: () => 1000 });
  const attention = notices([['a', 'completion', { eventId: 'a', occurredAt: 0, receivedAt: 999, updatedAt: 9999 }], ['b', 'completion', { occurredAt: 10, receivedAt: 0 }], ['c', 'completion', { receivedAt: 5 }]]);
  assert.deepEqual(ids(sorter.order(rows('b', 'c', 'a'), { attention })), ['a', 'c', 'b']);
});
test('null, NaN, Infinity, negative and string timestamps never coerce to event ages', () => {
  const sorter = createPriorityOrder({ now: () => 1000 });
  const values = [null, NaN, Infinity, -1, '0', undefined];
  const items = values.map((_, index) => ({ id: String(index) }));
  const attention = new Map(values.map((occurredAt, index) => [String(index), { kind: 'completion', occurredAt }]));
  const history = [...items].reverse().map(x => x.id);
  assert.deepEqual(ids(sorter.order(items, { attention, history })), history);
});
test('receivedAt is used when occurredAt is invalid, and published time can replace an observation estimate', () => {
  const f = harness(1000), items = rows('a', 'b');
  f.order(items, { attention: notices([['a', 'completion', { eventId: 'a' }], ['b', 'completion', { eventId: 'b' }]]) });
  assert.deepEqual(ids(f.order(items, { attention: notices([['a', 'completion', { eventId: 'a', occurredAt: null, receivedAt: 20 }], ['b', 'completion', { eventId: 'b', occurredAt: 10 }]]) })), ['b', 'a']);
});
test('valid published time is authoritative even when greater than the injected observation clock', () => {
  const sorter = createPriorityOrder({ now: () => 0 });
  assert.deepEqual(ids(sorter.order(rows('new', 'old'), { attention: notices([['new', 'completion', { occurredAt: 200 }], ['old', 'completion', { occurredAt: 100 }]]) })), ['old', 'new']);
});
test('earliest timestamp for the same published event never resets on later metadata changes', () => {
  const f = harness(), items = rows('a', 'b');
  f.order(items, { attention: notices([['a', 'completion', { eventId: 'a', occurredAt: 5 }], ['b', 'completion', { eventId: 'b', occurredAt: 10 }]]) });
  assert.deepEqual(ids(f.order(items, { attention: notices([['a', 'completion', { eventId: 'a', occurredAt: 50 }], ['b', 'completion', { eventId: 'b', occurredAt: 10 }]]) })), ['a', 'b']);
});
test('invalid or throwing clock leaves deterministic MRU ties without fabricated times', () => {
  for (const now of [() => null, () => NaN, () => Infinity, () => -1, () => { throw Error('clock unavailable'); }]) {
    const sorter = createPriorityOrder({ now });
    assert.deepEqual(ids(sorter.order(rows('a', 'b'), { history: ['b'], attention: notices([['a', 'question'], ['b', 'question']]) })), ['b', 'a']);
  }
});
test('age changes do not reorder the frozen controller cycle; the next cycle uses fresh priorities', () => {
  const f = harness(100), items = rows('current', 'a', 'b');
  let attention = notices([['a', 'completion']]); let snapshot;
  const controller = createSwitcher({ getItems: () => f.order(items, { currentId: 'current', attention }), getCurrent: () => 'current', changed: value => snapshot = value, commit() {}, later: () => 1, cancel() {} });
  controller.next(); assert.deepEqual(ids(snapshot.items), ['current', 'a', 'b']);
  attention = notices([['a', 'completion'], ['b', 'question']]); controller.reconcile();
  assert.deepEqual(ids(snapshot.items), ['current', 'a', 'b']); controller.abort(); controller.next();
  assert.deepEqual(ids(snapshot.items), ['current', 'b', 'a']); controller.abort();
});
test('sorting only reads immutable input data and never answers, acknowledges, subscribes or retains', () => {
  const sorter = createPriorityOrder({ now: () => 0 });
  const request = Object.freeze(question('id'));
  const items = Object.freeze([Object.freeze({ id: 'a' }), Object.freeze({ id: 'b' })]);
  const history = Object.freeze(['b', 'a']);
  const status = new Map([['a', Object.freeze({ pendingInteraction: request })]]);
  const attention = new Map([['b', Object.freeze({ kind: 'completion', reminderActive: false })]]);
  for (const map of [status, attention]) for (const method of ['set', 'delete', 'clear']) Object.defineProperty(map, method, { value() { assert.fail('input map mutation'); } });
  assert.deepEqual(ids(sorter.order(items, { history, status, attention })), ['a', 'b']);
  assert.deepEqual(history, ['b', 'a']); assert.deepEqual(ids(items), ['a', 'b']); assert.equal(status.get('a').pendingInteraction, request);
});
test('cache is bounded to currently supplied candidates and their active signals; clear releases everything', () => {
  const sorter = createPriorityOrder({ now: () => 1000 });
  for (let i = 0; i < 200; i++) {
    const id = String(i), items = [{ id }];
    sorter.order(items, { status: new Map([[id, { pendingInteraction: question('q-' + i) }]]), attention: notices([[id, 'attention', { reason: 'error', eventId: 'e-' + i }]]) });
    assert.equal(sorter.size, 1);
  }
  sorter.order(rows('other')); assert.equal(sorter.size, 0);
  sorter.order(rows('x'), { attention: notices([['x', 'question']]) }); assert.equal(sorter.size, 1);
  sorter.clear(); assert.equal(sorter.size, 0);
  sorter.order([]); assert.equal(sorter.size, 0);
});
test('removing and later re-adding a candidate starts a fresh local episode even with the same notice identity', () => {
  const f = harness(100), items = rows('a', 'b');
  f.order(items, { attention: notices([['a', 'question', { eventId: 'a' }]]) }); f.order(rows('b'));
  f.setTime(200); f.order(items, { attention: notices([['b', 'question', { eventId: 'b' }]]) });
  f.setTime(300); assert.deepEqual(ids(f.order(items, { attention: notices([['a', 'question', { eventId: 'a' }], ['b', 'question', { eventId: 'b' }]]) })), ['b', 'a']);
});
