import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdentityService, installIdentityHost, IMAGE_ENDPOINT } from '../host.js';
import { allMosaicParametersDiffer } from '../image-salt.js';
import { getMosaicParameters } from '../src/mosaic.js';
import { identitySeed } from '../src/identity.js';
const differs=(id,before,after,beforeVariant='legacy',afterVariant='hybrid-fractal/v2')=>allMosaicParametersDiffer(getMosaicParameters(identitySeed(id,before,beforeVariant)),getMosaicParameters(identitySeed(id,after,afterVariant)));

const salt = n => `${String(n).padStart(8,'0')}-0000-4000-8000-000000000000`;
function fixture(records = new Map()) {
  let serial = 0;
  const sessions = new Map([['old',{id:'old',header:{createdAt:100}}],['new',{id:'new',header:{createdAt:1000}}]]);
  const table = { get:id=>records.get(id), entries:()=>records.entries(), async put(id,value){records.set(id,value);} };
  const service = createIdentityService({table,activatedAt:500,session:id=>sessions.get(id),random:()=>salt(++serial),generation:'host-a'});
  return {service,table,records,sessions,get entropyCalls(){return serial;}};
}
test('new chats get one durable random salt; legacy chats keep their exact previous seed',async()=>{
  const f=fixture();
  assert.equal((await f.service.ensure('old')).salt,null);
  const first=await f.service.ensure('new');
  assert.equal(first.salt,salt(1));assert.equal(first.revision,1);assert.equal(f.records.size,1);
  assert.deepEqual(await f.service.ensure('new'),first);
  assert.equal(f.service.snapshot().revision,1);
  await f.service.dispose();
});
test('concurrent initialization is deduplicated; rerolls serialize without lost revisions',async()=>{
  const f=fixture();
  const values=await Promise.all([f.service.ensure('new'),f.service.ensure('new'),f.service.ensure('new')]);
  assert.equal(new Set(values.map(x=>x.salt)).size,1);
  const changed=await Promise.all([f.service.regenerate('new'),f.service.regenerate('new')]);
  assert.deepEqual(changed.map(x=>x.revision),[2,3]);assert.notEqual(changed[0].salt,changed[1].salt);
  assert.equal(f.service.read('new').salt,changed[1].salt);assert.equal(differs('new',values[0].salt,changed[0].salt),true);assert.equal(differs('new',changed[0].salt,changed[1].salt,'hybrid-fractal/v2'),true);await f.service.dispose();
});
test('reopening storage preserves the salt instead of consuming entropy again',async()=>{
  const f=fixture();await f.service.regenerate('old');const before=f.service.read('old');await f.service.dispose();
  const other=fixture(f.records);assert.equal((await other.service.ensure('old')).salt,before.salt);assert.equal(other.service.snapshot().revision,0);await other.service.dispose();
});
test('a failed durable write publishes no change and retains the existing image',async()=>{
  const f=fixture();await f.service.regenerate('old');const before=f.service.read('old');let changes=0;f.service.subscribe(()=>changes++);
  f.table.put=async()=>{throw new Error('Disk full');};
  await assert.rejects(f.service.regenerate('old'),/Disk full/);assert.deepEqual(f.service.read('old'),before);assert.equal(changes,0);await f.service.dispose();
});
test('watch sends a baseline, wakes after commit, and cancellation removes its timer',async()=>{
  const f=fixture();const baseline=await f.service.watch({},new AbortController().signal);assert.deepEqual(baseline.records,[]);
  const timers=new Map();let next=0;const options={later:fn=>{timers.set(++next,fn);return next;},cancel:id=>timers.delete(id)};
  const controller=new AbortController();const waiting=f.service.watch(baseline,controller.signal,options);assert.equal(timers.size,1);
  await f.service.regenerate('old');const update=await waiting;assert.equal(update.records[0].salt,f.service.read('old').salt);assert.equal(differs('old',null,update.records[0].salt),true);assert.equal(timers.size,0);
  const cancelled=f.service.watch(update,controller.signal,options);controller.abort();await assert.rejects(cancelled);assert.equal(timers.size,0);
  await f.service.dispose();
});
test('watch timeout is metadata-only, unload cancels waits, and invalid chats cannot mutate',async()=>{
  const f=fixture();let timer;const signal=new AbortController().signal;
  const value=f.service.snapshot();const waiting=f.service.watch(value,signal,{later:fn=>(timer=fn,1),cancel:()=>{}});timer();
  assert.deepEqual(await waiting,{generation:'host-a',revision:0});
  const wait=f.service.watch(value,signal);const rejection=assert.rejects(wait,/unloaded/);await f.service.dispose();await rejection;
  assert.throws(()=>f.service.regenerate('missing'),/not open/);assert.equal(f.records.size,0);
});

test('rendered-reference CAS rejects stale clicks, queued concurrent references and old Host generations without extra writes',async()=>{
  const f=fixture();let changes=0;f.service.subscribe(()=>changes++);
  const reference={expectedSalt:null,expectedGeneration:'host-a'};
  const first=f.service.regenerate('old',reference),second=f.service.regenerate('old',reference);
  const rejected=assert.rejects(second,/already changed/);const accepted=await first;await rejected;
  assert.equal(changes,1);assert.equal(accepted.revision,1);const draws=f.entropyCalls;
  await assert.rejects(f.service.regenerate('old',{expectedSalt:accepted.salt,expectedGeneration:'retired-host'}),/already changed/);
  assert.equal(f.entropyCalls,draws);assert.equal(f.service.read('old').salt,accepted.salt);await f.service.dispose();
});
test('search publishes one durable record only, despite rejecting earlier candidate salts',async()=>{
  const f=fixture();let writes=0,notifications=0;const put=f.table.put;
  f.table.put=async(...args)=>{writes++;return put(...args);};f.service.subscribe(()=>notifications++);
  const accepted=await f.service.regenerate('old');assert.equal(differs('old',null,accepted.salt),true);
  assert.equal(writes,1);assert.equal(notifications,1);assert.equal(accepted.catalogRevision,1);assert.equal(f.entropyCalls>1,true,'deterministic stream exercises rejection');await f.service.dispose();
});
test('already-aborted requests cannot search or persist and malformed references fail closed',async()=>{
  const f=fixture(),controller=new AbortController();controller.abort();
  await assert.rejects(f.service.regenerate('old',{signal:controller.signal}),/cancelled or unloaded/);
  assert.equal(f.entropyCalls,0);assert.equal(f.records.size,0);
  await assert.rejects(f.service.regenerate('old',{expectedSalt:7}),/Invalid image reference/);assert.equal(f.records.size,0);await f.service.dispose();
});

test('a failed initial durable write already owns a domain disposer for activation rollback',async()=>{
  const cleanups=[];let closed=false;
  const ctx={storageDomain:{open:async()=>({global:{get:()=>({activatedAt:1}),set:async()=>{throw new Error('Disk full');}},close:async()=>{closed=true;}})},effect(fn){cleanups.push(fn());}};
  await assert.rejects(installIdentityHost(ctx),/Disk full/);
  assert.equal(cleanups.length,1,'domain ownership is registered before the fallible write');
  for(const off of cleanups.reverse())await off();assert.equal(closed,true);
});

test('Host UI transport and agent tool call the same durable operation without transcript writes',async()=>{
  const f=fixture();let tool,route;const cleanups=[],events=new Map();let persistedGlobal;
  const ctx={
    storageDomain:{open:async spec=>{assert.equal(spec.name,'local_chat_switcher_images');return {global:{get:()=>({activatedAt:500}),set:async value=>{persistedGlobal=value;}},table:()=>f.table,close:async()=>{}};}},
    sessions:{get:id=>f.sessions.get(id),list:()=>[f.sessions.get('old')]},
    effect(fn){const off=fn();if(off)cleanups.push(off);},on(name,fn){events.set(name,fn);},logger:{warn:()=>{}},
    tools:{register(value){tool=value;return ()=>{};}},connection:{fetch:{register(value){route=value;return ()=>{};}}},
  };
  let seq=20;await installIdentityHost(ctx,{valueSchema:{},globalSchema:{},random:()=>salt(++seq)});
  assert.deepEqual(persistedGlobal,{activatedAt:500});assert.equal(route.path,'/api/'+IMAGE_ENDPOINT);
  assert.equal((await tool.execute({action:'get'},{agent:{id:'old'}})).salt,null);
  const changed=await tool.execute({action:'regenerate'},{agent:{id:'old'}});assert.equal(differs('old',null,changed.salt),true);
  const request=payload=>new Request('http://localhost/api/'+IMAGE_ENDPOINT,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'1',method:IMAGE_ENDPOINT,payload})});
  const read=await (await route.fetch(request({action:'get',sessionId:'old'}))).json();assert.deepEqual(read.result.value,changed);
  const regenerated=await (await route.fetch(request({action:'regenerate',sessionId:'old'}))).json();assert.equal(differs('old',changed.salt,regenerated.result.value.salt,'hybrid-fractal/v2'),true);assert.equal(regenerated.result.value.revision,2);
  assert.deepEqual(await tool.execute({action:'get'},{agent:{id:'old'}}),regenerated.result.value);
  await events.get('agent/created')({agent:{id:'new'}});assert.equal(f.records.get('new').salt,salt(seq));assert.equal(f.records.get('new').revision,1);
  const failed=await (await route.fetch(request({action:'regenerate',sessionId:'absent'}))).json();assert.equal(failed.result.ok,false);assert.match(failed.result.error.message,/not open/);
  assert.equal((await route.fetch(new Request('http://localhost',{method:'POST',body:'plain'}))).status,415);
  for(const off of cleanups.reverse())await off();await f.service.dispose();
});
