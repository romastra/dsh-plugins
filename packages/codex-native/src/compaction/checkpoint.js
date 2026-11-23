import {createHash} from 'node:crypto';
export const KEY='codexNativeCompactionV1',MAX_BYTES=2*1024*1024, MAX_ITEMS=4096,MAX_AGE=7*86400000;
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/u.test(x);
const obj=x=>x!==null&&typeof x==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(x));
// Deterministic bounded JSON; no getters, toJSON, implicit prototypes, cycles or unstable key order.
export function canonical(value,limit=32*1024*1024){
  let count=0,bytes=0;const stack=new Set(),parts=[];
  function add(s){bytes+=Buffer.byteLength(s);if(bytes>limit)throw Error('CLOUD_BOUND');parts.push(s);}
  function walk(v,depth){
    if(++count>300000||depth>48)throw Error('CLOUD_BOUND');
    if(v===undefined||v===null){add('null');return;}
    if(typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v)){if(typeof v==='string'&&v.length>limit)throw Error('CLOUD_BOUND');add(JSON.stringify(v));return;}
    if(!(Array.isArray(v)||obj(v))||stack.has(v))throw Error('CLOUD_CANONICAL');
    stack.add(v);
    if(Array.isArray(v)){
      if(v.length>300000-count)throw Error('CLOUD_BOUND');
      add('[');for(let i=0;i<v.length;i++){if(i)add(',');const d=Object.getOwnPropertyDescriptor(v,String(i));if(d&&!Object.hasOwn(d,'value'))throw Error('CLOUD_CANONICAL');walk(d?.value,depth+1);}add(']');
    }else{
      add('{');let first=true;
      for(const k of Object.keys(v).sort()){const d=Object.getOwnPropertyDescriptor(v,k);if(!d||!Object.hasOwn(d,'value'))throw Error('CLOUD_CANONICAL');if(d.value===undefined)continue;if(!first)add(',');first=false;add(JSON.stringify(k));add(':');walk(d.value,depth+1);}add('}');
    }
    stack.delete(v);
  }
  walk(value,0);return parts.join('');
}
export const digest=(value,limit)=>createHash('sha256').update(canonical(value,limit)).digest('hex');
export const scopeOf=(scope,model)=>digest(['codex-native/checkpoint/v1',scope,'openai-codex','openai-codex-responses',model]);
const PROVIDER='openai-codex', API='openai-codex-responses';
const data=(o,k)=>Object.getOwnPropertyDescriptor(o??{},k)?.value;
const envelope=m=>data(data(data(m,'source'),'replayState'),'response');

// unwrapMessages validates the whole input before admission. For a same-model
// Native row it preserves exactly the original content, blocks, and inner Pi
// response. Foreign rows never unwrap, and portable rows lose replayState.
export function nativeBindings(original, verified, scope, model){
 const bindings=new Map();
 if(original.length!==verified.length || typeof scope!=='string' || !scope || scope.length>128)return bindings;
 for(let i=0;i<original.length;i++){
  const m=original[i], v=verified[i], source=data(m,'source'), projected=data(v,'source');
  if(data(m,'role')!=='assistant'||data(v,'role')!=='assistant'||m===v||data(m,'content')!==data(v,'content'))continue;
  if(data(source,'provider')!==PROVIDER||data(projected,'provider')!==PROVIDER||data(source,'model')!==model||data(projected,'model')!==model)continue;
  const raw=data(source,'replayState'), w=data(raw,'response'), r=data(projected,'replayState');
  if(data(w,'kind')!=='codex-native'||data(w,'version')!==1||data(w,'scope')!==scope)continue;
  const state=data(r,'response'), blocks=data(r,'blocks');
  if(state!==data(w,'state')||blocks!==data(raw,'blocks')||!Array.isArray(blocks))continue;
  if(data(state,'kind')!=='pi-ai'||data(state,'version')!==2||data(state,'provider')!==PROVIDER||data(state,'api')!==API||data(state,'model')!==model)continue;
  bindings.set(i,{state,blocks});
 }
 return bindings;
}
function binding(m,r){
 const s=m.source??{};
 const blocks=r?.blocks.map(b=>({type:data(b,'type'),textSignature:data(b,'textSignature'),thinkingSignature:data(b,'thinkingSignature'),thoughtSignature:data(b,'thoughtSignature'),namespace:data(b,'namespace'),redacted:data(b,'redacted')}));
 return {role:m.role,content:m.content,toolCallId:m.toolCallId,isError:m.isError,source:{kind:s.kind,provider:s.provider,model:s.model,callId:s.callId},native:r?{kind:r.state.kind,version:r.state.version,provider:r.state.provider,api:r.state.api,model:r.state.model,responseModel:r.state.responseModel,responseId:r.state.responseId,providerThinkingLevel:r.state.providerThinkingLevel,stopReason:r.state.stopReason,blocks}:null};
}
export function historyDigest(all,limit=all.length,native){
 const h=createHash('sha256').update('codex-native/history/v1\0');let bytes=0;
 for(let i=0;i<limit;i++){const item=canonical(binding(all[i],native?.get(i)),32*1024*1024-bytes);bytes+=Buffer.byteLength(item);h.update(item).update('\n');}
 return h.digest('hex');
}
export const anchorDigest=(content,blocks)=>digest({content,blocks});
export const instructions=m=>m.role==='system'||m.role==='developer';
export const requestDigest=options=>digest({system:options.system,history:options.messages.filter(instructions).map(m=>binding(m)),tools:options.tools,toolChoice:options.toolChoice,format:options.responseFormat??options.outputFormat});
export const wireDigest=payload=>digest({instructions:payload.instructions,tools:payload.tools,tool_choice:payload.tool_choice,text:payload.text,metadata:undefined});
export const id=x=>typeof x==='string'&&x.length>0&&x.length<=512;
export const cipher=x=>typeof x==='string'&&x.length>0;
const supported=new Set(['compaction','reasoning','message','function_call','custom_tool_call']);
export function validateItems(items){
 if(!Array.isArray(items)||!items.length||items.length>MAX_ITEMS||items[0]?.type!=='compaction'||!cipher(items[0].encrypted_content))return false;
 const ids=new Set(),calls=new Set();
 for(const [index,i] of items.entries()){
  if(!obj(i)||!supported.has(i.type)||i.type==='compaction'&&(index!==0||!cipher(i.encrypted_content))||i.type==='reasoning'&&(!id(i.id)||!cipher(i.encrypted_content))||i.type==='message'&&(i.role!=='assistant'||!Array.isArray(i.content)))return false;
  if(i.id!==undefined){if(!id(i.id)||ids.has(i.id))return false;ids.add(i.id);}
  if(i.type==='function_call'||i.type==='custom_tool_call'){if(!id(i.call_id)||!id(i.name)||calls.has(i.call_id)||typeof (i.arguments??i.input)!=='string')return false;calls.add(i.call_id);}
 }
 return true;
}
export function itemsDigest(items){const data=canonical(items,MAX_BYTES);return {bytes:Buffer.byteLength(data),digest:createHash('sha256').update(data).digest('hex')};}
export function newest(messages,scope,fingerprint,now,native){
 for(let index=messages.length-1;index>=0;index--){
  const m=messages[index],w=envelope(m),state=data(w,'kind')==='codex-native'?data(w,'state'):w;
  // An unverified carrier can force full history, but neither its item data
  // nor its opaque replay projection can enter an admitted checkpoint.
  if(!Object.hasOwn(state??{},KEY))continue;
  const r=native.get(index);
  if(!r||r.state!==state)return {reason:'unverified'};
  const c=data(r.state,KEY);
  if(!obj(c)||c.version!==1||!Number.isSafeInteger(c.createdAt)||c.createdAt<0||c.createdAt>now||now-c.createdAt>MAX_AGE)return {reason:'age-or-version'};
  if(c.scope!==scope||!hex(c.prefix)||!hex(c.content)||!hex(c.digest)||!hex(c.requestFingerprint)||!hex(c.wireFingerprint)||!Number.isSafeInteger(c.bytes)||c.bytes<1||c.bytes>MAX_BYTES)return {reason:'invalid'};
  if(c.requestFingerprint!==fingerprint)return {reason:'request-changed'};
  try{
   if(!validateItems(c.items))return {reason:'items'};
   const a=itemsDigest(c.items);if(c.digest!==a.digest||c.bytes!==a.bytes)return {reason:'digest'};
   if(c.prefix!==historyDigest(messages,index,native))return {reason:'prefix-changed'};
   if(c.content!==anchorDigest(m.content,r.blocks))return {reason:'anchor-changed'};
   return {index,c};
  }catch{return {reason:'bounds'};}
 }
 return {reason:'missing'};
}
export function correctTools(suffix,tail){
 const calls=new Set(),used=new Set();
 for(const i of [...suffix,...tail]){
  if(['function_call','custom_tool_call'].includes(i?.type)){
   if(!id(i.call_id)||calls.has(i.call_id))return false;calls.add(i.call_id);
  }else if(['function_call_output','custom_tool_call_output'].includes(i?.type)){
   if(!calls.has(i.call_id)||used.has(i.call_id))return false;used.add(i.call_id);
  }
 }
 return true;
}
