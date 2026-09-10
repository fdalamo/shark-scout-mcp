import { ChildProcess, spawn } from "node:child_process";

const MINUTE=60_000;
const HARD_DEADLINE_MS=Math.min(30*MINUTE,Math.max(20*MINUTE,Number(process.env.SCOUT_CRON_HARD_DEADLINE_MS||25*MINUTE)));
const TERM_GRACE_MS=Math.max(2_000,Math.min(10_000,Number(process.env.SCOUT_CRON_SUPERVISOR_TERM_GRACE_MS||5_000)));
const PATCH="0.52.3-external-cron-supervisor";
const POSIX=process.platform!=="win32";

let child:ChildProcess|null=null;
let finishing=false;
let hardDeadline:NodeJS.Timeout|undefined;

function emit(event:string,extra:Record<string,unknown>={}){
  console.log(JSON.stringify({event,patch:PATCH,supervisorPid:process.pid,at:new Date().toISOString(),...extra}));
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

async function reapProcessGroup(pid:number,reason:string){
  const termSent=signalGroup(pid,"SIGTERM");
  emit("shark_scout_cron_supervisor_term_sent",{reason,workloadPid:pid,termSent,graceMs:TERM_GRACE_MS});
  const until=Date.now()+TERM_GRACE_MS;
  while(Date.now()<until){if(!groupAlive(pid))return {termSent,killSent:false};await sleep(100);}
  const killSent=signalGroup(pid,"SIGKILL");
  emit("shark_scout_cron_supervisor_kill_sent",{reason,workloadPid:pid,killSent});
  const killUntil=Date.now()+1_500;
  while(Date.now()<killUntil){if(!groupAlive(pid))break;await sleep(100);}
  return {termSent,killSent};
}

async function finish(reason:string,exitCode:number){
  if(finishing)return;
  finishing=true;
  if(hardDeadline)clearTimeout(hardDeadline);
  const pid=child?.pid;
  let cleanup={termSent:false,killSent:false};
  if(pid)cleanup=await reapProcessGroup(pid,reason);
  emit("shark_scout_cron_supervisor_exiting",{reason,exitCode,workloadPid:pid??null,...cleanup});
  process.exit(exitCode);
}

function main(){
  const env={...process.env,SCOUT_NESTED_PROCESS_GROUPS:"0"};
  child=spawn(process.execPath,["dist/v051_runner.js"],{
    stdio:"inherit",
    env,
    detached:POSIX
  });
  const pid=child.pid;
  if(!pid){emit("shark_scout_cron_supervisor_spawn_failed",{reason:"missing_child_pid"});process.exit(1);return;}

  emit("shark_scout_cron_supervisor_started",{workloadPid:pid,hardDeadlineMs:HARD_DEADLINE_MS,termGraceMs:TERM_GRACE_MS,processGroupRoot:POSIX?pid:null,nestedProcessGroupsDisabled:true});

  hardDeadline=setTimeout(()=>{
    emit("shark_scout_cron_supervisor_deadline_fired",{workloadPid:pid,hardDeadlineMs:HARD_DEADLINE_MS});
    void finish("hard_deadline",124);
  },HARD_DEADLINE_MS);

  child.once("error",error=>{
    emit("shark_scout_cron_supervisor_child_error",{workloadPid:pid,error:error.message});
    void finish("child_error",1);
  });

  child.once("close",(code,signal)=>{
    const exitCode=code??(signal?128:1);
    emit("shark_scout_cron_supervisor_child_closed",{workloadPid:pid,childExitCode:code,childSignal:signal,derivedExitCode:exitCode});
    // Even after the runner closes, reap its process group. This prevents a leaked
    // descendant from keeping Railway's cron execution Active.
    void finish("child_closed",exitCode);
  });

  process.once("SIGTERM",()=>{emit("shark_scout_cron_supervisor_external_signal",{signal:"SIGTERM",workloadPid:pid});void finish("external_SIGTERM",143);});
  process.once("SIGINT",()=>{emit("shark_scout_cron_supervisor_external_signal",{signal:"SIGINT",workloadPid:pid});void finish("external_SIGINT",130);});
}

main();
