import { ChildProcess, SpawnOptions, spawn } from "node:child_process";

export type SupervisedExit={
  code:number|null;
  signal:NodeJS.Signals|null;
  timedOut:boolean;
  durationMs:number;
};

function isPosix(){return process.platform!=="win32";}

export function signalProcessTree(child:ChildProcess,signal:NodeJS.Signals){
  if(!child.pid||child.exitCode!==null)return false;
  try{
    if(isPosix()) process.kill(-child.pid,signal);
    else child.kill(signal);
    return true;
  }catch{
    try{return child.kill(signal);}
    catch{return false;}
  }
}

export function spawnProcessTree(command:string,args:string[],options:SpawnOptions={}){
  return spawn(command,args,{...options,detached:isPosix()});
}

export async function terminateProcessTree(child:ChildProcess,graceMs=4_000){
  if(child.exitCode!==null)return {termSent:false,killSent:false};
  const termSent=signalProcessTree(child,"SIGTERM");
  const closed=await Promise.race([
    new Promise<boolean>(resolve=>child.once("close",()=>resolve(true))),
    new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),graceMs))
  ]);
  if(closed||child.exitCode!==null)return {termSent,killSent:false};
  const killSent=signalProcessTree(child,"SIGKILL");
  await Promise.race([
    new Promise<void>(resolve=>child.once("close",()=>resolve())),
    new Promise<void>(resolve=>setTimeout(resolve,1_500))
  ]);
  return {termSent,killSent};
}

export async function runSupervised(
  command:string,
  args:string[],
  options:SpawnOptions,
  timeoutMs:number,
  graceMs=4_000,
  onTimeout?:()=>void
):Promise<SupervisedExit>{
  const started=Date.now();
  const child=spawnProcessTree(command,args,options);
  let timedOut=false;
  let timer:NodeJS.Timeout|undefined;
  const exitPromise=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{
    child.once("error",reject);
    child.once("close",(code,signal)=>resolve({code,signal}));
  });
  if(timeoutMs>0){
    timer=setTimeout(()=>{
      timedOut=true;
      onTimeout?.();
      void terminateProcessTree(child,graceMs);
    },timeoutMs);
  }
  try{
    const exit=await exitPromise;
    return {...exit,timedOut,durationMs:Date.now()-started};
  }finally{
    if(timer)clearTimeout(timer);
  }
}
