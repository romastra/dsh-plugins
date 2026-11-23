import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { prepareRasterWallpaper } from '../src/raster.js';
import { mosaicWallpaper } from '../src/backdrop.js';
import { getMosaicDataUrl } from '../src/mosaic.js';

function environment() {
  const calls=[];let canvas;
  return {calls,get canvas(){return canvas},Image:class {
    constructor(w,h){calls.push(['Image',w,h])}
    async decode(){calls.push(['decode',this.src])}
  },document:{createElement(tag){
    assert.equal(tag,'canvas');
    canvas={width:0,height:0,getContext(type,options){calls.push(['context',type,options]);return{set fillStyle(color){calls.push(['fillStyle',color])},fillRect(...args){calls.push(['fillRect',...args])},drawImage(image,...args){calls.push(['drawImage',image.src,...args])}}},toDataURL(type){calls.push(['encode',type]);return 'data:image/png;base64,AQID'}};
    return canvas;
  }}};
}

test('only the background is rasterized at512 losslessly with the exact canvas color',async()=>{
  const env=environment(),result=await prepareRasterWallpaper('raster-chat',env);
  assert.equal(result.kind,'raster');assert.equal(result.resolution,512);assert.equal(result.color,mosaicWallpaper('raster-chat').color);
  assert.deepEqual(env.calls.find(x=>x[0]==='Image'),['Image',512,512]);
  assert.deepEqual(env.calls.find(x=>x[0]==='drawImage'),['drawImage',getMosaicDataUrl('raster-chat'),0,0,512,512]);
  assert.deepEqual(env.calls.find(x=>x[0]==='fillStyle'),['fillStyle',result.color]);
  assert.deepEqual(env.calls.find(x=>x[0]==='encode'),['encode','image/png']);
  const svg=decodeURIComponent(result.image.split(',')[1]);
  assert.ok(svg.includes('<image x="10%" y="10%" width="80%" height="80%" preserveAspectRatio="xMidYMid meet" href="data:image/png;base64,AQID"/>'));
  assert.equal(/<filter|<mask|<polygon/.test(svg),false);
  assert.equal(env.canvas.width,0);assert.equal(env.canvas.height,0);
});

test('failed encoding still releases canvas allocation',async()=>{
  const env=environment(),create=env.document.createElement;
  env.document.createElement=tag=>{const canvas=create(tag);canvas.toDataURL=()=>{throw Error('encode failed')};return canvas};
  await assert.rejects(prepareRasterWallpaper('broken',env),/encode failed/);
  assert.equal(env.canvas.width,0);assert.equal(env.canvas.height,0);
});

function storeHarness(){
  let rasterCalls=0;const pending=[];
  const source=readFileSync(new URL('../src/raster.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'');
  const context=vm.createContext({getMosaicCanvasColor:()=> '#112233',getMosaicArtStore:id=>({getSnapshot:()=>({uri:'svg:'+id,status:'legacy'})}),waitForMosaicArt:async id=>'svg:'+id,mosaicWallpaper:id=>Object.freeze({color:'#112233',image:'vector:'+id})});
  vm.runInContext(source+'\nthis.api={getRasterWallpaperStore,rasterWallpaperCache,queuedRasterStores,pendingRasterStores,activeRasterStores,RASTER_CACHE_LIMIT,setRaster:fn=>{prepareRasterWallpaper=fn}};',context);
  context.api.setRaster(id=>{rasterCalls++;return new Promise((resolve,reject)=>pending.push({id,resolve,reject}))});
  return{api:context.api,pending,calls:()=>rasterCalls};
}

test('stores dedupe work, unsubscribe isolates old sessions, cached results survive remount',async()=>{
  const f=storeHarness(),a=f.api.getRasterWallpaperStore('a');
  assert.equal(a.getSnapshot().kind,'pending');assert.equal(a.getSnapshot().image,'');assert.equal(f.calls(),0);
  assert.equal(f.api.getRasterWallpaperStore('a'),a);
  let oldNotifications=0,currentNotifications=0;
  const off=a.subscribe(()=>oldNotifications++);a.subscribe(()=>currentNotifications++);off();assert.equal(f.calls(),1);
  const b=f.api.getRasterWallpaperStore('b');b.subscribe(()=>{});
  f.pending.find(x=>x.id==='a').resolve(Object.freeze({color:'#112233',image:'png:a',kind:'raster',resolution:512}));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(oldNotifications,0);assert.equal(currentNotifications,1);assert.equal(a.getSnapshot().image,'png:a');assert.equal(b.getSnapshot().image,'');
  const same=f.api.getRasterWallpaperStore('a');same.subscribe(()=>{});assert.equal(same.getSnapshot(),a.getSnapshot());assert.equal(f.calls(),2);
});

test('cancelled decoding skips canvas allocation and expensive PNG encoding',async()=>{
  const env=environment();let needed=true;
  env.Image=class{async decode(){needed=false}};
  await assert.rejects(prepareRasterWallpaper('cancelled',env,()=>needed),{name:'AbortError'});
  assert.equal(env.canvas,undefined);
});

test('rapid switching cancels queued jobs, dedupes evicted pending IDs and serializes work',async()=>{
  const f=storeHarness(),a=f.api.getRasterWallpaperStore('a');
  const offA=a.subscribe(()=>{});offA();
  const offs=[];
  for(let i=0;i<24;i++)offs.push(f.api.getRasterWallpaperStore('queued-'+i).subscribe(()=>{}));
  assert.equal(f.calls(),1,'only one SVG decode runs at a time');
  assert.equal(f.api.getRasterWallpaperStore('a'),a,'eviction does not duplicate inflight work');
  for(const off of offs.slice(0,-1))off();
  assert.equal(f.api.queuedRasterStores.size,1);
  f.pending[0].resolve({kind:'raster',image:'unused'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(a.getSnapshot().kind,'pending','departed chat never publishes stale raster');
  assert.equal(f.calls(),2);assert.equal(f.pending[1].id,'queued-23');
  f.pending[1].resolve({kind:'raster',image:'last'});
  await new Promise(resolve=>setImmediate(resolve));
  offs.at(-1)();
  assert.equal(f.api.pendingRasterStores.size,0);assert.equal(f.api.activeRasterStores.size,0);assert.equal(f.api.queuedRasterStores.size,0);
});

test('a transient raster failure retries on a later mount',async()=>{
  const f=storeHarness(),a=f.api.getRasterWallpaperStore('a'),off=a.subscribe(()=>{});
  f.pending[0].reject(Error('temporary'));
  await new Promise(resolve=>setImmediate(resolve));off();
  assert.equal(a.getSnapshot().kind,'vector-fallback');
  a.subscribe(()=>{});assert.equal(f.calls(),2);
  f.pending[1].resolve({kind:'raster',image:'recovered'});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(a.getSnapshot().image,'recovered');
});

test('failure falls back safely and cache is bounded, while empty sessions do no work',async()=>{
  const f=storeHarness();assert.equal(f.api.getRasterWallpaperStore(undefined).getSnapshot(),null);
  const a=f.api.getRasterWallpaperStore('a');a.subscribe(()=>{});f.pending[0].reject(Error('unavailable'));
  await new Promise(resolve=>setImmediate(resolve));assert.equal(a.getSnapshot().kind,'vector-fallback');assert.equal(a.getSnapshot().image,'vector:a');
  for(let i=0;i<40;i++)f.api.getRasterWallpaperStore('chat-'+i);
  assert.equal(f.api.rasterWallpaperCache.size,16);assert.equal(f.calls(),1);
});
