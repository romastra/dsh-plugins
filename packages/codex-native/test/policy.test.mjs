import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultPolicy,reducePolicy,speedForPolicy,assertSpeedSelection,POLICY_RECORD} from '../src/policy.js';
test('durable speed applies only exact model, standard default and strict capability',()=>{let s=defaultPolicy(); assert.equal(speedForPolicy(s,'a',null).tier,'standard');s=reducePolicy(s,{type:POLICY_RECORD,data:assertSpeedSelection('fast','a',true)});assert.equal(speedForPolicy(s,'a',true).tier,'fast');assert.equal(speedForPolicy(s,'b',true).tier,'standard');assert.throws(()=>speedForPolicy(s,'a',null));s=reducePolicy(s,{type:POLICY_RECORD,data:assertSpeedSelection('standard','a',null)});assert.equal(speedForPolicy(s,'a',false).tier,'standard');});
test('policy survives JSON persistence and unknown ignorable events do not affect it',()=>{const s={version:1,tier:'fast',model:'a'};assert.deepEqual(JSON.parse(JSON.stringify(s)),s);assert.equal(reducePolicy(s,{type:'other',data:{}}),s);});
