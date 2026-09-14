import { promises as fs } from "node:fs";
import path from "node:path";

const REPORT_PATH=process.env.SCOUT_CANDIDATE_ENGINE_REPORT_PATH||"/data/candidate-engine-report.json";
const STATE_PATH=process.env.SCOUT_CANDIDATE_ENGINE_STATE_PATH||"/data/candidate-engine-state.json";
const SHADOW_DIR=process.env.SCOUT_CANDIDATE_SHADOW_DIR||"/data/candidate-shadow";
const OUT_PATH=process.env.SCOUT_CANDIDATE_ACCELERATOR_PATH||"/data/candidate-decision-accelerator.json";
const STANDARD_HOURS=Math.max(24,Math.min(336,Number(process.env.CANDIDATE_SHADOW_MIN_HOURS||72)));
const STANDARD_CLOSES=Math.max(4,Math.min(30,Number(process.env.CANDIDATE_SHADOW_MIN_CLOSES||7)));
const STANDARD_MINTS=Math.max(2,Math.min(10,Number(process.env.CANDIDATE_SHADOW_MIN_MINTS||3)));
const DORMANT_HOURS=Math.max(12,Math.min(168,Number(process.env.CANDIDATE_SHADOW_DORMANT_HOURS||24)));
const ACTIVE_ROWS_MIN=Math.max(2,Math.min(20,Number(process.env.CANDIDATE_SHADOW_ACTIVE_ROWS_MIN||3)));

type AnyObj=Record<string,any>;
function now(){return new Date().toISOString();}
async function read(file:string,fallback:any){try{return JSON.parse(await fs.readFile(file,"utf8"));}catch{return fallback;}}
async function atomic(file:string,data:any){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;await fs.writeFile(tmp,JSON.stringify(data,null,2));await fs.rename(tmp,file);}
function ts(v:any){const n=Number(v);if(!Number.isFinite(n)||n<=0)return null;return n>1e12?n/1000:n;}
function vitality(rows:any[],startedAt:string|null,asOfSec:number){const start=startedAt?Date.parse(startedAt)/1000:0;const selected=(Array.isArray(rows)?rows:[]).filter(r=>{const t=ts(r?.timestamp);return t!=null&&t>=start;});const times=selected.map(r=>ts(r?.timestamp)).filter((x):x is number=>x!=null);const last=times.length?Math.max(...times):null;const within=(hours:number)=>selected.filter(r=>{const t=ts(r?.timestamp);return t!=null&&t>=asOfSec-hours*3600;}).length;return{sourceRowsSinceTrial:selected.length,sourceRows6h:within(6),sourceRows24h:within(24),sourceRows72h:within(72),lastSourceSwapAt:last?new Date(last*1000).toISOString():null,hoursSinceLastSourceSwap:last==null?null:Math.max(0,(asOfSec-last)/3600)};}
function decide(row:any,v:any){const shadow=row?.shadow;if(!shadow?.evaluation)return null;const currentStage=String(row?.stage||"");const age=Number(shadow.evaluation.ageHours||0),m=shadow.metrics||{},diag=shadow.monitor?.replayDiagnostics||{};const classified=Number(diag.classified||0),ambiguous=Number(diag.ambiguous||0),denom=Math.max(1,classified+ambiguous),ambiguityRatio=ambiguous/denom;
  if(currentStage==="ODIN_TRIAL_READY"||currentStage==="SHADOW_FAIL")return{lane:currentStage==="ODIN_TRIAL_READY"?"READY":"FAILED",stage:currentStage,decision:shadow.evaluation.decision,reason:shadow.evaluation.reason,ambiguityRatio};
  if(age<STANDARD_HOURS)return{lane:"PREMIUM",stage:currentStage,decision:shadow.evaluation.decision,reason:shadow.evaluation.reason,ambiguityRatio};
  const complete=Number(m.closed||0)>=STANDARD_CLOSES&&Number(m.distinctMints||0)>=STANDARD_MINTS;
  if(complete)return{lane:"PREMIUM",stage:currentStage,decision:shadow.evaluation.decision,reason:shadow.evaluation.reason,ambiguityRatio};
  if(Number(m.closed||0)===0){
    const dormant=v.sourceRows72h===0||(v.hoursSinceLastSourceSwap!=null&&v.hoursSinceLastSourceSwap>=DORMANT_HOURS);
    if(dormant)return{lane:"SLOW_MONITOR",stage:"SHADOW_PARK",decision:"PARK",reason:"source_dormant_after_standard_window",ambiguityRatio};
    if(v.sourceRows72h>=ACTIVE_ROWS_MIN&&(classified===0||ambiguityRatio>=.5))return{lane:"RECONSTRUCTION_PRIORITY",stage:"SHADOW_EXTEND",decision:"EXTEND",reason:"active_source_reconstruction_blocked",ambiguityRatio};
  }
  return{lane:"EXTENDED",stage:"SHADOW_EXTEND",decision:"EXTEND",reason:"forward_sample_incomplete_active_source",ambiguityRatio};
}

async function main(){const generatedAt=now(),asOfSec=Date.now()/1000,[report,state]=await Promise.all([read(REPORT_PATH,{}),read(STATE_PATH,{schemaVersion:2,candidates:{}})]);const candidates=Array.isArray(report?.candidates)?report.candidates:[],changes:any[]=[];for(const row of candidates){const address=String(row?.address||"");if(!address||!row?.shadowStartedAt||!row?.shadow)continue;const ledger=await read(path.join(SHADOW_DIR,`${address}.json`),{rows:[]}),v=vitality(ledger?.rows||[],row.shadowStartedAt,asOfSec),d=decide(row,v);row.shadow.vitality=v;row.shadow.lane=d?.lane||"UNKNOWN";row.shadow.acceleration=d?{decision:d.decision,reason:d.reason,ambiguityRatio:d.ambiguityRatio}:null;if(d&&d.stage!==row.stage){changes.push({address,from:row.stage,to:d.stage,lane:d.lane,reason:d.reason});row.stage=d.stage;if(row.shadow.evaluation){row.shadow.evaluation={...row.shadow.evaluation,stage:d.stage,decision:d.decision,reason:d.reason};}if(state?.candidates?.[address])state.candidates[address].stage=d.stage;}}
  const stages=["ODIN_TRIAL_READY","SHADOW_TRIAL","SHADOW_EXTEND","HISTORICAL_REVIEW","RECONSTRUCT","SHADOW_PARK","SHADOW_FAIL"];report.stageCounts=Object.fromEntries(stages.map(s=>[s,candidates.filter((r:any)=>r.stage===s).length]));report.odinTrialReady=candidates.filter((r:any)=>r.stage==="ODIN_TRIAL_READY");report.shadowActive=candidates.filter((r:any)=>r.stage==="SHADOW_TRIAL"||r.stage==="SHADOW_EXTEND");report.acceleration={generatedAt,standardHours:STANDARD_HOURS,dormantHours:DORMANT_HOURS,activeRowsMin:ACTIVE_ROWS_MIN,changes,premium:candidates.filter((r:any)=>r?.shadow?.lane==="PREMIUM").map((r:any)=>r.address),reconstructionPriority:candidates.filter((r:any)=>r?.shadow?.lane==="RECONSTRUCTION_PRIORITY").map((r:any)=>r.address),slowMonitor:candidates.filter((r:any)=>r?.shadow?.lane==="SLOW_MONITOR").map((r:any)=>r.address)};state.updatedAt=generatedAt;await atomic(REPORT_PATH,report);await atomic(STATE_PATH,state);const out={schemaVersion:1,event:"shark_scout_candidate_decision_accelerator_complete",generatedAt,policy:{standardHours:STANDARD_HOURS,dormantHours:DORMANT_HOURS,activeRowsMin:ACTIVE_ROWS_MIN,capitalMutation:false,odinMutation:false,guardsLowered:false},stageCounts:report.stageCounts,changes,lanes:{premium:report.acceleration.premium,reconstructionPriority:report.acceleration.reconstructionPriority,slowMonitor:report.acceleration.slowMonitor},candidates:candidates.filter((r:any)=>r?.shadow).map((r:any)=>({address:r.address,stage:r.stage,lane:r.shadow?.lane,vitality:r.shadow?.vitality,metrics:r.shadow?.metrics,evaluation:r.shadow?.evaluation,acceleration:r.shadow?.acceleration}))};await atomic(OUT_PATH,out);console.log(JSON.stringify(out));}
main().catch(e=>{console.error(JSON.stringify({event:"shark_scout_candidate_decision_accelerator_failed",error:e instanceof Error?e.message:String(e)}));process.exitCode=1;});
