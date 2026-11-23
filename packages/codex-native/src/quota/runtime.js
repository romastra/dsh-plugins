import { fileURLToPath } from 'node:url';
import { createQuotaService, stableAccountKey } from './service.js';
import { createPreferences } from './store.js';
import { createForecastStore, createWarnings } from './history-store.js';
import { createResetJournal } from './reset-journal.js';
import { createResetService,resetOwnerError } from './reset-service.js';
import { createQuotaRecovery, qualifies } from './recovery.js';
import { error,legacyUsage,object } from './parse.js';

export const QUOTA_ACTIONS=Object.freeze(['usageV2','usageHistory','usageProfile','quotaForecast','quotaPreferences','setQuotaPreferences','clearQuotaForecast','resetInspect','resetPrepare','resetCancel','resetConsume','resetOperationStatus','resetReconcile','resetRecoveryPrepare']);
const changes=new Set(['setQuotaPreferences','clearQuotaForecast','resetPrepare','resetCancel','resetConsume','resetRecoveryPrepare']);
const id=x=>typeof x==='string'&&/^[a-zA-Z0-9-]{1,100}$/u.test(x);
export function createQuotaRuntime({directory,ownerManaged,getIdentity,acquireAuth,onActive,now=()=>Date.now(),fetcher,monotonic}){
  const file=name=>fileURLToPath(new URL(name,directory));
  const warnings=createWarnings();
  const prefs=createPreferences({file:file('quota-preferences.json'),readOnly:ownerManaged,changed:(v,p)=>{if(p.autoQuotaRetry&&!v.autoQuotaRetry)recovery.stop();}});
  const forecast=createForecastStore({file:file('quota-forecast-history.json'),readOnly:ownerManaged,enabled:()=>prefs.get().forecastEnabled,now});
  const errors=new WeakMap();
  const quota=createQuotaService({getIdentity:async()=>{const who=await getIdentity();return who?{...who,stableAccountKey:stableAccountKey(who.account)}:null;},acquireAuth,onActive,now,fetcher,
    onRotate(){reset.rotate();warnings.reset();recovery.stop();},
    async onUsage(owner,snapshot){await forecast.observe(owner,snapshot,()=>quota.revision===owner.viewRevision);}
  });
  const recovery=createQuotaRecovery({quota,prefs:prefs.get,now,takeFailure:(failure,signal)=>{
    const source=errors.get(signal);errors.delete(signal);return source?.code===failure.code?source:null;
  }});
  const journal=ownerManaged?null:createResetJournal({file:file('reset-operations.json'),now});
  const reset=createResetService({quota,journal,ownerManaged,now,monotonic,onReset:async owner=>{await forecast.mark(owner);recovery.wake(owner);}});
  const unknown=()=>({schemaVersion:2,viewRevision:quota.revision,state:'unknown',windows:[],rateLimits:[],checkedAt:null,stale:true,refreshing:false});
  async function usage(owner,{force=false,signal}={}){
    if(!owner)return unknown();
    const data=await quota.read('usage',{force,signal,owner});
    return {...data,warnings:warnings.read(owner,data,prefs.get(),now()),modelBucketKnown:false};
  }
  async function dispatch(action,p,signal){
    if(!QUOTA_ACTIONS.includes(action))throw error('QUOTA_UNKNOWN_ACTION');
    await prefs.ready;
    const isMutation=changes.has(action),isReset=action.startsWith('reset');
    const notDispatched=action==='resetConsume'?{outcome:'not-dispatched'}:undefined;
    let owner;
    try{owner=await quota.current({optional:!isReset&&!isMutation&&action!=='usageHistory'&&action!=='usageProfile'});}catch(e){
      if(isReset)throw error(resetOwnerError(e).code,notDispatched);throw e;
    }
    const revision=owner?.viewRevision??quota.revision;
    if((isMutation||p.viewRevision!==undefined)&&p.viewRevision!==revision)throw error(isReset?'RESET_ACCOUNT_CHANGED':'QUOTA_ACCOUNT_CHANGED',notDispatched);
    if(p.force!==undefined&&typeof p.force!=='boolean')throw error('QUOTA_INVALID_ARGUMENT');
    for(const k of ['challengeId','operationId','creditRef'])if(p[k]!==undefined&&!id(p[k]))throw error('QUOTA_INVALID_ARGUMENT');
    const common={...p,signal,owner};
    let value;
    switch(action){
      case 'usageV2': return usage(owner,common);
      case 'usageHistory':case 'usageProfile':return quota.read(action==='usageHistory'?'history':'profile',common);
      case 'quotaPreferences':value={preferences:prefs.get(),ownerManaged};break;
      case 'setQuotaPreferences':if(!object(p.patch))throw error('QUOTA_PREFERENCES_INVALID');value={preferences:await prefs.set(p.patch),ownerManaged};break;
      case 'quotaForecast': {
        if(!owner)return {state:'unknown',rows:[],viewRevision:revision};
        if(p.limitId!==undefined&&!id(p.limitId)||p.windowSeconds!==undefined&&(!Number.isSafeInteger(p.windowSeconds)||p.windowSeconds<1))throw error('QUOTA_INVALID_ARGUMENT');
        const snapshot=prefs.get().forecastEnabled?await quota.read('usage',{owner,signal}):null;
        value=await forecast.result(owner,snapshot,p);break;
      }
      case 'clearQuotaForecast':if(p.acknowledged!==true)throw error('QUOTA_ACK_REQUIRED');await forecast.clear(owner);value={cleared:true};break;
      case 'resetInspect':return reset.inspect(common);
      case 'resetPrepare':return reset.prepare(common);
      case 'resetCancel':return reset.cancel(common);
      case 'resetConsume': {
        const fenceOutcome=async()=>{
          try{await quota.assertCurrent(owner);}catch{throw error('RESET_ACCOUNT_CHANGED');}
        };
        try{value=await reset.consume(common);}catch(e){
          if(e?.details?.outcome==='uncertain')await fenceOutcome();
          throw e;
        }
        await fenceOutcome();return value;
      }
      case 'resetOperationStatus':return reset.status(common);
      case 'resetReconcile':return reset.reconcile(common);
      case 'resetRecoveryPrepare':return reset.recovery(common);
    }
    if(owner)await quota.assertCurrent(owner);
    return {...value,viewRevision:revision};
  }
  return {get revision(){return quota.revision;},ready:prefs.ready,dispatch,rotate:()=>quota.rotate(),async status(){await quota.current({optional:true});return quota.revision;},
    legacy:async options=>legacyUsage(await usage(await quota.current({optional:true}),options)),handleError:recovery.handle,admitRetry:recovery.admitRetry,
    rememberFailure(signal,scope,failure,httpStatus){
      if(!signal)return;
      errors.delete(signal);
      if(qualifies(failure,httpStatus))errors.set(signal,{scope,code:failure.code});
    },
    background(expectedScope,signal){
      void prefs.ready.then(async()=>{
        if(!expectedScope||signal?.aborted||!prefs.get().forecastEnabled)return;
        const owner=await quota.current({optional:true});
        if(owner?.scope===expectedScope&&prefs.get().forecastEnabled)await quota.read('usage',{owner,signal});
      }).catch(()=>{});
    },
    dispose(){quota.dispose();recovery.stop();}
  };
}
