import { ChildProcess, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const MINUTE=60_000;
const HARD_DEADLINE_MS=Math.min(30*MINUTE,Math.max(20*MINUTE,Number(process.env.SCOUT_CRON_HARD_DEADLINE_MS||25*MINUTE)));
const TERM_GRACE_MS=Math.max(2_000,Math.min(10_000,Number(process.env.SCOUT_CRON_SUPERVISOR_TERM_GRACE_MS||5_000)));
const PATCH="0.52.4-kill-first-log-guard";
const POSIX=process.platform!=="win32";
const STATE_PATH=process.env.SCOUT_CRON_SUPERVISOR_STATE_PATH||"/data/cron-supervisor-state.json";

let child:ChildProcess|null=null;
let finishing=false;
let hardDeadline:NodeJS.Timeout|undefined;

function emit(event:string,extra:Record<string,unknown>={}){
  console.log(JSON.stringify({event,patch:PATCH,supervisorPid:process.pid,at:new Date().toISOString(),...extra}));
}

function persistState(state:Record<string,unknown>){
  try{
    mkdirSync(path.dirname(STATE_PATH),{recursive:true});
    writeFileSync(STATE_PATH,JSON.stringify({patch:PATCH,supervisorPid:process.pid,at:new Date().toISOString(),...state}));
  }catch{}
}

function groupAlive(pid:number){
  try{
    if(POSIX) process.kill(-pid,0);
    else process.kill(pid,0);
    return true;
  }catch{return false;}
}

function signalGroup(pid:number,signal:NodeJS.Signals){
  try{
    if(POSIX) process.kill(-pid,signal);
    else process.kill(pid,signal);
    return true;
  }catch{
    try{process.kill(pid,signal);return true;}catch{return false;}
  }
}

function sleep(ms:number){return new Promise<void>(resolve=>setTimeout(resolve,ms));}

async function reapProcessGroup(pid:number,reason:string,termAlreadySent=false){
  // Control path is intentionally stdout-independent: signal first, telemetry only after cleanup.
  const termSent=termAlreadySent?true:signalGroup(pid,"SIGTERM");
  persistState({event:"reap_started",reason,workloadPid:pid,termSent,graceMs:TERM_GRACE_MS});
  const until=Date.now()+TERM_GRACE_MS;
  while(Date.now()<until){if(!groupAlive(pid))return {termSent,killSent:false};await sleep(100);}
  const killSent=signalGroup(pid,"SIGKILL");
  persistState({event:"kill_sent",reason,workloadPid:pid,termSent,killSent});
  const killUntil=Date.now()+1_500;
  while(Date.now()<killUntil){if(!groupAlive(pid))break;await sleep(100);}
  return {termSent,killSent};
}

async function finish(reason:string,exitCode:number,termAlreadySent=false){
  if(finishing)return;
  finishing=true;
  if(hardDeadline)clearTimeout(hardDeadline);
  const pid=child?.pid;
  let cleanup={termSent:false,killSent:false};
  if(pid)cleanup=await reapProcessGroup(pid,reason,termAlreadySent);
  persistState({event:"supervisor_exiting",reason,exitCode,workloadPid:pid??null,...cleanup});
  emit("shark_scout_cron_supervisor_exiting",{reason,exitCode,workloadPid:pid??null,...cleanup});
  process.exit(exitCode);
}

function main(){
  const inheritedNodeOptions=String(process.env.NODE_OPTIONS||"").trim();
  const guardImport="--import=./dist/log_guard.js";
  const nodeOptions=inheritedNodeOptions.includes("dist/log_guard.js")?inheritedNodeOptions:`${inheritedNodeOptions} ${guardImport}`.trim();
  const env={...process.env,SCOUT_NESTED_PROCESS_GROUPS:"0",NODE_OPTIONS:nodeOptions};
  child=spawn(process.execPath,["dist/v051_runner.js"],{
    stdio:"inherit",
    env,
    detached:POSIX
  });
  const pid=child.pid;
  if(!pid){persistState({event:"spawn_failed",reason:"missing_child_pid"});emit("shark_scout_cron_supervisor_spawn_failed",{reason:"missing_child_pid"});process.exit(1);return;}

  persistState({event:"supervisor_started",workloadPid:pid,hardDeadlineMs:HARD_DEADLINE_MS,termGraceMs:TERM_GRACE_MS,logGuard:true});
  emit("shark_scout_cron_supervisor_started",{workloadPid:pid,hardDeadlineMs:HARD_DEADLINE_MS,termGraceMs:TERM_GRACE_MS,processGroupRoot:POSIX?pid:null,nestedProcessGroupsDisabled:true,logGuard:true,maxLogWriteBytes:Number(process.env.SCOUT_MAX_LOG_WRITE_BYTES||32768)});

  hardDeadline=setTimeout(()=>{
    // IMPORTANT: kill starts before any stdout/stderr operation. A wedged Railway log sink cannot block termination.
    const termSent=signalGroup(pid,"SIGTERM");
    persistState({event:"hard_deadline_fired",workloadPid:pid,hardDeadlineMs:HARD_DEADLINE_MS,termSent});
    void finish("hard_deadline",124,termSent);
  },HARD_DEADLINE_MS);

  child.once("error",error=>{
    persistState({event:"child_error",workloadPid:pid,error:error.message});
    void finish("child_error",1);
  });

  child.once("close",(code,signal)=>{
    const exitCode=code??(signal?128:1);
    persistState({event:"child_closed",workloadPid:pid,childExitCode:code,childSignal:signal,derivedExitCode:exitCode});
    // Reap the entire workload process group even after the runner closes.
    void finish("child_closed",exitCode);
  });

  process.once("SIGTERM",()=>{
    const termSent=signalGroup(pid,"SIGTERM");
    persistState({event:"external_signal",signal:"SIGTERM",workloadPid:pid,termSent});
    void finish("external_SIGTERM",143,termSent);
  });
  process.once("SIGINT",()=>{
    const termSent=signalGroup(pid,"SIGTERM");
    persistState({event:"external_signal",signal:"SIGINT",workloadPid:pid,termSent});
    void finish("external_SIGINT",130,termSent);
  });
}

main();
