import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlugin } from '../src/client.js';
import { getMosaicDataUrl } from '../src/mosaic.js';
function store(value) { const listeners=new Set();return {getSnapshot:()=>value,subscribe:fn=>{listeners.add(fn);return ()=>listeners.delete(fn);},set(next){value=next;for(const fn of [...listeners])fn();}}; }
function setup(t, { rpc, contextMenus } = {}) {
  const savedWindow=globalThis.window,savedDocument=globalThis.document;
  const target=new EventTarget(),document=new EventTarget(),storage=new Map();
  Object.assign(target,{localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)}});
  Object.assign(document,{documentElement:{dataset:{platform:'win32'}},querySelector:()=>null,body:{},head:{appendChild(){}},createElement:()=>({remove(){}})});
  globalThis.window=target;globalThis.document=document;
  const sessions=store({ids:['a','b','c'],byId:{a:{id:'a',title:'A',retainedBy:{mainView:1}},b:{id:'b',title:'B',retainedBy:{}},c:{id:'c',title:'C',retainedBy:{}}}});
  const workspaces=store({pinnedSessionIds:['a','b','c'],archivedSessionIds:[]});
  const form=store({status:'ready',writable:true,value:{enabled:true,delayMs:250},revision:1});
  const status=store(new Map()),definitions=[],slots=[],cleanups=[],opens=[],newSessions=[];
  const ctx={contextMenus,connection:rpc?{rpc}:undefined,effect:fn=>{const cleanup=fn();if(cleanup)cleanups.push(cleanup);},locale:{register:()=>()=>{},bind:()=>key=>key},configForms:{get:()=>form},sessions:{list:sessions},workspaces:{list:workspaces},uiSession:{sessionStatus:status},layout:{},shortcuts:{runtime:'desktop',platform:'windows',register:def=>{definitions.push(def);return ()=>{};}},uiWorkspace:{startSession(...args){newSessions.push(args);},openSession(id){opens.push(id);const list=sessions.getSnapshot();sessions.set({...list,byId:Object.fromEntries(Object.entries(list.byId).map(([key,row])=>[key,{...row,retainedBy:{mainView:key===id?1:0}}]))});}},slots:{inject:(_name,fn)=>fn(),register:(options,component)=>{slots.push({options,component});return ()=>{};}}};
  const inspectProviders=[];
  ctx.inject=(names, callback)=>{if(names[0]==='workspaceColorSource'){assert.deepEqual(names,['workspaceColorSource']);return;}assert.deepEqual(names,['cordisInspect']);callback({effect:ctx.effect,get:()=>({register:provider=>{inspectProviders.push(provider);return ()=>{};}})});};
  const React={createElement:(type,props,...children)=>({type,props,children}),useSyncExternalStore:(_subscribe,get)=>get(),useRef:()=>({current:null}),useMemo:fn=>fn(),useState:initial=>[typeof initial==='function'?initial():initial,()=>{}],useLayoutEffect:()=>{}};
  let now=0,serial=0;const timers=new Map();
  const originalSet=globalThis.setTimeout,originalClear=globalThis.clearTimeout,originalInterval=globalThis.setInterval,polls=[];
  globalThis.setInterval=(fn,ms)=>{polls.push(fn);return originalInterval(fn,ms);};
  globalThis.setTimeout=(fn,ms)=>{const id=++serial;timers.set(id,{fn,at:now+ms});return id;};globalThis.clearTimeout=id=>timers.delete(id);
  try { createPlugin(React).apply(ctx); } finally { globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;globalThis.setInterval=originalInterval; }
  const advance=ms=>{now+=ms;for(const [id,timer] of [...timers])if(timer.at<=now){timers.delete(id);timer.fn();}};
  const source=slots.find(x=>x.options.name==='shell.overlay').options.inject().source;
  t.after(()=>{for(const cleanup of cleanups.reverse())cleanup();globalThis.window=savedWindow;globalThis.document=savedDocument;});
  const next=(reverse=false)=>{const event=new Event('keydown',{cancelable:true});Object.assign(event,{key:'Tab',code:'Tab',ctrlKey:true,shiftKey:reverse});target.dispatchEvent(event);};
  const release=()=>{const event=new Event('keyup',{cancelable:true});Object.assign(event,{key:'Control',ctrlKey:false});target.dispatchEvent(event);};
  const render=()=>{const entry=slots.find(x=>x.options.name==='shell.overlay');return entry.component({...entry.options.inject(),t:key=>key});};
  return {source,next,release,sessions,workspaces,form,opens,newSessions,target,document,status,slots,advance,render,definitions,timers,inspectProviders,React,poll:()=>polls.forEach(fn=>fn())};
}
test('plugin wires ordered DOM events without native IPC commands, settings, overlay and badge',t=>{
  const f=setup(t);assert.deepEqual(f.slots.filter(x=>x.options.name==='sidebar.session.row.trailing').map(x=>x.options.id),['chat-switcher']);assert.equal(f.slots.some(x=>x.options.name==='settings.general.item'),true);assert.equal(f.source.getSnapshot().items.length,3);assert.equal(f.definitions.length,0);
});
test('real adapter/controller wiring alternates quickly without history fetch or opening previews',t=>{
  const f=setup(t);f.next();assert.equal(f.source.getSnapshot().cycle.items[f.source.getSnapshot().cycle.index].id,'b');assert.deepEqual(f.opens,[]);f.release();assert.deepEqual(f.opens,['b']);f.next();assert.deepEqual(f.source.getSnapshot().cycle.items.map(x=>x.id),['b','a','c']);f.release();assert.deepEqual(f.opens,['b','a']);
});
test('unpin and external navigation reconcile or cancel a held cycle',t=>{
  const f=setup(t);f.next();f.workspaces.set({pinnedSessionIds:['a','c'],archivedSessionIds:[]});assert.equal(f.source.getSnapshot().cycle.items.some(x=>x.id==='b'),false);f.release();assert.deepEqual(f.opens,['c']);f.next();const list=f.sessions.getSnapshot();f.sessions.set({...list,byId:{...list.byId,c:{...list.byId.c,retainedBy:{}},a:{...list.byId.a,retainedBy:{mainView:1}}}});assert.equal(f.source.getSnapshot().cycle,null);
});
test('late bridge, replacements and removal replace attention without acknowledgement',t=>{
  const f=setup(t),attention=store(new Map([['b',{kind:'question',reminderActive:true}]]));f.target.__DSH_SOUND_ATTENTION__=attention;f.target.dispatchEvent(new Event('dsh:sound-attention-changed'));assert.equal(f.source.getSnapshot().attention.get('b').kind,'question');f.next();f.release();assert.equal(attention.getSnapshot().has('b'),true);delete f.target.__DSH_SOUND_ATTENTION__;f.target.dispatchEvent(new Event('dsh:sound-attention-changed'));assert.equal(f.source.getSnapshot().attention.size,0);assert.equal(f.source.getSnapshot().bridge,false);
});
function countDialogs(tree) {
  if (!tree || typeof tree !== 'object') return 0;
  if (Array.isArray(tree)) return tree.reduce((n,node)=>n+countDialogs(node),0);
  return Number(tree.type==='dialog') + countDialogs(tree.children);
}
test('quick DOM tap switches on Control release and never mounts a modal',t=>{
  const f=setup(t);assert.equal(countDialogs(f.render()),0);f.next();f.advance(100);
  assert.equal(countDialogs(f.render()),0);assert.deepEqual(f.opens,[]);f.release();
  assert.deepEqual(f.opens,['b']);assert.equal(f.timers.size,0);f.advance(1000);assert.equal(countDialogs(f.render()),0);
  f.next();f.release();assert.deepEqual(f.opens,['b','a']);
});
test('modal is absent at 249ms, mounted at 250ms, and Control release selects its cursor',t=>{
  const f=setup(t);f.next();f.advance(249);assert.equal(countDialogs(f.render()),0);
  f.advance(1);assert.equal(countDialogs(f.render()),1);assert.deepEqual(f.opens,[]);
  f.next();assert.equal(f.source.getSnapshot().cycle.items[f.source.getSnapshot().cycle.index].id,'c');f.release();
  assert.deepEqual(f.opens,['c']);assert.equal(countDialogs(f.render()),0);assert.equal(f.timers.size,0);
});
test('switcher modal has no keyboard instruction subtitle',t=>{
  const f=setup(t);f.next();f.advance(250);
  const strings=[];const walk=node=>{if(typeof node==='string')strings.push(node);else if(Array.isArray(node))node.forEach(walk);else if(node&&typeof node==='object')walk(node.children);};
  const tree=materialize(f.render());walk(tree);assert.ok(nodes(tree,x=>x.props?.['aria-label']==='pinned').length);assert.equal(strings.includes('hint'),false);f.release();
});
test('configured delay is honored by actual keyboard-to-overlay wiring',t=>{
  const f=setup(t);f.form.set({status:'ready',writable:true,value:{enabled:true,delayMs:650},revision:2});
  f.next();f.advance(250);assert.equal(countDialogs(f.render()),0);f.advance(399);assert.equal(countDialogs(f.render()),0);f.advance(1);assert.equal(countDialogs(f.render()),1);f.release();assert.deepEqual(f.opens,['b']);
});
test('Control release before any switch key cannot leave a delayed IPC cycle',t=>{
  const f=setup(t);f.release();f.advance(1000);assert.equal(f.source.getSnapshot().cycle,null);assert.equal(f.definitions.length,0);assert.equal(countDialogs(f.render()),0);assert.deepEqual(f.opens,[]);
});
test('nonpinned active, unread and silent attention sessions join and leave the live candidate set',t=>{
  const f=setup(t);f.workspaces.set({pinnedSessionIds:['a'],archivedSessionIds:[]});
  f.status.set(new Map([['b',{running:true}],['c',{completionUnread:true}]]));
  assert.deepEqual(f.source.getSnapshot().items.map(x=>x.id),['a','b','c']);
  f.status.set(new Map());assert.deepEqual(f.source.getSnapshot().items.map(x=>x.id),['a']);
  const notices=store(new Map([['c',{kind:'completion',reminderActive:false}]]));
  f.target.__DSH_SOUND_ATTENTION__=notices;f.target.dispatchEvent(new Event('dsh:sound-attention-changed'));
  assert.deepEqual(f.source.getSnapshot().items.map(x=>x.id),['a','c']);
  f.next();f.release();assert.deepEqual(f.opens,['c']);assert.equal(notices.getSnapshot().has('c'),true);
  notices.set(new Map());assert.deepEqual(f.source.getSnapshot().items.map(x=>x.id),['c','a'],'the current chat remains rank zero after its completion notice clears');
});
test('unpinned running chats support genuine two-tap MRU alternation',t=>{
  const f=setup(t);f.workspaces.set({pinnedSessionIds:[],archivedSessionIds:[]});
  f.status.set(new Map([['a',{running:true}],['b',{running:true}]]));
  f.next();f.release();f.next();f.release();assert.deepEqual(f.opens,['b','a']);
});
test('closing a nested question reconciles candidates without replacing root status',t=>{
  const f=setup(t),question=store({closed:false,channel:'rpc'});question.kind='question';
  f.workspaces.set({pinnedSessionIds:['a'],archivedSessionIds:[]});
  f.status.set(new Map([['b',{pendingInteraction:question}]]));
  assert.equal(f.source.getSnapshot().items.some(x=>x.id==='b'),true);f.next();
  question.set({closed:true,channel:'rpc'});assert.equal(f.source.getSnapshot().items.some(x=>x.id==='b'),false);
  assert.equal(f.source.getSnapshot().cycle.items.some(x=>x.id==='b'),false);f.release();assert.deepEqual(f.opens,['a']);
});
test('approval getter changes refresh membership using lightweight observation without granting access',t=>{
  const f=setup(t);let answerable=true;const approval={kind:'approval',get answerable(){return answerable},answer(){assert.fail('must not answer')}};
  f.workspaces.set({pinnedSessionIds:['a'],archivedSessionIds:[]});f.status.set(new Map([['b',{pendingInteraction:approval}]]));
  assert.equal(f.source.getSnapshot().items.some(x=>x.id==='b'),true);answerable=false;f.poll();
  assert.equal(f.source.getSnapshot().items.some(x=>x.id==='b'),false);
});
function materialize(tree){
  if(Array.isArray(tree))return tree.map(materialize);
  if(!tree||typeof tree!=='object')return tree;
  if(typeof tree.type==='function')return materialize(tree.type(tree.props));
  return {...tree,children:materialize(tree.children)};
}
function nodes(tree,predicate){
  if(Array.isArray(tree))return tree.flatMap(x=>nodes(x,predicate));
  if(!tree||typeof tree!=='object')return [];
  return [...(predicate(tree)?[tree]:[]),...nodes(tree.children,predicate)];
}
test('mosaics appear only with delayed previews and verified Done uses a green-dot state in cards and sidebar',t=>{
  const f=setup(t),notices=store(new Map([['b',{kind:'completion',reminderActive:false}]]));
  f.target.__DSH_SOUND_ATTENTION__=notices;f.target.dispatchEvent(new Event('dsh:sound-attention-changed'));
  assert.equal(nodes(materialize(f.render()),x=>x.type==='img').length,0);f.next();f.advance(249);
  assert.equal(nodes(materialize(f.render()),x=>x.type==='img').length,0);f.advance(1);
  const tree=materialize(f.render()),images=nodes(tree,x=>x.props?.className==='cs-mosaic');
  assert.equal(images.length,3);assert.equal(images.every(x=>x.props.src.startsWith('data:image/svg+xml;')),true);
  const dots=nodes(tree,x=>x.props?.className==='cs-status-dot');assert.equal(dots.some(x=>x.props['data-state']==='completion'),true);
  const row=f.slots.find(x=>x.options.name==='sidebar.session.row.trailing');
  const badge=materialize(row.component({...row.options.inject(),sessionId:'b',t:x=>x}));
  assert.equal(nodes(badge,x=>x.props?.className==='cs-status-dot')[0].props['data-state'],'completion');
  f.release();assert.equal(notices.getSnapshot().has('b'),true);
});
test('status churn never adds or reorders a frozen cycle; cleared unpinned targets are removed',t=>{
  const f=setup(t);f.workspaces.set({pinnedSessionIds:['a'],archivedSessionIds:[]});f.status.set(new Map([['b',{running:true}]]));
  f.next();f.status.set(new Map([['b',{running:true}],['c',{running:true}]]));
  assert.deepEqual(f.source.getSnapshot().cycle.items.map(x=>x.id),['a','b']);
  f.status.set(new Map([['c',{running:true}]]));f.release();assert.deepEqual(f.opens,['a']);
});
test('composer identity uses its own scoped session and mounts only a style, never a replacement action',t=>{
  const f=setup(t);
  const slot=f.slots.find(x=>x.options.name==='conversation.input.overlay');
  assert.ok(slot);
  const render=sessionId=>materialize(slot.component({...slot.options.inject(),sessionId}));
  assert.equal(render(undefined),null);
  const a=render('a'),b=render('b');
  assert.equal(a.type,'style');assert.equal(a.props['data-cs-composer-image'],'a');
  assert.notEqual(a.children[0],b.children[0],'mirrored/child composers get their own image');
  assert.deepEqual(f.opens,[]);assert.equal(f.source.getSnapshot().cycle,null);
  assert.equal(nodes(a,x=>x.type==='button').length,0,'native actions are never reimplemented');
});
function hoverTree(f, sessionId) {
  const slot=f.slots.find(x=>x.options.name==='sidebar.session.row.hover');
  assert.ok(slot,'native Workspace hover slot registered');
  return materialize(slot.component({...slot.options.inject(),sessionId,t:x=>x}));
}
test('native hover and modal reuse the identical mosaic card without opening or acknowledging',t=>{
  const f=setup(t),notices=store(new Map([['b',{kind:'completion',reminderActive:false}]]));
  f.target.__DSH_SOUND_ATTENTION__=notices;f.target.dispatchEvent(new Event('dsh:sound-attention-changed'));
  const hover=hoverTree(f,'b');
  assert.equal(nodes(hover,x=>x.type==='img').length,1);
  assert.equal(nodes(hover,x=>x.props?.['data-state']==='completion').length>0,true);
  assert.deepEqual(f.opens,[]);assert.equal(f.source.getSnapshot().cycle,null);assert.equal(notices.getSnapshot().has('b'),true);
  f.next();f.advance(250);
  const modal=materialize(f.render());
  const card=nodes(modal,x=>x.props?.id==='cs-option-b')[0];
  for(const className of ['cs-mosaic','cs-title','cs-state']) assert.deepEqual(nodes(hover,x=>x.props?.className===className),nodes(card,x=>x.props?.className===className),'shared '+className);
  assert.equal(nodes(hover,x=>x.props?.className==='cs-folder'||x.props?.className==='cs-folder-icon').length,0,'no redundant workspace path in hover');
  assert.equal(nodes(card,x=>x.props?.className==='cs-folder'||x.props?.className==='cs-folder-icon').length,0,'modal no longer renders paths');
  assert.equal(nodes(card,x=>x.props?.className==='cs-workspace-name').length,1,'modal has a Workspace label above its image');
  assert.equal(nodes(card,x=>x.props?.className==='cs-badges').length,0,'below the image is only the chat title');
  assert.equal(nodes(card,x=>x.props?.className==='cs-preview-statuses').length,1);
  assert.equal(nodes(hover,x=>x.props?.className==='cs-mosaic-shade').length,0,'Workspace hover has no shade layer');
  assert.equal(nodes(card,x=>x.props?.className==='cs-mosaic-shade').length,1,'modal shading remains unchanged');
  assert.equal(hover.props.onClick,undefined);assert.equal(hover.props.role,undefined);
  f.target.dispatchEvent(new Event('blur'));
  assert.equal(notices.getSnapshot().has('b'),true);
});
test('modal regions show Workspace above image, first in-progress TODO inside, and only chat title below',t=>{
  const f=setup(t),list=f.sessions.getSnapshot();
  f.workspaces.set({pinnedSessionIds:['a','b','c'],archivedSessionIds:[],items:[{workspaceId:'w',title:'Project Alpha',path:'C:/private/workspace',sessionIds:['b']}]});
  f.sessions.set({...list,byId:{...list.byId,b:{...list.byId.b,cwd:'C:/private/cwd',goal:{objective:'GOAL SHOULD NOT APPEAR'}}},projectionsBySession:{b:{state:'idle',values:{goal:{objective:'ANOTHER GOAL'},todos:[{content:'Already done',status:'completed'},{content:'First actual task',status:'in_progress'},{content:'Parallel later task',status:'in_progress'}]}}}});
  chatPull(f).open();const tree=materialize(f.render()),card=nodes(tree,x=>x.props?.id==='cs-option-b')[0],regions=card.children.filter(x=>x&&typeof x==='object');
  assert.deepEqual(regions.map(x=>x.props?.className),['cs-workspace-name','cs-preview','cs-title']);assert.equal(regions[0].children[0],'Project Alpha');assert.equal(regions[2].children[0],'B');
  const image=regions[1],content=nodes(image,x=>x.props?.className==='cs-preview-content')[0];assert.equal(nodes(content,x=>x.props?.className==='cs-active-task')[0].children[0],'First actual task');assert.equal(content.children.at(-1).props.className,'cs-preview-statuses');assert.equal(nodes(card,x=>x.props?.className==='cs-badges').length,0);assert.equal(nodes(card,x=>x.props?.['aria-label']==='pinned').length,1);
  const serialized=JSON.stringify(card);for(const text of ['C:/private','GOAL SHOULD NOT APPEAR','ANOTHER GOAL','Already done','Parallel later task'])assert.equal(serialized.includes(text),false,text);
  const hover=hoverTree(f,'b');assert.equal(nodes(hover,x=>x.props?.className==='cs-workspace-name'||x.props?.className==='cs-active-task').length,0,'the requested layout applies only to the chooser');assert.deepEqual(f.opens,[]);
});
test('cached TODO changes update a frozen modal without navigation, pending/Goal fallback or history loading',t=>{
  const f=setup(t),before=f.sessions.getSnapshot();chatPull(f).open();const frozen=f.source.getSnapshot().cycle.items.map(x=>x.id);
  const show=todos=>{const current=f.sessions.getSnapshot();f.sessions.set({...current,projectionsBySession:{b:{state:'idle',values:{todos,goal:{objective:'Never the Goal'}}}}});return nodes(materialize(f.render()),x=>x.props?.id==='cs-option-b')[0];};
  let card=show([{content:'Pending is not a task in progress',status:'pending'},{content:'Working now',status:'in_progress'}]);assert.equal(nodes(card,x=>x.props?.className==='cs-active-task')[0].children[0],'Working now');
  card=show([{content:'Finished',status:'completed'},{content:'Next active',status:'in_progress'}]);assert.equal(nodes(card,x=>x.props?.className==='cs-active-task')[0].children[0],'Next active');
  for(const value of [null,undefined,[],[{content:'Only pending',status:'pending'}]])assert.equal(nodes(show(value),x=>x.props?.className==='cs-active-task').length,0);
  assert.deepEqual(f.source.getSnapshot().cycle.items.map(x=>x.id),frozen);assert.deepEqual(f.opens,[]);assert.equal(f.sessions.getSnapshot().byId,before.byId);
});
test('TODO fallback scroll controls stop card/grid bubbling only while overflowing',t=>{
  const f=setup(t),list=f.sessions.getSnapshot();f.sessions.set({...list,projectionsBySession:{b:{values:{todos:[{content:'A task',status:'in_progress'}]}}}});chatPull(f).open();
  const frame=nodes(materialize(f.render()),x=>x.props?.className==='cs-task-fit')[0];assert.ok(frame);
  for(const name of ['onPointerDown','onClick','onKeyDown'])for(const overflow of [false,true]){let stopped=false;frame.props[name]({currentTarget:{dataset:{taskOverflow:String(overflow)}},stopPropagation(){stopped=true;}});assert.equal(stopped,overflow,name);}
  assert.deepEqual(f.opens,[]);
});
test('empty TODO list renders the latest same-chat goal with the existing auto-fit style and updates live',t=>{
  const f=setup(t);chatPull(f).open();const frozen=f.source.getSnapshot().cycle.items.map(x=>x.id);
  const show=(todos,objective)=>{const list=f.sessions.getSnapshot();f.sessions.set({...list,projectionsBySession:{b:{state:'idle',values:{todos,goal:objective===null?null:{goal:{objective,phase:'complete'},roundsStarted:1,createdAt:1,updatedAt:2}}}}});const card=nodes(materialize(f.render()),x=>x.props?.id==='cs-option-b')[0];return nodes(card,x=>x.props?.className==='cs-active-task');};
  assert.equal(show([], 'Nearest retained goal')[0].children[0],'Nearest retained goal');
  assert.equal(show(null, 'New latest goal')[0].children[0],'New latest goal');
  assert.equal(show([{content:'Actual TODO',status:'in_progress'}], 'Lower priority goal')[0].children[0],'Actual TODO');
  assert.equal(show([{content:'Pending TODO',status:'pending'}], 'Do not replace a nonempty list').length,0);
  assert.equal(show([],null).length,0);assert.deepEqual(f.source.getSnapshot().cycle.items.map(x=>x.id),frozen);assert.deepEqual(f.opens,[]);
});
test('Workspace display uses membership and native default/ungrouped labels, never path guesses',t=>{
  const f=setup(t);f.workspaces.set({pinnedSessionIds:['a','b','c'],archivedSessionIds:[],items:[{title:'default-workspace',path:'C:/should-not-show',sessionIds:['a']},{title:'Named workspace',path:'C:/same',sessionIds:['c']}]});chatPull(f).open();
  const tree=materialize(f.render()),name=id=>nodes(nodes(tree,x=>x.props?.id==='cs-option-'+id)[0],x=>x.props?.className==='cs-workspace-name')[0].children[0];assert.equal(name('a'),'defaultWorkspace');assert.equal(name('b'),'ungrouped');assert.equal(name('c'),'Named workspace');
});
test('hover keeps its mosaic card but delegates all popup geometry to the native owner',t=>{
  const f=setup(t),hover=hoverTree(f,'b');assert.equal(hover.props.className,'cs-card cs-hover-card');assert.equal(nodes(hover,x=>x.type==='img').length,1);assert.equal(nodes(hover,x=>x.type==='style'||x.props?.['data-cs-hover-surface']!==undefined||x.props?.['data-cs-hover-anchor']!==undefined).length,0);assert.deepEqual(f.opens,[]);
  const style=nodes(materialize(f.render()),x=>x.type==='style'&&x.props?.['data-chat-switcher-version'])[0];assert.ok(style);assert.doesNotMatch(style.children.join(''),/_l6gf9_|--dsh-ui-zoom-|--cs-hover-|position-try-fallbacks/,'no native positioning primitive overrides remain in the shared stylesheet');
});
test('hover covers idle unpinned and archived metadata without expanding keyboard selection',t=>{
  const f=setup(t);f.workspaces.set({pinnedSessionIds:['a'],archivedSessionIds:['c']});
  const list=f.sessions.getSnapshot();f.sessions.set({...list,byId:{...list.byId,b:{...list.byId.b,cwd:'C:/projects/idle'}}});
  const hover=hoverTree(f,'b');
  assert.equal(nodes(hover,x=>x.props?.className==='cs-folder').length,0);
  assert.equal(JSON.stringify(hover).includes('C:/projects/idle'),false,'path is not rendered, not merely hidden');
  assert.equal(nodes(hover,x=>x.props?.['data-state']==='idle').length>0,true);
  assert.equal(nodes(hoverTree(f,'c'),x=>x.type==='img').length,1);
  assert.deepEqual(f.source.getSnapshot().items.map(x=>x.id),['a']);
  f.status.set(new Map([['b',{running:true}]]));
  assert.equal(nodes(hoverTree(f,'b'),x=>x.props?.['data-state']==='running').length>0,true);
  f.status.set(new Map());assert.deepEqual(f.source.getSnapshot().items.map(x=>x.id),['a']);
  delete list.byId.c;f.sessions.set({...list});
  assert.equal(hoverTree(f,'c'),null,'missing metadata leaves native fallback visible');
});

test('palette is a rightmost utility without replacing the native sidebar opener',t=>{
  const f=setup(t),entry=f.slots.find(x=>x.options.id==='chat-image');
  assert.equal(entry.options.name,'conversation.session.header.utilities');assert.equal(entry.options.order,100);
  assert.equal(f.slots.some(x=>x.options.name==='conversation.session.header.corner'),false);
  const tree=materialize(entry.component({...entry.options.inject(),sessionId:'a',t:x=>x}));
  const button=nodes(tree,x=>x.type==='button')[0];assert.equal(button.props['aria-label'],'imageChange');assert.equal(button.props.disabled,true);
  assert.equal(nodes(tree,x=>x.type==='svg').length,1);assert.equal(nodes(tree,x=>x.type==='circle').length,4,'palette paint wells replace the brush');assert.deepEqual(f.opens,[]);
});
test('blank new-chat palette uses the same action before any message, and no-session state stays empty',t=>{
  const f=setup(t),entry=f.slots.find(x=>x.options.name==='conversation.header.leading');
  const render=()=>materialize(entry.component({...entry.options.inject(),t:x=>x}));
  assert.equal(render(),null);
  const list=f.sessions.getSnapshot();f.sessions.set({...list,byId:{...list.byId,a:{...list.byId.a,blank:true}}});
  assert.equal(nodes(render(),x=>x.type==='button').length,1);
  assert.ok(JSON.stringify(render()).includes('cs-blank-image-action'));
  f.sessions.set({...list,byId:{...list.byId,a:{...list.byId.a,blank:true,retainedBy:{}}}});assert.equal(render(),null);
});
test('a palette click updates the native composer and hover from one seed without navigating or editing',async t=>{
  const requests=[];
  const rpc={call(channel,method,payload,signal){assert.equal(channel,'/api');assert.equal(method,'chat-switcher/images');return new Promise((resolve,reject)=>{requests.push({payload,resolve});signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});}};
  const f=setup(t,{rpc});requests[0].resolve({ok:true,value:{generation:'h',revision:0,records:[]}});await new Promise(resolve=>setImmediate(resolve));
  const entry=f.slots.find(x=>x.options.id==='chat-image'),composer=f.slots.find(x=>x.options.name==='conversation.input.overlay');
  const render=()=>materialize(entry.component({...entry.options.inject(),sessionId:'a',t:x=>x}));
  const beforeHover=nodes(hoverTree(f,'a'),x=>x.type==='img')[0].props.src;
  const beforeCss=materialize(composer.component({...composer.options.inject(),sessionId:'a'})).children[0];
  const button=nodes(render(),x=>x.type==='button')[0];assert.equal(button.props.disabled,false);button.props.onClick();
  assert.equal(nodes(render(),x=>x.type==='button')[0].props.disabled,true);
  requests.find(x=>x.payload.action==='regenerate').resolve({ok:true,value:{sessionId:'a',salt:'chosen-salt',revision:1,generation:'h',catalogRevision:1}});await new Promise(resolve=>setImmediate(resolve));
  const afterHover=nodes(hoverTree(f,'a'),x=>x.type==='img')[0].props.src;
  const afterCss=materialize(composer.component({...composer.options.inject(),sessionId:'a'})).children[0];
  assert.notEqual(afterHover,beforeHover);assert.notEqual(afterCss,beforeCss);assert.ok(afterCss.includes(afterHover));
  assert.equal(nodes(render(),x=>x.type==='button')[0].props.disabled,false);assert.deepEqual(f.opens,[]);assert.equal(f.source.getSnapshot().cycle,null);
});

test('initial current session is recorded once pins arrive after catalog',t=>{
  const f=setup(t);f.workspaces.set({pinnedSessionIds:[],archivedSessionIds:[]});f.sessions.set({...f.sessions.getSnapshot(),byId:{...f.sessions.getSnapshot().byId,a:{id:'a',retainedBy:{}},c:{id:'c',retainedBy:{mainView:1}}}});f.workspaces.set({pinnedSessionIds:['a','b','c'],archivedSessionIds:[]});assert.equal(f.source.getSnapshot().items[0].id,'c');
});

test('one global palette uses the committed main chat and shared image identity, never a Ctrl+Tab preview',t=>{
  const f=setup(t),entries=f.slots.filter(x=>x.options.id==='chat-switcher:body-palette:1.16.1');
  assert.equal(entries.length,1);assert.equal(entries[0].options.name,'shell.overlay');
  const props=entries[0].options.inject(),composer=f.slots.find(x=>x.options.name==='conversation.input.overlay');
  assert.equal(props.identities,composer.options.inject().identities);assert.equal(props.source,f.source);
  assert.equal(f.source.getSnapshot().currentId,'a');
  f.next();assert.equal(f.source.getSnapshot().currentId,'a');assert.equal(f.source.getSnapshot().cycle.items[f.source.getSnapshot().cycle.index].id,'b');
  f.release();assert.equal(f.source.getSnapshot().currentId,'b');
  const list=f.sessions.getSnapshot();f.sessions.set({...list,byId:Object.fromEntries(Object.entries(list.byId).map(([id,row])=>[id,{...row,retainedBy:{}}]))});
  assert.equal(f.source.getSnapshot().currentId,null);
});
test('adaptive palette failure is a localized non-blocking hint, separate from image regeneration errors',t=>{
  const f=setup(t),entry=f.slots.find(x=>x.options.name==='conversation.session.header.utilities'),props=entry.options.inject();
  const warn=console.warn;console.warn=()=>{};
  try { props.paletteRuntime.update('#6abfc6',()=>{throw new Error('unreadable CSS');}); } finally { console.warn=warn; }
  const tree=materialize(entry.component({...props,sessionId:'a',t:key=>key}));
  const button=nodes(tree,x=>x.type==='button')[0];assert.ok(button.props.title.includes('paletteFallback'));assert.equal(button.props['aria-label'],'imageChange');
  assert.equal(props.identities.getSnapshot().errors.has('a'),false);assert.deepEqual(f.opens,[]);
});

test('phone pull contribution opens persistent previews without Desktop platform or a timer', t => {
  const f = setup(t); f.document.documentElement.dataset = {};
  const entry = f.slots.find(x => x.options.name === 'conversation.hero.frame');
  assert.equal(entry.options.id, 'chat-switcher:pull:1.16.1'); assert.equal(entry.options.order, -100);
  const { pull } = entry.options.inject();
  assert.equal(pull.enabled(), true); assert.equal(pull.getSession(), 'a'); assert.equal(pull.canOpen(), true);
  pull.open(); const cycle = f.source.getSnapshot().cycle;
  assert.equal(cycle.mode, 'browse'); assert.equal(cycle.visible, true); assert.equal(cycle.items[cycle.index].id, 'b');
  assert.equal(f.timers.size, 0); assert.equal(pull.canOpen(), false);
  f.release(); f.advance(1000); assert.deepEqual(f.opens, []); assert.equal(f.source.getSnapshot().cycle.mode, 'browse');
  const cancel = f.slots.find(x => x.options.name === 'shell.overlay').options.inject().cancel;
  cancel(); assert.equal(f.source.getSnapshot().cycle, null); assert.deepEqual(f.opens, []);
});
function nativeMenuFixture(onSelect=()=>{}) {
  const ids=['session.pin/pin','session.rename/rename','session.fork/fork','session.id/copy','session.archive/archive'],scopes=[],selected=[];
  const service={resolve(target){const rows=store(ids.map((id,index)=>({id,label:id,disabled:false,icon:{key:['workspace.pin','workspace.rename','workspace.fork','workspace.copy','workspace.archive'][index]}})));
    const scope={target,source:rows,ready:Promise.resolve(),disposals:0,select(id){selected.push({id,target});onSelect(id,target);},dispose(){scope.disposals++;}};scopes.push(scope);return scope;}};
  return {service,scopes,selected};
}
function overlayProps(f){return f.slots.find(x=>x.options.name==='shell.overlay').options.inject();}
function chatPull(f){return f.slots.find(x=>x.options.name==='conversation.hero.frame').options.inject().pull;}
test('quick swipe uses the frozen shown target after priority churn without creating a cycle or reveal timer',t=>{
  const f=setup(t),pull=chatPull(f),cycles=[],off=f.source.subscribe(()=>cycles.push(f.source.getSnapshot().cycle));
  const frozen=pull.getNext();assert.equal(frozen,'b');const question=store({closed:false,channel:'rpc'});question.kind='question';f.status.set(new Map([['c',{pendingInteraction:question}]]));assert.equal(pull.getNext(),'c');
  pull.quick(frozen);assert.deepEqual(f.opens,['b']);assert.equal(f.source.getSnapshot().currentId,'b');assert.ok(cycles.every(value=>value===null));assert.equal(f.timers.size,0);off();
});
test('chat indicator uses the next target mosaic on the left and window glyph on the right for browse',t=>{
  const f=setup(t),entry=f.slots.find(x=>x.options.name==='conversation.hero.frame'),props=entry.options.inject(),original=f.React.useState;
  try{
    f.React.useState=()=>[{distance:90,ready:true,action:'quick',targetId:'b'},()=>{}];let tree=materialize(entry.component({...props,children:null}));
    assert.equal(nodes(tree,x=>x.props?.className==='cs-tension')[0].props['data-side'],'left');assert.equal(nodes(tree,x=>x.type==='image')[0].props.href,getMosaicDataUrl(props.identities.seed('b')));
    f.React.useState=()=>[{distance:90,ready:true,action:'browse',targetId:null},()=>{}];tree=materialize(entry.component({...props,children:null}));assert.equal(nodes(tree,x=>x.props?.className==='cs-tension')[0].props['data-side'],'right');assert.equal(nodes(tree,x=>x.type==='image').length,0);
  }finally{f.React.useState=original;}
});
function ownedChatArea(f, rect) {
  const pull=chatPull(f),content={dataset:{conversationSession:'a'}};
  const frame={isConnected:true,closest:selector=>selector==='[data-rightbar-col]'?null:content};
  const area={isConnected:true,getBoundingClientRect:()=>rect};
  return pull.observeArea(frame,area);
}
test('card click snapshots the displayed mosaic and moves toward the frozen chat area, without duplicate queued opens',t=>{
  const f=setup(t),target={left:300,top:70,width:900,height:650};ownedChatArea(f,target);Object.assign(f.target,{innerWidth:1400,innerHeight:900});
  chatPull(f).open();const tree=materialize(f.render()),card=nodes(tree,x=>x.props?.id==='cs-option-b')[0],preview=nodes(card,x=>x.props?.className==='cs-preview')[0];
  preview.props.ref({isConnected:true,matches:selector=>selector==='.cs-preview',getBoundingClientRect:()=>({left:400,top:140,width:200,height:200}),querySelector:()=>({getAttribute:()=> 'shown-card-image'})});
  card.props.onClick();assert.deepEqual(f.opens,['b']);assert.equal(f.source.getSnapshot().cycle,null);
  const curtain=f.source.getSnapshot().curtain;assert.equal(curtain.shape,'card');assert.equal(curtain.image,'shown-card-image');assert.deepEqual(curtain.target,target);assert.notEqual(curtain.target,target);
  assert.equal(f.source.getSnapshot().modalArea,null,'new session may replace old HOC without erasing the frozen destination');
  card.props.onClick();assert.deepEqual(f.opens,['b']);
});
test('card selection with missing visual still navigates, but archived/stale rows cannot start a curtain',t=>{
  const f=setup(t),api=overlayProps(f);chatPull(f).open();api.open('b',null);assert.deepEqual(f.opens,['b']);assert.equal(f.source.getSnapshot().curtain,null);
  api.open('c',{circle:{left:0,top:0,width:100,height:100},shape:'card',image:'stale'});assert.deepEqual(f.opens,['b']);
  chatPull(f).open();f.workspaces.set({pinnedSessionIds:['a','b','c'],archivedSessionIds:['c']});api.open('c',{circle:{left:0,top:0,width:100,height:100},shape:'card',image:'archived'});assert.deepEqual(f.opens,['b']);assert.equal(f.source.getSnapshot().curtain,null);
});
test('visible keyboard selection captures before dialog clear; quick Ctrl+Tab stays instant',t=>{
  const f=setup(t),api=overlayProps(f);let calls=0;
  const off=api.registerSelectionCapture(id=>{calls++;assert.equal(f.source.getSnapshot().cycle.visible,true);assert.equal(id,'b');return {circle:{left:400,top:140,width:200,height:200},shape:'card',image:'keyboard-card'};});
  f.next();f.release();assert.equal(calls,0);assert.equal(f.source.getSnapshot().curtain,null);
  // Current is now b: the next visible keyboard target is a.
  off();api.registerSelectionCapture(id=>{calls++;assert.equal(f.source.getSnapshot().cycle.visible,true);assert.equal(id,'a');return {circle:{left:400,top:140,width:200,height:200},shape:'card',image:'keyboard-card'};});
  f.next();f.advance(250);f.release();assert.equal(calls,1);assert.equal(f.source.getSnapshot().curtain.image,'keyboard-card');assert.deepEqual(f.opens,['b','a']);
});
test('selection capture cleanup cannot unregister a newer renderer and failures never block navigation',t=>{
  const f=setup(t),api=overlayProps(f);const old=api.registerSelectionCapture(()=>{throw new Error('stale renderer');});
  api.registerSelectionCapture(()=>{throw new Error('missing visual');});old();f.next();f.advance(250);f.release();assert.deepEqual(f.opens,['b']);assert.equal(f.source.getSnapshot().curtain,null);
});
test('prepared quick curtain survives navigation, rejects stale completion, and keyboard input cancels it',t=>{
  const f=setup(t),pull=chatPull(f),api=overlayProps(f),image=getMosaicDataUrl(f.slots.find(x=>x.options.name==='conversation.hero.frame').options.inject().identities.seed('b'));
  pull.quick('b',{circle:{left:20,top:200,width:160,height:160},image});assert.equal(f.source.getSnapshot().currentId,'b');assert.equal(f.source.getSnapshot().cycle,null);assert.equal(f.source.getSnapshot().curtain.image,image);assert.equal(countDialogs(f.render()),0);assert.equal(pull.canOpen(),false);
  const old=f.source.getSnapshot().curtain.id;api.startCurtain({circle:{left:30,top:210,width:160,height:160},image});const next=f.source.getSnapshot().curtain.id;api.finishCurtain(old);assert.equal(f.source.getSnapshot().curtain.id,next);api.finishCurtain(next);assert.equal(f.source.getSnapshot().curtain,null);
  api.startCurtain({circle:{left:30,top:210,width:160,height:160},image});f.next();assert.equal(f.source.getSnapshot().curtain,null);assert.equal(f.source.getSnapshot().cycle.mode,'hold');
});
test('header New Session delegates native no-argument navigation and respects the standard create permission',t=>{
  const f=setup(t);chatPull(f).open();let tree=materialize(f.render()),button=nodes(tree,x=>x.props?.className==='cs-new-session')[0];assert.ok(button);assert.equal(button.props.disabled,false);button.props.onClick();assert.deepEqual(f.newSessions,[[]]);assert.equal(f.source.getSnapshot().cycle,null);
  chatPull(f).open();const entry=f.slots.find(x=>x.options.name==='shell.overlay');tree=materialize(entry.component({...entry.options.inject(),t:key=>key,useRemoteAccess:()=>false}));button=nodes(tree,x=>x.props?.className==='cs-new-session')[0];assert.equal(button.props.disabled,true);button.props.onClick();assert.deepEqual(f.newSessions,[[]]);
});
test('context Pin and Copy select the native occurrence once while keeping the chooser open',async t=>{
  const native=nativeMenuFixture(),f=setup(t,{contextMenus:native.service}),api=overlayProps(f);chatPull(f).open();
  for(const id of ['session.pin/pin','session.id/copy']){
    api.openContext('b',{x:80,y:150});await Promise.resolve();const tree=materialize(f.render()),menu=nodes(tree,x=>x.props?.className==='cs-session-menu')[0];assert.ok(menu);assert.equal(nodes(menu,x=>x.props?.role==='menuitem').length,5);const item=nodes(menu,x=>x.props?.role==='menuitem'&&x.props.children===undefined).find(x=>x.props.key===id);assert.ok(item);item.props.onClick({stopPropagation(){}});
    assert.equal(f.source.getSnapshot().contextMenu,null);assert.equal(f.source.getSnapshot().cycle.mode,'browse');assert.equal(native.scopes.at(-1).disposals,1);
  }
  assert.deepEqual(native.selected.map(row=>row.id),['session.pin/pin','session.id/copy']);assert.equal(native.selected.every(row=>row.target.value.sessionId==='b'),true);
});
test('native prompting/context navigation actions run only after the main chooser cycle is closed',async t=>{
  let f;const native=nativeMenuFixture(()=>assert.equal(f.source.getSnapshot().cycle,null));f=setup(t,{contextMenus:native.service});
  for(const id of ['session.rename/rename','session.fork/fork','session.archive/archive']){chatPull(f).open();overlayProps(f).openContext('b',{x:80,y:150});await Promise.resolve();const tree=materialize(f.render()),item=nodes(tree,x=>x.props?.role==='menuitem'&&x.props.key===id)[0];assert.ok(item);item.props.onClick({stopPropagation(){}});assert.equal(f.source.getSnapshot().contextMenu,null);}
  assert.equal(native.selected.length,3);
});
test('context Escape closes only its layer and Control release cannot commit the former keyboard cursor',async t=>{
  const native=nativeMenuFixture(),f=setup(t,{contextMenus:native.service});f.next();f.advance(250);overlayProps(f).openContext('b',{x:80,y:150});await Promise.resolve();assert.equal(f.source.getSnapshot().cycle.mode,'browse');assert.equal(f.source.getSnapshot().cycle.keyboardSelection,false);f.release();
  const escape=new Event('keydown',{cancelable:true});Object.assign(escape,{key:'Escape'});f.target.dispatchEvent(escape);assert.ok(f.source.getSnapshot().contextMenu);assert.equal(escape.defaultPrevented,false);
  const menu=nodes(materialize(f.render()),x=>x.props?.className==='cs-session-menu')[0];menu.props.onCancel({preventDefault(){},stopPropagation(){}});assert.equal(f.source.getSnapshot().contextMenu,null);assert.equal(f.source.getSnapshot().cycle.mode,'browse');f.release();assert.deepEqual(f.opens,[]);assert.equal(native.scopes[0].disposals,1);
});
test('archiving externally prunes frozen previews, closes the target menu and excludes quick/click actions',async t=>{
  const native=nativeMenuFixture(),f=setup(t,{contextMenus:native.service}),pull=chatPull(f);f.status.set(new Map([['b',{running:true}]]));pull.open();overlayProps(f).openContext('b',{x:80,y:150});await Promise.resolve();
  f.workspaces.set({pinnedSessionIds:['a','b','c'],archivedSessionIds:['b']});assert.equal(f.source.getSnapshot().contextMenu,null);assert.equal(f.source.getSnapshot().cycle.items.some(row=>row.id==='b'),false);assert.equal(pull.getNext(),'c');assert.equal(pull.isEligible('b'),false);assert.equal(native.scopes[0].disposals,1);
  overlayProps(f).cancel();pull.quick('b');overlayProps(f).openContext('b',{x:0,y:0});assert.deepEqual(f.opens,[]);assert.equal(native.scopes.length,1);
});
test('archived pinned/running chats never enter a new picker or native action resolution',t=>{
  const native=nativeMenuFixture(),f=setup(t,{contextMenus:native.service}),pull=chatPull(f);f.workspaces.set({pinnedSessionIds:['a','b','c'],archivedSessionIds:['b']});f.status.set(new Map([['b',{running:true,completionUnread:true}]]));pull.open();assert.deepEqual(f.source.getSnapshot().cycle.items.map(row=>row.id),['a','c']);overlayProps(f).openContext('b',{x:0,y:0});assert.equal(native.scopes.length,0);
});
test('blur, hiding and disabling close the context occurrence together with its parent without selecting',async t=>{
  const native=nativeMenuFixture(),f=setup(t,{contextMenus:native.service});
  for(const reason of ['blur','hidden','disabled']){
    chatPull(f).open();overlayProps(f).openContext('b',{x:80,y:150});await Promise.resolve();
    if(reason==='blur')f.target.dispatchEvent(new Event('blur'));
    else if(reason==='hidden'){f.document.visibilityState='hidden';f.document.dispatchEvent(new Event('visibilitychange'));}
    else f.form.set({status:'ready',value:{enabled:true,pullEnabled:false,delayMs:250}});
    assert.equal(f.source.getSnapshot().cycle,null,reason);assert.equal(f.source.getSnapshot().contextMenu,null,reason);assert.equal(native.scopes.at(-1).disposals,1,reason);f.document.visibilityState='visible';
  }
  assert.deepEqual(native.selected,[]);
});
test('swipe previews have no selected card or active descendant until keyboard navigation starts', t=>{
  const f=setup(t);f.slots.find(x=>x.options.name==='conversation.hero.frame').options.inject().pull.open();
  let tree=materialize(f.render()),options=nodes(tree,x=>x.props?.role==='option'),grid=nodes(tree,x=>x.props?.role==='listbox')[0];
  assert.equal(options.length,3);assert.equal(options.some(x=>x.props['aria-selected']===true),false);assert.equal(grid.props['aria-activedescendant'],undefined);
  grid.props.onKeyDown({key:'Enter',preventDefault(){},stopPropagation(){}});assert.deepEqual(f.opens,[]);assert.equal(f.source.getSnapshot().cycle.mode,'browse');
  grid.props.onKeyDown({key:'ArrowDown',preventDefault(){},stopPropagation(){}});
  tree=materialize(f.render());grid=nodes(tree,x=>x.props?.role==='listbox')[0];assert.equal(grid.props['aria-activedescendant'],'cs-option-a');assert.equal(nodes(tree,x=>x.props?.role==='option'&&x.props['aria-selected']===true).length,1);
});
test('Ctrl+Tab from unselected swipe previews selects the hottest next chat without skipping it',t=>{
  const f=setup(t);f.slots.find(x=>x.options.name==='conversation.hero.frame').options.inject().pull.open();f.next();
  const tree=materialize(f.render()),selected=nodes(tree,x=>x.props?.role==='option'&&x.props['aria-selected']===true);
  assert.equal(selected.length,1);assert.equal(selected[0].props.id,'cs-option-b');f.release();assert.deepEqual(f.opens,['b']);
});
test('browse tap uses the same eligible candidates and preserves attention without Control keyup commit', t => {
  const f = setup(t), entry = f.slots.find(x => x.options.name === 'shell.overlay');
  f.slots.find(x => x.options.name === 'conversation.hero.frame').options.inject().pull.open();
  f.release(); assert.deepEqual(f.opens, []);
  entry.options.inject().open('c'); assert.deepEqual(f.opens, ['c']); assert.equal(f.source.getSnapshot().cycle, null);
});
test('keyboard and touch enable flags are independent and changes cancel only the owning mode', t => {
  const f = setup(t), { pull } = f.slots.find(x => x.options.name === 'conversation.hero.frame').options.inject();
  f.form.set({ status: 'ready', value: { enabled: false, pullEnabled: true, delayMs: 250 } });
  assert.equal(pull.enabled(), true); pull.open();
  f.form.set({ status: 'ready', value: { enabled: false, pullEnabled: true, delayMs: 250 } });
  assert.equal(f.source.getSnapshot().cycle.mode, 'browse');
  f.form.set({ status: 'ready', value: { enabled: true, pullEnabled: false, delayMs: 250 } });
  assert.equal(f.source.getSnapshot().cycle, null); assert.equal(pull.enabled(), false);
  f.next(); f.form.set({ status: 'ready', value: { enabled: true, pullEnabled: false, delayMs: 250 } });
  assert.equal(f.source.getSnapshot().cycle.mode, 'hold'); f.release(); assert.deepEqual(f.opens, ['b']);
});
test('Escape cancels a browse dialog in a phone/Web page without navigation', t => {
  const f = setup(t); f.document.documentElement.dataset = {};
  f.slots.find(x => x.options.name === 'conversation.hero.frame').options.inject().pull.open();
  const event = new Event('keydown', { cancelable: true }); Object.assign(event, { key: 'Escape' });
  f.target.dispatchEvent(event); assert.equal(event.defaultPrevented, true); assert.equal(f.source.getSnapshot().cycle, null); assert.deepEqual(f.opens, []);
});
test('read-only swipe diagnostics report real mount counts and can select a touch-capable responder', async t => {
  const f=setup(t),provider=f.inspectProviders.find(x=>x.manifest.id==='ChatSwitcher'); assert.ok(provider);
  const state=await provider.query('status',{});assert.equal(state.gestureEnabled,true);assert.equal(state.formStatus,'ready');assert.equal(state.mountedFrames,0);assert.equal(state.candidates,3);
  await assert.rejects(provider.query('status',{touchOnly:true}),/not-touch-page/);
  f.target.navigator={maxTouchPoints:5};assert.equal((await provider.query('status',{touchOnly:true})).touchPoints,5);assert.deepEqual(f.opens,[]);
});
test('short Ctrl+Tab chooses the oldest request before a more recently visited request and error',t=>{
  const originalNow=Date.now;let now=100;Date.now=()=>now;t.after(()=>Date.now=originalNow);
  const f=setup(t);f.status.set(new Map([['c',{pendingInteraction:{kind:'approval',callId:'old',answerable:true}}]]));
  now=200;f.status.set(new Map([['b',{pendingInteraction:{kind:'approval',callId:'new',answerable:true}}],['c',{pendingInteraction:{kind:'approval',callId:'old',answerable:true}}]]));
  assert.deepEqual(f.source.getSnapshot().items.map(x=>x.id),['a','c','b']);
  f.next();f.release();assert.deepEqual(f.opens,['c']);
  f.next();f.release();assert.deepEqual(f.opens,['c','b'],'after entering the hot current chat, the next hottest event wins over previous ordinary MRU');
});
test('current idle chat remains first while unrelated idle catalog rows stay excluded',t=>{
  const f=setup(t);f.workspaces.set({pinnedSessionIds:[],archivedSessionIds:[]});
  assert.deepEqual(f.source.getSnapshot().items.map(x=>x.id),['a']);
  f.status.set(new Map([['b',{running:true}]]));assert.deepEqual(f.source.getSnapshot().items.map(x=>x.id),['a','b']);
  f.next();f.release();assert.deepEqual(f.opens,['b']);
});
test('recent idle visits enter the last group and expire via one deadline timer, while the current chat stays first',t=>{
  const originalNow=Date.now;let now=10000;Date.now=()=>now;t.after(()=>Date.now=originalNow);
  const f=setup(t);f.workspaces.set({pinnedSessionIds:[],archivedSessionIds:[]});
  const list=f.sessions.getSnapshot();f.sessions.set({...list,byId:Object.fromEntries(Object.entries(list.byId).map(([id,row])=>[id,{...row,retainedBy:{mainView:id==='b'?1:0}}]))});
  assert.deepEqual(f.source.getSnapshot().items.map(x=>x.id),['b','a']);assert.equal(f.timers.size,1);
  now+=3600000;f.advance(3600000);assert.deepEqual(f.source.getSnapshot().items.map(x=>x.id),['b']);assert.equal(f.timers.size,0);
  f.workspaces.set({pinnedSessionIds:['a'],archivedSessionIds:[]});assert.deepEqual(f.source.getSnapshot().items.map(x=>x.id),['b','a']);assert.equal(f.timers.size,0);
});
test('leaving a long-open idle chat records the departure, not only the much older arrival',t=>{
  const originalNow=Date.now;let now=10000;Date.now=()=>now;t.after(()=>Date.now=originalNow);
  const f=setup(t);f.workspaces.set({pinnedSessionIds:[],archivedSessionIds:[]});now+=2*3600000;
  const list=f.sessions.getSnapshot();f.sessions.set({...list,byId:Object.fromEntries(Object.entries(list.byId).map(([id,row])=>[id,{...row,retainedBy:{mainView:id==='b'?1:0}}]))});
  assert.deepEqual(f.source.getSnapshot().items.map(x=>x.id),['b','a']);assert.equal(f.timers.size,1);
});
