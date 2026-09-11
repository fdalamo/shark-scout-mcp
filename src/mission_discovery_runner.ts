import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const REAL_OUT=process.env.SCOUT_OUTCOME_MINER_PATH||"/data/outcome-miner-v2.json";
const TMP_OUT="/data/outcome-miner-hourly-tmp.json";
const REPORT="/data/mission-discovery-run.json";
const PIPELINE_TRUTH=process.env.SCOUT_PIPELINE_TRUTH_PATH||"/data/pipeline-truth.json";
const HARVEST_REPORT=process.env.SCOUT_REPORT_PATH||"/data/latest-harvest.json";
const SCOUT_STATE=process.env.SCOUT_STATE_PATH||"/data/shark-state.json";
const CORE_FRESH_MS=15*60_000;

type RunStatus="SUCCESS"|"FAILED"|"TIMED_OUT"|"SKIPPED_CORE_SUCCESS"|"SKIPPED_FRESH_DISCOVERY";
type RunResult={label:string;status:RunStatus;exitCode:number|null;runtimeMs:number};
function now(){return new Date().toISOString();}
async function json(file:string,fallback:any){try{return JSON.parse(await fs.readFile(file,"utf8"));}catch{return fallback;}}
async function atomic(file:string,data:any){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;await fs.writeFile(tmp,JSON.stringify(data,null,2));await fs.rename(tmp,file);}
function emit(event:string,extra:Record<string,unknown>={}){console.log(JSON.stringify({event,at:now(),...extra}));}

function freshCoreResult(truth:any,stage:string){
  const finished=Date.parse(String(truth?.finishedAt||""));
  if(!Number.isFinite(finished)||Date.now()-finished>CORE_FRESH_MS)return null;
  const rows=Array.isArray(truth?.stageResults)?truth.stageResults:[];
  const hit=rows.find((x:any)=>x?.name===stage);
  return hit||null;
}

async function run(label:string,script:string,timeoutMs:number,env:Record<string,string>={}):Promise<RunResult>{
  const started=Date.now();
  emit("shark_scout_mission_discovery_stage_started",{label,script,timeoutMs});
  return await new Promise(resolve=>{
    let done=false,timedOut=false;
    const child=spawn(process.execPath,[script],{stdio:"inherit",env:{...process.env,...env}});
    const finish=(status:RunStatus,exitCode:number|null)=>{if(done)return;done=true;clearTimeout(timer);const result={label,status,exitCode,runtimeMs:Date.now()-started};emit("shark_scout_mission_discovery_stage_finished",result);resolve(result);};
    const timer=setTimeout(()=>{timedOut=true;emit("shark_scout_mission_discovery_stage_timeout",{label,runtimeMs:Date.now()-started});try{child.kill("SIGTERM");}catch{}setTimeout(()=>{if(child.exitCode===null)try{child.kill("SIGKILL");}catch{}},4000).unref();},timeoutMs);
    child.once("error",()=>finish("FAILED",1));
    child.once("close",code=>finish(timedOut?"TIMED_OUT":code===0?"SUCCESS":"FAILED",code));
  });
}

async function mergeOutcomeTmp(){
  const real=await json(REAL_OUT,{runs:[]}),tmp=await json(TMP_OUT,{runs:[]});
  const fresh=tmp?.last||((Array.isArray(tmp?.runs)&&tmp.runs.length)?tmp.runs[tmp.runs.length-1]:null);
  if(!fresh)return {merged:false,reason:"NO_FRESH_REPORT"};
  const runs=[...(Array.isArray(real?.runs)?real.runs:[]),fresh].slice(-60);
  await atomic(REAL_OUT,{...real,runs,last:fresh});
  return {merged:true,finishedAt:fresh.finishedAt||null,newWallets:fresh.newWallets??null,walletsAdmitted:fresh.walletsAdmitted??null,poolsSucceeded:fresh.poolsSucceeded??null};
}

function stamp(x:any){return String(x?.telemetry?.finishedAt||x?.finishedAt||x?.updatedAt||"")||null;}

async function main(){
  const startedAt=now(),truth=await json(PIPELINE_TRUTH,{});
  const coreOutcome=freshCoreResult(truth,"outcome_miner_v2"),coreHarvest=freshCoreResult(truth,"harvest_scout");

  let outcome:RunResult,outcomeMerge:any;
  if(coreOutcome?.status==="SUCCESS"){
    outcome={label:"outcome_miner_hourly",status:"SKIPPED_CORE_SUCCESS",exitCode:0,runtimeMs:0};
    outcomeMerge={merged:false,reason:"CORE_ALREADY_SUCCEEDED"};
    emit("shark_scout_mission_discovery_stage_skipped",{label:outcome.label,reason:"CORE_ALREADY_SUCCEEDED",coreDurationMs:coreOutcome.durationMs??null});
  }else{
    await atomic(TMP_OUT,{runs:[]});
    outcome=await run("outcome_miner_hourly","dist/outcome_miner_v2.js",105_000,{
      SCOUT_OUTCOME_MINER_PATH:TMP_OUT,
      OUTCOME_MINER_MAX_POOLS:"6",
      OUTCOME_MINER_ANCHOR_POOLS:"2",
      OUTCOME_MINER_MAX_RATE_LIMITS:"1",
      GECKOTERMINAL_MIN_INTERVAL_MS:"7000",
      REQUEST_TIMEOUT_MS:"10000"
    });
    outcomeMerge=outcome.status==="SUCCESS"?await mergeOutcomeTmp():{merged:false,reason:outcome.status};
  }

  const outcomeUseful=outcome.status==="SUCCESS"||outcome.status==="SKIPPED_CORE_SUCCESS";
  const freshOutcomeAdded=outcome.status==="SUCCESS"&&Boolean(outcomeMerge?.merged)&&(Number(outcomeMerge?.newWallets||0)>0||Number(outcomeMerge?.walletsAdmitted||0)>0);

  let harvest:RunResult;
  let harvestProgress:any={reportAdvanced:false,stateAdvanced:false};
  if(coreHarvest?.status==="SUCCESS"){
    harvest={label:"harvest_scout_hourly",status:"SKIPPED_CORE_SUCCESS",exitCode:0,runtimeMs:0};
    emit("shark_scout_mission_discovery_stage_skipped",{label:harvest.label,reason:"CORE_ALREADY_SUCCEEDED",coreDurationMs:coreHarvest.durationMs??null});
  }else if(coreHarvest?.status==="SKIPPED_EVENT"&&freshOutcomeAdded){
    harvest={label:"harvest_scout_hourly",status:"SKIPPED_FRESH_DISCOVERY",exitCode:0,runtimeMs:0};
    emit("shark_scout_mission_discovery_stage_skipped",{
      label:harvest.label,
      reason:"FRESH_OUTCOME_DISCOVERY_ALREADY_ADVANCED_UNIVERSE",
      coreHarvestStatus:coreHarvest.status,
      newWallets:outcomeMerge?.newWallets??null,
      walletsAdmitted:outcomeMerge?.walletsAdmitted??null,
      note:"Full Harvest remains on its core cadence; hourly recovery is reserved for actual discovery failure/degradation rather than cadence skips."
    });
  }else{
    const beforeReport=await json(HARVEST_REPORT,null),beforeState=await json(SCOUT_STATE,null);
    harvest=await run("harvest_scout_hourly","dist/harvest_scout_fabric.js",70_000,{
      HARVEST_PROFILE_LIMIT:"8",
      HARVEST_TOKEN_LIMIT:"12",
      CIELO_TAG_ENRICH_PER_RUN:"8",
      CIELO_BRIDGE_TOKEN_LIMIT:"2",
      CIELO_BRIDGE_TRADERS_PER_TOKEN:"3",
      REQUEST_TIMEOUT_MS:"8000"
    });
    const afterReport=await json(HARVEST_REPORT,null),afterState=await json(SCOUT_STATE,null);
    harvestProgress={
      reportAdvanced:Boolean(stamp(afterReport)&&stamp(afterReport)!==stamp(beforeReport)),
      reportBefore:stamp(beforeReport),reportAfter:stamp(afterReport),
      stateAdvanced:Boolean(stamp(afterState)&&stamp(afterState)!==stamp(beforeState)),
      stateBefore:stamp(beforeState),stateAfter:stamp(afterState),
      note:"A timed-out recovery is not treated as zero work when persistent report/state advanced."
    };
    emit("shark_scout_mission_discovery_harvest_progress",harvestProgress);
  }

  const harvestUseful=harvest.status==="SUCCESS"||harvest.status==="SKIPPED_CORE_SUCCESS"||harvest.status==="SKIPPED_FRESH_DISCOVERY"||Boolean(harvestProgress.reportAdvanced)||Boolean(harvestProgress.stateAdvanced);
  const report={schemaVersion:4,patch:"0.55.1-package3-hotfix",startedAt,finishedAt:now(),core:{finishedAt:truth?.finishedAt||null,outcomeStatus:coreOutcome?.status||null,harvestStatus:coreHarvest?.status||null},outcome,outcomeMerge,harvest,harvestProgress,status:(outcomeUseful||harvestUseful)?"DISCOVERY_EXECUTED_OR_CONFIRMED":"DISCOVERY_DEGRADED"};
  await atomic(REPORT,report);
  emit("shark_scout_mission_discovery_complete",report);
}

main().catch(async e=>{const report={schemaVersion:4,patch:"0.55.1-package3-hotfix",finishedAt:now(),status:"FAILED",error:e instanceof Error?e.message:String(e)};try{await atomic(REPORT,report);}catch{}console.error(JSON.stringify({event:"shark_scout_mission_discovery_failed",...report}));process.exitCode=1;});
