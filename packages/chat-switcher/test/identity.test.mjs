import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdentityClient, identitySeed } from '../src/identity.js';
import { getMosaicDataUrl } from '../src/mosaic.js';
import { composerIdentityCss } from '../src/composer.js';
import { chatBackdropCss, mosaicWallpaper } from '../src/backdrop.js';
import { getRasterWallpaperStore } from '../src/raster.js';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const record=(revision,salt='salt-'+revision)=>({sessionId:'a',salt,revision,generation:'h',catalogRevision:revision});
function fixture() {
  const requests=[];
  const call=(payload,signal)=>new Promise((resolve,reject)=>{
    requests.push({payload,resolve,reject});
    signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
  });
  const client=createIdentityClient({call});
  return {client,requests};
}
test('salt is prepended with unambiguous boundaries while legacy inputs remain byte-identical',()=>{
  assert.equal(identitySeed('chat',null),'chat');assert.equal(identitySeed('chat',''),'chat');
  assert.notEqual(identitySeed('bc','a'),identitySeed('c','ab'));
  assert.ok(identitySeed('session','salt').indexOf('salt')<identitySeed('session','salt').indexOf('session'));
  assert.notEqual(getMosaicDataUrl(identitySeed('chat','one')),getMosaicDataUrl(identitySeed('chat','two')));
});
test('reroll carries the rendered salt reference and generation instead of silently replacing a newer unseen image',async()=>{
  const {client,requests}=fixture();client.start();requests[0].resolve({ok:true,value:{generation:'h',revision:1,records:[record(1,'current-store')]}});await tick();
  const operation=client.regenerate('a','rendered-older');const request=requests.find(x=>x.payload.action==='regenerate');
  assert.deepEqual(request.payload,{action:'regenerate',sessionId:'a',expectedSalt:'rendered-older',expectedVariant:'legacy',expectedGeneration:'h'});
  request.resolve({ok:false,error:{message:'Chat image already changed; refresh and try again'}});await assert.rejects(operation,/already changed/);
  assert.equal(client.seed('a'),identitySeed('a','current-store'));assert.equal(client.getSnapshot().busy.size,0);client.stop();await tick();
});
test('confirmed salt synchronizes consumers and stale watch replies cannot undo a click',async()=>{
  const {client,requests}=fixture();client.start();
  requests[0].resolve({ok:true,value:{generation:'h',revision:0,records:[]}});await tick();
  assert.equal(client.getSnapshot().status,'ready');assert.equal(client.seed('a'),'a');
  const changed=client.regenerate('a');assert.equal(client.getSnapshot().busy.has('a'),true);
  requests.find(x=>x.payload.action==='regenerate').resolve({ok:true,value:record(2)});await changed;
  const seed=client.seed('a');assert.equal(seed,identitySeed('a','salt-2'));assert.equal(client.getSnapshot().busy.size,0);
  requests[1].resolve({ok:true,value:{generation:'h',revision:1,records:[record(1)]}});await tick();
  assert.equal(client.seed('a'),seed,'older pending subscription cannot restore stale art');
  assert.equal(client.seed('b'),'b');client.stop();await tick();
});
test('a local mutation never skips concurrent changes to other chats in the shared cursor',async()=>{
  const {client,requests}=fixture();client.start();
  requests[0].resolve({ok:true,value:{generation:'h',revision:1,records:[]}});await tick();
  const local=client.regenerate('a');
  requests.find(x=>x.payload.action==='regenerate').resolve({ok:true,value:record(3)});await local;
  requests[1].resolve({ok:true,value:{generation:'h',revision:2,records:[{sessionId:'b',salt:'external-b',revision:1}]}});await tick();
  assert.equal(client.seed('b'),identitySeed('b','external-b'));
  assert.equal(client.seed('a'),identitySeed('a','salt-3'));
  assert.deepEqual(requests.at(-1).payload,{action:'watch',generation:'h',revision:2},'cursor describes the entire catalog, not one mutation');
  client.stop();await tick();
});
test('a new Host baseline replaces previous generations but retains a confirmed newer same-generation click',async()=>{
  const {client,requests}=fixture();client.start();
  requests[0].resolve({ok:true,value:{generation:'h',revision:1,records:[{sessionId:'b',salt:'old-b',revision:1}]}});await tick();
  const local=client.regenerate('a');requests.find(x=>x.payload.action==='regenerate').resolve({ok:true,value:{...record(1),generation:'new-host'}});await local;
  requests[1].resolve({ok:true,value:{generation:'new-host',revision:0,records:[]}});await tick();
  assert.equal(client.seed('b'),'b');assert.equal(client.seed('a'),identitySeed('a','salt-1'));client.stop();await tick();
});
test('a delayed mutation reply from a retired Host cannot overwrite an accepted new Host baseline',async()=>{
  const {client,requests}=fixture();client.start();
  requests[0].resolve({ok:true,value:{generation:'old',revision:1,records:[{sessionId:'a',salt:'old-one',revision:1}]}});await tick();
  const local=client.regenerate('a');
  requests[1].resolve({ok:true,value:{generation:'new',revision:1,records:[{sessionId:'a',salt:'new-three',revision:3}]}});await tick();
  requests.find(x=>x.payload.action==='regenerate').resolve({ok:true,value:{sessionId:'a',salt:'old-two',revision:2,generation:'old',catalogRevision:2}});await local;
  assert.equal(client.seed('a'),identitySeed('a','new-three'));
  assert.deepEqual(requests.at(-1).payload,{action:'watch',generation:'new',revision:1});client.stop();await tick();
});
test('duplicate clicks share one mutation; a storage failure keeps the previous art and is visible',async()=>{
  const {client,requests}=fixture();const first=client.regenerate('a'),second=client.regenerate('a');assert.equal(first,second);assert.equal(requests.length,1);
  requests[0].resolve({ok:false,error:{message:'Disk full'}});await assert.rejects(first,/Disk full/);
  assert.equal(client.seed('a'),'a');assert.equal(client.getSnapshot().errors.get('a'),'Disk full');assert.equal(client.getSnapshot().busy.size,0);client.stop();
});
test('stop aborts subscriptions, mutations, and pending retry timers',async()=>{
  const {client,requests}=fixture();client.start();const mutation=client.regenerate('a');const rejected=assert.rejects(mutation,/aborted|cancelled/);client.stop();await rejected;await tick();
  const timers=new Map();let number=0;const failing=createIdentityClient({call:async()=>{throw new Error('offline');},later:fn=>{timers.set(++number,fn);return number;},cancel:id=>timers.delete(id)});
  failing.start();await tick();assert.equal(timers.size,1);failing.stop();await tick();assert.equal(timers.size,0);
  assert.equal(createIdentityClient().getSnapshot().status,'unavailable');
});
test('one salted seed keys vector, backdrop and lazy raster caches without changing CSS session scope',()=>{
  const id='salt-cache-test',one=identitySeed(id,'one'),two=identitySeed(id,'two');
  const button=composerIdentityCss(id,one),wall=mosaicWallpaper(one),raster=getRasterWallpaperStore(one);
  assert.ok(button.includes(getMosaicDataUrl(one)));assert.notEqual(mosaicWallpaper(two).image,wall.image);
  assert.equal(getRasterWallpaperStore(one),raster);assert.notEqual(getRasterWallpaperStore(two),raster);
  const css=chatBackdropCss(id,wall,one);assert.ok(css.includes(wall.image));assert.ok(css.includes('data-conversation-session='));assert.equal(css.includes(one),false);
  assert.equal(button.includes(one),false);assert.notEqual(composerIdentityCss(id,two),button);
});
