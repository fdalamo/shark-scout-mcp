import { promises as fs } from "node:fs";
import path from "node:path";

const HELIUS_API_KEY=process.env.HELIUS_API_KEY?.trim();
const STATE_PATH=process.env.SCOUT_STATE_PATH||"./data/shark-state.json";
const CHECKPOINT_PATH=process.env.SCOUT_GAUNTLET_STATE_PATH||"./data/gauntlet-state.json";
const QUEUE_PATH=process.env.SCOUT_DEEP_DIVE_QUEUE_PATH||"./data/deep-dive-queue.json";
const CACHE_DIR=process.env.SCOUT_HELIUS_CACHE_DIR||"./data/helius-cache";
const BATCH=Math.max(1,Math.min(20,Number(process.env.DEEP_DIVE_BATCH||8)));
const PAGES=Math.max(6,Math.min(20,Number(process.env.DEEP_DIVE_HELIUS_PAGES||12)));
const COOLDOWN_HOURS=Math.max(2,Math.min(72,Number(process.env.DEEP_DIVE_COOLDOWN_HOURS||12)));
const MIN_INTERVAL_MS=Math.max(120,Math.min(3000,Number(process.env.DEEP_DIVE_HELIUS_MIN_INTERVAL_MS||350)));
const TIMEOUT_MS=Math.max(3000,Math.min(60000,Number(process.env.REQUEST_TIMEOUT_MS||25000)));

type AnyObj=Record<string,any>;
type QueueEntry={address:string;priority:number;bucket:string;reasons:string[];status:string;stage:string;lastEvaluatedAt:string|null;selectedAt?:string;attempts?:number;lastAttemptAt?:string;rowsFetched?:number;partial?:boolean;error?:string|null};

function n(v:any,d=0){const x=Number(v);return Number.isFinite(x)?x:d;}
function ageHours(iso:any){const t=Date.parse(String(iso||""));return Number.isFinite(t)?(Date.now()-t)/3600000:99999;}
function sleep(ms:number){return new Promise(r=>setTimeout(r,ms));}
async function atomic(file:string,data:any){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;await fs.writeFile(tmp,JSON.stringify(data));await fs.rename(tmp,file);}
async function json(file:string,fallback:any){try{return JSON.parse(await fs.readFile(file,"utf8"));}catch{return fallback;}}

function classify(r:any){
  const status=String(r?.verdict?.status||"UNKNOWN"),stage=String(r?.verdict?.stage||"unknown"),reasons:string[]=Array.isArray(r?.verdict?.reasons)?r.verdict.reasons:[];
  const h=r?.hold||{},rp=r?.replay?.twoPerDay||{},q=r?.dataQuality||{};
  const closed=n(h.closedHolds),trades=n(rp.selected),net=Number(rp.netSol),stress=Number(rp.stress50NetSol),med=n(h.medianHoldSeconds),tokens=n(r.discoveryTokens),coverage=closed>0&&n(h.buyEvents)>0?closed/n(h.buyEvents):0;
  let bucket="LOW_INFORMATION",priority=0;
  if(status==="SIGNAL_ONLY")priority+=220; else if(status==="UNKNOWN")priority+=180; else if(status==="REJECT")priority+=40;
  if(med>=43200)priority+=160; else if(med>=21600)priority+=130; else if(med>=3600)priority+=70; else if(med>0&&med<600)priority-=300;
  priority+=Math.min(120,closed*6)+Math.min(80,tokens*20);
  if(trades>=3)priority+=50;if(Number.isFinite(net)&&net>0)priority+=120;if(Number.isFinite(stress)&&stress>0)priority+=140;
  if(q.score!=null)priority+=Math.round(n(q.score)*80);
  if(r?.heliusCoveragePartial)priority+=90;
  if(r?.heliusError||r?.vybeError)priority+=30;
  if(reasons.some(x=>String(x).includes("single_discovery")))priority+=35;
  if(reasons.some(x=>String(x).includes("history_window_partial")))priority+=100;
  if(reasons.some(x=>String(x).includes("under_10m")))priority-=250;
  if(stage==="fixed_size_economics"&&Number.isFinite(net)&&net<=0)priority-=180;
  if(stage==="robustness"&&r?.robustness?.antiJackpotPass===false)priority-=120;
  if(r?.heliusCoveragePartial||reasons.some(x=>String(x).includes("history_window_partial")))bucket="HISTORY_RECONSTRUCTION";
  else if(status==="UNKNOWN"&&(r?.heliusError||r?.vybeError||stage==="evaluation_error"))bucket="TRANSIENT_DATA";
  else if(status==="SIGNAL_ONLY"&&med>=3600)bucket="ECONOMICS_INCOMPLETE";
  else if(status==="SIGNAL_ONLY"&&med>=600)bucket="HOLD_BORDERLINE";
  else if(status==="UNKNOWN")bucket="INSUFFICIENT_EVIDENCE";
  else if(status==="REJECT"&&priority>100)bucket="REJECT_RECHECK";
  return{priority,bucket,status,stage,reasons,coverage};
}

let nextAt=0;
async function helius(address:string){
  if(!HELIUS_API_KEY)return{rows:[] as any[],partial:true,error:"HELIUS_API_KEY missing"};
  const all:any[]=[],seen=new Set<string>();let before:string|undefined,partial=false,error:string|null=null;
  for(let page=0;page<PAGES;page++){
    const wait=Math.max(0,nextAt-Date.now());if(wait)await sleep(wait);nextAt=Math.max(Date.now(),nextAt)+MIN_INTERVAL_MS;
    const c=new AbortController(),timer=setTimeout(()=>c.abort(),TIMEOUT_MS);
    try{
      const u=new URL(`https://api.helius.xyz/v0/addresses/${address}/transactions`);u.searchParams.set("api-key",HELIUS_API_KEY);u.searchParams.set("limit","100");u.searchParams.set("type","SWAP");if(before)u.searchParams.set("before",before);
      const r=await fetch(u,{signal:c.signal});const text=await r.text();
      if(!r.ok){error=`${r.status}:${text.slice(0,160)}`;partial=true;break;}
      const rows=JSON.parse(text);if(!Array.isArray(rows)||!rows.length)break;
      let added=0;for(const x of rows){const sig=String(x?.signature||"");if(sig&&!seen.has(sig)){seen.add(sig);all.push(x);added++;}}
      before=rows[rows.length-1]?.signature;
      if(rows.length<100||added===0)break;
      if(page===PAGES-1){partial=true;}
    }catch(e){error=e instanceof Error?e.message:String(e);partial=true;break;}finally{clearTimeout(timer);}
  }
  all.sort((a,b)=>n(b?.timestamp)-n(a?.timestamp));
  return{rows:all,partial,error};
}

export async function runDeepDiveReinvestigation(){
  const startedAt=new Date().toISOString(),state=await json(STATE_PATH,{wallets:{}}),cp=await json(CHECKPOINT_PATH,{results:{},runs:[]}),prev=await json(QUEUE_PATH,{entries:{},runs:[]});
  const results:Record<string,any>=cp.results||{},wallets:Record<string,any>=state.wallets||{},history:Record<string,any>=prev.entries||{};
  const candidates:QueueEntry[]=[];
  for(const [address,r] of Object.entries(results)){
    if(!wallets[address]||wallets[address]?.status==="REJECTED")continue;
    const c=classify(r),old=history[address]||{},cooling=old.lastAttemptAt&&ageHours(old.lastAttemptAt)<COOLDOWN_HOURS;
    const eligibleStatus=c.status==="UNKNOWN"||c.status==="SIGNAL_ONLY"||(c.status==="REJECT"&&c.priority>=180);
    if(!eligibleStatus||cooling||c.priority<=0)continue;
    candidates.push({address,priority:c.priority,bucket:c.bucket,reasons:c.reasons,status:c.status,stage:c.stage,lastEvaluatedAt:r?.evaluatedAt||null,attempts:n(old.attempts)});
  }
  candidates.sort((a,b)=>b.priority-a.priority||ageHours(b.lastEvaluatedAt)-ageHours(a.lastEvaluatedAt));
  const selected=candidates.slice(0,BATCH),outcomes:any[]=[];
  for(const item of selected){
    const hx=await helius(item.address),now=new Date().toISOString();
    if(hx.rows.length){await fs.mkdir(CACHE_DIR,{recursive:true});await atomic(path.join(CACHE_DIR,`${item.address}.json`),{generatedAt:now,source:"deep_dive_reinvestigation",pagesRequested:PAGES,partial:hx.partial,rows:hx.rows});delete results[item.address];}
    const record={...item,selectedAt:startedAt,lastAttemptAt:now,attempts:n(item.attempts)+1,rowsFetched:hx.rows.length,partial:hx.partial,error:hx.error||null,invalidatedForGauntlet:hx.rows.length>0};
    history[item.address]=record;outcomes.push(record);
  }
  cp.results=results;cp.updatedAt=new Date().toISOString();await atomic(CHECKPOINT_PATH,cp);
  const bucketCounts=candidates.reduce((a:AnyObj,x)=>(a[x.bucket]=(a[x.bucket]||0)+1,a),{});
  const run={startedAt,finishedAt:new Date().toISOString(),candidateCount:candidates.length,selectedCount:selected.length,invalidatedForGauntlet:outcomes.filter(x=>x.invalidatedForGauntlet).length,rowsFetched:outcomes.reduce((a,x)=>a+n(x.rowsFetched),0),bucketCounts,selected:outcomes};
  await atomic(QUEUE_PATH,{schemaVersion:1,updatedAt:new Date().toISOString(),policy:{batch:BATCH,pages:PAGES,cooldownHours:COOLDOWN_HOURS,sort:"evidence-gap priority; UNKNOWN/SIGNAL_ONLY first; long-hold + positive/stressed replay boosted; hard bad economics/very-fast holds penalized"},entries:history,runs:[...(Array.isArray(prev.runs)?prev.runs.slice(-79):[]),run],queue:candidates.slice(0,50)});
  console.log(JSON.stringify({event:"shark_scout_deep_dive_reinvestigation_complete",...run,selected:outcomes.map(x=>({address:x.address,priority:x.priority,bucket:x.bucket,previousStatus:x.status,rowsFetched:x.rowsFetched,invalidatedForGauntlet:x.invalidatedForGauntlet,error:x.error}))}));
  return run;
}

if(import.meta.url===`file://${process.argv[1]}`)runDeepDiveReinvestigation().catch(e=>{console.error(JSON.stringify({event:"shark_scout_deep_dive_reinvestigation_failed",error:e instanceof Error?e.message:String(e)}));process.exitCode=1;});
