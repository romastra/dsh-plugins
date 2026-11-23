import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
const verifiedBinaries = new Map();
import { createHash } from 'node:crypto';
import { RigError, localPath } from './rig-transport.mjs';
import { RIG_MAX_RECORDING_SECONDS } from './recording-limit.mjs';
export function validatePcmWav(wav) {
 if(!Buffer.isBuffer(wav)||wav.length<512||wav.length>20*1024*1024||wav.toString('ascii',0,4)!=='RIFF'||wav.toString('ascii',8,12)!=='WAVE'||wav.readUInt32LE(4)!==wav.length-8)throw new RigError(400,'wav_invalid');
 let offset=12,fmt=null,data=null;
 while(offset+8<=wav.length){const kind=wav.toString('ascii',offset,offset+4),size=wav.readUInt32LE(offset+4);offset+=8;if(offset+size>wav.length)throw new RigError(400,'wav_invalid');
  if(kind==='fmt '){if(fmt||size!==16)throw new RigError(400,'wav_invalid');fmt=wav.subarray(offset,offset+size)}
  else if(kind==='data'){if(data)throw new RigError(400,'wav_invalid');data=wav.subarray(offset,offset+size)}
  else throw new RigError(400,'wav_chunk_unsupported');
  offset+=size+(size%2);
 }
 if(offset!==wav.length||!fmt||!data||fmt.readUInt16LE(0)!==1||fmt.readUInt16LE(2)!==1||fmt.readUInt16LE(14)!==16||fmt.readUInt16LE(12)!==2)throw new RigError(400,'wav_pcm16_mono_required');
 const rate=fmt.readUInt32LE(4);if(rate<8000||rate>192000||fmt.readUInt32LE(8)!==rate*2||data.length%2!==0||data.length<2||data.length/(2*rate)>RIG_MAX_RECORDING_SECONDS)throw new RigError(400,'wav_duration_invalid');
 return {duration:data.length/(2*rate),rate};
}
export async function verifyEncoder(path,sha256) {
 localPath(path);if(typeof sha256!=='string'||!/^[a-f0-9]{64}$/.test(sha256))throw new RigError(503,'encoder_hash_required');
 const st=await lstat(path);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>512*1024*1024)throw new RigError(503,'encoder_invalid');
 const key=path+'|'+sha256,stamp=[st.dev,st.ino,st.size,st.mtimeMs,st.ctimeMs].join(':');
 const prior=verifiedBinaries.get(key);if(prior?.stamp===stamp)return prior.promise;
 const promise=(async()=>{const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);if(hash.digest('hex')!==sha256)throw new RigError(503,'encoder_hash_mismatch')})();
 verifiedBinaries.set(key,{stamp,promise});try{await promise}catch(error){verifiedBinaries.delete(key);throw error}
}
export function createFlacEncoder(config,dependencies={}) {
 const spawnChild=dependencies.spawn??spawn,verify=dependencies.verify??(()=>verifyEncoder(config.ffmpegPath,config.ffmpegSha256));
 return async (wav,signal)=>{
  validatePcmWav(wav);await verify();if(signal?.aborted)throw new RigError(499,'cancelled');
  return new Promise((resolve,reject)=>{
   let child,done=false,closed=false,failure=null,chunks=[],bytes=0,killTimer;
   const settle=(err,result)=>{if(done)return;done=true;clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);err?reject(err):resolve(result)};
   const fail=error=>{
    if(done||failure)return;failure=error;clearTimeout(timer);signal?.removeEventListener('abort',abort);
    if(!child||closed){settle(error);return}
    // Own only this exact ChildProcess; never a PID lookup, process tree, or worker.
    try{child.stdin.destroy()}catch{}try{child.kill()}catch{}
    // Keep the close/reap listener and escalation alive even after stdin EPIPE.
    if(!closed)killTimer=setTimeout(()=>{if(!closed)try{child.kill('SIGKILL')}catch{}},dependencies.killDelayMs??1000);
   };
   const abort=()=>fail(new RigError(499,'cancelled'));
   const timer=setTimeout(()=>fail(new RigError(504,'encoder_timeout')),dependencies.timeoutMs??30000);
   try{child=spawnChild(localPath(config.ffmpegPath),['-hide_banner','-loglevel','error','-nostdin','-protocol_whitelist','pipe','-f','wav','-i','pipe:0','-map','0:a:0','-vn','-c:a','flac','-compression_level','5','-f','flac','pipe:1'],{windowsHide:true,shell:false,env:{SystemRoot:process.env.SystemRoot},stdio:['pipe','pipe','pipe']})}catch{fail(new RigError(503,'encoder_spawn'));return}
   child.stdout.on('data',chunk=>{if(failure)return;bytes+=chunk.length;if(bytes>20*1024*1024)fail(new RigError(413,'compressed_audio_limit'));else chunks.push(chunk)});
   child.stderr.on('data',()=>{});child.on('error',()=>fail(new RigError(503,'encoder_spawn')));child.stdin.on('error',()=>fail(new RigError(502,'encoder_input')));
   child.stdout.on('error',()=>fail(new RigError(502,'encoder_output')));child.stderr.on('error',()=>fail(new RigError(502,'encoder_output')));
   child.on('close',code=>{closed=true;if(done)return;if(failure){settle(failure);return}const flac=Buffer.concat(chunks);if(code!==0||flac.length<4||flac.subarray(0,4).toString()!=='fLaC'){settle(new RigError(502,'encoder_failed'));return}settle(null,flac)});
   signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted){abort();return}try{child.stdin.end(wav)}catch{fail(new RigError(502,'encoder_input'))}
  });
 };
}
