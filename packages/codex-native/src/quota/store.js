import { open,lstat,rename,unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { error,object } from './parse.js';

export async function readJson(path,limit){
  const p=await lstat(path).catch(e=>{if(e.code!=='ENOENT')throw e;return null;});
  if(!p)return undefined;
  if(!p.isFile()||p.isSymbolicLink()||p.size>limit)throw error('QUOTA_STATE_INVALID');
  const h=await open(path,'r');
  try{
    const buffer=Buffer.alloc(limit+1);let length=0;
    while(length<buffer.length){const r=await h.read(buffer,length,buffer.length-length,length);if(!r.bytesRead)break;length+=r.bytesRead;}
    if(length>limit)throw error('QUOTA_STATE_INVALID');
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,length)));
  } finally{await h.close();}
}
export async function writeJson(path,value,limit){
  const data=Buffer.from(JSON.stringify(value)+'\n','utf8');
  if(data.length>limit)throw error('QUOTA_STATE_LIMIT');
  const temp=`${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try{
    handle=await open(temp,'wx',0o600);await handle.writeFile(data);await handle.sync();await handle.close();handle=undefined;
    const p=await lstat(path).catch(e=>{if(e.code!=='ENOENT')throw e;return null;});
    if(p&&(!p.isFile()||p.isSymbolicLink()))throw error('QUOTA_STATE_INVALID');
    await rename(temp,path);
    // Windows does not permit opening directories this way. File FlushFileBuffers
    // + same-directory atomic rename is the available boundary on that platform.
    if(process.platform!=='win32'){
      const parent=await open(dirname(path),'r').catch(e=>{if(!['EISDIR','EINVAL','EPERM','ENOTSUP'].includes(e.code))throw e;});
      if(parent)try{await parent.sync();}catch(e){if(!['EINVAL','EPERM','ENOTSUP','EBADF'].includes(e.code))throw e;}finally{await parent.close();}
    }
  }finally{await handle?.close().catch(()=>{});await unlink(temp).catch(()=>{});}
}
export function serialize(){let tail=Promise.resolve();return action=>{const run=tail.then(action);tail=run.catch(()=>{});return run;};}
export const DEFAULT_PREFS=Object.freeze({schemaVersion:1,forecastEnabled:false,quotaAlerts:'important',shortWarningThreshold:20,longWarningThreshold:20,autoQuotaRetry:false});
const keyValid={forecastEnabled:v=>typeof v==='boolean',quotaAlerts:v=>['off','important','early','custom'].includes(v),shortWarningThreshold:threshold,longWarningThreshold:threshold,autoQuotaRetry:v=>typeof v==='boolean'};
function threshold(v){return Number.isInteger(v)&&v>=1&&v<=100;}
function patchPrefs(value){
  if(!object(value))throw error('QUOTA_PREFERENCES_INVALID');
  const keys=Object.keys(value);
  if(keys.some(k=>!Object.hasOwn(keyValid,k)||!keyValid[k](value[k])))throw error('QUOTA_PREFERENCES_INVALID');
  return Object.fromEntries(keys.map(k=>[k,value[k]]));
}
export function createPreferences({file,readOnly=false,changed=()=>{}}){
  const sync=serialize();let state=DEFAULT_PREFS;
  const ready=readJson(file,4096).then(value=>{if(value===undefined)return;const {schemaVersion,...patch}=value;if(schemaVersion!==1)throw error('QUOTA_PREFERENCES_INVALID');state=Object.freeze({...DEFAULT_PREFS,...patchPrefs(patch)});}).catch(()=>{});
  return {ready,get:()=>state,async set(patch){
    if(readOnly)throw error('QUOTA_MANAGED_BY_DESKTOP');
    patch=patchPrefs(patch);await ready;
    return sync(async()=>{const next=Object.freeze({...state,...patch});await writeJson(file,next,4096).catch(()=>{throw error('QUOTA_PREFERENCES_IO');});const previous=state;state=next;changed(next,previous);return state;});
  }};
}
