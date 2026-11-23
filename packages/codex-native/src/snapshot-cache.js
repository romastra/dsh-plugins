// Bounded account-scoped telemetry cache; never blocks model streams.
export function createSnapshotCache({load,now=Date.now,ttlMs=60000,retryMs=300000}){
 const entries=new Map();let epoch=0,disposed=false;
 function entry(scope){let e=entries.get(scope);if(!e){e={value:null,checkedAt:null,retryAt:0,flight:null,controller:null};entries.set(scope,e);}return e;}
 function get(scope){const e=entry(scope);return {value:e.value,checkedAt:e.checkedAt,stale:e.checkedAt===null||now()-e.checkedAt>=ttlMs,refreshing:!!e.flight};}
 async function ensure(scope){if(disposed)throw new Error('CODEX_METADATA_DISPOSED');const e=entry(scope);if(e.flight)return e.value!==null?undefined:e.flight;if(e.checkedAt!==null&&now()-e.checkedAt<ttlMs)return;if(now()<e.retryAt)return;const version=epoch;const controller=new AbortController();e.controller=controller;const flight=Promise.resolve().then(()=>{if(disposed||version!==epoch||controller.signal.aborted)throw new Error('CODEX_METADATA_DISPOSED');return load(scope,{signal:controller.signal});}).then(value=>{if(disposed||version!==epoch||controller.signal.aborted)return;e.value=value;e.checkedAt=now();e.retryAt=0;},error=>{if(!disposed&&version===epoch)e.retryAt=now()+Math.max(retryMs,Number.isFinite(error?.retryAfterMs)?Math.min(error.retryAfterMs,86400000):0);}).finally(()=>{if(e.flight===flight){e.flight=null;e.controller=null;}});e.flight=flight;if(e.value!==null){void flight;return;}await flight;}
 function invalidate(){epoch++;for(const e of entries.values())e.controller?.abort();entries.clear();}
 return {get,ensure,invalidate,dispose(){disposed=true;invalidate();}};
}
