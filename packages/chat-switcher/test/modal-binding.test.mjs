import test from 'node:test';
import assert from 'node:assert/strict';
import { bindModalAreaStyle } from '../src/modal-area.js';

class Events {
  listeners = new Map();
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type,new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  emit(type) { for (const fn of this.listeners.get(type)??[]) fn(); }
  get count() { return [...this.listeners.values()].reduce((n,set)=>n+set.size,0); }
}
test('same physical rect with changed CSS zoom recalculates inline pixels independently of area deduplication',()=>{
  const view=new Events(); view.visualViewport=new Events();
  const area={left:300,top:50,width:1000,height:800},changes=[];let zoom=1;
  const off=bindModalAreaStyle({view,getArea:()=>area,getZoom:()=>zoom,changed:style=>changes.push(style)});
  assert.equal(changes[0].left,'350px');assert.equal(changes[0].width,'900px');
  zoom=2;view.emit('resize');assert.equal(changes.length,2);assert.equal(changes[1].left,'175px');assert.equal(changes[1].width,'450px');
  view.emit('resize');assert.equal(changes.length,2);
  zoom=.5;view.visualViewport.emit('resize');assert.equal(changes.at(-1).width,'1800px');
  area.left=500;view.visualViewport.emit('scroll');assert.equal(changes.at(-1).left,'1100px');
  off();off();assert.equal(view.count+view.visualViewport.count,0);
  zoom=1;view.emit('resize');assert.equal(changes.length,4);
});
test('missing area safely clears custom positioning and teardown contains queued notifications',()=>{
  const view=new Events(),changes=[];let area=null;
  const off=bindModalAreaStyle({view,getArea:()=>area,getZoom:()=>1,changed:style=>changes.push(style)});
  assert.deepEqual(changes,[null]);area={left:0,top:0,width:100,height:200};view.emit('resize');assert.equal(changes.length,2);
  const stale=[...view.listeners.get('resize')][0];off();area=null;stale();assert.equal(changes.length,2);
});
