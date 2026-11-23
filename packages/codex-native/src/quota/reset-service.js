// Pending consent is ephemeral. Once an operation may reach the server its exact IDs are durable.
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { error } from './parse.js';
import { unresolved,publicOperation } from './reset-journal.js';
const MAX=256, DELAY=5000, TTL=60000;
const resetAuthCode=code=>{
  if(code==='QUOTA_AUTH_REQUIRED'||code==='RESET_AUTH_REQUIRED')return 'RESET_AUTH_REQUIRED';
  if(code==='QUOTA_ACCESS_DENIED'||code==='RESET_ACCESS_DENIED')return 'RESET_ACCESS_DENIED';
  if(code==='QUOTA_ACCOUNT_CHANGED'||code==='RESET_ACCOUNT_CHANGED')return 'RESET_ACCOUNT_CHANGED';
};
export const resetOwnerError=e=>error(resetAuthCode(e?.code)??'RESET_ACCOUNT_CHANGED');
const sameOwner=(a,b)=>a.scope===b.scope&&a.viewRevision===b.viewRevision;
export function createResetService({quota,journal,ownerManaged=false,now=Date.now,monotonic=()=>performance.now(),uuid=randomUUID,onReset=async()=>{}}){
  const refs=new Map(),challenges=new Map(),busy=new Set(),prepareFlights=new Map();
  const physical=(owner,id)=>owner.stableAccountKey+'\0'+id;
  const fail=(code,details)=>{throw error(code,details);};
  const allowed=()=>{if(ownerManaged)fail('RESET_MANAGED_BY_DESKTOP');};
  async function fence(who){try{await quota.assertCurrent(who);}catch(e){throw resetOwnerError(e);}}
  async function owner(expected){
    // A dispatcher-bound owner can be revalidated, never replaced with a newer one.
    if(expected){await fence(expected);return expected;}
    try{return await quota.current();}catch(e){throw resetOwnerError(e);}
  }
  function prune(){const t=monotonic();for(const [id,c] of challenges)if(c.deadlineMono<=t&&!busy.has(c.key))challenges.delete(id);}
  const cardView=(card,creditRef)=>({creditRef,name:card.name,description:card.description,expiresAt:card.expiresAt});
  const opView=r=>publicOperation(r,busy.has(r.stableAccountKey+'\0'+r.creditId));
  const journalRows=async who=>(await journal.all()).filter(r=>r.stableAccountKey===who.stableAccountKey);
  async function inventory(who,force,signal){
    let snap;
    try{snap=await quota.read('inventory',{owner:who,force,signal});}catch(e){
      const code=resetAuthCode(e?.code);if(code)fail(code);throw e;
    }
    return {snap,data:snap.data,usable:snap.stale||snap.errorCode?[]:(snap.data?.cards??[]).filter(c=>!c.expiresAt||c.expiresAt>now())};
  }
  function requireInventory({snap,data}){
    if(snap.stale||!data||snap.errorCode)fail(resetAuthCode(snap.errorCode)??'RESET_INVENTORY_UNAVAILABLE',{retryAt:snap.retryAt});
  }
  async function inspect({owner:expected,force=false,signal}={}){
    const who=await owner(expected);let snapshot,journalError,entries=[];
    try{snapshot=await inventory(who,force,signal);}catch(e){
      if(signal?.aborted)throw e;
      if(resetAuthCode(e?.code))throw resetOwnerError(e);
    }
    if(!ownerManaged)try{entries=await journalRows(who);}catch(e){journalError=e.code;}
    await fence(who);signal?.throwIfAborted();
    const {snap,data,usable} = snapshot??{usable:[]};
    const cards=usable.filter(c=>!c.expiresAt||c.expiresAt>now()).map(card=>{
      let creditRef=[...refs].find(([,v])=>sameOwner(v,who)&&v.cardId===card.id)?.[0];
      if(!creditRef){if(refs.size>=MAX)refs.delete(refs.keys().next().value);creditRef=uuid();refs.set(creditRef,{scope:who.scope,viewRevision:who.viewRevision,cardId:card.id});}
      return cardView(card,creditRef);
    });
    return {viewRevision:who.viewRevision,ownerManaged,availableCount:data?.availableCount??null,inventoryState:snap?.state??'unknown',stale:snap?.stale??true,checkedAt:snap?.checkedAt??null,retryAt:snap?.retryAt,cards,mismatch:data?.mismatch??false,errorCode:resetAuthCode(snap?.errorCode)??snap?.errorCode,journalError,operations:entries.slice(-MAX).reverse().map(opView)};
  }
  function publicChallenge(c){return {challengeId:c.id,kind:c.kind,name:c.card?.name,description:c.card?.description,expiresAt:c.card?.expiresAt,readyAt:c.readyAt,confirmBy:c.confirmBy,operationId:c.operationId,viewRevision:c.who.viewRevision};}
  function challenge(who,kind,key,card,operationId){
    prune();const prior=[...challenges.values()].find(c=>sameOwner(c.who,who)&&c.key===key&&c.kind===kind&&c.operationId===operationId);
    if(prior)return publicChallenge(prior);
    if(challenges.size>=MAX)fail('RESET_IN_PROGRESS');
    const t=now(),m=monotonic();const confirmBy=Math.min(t+TTL,kind==='new-redemption'?(card.expiresAt??Infinity):Infinity);
    if(confirmBy<=t+DELAY)fail('RESET_EXPIRED');
    const c={id:uuid(),kind,key,who,card,operationId,readyAt:t+DELAY,confirmBy,readyMono:m+DELAY,deadlineMono:m+confirmBy-t};
    challenges.set(c.id,c);return publicChallenge(c);
  }
  async function prepare({owner:expected,creditRef,signal}={}){
    allowed();const who=await owner(expected);signal?.throwIfAborted();const ref=creditRef===undefined?null:refs.get(creditRef);
    if(creditRef!==undefined&&(!ref||!sameOwner(ref,who)))fail('RESET_REF_INVALID');
    const flightKey=who.viewRevision+'\0'+(ref?.cardId??'');
    let flight=prepareFlights.get(flightKey);
    if(!flight){
      flight=(async()=>{
        const s=await inventory(who,true);requireInventory(s);
        const card=ref?s.usable.find(c=>c.id===ref.cardId):s.usable[0];
        if(!card)fail(ref?'RESET_EXPIRED':'RESET_UNAVAILABLE');
        const key=physical(who,card.id);
        if(busy.has(key)||(await journalRows(who)).some(r=>r.creditId===card.id&&unresolved(r)))fail('RESET_IN_PROGRESS');
        await fence(who);
        return challenge(who,'new-redemption',key,card);
      })().finally(()=>{if(prepareFlights.get(flightKey)===flight)prepareFlights.delete(flightKey);});
      prepareFlights.set(flightKey,flight);
    }
    const result=await flight;signal?.throwIfAborted();return result;
  }
  async function lookup(who,id){const r=(await journalRows(who)).find(x=>x.operationId===id);if(!r)fail('RESET_REF_INVALID');return r;}
  async function recovery({owner:expected,operationId,signal}={}){
    allowed();const who=await owner(expected),r=await lookup(who,operationId);await fence(who);signal?.throwIfAborted();
    const key=physical(who,r.creditId);if(busy.has(key))fail('RESET_IN_PROGRESS');if(!unresolved(r))fail('RESET_UNAVAILABLE');
    return challenge(who,'recovery',key,undefined,r.operationId);
  }
  async function cancel({owner:expected,challengeId,signal}={}){
    allowed();const c=challenges.get(challengeId);if(!c)fail('RESET_REF_INVALID');if(busy.has(c.key))fail('RESET_IN_PROGRESS');
    const who=await owner(expected);if(!sameOwner(c.who,who))fail('RESET_ACCOUNT_CHANGED');
    signal?.throwIfAborted();if(busy.has(c.key))fail('RESET_IN_PROGRESS');
    if(challenges.get(challengeId)!==c)fail('RESET_REF_INVALID');
    challenges.delete(challengeId);return {state:'cancelledBeforeDispatch',viewRevision:who.viewRevision};
  }
  async function consume({owner:expected,challengeId,acknowledged,signal}={}){
    allowed();const c=challenges.get(challengeId);
    if(!c)fail('RESET_REF_INVALID');
    if(expected&&!sameOwner(c.who,expected))fail('RESET_ACCOUNT_CHANGED',{outcome:'not-dispatched'});
    if(acknowledged!==true)fail('RESET_ACK_REQUIRED');
    if(monotonic()<c.readyMono)fail('RESET_NOT_READY');
    if(monotonic()>=c.deadlineMono||now()>=c.confirmBy)fail('RESET_EXPIRED');
    if(busy.has(c.key))fail('RESET_IN_PROGRESS');
    busy.add(c.key); // before the first await, keyed by real physical card and stable account
    let operation,dispatched=false,wroteIntent=false,freshExpiresAt;
    const who=expected??c.who;
    const put=next=>journal.update(rows=>[...rows.filter(r=>r.operationId!==next.operationId),next]);
    try{
      signal?.throwIfAborted();await fence(who);
      if(c.kind==='new-redemption'){
        const fresh=await inventory(who,true,signal);requireInventory(fresh);
        const card=fresh.usable.find(x=>x.id===c.card.id);if(!card)fail('RESET_EXPIRED');
        freshExpiresAt=card.expiresAt;
        const t=now();operation={schemaVersion:1,operationId:uuid(),stableAccountKey:who.stableAccountKey,createdScope:who.scope,creditId:card.id,redeemRequestId:uuid(),state:'dispatching',createdAt:t,consentedAt:t,dispatchedAt:t};
        await journal.update(rows=>{
          if(rows.some(r=>r.stableAccountKey===who.stableAccountKey&&r.creditId===card.id&&(unresolved(r)||(r.state==='resolved'&&['reset','already_redeemed'].includes(r.resultCode)))))fail('RESET_IN_PROGRESS');
          return [...rows,operation];
        });
      }else{
        const old=await lookup(who,c.operationId);if(!unresolved(old))fail('RESET_UNAVAILABLE');
        // Recovery supplies fresh ephemeral consent, not a new durable operation.
        operation={...old,state:'dispatching'};await put(operation);
      }
      wroteIntent=true;
      const result=await quota.consume(who,{signal,creditId:operation.creditId,redeemRequestId:operation.redeemRequestId,beforeDispatch(){
        signal?.throwIfAborted();
        const t=now();
        // Inventory can shorten a card's expiry while auth/intent I/O is pending.
        if(monotonic()>=c.deadlineMono||t>=c.confirmBy||(freshExpiresAt!==undefined&&t>=freshExpiresAt))fail('RESET_EXPIRED');
        if(challenges.get(challengeId)!==c)fail('RESET_ACCOUNT_CHANGED');
        dispatched=true;challenges.delete(challengeId);
      }});
      const resolved={...operation,state:'resolved',resolvedAt:now(),resultCode:result.code,...(result.windowsReset?{windowsReset:result.windowsReset}:{}),...(result.windowsResetCount!==undefined?{windowsResetCount:result.windowsResetCount}:{})};
      await put(resolved);
      if(quota.revision===who.viewRevision){
        quota.invalidateUsageSnapshot();quota.invalidateResetInventory();
        Promise.resolve().then(async()=>{if(result.code==='reset')await onReset(who);await Promise.allSettled([quota.read('usage',{owner:who,force:true}),quota.read('inventory',{owner:who,force:true})]);}).catch(()=>{});
      }
      return {...opView(resolved),viewRevision:who.viewRevision,outcome:'known'};
    }catch(e){
      if(dispatched){
        await put({...operation,state:'uncertain'}).catch(()=>{});
        if(quota.revision===who.viewRevision){quota.invalidateUsageSnapshot();quota.invalidateResetInventory();}
        throw error('RESET_UNCERTAIN',{operationId:operation.operationId,outcome:'uncertain',viewRevision:who.viewRevision});
      }
      if(wroteIntent)await put({...operation,state:c.kind==='recovery'?'uncertain':'cancelledBeforeDispatch'}).catch(()=>{});
      const authCode=resetAuthCode(e?.code);
      if(authCode)fail(authCode,{...e.details,outcome:'not-dispatched'});
      if(typeof e?.code==='string'&&e.code.startsWith('RESET_'))throw error(e.code,{...e.details,outcome:'not-dispatched'});
      throw error('RESET_UNAVAILABLE',{outcome:'not-dispatched'});
    }finally{busy.delete(c.key);}
  }
  async function status({owner:expected,operationId,signal}={}){allowed();const who=await owner(expected),r=await lookup(who,operationId);await fence(who);signal?.throwIfAborted();return {...opView(r),viewRevision:who.viewRevision};}
  async function reconcile({owner:expected,operationId,signal}={}){
    allowed();const who=await owner(expected),r=await lookup(who,operationId);
    const [usage,inv]=await Promise.all([
      quota.read('usage',{owner:who,force:true,signal}).catch(e=>{if(resetAuthCode(e?.code))throw resetOwnerError(e);throw e;}),
      inspect({owner:who,force:true,signal})
    ]);
    await fence(who);signal?.throwIfAborted();return {operation:opView(r),usage,inventory:inv,viewRevision:who.viewRevision};
  }
  return {inspect,prepare,cancel,consume,status,reconcile,recovery,rotate(){refs.clear();challenges.clear();prepareFlights.clear();}};
}
