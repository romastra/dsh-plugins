import { error,object,RESET_CODES } from './parse.js';
import { readJson,writeJson,serialize } from './store.js';
const LIMIT=1024*1024, MAX=256, RETAIN=30*86400000;
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(x);
const hash=x=>typeof x==='string'&&/^[0-9a-f]{64}$/u.test(x);
const moment=x=>Number.isSafeInteger(x)&&x>0&&x<=8640000000000000;
const string=(x,n)=>typeof x==='string'&&x.length>0&&x.length<=n&&!/[\x00-\x1f\x7f]/u.test(x);
const states=['dispatching','uncertain','resolved','cancelledBeforeDispatch'];
const required=new Set(['schemaVersion','operationId','stableAccountKey','createdScope','creditId','redeemRequestId','state','createdAt','consentedAt','dispatchedAt','resolvedAt','resultCode','windowsReset','windowsResetCount']);
function valid(r){
  if(!object(r)||r.schemaVersion!==1||!uuid(r.operationId)||!hash(r.stableAccountKey)||!hash(r.createdScope)||!string(r.creditId,256)||!uuid(r.redeemRequestId)||!states.includes(r.state)||!moment(r.createdAt)||!moment(r.consentedAt)||!moment(r.dispatchedAt)||!Object.keys(r).every(k=>required.has(k)))return false;
  if(r.state!=='resolved')return [r.resolvedAt,r.resultCode,r.windowsReset,r.windowsResetCount].every(x=>x===undefined);
  if(!moment(r.resolvedAt)||!RESET_CODES.includes(r.resultCode))return false;
  if(r.windowsReset!==undefined)return r.windowsResetCount===undefined&&Array.isArray(r.windowsReset)&&r.windowsReset.length<=16&&[...r.windowsReset].every(x=>string(x,96));
  return r.windowsResetCount===undefined||(Number.isInteger(r.windowsResetCount)&&r.windowsResetCount>=0&&r.windowsResetCount<=16);
}
export const unresolved=r=>r.state==='dispatching'||r.state==='uncertain';
function validRows(rows){
  const ids=new Set(),cards=new Set();
  for(const r of rows){
    if(!valid(r)||ids.has(r.operationId))return false;
    ids.add(r.operationId);
    if(unresolved(r)){
      const key=r.stableAccountKey+'\0'+r.creditId;
      if(cards.has(key))return false;
      cards.add(key);
    }
  }
  return true;
}
const immutable=['schemaVersion','stableAccountKey','createdScope','creditId','redeemRequestId','createdAt','consentedAt','dispatchedAt'];
const freezeRow=r=>Object.freeze({...r,...(r.windowsReset?{windowsReset:Object.freeze([...r.windowsReset])}:{})});
export function publicOperation(r,active=false){
  return {operationId:r.operationId,state:r.state==='dispatching'&&!active?'uncertain':r.state,createdAt:r.createdAt,...(r.resolvedAt?{resolvedAt:r.resolvedAt,resultCode:r.resultCode}:{}),...(r.windowsReset?{windowsReset:[...r.windowsReset]}:{}),...(r.windowsResetCount!==undefined?{windowsResetCount:r.windowsResetCount}:{})};
}
export function createResetJournal({file,now=Date.now,read=readJson,write=writeJson}){
  const lock=serialize();let cached;
  async function load(){
    if(cached)return cached;
    let raw;try{raw=await read(file,LIMIT);}catch{throw error('RESET_JOURNAL_UNAVAILABLE');}
    if(raw===undefined)return cached=[];
    if(!object(raw)||raw.schemaVersion!==1||Object.keys(raw).length!==2||!Array.isArray(raw.operations)||raw.operations.length>MAX||!validRows(raw.operations))throw error('RESET_JOURNAL_UNAVAILABLE');
    return cached=raw.operations.map(r=>freezeRow(r.state==='dispatching'?{...r,state:'uncertain'}:r));
  }
  async function update(fn){return lock(async()=>{
    const rows=await load();
    const source=rows.filter(r=>unresolved(r)||now()-(r.resolvedAt??r.createdAt)<=RETAIN);
    const next=fn(source);
    if(!Array.isArray(next))throw error('RESET_JOURNAL_UNAVAILABLE');
    if(next.length>MAX)throw error('RESET_JOURNAL_LIMIT');
    if(!validRows(next))throw error('RESET_JOURNAL_UNAVAILABLE');
    const previous=new Map(rows.map(r=>[r.operationId,r]));
    const updated=new Map(next.map(r=>[r.operationId,r]));
    for(const [id,before] of previous){
      const after=updated.get(id);
      if(after?immutable.some(k=>before[k]!==after[k]):unresolved(before))throw error('RESET_JOURNAL_UNAVAILABLE');
    }
    const durable=next.map(freezeRow);
    try{await write(file,{schemaVersion:1,operations:durable},LIMIT);}catch(e){throw error(e?.code==='QUOTA_STATE_LIMIT'?'RESET_JOURNAL_LIMIT':'RESET_JOURNAL_UNAVAILABLE');}
    cached=durable;
  });}
  return {all:()=>lock(async()=>[...await load()]),update};
}
