// Adapted WSL043 quota-retry policy; only known main Codex reset windows can park a step.
import { randomUUID } from 'node:crypto';
const SHORT_SECONDS=6*3600, WEEK_SECONDS=7*86400, MARGIN=10000;
const usageLimit=/^You have hit your ChatGPT usage limit(?: \([a-z0-9][a-z0-9 ._-]{0,39} plan\))?\.(?: Try again in ~\d{1,6} min\.)?$/u;
export function qualifies(f,httpStatus=f?.status){
  // Pi 1.3 can render even a 403/usage_not_included as the same friendly text.
  // The phrase is an admission hint, not a source of deadlines or authorization.
  return (f?.code==='RATE_LIMIT'||f?.code==='PI_AI_ERROR'&&typeof f.message==='string'&&usageLimit.test(f.message))&&
    f.status!==401&&f.status!==403&&(httpStatus===undefined||httpStatus===429||httpStatus>=200&&httpStatus<300)&&
    !/usage restricted|access denied|spend cap|spending limit/i.test(f.message??'');
}
function maxWait(seconds){
  if(!Number.isSafeInteger(seconds)||seconds<=0)return 0;
  if(seconds<=SHORT_SECONDS)return SHORT_SECONDS*1000;
  // Match the weekly duration band in usage.js; cap the timer at one week + margin.
  return seconds>=WEEK_SECONDS*0.95&&seconds<=WEEK_SECONDS*1.05 ? WEEK_SECONDS*1000+MARGIN : 0;
}
export function assessWindow(snapshot,now){
  if(snapshot?.stale!==false||!Number.isFinite(snapshot.checkedAt)||snapshot.checkedAt>now||now-snapshot.checkedAt>300000||snapshot.spendControlReached===true||/^workspace_.*usage_limit_reached$/u.test(snapshot.rateLimitReachedType??'')||snapshot.sectionErrors?.some(s=>s.section==='codex'||s.section==='spending'))return {state:'invalid'};
  const w=snapshot.rateLimits?.find(x=>x.id==='codex')?.windows;
  if(!w?.length||w.some(x=>!Number.isFinite(x.usedPercent)))return {state:'invalid'};
  const exhausted=w.filter(x=>x.usedPercent>=99.9);
  if(!exhausted.length)return {state:snapshot.codexBlocked===true?'invalid':'available'};
  if(exhausted.some(x=>!Number.isFinite(x.resetAt)||x.resetAt<=now||x.resetAt-now+MARGIN>maxWait(x.windowSeconds)))return {state:'invalid'};
  return {state:'wait',when:Math.max(...exhausted.map(w=>w.resetAt))+MARGIN};
}
function delay(ms,signal){return new Promise(resolve=>{
  if(signal.aborted){resolve('cancel');return;}
  const complete=value=>{clearTimeout(id);signal.removeEventListener('abort',abort);resolve(value);};
  const abort=()=>complete('cancel'),id=setTimeout(()=>complete('timer'),ms);
  signal.addEventListener('abort',abort,{once:true});
});}
export function createQuotaRecovery({quota,prefs,now=Date.now,wait=delay,takeFailure=()=>null}){
  let active=new AbortController();const attempted=new WeakMap(),permits=new WeakMap(),waiting=new Set();
  const stop=()=>{active.abort();active=new AbortController();};
  function wake(owner){for(const w of waiting)if(w.scope===owner.scope&&w.revision===owner.viewRevision)w.wake();}
  // Host owns execution; fence the next attempt even if the account changed
  // after the countdown finished but before Host re-prepared the request.
  function admitRetry(signal,scope){
    const permit=permits.get(signal);if(!permit)return;
    permits.delete(signal);
    if(permit.owner.scope!==scope||permit.owner.viewRevision!==quota.revision)
      return {code:'CODEX_QUOTA_ACCOUNT_CHANGED',message:'The Codex account changed during quota recovery. The request was not retried.'};
    if(permit.signal.aborted||!prefs().autoQuotaRetry)
      return {code:'CODEX_QUOTA_RECOVERY_CANCELLED',message:'Codex quota recovery was cancelled. The request was not retried.'};
  }
  async function handle(payload,next){
    const {agent,turn,step,provider,failure,signal}=payload;
    if(provider!=='openai-codex'||!qualifies(failure))return next();
    const source=takeFailure(failure,signal);if(!source||signal.aborted||typeof agent?.session?.append!=='function')return next();
    const prior=attempted.get(agent);
    if(prior?.turn===turn&&prior.steps.has(step))return; // no second quota wait or quota retry for this step
    if(!prefs().autoQuotaRetry)return next();
    let owner;
    try{owner=await quota.current();}catch{return signal.aborted?undefined:next();}
    if(owner.scope!==source.scope||signal.aborted||!prefs().autoQuotaRetry)return;
    // The first identity read can rotate an empty runtime into its initial scope.
    // Capture the wait epoch only after admitting the request's actual scope.
    const own=active.signal, aborted=AbortSignal.any([signal,own]);
    let snapshot;
    try{snapshot=await quota.read('usage',{force:true,signal:aborted,owner});}catch{return aborted.aborted?undefined:next();}
    if(aborted.aborted||!prefs().autoQuotaRetry)return;
    const plan=assessWindow(snapshot,now());if(plan.state!=='wait')return next();
    if(attempted.get(agent)?.turn!==turn)attempted.set(agent,{turn,steps:new Set()});
    const steps=attempted.get(agent).steps;if(steps.has(step))return;
    const retryId=randomUUID(),scheduled={retryId,turn,step,retry:1};
    try{agent.session.append('llm/retry',{...scheduled,provider,mode:'normal',policyKey:'codex-native-quota-'+retryId,maxRetries:1,delayMs:Math.max(0,plan.when-now()),failure:{code:failure.code,message:`Codex quota exhausted. Waiting until ${new Date(plan.when).toISOString()}`}});}catch{return next();}
    steps.add(step);
    try{
      while(!aborted.aborted&&prefs().autoQuotaRetry){
        const sub=new AbortController(),s=AbortSignal.any([aborted,sub.signal]);
        let entry;const wakeable=new Promise(resolve=>{entry={scope:owner.scope,revision:owner.viewRevision,wake:()=>resolve('wake')};waiting.add(entry);});
        let reason;try{reason=await Promise.race([wait(Math.max(0,plan.when-now()),s),wakeable]);}finally{waiting.delete(entry);sub.abort();}
        if(aborted.aborted||reason==='cancel'||!prefs().autoQuotaRetry)return;
        const updated=await quota.read('usage',{force:true,signal:aborted,owner});
        if(aborted.aborted||!prefs().autoQuotaRetry)return;
        const check=assessWindow(updated,now());
        if(check.state!=='available'){if(reason==='wake'&&now()<plan.when)continue;return;}
        await quota.assertCurrent(owner);if(aborted.aborted||!prefs().autoQuotaRetry)return;
        agent.session.append('llm/retry-started',scheduled);
        permits.set(signal,{owner,signal:aborted});
        return {kind:'retry'};
      }
    }catch{return undefined;}
  }
  return {handle,stop,wake,admitRetry};
}
