// WSL043 forecast math; Native owns timestamps, retention, account scoping and writes.
import { observeQuotaForecast, estimateQuotaForecast } from './quota-forecast.js';
import { forecastRunway } from './quota-pace.js';
import { readJson,writeJson,serialize } from './store.js';
import { error } from './parse.js';
const H=3600000, DAY=24*H, LIMIT=256*1024;
const scopePattern=/^[a-f0-9]{64}$/u, limitPattern=/^[a-z][a-z0-9_.-]{0,95}$/u;
const whole=(x)=>Number.isSafeInteger(x)&&x>=0;
const main=(snapshot)=>snapshot?.rateLimits?.find(l=>l.id==='codex');
const timed=(x,now)=>whole(x)&&x<=now&&now-x<=5*60000;
function readKey(key){try{const a=JSON.parse(key);return Array.isArray(a)&&a.length===3&&scopePattern.test(a[0])&&limitPattern.test(a[1])&&Number.isSafeInteger(a[2])&&a[2]>0?a:null;}catch{return null;}}
function compact(samples,now){
  const recent=[],older=new Map(),marks=[];
  for(const p of samples){
    if(p.at<now-30*DAY||p.at>now)continue;
    if(p.at>=now-2*H){recent.push(p);continue;}
    if(p.reset){marks.push(p);continue;}
    const width=p.at>=now-7*DAY?2*H:8*H;
    older.set(`${width}:${Math.floor(p.at/width)}`,p);
  }
  const protectedItems=[...marks,...recent.filter(p=>p.reset)].slice(-176);
  const plainRecent=recent.filter(p=>!p.reset).slice(-Math.max(1,104-recent.filter(p=>p.reset).length));
  const left=Math.max(0,280-protectedItems.length-plainRecent.length);
  return [...protectedItems,...(left?[...older.values()].slice(-left):[]),...plainRecent].sort((a,b)=>a.at-b.at);
}
function bounded(input,now){
  const windows=Object.create(null);
  for(const [k,r] of Object.entries(input.windows??{}).slice(0,4096)){
    if(!readKey(k)||!Array.isArray(r?.samples)||r.samples.length>281||!whole(r.epochStart)||r.epochStart>now||!(r.resetsAt===null||Number.isFinite(r.resetsAt)&&r.resetsAt>0))continue;
    let last=-1; const samples=[];
    for(const p of r.samples){if(!whole(p?.at)||p.at<=last||p.at>now||!Number.isFinite(p.remainingPercent)||p.remainingPercent<0||p.remainingPercent>100)continue;last=p.at;samples.push({at:p.at,remainingPercent:p.remainingPercent,...(p.reset===true?{reset:true}:{})});}
    const safe=compact(samples,now);if(safe.length)windows[k]={epochStart:r.epochStart,resetsAt:r.resetsAt,samples:safe};
  }
  let keys=Object.keys(windows).sort((a,b)=>windows[b].samples.at(-1).at-windows[a].samples.at(-1).at);
  for(const k of keys.slice(128))delete windows[k];keys=keys.slice(0,128);
  const resets=Object.fromEntries(Object.entries(input.resets??{}).filter(([k,v])=>scopePattern.test(k)&&whole(v)&&v<=now&&now-v<=30*DAY).sort((a,b)=>b[1]-a[1]).slice(0,128));
  const out={schemaVersion:1,windows,resets};
  while(keys.length&&Buffer.byteLength(JSON.stringify(out),'utf8')+1>LIMIT)delete windows[keys.pop()];
  return out;
}
export function createForecastStore({file,readOnly=false,now=Date.now,enabled=()=>false,onFailure=()=>{}}){
  const sync=serialize();let state={schemaVersion:1,windows:{},resets:{}},failed=false;
  const ready=readJson(file,LIMIT).then(x=>{if(x?.schemaVersion===1)state=bounded(x,now());}).catch(()=>{failed=true;});
  async function commit(next){state=bounded(next,now());try{await writeJson(file,state,LIMIT);failed=false;}catch{failed=true;onFailure();}}
  const donor=w=>({...w,resetsAt:w.resetAt===null?null:w.resetAt/1000});
  const windowKey=(scope,id,w)=>JSON.stringify([scope,id,w.windowSeconds]);
  const read=(owner,snapshot,filters={})=>{
    if(!enabled())return {state:'off',rows:[]};
    const at=snapshot?.checkedAt,t=now();
    const rows=[];
    for(const l of snapshot?.rateLimits??[]){if(filters.limitId!==undefined&&l.id!==filters.limitId)continue;
      for(const w of l.windows){if(!w.windowSeconds||(filters.windowSeconds!==undefined&&w.windowSeconds!==filters.windowSeconds))continue;
        const estimate=snapshot.stale||!timed(at,t)||(w.resetAt!==null&&w.resetAt<=t)?{status:'calibrating',reason:'stale'}:estimateQuotaForecast(state,donor(w),t,{scope:owner.scope,limitId:l.id});
        const last=state.windows[windowKey(owner.scope,l.id,w)]?.samples.at(-1)?.at??null;
        const atOf=s=>last!==null&&Number.isFinite(s)&&s>=0&&s<=30*DAY/1000?last+s*1000:undefined;
        const display=forecastRunway(estimate);
        rows.push({limitId:l.id,windowSeconds:w.windowSeconds,remainingPercent:w.remainingPercent,estimate,lastObservedAt:last,exhaustionAt:atOf(display?.seconds),exhaustionFrom:atOf(display?.min),exhaustionTo:atOf(display?.max)});
    }}
    return {state:rows.length?'available':'calibrating',approximate:true,persistenceFailed:failed,rows};
  };
  return {
    async observe(owner,snapshot,isCurrent=()=>true){
      if(readOnly||!enabled()||snapshot.stale||!timed(snapshot.checkedAt,now()))return;
      await ready;return sync(async()=>{
        if(!enabled()||!isCurrent()||!timed(snapshot.checkedAt,now()))return;
        let windows={...state.windows},changed=false;
        for(const l of snapshot.rateLimits){for(const w of l.windows){
          if(!w.windowSeconds||w.resetAt!==null&&w.resetAt<=snapshot.checkedAt)continue;
          const k=windowKey(owner.scope,l.id,w),prior=windows[k];
          if(prior?.samples.at(-1)?.at>=snapshot.checkedAt)continue;
          const {state:next}=observeQuotaForecast({windows:{[k]:prior}},[donor(w)],snapshot.checkedAt,{scope:owner.scope,limitId:l.id});
          const r=next.windows[k];if(!r)continue;
          const p=r.samples.at(-1);if((state.resets?.[owner.scope]??-1)>(prior?.samples.at(-1)?.at??-1)){p.reset=true;r.epochStart=p.at;}
          windows[k]={...r,samples:compact([...(prior?.samples??[]),p],snapshot.checkedAt)};changed=true;
        }}
        if(changed)await commit({...state,windows});
      });
    },
    async result(owner,snapshot,filters){await ready;return read(owner,snapshot,filters);},
    async mark(owner){if(readOnly||!enabled())return;await ready;return sync(async()=>{if(enabled())await commit({...state,resets:{...state.resets,[owner.scope]:now()}});});},
    async clear(owner){if(readOnly)throw error('QUOTA_MANAGED_BY_DESKTOP');await ready;return sync(async()=>{
      const windows=Object.fromEntries(Object.entries(state.windows).filter(([k])=>readKey(k)?.[0]!==owner.scope));
      const resets={...state.resets};delete resets[owner.scope];await commit({windows,resets});if(failed)throw error('QUOTA_FORECAST_IO');
    });}
  };
}
export function createWarnings(){
  const fired=new Map();
  return {reset:()=>fired.clear(),read(owner,snapshot,prefs,now=Date.now()){
    if(prefs.quotaAlerts==='off'||snapshot?.stale||!timed(snapshot?.checkedAt,now))return [];
    const warnings=[];
    for(const w of main(snapshot)?.windows??[]){
      if(w.resetAt===null||w.resetAt<=now||!w.windowSeconds)continue;
      const short=w.windowSeconds<=21600;
      const threshold=prefs.quotaAlerts==='custom'?(short?prefs.shortWarningThreshold:prefs.longWarningThreshold):prefs.quotaAlerts==='early'&&short?50:20;
      const key=JSON.stringify([owner.viewRevision,'codex',w.windowSeconds,w.resetAt,threshold]);
      if(w.remainingPercent<=threshold){
        const crossing=!fired.has(key);if(crossing){if(fired.size>=128)fired.delete(fired.keys().next().value);fired.set(key,true);}
        warnings.push({id:key,windowSeconds:w.windowSeconds,remainingPercent:w.remainingPercent,resetAt:w.resetAt,threshold,crossing});
      }else fired.delete(key);
    }
    return warnings;
  }};
}
