/** Catalog discovery compatibility version, not an installed CLI or executable. */
import { readMetadataBody } from './model-catalog.js';
export const CODEX_CATALOG_CLIENT_VERSION = '0.171.0'; // Verified against the live official catalog, 2026-11-20.
export const CODEX_VERSION_METADATA_URL = 'https://registry.npmjs.org/@openai/codex/latest';
const unavailable = () => Object.assign(new Error('CODEX_CATALOG_PROTOCOL_UNAVAILABLE'), { code: 'CODEX_CATALOG_PROTOCOL_UNAVAILABLE' });
const validVersion = value => typeof value === 'string' && /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/.test(value);
const compare = (a,b) => { const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]-y[i];return 0; };

/** Public metadata only: never forwards Codex authorization/account headers. */
export async function fetchCatalogClientVersion({ signal, fetchFn = fetch } = {}) {
  const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000);
  const response = await fetchFn(CODEX_VERSION_METADATA_URL, {
    headers: { accept: 'application/json' }, credentials: 'omit', redirect: 'error', signal: bounded,
  });
  if (!response.ok) {
    const error = unavailable(), raw = response.headers.get('retry-after');
    const delay = raw !== null && /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw)*1000 : Date.parse(raw??'')-Date.now();
    if(Number.isFinite(delay)&&delay>0)error.retryAfterMs=Math.min(delay,86400000);
    throw error;
  }
  const body = await readMetadataBody(response, { maxBytes: 131072, signal: bounded });
  if(body?.name!=='@openai/codex' || !validVersion(body?.version))throw unavailable();
  return body.version;
}

function waitFor(promise, signal) {
  if(!signal)return promise;
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason??unavailable());};
    signal.addEventListener('abort',abort,{once:true});
    promise.then(value=>{signal.removeEventListener('abort',abort);if(signal.aborted)reject(signal.reason??unavailable());else resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
    if(signal.aborted)abort();
  });
}

/** Daily public-version lookup + singleflight + fallback; no package installation. */
export function createCatalogProtocol({ loadVersion = fetchCatalogClientVersion, now = Date.now, ttlMs = 86400000, retryMs = 3600000 } = {}) {
  if(typeof loadVersion!=='function'||typeof now!=='function'||!Number.isSafeInteger(ttlMs)||ttlMs<1||!Number.isSafeInteger(retryMs)||retryMs<1)throw unavailable();
  let version=CODEX_CATALOG_CLIENT_VERSION, checkedAt=null, nextCheck=0, retryAt=0, flight, disposed=false;
  function start() {
    const controller=new AbortController(), owned={controller,promise:undefined};
    flight=owned;
    const aborted=new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(unavailable()),{once:true}));
    owned.promise=Promise.race([Promise.resolve().then(()=>{if(disposed||controller.signal.aborted)throw unavailable();return loadVersion({signal:controller.signal});}),aborted]).then(next=>{
      if(disposed||flight!==owned||controller.signal.aborted)return;
      if(!validVersion(next)||compare(next,version)<0)throw unavailable();
      version=next;checkedAt=now();nextCheck=checkedAt+ttlMs;retryAt=0;
    }).catch(error=>{
      if(!disposed&&flight===owned){const delay=Number.isFinite(error?.retryAfterMs)&&error.retryAfterMs>0?Math.min(error.retryAfterMs,86400000):0;retryAt=now()+Math.max(retryMs,delay);}
    }).finally(()=>{if(flight===owned)flight=undefined;});
    return owned.promise;
  }
  return {
    async ensure({signal}={}) {
      if(disposed)throw unavailable();signal?.throwIfAborted();
      if(now()>=nextCheck&&now()>=retryAt&&!flight)start();
      if(flight)await waitFor(flight.promise,signal);
      signal?.throwIfAborted();if(disposed)throw unavailable();
      return version;
    },
    snapshot:()=>({version,checkedAt,refreshing:Boolean(flight)}),
    dispose(){if(disposed)return;disposed=true;flight?.controller.abort();},
  };
}
