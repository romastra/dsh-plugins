import test from 'node:test';
import assert from 'node:assert/strict';
import { readCardMeta } from '../src/card-meta.js';

const noMeta = () => ({ workspaceId: null, workspaceTitle: null, activeTask: null });
const row = id => ({ id, title: `Chat ${id}` });
const task = (content, status = 'in_progress') => ({ content, status });
const projection = todos => ({ values: { todos } });
const snapshot = (todos = [], id = 'a') => ({
  byId: { [id]: row(id) }, projectionsBySession: { [id]: projection(todos) },
});
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

test('default candidates include unopened byId sessions and preserve raw default/custom workspace titles', () => {
  const sessions = {
    ids: ['open'],
    byId: { open: row('open'), unopened: row('unopened'), ungrouped: row('ungrouped') },
    projectionsBySession: {
      open: projection([task('  Finish open chat  ')]),
      unopened: projection([task('  Work from the live root stream  ')]),
    },
  };
  const workspaces = { items: [
    { workspaceId: 'default', title: '  default-workspace \t', sessionIds: ['open'] },
    { workspaceId: 'custom', title: '  Custom project  ', sessionIds: ['unopened'] },
  ] };
  assert.deepEqual(readCardMeta(sessions, workspaces), new Map([
    ['open', { workspaceId: 'default', workspaceTitle: 'default-workspace', activeTask: 'Finish open chat' }],
    ['unopened', { workspaceId: 'custom', workspaceTitle: 'Custom project', activeTask: 'Work from the live root stream' }],
    ['ungrouped', noMeta()],
  ]));
});

test('explicit candidate ids alone are mapped, in candidate order, with unknown ids defaulting to null', () => {
  const sessions = {
    byId: { a: row('a'), b: row('b'), outside: row('outside') },
    projectionsBySession: {
      b: projection([task('Only B')]),
      get outside() { throw new Error('noncandidate projection was read'); },
      ghost: projection([task('Stale ghost task')]),
    },
  };
  const workspaces = { items: [{ title: 'B workspace', sessionIds: ['b', 'ghost'] }] };
  assert.deepEqual(readCardMeta(sessions, workspaces, ['b', 'ghost', 'a', 'b']), new Map([
    ['b', { workspaceId: null, workspaceTitle: 'B workspace', activeTask: 'Only B' }],
    ['ghost', noMeta()],
    ['a', noMeta()],
  ]));
});

test('workspace membership uses sessionIds only, never raw workspaceId/cwd or workspace path collisions', () => {
  const sessions = { byId: {
    a: { ...row('a'), workspaceId: 'collision', cwd: 'C:\\same-path', path: 'C:\\same-path' },
    b: { ...row('b'), workspaceId: 'real', cwd: 'C:\\same-path' },
  } };
  const workspaces = { items: [
    { workspaceId: 'collision', title: 'Wrong path match', path: 'C:\\same-path', sessionIds: ['other'] },
    { workspaceId: 'real', title: 'Actual membership', path: 'C:\\different-path', sessionIds: ['a'] },
  ] };
  assert.deepEqual(readCardMeta(sessions, workspaces), new Map([
    ['a', { workspaceId: 'real', workspaceTitle: 'Actual membership', activeTask: null }],
    ['b', noMeta()],
  ]));
});

test('the first matching workspace in native items order wins regardless of workspace id order', () => {
  const first = { workspaceId: 'z', title: ' First native item ', sessionIds: ['a'] };
  const second = { workspaceId: 'a', title: 'Second item', sessionIds: ['a'] };
  assert.equal(readCardMeta(snapshot(), { items: [first, second] }).get('a').workspaceTitle, 'First native item');
  assert.equal(readCardMeta(snapshot(), { items: [second, first] }).get('a').workspaceTitle, 'Second item');
});

test('missing/empty/malformed first workspace titles have no path or later-workspace fallback', () => {
  for (const title of [undefined, null, 42, {}, [], '', ' \t\n ']) {
    const workspaces = { items: [
      { title, path: 'C:\\never-a-label', sessionIds: ['a'] },
      { title: 'Do not skip to this workspace', sessionIds: ['a'] },
    ] };
    assert.equal(readCardMeta(snapshot(), workspaces).get('a').workspaceTitle, null);
  }
});

test('missing or malformed workspace containers/membership cannot invent a workspace title', () => {
  const malformed = [undefined, null, {}, [], { items: null }, { items: {} }, { items: 'a' },
    { items: [null, [], 'bad', { title: 'Not an array', sessionIds: 'a' }, { title: 'No membership' }] }];
  for (const workspaces of malformed) {
    assert.deepEqual(readCardMeta(snapshot([task('Task still available')]), workspaces).get('a'), {
      workspaceId: null, workspaceTitle: null, activeTask: 'Task still available',
    });
  }
});

test('activeTask is the trimmed first in_progress TODO, not pending/completed or later active tasks', () => {
  const todos = [
    task('Pending first', 'pending'), task('Completed second', 'completed'),
    task(' \tFirst active\nwith detail \n'),
    { get content() { throw new Error('a later task was read'); }, status: 'in_progress' },
  ];
  assert.deepEqual(readCardMeta(snapshot(todos), {}).get('a'), {
    workspaceId: null, workspaceTitle: null, activeTask: 'First active\nwith detail',
  });
});

test('nonempty TODO lists do not read goals; missing lists use only canonical wire goals, never raw-row data', () => {
  const sessions = {
    byId: { a: {
      ...row('a'),
      get projectionValues() { throw new Error('raw-row projectionValues were read'); },
      get goal() { throw new Error('a raw-row goal was read'); },
    } },
    projectionsBySession: { a: { values: {
      get goal() { throw new Error('projection goal was read'); },
      todos: [task('Pending fallback', 'pending'), task('Completed fallback', 'completed')],
    } } },
  };
  assert.deepEqual(readCardMeta(sessions, {}).get('a'), noMeta());
  delete sessions.projectionsBySession.a.values.todos;
  Object.defineProperty(sessions.projectionsBySession.a.values, 'goal', { value: { goal: { objective: 'Canonical fallback', phase: 'active' } } });
  assert.deepEqual(readCardMeta(sessions, {}).get('a'), { workspaceId: null, workspaceTitle: null, activeTask: 'Canonical fallback' });
});

test('latest same-session wire goal supplies the caption only for missing/null/empty TODO lists', () => {
  for (const phase of ['active', 'paused', 'blocked', 'complete']) for (const todos of [undefined, null, []]) {
    const sessions = snapshot(todos);
    sessions.projectionsBySession.a.values.goal = { goal: { objective: '  Closest retained goal  ', phase }, createdAt: 1, updatedAt: 2 };
    assert.equal(readCardMeta(sessions, {}).get('a').activeTask, 'Closest retained goal');
  }
});
test('existing TODOs retain priority and a nonempty pending/completed/malformed list does not become a goal', () => {
  for (const todos of [[task('Actual first task')], [task('Pending', 'pending')], [task('Done', 'completed')], [task('   ')], 'corrupt']) {
    const sessions = snapshot(todos);
    Object.defineProperty(sessions.projectionsBySession.a.values, 'goal', { get() { throw new Error('goal read despite an existing TODO list'); } });
    assert.equal(readCardMeta(sessions, {}).get('a').activeTask, Array.isArray(todos) && todos[0]?.content === 'Actual first task' ? 'Actual first task' : null);
  }
});
test('goal replacement and clear use the latest native cache only, with no historical or cross-session fallback', () => {
  const sessions = snapshot(null);
  sessions.byId.b = row('b');
  sessions.projectionsBySession.b = { values: { goal: { goal: { objective: 'Other chat', phase: 'active' } } } };
  const values = sessions.projectionsBySession.a.values;
  values.goal = { goal: { objective: 'Old current', phase: 'active' } };
  assert.equal(readCardMeta(sessions, {}).get('a').activeTask, 'Old current');
  values.goal = { goal: { objective: 'New current', phase: 'complete' } };
  assert.equal(readCardMeta(sessions, {}).get('a').activeTask, 'New current');
  values.goal = null;
  assert.equal(readCardMeta(sessions, {}).get('a').activeTask, null);
});
test('flat goals, checkpoints, malformed/unknown/empty or cleared wire goals never supply captions', () => {
  for (const goal of [undefined, null, {}, { objective: 'Wrong flat shape' }, { current: { goal: { objective: 'Checkpoint', phase: 'active' } } }, { goal: { objective: ' ', phase: 'active' } }, { goal: { objective: 42, phase: 'active' } }, { goal: { objective: 'Bad phase', phase: 'unknown' } }]) {
    const sessions = snapshot(null); sessions.projectionsBySession.a.values.goal = goal;
    assert.equal(readCardMeta(sessions, {}).get('a').activeTask, null);
  }
});
test('stale alternative projections never replace missing/null/empty canonical todos', () => {
  for (const canonical of [undefined, null, [], [task('Only pending', 'pending')]]) {
    const stale = { todos: [task('Stale alternative active task')] };
    const sessions = {
      byId: { a: { ...row('a'), projectionValues: stale } },
      projectionValues: { a: stale },
      projectionsBySession: { a: { ...stale, values: { todos: canonical, goal: { objective: 'Not a TODO' } } } },
    };
    assert.equal(readCardMeta(sessions, {}).get('a').activeTask, null);
  }
});

test('missing, null and malformed canonical TODO/projection containers yield null', () => {
  for (const value of [undefined, null, [], 'bad', {}, { values: null }, { values: [] }, { values: {} },
    { values: { todos: null } }, { values: { todos: [] } }, { values: { todos: 'bad' } },
    { values: { todos: { 0: task('Not an array'), length: 1 } } }]) {
    const sessions = { byId: { a: row('a') }, projectionsBySession: { a: value } };
    assert.equal(readCardMeta(sessions, {}).get('a').activeTask, null);
  }
});

test('a malformed/empty first in_progress content fails closed instead of skipping to a later task', () => {
  for (const content of [undefined, null, false, 42, {}, [], '', ' \n\t ']) {
    const sessions = snapshot([task(content), task('Do not select this later active task')]);
    assert.equal(readCardMeta(sessions, {}).get('a').activeTask, null);
  }
});

test('malformed TODO entries before a valid in_progress task fail closed', () => {
  for (const malformed of [undefined, null, false, 42, 'bad', [], {},
    { status: 'IN_PROGRESS', content: 'Wrong status' }, { status: 'unknown', content: 'Unknown status' },
    { status: 'pending', content: 7 }, { status: 'completed' }]) {
    assert.equal(readCardMeta(snapshot([malformed, task('Must not skip malformed state')]), {}).get('a').activeTask, null);
  }
});

test('turn-start/reset snapshots drop previous active tasks without reading history or retaining metadata', () => {
  const byId = { a: row('a') };
  const workspaces = { items: [{ title: 'Current workspace', sessionIds: ['a'] }] };
  const first = readCardMeta({ byId, projectionsBySession: { a: projection([task('Earlier turn')]) } }, workspaces);
  assert.equal(first.get('a').activeTask, 'Earlier turn');
  for (const projectionsBySession of [undefined, {}, { a: { values: {} } }, { a: projection(null) }]) {
    assert.deepEqual(readCardMeta({ byId, projectionsBySession }, workspaces).get('a'), {
      workspaceId: null, workspaceTitle: 'Current workspace', activeTask: null,
    });
  }
  assert.equal(first.get('a').activeTask, 'Earlier turn');
});

test('missing or malformed sessions produce no default candidates and null explicit-candidate metadata', () => {
  const workspaces = { items: [{ title: 'Stale workspace', sessionIds: ['a'] }] };
  for (const malformed of [undefined, null, [], {}, { byId: null }, { byId: [] }, { byId: 1 }, { byId: 'a' }]) {
    assert.deepEqual(readCardMeta(malformed, workspaces), new Map());
    assert.deepEqual(readCardMeta(malformed, workspaces, ['a']), new Map([['a', noMeta()]]));
  }
  for (const missingRow of [undefined, null, [], 'bad', 42]) {
    const sessions = { byId: { a: missingRow }, projectionsBySession: { a: projection([task('Stale task')]) } };
    assert.deepEqual(readCardMeta(sessions, workspaces).get('a'), noMeta());
  }
});

test('inherited session/projection dictionary entries do not create metadata for unknown ids', () => {
  const byId = Object.assign(Object.create({ inherited: row('inherited') }), { a: row('a') });
  const projectionsBySession = Object.create({ a: projection([task('Inherited task')]) });
  const sessions = { byId, projectionsBySession };
  const workspaces = { items: [{ title: 'Known workspace', sessionIds: ['a', 'inherited', 'toString'] }] };
  assert.deepEqual(readCardMeta(sessions, workspaces, ['a', 'inherited', 'toString']), new Map([
    ['a', { workspaceId: null, workspaceTitle: 'Known workspace', activeTask: null }],
    ['inherited', noMeta()], ['toString', noMeta()],
  ]));
  assert.deepEqual([...readCardMeta(sessions, workspaces).keys()], ['a']);
});

test('deeply frozen inputs stay unchanged and result mutations do not affect future reads', () => {
  const sessions = deepFreeze(snapshot([task(' Pending ', 'pending'), task(' Active '), task(' Later ')]));
  const workspaces = deepFreeze({ items: [{ title: ' Workspace ', path: 'C:\\project', sessionIds: ['a'] }] });
  const ids = deepFreeze(['a', 'missing']);
  const before = JSON.stringify({ sessions, workspaces, ids });
  const result = readCardMeta(sessions, workspaces, ids);
  assert.deepEqual(result, new Map([
    ['a', { workspaceId: null, workspaceTitle: 'Workspace', activeTask: 'Active' }], ['missing', noMeta()],
  ]));
  result.get('a').workspaceTitle = 'Changed result'; result.get('a').activeTask = 'Changed result';
  result.get('missing').activeTask = 'Unrelated result'; result.delete('a');
  assert.equal(JSON.stringify({ sessions, workspaces, ids }), before);
  assert.deepEqual(readCardMeta(sessions, workspaces, ids).get('a'), { workspaceId: null, workspaceTitle: 'Workspace', activeTask: 'Active' });
  assert.deepEqual(readCardMeta(sessions, workspaces, ids).get('missing'), noMeta());
});

test('task extraction stops at the first active item without copying or traversing the remaining TODO list', () => {
  const todos = new Proxy([task('Pending', 'pending'), task('Active'), task('Unneeded')], {
    get(target, key, receiver) {
      if (key === '2') throw new Error('remaining TODO list was copied/traversed');
      return Reflect.get(target, key, receiver);
    },
  });
  assert.equal(readCardMeta(snapshot(todos), {}).get('a').activeTask, 'Active');
});

test('nonarray explicit ids fail closed instead of expanding a malformed candidate list', () => {
  for (const ids of [null, {}, 'a', 42, false]) assert.deepEqual(readCardMeta(snapshot(), {}, ids), new Map());
});
