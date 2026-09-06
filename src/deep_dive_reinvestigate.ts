import { promises as fs } from "node:fs";
import path from "node:path";

const HELIUS_API_KEY=process.env.HELIUS_API_KEY?.trim();
const STATE_PATH=process.env.SCOUT_STATE_PATH||"./data/shark-state.json";
const CHECKPOINT_PATH=process.env.SCOUT_GAUNTLET_STATE_PATH||"./data/gauntlet-state.json";
const QUEUE_PATH=process.env.SCOUT_DEEP_DIVE_QUEUE_PATH||"./data/deep-dive-queue.json";
const CACHE_DIR=process.env.SCOUT_HELIUS_CACHE_DIR||"./data/helius-cache";
const BATCH=Math.max(1,Math.min(20,Number(process.env.DEEP_DIVE_BATCH||8)));
const PAGES=Math.max(6,Math.min(20,Number(process.env.DEEP_DIVE_HELIUS_PAGES||12)));
const FALLBACK_PAGES=Math.max(1,Math.min(8,Number(process.env.DEEP_DIVE_UNFILTERED_PAGES||4)));
const COOLDOWN_HOURS=Math.max(2,Math.min(72,Number(process.env.DEEP_DIVE_COOLDOWN_HOURS||12)));
const MIN_INTERVAL_MS=Math.max(120,Math.min(3000,Number(process.env.DEEP_DIVE_HELIUS_MIN_INTERVAL_MS||350)));
const TIMEOUT_MS=Math.max(3000,Math.min(60000,Number(process.env.REQUEST_TIMEOUT_MS||25000)));

type AnyObj=Record<string,any>;
type QueueEntry={address:string;priority:number;bucket:string;reasons:string[];status:string;stage:string;lastEvaluatedAt:string|null;selectedAt?:string;attempts?:number;lastAttemptAt?:string;rowsFetched?:number;partial?:boolean;error?:string|null;coverage?:number;closed?:number;buys?:number;replayTrades?:number;replayNet?:number|null;stress50?:number|null;stateStatus?:string};

function n(v:any,d=0){const x=Number(v);return Number.isFinite(x)?x:d;}
function finite(v:any){const x=Number(v);return Number.isFinite(x)?x:null;}
function ageHours(iso:any){const t=Date.parse(String(iso||""));return Number.isFinite(t)?(Date.now()-t)/3600000:99999;}
function sleep(ms:number){return new Promise(r=>setTimeout(r,ms));}
async function atomic(file:string,data:any){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;await fs.writeFile(tmp,JSON.stringify(data));await fs.rename(tmp,file);}
async function json(file:string,fallback:any){try{return JSON.parse(await fs.readFile(file,"utf8"));}catch{return fallback;}}

function classify(r:any){
  const status=String(r?.verdict?.status||"UNKNOWN"),stage=String(r?.verdict?.stage||"unknown"),reasons:string[]=Array.isArray(r?.verdict?.reasons)?r.verdict.reasons:[];
  const h=r?.hold||{},rp=r?.replay?.twoPerDay||{},q=r?.dataQuality||{};
  const closed=n(h.closedHolds),buys=n(h.buyEvents),trades=n(rp.selected),net=finite(rp.netSol),stress=finite(rp.stress50NetSol),med=n(h.medianHoldSeconds),tokens=n(r.discoveryTokens),coverage=buys>0?Math.min(1,closed/buys):0;
  const positiveReplay=trades>=3&&net!==null&&net>0;
  const stressPositive=stress!==null&&stress>0;
  const longHold=med>=3600;
  const hardFast=med>0&&med<600;
  const badEconomics=stage==="fixed_size_economics"&&net!==null&&net<=0;
  const antiJackpotFail=stage==="robustness"&&r?.robustness?.antiJackpotPass===false;

  let bucket="LOW_INFORMATION",priority=0;
  if(status==="SIGNAL_ONLY")priority+=220; else if(status==="UNKNOWN")priority+=180; else if(status==="REJECT")priority+=30;
  if(med>=43200)priority+=160; else if(med>=21600)priority+=130; else if(longHold)priority+=70; else if(hardFast)priority-=350;
  priority+=Math.min(100,closed*4)+Math.min(70,tokens*18);
  if(positiveReplay)priority+=160;
  if(stressPositive)priority+=180;
  if(q.score!=null)priority+=Math.round(n(q.score)*70);
  if(r?.heliusCoveragePartial)priority+=110;
  if(r?.heliusError||r?.vybeError)priority+=45;
  if(reasons.some(x=>String(x).includes("single_discovery")))priority+=45;
  if(reasons.some(x=>String(x).includes("history_window_partial")))priority+=120;
  if(coverage>0&&coverage<0.5)priority+=Math.round((0.5-coverage)*180);
  if(trades===0&&longHold&&closed>=10)priority+=125;
  if(hardFast||reasons.some(x=>String(x).includes("under_10m")))priority-=300;
  if(badEconomics)priority-=220;
  if(antiJackpotFail)priority-=150;

  if(status==="REJECT"&&positiveReplay&&stressPositive&&longHold&&!hardFast&&!badEconomics)bucket="NEAR_PASS_STRESS";
  else if(trades===0&&longHold&&closed>=10)bucket="REPLAY_RECONSTRUCTION";
  else if(r?.heliusCoveragePartial||reasons.some(x=>String(x).includes("history_window_partial"))||coverage<0.35&&buys>=10)bucket="HISTORY_RECONSTRUCTION";
  else if(status==="UNKNOWN"&&(r?.heliusError||r?.vybeError||stage==="evaluation_error"))bucket="PROVIDER_RETRY";
  else if(reasons.some(x=>String(x).includes("single_discovery")))bucket="CONTEXT_EXPANSION";
  else if(status==="SIGNAL_ONLY"&&longHold)bucket="ECONOMICS_INCOMPLETE";
  else if(status==="SIGNAL_ONLY"&&med>=600)bucket="HOLD_BORDERLINE";
  else if(status==="UNKNOWN")bucket="INSUFFICIENT_EVIDENCE";
  else if(status==="REJECT"&&priority>100)bucket="REJECT_RECHECK";

  const reinvestigableReject=status==="REJECT"&&!hardFast&&!badEconomics&&(bucket==="NEAR_PASS_STRESS"||bucket==="HISTORY_RECONSTRUCTION"||bucket==="REPLAY_RECONSTRUCTION"||bucket==="CONTEXT_EXPANSION");
  return{priority,bucket,status,stage,reasons,coverage,closed,buys,trades,net,stress,reinvestigableReject};
}

let nextAt=0;
async function fetchPage(address:string,before:string|undefined,type:string|undefined){
  const wait=Math.max(0,nextAt-Date.now());if(wait)await sleep(wait);nextAt=Math.max(Date.now(),nextAt)+MIN_INTERVAL_MS;
  const c=new AbortController(),timer=setTimeout(()=>c.abort(),TIMEOUT_MS);
  try{
    const u=new URL(`https://api.helius.xyz/v0/addresses/${address}/transactions`);u.searchParams.set("api-key",HELIUS_API_KEY!);u.searchParams.set("limit","100");if(type)u.searchParams.set("type",type);if(before)u.searchParams.set("before",before);
    const r=await fetch(u,{signal:c.signal});const text=await r.text();if(!r.ok)throw new Error(`${r.status}:${text.slice(0,160)}`);
    const rows=JSON.parse(text);return Array.isArray(rows)?rows:[];
  }finally{clearTimeout(timer);}
}

async function collect(address:string,type:string|undefined,pages:number,seed?:Map<string,any>){
  const found=seed||new Map<string,any>();let before:string|undefined,partial=false,error:string|null=null,pagesFetched=0;
  for(let page=0;page<pages;page++){
    try{
      const rows=await fetchPage(address,before,type);pagesFetched++;
      if(!rows.length)break;
      let added=0;for(const x of rows){const sig=String(x?.signature||"");if(sig&&!found.has(sig)){found.set(sig,x);added++;}}
      before=rows[rows.length-1]?.signature;
      if(rows.length<100||added===0)break;
      if(page===pages-1)partial=true;
    }catch(e){error=e instanceof Error?e.message:String(e);partial=true;break;}
  }
  return{found,partial,error,pagesFetched};
}

async function helius(address:string,bucket:string){
  if(!HELIUS_API_KEY)return{rows:[] as any[],partial:true,error:"HELIUS_API_KEY missing",swapRows:0,unfilteredRows:0,pagesFetched:0,mode:"none"};
  const swap=await collect(address,"SWAP",PAGES),swapRows=swap.found.size;
  const needsBroad=swapRows<25||bucket==="REPLAY_RECONSTRUCTION"||bucket==="HISTORY_RECONSTRUCTION"||bucket==="NEAR_PASS_STRESS";
  let merged=swap.found,unfilteredRows=0,partial=swap.partial,error=swap.error,pagesFetched=swap.pagesFetched,mode="swap_only";
  if(needsBroad){
    const before=merged.size;const broad=await collect(address,undefined,FALLBACK_PAGES,merged);merged=broad.found;unfilteredRows=Math.max(0,merged.size-before);partial=partial||broad.partial;error=error||broad.error;pagesFetched+=broad.pagesFetched;mode="swap_plus_unfiltered";
  }
  const rows=[...merged.values()].sort((a,b)=>n(b?.timestamp)-n(a?.timestamp));
  return{rows,partial,error,swapRows,unfilteredRows,pagesFetched,mode};
}

export async function runDeepDiveReinvestigation(){
  const startedAt=new Date().toISOString(),state=await json(STATE_PATH,{wallets:{}}),cp=await json(CHECKPOINT_PATH,{results:{},runs:[]}),prev=await json(QUEUE_PATH,{entries:{},runs:[]});
  const results:Record<string,any>=cp.results||{},wallets:Record<string,any>=state.wallets||{},history:Record<string,any>=prev.entries||{};
  const candidates:QueueEntry[]=[];
  for(const [address,r] of Object.entries(results)){
    if(!wallets[address])continue;
    const c=classify(r),old=history[address]||{},cooling=old.lastAttemptAt&&ageHours(old.lastAttemptAt)<COOLDOWN_HOURS,stateStatus=String(wallets[address]?.status||"");
    if(stateStatus==="REJECTED"&&!c.reinvestigableReject)continue;
    const eligibleStatus=c.status==="UNKNOWN"||c.status==="SIGNAL_ONLY"||c.reinvestigableReject;
    if(!eligibleStatus||cooling||c.priority<=0)continue;
    candidates.push({address,priority:c.priority,bucket:c.bucket,reasons:c.reasons,status:c.status,stage:c.stage,lastEvaluatedAt:r?.evaluatedAt||null,attempts:n(old.attempts),coverage:c.coverage,closed:c.closed,buys:c.buys,replayTrades:c.trades,replayNet:c.net,stress50:c.stress,stateStatus});
  }
  const bucketRank:Record<string,number>={NEAR_PASS_STRESS:0,REPLAY_RECONSTRUCTION:1,HISTORY_RECONSTRUCTION:2,PROVIDER_RETRY:3,CONTEXT_EXPANSION:4,ECONOMICS_INCOMPLETE:5,INSUFFICIENT_EVIDENCE:6,HOLD_BORDERLINE:7,REJECT_RECHECK:8,LOW_INFORMATION:9};
  candidates.sort((a,b)=>(bucketRank[a.bucket]??99)-(bucketRank[b.bucket]??99)||b.priority-a.priority||(a.coverage??0)-(b.coverage??0)||ageHours(b.lastEvaluatedAt)-ageHours(a.lastEvaluatedAt));
  const selected=candidates.slice(0,BATCH),outcomes:any[]=[];
  for(const item of selected){
    const hx=await helius(item.address,item.bucket),now=new Date().toISOString();
    if(hx.rows.length){await fs.mkdir(CACHE_DIR,{recursive:true});await atomic(path.join(CACHE_DIR,`${item.address}.json`),{generatedAt:now,source:"deep_dive_reinvestigation_v2",mode:hx.mode,pagesRequested:{swap:PAGES,unfiltered:FALLBACK_PAGES},pagesFetched:hx.pagesFetched,partial:hx.partial,rows:hx.rows});delete results[item.address];}
    const record={...item,selectedAt:startedAt,lastAttemptAt:now,attempts:n(item.attempts)+1,rowsFetched:hx.rows.length,swapRows:hx.swapRows,unfilteredRows:hx.unfilteredRows,pagesFetched:hx.pagesFetched,fetchMode:hx.mode,partial:hx.partial,error:hx.error||null,invalidatedForGauntlet:hx.rows.length>0};
    history[item.address]=record;outcomes.push(record);
  }
  cp.results=results;cp.updatedAt=new Date().toISOString();await atomic(CHECKPOINT_PATH,cp);
  const bucketCounts=candidates.reduce((a:AnyObj,x)=>(a[x.bucket]=(a[x.bucket]||0)+1,a),{});
  const run={startedAt,finishedAt:new Date().toISOString(),candidateCount:candidates.length,selectedCount:selected.length,invalidatedForGauntlet:outcomes.filter(x=>x.invalidatedForGauntlet).length,rowsFetched:outcomes.reduce((a,x)=>a+n(x.rowsFetched),0),unfilteredRows:outcomes.reduce((a,x)=>a+n(x.unfilteredRows),0),bucketCounts,selected:outcomes};
  await atomic(QUEUE_PATH,{schemaVersion:2,updatedAt:new Date().toISOString(),policy:{batch:BATCH,swapPages:PAGES,unfilteredFallbackPages:FALLBACK_PAGES,cooldownHours:COOLDOWN_HOURS,sort:"stage-specific evidence-gap queue: near-pass stress > replay reconstruction > history reconstruction > provider retry > context expansion > economics incomplete; rejected wallets re-enter only for evidence/sample gaps, never hard-fast or known-bad economics"},entries:history,runs:[...(Array.isArray(prev.runs)?prev.runs.slice(-79):[]),run],queue:candidates.slice(0,50)});
  console.log(JSON.stringify({event:"shark_scout_deep_dive_reinvestigation_complete",schemaVersion:2,...run,selected:outcomes.map(x=>({address:x.address,priority:x.priority,bucket:x.bucket,previousStatus:x.status,stateStatus:x.stateStatus,coverage:x.coverage,replayTrades:x.replayTrades,replayNet:x.replayNet,stress50:x.stress50,rowsFetched:x.rowsFetched,swapRows:x.swapRows,unfilteredRows:x.unfilteredRows,fetchMode:x.fetchMode,invalidatedForGauntlet:x.invalidatedForGauntlet,error:x.error}))}));
  return run;
}

if(import.meta.url===`file://${process.argv[1]}`)runDeepDiveReinvestigation().catch(e=>{console.error(JSON.stringify({event:"shark_scout_deep_dive_reinvestigation_failed",error:e instanceof Error?e.message:String(e)}));process.exitCode=1;});
