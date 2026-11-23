import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, appendFile } from 'node:fs/promises';
import { redactEvidence } from './src/evidence.js';
import { resolve, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hostModule, hostVersion } from './src/host.js';
import { acquireOwnerLock } from './src/lock.js';
import { bindReplayGeneration } from './src/replay-generation.js';
import { createCodexNativeProvider, CODEX_PAYLOAD_REVISION } from './src/provider.js?compat=ultrafast-5';
import { createCredentialBridge } from './src/credentials.js';
import { wrapReplayState, unwrapMessages } from './src/scope.js';
import { noteReportedTier, attachReportedTier } from './src/reported-tier.js';
import { createAuthBroker } from './src/auth.js';
import { createCapabilityCache } from './src/capability.js';
import { createCatalogProtocol } from './src/catalog-protocol.js';
import { createModelCatalog, startCatalogAutoRefresh, readMetadataBody } from './src/model-catalog.js';
import { createQuotaRuntime, QUOTA_ACTIONS } from './src/quota/runtime.js';
import { CLOUD_ACTIONS, installCloud } from './src/compaction/policy.js';
import { beginCloud } from './src/compaction/bridge.js';
import { createLastResponseProjection } from './src/last-response.js';
import { SPEED_TIERS, defaultPolicy, reducePolicy, policyForSession, speedForPolicy, assertSpeedSelection, encodePolicyRecord, requireSpeed, assertAdvertisedSpeed, ultrafastAvailability, POLICY_RECORD } from './src/policy.js';
import { nativeRetryPolicy, installRuntimeStatus } from './src/retry-policy.js';

export const name = 'codex-native';
export const inject = ['llm','credentials','authorization','connection','sessions','sessionProjections'];
const PROVIDER = 'openai-codex';
const API = 'openai-codex-responses';
const ENDPOINTS = ['status','speed','setSpeed','usage','authStart','authPoll','authAnswer','authCancel','capabilitiesRefresh','evidence',...CLOUD_ACTIONS,...QUOTA_ACTIONS];
const hash = value => createHash('sha256').update(value).digest('hex');
const safeCode = error => /^[A-Z][A-Z0-9_]{2,70}$/.test(error?.code ?? '') ? error.code : 'CODEX_NATIVE_FAILED';
const FAIL_MESSAGES={CODEX_HOST_VERSION_MISMATCH:'This Codex Native build supports DSH 0.2.2-rc.5 with pi-ai 1.3.0 only; the running Harness host differs. Install the matching Codex Native release or return the desktop to the supported version.',CODEX_FAST_UNSUPPORTED:'Fast is not available for this model on the connected account. Your choice was not changed.',CODEX_FAST_CHECK_UNAVAILABLE:'Fast availability could not be checked automatically. The connection will retry; your Speed choice was not changed.',CODEX_AUTH_REQUIRED:'Sign in to Codex OAuth to continue.',CODEX_ROUTE_NOT_READY:'The Codex connection is updating. Retry after the current sign-in operation finishes.'};
const fail = code => { const error = new Error(FAIL_MESSAGES[code]??code); error.code = code; throw error; };
function accountOf(grant) {
  try {
    const parsed = JSON.parse(Buffer.from(grant.access.split('.')[1], 'base64url').toString('utf8'));
    const id = parsed['https://api.openai.com/auth']?.chatgpt_account_id;
    if (typeof id !== 'string' || !id) fail('CODEX_ACCOUNT_UNAVAILABLE');
    return id;
  } catch { fail('CODEX_ACCOUNT_UNAVAILABLE'); }
}
async function loadGeneration(stateDirectory) {
  if(typeof stateDirectory!=='string'||!isAbsolute(stateDirectory))fail('CODEX_STATE_DIRECTORY_REQUIRED');
  const absolute=resolve(stateDirectory);
  const dir = pathToFileURL(absolute+'/');
  const path = new URL('grant-generation.json', dir);
  await mkdir(dir, { recursive: true });
  // A live owner keeps the exclusive lease. A crash leaves its PID behind;
  // acquireOwnerLock retains that file as evidence and reclaims only a verified
  // dead owner, so an abnormal exit cannot permanently disable the route.
  const lease=await acquireOwnerLock(absolute);
  const release=lease.release;
  try {
    try { const data = JSON.parse(await readFile(path, 'utf8')); if (typeof data.generation === 'string' && /^[0-9a-f-]{36}$/.test(data.generation)) return {generation:data.generation,path,release,staleLock:lease.staleLock}; } catch(error) { if (error.code !== 'ENOENT') throw new Error('CODEX_GENERATION_INVALID'); }
    const generation = randomUUID();
    await writeFile(path, JSON.stringify({version:1,generation})+'\n', {mode:0o600,flag:'wx'});
    return {generation,path,release,staleLock:lease.staleLock};
  } catch (error) { await release().catch(()=>{}); throw error; }
}
async function saveGeneration(state) {
  if (state.external) fail('CODEX_AUTH_MANAGED_BY_DESKTOP');
  const generation = randomUUID();
  const temporary = new URL('./grant-generation.'+randomUUID()+'.tmp', state.path);
  await writeFile(temporary, JSON.stringify({version:1,generation})+'\n', {mode:0o600});
  await rename(temporary,state.path);
  state.generation = generation;
}

export async function apply(ctx,config={}) {
  if (hostVersion('@deepseek-ai/dsh-llm-pi-ai') !== '0.2.2-rc.5' || hostVersion('@earendil-works/pi-ai') !== '1.3.0') fail('CODEX_HOST_VERSION_MISMATCH');
  const [{PiAiAdapter,recordKeyFor},{openaiCodexProvider},{LlmAdapter,LlmError,resolveRetryPolicy,resolveImageAttachmentAccess,assistantStreamFirstTokenTime,lastAssistantStreamChunk,BlockAssembler,isAgentLoopRequest},{appendPluginRecord},{z}] = await Promise.all([
    hostModule('@deepseek-ai/dsh-llm-pi-ai'),hostModule('@earendil-works/pi-ai/providers/openai-codex'),hostModule('@deepseek-ai/dsh-llm'),hostModule('@deepseek-ai/dsh-session'),hostModule('zod')
  ]);
  const retryPolicy = nativeRetryPolicy(config, resolveRetryPolicy);
  const runtimeGeneration = await loadGeneration(config.stateDirectory);
  ctx.effect(()=>()=>runtimeGeneration.release());
  let generation;
  try { generation = await bindReplayGeneration(runtimeGeneration,config.replayGenerationDirectory); }
  catch (error) { await runtimeGeneration.release(); throw error; }
  const requestContext = new AsyncLocalStorage(), loopContext = new AsyncLocalStorage();
  const retryVeto = new WeakSet();
  ctx.on('llm/stream',(options,next)=>{
    if(options.provider!==PROVIDER)return next();
    const stamp=isAgentLoopRequest(options)&&options.purpose===undefined?{sessionId:options.sessionId,model:options.model,signal:options.signal}:null;
    return (async function*(){
      const iterator=loopContext.run(stamp,()=>next()[Symbol.asyncIterator]());
      try{while(true){const item=await loopContext.run(stamp,()=>iterator.next());if(item.done)return;yield item.value;}}
      finally{await loopContext.run(stamp,()=>iterator.return?.());}
    })();
  });
  let active = 0, metadataActive = 0, disposed = false, authChanging = false, authCatalogTimer;
  const catalogProtocol=createCatalogProtocol();
  const capabilities=createCapabilityCache({load:(scope,options)=>loadMetadata(scope,'catalog',options)});
  let quota;
  const invalidateMetadata=()=>{capabilities.invalidate();quota?.rotate();catalog.reset();};
  const nonce = randomBytes(32).toString('base64url');
  const evidence = [];
  const requestControllers = new Set();
  let externalAuthFence = Promise.resolve(), externalAuthPending=0;
  ctx.on('authorization/settled',(key,status)=>{
    if(key!==recordKeyFor(PROVIDER)||status!=='authorized'||broker.isRunning())return;
    authChanging=true;externalAuthPending++;invalidateMetadata();
    for(const controller of requestControllers)controller.abort(new Error('CODEX_AUTH_CHANGED'));
    externalAuthFence=externalAuthFence.then(()=>generation.external?generation.refresh():saveGeneration(generation)).then(()=>{externalAuthPending--;if(!disposed&&externalAuthPending===0)authChanging=false;}).catch(()=>{authChanging=true;});
    return externalAuthFence;
  });
  const projection = await ctx.sessionProjections.register({
    key:'codex-native/policy',stateVersion:2,
    stateSchema:z.object({version:z.literal(1),tier:z.enum(SPEED_TIERS),model:z.string().nullable()}),
    init:defaultPolicy,apply:reducePolicy
  });
  const sessionFor = id => { if (typeof id !== 'string' || id.length>160) fail('INVALID_SESSION'); const session=ctx.sessions.get(id); if(!session)fail('SESSION_UNAVAILABLE');return session; };
  const policyFor = session => policyForSession(projection,session);
  const cloud=installCloud({ctx,z,appendPluginRecord,sessionFor,describeModel:(model,signal)=>delegate.resolveModel(PROVIDER,model,signal)});
  await cloud.ready;
  const observeGrant = async grant => {
    const current=requestContext.getStore();
    if(!current || !grant)return;
    if(authChanging||ctx.authorization.describe(recordKeyFor(PROVIDER))?.inFlight)fail('CODEX_ROUTE_NOT_READY');
    await generation.refresh();
    const scope=hash(generation.generation+'\0'+accountOf(grant));
    if(current.scope!==scope)fail('CODEX_ACCOUNT_CHANGED_START_NEW_SESSION');
  };
  const credentials=createCredentialBridge({credentials:ctx.credentials,recordKeyFor,onCredential:observeGrant});
  async function assertRequestScope(current) {
    const epoch=await generation.refresh();
    const grant=await credentials.read(PROVIDER);
    if(epoch!==current.generation||!grant||hash(epoch+'\0'+accountOf(grant))!==current.scope)fail('CODEX_ACCOUNT_CHANGED_START_NEW_SESSION');
  }
  const auth={credentials,authContext:{env:async()=>undefined,fileExists:async()=>false}};
  const native=openaiCodexProvider();
  const provider=createCodexNativeProvider({nativeProvider:native,
    snapshotSpeed:({sessionId,model})=>{const current=requestContext.getStore();if(!current || current.sessionId!==sessionId || current.model!==model.id)fail('CODEX_REQUEST_CONTEXT_MISSING');return {tier:current.tier,scope:'session'};},
    snapshotCloud:()=>requestContext.getStore()?.cloud,
    observeHttpStatus:status=>{const current=requestContext.getStore();if(current)current.httpStatus=status;},
    recordEvidence:async row=>{
      const current=requestContext.getStore();
      if(row.phase==='request-policy'&&(!current||authChanging||ctx.authorization.describe(recordKeyFor(PROVIDER))?.inFlight))fail('CODEX_ROUTE_NOT_READY');
      if(row.phase==='request-policy'&&current)await assertRequestScope(current);
      if(row.phase==='request-policy'&&current?.tier==='ultrafast')assertAdvertisedSpeed(capabilities,current.scope,current.model,current.tier);
      noteReportedTier(current,row);
      const redacted=redactEvidence(row,{purpose:current?.purpose});
      evidence.push(redacted);if(evidence.length>200)evidence.shift();
      if(current&&config.pilotSessionId===current.sessionId)await appendFile(new URL('pilot-evidence.jsonl',generation.path),JSON.stringify(redacted)+'\n',{mode:0o600});
    }
  });
  const profile={provider:PROVIDER,displayName:'OpenAI Codex · Native replay',piProvider:provider,retryPolicy,
    configuredMaxTokens:new Map(),modelErrors:new Map(),transport:'sse',streamIdleTimeoutMs:300000,
    maxRequestImageBytes:20971520,maxRequestImages:50,imageOffloadCountQuantum:10,requestImagePixelBudget:4194304,requestImageMaxBytes:1048576};
  let profiles=new Map([[PROVIDER,profile]]);
  const catalog=createModelCatalog({baseline:native.getModels(),publish:models=>{
    // Replace the entire native snapshot, never mutate a prepared call's provider.
    const snapshot=Object.freeze([...models]);
    const piProvider={...provider,getModels:()=>snapshot,getAllModels:()=>snapshot};
    profiles=new Map([[PROVIDER,{...profile,piProvider}]]);
    ctx.emit('llm/models-updated',PROVIDER);
  }});
  async function ensureCatalog() {
    if(!await authenticated()) { if(catalog.scope())invalidateMetadata(); return; }
    const scope=await metadataScope();await capabilities.ensure(scope);
  }
  const delegate=new PiAiAdapter({profiles:()=>profiles,resolveApiKey:async()=>undefined,auth,
    resolveAttachments:()=>ctx.get('attachments'),
    resolveImageAccess:(attachments,ref)=>resolveImageAttachmentAccess(attachments,path=>ctx.get('fs')?.processPathFromHostPath(path),ref),
    prepareHeaders:(request,headers)=>ctx.waterfall('llm-pi-ai/request-headers',request,headers,()=>headers),
    onReplayDegrade:()=>fail('CODEX_REPLAY_DEGRADED_START_NEW_SESSION')});
  async function scopedStream(options, descriptor, cloudPolicy, retrySignal) {
    if(disposed || authChanging)fail('CODEX_ROUTE_NOT_READY');
    const session=sessionFor(options.sessionId);
    const grant=await credentials.read(PROVIDER);
    if(!grant)fail('CODEX_AUTH_REQUIRED');
    const requestGeneration=await generation.refresh();
    const scope=hash(requestGeneration+'\0'+accountOf(grant));
    const veto=retrySignal&&quota.admitRetry(retrySignal,scope);
    if(veto)throw LlmError.fromFailure(veto);
    const messages=unwrapMessages(options.messages,scope,{provider:options.provider,model:options.model,api:API,allowPortablePiAiHistory:config.allowPortablePiAiHistory!==false});
    const selected=policyFor(session);
    const tier=selected.model===options.model?selected.tier:'standard';
    const available=await requireSpeed(capabilities,scope,options.model,tier,options.signal);
    const speed=speedForPolicy(selected,options.model,available);
    const cloudAttempt=cloudPolicy ? beginCloud({options,messages,scope,descriptor,policy:cloudPolicy,diagnostic:(reason,t)=>cloud.report(session,reason,t,options.model)}) : {messages};
    return {context:{sessionId:options.sessionId,model:options.model,scope,tier:speed.tier,purpose:options.purpose,generation:requestGeneration,reportedTier:null,cloud:cloudAttempt.state},options:{...options,messages:cloudAttempt.messages}};
  }
  class ScopedAdapter extends LlmAdapter {
    providerInfo(id){return delegate.providerInfo(id);}
    providerRetryPolicy(id){return delegate.providerRetryPolicy(id);}
    async listModels(id){try{await ensureCatalog();}catch{}return delegate.listModels(id);}
    resolveModel(...args){return delegate.resolveModel(...args);}
    imageRequestTarget(...args){return delegate.imageRequestTarget(...args);}
    async prepareCall(...args){const call=await delegate.prepareCall(...args);return {...call,stream:options=>this.run(options,call)};}
    stream(options){return this.run(options);}
    async *run(options,prepared){
      if(disposed || authChanging || broker.isRunning() || ctx.authorization.describe(recordKeyFor(PROVIDER))?.inFlight)fail('CODEX_ROUTE_NOT_READY');
      active++; // Reserve before the first await: login cannot race scope resolution.
      let request,iterator;
      const loop=loopContext.getStore();
      const main=options.purpose===undefined&&(isAgentLoopRequest(options)||(loop!=null&&loop.sessionId===options.sessionId&&loop.model===options.model&&loop.signal===options.signal));
      let emitted=false, completed=false;
      const controller=new AbortController();requestControllers.add(controller);
      const signal=options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal;
      try{
        const policy=main?await cloud.policy(sessionFor(options.sessionId)):null;
        const call=prepared??(policy?.mode==='cloud'?await delegate.prepareCall(options.provider,options.model,signal):null);
        const invoke=call?.stream??(value=>delegate.stream(value));
        request=await scopedStream({...options,signal},call?.model,policy,main?options.signal:undefined);
        const state=request.context, assembly=state.cloud?new BlockAssembler():null;
        iterator=requestContext.run(state,()=>invoke(request.options)[Symbol.asyncIterator]());
        while(true){
          const next=await requestContext.run(state,()=>iterator.next());if(next.done)return;
          let chunk=next.value;
          if(chunk.type==='text-delta'||chunk.type==='reasoning-delta'||chunk.type==='tool-call-delta'||chunk.type==='block-end')emitted=true;
          if(chunk.type==='finish'&&state.cloud?.lateFailure){chunk={type:'finish',reason:{kind:'error',failure:state.cloud.lateFailure}};}
          if(chunk.type==='finish'&&main){
            if(chunk.reason.kind==='error') {
              if(options.signal&&state.cloud&&(emitted||state.cloud.lateFailure))retryVeto.add(options.signal);
              else if(!emitted)quota.rememberFailure(options.signal,state.scope,chunk.reason.failure,state.httpStatus);
            }
            completed=['stop','tool-calls'].includes(chunk.reason.kind);
          }
          assembly?.push(chunk);
          if(chunk.type==='finish'&&chunk.replayState){
            await assertRequestScope(state);
            let replay=chunk.replayState;
            if(assembly&&['stop','tool-calls'].includes(chunk.reason.kind)&&!signal.aborted&&assembly.replayState){
              
              if(!signal.aborted)replay=state.cloud.attach(replay,assembly.blocks());
            }
            chunk={...chunk,replayState:attachReportedTier(wrapReplayState(replay,state.scope),state)};
          }
          yield chunk;
        }
      }catch(error){
        if(options.signal&&request?.context.cloud&&emitted)retryVeto.add(options.signal);
        throw error;
      }finally{try{if(iterator)await requestContext.run(request.context,()=>iterator.return?.());}finally{
        requestControllers.delete(controller);active--;
        if(completed&&!signal.aborted)setImmediate(()=>quota.background(request.context.scope,options.signal));
      }}
    }
  }
  ctx.effect(()=>ctx.llm.registerAdapter([PROVIDER],new ScopedAdapter()));
  const authenticated=async()=> (await ctx.credentials.describeRecord(recordKeyFor(PROVIDER))).configured===true;
  async function quotaIdentity(){
    if(disposed||authChanging||broker.isRunning()||ctx.authorization.describe(recordKeyFor(PROVIDER))?.inFlight)return null;
    if(!await authenticated())return null;
    const epoch=await generation.refresh();
    const grant=await credentials.read(PROVIDER);
    if(!grant||disposed||authChanging||ctx.authorization.describe(recordKeyFor(PROVIDER))?.inFlight||epoch!==await generation.refresh())return null;
    const account=accountOf(grant);return {account,scope:hash(epoch+'\0'+account)};
  }
  quota=createQuotaRuntime({directory:generation.path,ownerManaged:generation.external,getIdentity:quotaIdentity,
    onActive:count=>{metadataActive+=count;},acquireAuth:async who=>{
      const models=delegate.current().models,model=models.getModel(PROVIDER,'gpt-6.1-sol')??models.getModels(PROVIDER)[0];
      const resolved=await models.getAuth(model);const access=resolved?.auth?.apiKey;
      if(!access)fail('QUOTA_AUTH_REQUIRED');
      const current=await quotaIdentity();if(!current||current.scope!==who.scope||accountOf({access})!==who.account)fail('QUOTA_ACCOUNT_CHANGED');
      return {...current,access};
    }});
  await quota.ready;
  const quotaListener=ctx.on('agent/request-error',(payload,next)=>{
    if(retryVeto.delete(payload.signal))return Promise.resolve(undefined);
    return quota.handleError(payload,next);
  },true);
  ctx.effect(()=>()=>{if(typeof quotaListener==='function')quotaListener();quota.dispose();});
  async function metadataScope(){
    if(disposed||authChanging||broker.isRunning()||ctx.authorization.describe(recordKeyFor(PROVIDER))?.inFlight)fail('CODEX_ROUTE_NOT_READY');
    const startedGeneration=await generation.refresh();
    const grant=await credentials.read(PROVIDER);if(!grant)fail('CODEX_AUTH_REQUIRED');
    await generation.refresh();
    if(disposed||authChanging||startedGeneration!==generation.generation||broker.isRunning()||ctx.authorization.describe(recordKeyFor(PROVIDER))?.inFlight)fail('CODEX_ROUTE_NOT_READY');
    const scope=hash(startedGeneration+'\0'+accountOf(grant));
    if(catalog.scope()&&catalog.scope()!==scope)invalidateMetadata();
    return scope;
  }
  async function loadMetadata(scope,kind,{signal}={}) {
    if(disposed||authChanging||ctx.authorization.describe(recordKeyFor(PROVIDER))?.inFlight)fail('CODEX_ROUTE_NOT_READY');
    metadataActive++;
    try {
      const startedGeneration=await generation.refresh();
      const models=delegate.current().models;const model=models.getModel(PROVIDER,'gpt-6.1-sol')??models.getModels(PROVIDER)[0];
      const resolved=await models.getAuth(model);if(!resolved?.auth?.apiKey)fail('CODEX_AUTH_REQUIRED');
      const account=accountOf({access:resolved.auth.apiKey});
      const check=()=>{if(disposed||authChanging||signal?.aborted||startedGeneration!==generation.generation||ctx.authorization.describe(recordKeyFor(PROVIDER))?.inFlight)fail('CODEX_CAPABILITY_SCOPE_CHANGED');};
      const valid=async()=>{
        await generation.refresh();check();const grant=await credentials.read(PROVIDER);
        await generation.refresh();check();
        if(!grant||hash(startedGeneration+'\0'+accountOf(grant))!==scope||hash(startedGeneration+'\0'+account)!==scope)fail('CODEX_CAPABILITY_SCOPE_CHANGED');
      };
      await valid();
      const timeout=AbortSignal.timeout(15000);const bounded=signal?AbortSignal.any([signal,timeout]):timeout;
      const clientVersion=await catalogProtocol.ensure({signal:bounded});
      await valid();bounded.throwIfAborted();check();
      const url='https://chatgpt.com/backend-api/codex/models?client_version='+clientVersion;
      const response=await fetch(url,{headers:{authorization:'Bearer '+resolved.auth.apiKey,'chatgpt-account-id':account,originator:kind==='catalog'?'pi':'codex_cli_rs',accept:'application/json'},signal:bounded,redirect:'error'});
      if(!response.ok){const error=new Error(kind==='catalog'?'CODEX_CATALOG_UNAVAILABLE':'CODEX_USAGE_UNAVAILABLE');error.code=error.message;const value=response.headers.get('retry-after');const seconds=value!==null&&/^\d+(?:\.\d+)?$/.test(value)?Number(value)*1000:Date.parse(value??'')-Date.now();error.retryAfterMs=Number.isFinite(seconds)&&seconds>0?Math.min(seconds,86400000):300000;throw error;}
      const body=await readMetadataBody(response,{signal:bounded});
      await valid();bounded.throwIfAborted();check();
      return catalog.accept(scope,body);
    } finally {metadataActive--;}
  }
  async function refreshCapabilities(){const scope=await metadataScope();await capabilities.ensure(scope,{force:true});return {checked:true,models:catalog.getModels().filter(m=>capabilities.get(scope,m.id).available!==null).length};}
  const broker=createAuthBroker({authorization:ctx.authorization,key:recordKeyFor(PROVIDER),
    onStarting:async()=>{if(generation.external)fail('CODEX_AUTH_MANAGED_BY_DESKTOP');if(active||metadataActive)fail('CODEX_REQUEST_ACTIVE');authChanging=true;invalidateMetadata();await saveGeneration(generation);},
    onAuthorized:async()=>{
      authChanging=false;clearTimeout(authCatalogTimer);
      // Run after the broker releases isRunning(), not inside its completion hook.
      authCatalogTimer=setTimeout(()=>{authCatalogTimer=undefined;void autoCatalog.tick();},0);authCatalogTimer.unref?.();
    }});
  // Wire only scalar per-response readings; no extra OpenAI requests or replay mutation.
  await ctx.sessionProjections.register(createLastResponseProjection({z,assistantStreamFirstTokenTime,lastAssistantStreamChunk}));
  const requireNonce=payload=>{if(typeof payload.nonce!=='string')fail('NONCE_REQUIRED');const a=Buffer.from(payload.nonce),b=Buffer.from(nonce);if(a.length!==b.length||!timingSafeEqual(a,b))fail('NONCE_REQUIRED');};
  async function dispatch(action,payload,signal) {
    if(action==='status'){const state=broker.status();if(state.state!=='pending'&&externalAuthPending===0&&!broker.isRunning()&&!ctx.authorization.describe(recordKeyFor(PROVIDER))?.inFlight)authChanging=false;return {nonce,authenticated:await authenticated(),auth:state,viewRevision:await quota.status(),route:{provider:PROVIDER,registered:true}};}
    if(action!=='speed')requireNonce(payload);
    if(action==='authStart')return broker.start();
    if(action==='authPoll'){const result=broker.poll(payload.id);if(result.state!=='pending'&&externalAuthPending===0&&!broker.isRunning()&&!ctx.authorization.describe(recordKeyFor(PROVIDER))?.inFlight)authChanging=false;return result;}
    if(action==='authAnswer')return broker.answer(payload.id,payload.promptId,payload.answer);
    if(action==='authCancel'){const result=broker.cancel(payload.id);if(externalAuthPending===0&&!broker.isRunning()&&!ctx.authorization.describe(recordKeyFor(PROVIDER))?.inFlight)authChanging=false;return result;}
    if(action==='capabilitiesRefresh')return refreshCapabilities();
    if(action==='evidence')return {rows:evidence.slice()};
    if(CLOUD_ACTIONS.includes(action))return {...await cloud.dispatch(action,payload,signal),viewRevision:quota.revision};
    if(QUOTA_ACTIONS.includes(action))return quota.dispatch(action,payload,signal);
    if(action==='usage'){
      sessionFor(payload.sessionId);if(typeof payload.model!=='string'||!catalog.getModels().some(m=>m.id===payload.model))fail('UNKNOWN_MODEL');
      return quota.legacy({signal});
    }
    if(action==='speed'||action==='setSpeed'){
      const session=sessionFor(payload.sessionId), model=payload.model;
      if(typeof model!=='string'||!catalog.getModels().some(m=>m.id===model))fail('UNKNOWN_MODEL');
      const changing=action==='setSpeed';
      if(changing&&!SPEED_TIERS.includes(payload.tier))fail('INVALID_SPEED_SELECTION');
      const needsCheck=!changing||payload.tier!=='standard';
      const scope=needsCheck&&await authenticated()?await metadataScope():null;
      if(changing){
        const available=await requireSpeed(capabilities,scope,model,payload.tier,signal);
        if(payload.tier==='ultrafast'){
          if(await metadataScope()!==scope)fail('CODEX_ROUTE_NOT_READY');
          assertAdvertisedSpeed(capabilities,scope,model,payload.tier);
        }
        signal?.throwIfAborted();
        if(sessionFor(payload.sessionId)!==session)fail('SESSION_UNAVAILABLE');
        const policy=assertSpeedSelection(payload.tier,model,available);
        appendPluginRecord(session,POLICY_RECORD,encodePolicyRecord(policy));
        if(!await ctx.sessions.flush(session))fail('CODEX_DURABILITY_UNAVAILABLE');
      } else if(scope){
        try{await capabilities.ensure(scope,{model,signal});}catch{}
        signal?.throwIfAborted();
        if(await metadataScope()!==scope)fail('CODEX_ROUTE_NOT_READY');
      }
      const fast=scope?capabilities.get(scope,model):null;
      const ultra=scope?capabilities.get(scope,model,'ultrafast'):null;
      const capabilityState=fast?(fast.stale?'stale':fast.available===true?'supported':fast.available===false?'unsupported':'unknown'):'unknown';
      const selected=policyFor(session);
      return {tier:selected.model===model?selected.tier:'standard',fastAvailable:fast?.available??null,ultrafastAvailable:ultrafastAvailability(ultra),capabilityState,source:selected.model===model?'session':'standard-default'};
    }
    fail('UNKNOWN_ACTION');
  }
  for(const action of ENDPOINTS)ctx.effect(()=>ctx.connection.fetch.register({
    path:'/api/codex-native.'+action,methods:['POST'],requestBody:'buffered',
    async fetch(request){
      if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')return new Response('JSON required',{status:415});
      // Connection admits the authenticated owner and validates Host/Origin before
      // dispatching this exact route. Its HTTP bridge deliberately uses the URL
      // http://dsh.internal; comparing browser Origin to request.url rejects LAN
      // and loopback browser POSTs alike. Do not duplicate that carrier fence.
      let msg;try{const body=await request.text();if(body.length>24576)return new Response('Too large',{status:413});msg=JSON.parse(body);}catch{return new Response('Invalid JSON',{status:400});}
      if(msg?.type!=='client-request'||typeof msg.rpcId!=='string'||msg.method!=='codex-native.'+action||!msg.payload||typeof msg.payload!=='object')return new Response('Invalid request',{status:400});
      const revised=CLOUD_ACTIONS.includes(action)||QUOTA_ACTIONS.includes(action)||action==='status';
      let result;
      try{const value=await dispatch(action,msg.payload,request.signal);result={ok:true,value:revised?{...value,requestId:msg.rpcId}:value};}
      catch(error){const code=safeCode(error), d=error?.details;
        const details=revised?{messageKey:code,retryable:['QUOTA_THROTTLED','QUOTA_UNAVAILABLE','RESET_NOT_READY','RESET_INVENTORY_UNAVAILABLE'].includes(code),viewRevision:typeof d?.viewRevision==='string'?d.viewRevision:quota.revision,requestId:msg.rpcId,
          ...(['not-dispatched','uncertain','known'].includes(d?.outcome)?{outcome:d.outcome}:{}),...(typeof d?.operationId==='string'&&/^[a-f0-9-]{36}$/u.test(d.operationId)?{operationId:d.operationId}:{}),...(Number.isFinite(d?.retryAt)?{retryAt:d.retryAt}:{})}:{};
        result={ok:false,error:{code,message:code,details}};
      }
      return Response.json({type:'server-response',rpcId:msg.rpcId,result},{headers:{'cache-control':'no-store'}});
    }}));
  installRuntimeStatus(ctx,{catalog,capabilities,retryPolicy,config,activeRequests:()=>active});
  const autoCatalog=startCatalogAutoRefresh({refresh:ensureCatalog});
  ctx.effect(()=>()=>{disposed=true;clearTimeout(authCatalogTimer);autoCatalog.dispose();catalogProtocol.dispose();broker.dispose();capabilities.dispose();evidence.length=0;});
  await writeFile(new URL('pilot-runtime.json',generation.path),JSON.stringify({codeRevision:20,version:"0.2.2-rc.5-catalog.1.replay.1.retry.1.ultrafast.1.compaction.1.recovery.1.cloud-default.1",cloudPolicyRevision:2,quotaRecoveryRevision:2,modelCatalogRevision:3,catalogProtocolRevision:1,externalReplayOwner:generation.external,browserTransportRevision:1,staleLockRecovered:Boolean(generation.staleLock),staleLockEvidence:generation.staleLock?generation.staleLock.split(/[\\/]/).at(-1):null,payloadRevision:CODEX_PAYLOAD_REVISION,omitsUnsupportedTemperature:CODEX_PAYLOAD_REVISION>=4,automaticMetadata:true,serverTierRailMetadata:false,reportedServiceTierMetadata:true,lastResponseMetrics:true,quotaUiRevision:2,cloudCompactionRevision:1,speedUiRevision:4,ultrafast:true,pilotRevision:config.pilotRevision??null,pilotConfigured:typeof config.pilotSessionId==='string',readyAt:Date.now(),sseOnly:true})+'\n',{mode:0o600});
}
