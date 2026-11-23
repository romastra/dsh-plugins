// A second allowlist at the persistence boundary: never log provider payloads.
import { REPORTED_SERVICE_TIERS, SPEED_TIERS } from './policy.js';
const phases=new Set(['request-policy','response-terminal']);
const tiers=new Set(REPORTED_SERVICE_TIERS);
const efforts=new Set(['none','minimal','low','medium','high','xhigh','max']);
const transports=new Set(['sse','websocket','websocket-cached','auto']);
const flags=['serviceTierPresent','store','includesEncryptedReasoning','rawReportedTierPresent','rawReportedTierRecognized'];
const counts=['requestId','reasoningItems','terminalSignatures','replayReasoningItems','replayEncryptedReasoningItems','toolResultItems'];
export function redactEvidence(row,{time=Date.now(),purpose='generation'}={}){
 if(!row||!phases.has(row.phase))throw new Error('CODEX_EVIDENCE_PHASE_INVALID');
 const result={time,phase:row.phase,purpose:purpose==='session-title'?'session-title':'generation'};
 for(const key of flags)if(typeof row[key]==='boolean')result[key]=row[key];
 for(const key of counts)if(Number.isSafeInteger(row[key])&&row[key]>=0)result[key]=row[key];
 for(const key of ['serviceTier','rawReportedTier','requestedTier'])if(row[key]===null||tiers.has(row[key]))result[key]=row[key];
 if(SPEED_TIERS.includes(row.selectedTier))result.selectedTier=row.selectedTier;
 if(row.reasoningEffort===null||efforts.has(row.reasoningEffort))result.reasoningEffort=row.reasoningEffort;
 if(transports.has(row.transport))result.transport=row.transport;
 if(['response.completed','response.done','response.incomplete','response.failed'].includes(row.eventType))result.eventType=row.eventType;
 return result;
}
