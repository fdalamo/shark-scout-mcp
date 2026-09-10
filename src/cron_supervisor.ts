import { ChildProcess, spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const MINUTE=60_000;
const HARD_DEADLINE_MS=Math.min(30*MINUTE,Math.max(20*MINUTE,Number(process.env.SCOUT_CRON_HARD_DEADLINE_MS||25*MINUTE)));
const TERM_GRACE_MS=Math.max(2_000,Math.min(10_000,Number(process.env.SCOUT_CRON_SUPERVISOR_TERM_GRACE_MS||5_000)));
const PATCH="0.52.5-lifecycle-diagnostic";
const POSIX=process.platform!=="win32";
const STATE_PATH=process.env.SCOUT_CRON_SUPERVISOR_STATE_PATH||"/data/cron-supervisor-state.json";
const DIAGNOSTIC_PATH=process.env.SCOUT_CRON_LIFECYCLE_DIAGNOSTIC_PATH||"/data/cron-lifecycle-diagnostic.json";

let child:ChildProcess|null=null;
let finishing=false;
let hardDeadline:NodeJS.Timeout|undefined;
let startupSnapshot:Record<string,unknown>|null=null;

function emit(event:string,extra:Record<string,unknown>={}){
  console.log(JSON.stringify({event,patch:PATCH,supervisorPid:process.pid,at:new Date().toISOString(),...extra}));
}

function persistState(state:Record<string,unknown>){
  try{
    mkdirSync(path.dirname(STATE_PATH),{recursive:true});
    writeFileSync(STATE_PATH,JSON.stringify({patch:PATCH,supervisorPid:process.pid,at:new Date().toISOString(),...state}));
  }catch{}
}

function procText(pid:number,file:string){
  try{return readFileSync(`/proc/${pid}/${file}`,"utf8").replace(/\0/g," ").trim();}catch{return null;}
}

function procStatus(pid:number){
  const raw=procText(pid,"status");
  if(!raw)return null;
  const wanted=new Set(["Name","State","Pid","PPid","TracerPid","Uid","Gid","FDSize","Threads","NSpid","NSpgid","NSsid"]);
  const out:Record<string,string>={};
  for(const line of raw.split("\n")){
    const i=line.indexOf(":");
    if(i<0)continue;
    const key=line.slice(0,i);
    if(wanted.has(key))out[key]=line.slice(i+1).trim();
  }
  return out;
}

function fdTargets(pid:number){
  try{
    const fds=readdirSync(`/proc/${pid}/fd`).slice(0,64);
    const out:Record<string,string>={};
    for(const fd of fds){
      try{out[fd]=readlinkSync(`/proc/${pid}/fd/${fd}`);}catch{out[fd]="<unreadable>";}
    }
    return out;
  }catch{return null;}
}

function lifecycleSnapshot(label:string,workloadPid:number|null=null){
  const ppid=process.ppid;
  const snap={
    label,
    at:new Date().toISOString(),
    supervisor:{pid:process.pid,ppid,argv:process.argv,execPath:process.execPath,status:procStatus(process.pid),cmdline:procText(process.pid,"cmdline"),fds:fdTargets(process.pid)},
    parent:{pid:ppid,status:procStatus(ppid),cmdline:procText(ppid,"cmdline"),fds:fdTargets(ppid)},
    pid1:{status:procStatus(1),cmdline:procText(1,"cmdline"),fds:fdTargets(1)},
    workloadPid,
    workload:workloadPid?{status:procStatus(workloadPid),cmdline:procText(workloadPid,"cmdline"),fds:fdTargets(workloadPid)}:null
  };
  try{
    mkdirSync(path.dirname(DIAGNOSTIC_PATH),{recursive:true});
    writeFileSync(DIAGNOSTIC_PATH,JSON.stringify({patch:PATCH,startup:startupSnapshot,latest:snap},null,2));
  }catch{}
  return snap;
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
  const preExit=lifecycleSnapshot("pre_exit",pid??null);
  persistState({event:"supervisor_exiting",reason,exitCode,workloadPid:pid??null,...cleanup,lifecycleDiagnosticPath:DIAGNOSTIC_PATH});
  emit("shark_scout_cron_supervisor_lifecycle",{reason,exitCode,parentPid:process.ppid,pid1Cmdline:(preExit as any).pid1?.cmdline,parentCmdline:(preExit as any).parent?.cmdline,lifecycleDiagnosticPath:DIAGNOSTIC_PATH});
  emit("shark_scout_cron_supervisor_exiting",{reason,exitCode,workloadPid:pid??null,...cleanup});
  process.exit(exitCode);
}

function main(){
  startupSnapshot=lifecycleSnapshot("startup",null);
  emit("shark_scout_cron_supervisor_lifecycle",{phase:"startup",parentPid:process.ppid,pid1Cmdline:(startupSnapshot as any).pid1?.cmdline,parentCmdline:(startupSnapshot as any).parent?.cmdline,lifecycleDiagnosticPath:DIAGNOSTIC_PATH});

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

  persistState({event:"supervisor_started",workloadPid:pid,hardDeadlineMs:HARD_DEADLINE_MS,termGraceMs:TERM_GRACE_MS,logGuard:true,lifecycleDiagnosticPath:DIAGNOSTIC_PATH});
  emit("shark_scout_cron_supervisor_started",{workloadPid:pid,hardDeadlineMs:HARD_DEADLINE_MS,termGraceMs:TERM_GRACE_MS,processGroupRoot:POSIX?pid:null,nestedProcessGroupsDisabled:true,logGuard:true,maxLogWriteBytes:Number(process.env.SCOUT_MAX_LOG_WRITE_BYTES||32768)});

  hardDeadline=setTimeout(()=>{
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
