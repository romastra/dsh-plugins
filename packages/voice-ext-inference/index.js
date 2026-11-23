/** Staged Rig adapter. No deployment or local-worker fallback side effects. */
import { assertSameOrigin, readBody, HttpError } from './local-legacy.js';
import { createRigTransport, RigError, MODEL, transcriptionMetadata } from './rig-transport.mjs';
import { createFlacEncoder } from './pcm-flac.mjs';
import { RIG_MAX_RECORDING_SECONDS, RIG_WINDOW_SECONDS } from './recording-limit.mjs';
import { resolveConfig } from './config.mjs';
export const inject=['webServer','connection'];
export const VERSION='1.2.8';
export { Config } from './config.mjs';
const ROUTE='/local-parakeet';
function json(res,status,payload){if(res.destroyed||res.writableEnded)return;const body=Buffer.from(JSON.stringify(payload));res.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':body.length,'cache-control':'no-store','x-content-type-options':'nosniff'});res.end(body)}
export function validatePool(raw){
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||!Object.keys(raw).length||Object.keys(raw).some(k=>!['bulk_workers','interactive_workers','bulk_gpu_ids','interactive_gpu_ids'].includes(k)))throw new RigError(400,'pool_invalid');
 const out={};for(const key of ['bulk_workers','interactive_workers'])if(raw[key]!==undefined){if(!Number.isInteger(raw[key])||raw[key]<0||raw[key]>13)throw new RigError(400,'pool_invalid');out[key]=raw[key]}
 let ids=[];for(const key of ['bulk_gpu_ids','interactive_gpu_ids'])if(raw[key]!==undefined){if(!Array.isArray(raw[key])||raw[key].some(n=>!Number.isInteger(n)||n<0||n>12))throw new RigError(400,'pool_invalid');ids.push(...raw[key]);out[key]=raw[key];const count=key==='bulk_gpu_ids'?'bulk_workers':'interactive_workers';if(out[count]!==undefined&&out[count]!==raw[key].length)throw new RigError(400,'pool_invalid')}
 if(new Set(ids).size!==ids.length||(raw.bulk_workers??raw.bulk_gpu_ids?.length??0)+(raw.interactive_workers??raw.interactive_gpu_ids?.length??0)>13)throw new RigError(400,'pool_invalid');return out;
}
export function safePool(raw={}){
 const config={};for(const k of ['bulk_workers','interactive_workers','bulk_gpu_ids','interactive_gpu_ids'])if(raw.config?.[k]!==undefined)config[k]=raw.config[k];
 return {config,workers:Array.isArray(raw.workers)?raw.workers.slice(0,13).map(w=>({worker_id:String(w.worker_id??'').slice(0,80),gpu:w.gpu,role:w.role==='interactive'?'interactive':'bulk',state:String(w.state??'unknown').replace(/[^a-z_-]/gi,'').slice(0,32),ready:w.ready===true,busy:w.busy===true,draining:w.draining===true,error:w.error?'worker_unavailable':''})):[],queue:{bulk:Number(raw.queue?.bulk)||0,interactive:Number(raw.queue?.interactive)||0}};
}
export function createController(config={},dependencies={}){
 const rig=dependencies.rig??createRigTransport(config.rig??{}),encode=dependencies.encode??createFlacEncoder(config.rig??{});
 let backend='rig',verified=false,disposed=false,legacy;
 const lifecycle=new AbortController();
 async function local(){if(config.enableLocalRollback!==true)throw new RigError(403,'local_disabled');if(!legacy){const m=await import('./local-legacy.js');legacy=m.createController(config.local??{},dependencies.localDependencies)}return legacy}
 function shape(info){if(info.model!==MODEL||info.device!=='rig'||info.engine!=='llama.cpp/Vulkan')throw new RigError(503,'gateway_identity_mismatch');verified=true;return {ready:info.ready===true,running:info.running===true,preparing:info.preparing===true,phase:info.phase==='ready'?'ready':info.preparing?'checking':'error',model:MODEL,engine:'llama.cpp/Vulkan',device:'rig',backend:'rig',language:'auto',maxRecordingSeconds:RIG_MAX_RECORDING_SECONDS,maxSegmentSeconds:RIG_WINDOW_SECONDS,estimatedModelMb:0,pool:safePool(info.pool),version:VERSION,message:info.ready?'Qwen ASR 1.7B · Rig GPU':'Rig interactive worker is not ready',error:''}}
 async function status(){if(backend==='local')return {...await(await local()).status(),backend:'local',version:VERSION};try{return shape(await rig.status())}catch{return {ready:false,preparing:false,phase:'error',model:MODEL,engine:'llama.cpp/Vulkan',device:'rig',backend:'rig',version:VERSION,maxRecordingSeconds:RIG_MAX_RECORDING_SECONDS,maxSegmentSeconds:RIG_WINDOW_SECONDS,error:'rig_unavailable',message:'Rig is unavailable or identity validation failed; local fallback is disabled.'}}}
 async function handle(req,res){
 try{
  // Raw webServer prefixes do NOT inherit frontend or /api authentication.
  // Canonical connection admission must run before routing, body reads or Rig work.
  if(typeof dependencies.requestRejection!=='function')throw new RigError(503,'authentication_unavailable');
  const rejection=await dependencies.requestRejection(req);
  if(rejection!==undefined){if(rejection===401||rejection===403)throw new RigError(rejection,rejection===401?'unauthorized':'forbidden');throw new RigError(503,'authentication_unavailable')}
  if(disposed)throw new RigError(503,'disposed');const path=new URL(req.url||'/', 'http://localhost').pathname;const route=path.slice(ROUTE.length);if(!path.startsWith(ROUTE+'/')){json(res,404,{code:'not_found'});return}assertSameOrigin(req);
  if(req.headers.origin&&new URL(req.headers.origin).protocol!==(req.socket?.encrypted?'https:':'http:'))throw new RigError(403,'origin');
  const methods={'/status':['GET'],'/prepare':['POST'],'/transcribe':['POST'],'/pool':['GET','PUT'],'/backend':['GET','PUT'],'/ack':['POST']};
  if(methods[route]&&!methods[route].includes(req.method)){res.setHeader?.('allow',methods[route].join(', '));json(res,405,{code:'method_not_allowed'});return}
  if(route==='/ack'&&req.method==='POST'){const body=JSON.parse((await readBody(req,1024)).toString('utf8'));if(req.aborted||typeof body?.id!=='string'||!/^[-A-Za-z0-9_]{1,80}$/.test(body.id)||Object.keys(body).some(k=>k!=='id'))throw new RigError(400,'ack_invalid');await rig.ack(body.id);json(res,200,{ok:true});return}
  if(route==='/backend'&&req.method==='GET'){json(res,200,{backend,rigVerified:verified,localEnabled:config.enableLocalRollback===true});return}
  if(route==='/backend'&&req.method==='PUT'){const body=JSON.parse((await readBody(req,1024)).toString('utf8'));if(body.backend==='local'){await local();backend='local'}else if(body.backend==='rig'){shape(await rig.status());backend='rig'}else throw new RigError(400,'backend_invalid');json(res,200,{backend,localEnabled:config.enableLocalRollback===true});return}
  if(route==='/pool'&&req.method==='GET'){json(res,200,safePool(await rig.pool()));return}
  if(route==='/pool'&&req.method==='PUT'){const body=JSON.parse((await readBody(req,4096)).toString('utf8'));json(res,202,safePool(await rig.configure(validatePool(body))));return}
  if(route==='/status'&&req.method==='GET'){json(res,200,await status());return}
  if(route==='/prepare'&&req.method==='POST'){json(res,200,backend==='rig'?shape(await rig.prepare()):await(await local()).prepare());return}
  if(route==='/transcribe'&&req.method==='POST'){
   if(backend==='local'){await(await local()).handle(req,res);return}
   if(!['audio/wav','application/octet-stream'].includes(String(req.headers['content-type']??'').split(';')[0]))throw new RigError(415,'audio_type');
   const metadata=transcriptionMetadata(req.headers);const controller=new AbortController();const signal=AbortSignal.any([controller.signal,lifecycle.signal]);
   const abandon=()=>{if(!res.writableEnded)controller.abort()};req.once('aborted',abandon);res.once('close',abandon);
   try{const wav=await readBody(req,20*1024*1024);const flac=await encode(wav,signal);const result=await rig.transcribe(flac,metadata,signal);
    if(result.model!==MODEL||typeof result.text!=='string'||Buffer.byteLength(result.text)>2*1024*1024)throw new RigError(502,'transcript_invalid');
    // Never ACK here: only the browser can confirm it parsed this delivery.
    const text=result.text.trim();
    const noSpeech=!text&&result.no_speech===true&&metadata['X-ASR-Phase']==='final';
    if(!text&&!noSpeech)throw new RigError(422,'empty');
    if(!signal.aborted)json(res,200,{...(typeof result.id==='string'&&/^[-A-Za-z0-9_]{1,80}$/.test(result.id)?{id:result.id}:{}),text,...(noSpeech?{noSpeech:true}:{}),language:['ru','en'].includes(result.language)?result.language:'auto',duration:Number(result.duration)||null,inferenceSeconds:Number(result.inferenceSeconds)||null,windows:Number(result.windows)||null,cacheHit:false,model:MODEL});
   }finally{req.removeListener('aborted',abandon);res.removeListener('close',abandon)}return;
  }
  json(res,404,{code:'not_found'});
 }catch(error){const safe=error instanceof RigError||error instanceof HttpError?error:new RigError(error instanceof SyntaxError?400:503,error instanceof SyntaxError?'invalid_json':'rig_unavailable');json(res,safe.status,{error:safe.message,code:safe.code})}
 }
 return {handle,status,dispose(){disposed=true;lifecycle.abort();legacy?.dispose()}};
}
export function apply(ctx,config){const controller=createController(resolveConfig(config),{logger:ctx.logger,requestRejection:req=>{if(typeof ctx.connection?.requestRejection!=='function')throw new RigError(503,'authentication_unavailable');return ctx.connection.requestRejection(req)}});ctx.effect(()=>ctx.webServer.register({kind:'prefix',path:ROUTE,handler:controller.handle}));ctx.effect(()=>()=>controller.dispose());ctx.logger.info('Rig Qwen ASR adapter; local backend disabled unless explicitly enabled for rollback.')}
