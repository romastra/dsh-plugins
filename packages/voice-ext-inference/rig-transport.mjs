import http from 'node:http';
import { isIPv4 } from 'node:net';
import { lstat, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { win32 } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
const verifiedTools=new Map();
export async function verifyTailscale(path,sha256){
 localPath(path);if(typeof sha256!=='string'||!/^[a-f0-9]{64}$/.test(sha256))throw new RigError(503,'tailscale_hash_required');
 const st=await lstat(path);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>512*1024*1024)throw new RigError(503,'tailscale_binary_invalid');
 const key=path+'|'+sha256,stamp=[st.dev,st.ino,st.size,st.mtimeMs,st.ctimeMs].join(':');
 const prior=verifiedTools.get(key);if(prior?.stamp===stamp)return prior.promise;
 const promise=(async()=>{const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);if(hash.digest('hex')!==sha256)throw new RigError(503,'tailscale_hash_mismatch')})();
 verifiedTools.set(key,{stamp,promise});try{await promise}catch(error){verifiedTools.delete(key);throw error}
}

const DEFAULT_RIG_PORT = 8081;
export function pinnedPeer(pin) {
 const ip = pin?.ip;
 const id = pin?.peer_id ?? pin?.id;
 const publicKey = pin?.public_key ?? pin?.publicKey;
 const port = pin?.port === undefined ? DEFAULT_RIG_PORT : pin.port;
 if (typeof ip !== 'string' || !isIPv4(ip) || !ip.startsWith('100.') || +ip.split('.')[1] < 64 || +ip.split('.')[1] > 127 ||
     typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id) ||
     typeof publicKey !== 'string' || !/^nodekey:[a-f0-9]{64}$/.test(publicKey)) throw new RigError(503, 'peer_pin_required');
 if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RigError(503, 'peer_port_invalid');
 if (pin.origin !== undefined && pin.origin !== `http://${ip}:${port}`) throw new RigError(503, 'peer_origin_mismatch');
 return { ip, port, id, publicKey };
}
export const MODEL = 'qwen3-asr-1.7b';
export class RigError extends Error {
 constructor(status, code) { super(`Rig ASR: ${code}`); this.status=status; this.code=code; }
}
// The Browser may receive these stable public codes, never the remote message
// or an arbitrary string copied from an upstream response.
const upstreamCodes = new Set([
 'unauthorized', 'upload_busy', 'upload_timeout', 'queue_full', 'work_full', 'delivery_full',
 'draining', 'resource_wait', 'worker_unavailable', 'interrupted', 'cancelled',
 'idempotency_conflict', 'result_erased', 'native_empty', 'native_http', 'native_incomplete',
 'native_protocol', 'native_transport', 'processing_failed', 'invalid_media', 'duration_limit', 'file_too_large',
]);

function upstreamError(status, body) {
 try {
  const error = JSON.parse(body)?.error;
  if(error?.type === 'asr_error' && upstreamCodes.has(error.code)) return new RigError(status, error.code);
 } catch { /* Invalid/foreign/gateway error bodies stay opaque. */ }
 return new RigError(status, 'gateway_refused');
}

export function localPath(path) {
 if(typeof path!=='string'||!win32.isAbsolute(path)||path.startsWith('\\')||path.includes('\0')||!/^([a-z]:)[/\\]/i.test(path))throw new RigError(503,'local_path_required');
 return path;
}
export function parseSecret(text,format='raw') {
 if(!['raw','polaris-env'].includes(format)||typeof text!=='string'||Buffer.byteLength(text)>65536)throw new RigError(503,'secret_file_invalid');
 const grammar=format==='polaris-env'?/^POLARIS_API_KEY=([A-Za-z0-9_.~+/=-]{16,4096})(?:\r\n|\n)?$/:/^([A-Za-z0-9_.~+/=-]{16,4096})(?:\r\n|\n)?$/;
 const match=text.match(grammar);if(!match||match[0]!==text)throw new RigError(503,'secret_file_invalid');return match[1];
}
function sameSecretIdentity(a,b){return ['dev','ino','size','mtimeMs','ctimeMs'].every(k=>a[k]===b[k])}
export async function readSecret(path,format='raw',dependencies={}) {
 localPath(path);if(!['raw','polaris-env'].includes(format))throw new RigError(503,'secret_file_invalid');
 const fs=dependencies.fs??{lstat,open};let handle;
 const valid=st=>st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&st.size>=16&&st.size<=(format==='raw'?4098:65536);
 try{
  const before=await fs.lstat(path);if(!valid(before))throw Error();
  handle=await fs.open(path,'r');const opened=await handle.stat();if(!valid(opened)||!sameSecretIdentity(before,opened))throw Error();
  const data=Buffer.alloc(65537);let bytes=0;
  while(bytes<data.length){const result=await handle.read(data,bytes,data.length-bytes,bytes);if(!result.bytesRead)break;bytes+=result.bytesRead}
  if(bytes>65536||bytes!==opened.size)throw Error();
  const after=await handle.stat(),named=await fs.lstat(path);
  if(!valid(after)||!valid(named)||!sameSecretIdentity(opened,after)||!sameSecretIdentity(after,named))throw Error();
  return parseSecret(data.subarray(0,bytes).toString('utf8'),format);
 }catch{throw new RigError(503,'secret_file_invalid')}finally{if(handle)try{await handle.close()}catch{}}
}
export function verifyPeerMap(map,pin) {
 pin = pinnedPeer(pin);
 const matches=Object.values(map?.Peer??{}).filter(p=>p?.ID===pin.id&&p.PublicKey===pin.publicKey&&p.TailscaleIPs?.includes(pin.ip));
 if(matches.length!==1||matches[0].Online!==true||map.BackendState!=='Running')throw new RigError(503,'peer_identity_mismatch');
 return true;
}
export function readPeerMap(path,spawnChild=spawn) {
 localPath(path);
 return new Promise((resolve,reject)=>{
  let child,bytes=0,chunks=[],done=false;
  const finish=(err,value)=>{if(done)return;done=true;clearTimeout(timer);err?reject(err):resolve(value)};
  const timer=setTimeout(()=>{finish(new RigError(503,'peer_proof_timeout'));try{child?.kill()}catch{}},10000);
  try{child=spawnChild(path,['status','--json'],{windowsHide:true,shell:false,env:{SystemRoot:process.env.SystemRoot},stdio:['ignore','pipe','pipe']})}catch{finish(new RigError(503,'peer_proof_failed'));return}
  child.stdout.on('data',c=>{bytes+=c.length;if(bytes>2*1024*1024){finish(new RigError(503,'peer_proof_limit'));child.kill();return}chunks.push(c)});
  child.stderr.on('data',()=>{}); child.on('error',()=>finish(new RigError(503,'peer_proof_failed')));
  child.on('close',code=>{if(done)return;try{if(code!==0)throw Error();finish(null,JSON.parse(Buffer.concat(chunks).toString('utf8')))}catch{finish(new RigError(503,'peer_proof_failed'))}});
 });
}
export function transcriptionMetadata(headers) {
 const phase=headers['x-asr-phase'],id=headers['x-asr-utterance-id'],generation=headers['x-asr-generation'];
 if(!['preview','final'].includes(phase)||typeof id!=='string'||!/^[-A-Za-z0-9_.:]{1,120}$/.test(id)||typeof generation!=='string'||!/^\d{1,15}$/.test(generation))throw new RigError(400,'capture_metadata_required');
 const key=headers['idempotency-key'];
 if(typeof key!=='string'||!/^[-A-Za-z0-9_.:]{1,160}$/.test(key))throw new RigError(400,'idempotency_required');
 return {'X-ASR-Class':'interactive','X-ASR-Phase':phase,'X-ASR-Utterance-ID':id,'X-ASR-Generation':generation,'Idempotency-Key':key};
}
export function multipart(file,metadata={}) {
 if(!Buffer.isBuffer(file)||file.length<4||file.subarray(0,4).toString()!=='fLaC')throw new RigError(400,'compressed_flac_required');
 const boundary='dsh-asr-'+randomBytes(18).toString('hex');
 const body=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${MODEL}\r\n--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nauto\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="dictation.flac"\r\nContent-Type: audio/flac\r\n\r\n`),file,Buffer.from(`\r\n--${boundary}--\r\n`)]);
 return {body,headers:{...metadata,'Content-Type':`multipart/form-data; boundary=${boundary}`}};
}
export function createRigTransport(config,dependencies={}) {
 const request=dependencies.request??http.request;
 const proof=dependencies.peerMap??(async()=>{await verifyTailscale(config.tailscalePath,config.tailscaleSha256);return readPeerMap(config.tailscalePath)});
 const secret=dependencies.secret??(()=>readSecret(config.secretFile,config.secretFormat));
 async function json(method,path,body,headers={},signal) {
  if(!['/asr/status','/asr/prepare','/asr/pool','/v1/audio/transcriptions'].includes(path)&&!/^\/asr\/jobs\/[-A-Za-z0-9_]{1,80}\/ack$/.test(path))throw new RigError(400,'route_not_allowed');
  const peer = pinnedPeer(config.peer);
   if (signal?.aborted) throw new RigError(499, 'cancelled');
   verifyPeerMap(await proof(), peer);
   if (signal?.aborted) throw new RigError(499, 'cancelled');
  const token=await secret(); if(signal?.aborted)throw new RigError(499,'cancelled');
  return new Promise((resolve,reject)=>{
   let req,done=false;
   const finish=(err,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);err?reject(err):resolve(value)};
   const abort=()=>{finish(new RigError(499,'cancelled'));req?.destroy()};
   const timeout=path==='/v1/audio/transcriptions'?(headers['X-ASR-Phase']==='preview'?25000:250000):15000;
    const timer=setTimeout(()=>{finish(new RigError(504,'timeout'));req?.destroy()},timeout);
   try{req=request({protocol:'http:',hostname:peer.ip,port:peer.port,path,method,agent:false,headers:{...headers,Authorization:`Bearer ${token}`,Accept:'application/json',...(body?{'Content-Length':body.length}:{})}},res=>{
    const status=res.statusCode;
    const refused=Number.isInteger(status)&&status>=400&&status<=599;
    const fallback=()=>new RigError(refused?status:502,'gateway_refused');
    if(!refused&&!(status>=200&&status<300)){
     finish(fallback());res.destroy();return; // Never follow redirects.
    }
    const chunks=[];let bytes=0;
    res.on('data',chunk=>{
     if(done)return;
     bytes+=chunk.length;
     if(bytes>(refused?16384:2*1024*1024)){
      finish(refused?fallback():new RigError(502,'response_limit'));res.destroy();
     }else chunks.push(chunk);
    });
    const broken=()=>finish(refused?fallback():new RigError(502,'response_failed'));
    res.on('error',broken);
    res.on('close',broken);
    res.on('end',()=>{
     if(done)return;
     const text=Buffer.concat(chunks).toString('utf8');
     if(refused){finish(upstreamError(status,text));return}
     try{const parsed=JSON.parse(text);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error();finish(null,parsed)}catch{finish(new RigError(502,'response_invalid'))}
    });
   });}catch{finish(new RigError(502,'transport_failed'));return}
   req.on('socket', socket => {
     const send = () => {
      if (done) return;
      const ip = socket.remoteAddress?.replace(/^::ffff:/, '');
      if (ip !== peer.ip || socket.remotePort !== peer.port) {
       finish(new RigError(503, 'connected_peer_mismatch')); req.destroy(); return;
      }
      try { req.end(body); } catch { finish(new RigError(502, 'transport_failed')); req.destroy(); }
     };
     if (socket.connecting) socket.once('connect', send); else send();
    });
   req.on('error',()=>finish(new RigError(502,'transport_failed')));
   signal?.addEventListener('abort',abort,{once:true}); if(signal?.aborted)abort();
  });
 }
 return {
  status:()=>json('GET','/asr/status'), prepare:()=>json('POST','/asr/prepare'), pool:()=>json('GET','/asr/pool'),
  ack:id=>{if(typeof id!=='string'||!/^[-A-Za-z0-9_]{1,80}$/.test(id))throw new RigError(502,'job_id_invalid');return json('POST',`/asr/jobs/${id}/ack`)},
  configure:settings=>json('PUT','/asr/pool',Buffer.from(JSON.stringify(settings)),{'Content-Type':'application/json'}),
  transcribe:(flac,metadata,signal)=>{const form=multipart(flac,metadata);return json('POST','/v1/audio/transcriptions',form.body,form.headers,signal)},
 };
}
