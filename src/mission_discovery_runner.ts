import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const REAL_OUT=process.env.SCOUT_OUTCOME_MINER_PATH||"/data/outcome-miner-v2.json";
const TMP_OUT="/data/outcome-miner-hourly-tmp.json";
const REPORT="/data/mission-discovery-run.json";

type RunResult={label:string;status:"SUCCESS"|"FAILED"|"TIMED_OUT";exitCode:number|null;runtimeMs:number};
function now(){return new Date().toISOString();}
async function json(file:string,fallback:any){try{return JSON.parse(await fs.readFile(file,"utf8"));}catch{return fallback;}}
async function atomic(file:string,data:any){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;await fs.writeFile(tmp,JSON.stringify(data,null,2));await fs.rename(tmp,file);}
function emit(event:string,extra:Record<string,unknown>={}){console.log(JSON.stringify({event,at:now(),...extra}));}

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
  const startedAt=now();
  // Use an isolated outcome report so the miner's legacy multi-hour poll gate cannot suppress the hourly mission pass.
  // State writes remain authoritative at SCOUT_STATE_PATH; after success we merge only the fresh report back into durable history.
  await atomic(TMP_OUT,{runs:[]});
  const outcome=await run("outcome_miner_hourly","dist/outcome_miner_v2.js",75_000,{
    SCOUT_OUTCOME_MINER_PATH:TMP_OUT,
    OUTCOME_MINER_MAX_POOLS:"6",
    OUTCOME_MINER_ANCHOR_POOLS:"2",
    OUTCOME_MINER_MAX_RATE_LIMITS:"1",
    GECKOTERMINAL_MIN_INTERVAL_MS:"7000",
    REQUEST_TIMEOUT_MS:"12000"
  });
  const outcomeMerge=outcome.status==="SUCCESS"?await mergeOutcomeTmp():{merged:false,reason:outcome.status};

  // Keep a second independent discovery lane alive every hour. It is bounded so discovery cannot consume the run.
  const harvest=await run("harvest_scout_hourly","dist/harvest_scout_fabric.js",90_000,{});

  const report={schemaVersion:1,patch:"0.54.0-discovery-throughput",startedAt,finishedAt:now(),outcome,outcomeMerge,harvest,status:(outcome.status==="SUCCESS"||harvest.status==="SUCCESS")?"DISCOVERY_EXECUTED":"DISCOVERY_DEGRADED"};
  await atomic(REPORT,report);
  emit("shark_scout_mission_discovery_complete",report);
}

main().catch(async e=>{const report={schemaVersion:1,patch:"0.54.0-discovery-throughput",finishedAt:now(),status:"FAILED",error:e instanceof Error?e.message:String(e)};try{await atomic(REPORT,report);}catch{}console.error(JSON.stringify({event:"shark_scout_mission_discovery_failed",...report}));process.exitCode=1;});
