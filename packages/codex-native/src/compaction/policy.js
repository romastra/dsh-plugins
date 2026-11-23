export const CLOUD_RECORD='plugin:codex-native/cloud-compaction';
export const CLOUD_KEY='codex-native/cloud-compaction';
export const CLOUD_ACTIONS=['cloudCompaction','setCloudCompaction'];
export const defaultCloud=()=>({version:1,mode:'off',thresholdTokens:null});
export function cloudPolicy(mode,thresholdTokens){
 if(!['off','cloud'].includes(mode)||thresholdTokens!==null&&(!Number.isSafeInteger(thresholdTokens)||thresholdTokens<1000))throw Object.assign(Error('Invalid cloud mode or threshold'),{code:'CLOUD_POLICY_INVALID'});
 return {version:1,mode,thresholdTokens};
}
import { compactionThreshold } from './budget.js';
export function installCloud({ctx,z,appendPluginRecord,sessionFor,describeModel}){
 const stateSchema=z.object({version:z.literal(1),mode:z.enum(['off','cloud']),thresholdTokens:z.number().int().min(1000).nullable()});
 const reduce=(state,event)=>{
  if(event.type==='session/end-seed'&&event.data?.inherited===true)return defaultCloud();
  if(event.type!==CLOUD_RECORD||event.data?.version!==1)return state;
  try{return cloudPolicy(event.data.mode,event.data.thresholdTokens);}catch{return state;}
 };
 const ready=ctx.sessionProjections.register({key:CLOUD_KEY,stateVersion:1,stateSchema,init:defaultCloud,apply:reduce});
 const stateOf=(h,s)=>s.inheritedEventCount?s.snapshotEvents().filter(e=>e.seq>=s.inheritedEventCount).reduce(reduce,defaultCloud()):h.stateOf(s);
 // AgentLoop awaits this after SessionStore announcement and before queued
 // prompts can run. Changing projection init would also flip old chats.
 ctx.on('agent/created',async ({agent,source,signal})=>{
  if(source!=='startup'||signal?.aborted)return;
  const s=agent?.session,h=s?.header;
  if(!h||h.isSeeded!==false||s.firstLiveSeq!==0||s.inheritedEventCount!==0||
     h.parentSession!==undefined||h.origin!==undefined||(h.delegationDepth??0)!==0)return;
  if(s.ownEvents().some(event=>event.type===CLOUD_RECORD))return;
  try{
   appendPluginRecord(s,CLOUD_RECORD,cloudPolicy('cloud',null));
   await ctx.sessions.flush(s);
  }catch{
   // A default must not prevent opening a chat on storage failure.
   ctx.logger?.warn('Codex Native could not persist the initial Cloud policy.');
  }
 });
 const diagnostics=new WeakMap();
 ctx.on('session/event',(session,event)=>{
  if(event.type!=='assistant/message'||event.data?.interrupted)return;
  const source=event.data?.message?.source;
  if(source?.provider!=='openai-codex'||!source.replayState?.response?.state?.codexNativeCompactionV1)return;
  const status=diagnostics.get(session);
  if(status?.reason!=='attachedToFinish'||status.model!==source.model)return;
  void Promise.resolve(ctx.sessions.flush(session)).then(ok=>{
   if(ok===true&&status===diagnostics.get(session))diagnostics.set(session,{...status,reason:'saved',stats:{...status.stats,saved:(status.stats.saved??0)+1}});
  }).catch(()=>{});
 });
 return {ready,policy:async session=>stateOf(await ready,session),
  report(session,reason,threshold=null,model){const prior=diagnostics.get(session);const stats={...prior?.stats};if(['reused','received','attachedToFinish'].includes(reason))stats[reason]=(stats[reason]??0)+1;
   const preserved=prior?.reason==='reused'&&reason==='waiting'?'reused':reason;diagnostics.set(session,{reason:preserved,threshold,model,timestamp:Date.now(),stats});},
  async dispatch(action,payload,signal){
   const s=sessionFor(payload.sessionId),h=await ready;
   if(action==='setCloudCompaction'){
    const options=cloudPolicy(payload.mode,payload.thresholdTokens);
    signal?.throwIfAborted();appendPluginRecord(s,CLOUD_RECORD,options);
    if(!await ctx.sessions.flush(s))throw Object.assign(Error('Unable to flush session'),{code:'CLOUD_DURABILITY_UNAVAILABLE'});
   }
   const policy=stateOf(h,s);
   let budgetPreview=null;
   if(policy.mode==='cloud'&&typeof payload.model==='string'&&/^[a-zA-Z0-9_.-]{1,160}$/u.test(payload.model)&&describeModel){
    try{
     const model=await describeModel(payload.model,signal), call=s.requestHeader?.()?.config;
     budgetPreview=compactionThreshold(model?.context?.contextWindow,(call?.provider==='openai-codex'&&call.model===payload.model?call.maxTokens:undefined)??model?.defaultMaxTokens??0,policy.thresholdTokens);
    }catch{}
   }
   return {policy,budgetPreview,status:policy.mode==='off'?{reason:'off',threshold:null}:diagnostics.get(s)??{reason:'waiting',threshold:null}};
  }
 };
}
