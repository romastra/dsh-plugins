import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function harness() {
  const context=vm.createContext({TextEncoder,encodeURIComponent,decodeURIComponent});
  const sources=['mosaic','composer','backdrop'].map(name=>readFileSync(new URL('../src/'+name+'.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,''));
  // Instrument only the test copy, leaving the production API untouched.
  sources[0]=sources[0].replace('function createMosaicSvg(sessionId) {','function createMosaicSvg(sessionId) { generationCount++;');
  sources[2]=sources[2].replace('const svg = decodeURIComponent(', 'wrapperCount++; const svg = decodeURIComponent(');
  const prelude=['image-variant','fractal'].map(name=>readFileSync(new URL('../src/'+name+'.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'')).join('\n');
  vm.runInContext('let generationCount=0,wrapperCount=0;\n'+prelude+'\n'+sources.join('\n')+'\nthis.api={getMosaicDataUrl,composerIdentityCss,chatBackdropCss,mosaicWallpaper,wallpaperCache,WALLPAPER_CACHE_LIMIT,counts:()=>({generationCount,wrapperCount})};',context);
  return context.api;
}

test('button, modal, Workspace hover and wallpaper share one algorithm run per cached chat', () => {
  const api=harness();
  api.composerIdentityCss('one-chat');
  const preview=api.getMosaicDataUrl('one-chat');
  assert.equal(api.getMosaicDataUrl('one-chat'),preview);
  api.chatBackdropCss('one-chat');
  const first=api.mosaicWallpaper('one-chat');
  for(let i=0;i<10;i++){
    api.composerIdentityCss('one-chat');api.getMosaicDataUrl('one-chat');api.chatBackdropCss('one-chat');
    assert.equal(api.mosaicWallpaper('one-chat'),first,'the same finished wallpaper record is reused');
  }
  assert.equal(api.counts().generationCount,1);
  assert.equal(api.counts().wrapperCount,1);
  assert.ok(Object.isFrozen(first));
  assert.throws(()=>{first.color='red'},TypeError);
});

test('derived wallpaper cache is LRU-bounded and evictions reuse the base SVG', () => {
  const api=harness(),first=api.mosaicWallpaper('first');
  for(let i=1;i<api.WALLPAPER_CACHE_LIMIT;i++)api.mosaicWallpaper('other-'+i);
  assert.equal(api.wallpaperCache.size,16);
  assert.equal(api.mosaicWallpaper('first'),first); // refresh oldest
  api.mosaicWallpaper('extra');
  assert.equal(api.wallpaperCache.size,16);
  assert.ok(api.wallpaperCache.has('first'));
  assert.equal(api.wallpaperCache.has('other-1'),false);
  const count=api.counts().generationCount;
  api.mosaicWallpaper('other-1');
  assert.equal(api.counts().generationCount,count,'rebuilding only the cheap wrapper does not rerun geometry');
  for(let i=0;i<40;i++)api.mosaicWallpaper('sweep-'+i);
  assert.equal(api.wallpaperCache.size,16);
});

test('cached wallpaper is byte-for-byte identical to the previous uncached preparation', () => {
  const api=harness();
  for(const id of ['a','b','chat-a','Привет 😀','x"{};/*']){
    const uri=api.getMosaicDataUrl(id),svg=decodeURIComponent(uri.slice(uri.indexOf(',')+1));
    const color=svg.match(/<rect x="-1" y="-1" width="2" height="2" fill="(#[0-9a-f]{6})"\/>/i)[1];
    const inset=svg.replace('width="272" height="272"','x="10%" y="10%" width="80%" height="80%" preserveAspectRatio="xMidYMid meet"');
    const old='<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"><rect width="100%" height="100%" fill="'+color+'"/>'+inset+'</svg>';
    const result=api.mosaicWallpaper(id);
    assert.equal(result.image,'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(old));
    assert.equal(result.color,color);
  }
});
