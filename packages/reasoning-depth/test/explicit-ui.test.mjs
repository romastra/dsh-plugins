import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {buildEffortView,selectionAt} from '../src/choices.js';
test('unknown effort is never represented as the first level and does not write a selection',()=>{const current={provider:'openai-codex',model:'gpt'};const state={current,groups:[{id:current.provider,models:[{id:current.model,reasoning:{efforts:[{id:'low',name:'Low'},{id:'max',name:'Max'}]}}]}]};const view=buildEffortView(state);assert.equal(view.index,-1);assert.equal(view.selectionRequired,true);assert.deepEqual(state.current,current);assert.deepEqual(selectionAt(view,0),{...current,reasoningEffort:'low'});});
test('unset effort has no pretend thumb or extra Default stop and remains keyboard selectable',async()=>{const s=await readFile(new URL('../src/client.js',import.meta.url),'utf8');assert.ok(s.includes("name: t('chooseLevel')"));assert.ok(s.includes('data-unset'));assert.ok(s.includes('::-webkit-slider-thumb { opacity:0; }'));assert.ok(s.includes('view.selectionRequired && !draftRef.current'));assert.ok(s.includes('&& !view?.selectionRequired'));assert.ok(!s.includes("t('default')"));});
