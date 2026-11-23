import test from 'node:test';
import assert from 'node:assert/strict';
import { bindKeys, isSwitchKey, readPinned, readCandidates, currentSession } from '../src/adapter.js';
class Target {
  listeners = new Map();
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  emit(type, patch = {}) { const event = { key: '', code: '', ctrlKey: true, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...patch }; for (const fn of this.listeners.get(type) ?? []) fn(event); return event; }
}
function fixture() {
  const target = new Target(), document = new Target();
  let cycle = false, enabled = true, modal = false;
  const calls = [];
  document.querySelector = () => modal;
  const controller = { next(reverse) { calls.push(['next', reverse]); cycle = true; }, release() { calls.push(['release']); cycle = false; }, abort() { calls.push(['abort']); cycle = false; } };
  const dispose = bindKeys({target,document,controller,hasCycle:()=>cycle,enabled:()=>enabled});
  return {target,document,calls,dispose,enable:value=>enabled=value,modal:value=>modal=value};
}
test('only clean Ctrl+Tab is captured, including reverse', () => {
  assert.equal(isSwitchKey({key:'Tab',ctrlKey:true}),true);
  for(const field of ['altKey','metaKey','isComposing']) assert.equal(isSwitchKey({key:'Tab',ctrlKey:true,[field]:true}),false);
  assert.equal(isSwitchKey({key:'Tab',ctrlKey:false}),false);
  const f=fixture();const e=f.target.emit('keydown',{key:'Tab',shiftKey:true});
  assert.deepEqual(f.calls,[['next',true]]);assert.equal(e.prevented,true);assert.equal(e.stopped,true);f.dispose();
});
test('repeat is suppressed and Control release commits once',()=>{
  const f=fixture();f.target.emit('keydown',{key:'Tab',shiftKey:false});f.target.emit('keydown',{key:'Tab',repeat:true});
  f.target.emit('keyup',{key:'Tab'});assert.deepEqual(f.calls,[['next',false]]);
  f.target.emit('keyup',{key:'Control',ctrlKey:false});f.target.emit('keyup',{key:'Control',ctrlKey:false});assert.deepEqual(f.calls,[['next',false],['release']]);f.dispose();
});
test('Escape, focus loss, hidden page and cleanup cancel without commit',()=>{
  for(const mode of ['escape','blur','hidden','dispose']) {const f=fixture();f.target.emit('keydown',{key:'Tab'}); if(mode==='escape')f.target.emit('keydown',{key:'Escape'});if(mode==='blur')f.target.emit('blur');if(mode==='hidden'){f.document.visibilityState='hidden';f.document.emit('visibilitychange');}if(mode==='dispose')f.dispose();assert.equal(f.calls.filter(x=>x[0]==='release').length,0);assert.equal(f.calls.at(-1)[0],'abort');if(mode!=='dispose')f.dispose();}
});
test('disabled or an existing modal leaves shortcut untouched',()=>{
  const f=fixture();f.enable(false);assert.equal(f.target.emit('keydown',{key:'Tab'}).prevented,undefined);f.enable(true);f.modal(true);assert.equal(f.target.emit('keydown',{key:'Tab'}).prevented,undefined);assert.deepEqual(f.calls,[]);f.dispose();
});
test('one released Control does not commit while the other remains held',()=>{
  const f=fixture();f.target.emit('keydown',{key:'Tab'});f.target.emit('keyup',{key:'Control',ctrlKey:true});assert.equal(f.calls.length,1);f.target.emit('keyup',{key:'Control',ctrlKey:false});assert.equal(f.calls.at(-1)[0],'release');f.dispose();
});
test('Enter provides an explicit commit fallback',()=>{const f=fixture();f.target.emit('keydown',{key:'Tab'});f.target.emit('keydown',{key:'Enter'});assert.equal(f.calls.at(-1)[0],'release');f.dispose();});
test('cleanup removes every event listener',()=>{
  const f=fixture();f.dispose();assert.equal([...f.target.listeners.values(),...f.document.listeners.values()].reduce((n,s)=>n+s.size,0),0);
});
test('catalog adapter uses pinned registry, excludes archived and never retains sessions',()=>{
  const sessions={list:{getSnapshot:()=>({ids:['a','b','c','d'],byId:{a:{id:'a'},b:{id:'b',retainedBy:{mainView:1}},c:{id:'c'},d:{id:'d'}}})}};
  const workspaces={list:{getSnapshot:()=>({pinnedSessionIds:['c','b','unknown'],archivedSessionIds:['c']})}};
  assert.deepEqual(readPinned(sessions,workspaces).map(x=>[x.id,x.pinned]),[['b',true]]);assert.equal(currentSession(sessions),'b');
});

function catalog(rows, pins = [], archived = []) {
  const list = { ids: Object.keys(rows), byId: rows };
  const workspace = { pinnedSessionIds: pins, archivedSessionIds: archived };
  // Deliberately supply only read APIs: candidate enumeration cannot retain,
  // acknowledge, restore, answer, or fetch a session.
  return { list, workspace,
    sessions: { list: { getSnapshot: () => list } },
    workspaces: { list: { getSnapshot: () => workspace } } };
}
const candidateIds = (f, status, attention) => readCandidates(f.sessions, f.workspaces, status, attention).map(x => x.id);

test('candidate union dedupes pins/activity/attention and keeps real metadata and pin flags', () => {
  const rows = Object.fromEntries(['p', 'both', 'row', 'status', 'pending', 'unread', 'notice', 'done', 'idle'].map(id => [id, Object.freeze({ id, title: id })]));
  rows.row = Object.freeze({ ...rows.row, running: true });
  rows.both = Object.freeze({ ...rows.both, running: true });
  const f = catalog(rows, ['both', 'p', 'both', 'unknown']);
  const statuses = new Map([
    ['status', { running: true }], ['pending', { pendingInteraction: { kind: 'approval', answerable: true } }],
    ['unread', { completionUnread: true }], ['unknown-status', { running: true }],
  ]);
  const attention = new Map([['both', { kind: 'attention' }], ['notice', { kind: 'attention', reminderActive: false }], ['done', { kind: 'completion' }], ['unknown-notice', { kind: 'completion' }]]);
  const items = readCandidates(f.sessions, f.workspaces, statuses, attention);
  assert.deepEqual(items.map(x => x.id), ['both', 'p', 'row', 'status', 'pending', 'unread', 'notice', 'done']);
  for (const item of items) {
    assert.equal(item.eligible, true);
    assert.equal(item.pinned, ['both', 'p'].includes(item.id));
    assert.equal(item.title, rows[item.id].title);
    assert.notEqual(item, rows[item.id]);
    assert.equal(rows[item.id].eligible, undefined);
  }
  assert.deepEqual(candidateIds(f), ['both', 'p', 'row']);
});

test('candidate enumeration requires current metadata, not stale IDs, status, or bridge notices', () => {
  const f = catalog({ a: { id: 'a', running: true }, b: { id: 'b' } }, ['a', 'missing']);
  const status = new Map([['a', { running: true }], ['missing', { completionUnread: true }]]);
  const attention = new Map([['a', { kind: 'question' }], ['missing', { kind: 'approval' }]]);
  assert.deepEqual(candidateIds(f, status, attention), ['a']);
  delete f.list.byId.a;
  assert.deepEqual(candidateIds(f, status, attention), []);
});

test('row running or status running independently qualifies; clearing the last reason removes a chat', () => {
  const f = catalog({ a: { id: 'a', running: true } }, ['a']);
  const status = new Map([['a', { running: false }]]);
  f.workspace.pinnedSessionIds = [];
  assert.deepEqual(candidateIds(f, status), ['a']);
  f.list.byId.a.running = false;
  status.set('a', { running: true });
  assert.deepEqual(candidateIds(f, status), ['a']);
  status.clear();
  assert.deepEqual(candidateIds(f, status), []);
  status.set('a', { completionUnread: true });
  assert.deepEqual(candidateIds(f, status), ['a']);
  status.set('a', { completionUnread: false });
  assert.deepEqual(candidateIds(f, status), []);
  const attention = new Map([['a', { kind: 'completion', reminderActive: false }]]);
  assert.deepEqual(candidateIds(f, status, attention), ['a']);
  attention.clear();
  assert.deepEqual(candidateIds(f, status, attention), []);
});

test('only live manual pending interactions qualify; nested snapshots are read afresh without mutations', () => {
  const f = catalog({ a: { id: 'a' } });
  let snapshot = { closed: false, channel: 'rpc' };
  const forbidden = () => assert.fail('interaction mutation or subscription during enumeration');
  const request = { kind: 'question', getSnapshot: () => snapshot, subscribe: forbidden, answer: forbidden, dismiss: forbidden };
  const status = new Map([['a', { pendingInteraction: request }]]);
  assert.deepEqual(candidateIds(f, status), ['a']);
  for (const patch of [{ closed: true, channel: 'rpc' }, { closed: false, channel: 'local' }, { channel: 'rpc' }]) {
    snapshot = patch;
    assert.deepEqual(candidateIds(f, status), []);
  }
  snapshot = { closed: false, channel: 'waterfall' };
  request.kind = 'plan-review';
  assert.deepEqual(candidateIds(f, status), ['a']);
  request.review = {};
  assert.deepEqual(candidateIds(f, status), []);
  for (const request of [{ kind: 'approval', answerable: true }, { kind: 'approval', answerable: false }, { kind: 'question' }, { kind: 'unsupported', answerable: true }]) {
    status.set('a', { pendingInteraction: request });
    assert.deepEqual(candidateIds(f, status), request.answerable === true && request.kind === 'approval' ? ['a'] : []);
  }
});

test('all bridge notice kinds qualify without sound reminders; unknown or absent notices do not', () => {
  const f = catalog({ a: { id: 'a' } });
  for (const kind of ['approval', 'question', 'plan-review', 'attention', 'completion']) {
    assert.deepEqual(candidateIds(f, new Map(), new Map([['a', { kind, reminderActive: false }]])), ['a']);
  }
  for (const notice of [null, {}, { kind: 'unknown' }]) {
    assert.deepEqual(candidateIds(f, new Map(), new Map([['a', notice]])), []);
  }
});

test('archives are never candidates even when pinned, running, unread, or requiring attention', () => {
  const f = catalog({ a: { id: 'a', running: true }, b: { id: 'b' } }, ['a', 'b'], ['a']);
  const status = new Map([['a', { running: true, completionUnread: true, pendingInteraction: { kind: 'approval', answerable: true } }]]);
  const attention = new Map([['a', { kind: 'attention' }]]);
  assert.deepEqual(candidateIds(f, status, attention), ['b']);
  assert.deepEqual(f.workspace.archivedSessionIds, ['a']);
  // Eligibility changes only after an external explicit restore; no mutation here.
  f.workspace.archivedSessionIds = [];
  assert.deepEqual(candidateIds(f, status, attention), ['a', 'b']);
});

test('only the explicitly current valid main chat is included while idle and unpinned', () => {
  const f=catalog({current:{id:'current'},other:{id:'other'},child:{id:'child',parentId:'current'},archived:{id:'archived'}},[],['archived']);
  const ids=currentId=>readCandidates(f.sessions,f.workspaces,new Map(),new Map(),currentId).map(x=>x.id);
  assert.deepEqual(ids('current'),['current']);assert.deepEqual(ids(null),[]);assert.deepEqual(ids('missing'),[]);
  assert.deepEqual(ids('child'),[]);assert.deepEqual(ids('archived'),[]);
  const recent=new Set(['other','child','archived','missing']);
  assert.deepEqual(readCandidates(f.sessions,f.workspaces,new Map(),new Map(),'current',recent).map(x=>x.id),['current','other']);
  assert.equal(recent.size,4,'eligibility does not mutate the recency witness');
});
