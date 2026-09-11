import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const REAL_OUT=process.env.SCOUT_OUTCOME_MINER_PATH||"/data/outcome-miner-v2.json";
const TMP_OUT="/data/outcome-miner-hourly-tmp.json";
const REPORT="/data/mission-discovery-run.json";
const PIPELINE_TRUTH=process.env.SCOUT_PIPELINE_TRUTH_PATH||"/data/pipeline-truth.json";
const CORE_FRESH_MS=15*60_000;

type RunResult={label:string;status:"SUCCESS"|"FAILED"|"TIMED_OUT"|"SKIPPED_CORE_SUCCESS";exitCode:number|null;runtimeMs:number};
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
    const finish=(status:RunResult["status"],exitCode:number|null)=>{if(done)return;done=true;clearTimeout(timer);const result={label,status,exitCode,runtimeMs:Date.now()-started};emit("shark_scout_mission_discovery_stage_finished",result);resolve(result);};
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

async function main(){
  const startedAt=now(),truth=await json(PIPELINE_TRUTH,{});
  const coreOutcome=freshCoreResult(truth,"outcome_miner_v2"),coreHarvest=freshCoreResult(truth,"harvest_scout");

  let outcome:RunResult,outcomeMerge:any;
  if(coreOutcome?.status==="SUCCESS"){
    outcome={label:"outcome_miner_hourly",status:"SKIPPED_CORE_SUCCESS",exitCode:0,runtimeMs:0};
    outcomeMerge={merged:false,reason:"CORE_ALREADY_SUCCEEDED"};
    emit("shark_scout_mission_discovery_stage_skipped",{label:outcome.label,reason:"CORE_ALREADY_SUCCEEDED",coreDurationMs:coreOutcome.durationMs??null});
  }else{
    // Isolate the hourly report so the miner's legacy multi-hour poll gate cannot suppress a recovery pass.
    // Keep the retry lane bounded; state remains authoritative at SCOUT_STATE_PATH.
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

  let harvest:RunResult;
  if(coreHarvest?.status==="SUCCESS"){
    harvest={label:"harvest_scout_hourly",status:"SKIPPED_CORE_SUCCESS",exitCode:0,runtimeMs:0};
    emit("shark_scout_mission_discovery_stage_skipped",{label:harvest.label,reason:"CORE_ALREADY_SUCCEEDED",coreDurationMs:coreHarvest.durationMs??null});
  }else{
    harvest=await run("harvest_scout_hourly","dist/harvest_scout_fabric.js",90_000,{});
  }

  const outcomeUseful=outcome.status==="SUCCESS"||outcome.status==="SKIPPED_CORE_SUCCESS";
  const harvestUseful=harvest.status==="SUCCESS"||harvest.status==="SKIPPED_CORE_SUCCESS";
  const report={schemaVersion:2,patch:"0.54.1-discovery-dedupe",startedAt,finishedAt:now(),core:{finishedAt:truth?.finishedAt||null,outcomeStatus:coreOutcome?.status||null,harvestStatus:coreHarvest?.status||null},outcome,outcomeMerge,harvest,status:(outcomeUseful||harvestUseful)?"DISCOVERY_EXECUTED_OR_CONFIRMED":"DISCOVERY_DEGRADED"};
  await atomic(REPORT,report);
  emit("shark_scout_mission_discovery_complete",report);
}

main().catch(async e=>{const report={schemaVersion:2,patch:"0.54.1-discovery-dedupe",finishedAt:now(),status:"FAILED",error:e instanceof Error?e.message:String(e)};try{await atomic(REPORT,report);}catch{}console.error(JSON.stringify({event:"shark_scout_mission_discovery_failed",...report}));process.exitCode=1;});
