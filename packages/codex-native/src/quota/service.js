import { randomUUID, createHash } from 'node:crypto';
import { readMetadataBody } from '../model-catalog.js';
import { error,parseQuota,parseInventory,parseResetResult } from './parse.js';
import { parsePlanHistory,parseUsageProfile } from './report.js';
import { quotaRefreshMs,highestUsed } from './quota-cadence.js';

const MB=1024*1024;
const base='https://chatgpt.com/backend-api/wham/';
const paths={usage:['usage',MB,parseQuota],inventory:['rate-limit-reset-credits',MB,parseInventory],history:['usage/plan_limit_history?days=7',4*MB,parsePlanHistory],profile:['profiles/me',4*MB,parseUsageProfile],consume:['rate-limit-reset-credits/consume',MB,parseResetResult]};
const ttl={inventory:60000,history:300000,profile:1800000};
const timestamp=x=>Number.isFinite(x)&&x>=0;
const hash=x=>createHash('sha256').update(x).digest('hex');
export const stableAccountKey=account=>hash('codex-native-reset-account-v1\0'+account);

function statusError(response, now){
  const status=response.status;
  const code=({401:'QUOTA_AUTH_REQUIRED',403:'QUOTA_ACCESS_DENIED',404:'QUOTA_NOT_PROVIDED',429:'QUOTA_THROTTLED'})[status]??'QUOTA_HTTP_FAILURE';
  const value=response.headers.get('retry-after');
  const deadline=value===null?NaN:/^\d+(?:\.\d+)?$/u.test(value)?now+Number(value)*1000:Date.parse(value);
  return error(code,{...(status===429&&timestamp(deadline)&&deadline>now?{retryAt:deadline}:{})});
}

export function createQuotaService({getIdentity,acquireAuth,fetcher=(...args)=>fetch(...args),now=Date.now,onRotate=()=>{},onUsage=()=>{},onActive=()=>{}}){
  let identity=null,viewRevision=randomUUID(),closed=false,epoch=0;
  let identityFlight;
  const cache=new Map();
  function invalidate(keys=[...cache.keys()]){
    for(const key of keys){const entry=cache.get(key);entry?.flight?.controller.abort();
      // Invalidation marks values stale without removing a provider Retry-After.
      if(entry){entry.flight=null;entry.invalid=true;}}
  }
  function rotate(next=null){
    invalidate();cache.clear();identity=next;viewRevision=randomUUID();epoch++;identityFlight=null;onRotate();
  }
  async function current({optional=false}={}){
    if(closed)throw error('QUOTA_DISPOSED');
    if(!identityFlight){
      const generation=epoch;
      const pending=Promise.resolve().then(getIdentity).then(fresh=>{
        if(closed)throw error('QUOTA_DISPOSED');
        if(generation!==epoch)throw error('QUOTA_ACCOUNT_CHANGED');
        if((fresh?.scope??null)!==(identity?.scope??null))rotate(fresh??null);
        return fresh?{...fresh,viewRevision}:null;
      },err=>{if(generation===epoch&&identity)rotate();throw err;}).finally(()=>{if(identityFlight===pending)identityFlight=null;});
      identityFlight=pending;
    }
    let fresh;
    try{fresh=await identityFlight;}catch(e){if(optional&&!closed&&e.code!=='QUOTA_ACCOUNT_CHANGED')return null;throw e;}
    if(fresh&&fresh.viewRevision!==viewRevision)throw error('QUOTA_ACCOUNT_CHANGED');
    if(!fresh&&!optional)throw error('QUOTA_AUTH_REQUIRED');
    return fresh;
  }
  async function assertCurrent(owner){const latest=await current();if(latest.scope!==owner.scope||latest.viewRevision!==owner.viewRevision)throw error('QUOTA_ACCOUNT_CHANGED');return latest;}
  async function network(owner,kind,signal,options){
    const [path,maxBytes,parse]=paths[kind];const consume=kind==='consume';
    const bounded=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(15000)]);
    await assertCurrent(owner);bounded.throwIfAborted();
    onActive(1);
    try{
      const auth=await acquireAuth(owner);await assertCurrent(owner);bounded.throwIfAborted();
      if(auth.scope!==owner.scope||auth.account!==owner.account)throw error('QUOTA_ACCOUNT_CHANGED');
      const headers={authorization:'Bearer '+auth.access,'chatgpt-account-id':auth.account,originator:'codex_cli_rs',accept:'application/json'};
      if(consume){headers['content-type']='application/json';options.beforeDispatch();}
      const networkSignal=consume?AbortSignal.timeout(15000):bounded;
      const response=await fetcher(base+path,{method:consume?'POST':'GET',headers,signal:networkSignal,redirect:'error',...(consume?{body:JSON.stringify({redeem_request_id:options.redeemRequestId,credit_id:options.creditId})}:{})});
      if(!response.ok){await response.body?.cancel().catch(()=>{});throw statusError(response,now());}
      const type=response.headers.get('content-type');
      if(type&&!/^(application\/(?:json|[a-z0-9.+-]+\+json))\b/iu.test(type)){await response.body?.cancel().catch(()=>{});throw error('QUOTA_BAD_RESPONSE');}
      const body=await readMetadataBody(response,{signal:networkSignal,maxBytes}).catch(()=>{throw error('QUOTA_BAD_RESPONSE');});
      networkSignal.throwIfAborted();const receivedAt=now();
      if(!consume)await assertCurrent(owner); // a sent mutation settles the original owner's journal, not the current cache
      return {value:parse(body,receivedAt),receivedAt};
    }finally{onActive(-1);}
  }
  function join(promise,signal){
    if(!signal)return promise;
    signal.throwIfAborted();
    let onAbort;const abort=new Promise((_,reject)=>{onAbort=()=>reject(signal.reason);signal.addEventListener('abort',onAbort,{once:true});});
    return Promise.race([promise,abort]).finally(()=>signal.removeEventListener('abort',onAbort));
  }
  function expiredReset(value,nowMs){return value?.rateLimits?.some(l=>l.windows.some(w=>w.resetAt!==null&&w.resetAt<=nowMs))===true;}
  function fresh(e,kind,t){return e.checkedAt!==null&&t-e.checkedAt<(kind==='usage'?quotaRefreshMs(highestUsed(e.value?.windows??[])):ttl[kind])&&!e.invalid&&!e.code&&(kind!=='usage'||!expiredReset(e.value,t));}
  function snapshot(e,owner,kind){
    const t=now();const meta={viewRevision:owner.viewRevision,checkedAt:e.checkedAt,stale:!fresh(e,kind,t),refreshing:!!e.flight,...(e.retryAt>t?{retryAt:e.retryAt}:{}),...(e.code?{errorCode:e.code}:{})};
    if(kind==='usage')return {...(e.value??{schemaVersion:2,state:'unknown',windows:[],rateLimits:[]}),...meta};
    return {state:e.value?'available':e.code==='QUOTA_NOT_PROVIDED'?'unavailable':'unknown',data:e.value??null,...meta};
  }
  function createFlight(kind,e,owner){
    const controller=new AbortController();const flight={controller,promise:null};e.flight=flight;
    const relevant=()=>e.flight===flight&&owner.scope===identity?.scope&&owner.viewRevision===viewRevision;
    flight.promise=network(owner,kind,controller.signal).then(({value,receivedAt})=>{
      if(!relevant())throw error('QUOTA_ACCOUNT_CHANGED');
      if(kind==='usage'&&value.state==='unknown'&&e.value)throw error('QUOTA_BAD_RESPONSE');
      e.value=value;e.checkedAt=receivedAt;e.code=null;e.failures=0;e.retryAt=0;e.invalid=false;
      if(kind==='usage')Promise.resolve().then(()=>relevant()||owner.viewRevision===viewRevision?onUsage(owner,snapshot(e,owner,kind)):undefined).catch(()=>{});
    }).catch(err=>{
      if(!relevant())throw error('QUOTA_ACCOUNT_CHANGED');
      e.code=typeof err?.code==='string'&&/^(QUOTA_|RESET_INVENTORY_)/u.test(err.code)?err.code:'QUOTA_UNAVAILABLE';e.failures++;
      const cool=e.code==='QUOTA_NOT_PROVIDED'?(ttl[kind]??60000):Math.min(300000,5000*2**Math.min(8,e.failures-1));
      e.retryAt=Math.max(now()+cool,err?.details?.retryAt??0);
    }).finally(()=>{if(e.flight===flight)e.flight=null;});
    flight.promise.catch(()=>{});return flight.promise;
  }
  async function read(kind,{force=false,signal,owner}={}){
    if(!Object.hasOwn(paths,kind)||kind==='consume')throw error('QUOTA_UNKNOWN_REPORT');
    signal?.throwIfAborted();owner=owner?await assertCurrent(owner):await current();signal?.throwIfAborted();
    let e=cache.get(kind);if(!e){e={value:null,checkedAt:null,code:null,failures:0,retryAt:0,flight:null,invalid:false};cache.set(kind,e);}
    const t=now();if(e.flight)await join(e.flight.promise,signal);
    else if((force||!fresh(e,kind,t))&&t>=e.retryAt)await join(createFlight(kind,e,owner),signal);
    signal?.throwIfAborted();await assertCurrent(owner);return snapshot(e,owner,kind);
  }
  return {current,assertCurrent,read,get revision(){return viewRevision;},
    consume:(owner,details)=>network(owner,'consume',details.signal,details).then(x=>x.value),
    invalidateUsageSnapshot:()=>invalidate(['usage']),invalidateResetInventory:()=>invalidate(['inventory']),invalidateReports:()=>invalidate(['history','profile']),rotate,
    peekUsage:owner=>owner&&owner.viewRevision===viewRevision&&cache.has('usage')?snapshot(cache.get('usage'),owner,'usage'):null,
    dispose(){closed=true;rotate();}
  };
}
