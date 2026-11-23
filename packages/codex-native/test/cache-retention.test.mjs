import test from 'node:test';
import assert from 'node:assert/strict';
import {createSnapshotCache} from '../src/snapshot-cache.js';
test('quota stale value is not exposed as fresh after failed refresh',async()=>{let time=0,fail=false;const cache=createSnapshotCache({now:()=>time,ttlMs:10,retryMs:30,load:async()=>{if(fail)throw Error('no');return {windows:[{usedPercent:45}]};}});await cache.ensure('A');assert.equal(cache.get('A').stale,false);time=10;fail=true;await cache.ensure('A');for(let i=0;i<6;i++)await Promise.resolve();assert.equal(cache.get('A').stale,true);assert.equal(cache.get('A').value.windows[0].usedPercent,45);cache.dispose();});
