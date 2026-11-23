import { randomUUID } from 'node:crypto';
import { anchorDigest, digest, historyDigest, nativeBindings, newest, requestDigest, scopeOf, wireDigest, correctTools, instructions, KEY } from './checkpoint.js';
import {createCollector} from './collector.js';
import {compactionThreshold} from './budget.js';
const fail=()=>Object.assign(new Error('Cloud checkpoint no longer matches the prepared request. Disable cloud compaction and retry with full history.'),{code:'CLOUD_LATE_CONTRACT_CHANGED'});
const callId=id=>typeof id==='string'?id.split('|')[0]:null;

function tailSafe(tail,items){
 const seen=new Map(),answered=new Set();
 for(const i of items)if(['function_call','custom_tool_call'].includes(i.type))seen.set(i.call_id,i.type==='custom_tool_call'?'custom':'normal');
 for(const m of tail){
  if(m.role==='tool'){const id=callId(m.toolCallId);if(!id||!seen.has(id)||answered.has(id)||seen.get(id)==='custom')return false;answered.add(id);}
  if(m.role==='assistant')for(const b of m.content)if(b.type==='tool-call'){const id=callId(b.id);if(!id||seen.has(id))return false;seen.set(id,'normal');}
 }
 return true;
}
export function beginCloud({options,messages,scope,descriptor,policy,diagnostic,now=Date.now}){
 if(policy.mode!=='cloud'||(options.provider!==undefined&&options.provider!=='openai-codex'))return {messages};
 const threshold=compactionThreshold(descriptor?.context?.contextWindow,options.maxTokens??descriptor?.defaultMaxTokens??0,policy.thresholdTokens);
 if(threshold===null){diagnostic('budget-unavailable');return {messages};}
 const attemptId=randomUUID(), original=options.messages;
 let fingerprint,prefix,owner,selected;
 try{
  const native=nativeBindings(original,messages,scope,options.model);
  fingerprint=requestDigest(options);prefix=historyDigest(original,original.length,native);owner=scopeOf(scope,options.model);
  selected=newest(original,owner,fingerprint,now(),native);
 }catch{diagnostic('history-bounds');return {messages};}
 if(selected.c&&!tailSafe(original.slice(selected.index+1),selected.c.items))selected={reason:'tool-pairing'};
 const shortened=selected.c?[...messages.slice(0,selected.index).filter(instructions),...messages.slice(selected.index+1)]:messages;
 let contract=null,collector=createCollector();
 const cached=new WeakMap();
 const report=(reason)=>diagnostic(reason,threshold);
 if(!selected.c)report(selected.reason);
 const state={attemptId,threshold,reason:selected.reason,enabled:true,
  before(payload){
   try{return {wire:wireDigest(payload),input:digest(payload.input),model:payload.model};}
   catch{if(selected.c)throw fail();return null;}
  },
  prepare(payload,expected){
   if(!Array.isArray(payload?.input)||payload.model!==options.model){if(selected.c)throw fail();collector=null;return payload;}
   const actual=state.before(payload);
   if(!actual){collector=null;return payload;}
   let input=payload.input;
   const prior=cached.get(payload);
   const sameContract=expected?.wire===actual.wire&&expected.model===actual.model;
   const unchanged=sameContract&&expected.input===actual.input;
   if(selected.c){
    if(actual.wire!==selected.c.wireFingerprint || (prior
      ? actual.input!==prior.preparedInput || !sameContract || (!unchanged&&expected.input!==prior.originalInput)
      : !unchanged))throw fail();
    if(!prior){
     // Pi may emit retained developer/system updates in input; its top-level
     // instructions are separate and stay exactly as serialized by Pi.
     let split=0;while(split<input.length&&(['developer','system'].includes(input[split]?.role)||input[split]?.type==='additional_tools'))split++;
     const tail=input.slice(split);if(!correctTools(selected.c.items,tail))throw fail();
     input=[...input.slice(0,split),...selected.c.items,...tail];report('reused');
    }
   }else if(!unchanged||(contract&&(contract.wire!==actual.wire||contract.input!==actual.input)))collector=null;
   contract=actual;
   const result={...payload,input,context_management:[{type:'compaction',compact_threshold:threshold}]};
   if(selected.c){
    try{cached.set(result,prior??{originalInput:actual.input,preparedInput:digest(input)});}
    catch{throw fail();}
   }
   return result;
  },
  // Pinned Pi invokes this hook synchronously for each parsed event before
  // normalization; never tee the transport or retain event objects themselves.
  observe(event){collector?.observe(event);},
  attach(replay,anchor){
   if(!collector||!contract||!Array.isArray(anchor)||!Array.isArray(replay?.blocks)||replay.blocks.length!==anchor.length)return replay;
   const result=collector.finish(replay);
   if(!result.items){if(!selected.c)report(result.reason==='missing'?'waiting':result.reason);return replay;}
   report('received');
   try{
    const value={version:1,createdAt:now(),scope:owner,prefix,content:anchorDigest(anchor,replay.blocks),items:result.items,bytes:result.bytes,digest:result.digest,requestFingerprint:fingerprint,wireFingerprint:contract.wire};
    report('attachedToFinish');
    return {...replay,response:{...replay.response,[KEY]:value}};
   }catch{report('anchor-unavailable');return replay;}
  }
 };
 return {messages:shortened,state};
}
