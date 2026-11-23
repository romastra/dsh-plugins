import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { readCandidates, readPinned } from '../src/adapter.js';
import { chatIndicator } from '../src/status.js';

function fixture() {
  const rows = Object.fromEntries(Array.from({ length: 500 }, (_, i) => ['idle-' + i, { id: 'idle-' + i, running: false, retainedBy: { mainView: i === 0 ? 1 : 0 } }]));
  for (const id of ['pin', 'run', 'unread', 'done', 'failed', 'question', 'archived']) rows[id] = { id };
  const statuses = new Map(Object.keys(rows).map(id => [id, { running: false, completionUnread: false }]));
  statuses.set('run', { running: true });
  statuses.set('unread', { completionUnread: true });
  statuses.set('question', { pendingInteraction: { kind: 'question', getSnapshot: () => ({ closed: false, channel: 'rpc' }) } });
  const attention = new Map([['done', { kind: 'completion', reminderActive: false }], ['failed', { kind: 'attention', reason: 'error', reminderActive: false }], ['archived', { kind: 'completion' }]]);
  rows['child-run'] = { id: 'child-run', parentId: 'run', running: true };
  rows['child-done'] = { id: 'child-done', origin: 'subagent' };
  rows['child-pin'] = { id: 'child-pin', origin: 'subagent', parentId: 'pin' };
  attention.set('child-done', { kind: 'completion', reminderActive: false });
  return { rows, statuses, attention,
    sessions: { list: { getSnapshot: () => ({ ids: Object.keys(rows), byId: rows }), subscribe: () => () => {} } },
    workspaces: { list: { getSnapshot: () => ({ pinnedSessionIds: ['pin', 'archived', 'child-pin'], archivedSessionIds: ['archived'] }), subscribe: () => () => {} } } };
}
const expected = ['pin', 'run', 'unread', 'done', 'failed', 'question'];

test('a large catalog is not the switcher selection: only pins, activity and attention', () => {
  const f = fixture();
  const items = readCandidates(f.sessions, f.workspaces, f.statuses, f.attention);
  assert.deepEqual(items.map(x => x.id), expected);
  assert.ok(items.every(x => x.pinned || chatIndicator(x, f.statuses.get(x.id), f.attention.get(x.id)).kind !== 'idle'));
});

test('subagents never qualify, even pinned, running, unread or awaiting input', () => {
  for (const metadata of [{ origin: 'subagent' }, { parentId: 'parent' }, { origin: 'subagent', parentId: 'missing-parent' }]) {
    for (const reason of ['pin', 'running', 'unread', 'pending', 'done', 'failed']) {
      const row = { id: 'child', ...metadata };
      const status = { running: reason === 'running', completionUnread: reason === 'unread', pendingInteraction: reason === 'pending' ? { kind: 'approval', answerable: true } : undefined };
      const attention = new Map(reason === 'done' ? [['child', { kind: 'completion' }]] : reason === 'failed' ? [['child', { kind: 'attention', reason: 'error' }]] : []);
      // Projected children can exist in byId without appearing in the root ids.
      const sessions = { list: { getSnapshot: () => ({ ids: [], byId: { child: row } }) } };
      const workspaces = { list: { getSnapshot: () => ({ pinnedSessionIds: reason === 'pin' ? ['child'] : [] }) } };
      assert.deepEqual(readCandidates(sessions, workspaces, new Map([['child', status]]), attention), [], reason);
      assert.deepEqual(readPinned(sessions, workspaces), []);
    }
  }
});

test('root chats with absent or null parent metadata retain the existing eligibility rules', () => {
  for (const metadata of [{}, { parentId: null }, { origin: 'user' }, { origin: 'cli', parentId: null }]) {
    const row = { id: 'root', ...metadata };
    const sessions = { list: { getSnapshot: () => ({ ids: ['root'], byId: { root: row } }) } };
    const workspaces = { list: { getSnapshot: () => ({ pinnedSessionIds: [] }) } };
    assert.deepEqual(readCandidates(sessions, workspaces), []);
    for (const status of [{ running: true }, { completionUnread: true }, { pendingInteraction: { kind: 'approval', answerable: true } }]) {
      assert.deepEqual(readCandidates(sessions, workspaces, new Map([['root', status]])).map(x => x.id), ['root']);
    }
    workspaces.list.getSnapshot = () => ({ pinnedSessionIds: ['root'] });
    assert.deepEqual(readCandidates(sessions, workspaces).map(x => x.id), ['root']);
    assert.deepEqual(readPinned(sessions, workspaces).map(x => x.id), ['root']);
  }
});

test('row-only unread qualifies, historical status labels and retention do not', () => {
  const f = fixture();
  f.rows['idle-1'].completionUnread = true;
  f.rows['idle-2'].status = 'done';
  f.rows['idle-3'].running = 'true';
  f.statuses.set('idle-4', { kind: 'completion', status: 'done' });
  f.attention.set('idle-5', { kind: 'idle', reminderActive: true });
  const ids = readCandidates(f.sessions, f.workspaces, f.statuses, f.attention).map(x => x.id);
  assert.deepEqual(ids, ['pin', 'idle-1', ...expected.slice(1)]);
});

test('disposed interactions cannot abort filtering or admit idle chats', () => {
  const f = fixture();
  f.statuses.set('idle-0', { pendingInteraction: { kind: 'question', getSnapshot() { throw new Error('disposed'); } } });
  f.statuses.set('idle-1', { pendingInteraction: { kind: 'approval', get answerable() { throw new Error('disposed'); } } });
  assert.deepEqual(readCandidates(f.sessions, f.workspaces, f.statuses, f.attention).map(x => x.id), expected);
});

test('installed standalone bundle filters a full catalog and never revives idle MRU entries', () => {
  const f = fixture();
  const slots = [], cleanups = [];
  let plugin;
  const window = new EventTarget();
  window.localStorage = { getItem: () => JSON.stringify(['child-run', 'child-done', 'child-pin', 'idle-0', 'idle-1', 'done', 'run']), setItem() {} };
  window.__DSH_SOUND_ATTENTION__ = { getSnapshot: () => f.attention, subscribe: () => () => {} };
  window.__ModuleLoader__ = { load: ({ factory }) => { plugin = factory(() => ({ createElement() {} })); } };
  const document = new EventTarget();
  document.documentElement = { dataset: { platform: 'win32' } };
  document.querySelector = () => null;
  Object.assign(document, { body: {}, head: { appendChild() {} }, createElement: () => ({ remove() {} }) });
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  vm.runInNewContext(readFileSync(new URL('../' + manifest.exports['./client'].replace(/^\.\//, ''), import.meta.url), 'utf8'), { window, document, TextEncoder, queueMicrotask, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {} });
  const form = { getSnapshot: () => ({ value: { enabled: true, delayMs: 250 } }), subscribe: () => () => {} };
  plugin.apply({
    sessions: f.sessions, workspaces: f.workspaces,
    uiSession: { sessionStatus: { getSnapshot: () => f.statuses, subscribe: () => () => {} } },
    uiWorkspace: { openSession() { assert.fail('enumeration must not navigate'); } },
    layout: {}, locale: { register: () => () => {} }, configForms: { get: () => form },
    effect(fn) { const off = fn(); if (off) cleanups.push(off); },
    slots: { inject: (_, fn) => fn(), register(options) { slots.push(options); return () => {}; } },
  });
  try {
    const source = slots.find(x => x.name === 'shell.overlay').inject().source;
    const ids = Array.from(source.getSnapshot().items, x => x.id);
    assert.deepEqual(ids, ['idle-0', 'question', 'failed', 'done', 'run', 'pin', 'unread']);
    assert.deepEqual(ids.filter(id => id.startsWith('idle-')), ['idle-0'], 'only the actual current chat may be an unpinned idle candidate');
    const event = new Event('keydown', { cancelable: true });
    Object.assign(event, { key: 'Tab', ctrlKey: true });
    window.dispatchEvent(event);
    assert.deepEqual(Array.from(source.getSnapshot().cycle.items, x => x.id), ids);
  } finally { for (const off of cleanups.reverse()) off(); }
});
