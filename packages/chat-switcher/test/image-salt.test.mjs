import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { selectImageSalt, allMosaicParametersDiffer } from '../image-salt.js';
import { getMosaicParameters } from '../src/mosaic.js';
import { identitySeed } from '../src/identity.js';

const salt=n=>`${String(n).padStart(8,'0')}-0000-4000-8000-000000000000`;
const base={axes:1, colors:2, palette:['red','blue'], rotation:0.1, composition:0};
const changed={axes:2, colors:3, palette:['blue','red','green'], rotation:0.2, composition:1};
test('installed package includes every pure Host dependency, without importing Host policy into browser code',()=>{
  const manifest=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
  for(const dependency of ['host.js','image-salt.js','src/mosaic.js','src/identity.js'])assert.ok(manifest.files.includes(dependency),dependency);
  assert.doesNotMatch(readFileSync(new URL('../build.mjs',import.meta.url),'utf8'),/name of \[[^\]]*image-salt/);
});
test('every field must differ; one identical field rejects even an otherwise different image',()=>{
  assert.equal(allMosaicParametersDiffer(base,changed),true);
  for(const key of Object.keys(base))assert.equal(allMosaicParametersDiffer(base,{...changed,[key]:base[key]}),false,key);
  assert.equal(allMosaicParametersDiffer(base,{...changed,palette:['red','green','blue']}),false,'canvas/first palette color must change');
  assert.equal(allMosaicParametersDiffer(base,{...changed,palette:['green','blue','red']}),false,'matching second palette position must change');
});
test('missing/extra/unsupported/invalid values cannot be mistaken for an all-parameter change',()=>{
  for(const value of [null,{}, {...changed,extra:1},{...changed,axes:NaN},{...changed,axes:'2'},{...changed,rotation:undefined},{...changed,palette:[]},{...changed,palette:{} }])assert.equal(allMosaicParametersDiffer(base,value),false);
});
test('search skips unchanged salt and every rejected candidate, then returns only a complete match',async()=>{
  const attempts=[salt(1),salt(2),salt(2),salt(3)],seen=[];
  const parameters=seed=>{seen.push(seed);return seed===identitySeed('a',salt(3))?changed:base;};
  const value=await selectImageSalt({sessionId:'a',previousSalt:salt(1),random:()=>attempts.shift(),parameters});
  assert.equal(value,salt(3));assert.deepEqual(seen,[identitySeed('a',salt(1)),identitySeed('a',salt(2)),identitySeed('a',salt(3))],'duplicate salts do not repeatedly compute metadata');
});
test('legacy unsalted image is the reference, and rejected candidates do not advance that reference',async()=>{
  let n=0;const seen=[];
  assert.equal(await selectImageSalt({sessionId:'legacy',random:()=>salt(++n),parameters:seed=>{seen.push(seed);return seed===identitySeed('legacy',salt(3))?changed:base;}}),salt(3));
  assert.equal(seen[0],'legacy');assert.equal(seen.length,4);
});
test('bounded batches yield without weakening acceptance and broken entropy fails closed',async()=>{
  let yields=0,calls=0,metadata=0;
  await assert.rejects(selectImageSalt({sessionId:'a',random:()=>{calls++;return salt(1);},parameters:()=>{metadata++;return base;},maxAttempts:5,batchSize:2,yieldControl:async()=>{yields++;}}),/every parameter changed; previous image kept/);
  assert.equal(calls,5);assert.equal(yields,2);assert.equal(metadata,2,'baseline plus one distinct candidate only');
});
test('abort/unload while yielded stops before further entropy or metadata work',async()=>{
  let cancelled=false,calls=0;
  await assert.rejects(selectImageSalt({sessionId:'a',random:()=>salt(++calls),parameters:()=>base,batchSize:2,shouldAbort:()=>cancelled,yieldControl:async()=>{cancelled=true;}}),/cancelled or unloaded/);
  assert.equal(calls,2);
  await assert.rejects(selectImageSalt({sessionId:'a',random:()=>{throw new Error('must not run');},shouldAbort:()=>true}),/cancelled or unloaded/);
});
test('invalid entropy/reference/budget errors never return an accepted salt',async()=>{
  for(const value of [null,7,'salt','','-'.repeat(36),'000000000-000-4000-8000-000000000000','00000000-0000-9000-8000-000000000000','00000000-0000-4000-0000-000000000000'])await assert.rejects(selectImageSalt({sessionId:'a',random:()=>value}),/generate a new image salt/);
  await assert.rejects(selectImageSalt({sessionId:'a',previousSalt:'invalid',random:randomUUID}),/Invalid image reference/);
  for(const maxAttempts of [0,-1,NaN,1.5,65537])await assert.rejects(selectImageSalt({sessionId:'a',random:randomUUID,maxAttempts}),/budget/);
});
test('real deterministic generator: every accepted reroll changes all 19 inputs and each aligned palette entry',async()=>{
  for(let i=0;i<32;i++){
    const sessionId='parameter-search-'+i,previousSalt=i%2?salt(500+i):null;let seq=i*1000;
    const next=await selectImageSalt({sessionId,previousSalt,random:()=>salt(++seq)});
    const before=getMosaicParameters(identitySeed(sessionId,previousSalt)),after=getMosaicParameters(identitySeed(sessionId,next));
    assert.equal(Object.keys(before).length,19);assert.equal(allMosaicParametersDiffer(before,after),true);
    for(const key of Object.keys(before))if(key!=='palette')assert.notEqual(before[key],after[key],key);
    for(let p=0;p<Math.min(before.palette.length,after.palette.length);p++)assert.notEqual(before.palette[p],after.palette[p]);
  }
});
