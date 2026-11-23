// Numeric report allowlists adapted from WSL043 plan-history.js / usage-profile.js.
import { object, own, label, error } from './parse.js';
const dimensions=['model','surface','thread_source','turn_trigger'];
const whole=x=>Number.isSafeInteger(x)&&x>=0?x:undefined;
const pct=x=>Number.isFinite(x)&&x>=0?x/100:undefined;
const dateDay=x=>{if(typeof x!=='string'||!/^\d{4}-\d{2}-\d{2}$/u.test(x))return undefined;const time=Date.parse(x);return Number.isFinite(time)&&new Date(time).toISOString().slice(0,10)===x?x:undefined;};
const stamp=x=>typeof x==='string'&&x.length<=64&&dateDay(x.slice(0,10))&&/^\d{4}-\d{2}-\d{2}T/u.test(x)&&Number.isFinite(Date.parse(x))?Date.parse(x):undefined;
const put=x=>Object.fromEntries(Object.entries(x).filter(([,v])=>v!==undefined));
export function parsePlanHistory(body){
  const rows=own(body,'periods');
  if(!Array.isArray(rows)||rows.length>1024)throw error('QUOTA_HISTORY_BAD_RESPONSE');
  let truncated=rows.length>64;
  const periods=[];
  for(const raw of rows.slice(0,64)){
    const startsAt=stamp(own(raw,'starts_at')),endsAt=stamp(own(raw,'ends_at'));
    if(startsAt===undefined||endsAt===undefined||endsAt<=startsAt){truncated=true;continue;}
    const breakdowns={};const groups=own(raw,'breakdowns');
    if(Array.isArray(groups)){
      if(groups.length>16)truncated=true;
      for(const group of groups.slice(0,16)){
        const d=own(group,'dimension'),cells=own(group,'rows');
        if(!dimensions.includes(d)||!Array.isArray(cells)||Object.hasOwn(breakdowns,d))continue;
        if(cells.length>24)truncated=true;
        breakdowns[d]=cells.slice(0,24).flatMap(cell=>{const key=label(own(cell,'key'),96),percent=pct(own(cell,'basis_points'));return key&&percent!==undefined?[{key,percent}]:[];});
      }
    }
    const complete=own(raw,'accounting_complete')===true;
    periods.push(put({startsAt,endsAt,windowMinutes:whole(own(raw,'window_minutes'))||undefined,planType:label(own(raw,'plan_type'),32),complete,usedPercent:pct(own(raw,'used_basis_points')),breakdowns}));
  }
  return put({periods,asOf:stamp(own(body,'data_as_of')),coverageStart:stamp(own(body,'coverage_start')),coverageComplete:own(body,'coverage_complete')===true&&!truncated,approximate:own(body,'approximate')!==false||truncated});
}
export function parseUsageProfile(body){
  const s=own(body,'stats');if(!object(s))throw error('QUOTA_PROFILE_BAD_RESPONSE');
  const count=k=>whole(own(s,k)), pctStat=k=>{const x=own(s,k);return Number.isFinite(x)&&x>=0&&x<=100?x:undefined;};
  const e=own(s,'most_used_reasoning_effort'),mostUsedReasoningEffort=typeof e==='string'&&/^[a-z_]{1,16}$/u.test(e)?e:undefined;
  const rows=own(s,'daily_usage_buckets'); const dates=new Map();
  if(Array.isArray(rows))for(const row of rows.slice(-800)){const date=dateDay(own(row,'start_date')),tokens=whole(own(row,'tokens'));if(date&&tokens!==undefined)dates.set(date,{date,tokens});}
  return put({lifetimeTokens:count('lifetime_tokens'),peakDailyTokens:count('peak_daily_tokens'),currentStreakDays:count('current_streak_days'),longestStreakDays:count('longest_streak_days'),totalThreads:count('total_threads'),longestRunningTurnSeconds:count('longest_running_turn_sec'),fastModePercent:pctStat('fast_mode_usage_percentage'),totalSkillsUsed:count('total_skills_used'),uniqueSkillsUsed:count('unique_skills_used'),mostUsedReasoningEffort,mostUsedReasoningEffortPercent:mostUsedReasoningEffort?pctStat('most_used_reasoning_effort_percentage'):undefined,days:[...dates.values()].sort((a,b)=>a.date.localeCompare(b.date))});
}
