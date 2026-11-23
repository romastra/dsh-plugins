import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { MOSAIC_WORKER_SOURCE } from '../src/mosaic-worker-source.js';
import { createIdentityService } from '../host.js';
import { selectImageSalt, allMosaicParametersDiffer } from '../image-salt.js';
import { identitySeed } from '../src/identity.js';
import { HYBRID_VARIANT, PARAMETRIC_VARIANT } from '../src/image-variant.js';
import { getFractalParameters, getFractalQuality, getMosaicParameters, hasMosaicFractal, getMosaicDataUrl } from '../src/mosaic.js';
import { createMosaicArtRuntime } from '../src/art-store.js';

const salt=n=>`${String(n).padStart(8,'0')}-0000-4000-8000-000000000000`;
function fixture(initial){let n=200,writes=0;const rows=new Map(initial?[['chat',initial]]:[]);const table={get:id=>rows.get(id),entries:()=>rows.entries(),put:async(id,value)=>{writes++;rows.set(id,value);}};return {service:createIdentityService({table,activatedAt:1000,session:id=>id==='chat'?{header:{createdAt:1}}:null,random:()=>salt(++n),generation:'presence-test'}),get writes(){return writes;}};}
test('first V2 reroll flips effective old presence: legacy OFF→ON and saved V1 ON→OFF',async()=>{
  for(const initial of [undefined,{salt:salt(1),revision:1,variant:HYBRID_VARIANT}]){
    const f=fixture(initial);const next=await f.service.regenerate('chat');const seed=identitySeed('chat',next.salt,next.variant);
    assert.equal(next.variant,PARAMETRIC_VARIANT);assert.equal(hasMosaicFractal(seed),!initial);assert.equal(f.writes,1);
    await f.service.dispose();
  }
});
test('ON/OFF toggling keeps all nineteen base inputs different without locking visible fractals to one family',async()=>{
  const f=fixture(),families=new Set();let previous=await f.service.read('chat');
  for(let i=0;i<36;i++){
    const next=await f.service.regenerate('chat',{expectedSalt:previous.salt,expectedVariant:previous.variant});
    const a=identitySeed('chat',previous.salt,previous.variant),b=identitySeed('chat',next.salt,next.variant);
    assert.notEqual(hasMosaicFractal(a),hasMosaicFractal(b));assert.equal(allMosaicParametersDiffer(getMosaicParameters(a),getMosaicParameters(b)),true);
    if(hasMosaicFractal(b)){assert.equal(getFractalQuality(b).accepted,true);families.add(getFractalParameters(b).family);}else assert.equal(getFractalQuality(b),null);
    previous=next;
  }
  assert.deepEqual([...families].sort(),['julia','mandelbrot']);await f.service.dispose();
});
test('OFF selection never calls the fractal quality probe and can accept low-contrast plain art',async()=>{
  let n=0,calls=0;const result=await selectImageSalt({sessionId:'off-without-probe',previousSalt:salt(700),previousVariant:HYBRID_VARIANT,nextVariant:PARAMETRIC_VARIANT,random:()=>salt(++n),quality:()=>{calls++;throw new Error('must not probe OFF');}});
  assert.equal(hasMosaicFractal(identitySeed('off-without-probe',result,PARAMETRIC_VARIANT)),false);assert.equal(calls,0);
});
test('plain V2 art is immediately ready and never creates a Worker or cooperative render job',async()=>{
  let off;for(let i=1;i<100;i++){const seed=identitySeed('plain-v2',salt(i),PARAMETRIC_VARIANT);if(!hasMosaicFractal(seed)){off=seed;break;}}
  assert.ok(off);let workers=0,renders=0;const runtime=createMosaicArtRuntime({Worker:class{constructor(){workers++;throw new Error('unneeded');}}},{createSvgAsync:async()=>{renders++;throw new Error('unneeded');}});
  const store=runtime.getStore(off),unsubscribe=store.subscribe(()=>{});assert.equal(await runtime.waitForArt(off),getMosaicDataUrl(off));
  assert.equal(store.getSnapshot().status,'legacy');assert.equal(workers,0);assert.equal(renders,0);assert.equal(runtime.getHealth().activeJobs,0);assert.equal(runtime.getHealth().queued,0);unsubscribe();runtime.dispose();
});
test('the freshly generated Worker returns the exact full renderer URI for BOTH V2 ON and OFF',()=>{
  let result;const self={postMessage:message=>{result=message;}};vm.runInNewContext(MOSAIC_WORKER_SOURCE,{TextEncoder,self});
  for(const enabled of [false,true]){
    let seed;for(let i=1;i<100;i++){const candidate=identitySeed('presence-worker',salt(i),PARAMETRIC_VARIANT);if(hasMosaicFractal(candidate)===enabled){seed=candidate;break;}}
    assert.ok(seed);self.onmessage({data:{id:enabled?2:1,seed}});assert.equal(result.uri,getMosaicDataUrl(seed));
  }
});
test('V2 ON routes to asynchronous rendering rather than the synchronous full renderer',()=>{
  let on;for(let i=1;i<100;i++){const seed=identitySeed('async-v2',salt(i),PARAMETRIC_VARIANT);if(hasMosaicFractal(seed)){on=seed;break;}}
  assert.ok(on);let synchronous=0;const runtime=createMosaicArtRuntime({}, {legacyUri:()=>{synchronous++;throw new Error('sync full hybrid render');}});
  const store=runtime.getStore(on);assert.equal(store.getSnapshot().status,'pending');assert.equal(synchronous,0);assert.equal(runtime.getHealth().activeJobs,0,'getSnapshot never starts rendering');runtime.dispose();
});
