import test from 'node:test';
import assert from 'node:assert/strict';
import { largestTaskFont, bindTaskFit, TASK_FIT_CSS, TASK_SHADOW_COLOR } from '../src/task-fit.js';

// Numeric fit oracles and owned-node interface doubles, not text metrics or a
// substitute browser renderer. Actual glyph layout is measured only in the GUI.
test('search returns the largest fitting value with subpixel precision and bounded work', () => {
  for (const threshold of [1, 7.7, 12, 23.625, 81.3, 250, 790]) {
    let probes=0;
    const size=largestTaskFont({max:800,fits:n=>{probes++;return n<=threshold;}});
    assert.ok(size<=threshold);assert.ok(threshold-size<=.25);assert.ok(probes<=26);
  }
});
test('short text can use the whole height with no small fixed font cap',()=>{
  assert.equal(largestTaskFont({max:600,fits:()=>true}),600);
  assert.equal(largestTaskFont({max:.5,fits:()=>true}),.5);
});
test('invalid bounds fail closed; unavoidable minimum overflow stays explicit',()=>{
  for(const max of [0,-1,NaN,Infinity,undefined])assert.equal(largestTaskFont({max,fits:()=>true}),null);
  assert.equal(largestTaskFont({max:10,fits:()=>false}),1);
});
function harness({observer=true}={}){
  let threshold=30,reads=0,disconnected=false;
  const events=new Map(),fontEvents=new Map(),queue=new Map();let serial=0,resize;
  const frame={clientWidth:200,clientHeight:140,style:{},dataset:{}};
  const text={textContent:'Task',style:{},dataset:{},get scrollHeight(){reads++;return Number.parseFloat(this.style.fontSize)<=threshold?100:500;},get scrollWidth(){return Math.max(0,frame.clientWidth-10);}};
  const view={getComputedStyle:()=>({fontFamily:'system-ui',fontWeight:'600',fontStyle:'normal',letterSpacing:'normal',wordSpacing:'0px'}),requestAnimationFrame:fn=>{const id=++serial;queue.set(id,fn);return id;},cancelAnimationFrame:id=>queue.delete(id),addEventListener:(n,f)=>events.set(n,f),removeEventListener:(n)=>events.delete(n)};
  if(observer)view.ResizeObserver=class{constructor(fn){resize=fn;}observe(){}disconnect(){disconnected=true;}};
  const document={fonts:{addEventListener:(n,f)=>fontEvents.set(n,f),removeEventListener:n=>fontEvents.delete(n)}};
  const dispose=bindTaskFit({frame,text,view,document});
  const flush=()=>{const jobs=[...queue.values()];queue.clear();jobs.forEach(f=>f());};
  return {frame,text,view,document,queue,events,fontEvents,dispose,flush,resize:()=>resize?.(),setThreshold:n=>threshold=n,get reads(){return reads;},get disconnected(){return disconnected;}};
}
test('owned-node measurements select a maximum and a self-induced observer callback does no repeated search',()=>{
  const h=harness();const size=Number.parseFloat(h.text.style.fontSize);assert.ok(size<=30&&size>29.75);assert.equal(h.text.dataset.taskFit,'fitted');
  const before=h.reads;h.resize();h.flush();assert.equal(h.reads,before);h.dispose();
});
test('available space, changed text and font loading each refit; resize callbacks are coalesced',()=>{
  const h=harness();h.setThreshold(18);h.frame.clientWidth=140;h.resize();h.resize();h.events.get('resize')();assert.equal(h.queue.size,1);h.flush();assert.ok(Number.parseFloat(h.text.style.fontSize)<=18);
  h.setThreshold(45);h.text.textContent='Short';h.resize();h.flush();assert.ok(Number.parseFloat(h.text.style.fontSize)>44.75);
  h.setThreshold(22);h.fontEvents.get('loadingdone')();h.flush();assert.ok(Number.parseFloat(h.text.style.fontSize)<=22);h.dispose();
});
test('zero-sized hidden area waits for a real size and minimum overflow remains scrollable',()=>{
  const h=harness();h.frame.clientHeight=0;const before=h.reads;h.resize();h.flush();assert.equal(h.reads,before);
  h.frame.clientHeight=60;h.setThreshold(0);h.resize();h.flush();assert.equal(h.text.dataset.taskFit,'overflow');assert.equal(h.frame.style.overflow,'auto');assert.equal(h.frame.style.alignItems,'flex-start');assert.equal(h.frame.style.pointerEvents,'auto');assert.equal(h.frame.tabIndex,0);assert.equal(h.frame.dataset.chatSwitcherNoSwipe,'');h.dispose();
});
test('fallback resize works without ResizeObserver and disposal cancels all owned resources',()=>{
  const h=harness({observer:false});h.frame.clientWidth=90;h.events.get('resize')();assert.equal(h.queue.size,1);const callback=[...h.queue.values()][0],before=h.reads;h.dispose();assert.equal(h.queue.size,0);assert.equal(h.events.size,0);assert.equal(h.fontEvents.size,0);callback();assert.equal(h.reads,before);
  const observed=harness();observed.dispose();assert.equal(observed.disconnected,true);
});
test('late font readiness cannot refit a disposed label',async()=>{
  let ready;const h=harness();h.dispose();h.document.fonts.ready=new Promise(resolve=>ready=resolve);const dispose=bindTaskFit({frame:h.frame,text:h.text,view:h.view,document:h.document});dispose();const before=h.reads;ready();await Promise.resolve();assert.equal(h.reads,before);assert.equal(h.queue.size,0);
});
test('task has a transparent region and opposing zero-distance shadow, with gutter included in fitting',()=>{
  assert.match(TASK_FIT_CSS,/\.cs-task-area\{[^}]*background:transparent/);
  assert.match(TASK_FIT_CSS,/\.cs-active-task\{[^}]*opacity:0\.5;/);
  assert.doesNotMatch(TASK_FIT_CSS,/\.cs-task-area\{[^}]*opacity:/);
  assert.doesNotMatch(TASK_FIT_CSS,/background:color-mix/);
  assert.match(TASK_FIT_CSS,/text-shadow:0 0 max\(2px,\.08em\) var\(--cs-task-shadow\),0 0 max\(1px,\.024em\) var\(--cs-task-shadow\)/);
  assert.match(TASK_FIT_CSS,/padding:max\(4px,\.12em\)/);
  assert.ok(TASK_FIT_CSS.includes('@supports (color:'+TASK_SHADOW_COLOR+')'));
  const lightnessToShadow=l=>Math.max(0,Math.min((50-l)*1000,100));
  for(const light of [80,90,100])assert.equal(lightnessToShadow(light),0);
  for(const dark of [0,10,25])assert.equal(lightnessToShadow(dark),100);
});
test('CSS reserves the full remaining image region and has no line clamp or fixed text height',()=>{
  assert.match(TASK_FIT_CSS,/flex:1 1 0/);assert.match(TASK_FIT_CSS,/position:absolute;inset:6px 7px/);
  assert.match(TASK_FIT_CSS,/overflow-wrap:anywhere/);assert.match(TASK_FIT_CSS,/line-height:1\.12/);
  assert.doesNotMatch(TASK_FIT_CSS,/line-clamp|ellipsis|max-height|48%|canvas/);
});
