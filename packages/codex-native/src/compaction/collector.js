// WSL043 suffix collection adapted to the raw pinned Pi hook (no second SSE parser).
import {createHash} from 'node:crypto';
import {canonical, cipher, id, MAX_BYTES, MAX_ITEMS, validateItems, itemsDigest} from './checkpoint.js';

const terminal=new Set(['response.completed','response.done','response.incomplete','response.failed','error']);
const callTypes=new Set(['function_call','custom_tool_call']);
const hash=text=>createHash('sha256').update(text).digest('hex');
function identify(item){
 if(!item||typeof item.type!=='string'||!item.type.length||item.type.length>64)throw Error('CLOUD_ITEMS');
 const call=callTypes.has(item.type);
 if((call&&!id(item.call_id))||(item.type==='reasoning'&&!id(item.id))||(item.id!==undefined&&!id(item.id)))throw Error('CLOUD_ITEMS');
 const callKey=call?'call:'+hash(JSON.stringify(item.call_id)):null;
 return {type:item.type,callKey,key:item.id!==undefined?'id:'+hash(JSON.stringify(item.id)):callKey??'item:'+hash(canonical(item,MAX_BYTES))};
}

export function createCollector(){
 // Keep only the latest suffix bodies. Retain bounded, fixed-size evidence of
 // earlier identities (especially earlier compactions) to detect stale echoes.
 const observed=new Map(), calls=new Set(), finalReasoning=new Map();
 let latest=-1,suffix=null,bytes=0,ended=false,reason='missing';
 function discard(why){ended=true;reason=why;suffix=null;observed.clear();calls.clear();finalReasoning.clear();}
 function copy(item){
  if(suffix.length>=MAX_ITEMS)throw Error('CLOUD_BOUND');
  const sep=suffix.length?1:0,text=canonical(item,MAX_BYTES-bytes-sep);
  bytes+=Buffer.byteLength(text)+sep;
  suffix.push(JSON.parse(text));
  return text;
 }
 function observeItem(item){
  if(observed.size>=MAX_ITEMS)throw Error('CLOUD_BOUND');
  const meta=identify(item);
  if(observed.has(meta.key)||meta.callKey&&calls.has(meta.callKey))throw Error('CLOUD_ITEMS');
  const pos=observed.size;
  if(item.type==='compaction'){suffix=[];bytes=2;latest=pos;}
  let fingerprint;
  if(suffix){const text=copy(item);if(item.type!=='reasoning')fingerprint=hash(text);}
  observed.set(meta.key,{pos,type:meta.type,callKey:meta.callKey,fingerprint});
  if(meta.callKey)calls.add(meta.callKey);
 }
 function reconcile(output){
  if(!Array.isArray(output))return;
  if(output.length>MAX_ITEMS)throw Error('CLOUD_BOUND');
  const compact=output.findLastIndex(i=>i?.type==='compaction');
  const ids=new Set(), terminalCalls=new Set();
  let last=-1, comparedBytes=0;
  for(let i=0;i<output.length;i++){
   const item=output[i], {key,type,callKey}=identify(item), known=observed.get(key);
   if(ids.has(key)||callKey&&terminalCalls.has(callKey))throw Error('CLOUD_ITEMS');
   ids.add(key);if(callKey)terminalCalls.add(callKey);
   if(known){
    if(last>=known.pos||known.type!==type||known.callKey!==callKey)throw Error('CLOUD_ORDER');
    // Earlier suffix bodies were discarded. Their identities are only used
    // for ordering, not to substitute anything into the authoritative suffix.
    if(known.pos>=latest&&known.fingerprint!==undefined){
     const text=canonical(item,MAX_BYTES-comparedBytes);comparedBytes+=Buffer.byteLength(text);
     if(hash(text)!==known.fingerprint)throw Error('CLOUD_CONFLICT');
    }
   }else if(callKey&&calls.has(callKey))throw Error('CLOUD_CONFLICT');
   if(i===compact&&latest>=0){
    // A known older compaction is stale. A terminal-only compaction can only
    // supersede the streamed one if a common item proves it comes after it.
    if(known?known.pos!==latest:last<latest)throw Error('CLOUD_ORDER');
   }
   if(known)last=known.pos;
   if(compact>=0&&i>compact&&!known&&type!=='reasoning')throw Error('CLOUD_CONFLICT');
   if(type==='reasoning'&&cipher(item.encrypted_content)&&(compact>=0?i>compact:latest>=0&&known?.pos>latest)){
    const text=canonical(item,MAX_BYTES-comparedBytes);comparedBytes+=Buffer.byteLength(text);
    finalReasoning.set(item.id,hash(text));
   }
  }
  if(compact>=0){
   // The terminal order is authoritative, not a union of both sequences.
   suffix=[];bytes=2;
   for(let i=compact;i<output.length;i++)copy(output[i]);
  }
 }
 return {
  observe(event){
   if(ended)return;
   try{
    if(event?.type==='response.output_item.done')observeItem(event.item);
    else if(terminal.has(event?.type)){
     ended=true;
     if(!['response.done','response.completed'].includes(event.type)||event.response?.status!=='completed'){discard('missing');return;}
     reconcile(event.response.output);
     observed.clear();calls.clear();
    }
   }catch(error){discard(error?.message==='CLOUD_BOUND'?'oversized':'items');}
  },
  finish(replay){
   if(!ended||!suffix)return {reason};
   const items=suffix;suffix=null;
   try{
    const positions=new Map();
    for(let i=0;i<items.length;i++)if(items[i]?.type==='reasoning')positions.set(items[i].id,i);
    if(positions.size){
     if(!Array.isArray(replay?.blocks)||replay.blocks.length>MAX_ITEMS)return {reason:'reasoning'};
     const matched=new Set();
     let finalBytes=bytes;
     for(const b of replay.blocks){
      if(b.type!=='reasoning'||typeof b.thinkingSignature!=='string')continue;
      if(b.thinkingSignature.length>MAX_BYTES||Buffer.byteLength(b.thinkingSignature)>MAX_BYTES)return {reason:'oversized'};
      const r=JSON.parse(b.thinkingSignature);
      if(r?.type!=='reasoning'||!id(r.id))return {reason:'reasoning'};
      if(!positions.has(r.id))continue;
      if(matched.has(r.id))return {reason:'reasoning'};
      const pos=positions.get(r.id), expected=finalReasoning.get(r.id);
      finalBytes-=Buffer.byteLength(canonical(items[pos],MAX_BYTES));
      const actual=canonical(r,MAX_BYTES-finalBytes);
      if(expected!==undefined&&expected!==hash(actual))return {reason:'reasoning'};
      finalBytes+=Buffer.byteLength(actual);
      items[pos]=r;matched.add(r.id);
     }
     if(matched.size!==positions.size)return {reason:'reasoning'};
    }
    if(!validateItems(items))return {reason:'items'};
    return {items,...itemsDigest(items)};
   }catch(error){return {reason:error?.message==='CLOUD_BOUND'?'oversized':'bounds'};}
   finally{finalReasoning.clear();}
  }
 };
}
