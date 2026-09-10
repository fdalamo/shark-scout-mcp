import { ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { buildLiveEdgeController } from "./live_edge_controller.js";
import { buildFollowerPolicyLedger } from "./follower_policy_ledger.js";
import { buildOpportunityDebt } from "./opportunity_debt.js";
import { buildHourlyIntelligenceReport } from "./hourly_intelligence_report.js";
import { spawnProcessTree, terminateProcessTree } from "./process_supervisor.js";

const MINUTE=60_000;
const QUOTA_PATH=process.env.SCOUT_QUOTA_SHIELD_PATH||"/data/quota-shield-summary.json";
const CRON_INTEGRITY_PATH=process.env.SCOUT_CRON_INTEGRITY_PATH||"/data/cron-integrity-state.json";
const CRON_WATCHDOG_MS=Math.min(30*MINUTE,Math.max(20*MINUTE,Number(process.env.SCOUT_CRON_WATCHDOG_MS||25*MINUTE)));
const PROVIDER_SMOKE_BUDGET_MS=Math.min(120_000,Math.max(30_000,Number(process.env.SCOUT_PROVIDER_SMOKE_BUDGET_MS||90_000)));
const MISSED_TICK_THRESHOLD_MS=90*MINUTE;
const PROCESS_KILL_GRACE_MS=Math.max(1_000,Math.min(8_000,Number(process.env.SCOUT_PROCESS_KILL_GRACE_MS||4_000)));

let activeProcess:ChildProcess|null=null;
let activeProcessLabel:string|null=null;
let externalShutdownStarted=false;

type QuotaPressure={total:number;http429:number;maxUsage:number;rateLimit:number;computeOrRps:number;samples:string[];};
type CronIntegrityState={schema:number;lastRunId?:string;lastRunStartedAt?:string;lastRunFinishedAt?:string;lastSuccessfulReportAt?:string;lastExitCode?:number;lastOutcome?:"RUN_COMPLETED"|"RUN_TIMED_OUT"|"RUN_FAILED";previousTickMissed?:boolean;runtimeMs?:number;};

async function atomic(file:string,data:any){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;await fs.writeFile(tmp,JSON.stringify(data,null,2));await fs.rename(tmp,file);}
async function readJson<T>(file:string):Promise<T|null>{try{return JSON.parse(await fs.readFile(file,"utf8")) as T;}catch{return null;}}
function clampNumber(value:string|undefined,fallback:number,min:number,max:number){const n=Number(value);return String(Math.max(min,Math.min(max,Number.isFinite(n)?n:fallback)));}

function envWithLeanGuardrails(){
  const env={...process.env};
  env.HARVEST_PIPELINE_BUDGET_MS=clampNumber(env.HARVEST_PIPELINE_BUDGET_MS,20*MINUTE,16*MINUTE,20*MINUTE);
  env.HARVEST_FINALIZE_RESERVE_MS=clampNumber(env.HARVEST_FINALIZE_RESERVE_MS,8*MINUTE,7*MINUTE,9*MINUTE);
  env.HARVEST_DISCOVERY_BUDGET_MS=clampNumber(env.HARVEST_DISCOVERY_BUDGET_MS,4*MINUTE,2*MINUTE,4*MINUTE);
  env.HARVEST_CANONICAL_RESEARCH_BUDGET_MS=clampNumber(env.HARVEST_CANONICAL_RESEARCH_BUDGET_MS,5*MINUTE,3*MINUTE,5*MINUTE);
  env.HARVEST_DISCOVERY_CADENCE_HOURS=clampNumber(env.HARVEST_DISCOVERY_CADENCE_HOURS,4,2,6);
  env.REQUEST_TIMEOUT_MS=clampNumber(env.REQUEST_TIMEOUT_MS,15_000,8_000,20_000);
  env.HARVEST_PROFILE_LIMIT=clampNumber(env.HARVEST_PROFILE_LIMIT,20,8,24);
  env.HARVEST_TOKEN_LIMIT=clampNumber(env.HARVEST_TOKEN_LIMIT,30,10,35);
  env.CIELO_TAG_ENRICH_PER_RUN=clampNumber(env.CIELO_TAG_ENRICH_PER_RUN,20,0,25);
  env.CIELO_BRIDGE_TOKEN_LIMIT=clampNumber(env.CIELO_BRIDGE_TOKEN_LIMIT,3,0,4);
  env.CIELO_BRIDGE_TRADERS_PER_TOKEN=clampNumber(env.CIELO_BRIDGE_TRADERS_PER_TOKEN,3,1,4);
  env.DEEP_DIVE_BATCH=clampNumber(env.DEEP_DIVE_BATCH,1,1,1);
  env.DEEP_DIVE_HELIUS_PAGES=clampNumber(env.DEEP_DIVE_HELIUS_PAGES,6,4,8);
  env.DEEP_DIVE_MAX_PAGES=clampNumber(env.DEEP_DIVE_MAX_PAGES,10,6,12);
  env.DEEP_DIVE_UNFILTERED_PAGES=clampNumber(env.DEEP_DIVE_UNFILTERED_PAGES,2,1,3);
  env.CANONICAL_PROGRESSIVE_MAX_WALLETS=clampNumber(env.CANONICAL_PROGRESSIVE_MAX_WALLETS,4,2,4);
  env.CANONICAL_PROGRESSIVE_MAX_PROVIDER_CALLS=clampNumber(env.CANONICAL_PROGRESSIVE_MAX_PROVIDER_CALLS,120,60,120);
  env.CANONICAL_PROGRESSIVE_MAX_PROVIDER_CALLS_PER_WALLET=clampNumber(env.CANONICAL_PROGRESSIVE_MAX_PROVIDER_CALLS_PER_WALLET,28,16,28);
  env.CANONICAL_PROGRESSIVE_MAX_TX_PER_WALLET=clampNumber(env.CANONICAL_PROGRESSIVE_MAX_TX_PER_WALLET,24,12,24);
  env.CANONICAL_RESCUE_MAX_CALLS=clampNumber(env.CANONICAL_RESCUE_MAX_CALLS,16,8,16);
  return env;
}

async function refreshTruthSurface(phase:"pre"|"post"){
  try{await buildFollowerPolicyLedger();}catch(e){console.log(JSON.stringify({event:`shark_scout_follower_policy_${phase}_degraded`,error:e instanceof Error?e.message:String(e)}));}
  try{await buildLiveEdgeController();}catch(e){console.log(JSON.stringify({event:`shark_scout_live_edge_${phase}_degraded`,error:e instanceof Error?e.message:String(e)}));}
  try{await buildOpportunityDebt();}catch(e){console.log(JSON.stringify({event:`shark_scout_opportunity_debt_${phase}_degraded`,error:e instanceof Error?e.message:String(e)}));}
}

function inspectQuota(text:string,q:QuotaPressure){
  const normalized=text.toLowerCase();let matched=false;
  if(/(^|\D)429(\D|$)/.test(normalized)){q.http429++;matched=true;}
  if(normalized.includes("max usage reached")){q.maxUsage++;matched=true;}
  if(normalized.includes("rate limit")||normalized.includes("ratelimit")){q.rateLimit++;matched=true;}
  if(normalized.includes("compute unit")||normalized.includes("cu limit")||normalized.includes("rps limit")||normalized.includes("too many requests")){q.computeOrRps++;matched=true;}
  if(matched){q.total++;if(q.samples.length<8){const sample=text.replace(/\s+/g," ").trim().slice(0,240);if(sample&&!q.samples.includes(sample))q.samples.push(sample);}}
}
function teeAndInspect(chunk:any,target:NodeJS.WriteStream,q?:QuotaPressure){const text=Buffer.isBuffer(chunk)?chunk.toString("utf8"):String(chunk);target.write(chunk);if(q)for(const line of text.split(/\r?\n/))if(line)inspectQuota(line,q);}

async function stopActiveProcess(reason:string){
  const child=activeProcess;const label=activeProcessLabel;
  if(!child||child.exitCode!==null)return {termSent:false,killSent:false};
  console.error(JSON.stringify({event:"shark_scout_child_cleanup_started",reason,label,pid:child.pid,graceMs:PROCESS_KILL_GRACE_MS,at:new Date().toISOString()}));
  const result=await terminateProcessTree(child,PROCESS_KILL_GRACE_MS);
  console.error(JSON.stringify({event:"shark_scout_child_cleanup_finished",reason,label,pid:child.pid,...result,exitCode:child.exitCode,signalCode:child.signalCode,at:new Date().toISOString()}));
  return result;
}

async function runTrackedScript(label:string,script:string,env:NodeJS.ProcessEnv,q?:QuotaPressure,localTimeoutMs=0){
  const started=Date.now();
  return await new Promise<number>((resolve,reject)=>{
    const child=spawnProcessTree(process.execPath,[script],{stdio:["ignore","pipe","pipe"],env});
    activeProcess=child;activeProcessLabel=label;let localTimedOut=false;let timer:NodeJS.Timeout|undefined;
    console.log(JSON.stringify({event:"shark_scout_child_process_started",label,pid:child.pid,detached:process.platform!=="win32",localTimeoutMs,at:new Date().toISOString()}));
    child.stdout?.on("data",chunk=>teeAndInspect(chunk,process.stdout,q));child.stderr?.on("data",chunk=>teeAndInspect(chunk,process.stderr,q));
    if(localTimeoutMs>0)timer=setTimeout(()=>{if(child.exitCode!==null)return;localTimedOut=true;console.error(JSON.stringify({event:"shark_scout_child_timeout",label,pid:child.pid,localTimeoutMs,runtimeMs:Date.now()-started,at:new Date().toISOString()}));void terminateProcessTree(child,PROCESS_KILL_GRACE_MS);},localTimeoutMs);
    child.once("error",e=>{if(timer)clearTimeout(timer);if(activeProcess===child){activeProcess=null;activeProcessLabel=null;}reject(e);});
    child.once("close",exitCode=>{if(timer)clearTimeout(timer);if(activeProcess===child){activeProcess=null;activeProcessLabel=null;}console.log(JSON.stringify({event:"shark_scout_child_process_closed",label,pid:child.pid,exitCode:exitCode??1,signalCode:child.signalCode,localTimedOut,runtimeMs:Date.now()-started,at:new Date().toISOString()}));resolve(localTimedOut?124:(exitCode??1));});
  });
}

async function runProviderSmoke(env:NodeJS.ProcessEnv){
  const code=await runTrackedScript("provider_fabric_smoke","dist/provider_fabric_smoke.js",env,undefined,PROVIDER_SMOKE_BUDGET_MS);
  if(code!==0)console.log(JSON.stringify({event:"shark_scout_provider_smoke_degraded",exitCode:code,budgetMs:PROVIDER_SMOKE_BUDGET_MS,note:"Provider smoke is advisory; harvest continues under the global wall-clock deadline."}));
}

async function runPipeline(){
  const env=envWithLeanGuardrails();
  console.log(JSON.stringify({event:"shark_scout_v051_guardrails",patch:"0.52.2-global-hard-wall-clock",operatingScale:"~1_SOL",principle:"HOT truth first; cheap exploration preserved; expensive work must earn runtime",pipelineBudgetMs:Number(env.HARVEST_PIPELINE_BUDGET_MS),finalizeReserveMs:Number(env.HARVEST_FINALIZE_RESERVE_MS),discoveryBudgetMs:Number(env.HARVEST_DISCOVERY_BUDGET_MS),canonicalResearchBudgetMs:Number(env.HARVEST_CANONICAL_RESEARCH_BUDGET_MS),discoveryCadenceHours:Number(env.HARVEST_DISCOVERY_CADENCE_HOURS),harvestProfileLimit:Number(env.HARVEST_PROFILE_LIMIT),harvestTokenLimit:Number(env.HARVEST_TOKEN_LIMIT),deepDiveBatch:Number(env.DEEP_DIVE_BATCH),progressiveMaxWallets:Number(env.CANONICAL_PROGRESSIVE_MAX_WALLETS),progressiveProviderCalls:Number(env.CANONICAL_PROGRESSIVE_MAX_PROVIDER_CALLS),canonicalRescueMaxCalls:Number(env.CANONICAL_RESCUE_MAX_CALLS),providerSmokeBudgetMs:PROVIDER_SMOKE_BUDGET_MS,opportunityDebt:true,quotaShield:true,hourlyIntelligenceReport:true,cronIntegrityGuard:true,processTreeGuard:true,liveOdinMutation:false}));
  const q:QuotaPressure={total:0,http429:0,maxUsage:0,rateLimit:0,computeOrRps:0,samples:[]};
  const code=await runTrackedScript("harvest_pipeline","dist/harvest_pipeline.js",env,q);
  const summary={event:"shark_scout_quota_shield_summary",generatedAt:new Date().toISOString(),processExitCode:code,semanticHealth:q.total>0?"DEGRADED_PROVIDER_LIMITED":"OK",quotaPressure:q,note:q.total>0?"Process success does not imply data health while provider quota pressure is present.":"No provider quota-pressure signatures observed in pipeline output."};
  await atomic(QUOTA_PATH,summary);console.log(JSON.stringify(summary));return code;
}

async function main(){
  const runId=`${Date.now()}-${process.pid}`;const startedAt=new Date();const previous=await readJson<CronIntegrityState>(CRON_INTEGRITY_PATH);
  const previousStartedMs=previous?.lastRunStartedAt?Date.parse(previous.lastRunStartedAt):NaN;const previousFinishedMs=previous?.lastRunFinishedAt?Date.parse(previous.lastRunFinishedAt):NaN;
  const previousIncomplete=Number.isFinite(previousStartedMs)&&(!Number.isFinite(previousFinishedMs)||previousFinishedMs<previousStartedMs);const missedByGap=Number.isFinite(previousStartedMs)&&(startedAt.getTime()-previousStartedMs)>MISSED_TICK_THRESHOLD_MS;const previousTickMissed=previousIncomplete||missedByGap;
  const startState:CronIntegrityState={...(previous||{schema:1}),schema:1,lastRunId:runId,lastRunStartedAt:startedAt.toISOString(),previousTickMissed};
  await atomic(CRON_INTEGRITY_PATH,startState);
  console.log(JSON.stringify({event:"shark_scout_cron_run_started",runId,startedAt:startedAt.toISOString(),previousTickMissed,previousIncomplete,missedByGap,watchdogMs:CRON_WATCHDOG_MS,providerSmokeBudgetMs:PROVIDER_SMOKE_BUDGET_MS,processTreeGuard:true}));
  if(previousTickMissed)console.log(JSON.stringify({event:"shark_scout_previous_tick_missed",runId,previousLastStartedAt:previous?.lastRunStartedAt||null,previousLastFinishedAt:previous?.lastRunFinishedAt||null}));

  let settled=false;
  const watchdog=setTimeout(async()=>{
    if(settled)return;settled=true;const watchdogAt=Date.now();
    console.error(JSON.stringify({event:"shark_scout_cron_watchdog_fired",runId,runtimeMs:watchdogAt-startedAt.getTime(),watchdogMs:CRON_WATCHDOG_MS,activeProcessLabel,at:new Date(watchdogAt).toISOString()}));
    try{await stopActiveProcess("cron_watchdog");}catch(e){console.error(JSON.stringify({event:"shark_scout_child_cleanup_failed",reason:"cron_watchdog",label:activeProcessLabel,error:e instanceof Error?e.message:String(e)}));}
    const finishedAt=new Date();const timedOut:CronIntegrityState={...startState,lastRunFinishedAt:finishedAt.toISOString(),lastExitCode:124,lastOutcome:"RUN_TIMED_OUT",runtimeMs:finishedAt.getTime()-startedAt.getTime()};
    try{await atomic(CRON_INTEGRITY_PATH,timedOut);}catch{}
    console.error(JSON.stringify({event:"shark_scout_cron_run_finished",runId,outcome:"RUN_TIMED_OUT",exitCode:124,runtimeMs:timedOut.runtimeMs,watchdogMs:CRON_WATCHDOG_MS}));
    console.error(JSON.stringify({event:"shark_scout_process_exiting",runId,exitCode:124,reason:"cron_watchdog",at:new Date().toISOString()}));process.exit(124);
  },CRON_WATCHDOG_MS);

  const externalShutdown=async(signal:NodeJS.Signals)=>{
    if(externalShutdownStarted)return;externalShutdownStarted=true;settled=true;clearTimeout(watchdog);
    console.error(JSON.stringify({event:"shark_scout_external_shutdown_started",runId,signal,activeProcessLabel,at:new Date().toISOString()}));
    try{await stopActiveProcess(`external_${signal}`);}catch{}
    const finishedAt=new Date();try{await atomic(CRON_INTEGRITY_PATH,{...startState,lastRunFinishedAt:finishedAt.toISOString(),lastExitCode:143,lastOutcome:"RUN_FAILED",runtimeMs:finishedAt.getTime()-startedAt.getTime()});}catch{}
    console.error(JSON.stringify({event:"shark_scout_process_exiting",runId,exitCode:143,reason:signal,at:new Date().toISOString()}));process.exit(143);
  };
  process.once("SIGTERM",()=>void externalShutdown("SIGTERM"));process.once("SIGINT",()=>void externalShutdown("SIGINT"));

  let code=1;let reportSucceeded=false;
  try{
    const env=envWithLeanGuardrails();await runProviderSmoke(env);if(settled)return;
    await refreshTruthSurface("pre");if(settled)return;
    code=await runPipeline();if(settled)return;
    await refreshTruthSurface("post");if(settled)return;
    try{await buildHourlyIntelligenceReport();reportSucceeded=true;}catch(e){console.log(JSON.stringify({event:"shark_scout_hourly_intelligence_report_degraded",error:e instanceof Error?e.message:String(e)}));}
  }finally{
    if(!settled){settled=true;clearTimeout(watchdog);const finishedAt=new Date();const outcome:CronIntegrityState["lastOutcome"]=code===0?"RUN_COMPLETED":"RUN_FAILED";const finishState:CronIntegrityState={...startState,lastRunFinishedAt:finishedAt.toISOString(),lastSuccessfulReportAt:reportSucceeded?finishedAt.toISOString():previous?.lastSuccessfulReportAt,lastExitCode:code,lastOutcome:outcome,runtimeMs:finishedAt.getTime()-startedAt.getTime()};await atomic(CRON_INTEGRITY_PATH,finishState);console.log(JSON.stringify({event:"shark_scout_cron_run_finished",runId,outcome,exitCode:code,runtimeMs:finishState.runtimeMs,reportSucceeded,previousTickMissed}));}
  }
  console.log(JSON.stringify({event:"shark_scout_process_exiting",runId,exitCode:code,reason:"normal_completion",at:new Date().toISOString()}));process.exit(code);
}

main().catch(async e=>{
  console.error(JSON.stringify({event:"shark_scout_v051_runner_failed",error:e instanceof Error?e.message:String(e)}));
  try{await stopActiveProcess("top_level_failure");}catch{}
  try{const previous=await readJson<CronIntegrityState>(CRON_INTEGRITY_PATH);await atomic(CRON_INTEGRITY_PATH,{...(previous||{schema:1}),lastRunFinishedAt:new Date().toISOString(),lastExitCode:1,lastOutcome:"RUN_FAILED"});}catch{}
  console.error(JSON.stringify({event:"shark_scout_process_exiting",exitCode:1,reason:"top_level_failure",at:new Date().toISOString()}));process.exit(1);
});
