import test from 'node:test';
import assert from 'node:assert/strict';
import { createSwitcher, orderPinned, orderCandidates, visit } from '../src/controller.js';
import { readCandidates } from '../src/adapter.js';

function fakeClock() {
  let now = 0;
  let nextId = 0;
  const jobs = new Map();
  const callbacks = [];
  return {
    later(callback, delay) {
      const id = nextId++;
      callbacks.push(callback);
      jobs.set(id, { callback, at: now + delay });
      return id;
    },
    cancel(id) { jobs.delete(id); },
    tick(milliseconds) {
      const end = now + milliseconds;
      while (true) {
        const due = [...jobs].filter(([, job]) => job.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        const [id, job] = due;
        now = job.at;
        jobs.delete(id);
        job.callback();
      }
      now = end;
    },
    get pending() { return jobs.size; },
    callbacks,
  };
}

function harness(ids = ['a', 'b', 'c'], current = 'a', options = {}) {
  const clock = fakeClock();
  const state = {
    items: ids.map(id => ({ id, pinned: true })),
    history: ids.slice(),
    current,
    changes: [],
    commits: [],
    delay: 250,
  };
  const controller = createSwitcher({
    getItems: () => orderPinned(state.items, state.history),
    getCurrent: () => state.current,
    commit(id) {
      state.commits.push(id);
      state.current = id;
      state.history = visit(state.history, id);
    },
    changed: snapshot => state.changes.push(snapshot),
    delay: () => state.delay,
    later: clock.later,
    cancel: clock.cancel,
    ...options,
  });
  return { ...controller, clock, state,
    get latest() { return state.changes.at(-1); },
  };
}

const idsOf = snapshot => snapshot.items.map(item => item.id);
const selected = snapshot => snapshot.items[snapshot.index].id;

test('visible release snapshots presentation before clear and passes it to the unchanged commit', () => {
  const order=[],prepared={image:'owned-card'};
  const h=harness(['a','b'],'a',{beforeCommit(id,cycle){order.push('capture:'+id);assert.equal(cycle.visible,true);return prepared;},changed:cycle=>{if(cycle===null)order.push('clear');},commit:(id,visual)=>{order.push('commit:'+id);assert.equal(visual,prepared);}});
  h.next();h.clock.tick(250);h.release();assert.deepEqual(order,['capture:b','clear','commit:b']);
});
test('hidden quick cycles do not capture visuals and a failed visible capture never blocks commit', () => {
  let captures=0;const h=harness(['a','b'],'a',{beforeCommit(){captures++;throw new Error('visual unavailable');}});
  h.next();h.release();assert.equal(captures,0);assert.deepEqual(h.state.commits,['b']);
  h.next();h.clock.tick(250);h.release();assert.equal(captures,1);assert.deepEqual(h.state.commits,['b','a']);
});
test('unselected browse and ineligible targets do not invoke presentation capture', () => {
  let captures=0;const h=harness(['a','b'],'a',{beforeCommit(){captures++;}});
  h.browse();h.release();assert.equal(captures,0);h.abort();h.next();h.clock.tick(250);h.state.items=[];h.release();assert.equal(captures,0);assert.deepEqual(h.state.commits,[]);
});
test('pointer context takeover keeps frozen cards but ends keyboard-release ownership', () => {
  for(const elapsed of [0,250]){
    const h=harness();h.next();h.clock.tick(elapsed);h.state.history=['c','b','a'];
    const result=h.browse({pointer:true});assert.equal(result.mode,'browse');assert.equal(result.visible,true);assert.equal(result.keyboardSelection,false);assert.deepEqual(idsOf(result),['a','b','c']);assert.equal(h.clock.pending,0);
    h.release();h.clock.tick(1000);assert.deepEqual(h.state.commits,[]);assert.equal(h.latest.mode,'browse');
  }
});
test('orderPinned filters strictly, ranks unique visits, and keeps unvisited input order', () => {
  const items = Object.freeze([
    Object.freeze({ id: 'a', pinned: true }),
    Object.freeze({ id: 'off', pinned: false }),
    Object.freeze({ id: 'b', pinned: true }),
    Object.freeze({ id: 'truthy', pinned: 1 }),
    Object.freeze({ id: 'a', pinned: true }),
    Object.freeze({ id: 'c', pinned: true }),
    Object.freeze({ id: 'd', pinned: true }),
  ]);
  const history = Object.freeze(['missing', 'c', 'c', 'off', 'a']);
  const ordered = orderPinned(items, history);
  assert.deepEqual(ordered.map(item => item.id), ['c', 'a', 'b', 'd']);
  assert.equal(ordered[1], items[0]);
  assert.equal(items.length, 7);
  assert.deepEqual(history, ['missing', 'c', 'c', 'off', 'a']);
  assert.deepEqual(orderPinned([], history), []);
});

test('visit puts the new ID first and deduplicates without modifying history', () => {
  const history = Object.freeze(['a', 'b', 'a', 'c', 'b']);
  assert.deepEqual(visit(history, 'b'), ['b', 'a', 'c']);
  assert.deepEqual(visit(history, 'd'), ['d', 'a', 'b', 'c']);
  assert.deepEqual(visit([], 'a'), ['a']);
  assert.deepEqual(history, ['a', 'b', 'a', 'c', 'b']);
});

test('quick taps alternate the two most recently visited pinned chats', () => {
  const h = harness();
  for (const id of ['b', 'a', 'b', 'a']) {
    h.next();
    assert.equal(selected(h.latest), id);
    assert.equal(h.latest.visible, false);
    h.clock.tick(249);
    const historyBeforeCommit = h.state.history;
    h.release();
    assert.notEqual(h.state.history, historyBeforeCommit);
    assert.equal(h.latest, null);
    assert.equal(h.clock.pending, 0);
  }
  assert.deepEqual(h.state.commits, ['b', 'a', 'b', 'a']);
  assert.equal(h.state.changes.some(snapshot => snapshot?.visible), false);
});

test('hold becomes visible exactly at the default delay without committing', () => {
  const h = harness(undefined, undefined, { delay: undefined });
  h.next();
  assert.equal(h.clock.pending, 1);
  h.clock.tick(249);
  assert.equal(h.latest.visible, false);
  h.clock.tick(1);
  assert.equal(h.latest.visible, true);
  assert.equal(selected(h.latest), 'b');
  assert.deepEqual(h.state.commits, []);
  assert.equal(h.clock.pending, 0);
  h.clock.tick(1000);
  h.release();
  assert.deepEqual(h.state.commits, ['b']);
  assert.equal(h.latest, null);
});

test('repeated next cycles three-plus frozen candidates without resetting reveal timer', () => {
  const h = harness(['a', 'b', 'c', 'd']);
  h.next();
  h.clock.tick(100);
  h.next();
  assert.equal(selected(h.latest), 'c');
  h.next();
  assert.equal(selected(h.latest), 'd');
  h.clock.tick(149);
  assert.equal(h.latest.visible, false);
  h.clock.tick(1);
  assert.equal(h.latest.visible, true);
  h.next();
  assert.equal(selected(h.latest), 'a');
  h.next();
  assert.equal(selected(h.latest), 'b');
  assert.deepEqual(h.state.history, ['a', 'b', 'c', 'd']);
  assert.deepEqual(h.state.commits, []);
  h.release();
  assert.deepEqual(h.state.commits, ['b']);
  assert.equal(h.clock.pending, 0);
});

test('reverse cycles and wraps, including changing direction mid-cycle', () => {
  const h = harness();
  h.next(true);
  assert.equal(selected(h.latest), 'c');
  h.next(true);
  assert.equal(selected(h.latest), 'b');
  h.next(true);
  assert.equal(selected(h.latest), 'a');
  h.next(true);
  assert.equal(selected(h.latest), 'c');
  h.next(false);
  assert.equal(selected(h.latest), 'a');
  h.release();
  assert.deepEqual(h.state.commits, ['a']);
  assert.equal(h.clock.pending, 0);
});

test('a current chat outside the pinned list starts at first or last candidate', () => {
  for (const current of ['unpinned', null]) {
    for (const reverse of [false, true]) {
      const h = harness(undefined, current);
      h.next(reverse);
      assert.equal(selected(h.latest), reverse ? 'c' : 'a');
      h.release();
      assert.equal(h.clock.pending, 0);
    }
  }
});

test('one candidate cycles safely in either direction', () => {
  const h = harness(['a']);
  h.next();
  h.next(true);
  assert.equal(selected(h.latest), 'a');
  h.release();
  assert.deepEqual(h.state.commits, ['a']);
  assert.equal(h.clock.pending, 0);
});

test('no candidates is a no-op and creates no timers', () => {
  const h = harness([]);
  assert.equal(h.next(), null);
  assert.equal(h.next(true), null);
  assert.equal(h.reconcile(), null);
  h.release();
  h.abort();
  assert.deepEqual(h.state.changes, []);
  assert.deepEqual(h.state.commits, []);
  assert.equal(h.clock.pending, 0);
});

test('abort clears hidden and visible cycles without commit and is idempotent', () => {
  for (const elapsed of [0, 250]) {
    const h = harness();
    h.next();
    h.clock.tick(elapsed);
    h.abort();
    h.abort();
    h.release();
    assert.equal(h.latest, null);
    assert.equal(h.state.changes.filter(value => value === null).length, 1);
    h.clock.tick(1000);
    assert.equal(h.latest, null);
    assert.deepEqual(h.state.commits, []);
    assert.equal(h.clock.pending, 0);
    h.next();
    assert.equal(selected(h.latest), 'b');
    h.release();
    assert.deepEqual(h.state.commits, ['b']);
  }
});

test('release checks latest eligibility even without reconcile', () => {
  for (const change of ['delete', 'unpin']) {
    const h = harness();
    h.next();
    if (change === 'delete') h.state.items = h.state.items.filter(item => item.id !== 'b');
    else h.state.items.find(item => item.id === 'b').pinned = false;
    h.release();
    h.release();
    h.clock.tick(1000);
    assert.deepEqual(h.state.commits, []);
    assert.equal(h.latest, null);
    assert.equal(h.clock.pending, 0);
  }
});

test('reconcile removes ineligible items and preserves a surviving selection', () => {
  const h = harness(['a', 'b', 'c', 'd']);
  h.next();
  h.next();
  assert.equal(selected(h.latest), 'c');
  h.state.items[1].pinned = false;
  h.state.items = h.state.items.filter(item => item.id !== 'a');
  h.state.history = ['d', 'c'];
  h.reconcile();
  assert.deepEqual(idsOf(h.latest), ['c', 'd']);
  assert.equal(selected(h.latest), 'c');
  assert.equal(h.latest.index, 0);
  assert.equal(h.clock.pending, 1);
  h.release();
  assert.deepEqual(h.state.commits, ['c']);
  assert.equal(h.clock.pending, 0);
});

test('reconcile replaces a removed selection at its slot, clamped to final slot', () => {
  const h = harness(['a', 'b', 'c', 'd']);
  h.next();
  h.state.items = h.state.items.filter(item => item.id !== 'b');
  h.reconcile();
  assert.deepEqual(idsOf(h.latest), ['a', 'c', 'd']);
  assert.equal(selected(h.latest), 'c');
  h.next();
  assert.equal(selected(h.latest), 'd');
  h.state.items = h.state.items.filter(item => item.id !== 'd');
  h.reconcile();
  assert.equal(selected(h.latest), 'c');
  h.release();
  assert.deepEqual(h.state.commits, ['c']);
  assert.equal(h.clock.pending, 0);
});

test('reconcile aborts when all frozen candidates disappear, ignoring new items', () => {
  const h = harness();
  h.next();
  h.state.items = [{ id: 'new', pinned: true }];
  assert.equal(h.reconcile(), null);
  h.clock.tick(1000);
  h.release();
  assert.equal(h.latest, null);
  assert.deepEqual(h.state.commits, []);
  assert.equal(h.clock.pending, 0);
});

test('MRU and candidate additions never reorder or grow an active cycle', () => {
  const h = harness();
  h.next();
  h.state.history = ['c', 'b', 'new', 'a'];
  h.state.items.unshift({ id: 'new', pinned: true });
  h.next();
  assert.deepEqual(idsOf(h.latest), ['a', 'b', 'c']);
  assert.equal(selected(h.latest), 'c');
  h.reconcile();
  assert.deepEqual(idsOf(h.latest), ['a', 'b', 'c']);
  assert.equal(selected(h.latest), 'c');
  h.abort();
  h.next();
  assert.deepEqual(idsOf(h.latest), ['c', 'b', 'new', 'a']);
  assert.equal(selected(h.latest), 'c');
  h.abort();
  assert.equal(h.clock.pending, 0);
});

test('snapshots have detached arrays so consumers cannot reorder the cycle', () => {
  const h = harness();
  const first = h.next();
  first.items.reverse();
  first.index = 0;
  first.visible = true;
  h.next();
  assert.deepEqual(idsOf(h.latest), ['a', 'b', 'c']);
  assert.equal(selected(h.latest), 'c');
  assert.equal(h.latest.visible, false);
  h.abort();
  assert.equal(h.clock.pending, 0);
});

test('configurable delay is sampled once per cycle and accepts zero', () => {
  const h = harness();
  h.state.delay = 10;
  h.next();
  h.state.delay = 0;
  h.next();
  h.clock.tick(9);
  assert.equal(h.latest.visible, false);
  h.clock.tick(1);
  assert.equal(h.latest.visible, true);
  h.abort();
  h.next();
  assert.equal(h.latest.visible, false);
  h.clock.tick(0);
  assert.equal(h.latest.visible, true);
  h.abort();
  assert.equal(h.clock.pending, 0);
});

test('invalid delay falls back to 250 milliseconds', () => {
  for (const delay of [NaN, Infinity, -1, undefined, '10']) {
    const h = harness();
    h.state.delay = delay;
    h.next();
    h.clock.tick(249);
    assert.equal(h.latest.visible, false);
    h.clock.tick(1);
    assert.equal(h.latest.visible, true);
    h.abort();
    assert.equal(h.clock.pending, 0);
  }
});

test('stale timer callbacks cannot expose an aborted or later cycle', () => {
  const h = harness();
  h.next();
  const stale = h.clock.callbacks[0];
  h.abort();
  stale();
  assert.equal(h.latest, null);
  h.next();
  const count = h.state.changes.length;
  stale();
  assert.equal(h.state.changes.length, count);
  assert.equal(h.latest.visible, false);
  h.release();
  assert.equal(h.clock.pending, 0);
});

test('release clears controller before commit, including a throwing commit', () => {
  const clock = fakeClock();
  const changes = [];
  let controller;
  controller = createSwitcher({
    getItems: () => [{ id: 'a' }, { id: 'b' }],
    getCurrent: () => 'a',
    commit() {
      assert.equal(changes.at(-1), null);
      assert.equal(clock.pending, 0);
      controller.abort();
      throw new Error('navigation failed');
    },
    changed: value => changes.push(value),
    later: clock.later,
    cancel: clock.cancel,
  });
  controller.next();
  assert.throws(() => controller.release(), /navigation failed/);
  controller.release();
  assert.equal(changes.filter(value => value === null).length, 1);
  assert.equal(clock.pending, 0);
});

test('orderCandidates MRU ranks every supplied candidate, not just pinned ones, without mutation', () => {
  const items = Object.freeze([
    Object.freeze({ id: 'pinned', pinned: true, eligible: true }),
    Object.freeze({ id: 'running', pinned: false, eligible: true }),
    Object.freeze({ id: 'attention', pinned: false, eligible: true }),
    Object.freeze({ id: 'running', title: 'duplicate' }),
    Object.freeze({ id: 'unvisited' }),
  ]);
  const visits = Object.freeze(['gone', 'attention', 'attention', 'running']);
  const ordered = orderCandidates(items, visits);
  assert.deepEqual(ordered.map(x => x.id), ['attention', 'running', 'pinned', 'unvisited']);
  assert.equal(ordered[1], items[1]);
  assert.deepEqual(orderPinned(items, visits).map(x => x.id), ['pinned']);
  assert.deepEqual(orderCandidates([], visits), []);
  assert.deepEqual(orderCandidates(items, []).map(x => x.id), ['pinned', 'running', 'attention', 'unvisited']);
});

function candidateHarness() {
  const rows = { a: { id: 'a' }, b: { id: 'b' }, c: { id: 'c' } };
  const workspace = { pinnedSessionIds: ['a'], archivedSessionIds: [] };
  const statuses = new Map([['b', { running: true }]]);
  const attention = new Map([['c', { kind: 'attention' }]]);
  const sessions = { list: { getSnapshot: () => ({ ids: Object.keys(rows), byId: rows }) } };
  const workspaces = { list: { getSnapshot: () => workspace } };
  const clock = fakeClock(), commits = [];
  let current = 'a', history = ['a', 'b', 'c'], latest;
  const getItems = () => orderCandidates(readCandidates(sessions, workspaces, statuses, attention), history);
  const controller = createSwitcher({ getItems, getCurrent: () => current,
    commit(id) { commits.push(id); current = id; history = visit(history, id); },
    changed(value) { latest = value; }, later: clock.later, cancel: clock.cancel });
  return { ...controller, rows, workspace, statuses, attention, commits, clock, getItems,
    get latest() { return latest; }, get history() { return history; } };
}

test('quick candidate taps alternate pinned and nonpinned active chats while preserving attention', () => {
  const h = candidateHarness();
  for (const id of ['b', 'a', 'b', 'a']) {
    h.next();
    assert.equal(selected(h.latest), id);
    h.release();
    assert.equal(h.latest, null);
    assert.equal(h.clock.pending, 0);
  }
  assert.deepEqual(h.commits, ['b', 'a', 'b', 'a']);
  assert.equal(h.getItems().some(x => x.id === 'b' && !x.pinned), true);
  assert.deepEqual([...h.attention], [['c', { kind: 'attention' }]]);
  assert.deepEqual([...h.statuses], [['b', { running: true }]]);
});

test('live candidate reconciliation removes cleared attention/status but never adds or reorders a cycle', () => {
  const h = candidateHarness();
  h.next();
  h.clock.tick(250);
  assert.equal(selected(h.latest), 'b');
  h.attention.clear();
  h.rows.d = { id: 'd', running: true };
  h.reconcile();
  assert.deepEqual(idsOf(h.latest), ['a', 'b']);
  h.statuses.clear();
  h.reconcile();
  assert.deepEqual(idsOf(h.latest), ['a']);
  h.release();
  assert.deepEqual(h.commits, ['a']);
});

test('unpinning a still-running selection keeps it eligible and tracked after commit', () => {
  const h = candidateHarness();
  h.workspace.pinnedSessionIds.push('b');
  h.next();
  h.workspace.pinnedSessionIds = ['a'];
  h.reconcile();
  assert.equal(selected(h.latest), 'b');
  h.release();
  assert.deepEqual(h.commits, ['b']);
  assert.deepEqual(h.history, ['b', 'a', 'c']);
  h.next();
  assert.equal(selected(h.latest), 'a');
  h.release();
  assert.deepEqual(h.commits, ['b', 'a']);
});

test('release freshly rechecks status, archive, metadata and pin changes even without reconciliation', () => {
  for (const remove of [h => h.statuses.clear(), h => h.workspace.archivedSessionIds.push('b'), h => delete h.rows.b]) {
    const h = candidateHarness();
    h.next();
    assert.equal(selected(h.latest), 'b');
    remove(h);
    h.release();
    assert.deepEqual(h.commits, []);
    assert.equal(h.latest, null);
    assert.equal(h.clock.pending, 0);
  }
  const h = candidateHarness();
  h.next(true);
  assert.equal(selected(h.latest), 'c');
  h.attention.clear();
  h.release();
  assert.deepEqual(h.commits, []);
});

test('browse opens immediately without keyboard selection, retaining its internal MRU cursor', () => {
  const h = harness();
  const snapshot = h.browse();
  assert.equal(snapshot.mode, 'browse'); assert.equal(snapshot.visible, true);
  assert.equal(snapshot.keyboardSelection, false);
  assert.equal(selected(snapshot), 'b'); assert.deepEqual(idsOf(snapshot), ['a', 'b', 'c']);
  assert.equal(h.clock.pending, 0); h.clock.tick(3000);
  assert.deepEqual(h.state.commits, []); assert.deepEqual(h.state.history, ['a', 'b', 'c']);
  h.abort(); assert.equal(h.latest, null); assert.deepEqual(h.state.commits, []);
});

test('release without a browse keyboard selection is a no-op and keeps the modal open', () => {
  const h = harness();
  const snapshot = h.browse();
  const history = h.state.history;
  h.release(); h.release(); h.clock.tick(3000);
  assert.equal(h.latest, snapshot);
  assert.equal(h.state.changes.length, 1);
  assert.equal(h.latest.keyboardSelection, false);
  assert.equal(h.latest.mode, 'browse'); assert.equal(h.latest.visible, true);
  assert.equal(h.clock.pending, 0);
  assert.equal(h.state.history, history); assert.deepEqual(h.state.commits, []);
  h.abort(); assert.equal(h.latest, null);
});

test('browse snapshots cannot enable or move the internal keyboard selection', () => {
  const h = harness(); h.browse();
  const detached = h.browse();
  detached.keyboardSelection = true; detached.index = 2; detached.items.reverse();
  h.release();
  const snapshot = h.browse();
  assert.equal(snapshot.keyboardSelection, false);
  assert.equal(selected(snapshot), 'b'); assert.deepEqual(idsOf(snapshot), ['a', 'b', 'c']);
  assert.deepEqual(h.state.commits, []); assert.equal(h.state.changes.length, 1);
  h.abort();
});

test('the first browse arrow selects the first or last item, never the invisible cursor', () => {
  for (const step of [1, 2, 6, -1, -2, -6]) {
    const h = harness(['a', 'b', 'c', 'd'], 'b'); h.browse();
    assert.equal(selected(h.latest), 'c'); assert.equal(h.latest.keyboardSelection, false);
    const first = h.move(step);
    assert.equal(selected(first), step > 0 ? 'a' : 'd');
    assert.equal(first.keyboardSelection, true); assert.equal(first.mode, 'browse');
    assert.equal(first.visible, true); assert.equal(h.clock.pending, 0);
    h.move(step > 0 ? 1 : -1);
    assert.equal(selected(h.latest), step > 0 ? 'b' : 'c');
    assert.deepEqual(h.state.commits, []); assert.deepEqual(h.state.history, ['a', 'b', 'c', 'd']);
    h.release(); assert.deepEqual(h.state.commits, [step > 0 ? 'b' : 'c']);
    assert.equal(h.latest, null);
  }
});

test('browse Home/End-style select activates keyboard selection before Enter-style release', () => {
  for (const [index, id] of [[-50, 'a'], [0, 'a'], [1, 'b'], [50, 'c']]) {
    const h = harness(); h.browse();
    const snapshot = h.select(index);
    assert.equal(snapshot.keyboardSelection, true); assert.equal(snapshot.mode, 'browse');
    assert.equal(selected(snapshot), id); assert.deepEqual(h.state.commits, []);
    h.release(); assert.deepEqual(h.state.commits, [id]); assert.equal(h.latest, null);
    assert.equal(h.clock.pending, 0);
  }
});

test('browse reentry does not advance or clear selection; move/select keep frozen membership', () => {
  const h = harness(); h.browse();
  const reentry = h.browse();
  assert.equal(selected(reentry), 'b'); assert.equal(reentry.keyboardSelection, false);
  assert.equal(h.state.changes.length, 1);
  h.move(1); assert.equal(selected(h.latest), 'a'); assert.equal(h.latest.mode, 'browse');
  const selectedReentry = h.browse();
  assert.equal(selected(selectedReentry), 'a'); assert.equal(selectedReentry.keyboardSelection, true);
  h.move(1); assert.equal(selected(h.latest), 'b'); h.select(50); assert.equal(selected(h.latest), 'c');
  h.select(-1); assert.equal(selected(h.latest), 'a');
  h.state.items = h.state.items.filter(x => x.id !== 'a'); h.reconcile();
  assert.deepEqual(idsOf(h.latest), ['b', 'c']); assert.equal(h.latest.mode, 'browse');
  assert.equal(h.latest.keyboardSelection, true);
  h.release(); assert.deepEqual(h.state.commits, ['b']); assert.equal(h.clock.pending, 0);
});

test('unselected browse reconcile only removes invalid frozen cards and never creates selection', () => {
  for (const step of [1, -1]) {
    const h = harness(['a', 'b', 'c', 'd']); h.browse();
    h.state.items = h.state.items.filter(item => item.id !== 'b');
    h.state.items.unshift({ id: 'new', pinned: true });
    h.state.history = ['new', 'd', 'c', 'a'];
    const snapshot = h.reconcile();
    assert.deepEqual(idsOf(snapshot), ['a', 'c', 'd']); assert.equal(selected(snapshot), 'c');
    assert.equal(snapshot.keyboardSelection, false);
    h.release(); assert.equal(h.latest, snapshot); assert.deepEqual(h.state.commits, []);
    h.move(step); assert.equal(selected(h.latest), step > 0 ? 'a' : 'd');
    assert.equal(h.latest.keyboardSelection, true);
    h.release(); assert.deepEqual(h.state.commits, [step > 0 ? 'a' : 'd']);
  }
});

test('Ctrl+Tab takes over unselected browse from current, without skipping its first target', () => {
  for (const reverse of [false, true]) {
    const h = harness(); h.browse(); h.next(reverse);
    assert.equal(selected(h.latest), reverse ? 'c' : 'b');
    assert.equal(h.latest.keyboardSelection, true);
    assert.equal(h.latest.mode, 'hold'); assert.equal(h.latest.visible, true); assert.equal(h.clock.pending, 0);
    h.release(); assert.deepEqual(h.state.commits, [reverse ? 'c' : 'b']);
  }
});

test('Ctrl+Tab takeover samples actual current but preserves frozen order despite later MRU/additions', () => {
  for (const [current, forward, backward] of [
    ['a', 'b', 'd'], ['b', 'c', 'a'], ['d', 'a', 'c'], ['outside', 'a', 'd'], [null, 'a', 'd'],
  ]) {
    for (const reverse of [false, true]) {
      const h = harness(['a', 'b', 'c', 'd']); h.browse();
      h.state.current = current;
      h.state.items.unshift({ id: 'new', pinned: true });
      h.state.history = ['new', 'd', 'c', 'b', 'a'];
      h.reconcile(); assert.equal(h.latest.keyboardSelection, false);
      h.next(reverse);
      assert.deepEqual(idsOf(h.latest), ['a', 'b', 'c', 'd']);
      assert.equal(selected(h.latest), reverse ? backward : forward);
      assert.equal(h.latest.keyboardSelection, true); assert.equal(h.latest.mode, 'hold');
      assert.equal(h.latest.visible, true); assert.equal(h.clock.pending, 0);
      assert.deepEqual(h.state.commits, []);
      h.release(); assert.deepEqual(h.state.commits, [reverse ? backward : forward]);
    }
  }
});

test('Ctrl+Tab advances an already keyboard-selected browse rather than resetting to current', () => {
  for (const reverse of [false, true]) {
    const h = harness(); h.browse(); h.select(1); h.next(reverse);
    assert.equal(selected(h.latest), reverse ? 'a' : 'c');
    assert.equal(h.latest.keyboardSelection, true); assert.equal(h.latest.mode, 'hold');
    assert.equal(h.latest.visible, true); assert.equal(h.clock.pending, 0);
    const reentry = h.browse();
    assert.equal(reentry.mode, 'hold'); assert.equal(reentry.keyboardSelection, true);
    assert.equal(selected(reentry), reverse ? 'a' : 'c');
    h.release(); assert.deepEqual(h.state.commits, [reverse ? 'a' : 'c']);
  }
});

test('all hold snapshots consistently export keyboardSelection through reveal and reconciliation', () => {
  const h = harness(); h.next(); h.clock.tick(250); h.move(-1); h.select(2); h.reconcile();
  const reentry = h.browse();
  for (const snapshot of [...h.state.changes, reentry]) {
    assert.equal(snapshot.keyboardSelection, true); assert.equal(snapshot.mode, 'hold');
  }
  h.release(); assert.equal(h.latest, null);
  const freshBrowse = h.browse();
  assert.equal(freshBrowse.keyboardSelection, false); assert.equal(freshBrowse.mode, 'browse');
  h.abort();
});

test('browse with no candidates is a no-op; stale hold timers cannot reveal a later browse', () => {
  const empty = harness([]); assert.equal(empty.browse(), null); assert.equal(empty.clock.pending, 0);
  const h = harness(); h.next(); const stale = h.clock.callbacks[0]; h.abort(); h.browse();
  stale(); assert.equal(h.latest.mode, 'browse'); assert.equal(h.latest.visible, true);
  assert.equal(h.latest.keyboardSelection, false); assert.equal(selected(h.latest), 'b'); h.abort();
});
