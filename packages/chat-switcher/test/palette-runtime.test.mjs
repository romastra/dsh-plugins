import test from 'node:test';
import assert from 'node:assert/strict';
import { readChatPaletteSource, createChatPaletteRuntime, createChatThemeSource, chatPaletteBodyCss } from '../src/palette-runtime.js';
import { adaptPalette, parsePaletteColor, paletteLuminance } from '../src/palette.js';

const prefix='--dsw-static-deepseek-';
const sample=Object.freeze({[prefix+'50']:'#edf3fe',[prefix+'500']:'#4176e6',[prefix+'700-delete']:'#2f4c8f'});
function declaration(values) {
  const names=Object.keys(values);
  return {length:names.length,item:index=>names[index],getPropertyValue:name=>values[name]??''};
}
function probeStyle(initial='',priority='') {
  let value=initial,importance=priority;
  return {getPropertyValue:()=>value,getPropertyPriority:()=>importance,setProperty:(_name,next,p='')=>{value=next;importance=p;},removeProperty:()=>{value='';importance='';}};
}
test('CSS source discovers arbitrary brand suffixes and copies live values while only its own sheet is disabled',()=>{
  const values={...sample,[prefix+'custom_42']:'rgb(48, 72, 110)','--dsw-static-red-500':'red','--dsw-alias-link':'blue'};
  const sheet={disabled:false},body={},probe={style:probeStyle('green','important')};
  const view={getComputedStyle(node){assert.equal(node,body);assert.equal(sheet.disabled,true);return declaration(values);}};
  const source=readChatPaletteSource({view,body,styleElement:{sheet},probe});
  assert.deepEqual(Object.keys(source).sort(),Object.keys(values).filter(x=>x.startsWith(prefix)).sort());
  assert.equal(Object.isFrozen(source),true);assert.equal(source[prefix+'700-delete'],'#2f4c8f');
  values[prefix+'500']='red';assert.equal(source[prefix+'500'],'#4176e6','a live CSSStyleDeclaration is not retained');
  assert.equal(sheet.disabled,false);assert.equal(probe.style.getPropertyValue('color'),'green');assert.equal(probe.style.getPropertyPriority('color'),'important');
});
test('baseline sampling never consumes its own generated colors and restores a previously disabled sheet',()=>{
  const sheet={disabled:false},body={};
  const view={getComputedStyle(){return declaration({[prefix+'500']:sheet.disabled?'#4176e6':'#000000'});}};
  const input={view,body,styleElement:{sheet}};
  assert.equal(readChatPaletteSource(input)[prefix+'500'],'#4176e6');assert.equal(sheet.disabled,false);
  sheet.disabled=true;assert.equal(readChatPaletteSource(input)[prefix+'500'],'#4176e6');assert.equal(sheet.disabled,true);
});
test('unsupported CSS colors are resolved on the owned probe, not by modifying body or using a canvas',()=>{
  const body=Object.freeze({}),sheet={disabled:false},probe={style:probeStyle('previous')};
  const view={getComputedStyle(node){assert.equal(sheet.disabled,true);if(node===body)return declaration({[prefix+'900']:'named-color'});assert.equal(node,probe);assert.equal(probe.style.getPropertyValue('color'),'named-color');return {color:'rgb(40, 49, 66)'};}};
  const source=readChatPaletteSource({view,body,styleElement:{sheet},probe});
  assert.equal(source[prefix+'900'],'rgb(40, 49, 66)');assert.equal(probe.style.getPropertyValue('color'),'previous');assert.equal(sheet.disabled,false);
});
test('failed or empty CSS sampling restores the stylesheet before falling back',()=>{
  const sheet={disabled:false},body={},probe={style:probeStyle('saved')};
  assert.throws(()=>readChatPaletteSource({view:{getComputedStyle(){throw new Error('CSS inaccessible');}},body,styleElement:{sheet},probe}),/CSS inaccessible/);
  assert.equal(sheet.disabled,false);assert.equal(probe.style.getPropertyValue('color'),'saved');
  assert.throws(()=>readChatPaletteSource({view:{getComputedStyle:()=>declaration({'--dsw-static-red-500':'#ff0000'})},body,styleElement:{sheet}}),/No readable brand colors/);
  assert.equal(sheet.disabled,false);
});
test('body CSS accepts only brand color declarations, never status/semantic tokens or injected CSS',()=>{
  const css=chatPaletteBodyCss(sample);
  assert.ok(css.startsWith('body{'));assert.ok(css.includes(prefix+'700-delete:#2f4c8f!important;'));
  assert.throws(()=>chatPaletteBodyCss({'--dsw-alias-state-error-primary':'#ff0000'}),/Invalid/);
  assert.throws(()=>chatPaletteBodyCss({[prefix+'bad;body']:'#ff0000'}),/Invalid/);
  assert.throws(()=>chatPaletteBodyCss({[prefix+'500']:'red;}body{display:none'}),/Invalid/);
  assert.equal(chatPaletteBodyCss({}),'');
});
test('runtime transfers the accent with checked Y, caches original+image pairs, and never drifts across A/B/A',()=>{
  let calculations=0,samples=0,notifications=0;
  const runtime=createChatPaletteRuntime({transform:(...args)=>{calculations++;return adaptPalette(...args);}});
  runtime.subscribe(()=>notifications++);
  const read=()=>{samples++;return sample;};
  const a=runtime.update('#c9d487',read);assert.equal(a.status,'ready');assert.equal(a.count,3);assert.ok(a.maxYError<1e-6);assert.ok(!a.css.includes('error-primary'));
  const first=a.css;runtime.update('#c9d487',read);assert.equal(notifications,1);assert.equal(calculations,1);
  const b=runtime.update('#50459b',read);assert.notEqual(b.css,first);
  runtime.update('#c9d487',read);assert.equal(runtime.getSnapshot().css,first);assert.equal(calculations,2);assert.equal(samples,4);
  assert.equal(sample[prefix+'500'],'#4176e6');runtime.dispose();
});
test('the same image uses a fresh baseline after theme changes, without depending on token counts or names',()=>{
  const runtime=createChatPaletteRuntime();
  const before=runtime.update('#a1683c',()=>sample).css;
  const changed={...sample,[prefix+'500']:'#7aaaff',[prefix+'future-extra-step']:'#4868b2'};
  const after=runtime.update('#a1683c',()=>changed);
  assert.equal(after.count,4);assert.notEqual(after.css,before);assert.ok(after.css.includes(prefix+'future-extra-step:'));
  runtime.dispose();
});
test('invalid generated tokens or changed luminance fall back to native CSS, not the last chat palette',()=>{
  const warnings=[];let invalid=false;
  const runtime=createChatPaletteRuntime({onError:x=>warnings.push(x),transform:(source,color)=>invalid?{colors:{...source,[prefix+'500']:'#000000'}}:adaptPalette(source,color)});
  runtime.update('#6abfc6',()=>sample);assert.equal(runtime.getSnapshot().status,'ready');
  invalid=true;runtime.update('#9f4e44',()=>sample);assert.equal(runtime.getSnapshot().status,'fallback');assert.equal(runtime.getSnapshot().css,'');assert.equal(warnings.length,1);
  runtime.update('#5cab5e',()=>sample);assert.equal(warnings.length,1,'the same fallback reason does not toast/log every chat tick');
  invalid=false;runtime.update('#5cab5e',()=>sample);assert.equal(runtime.getSnapshot().status,'ready');runtime.dispose();
});
test('generated status-token writes and alpha changes are refused even if RGB luminance matches',()=>{
  const extra=createChatPaletteRuntime({transform:source=>({colors:{...source,'--dsw-static-red-500':'#ff0000'}})});
  assert.equal(extra.update('#6abfc6',()=>sample).status,'fallback');assert.equal(extra.getSnapshot().css,'');extra.dispose();
  const alpha=createChatPaletteRuntime({transform:source=>({colors:Object.fromEntries(Object.entries(source).map(([name,value])=>{const rgb=parsePaletteColor(value);return [name,`color(srgb ${rgb[0]} ${rgb[1]} ${rgb[2]} / 0.5)`];}))})});
  assert.equal(alpha.update('#6abfc6',()=>sample).status,'fallback');alpha.dispose();
});
test('missing active chat, stylesheet errors, and unload clear the owned CSS and detach listeners',()=>{
  const runtime=createChatPaletteRuntime();let notifications=0;runtime.subscribe(()=>notifications++);
  runtime.update('#6abfc6',()=>sample);assert.ok(runtime.getSnapshot().css);
  runtime.update(null,()=>{throw new Error('must not sample');});assert.equal(runtime.getSnapshot().status,'inactive');assert.equal(runtime.getSnapshot().css,'');
  runtime.update('#6abfc6',()=>{throw new Error('CSS failed');});assert.equal(runtime.getSnapshot().status,'fallback');assert.equal(runtime.getSnapshot().css,'');
  runtime.dispose();const count=notifications;runtime.update('#6abfc6',()=>sample);assert.equal(notifications,count);assert.equal(runtime.getSnapshot().css,'');
});
test('CSS namespace is case-sensitive and one unsupported color never produces a mixed partial palette',()=>{
  const body={},sheet={disabled:false};
  const values={...sample,'--DSW-STATIC-DEEPSEEK-500':'#ffffff',[prefix+'Extra-Step']:'#34415b'};
  const view={getComputedStyle:()=>declaration(values)};
  const source=readChatPaletteSource({view,body,styleElement:{sheet}});
  assert.equal(source['--DSW-STATIC-DEEPSEEK-500'],undefined);assert.equal(source[prefix+'Extra-Step'],'#34415b');
  values[prefix+'500']='color(display-p3 1 0 0)';
  assert.throws(()=>readChatPaletteSource({view,body,styleElement:{sheet}}),/Unsupported brand color/);assert.equal(sheet.disabled,false);
});
test('derived palette cache is LRU bounded',()=>{
  let calculations=0;
  const runtime=createChatPaletteRuntime({cacheLimit:2,transform:(...args)=>{calculations++;return adaptPalette(...args);}});
  for(const color of ['#9f4e44','#6abfc6','#a057a3','#9f4e44'])runtime.update(color,()=>sample);
  assert.equal(calculations,4);runtime.dispose();
});
test('theme notifications coalesce after native presenter, independent of listener ordering',()=>{
  let theme={revision:0},presented=0,listener,offCount=0,notifications=0;
  const queued=[];
  const source=createChatThemeSource({read:()=>theme,listen:fn=>{listener=fn;return ()=>offCount++;},defer:fn=>queued.push(fn)});
  source.subscribe(()=>{notifications++;assert.equal(presented,theme.revision,'presenter ran before consumers see a new snapshot');});
  queued.shift()();
  theme={revision:1};listener();assert.equal(source.getSnapshot().revision,0);assert.equal(notifications,0);
  presented=1;theme={revision:2};listener();presented=2;
  assert.equal(queued.length,1);queued.shift()();assert.equal(source.getSnapshot().revision,2);assert.equal(notifications,1);
  theme={revision:3};listener();source.dispose();queued.shift()();assert.equal(notifications,1);assert.equal(offCount,1);
});
