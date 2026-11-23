import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { identitySeed, createIdentityClient } from '../src/identity.js';
import { HYBRID_VARIANT, PARAMETRIC_VARIANT, LEGACY_VARIANT, imageVariantFromSeed } from '../src/image-variant.js';
import { getMosaicParameters, getFractalParameters, getFractalQuality, createMosaicSvg, hasMosaicFractal } from '../src/mosaic.js';
import { createIdentityService } from '../host.js';
import { allMosaicParametersDiffer } from '../image-salt.js';
import { MOSAIC_WORKER_SOURCE } from '../src/mosaic-worker-source.js';

const salt=n=>`${String(n).padStart(8,'0')}-0000-4000-8000-000000000000`;
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(initial=new Map()){
  let n=100,writes=0;const table={get:id=>initial.get(id),entries:()=>initial.entries(),put:async(id,value)=>{writes++;initial.set(id,value);}};
  const service=createIdentityService({table,activatedAt:1000,session:id=>id==='chat'?{header:{createdAt:100}}:null,random:()=>salt(++n),generation:'hybrid-host'});
  return {service,records:initial,get writes(){return writes;},get draws(){return n-100;}};
}
test('absent legacy variant preserves the exact old identity tuple; hybrid has an explicit separate domain',()=>{
  assert.equal(identitySeed('chat',null),'chat');assert.equal(identitySeed('chat',salt(1)),JSON.stringify(['dsh-chat-image/v1',salt(1),'chat']));
  assert.equal(identitySeed('chat',salt(1),LEGACY_VARIANT),identitySeed('chat',salt(1)));
  const next=identitySeed('chat',salt(1),HYBRID_VARIANT);assert.notEqual(next,identitySeed('chat',salt(1)));assert.equal(imageVariantFromSeed(next),HYBRID_VARIANT);
  for(const seed of ['chat','[bad','["dsh-chat-image/hybrid-fractal/v1",null,"chat"]',identitySeed('chat',salt(1))])assert.equal(imageVariantFromSeed(seed),LEGACY_VARIANT);
  assert.throws(()=>identitySeed('chat',salt(1),'unknown-generation'),/Unsupported/);
});
test('mount/reopen/read does not convert a legacy image; only explicit regenerate persists hybrid metadata',async()=>{
  const f=fixture(new Map([['chat',{salt:salt(1),revision:7}]]));const legacy=await f.service.ensure('chat');
  assert.equal(legacy.variant,LEGACY_VARIANT);assert.equal(f.draws,0);assert.equal(f.writes,0);assert.equal(f.records.get('chat').variant,undefined);
  const changed=await f.service.regenerate('chat',{expectedSalt:salt(1),expectedVariant:LEGACY_VARIANT,expectedGeneration:'hybrid-host'});
  assert.equal(changed.variant,PARAMETRIC_VARIANT);assert.equal(changed.revision,8);assert.equal(f.writes,1);assert.equal(f.records.get('chat').variant,PARAMETRIC_VARIANT);
  const seed=identitySeed('chat',changed.salt,changed.variant);assert.equal(getFractalQuality(seed).accepted,true);
  assert.equal(allMosaicParametersDiffer(getMosaicParameters(identitySeed('chat',salt(1))),getMosaicParameters(seed)),true);
  await f.service.dispose();const reopened=fixture(f.records);assert.equal((await reopened.service.ensure('chat')).variant,PARAMETRIC_VARIANT);assert.equal(reopened.draws,0);assert.equal(reopened.writes,0);await reopened.service.dispose();
});
test('each subsequent reroll changes base 19 and flips presence; only ON images run the quality probe',async()=>{
  const f=fixture();let previous=await f.service.regenerate('chat');
  for(let i=0;i<6;i++){
    const current=await f.service.regenerate('chat',{expectedSalt:previous.salt,expectedVariant:PARAMETRIC_VARIANT});
    const before=identitySeed('chat',previous.salt,previous.variant),after=identitySeed('chat',current.salt,current.variant);
    assert.equal(allMosaicParametersDiffer(getMosaicParameters(before),getMosaicParameters(after)),true);
    assert.notEqual(hasMosaicFractal(before),hasMosaicFractal(after));
    if(hasMosaicFractal(after))assert.equal(getFractalQuality(after).accepted,true);
    else assert.equal(getFractalQuality(after),null);
    previous=current;
  }
  assert.equal(f.writes,7);await f.service.dispose();
});
test('stale variant reference fails before sampling or persistence',async()=>{
  const f=fixture(new Map([['chat',{salt:salt(1),revision:1,variant:HYBRID_VARIANT}]]));
  await assert.rejects(f.service.regenerate('chat',{expectedSalt:salt(1),expectedVariant:LEGACY_VARIANT}),/already changed/);
  assert.equal(f.draws,0);assert.equal(f.writes,0);await f.service.dispose();
});
test('the Client watch baseline and successful mutation carry hybrid version consistently to every seed consumer',async()=>{
  const requests=[],call=(payload,signal)=>new Promise((resolve,reject)=>{requests.push({payload,resolve});signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
  const client=createIdentityClient({call});client.start();requests[0].resolve({ok:true,value:{generation:'h',revision:1,records:[{sessionId:'chat',salt:salt(1),revision:1}]}});await tick();
  assert.equal(client.seed('chat'),identitySeed('chat',salt(1)));
  const operation=client.regenerate('chat',salt(1),LEGACY_VARIANT),request=requests.find(x=>x.payload.action==='regenerate');assert.equal(request.payload.expectedVariant,LEGACY_VARIANT);
  request.resolve({ok:true,value:{sessionId:'chat',salt:salt(2),revision:2,variant:HYBRID_VARIANT,generation:'h',catalogRevision:2}});await operation;
  assert.equal(client.seed('chat'),identitySeed('chat',salt(2),HYBRID_VARIANT));client.stop();await tick();
});
test('actual UI paths use async art snapshots; composer can receive the ready URI without changing base geometry',()=>{
  const client=readFileSync(new URL('../src/client.js',import.meta.url),'utf8'),raster=readFileSync(new URL('../src/raster.js',import.meta.url),'utf8');
  assert.doesNotMatch(client,/getMosaicDataUrl\(/,'no synchronous fractal renderer is called by a React path');
  assert.match(client,/composerIdentityCss\(sessionId, seed, art\.uri\)/);assert.match(client,/getMosaicCanvasColor\(seed\)/);
  assert.match(client,/disposeMosaicArtRuntime\(\)/);assert.match(raster,/await waitForMosaicArt\(sessionId, environment, needed\)/);
});
test('generated Worker executes the exact shared renderer and never accepts user content as code',()=>{
  let result;const self={postMessage:value=>{result=value;}};vm.runInNewContext(MOSAIC_WORKER_SOURCE,{TextEncoder,self});
  const seed=identitySeed('worker-hybrid',salt(7),HYBRID_VARIANT);self.onmessage({data:{id:1,seed}});
  assert.equal(result.id,1);assert.equal(decodeURIComponent(result.uri.split(',').slice(1).join(',')),createMosaicSvg(seed));
  self.onmessage({data:{id:2,seed:{bad:true}}});assert.match(result.error,/Invalid/);
  const manifest=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
  for(const dependency of ['src/mosaic.js','src/fractal.js','src/image-variant.js','src/identity.js','image-salt.js'])assert.ok(manifest.files.includes(dependency),dependency);
});
