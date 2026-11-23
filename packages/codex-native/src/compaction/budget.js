// Adapted from WSL043 context-budget.js. The Host has already selected its descriptor.
export function compactionThreshold(window,reserved=0,configured=null){
  if(!Number.isSafeInteger(window)||window<=0||!Number.isSafeInteger(reserved)||reserved<0||configured!==null&&(!Number.isSafeInteger(configured)||configured<1000))return null;
  const limit=Math.floor(Math.min(0.8*window,window-reserved-65536,configured??Infinity));
  return limit>=1000?limit:null;
}
