// Self-contained browser feature: compiler inlines this beside preserved capture code.
export function captureHeaders(rec,phase,{segment=null,attempt=0}={}){
 if(!rec.takeId||!Number.isSafeInteger(rec.generation))throw new Error('capture identity unavailable');
 const sequence=phase==='final'?('final'+(segment===null?'':'.window.'+segment)+(attempt===0?'':'.retry.'+attempt)):String(++rec.requestSequence);
 return {'x-asr-phase':phase,'x-asr-utterance-id':rec.takeId,'x-asr-generation':String(rec.generation),'idempotency-key':rec.takeId+'.'+rec.generation+'.'+sequence};
}
export function applyRigCopy(dicts){
 const copy={
  en:{'status.processing':'Transcribing…','error.empty':'No speech recognized.','error.notPrepared':'Rig interactive ASR is not ready.','error.preparing':'Rig GPU workers are warming.','prepare.title':'Qwen ASR 1.7B · Rig GPU','prepare.description':'Audio is compressed to FLAC on the DSH host, then sent over the private Tailnet to Rig GPU. No local ASR model is started.','prepare.sizeUnknown':'Model is hosted on Rig','prepare.hint':'Prepare requests the configured GPU pool. No model is downloaded here.','prepare.error':'Rig ASR is unavailable.','prepare.phase.checking':'Checking Rig readiness…','prepare.phase.installing':'Warming Rig GPU workers…','prepare.phase.downloading':'Warming Rig GPU workers…','prepare.phase.ready':'Rig interactive ASR is ready.','prepare.phase.error':'Rig readiness check failed.'},
  ru:{'status.processing':'Распознаю…','error.empty':'Речь не распознана.','error.notPrepared':'Интерактивный ASR на Rig не готов.','error.preparing':'GPU-воркеры Rig прогреваются.','prepare.title':'Qwen ASR 1.7B · Rig GPU','prepare.description':'DSH сжимает аудио в FLAC и передаёт по приватному Tailnet на GPU Rig. Локальная ASR-модель не запускается.','prepare.sizeUnknown':'Модель размещена на Rig','prepare.hint':'Подготовка запрашивает прогрев настроенного GPU-пула. Модель здесь не скачивается.','prepare.error':'Rig ASR недоступен.','prepare.phase.checking':'Проверяю готовность Rig…','prepare.phase.installing':'Прогреваются GPU-воркеры Rig…','prepare.phase.downloading':'Прогреваются GPU-воркеры Rig…','prepare.phase.ready':'Интерактивный ASR на Rig готов.','prepare.phase.error':'Проверка готовности Rig не удалась.'},
  zh:{'status.processing':'正在识别…','error.empty':'未识别到语音。','error.notPrepared':'Rig 交互识别尚未就绪。','error.preparing':'Rig GPU 正在预热。','prepare.title':'Qwen ASR 1.7B · Rig GPU','prepare.description':'DSH 将音频压缩为 FLAC，通过私有 Tailnet 发送到 Rig GPU；不启动本地识别模型。','prepare.sizeUnknown':'模型位于 Rig','prepare.hint':'准备操作请求 GPU 池预热，不在本地下载模型。','prepare.error':'Rig ASR 不可用。','prepare.phase.checking':'正在检查 Rig…','prepare.phase.installing':'正在预热 Rig GPU…','prepare.phase.downloading':'正在预热 Rig GPU…','prepare.phase.ready':'Rig 交互识别已就绪。','prepare.phase.error':'Rig 检查失败。'}
 };for(const locale of Object.keys(copy))Object.assign(dicts[locale],copy[locale]);
}
export function createRigSettings(React,{api}){
 const h=React.createElement;
 return function RigSettings(){
  const [pool,setPool]=React.useState(null),[backend,setBackend]=React.useState(null),[status,setStatus]=React.useState(null),[error,setError]=React.useState(''),[busy,setBusy]=React.useState(false);
  const [bulk,setBulk]=React.useState('7'),[reserve,setReserve]=React.useState('1');const dirty=React.useRef(false),alive=React.useRef(true);
  async function refresh(){try{const [p,b,s]=await Promise.all([api('/pool'),api('/backend'),api('/status')]);if(!alive.current)return;setPool(p);setBackend(b);setStatus(s);if(!dirty.current){setBulk(String(p.config.bulk_workers??p.config.bulk_gpu_ids?.length??0));setReserve(String(p.config.interactive_workers??p.config.interactive_gpu_ids?.length??0))}setError('')}catch{if(alive.current)setError('Rig status unavailable; no local fallback.')}}
  React.useEffect(()=>{alive.current=true;void refresh();const timer=window.setInterval(()=>void refresh(),3000);return()=>{alive.current=false;window.clearInterval(timer)}},[]);
  async function mutate(path,body){setBusy(true);setError('');try{await api(path,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(body)});dirty.current=false;await refresh()}catch{if(alive.current)setError('Change refused or gateway unavailable; refresh before retrying.')}finally{if(alive.current)setBusy(false)}}
  const workers=pool?.workers??[],valid=/^\d+$/.test(bulk)&&/^\d+$/.test(reserve)&&Number(bulk)+Number(reserve)<=13;
  return h('section',{'aria-label':'Rig ASR pool',style:{padding:16,display:'grid',gap:12}},
   h('h2',null,'Qwen ASR 1.7B · Rig GPU'),h('p',null,'Private Tailnet · desired pool vs actual GPU worker state. Active jobs finish before draining.'),
   error&&h('p',{role:'alert'},error),
   h('p',{role:'status'},`Backend ${status?.backend??'unverified'} · ${status?.model??'unverified'} · ${status?.device??'unverified'} · ${status?.ready?'interactive ready':'not ready'}`),
   h('p',null,`Desired GPU lists: bulk ${(pool?.config.bulk_gpu_ids??[]).join(', ')||'none'}; interactive ${(pool?.config.interactive_gpu_ids??[]).join(', ')||'none'}`),
   h('label',null,'Backend ',h('select',{'aria-label':'ASR backend',value:backend?.backend??'rig',disabled:busy||!backend,onChange:e=>void mutate('/backend',{backend:e.target.value})},h('option',{value:'rig'},'Rig Qwen ASR'),h('option',{value:'local',disabled:!backend?.localEnabled},'Local Parakeet (disabled rollback)'))),
   h('label',null,'Bulk workers (desired) ',h('input',{type:'number',min:0,max:13,value:bulk,onChange:e=>{dirty.current=true;setBulk(e.target.value)}})),
   h('label',null,'Interactive reserve (desired) ',h('input',{type:'number',min:0,max:13,value:reserve,onChange:e=>{dirty.current=true;setReserve(e.target.value)}})),
   h('p',null,`Desired total: ${Number(bulk)+Number(reserve)} / 13 · actual ${workers.length} · ready ${workers.filter(w=>w.ready).length} · busy ${workers.filter(w=>w.busy).length} · draining ${workers.filter(w=>w.draining).length}`),
   h('div',null,h('button',{type:'button',disabled:busy||!valid||!pool,onClick:()=>void mutate('/pool',{bulk_workers:Number(bulk),interactive_workers:Number(reserve)})},'Apply pool'),h('button',{type:'button',disabled:busy||!pool,onClick:()=>void mutate('/pool',{bulk_workers:0,interactive_workers:Number(pool?.config.interactive_workers??1)})},'Drain bulk'),h('button',{type:'button',disabled:busy||!pool,onClick:()=>void mutate('/pool',{bulk_workers:0,interactive_workers:0})},'Drain all after active jobs'),h('button',{type:'button',disabled:busy,onClick:()=>void refresh()},'Refresh')),
   h('p',null,`Queued: bulk ${pool?.queue.bulk??0}, interactive ${pool?.queue.interactive??0}`),
   h('ul',null,...workers.map(w=>h('li',{key:w.worker_id},`GPU ${w.gpu} · ${w.role} · ${w.state}${w.draining?' · draining':''}${w.error?' · unavailable':''}`)))
  );
 };
}
