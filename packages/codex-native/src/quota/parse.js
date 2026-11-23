// Adapted from WSL043 v3.2.27 usage/reset-credits parsers; Native owns auth and time units.
import { parseUsage } from '../usage.js';
export const object = x => x !== null && typeof x === 'object' && (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);
export const own = (x,k) => object(x) ? Object.getOwnPropertyDescriptor(x,k)?.value : undefined;
export const label = (x,n=120) => typeof x === 'string' ? x.replace(/[\x00-\x1f\x7f]/g,' ').trim().slice(0,n) || undefined : undefined;
export const error = (code, details={}) => Object.assign(new Error(code),{code,details});
const percent = n=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=100;
const token=x=>typeof x==='string'&&/^[a-z][a-z0-9_.-]{0,95}$/u.test(x)?x:undefined;
const optional=x=>x!==undefined&&x!==null;
export function decimal(value){
  if(typeof value==='number'&&Number.isFinite(value))value=value.toLocaleString('en-US',{useGrouping:false,maximumSignificantDigits:21});
  return typeof value==='string'&&value.length<=64&&/^-?\d+(?:\.\d+)?$/u.test(value)?value:undefined;
}
export function absolute(value){
  if(!Number.isSafeInteger(value)||value<=0||value>8640000000000)return undefined;
  return value*1000;
}
export function expiry(value){
  const ms=absolute(value)??(typeof value==='string'&&value.length<=64&&/^\d{4}-\d{2}-\d{2}T/u.test(value)?Date.parse(value):NaN);
  return Number.isFinite(ms)&&ms>0?ms:undefined;
}
const range=x=>Array.isArray(x)&&x.length===2&&x.every(n=>Number.isSafeInteger(n)&&n>=0)&&x[0]<=x[1]?[...x]:undefined;
const pick=(source,block)=>{const value=own(source,block);return typeof value==='boolean'?value:undefined;};
const defined=x=>Object.fromEntries(Object.entries(x).filter(([,v])=>v!==undefined));
export const RESET_CODES=Object.freeze(['reset','nothing_to_reset','no_credit','already_redeemed']);
export function parseInventory(body,now=Date.now()){
  const count=own(body,'available_count'), rows=own(body,'credits');
  if(!Number.isSafeInteger(count)||count<0||!Array.isArray(rows)||rows.length>256)throw error('RESET_INVENTORY_UNAVAILABLE');
  const seen=new Set(),cards=[];
  for(const row of rows){
    const id=own(row,'id'),raw=own(row,'expires_at'),expiresAt=expiry(raw);
    if(typeof id!=='string'||!id.trim()||id.length>256||/[\x00-\x1f\x7f]/u.test(id)||seen.has(id)||own(row,'status')!=='available'||(optional(raw)&&expiresAt===undefined)||(expiresAt!==undefined&&expiresAt<=now))continue;
    seen.add(id);cards.push(defined({id,name:label(own(row,'title')),description:label(own(row,'description'),240),expiresAt}));
  }
  cards.sort((a,b)=>(a.expiresAt??Infinity)-(b.expiresAt??Infinity)||a.id.localeCompare(b.id));
  return {availableCount:count,cards:count>0?cards:[],mismatch:count>0&&cards.length===0};
}
export function parseResetResult(body){
  const code=own(body,'code'),w=own(body,'windows_reset');
  if(!RESET_CODES.includes(code))throw error('RESET_UNCERTAIN');
  return {code,...(Array.isArray(w)?{windowsReset:w.slice(0,16).map(x=>token(x)).filter(Boolean)}:Number.isInteger(w)&&w>=0&&w<=16?{windowsResetCount:w}:{})};
}
export function parseQuota(body,now=Date.now()){
  if(!object(body)||!['rate_limit','additional_rate_limits','code_review_rate_limit','chatpass','credits','spend_control','rate_limit_reset_credits','plan_type','rate_limit_reached_type'].some(k=>Object.hasOwn(body,k)))throw error('QUOTA_BAD_RESPONSE');
  const sectionErrors=[], limits=[], ids=new Set();
  const bad=(section)=>{if(!sectionErrors.some(x=>x.section===section))sectionErrors.push({section,code:'QUOTA_BAD_SECTION'});};
  function add(id,name,raw,section){
    if(!optional(raw)||ids.has(id))return;
    if(!object(raw)){bad(section);return;}
    const windows=parseUsage({rate_limit:raw},{now}).windows;
    if(windows.length<['primary_window','secondary_window'].filter(k=>optional(own(raw,k))).length)bad(section);
    if(windows.length){ids.add(id);limits.push(defined({id,name,windows}));}
  }
  const main=own(body,'rate_limit');
  add('codex','Codex',main,'codex');
  const windows=limits[0]?.id==='codex'?limits[0].windows:[];
  const extra=own(body,'additional_rate_limits');
  if(optional(extra)){
    if(!Array.isArray(extra)||extra.length>64)bad('additional');
    else for(const row of extra){const id=token(own(row,'metered_feature'));if(!id){bad('additional');continue;}if(!['codex','code_review'].includes(id))add(id,label(own(row,'limit_name')),own(row,'rate_limit'),'additional');}
  }
  add('code_review','Code review',own(body,'code_review_rate_limit'),'codeReview');
  const c=own(body,'credits'), s=own(body,'spend_control'), i=own(s,'individual_limit');
  const exp=expiry(own(c,'expires_at'));
  const credits=object(c)?defined({hasCredits:pick(c,'has_credits'),unlimited:pick(c,'unlimited'),balance:decimal(own(c,'balance')),expiresAt:exp,expirySource:exp!==undefined?'api':undefined,approxLocalMessages:range(own(c,'approx_local_messages')),approxCloudMessages:range(own(c,'approx_cloud_messages'))}):undefined;
  if(optional(c)&&(!credits||!Object.keys(credits).length||['balance','expires_at','has_credits','unlimited','approx_local_messages','approx_cloud_messages'].some((k,n)=>optional(own(c,k))&&!optional(credits[['balance','expiresAt','hasCredits','unlimited','approxLocalMessages','approxCloudMessages'][n]]))))bad('credits');
  let individualLimit;
  if(optional(i)){
    const limit=decimal(own(i,'limit')),used=decimal(own(i,'used')),remainingPercent=own(i,'remaining_percent'),resetAt=absolute(own(i,'reset_at'));
    if(limit===undefined||used===undefined||!percent(remainingPercent))bad('spending');
    else individualLimit=defined({limit,used,remainingPercent,resetAt});
  }
  const spendControlReached=pick(s,'reached');
  if(optional(s)&&(!object(s)||(optional(own(s,'reached'))&&spendControlReached===undefined)))bad('spending');
  let resetCredits;
  const reset=own(body,'rate_limit_reset_credits');
  if(optional(reset))try{
    const rows=own(reset,'credits');const parsed=parseInventory({available_count:own(reset,'available_count'),credits:rows??[]},now);
    resetCredits=defined({availableCount:parsed.availableCount,credits:parsed.cards.map(({name,expiresAt})=>defined({name,expiresAt})),nextExpiresAt:parsed.cards[0]?.expiresAt});
  }catch{bad('resets');}
  let chatPass;
  const chat=own(body,'chatpass');
  if(optional(chat)){
    const rows=own(chat,'windows');
    if(!Array.isArray(rows)||rows.length>32)bad('chatPass');
    else{const parsed=rows.flatMap(raw=>parseUsage({rate_limit:{primary_window:raw}},{now}).windows);if(parsed.length!==rows.length)bad('chatPass');if(parsed.length)chatPass={windows:parsed};}
  }
  const reason=own(body,'rate_limit_reached_type');
  // A percentage below 100 is not proof of recovery if WHAM still denies calls.
  const codexBlocked=pick(main,'allowed')===false||pick(main,'limit_reached')===true?true:undefined;
  return defined({schemaVersion:2,state:windows.length?(sectionErrors.length?'partial':'available'):(limits.length||credits||resetCredits||chatPass?'partial':'unknown'),windows,rateLimits:limits,planType:token(own(body,'plan_type')),rateLimitReachedType:token(typeof reason==='string'?reason:own(reason,'type')),codexBlocked,spendControlReached,credits:credits&&Object.keys(credits).length?credits:undefined,individualLimit,resetCredits,chatPass,sectionErrors:sectionErrors.length?sectionErrors:undefined});
}
export function legacyUsage(snapshot){
  const c=snapshot.credits;
  return defined({state:snapshot.windows?.length?'available':'unknown',windows:snapshot.windows??[],checkedAt:snapshot.checkedAt,stale:snapshot.stale,planType:snapshot.planType,credits:c?defined({hasCredits:c.hasCredits,unlimited:c.unlimited,balance:typeof c.balance==='string'&&Number.isFinite(Number(c.balance))&&Number(c.balance)>=0?Number(c.balance):undefined}):undefined});
}
