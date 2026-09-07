import { spawn } from "node:child_process";

type Stage={name:string;args:string[];timeoutMs:number;continueOnFailure?:boolean;env?:Record<string,string>};

type StageResult={name:string;status:"SUCCESS"|"FAILED"|"TIMED_OUT";durationMs:number;exitCode:number|null;signal:NodeJS.Signals|null};

const MINUTE=60_000;
const stages:Stage[]=[
  {name:"maintenance",args:["dist/maintenance.js"],timeoutMs:2*MINUTE,continueOnFailure:true},
  {name:"odin_sync",args:["dist/odin_sync.js"],timeoutMs:2*MINUTE,continueOnFailure:true},
  {name:"portfolio_audit",args:["dist/portfolio_audit_v2.js"],timeoutMs:3*MINUTE,continueOnFailure:true},
  {name:"opportunity_audit",args:["dist/mirror_opportunity_audit.js"],timeoutMs:4*MINUTE,continueOnFailure:true},
  {name:"dune_alpha",args:["dist/dune_alpha_runner.js"],timeoutMs:3*MINUTE,continueOnFailure:true},
  {name:"outcome_miner_v2",args:["dist/outcome_miner_v2.js"],timeoutMs:12*MINUTE,continueOnFailure:true},
  {name:"harvest_scout",args:["dist/harvest_scout.js"],timeoutMs:15*MINUTE,continueOnFailure:true},
  {name:"canonical_snapshot_pre",args:["dist/canonical_state_guard.js","snapshot"],timeoutMs:2*MINUTE},
  {name:"deep_dive",args:["dist/deep_dive_reinvestigate.js"],timeoutMs:15*MINUTE,continueOnFailure:true},
  {name:"gauntlet_v6",args:["dist/gauntlet_v6.js"],timeoutMs:15*MINUTE,continueOnFailure:true,env:{VYBE_API_KEY:""}},
  {name:"canonical_restore",args:["dist/canonical_state_guard.js","restore"],timeoutMs:2*MINUTE},
  {name:"replay_shadow",args:["dist/replay_shadow.js"],timeoutMs:8*MINUTE,continueOnFailure:true},
  {name:"canonical_snapshot_post",args:["dist/canonical_state_guard.js","snapshot"],timeoutMs:2*MINUTE},
  {name:"selection_skill",args:["dist/selection_skill.js"],timeoutMs:3*MINUTE,continueOnFailure:true},
  {name:"canonical_overlay",args:["dist/canonical_gauntlet_overlay.js"],timeoutMs:3*MINUTE},
  {name:"paper_odin",args:["dist/paper_odin.js"],timeoutMs:4*MINUTE,continueOnFailure:true},
  {name:"dip_shadow",args:["dist/dip_shadow.js"],timeoutMs:4*MINUTE,continueOnFailure:true},
  {name:"odin_cap_audit",args:["dist/odin_cap_audit.js"],timeoutMs:3*MINUTE,continueOnFailure:true},
  {name:"cielo_validate",args:["dist/cielo_validate.js"],timeoutMs:3*MINUTE,continueOnFailure:true},
  {name:"evidence_funnel",args:["dist/evidence_funnel.js"],timeoutMs:3*MINUTE},
  {name:"engine_intelligence",args:["dist/engine_intelligence.js"],timeoutMs:3*MINUTE}
];

function log(event:string,extra:Record<string,unknown>={}){
  console.log(JSON.stringify({level:"info",event,at:new Date().toISOString(),...extra}));
}

async function runStage(stage:Stage):Promise<StageResult>{
  const started=Date.now();
  log("shark_scout_stage_started",{stage:stage.name,timeoutMs:stage.timeoutMs});
  return await new Promise<StageResult>((resolve)=>{
    let timedOut=false;
    const child=spawn(process.execPath,stage.args,{stdio:"inherit",env:{...process.env,...stage.env}});
    const timer=setTimeout(()=>{
      timedOut=true;
      log("shark_scout_stage_timeout",{stage:stage.name,elapsedMs:Date.now()-started});
      child.kill("SIGTERM");
      setTimeout(()=>{if(child.exitCode===null)child.kill("SIGKILL");},5000).unref();
    },stage.timeoutMs);
    timer.unref();
    child.on("error",()=>{
      clearTimeout(timer);
      resolve({name:stage.name,status:timedOut?"TIMED_OUT":"FAILED",durationMs:Date.now()-started,exitCode:null,signal:null});
    });
    child.on("exit",(code,signal)=>{
      clearTimeout(timer);
      const status=timedOut?"TIMED_OUT":code===0?"SUCCESS":"FAILED";
      resolve({name:stage.name,status,durationMs:Date.now()-started,exitCode:code,signal});
    });
  });
}

async function main(){
  const startedAt=new Date().toISOString();
  const results:StageResult[]=[];
  log("shark_scout_pipeline_started",{version:1,stageCount:stages.length});
  for(const stage of stages){
    const result=await runStage(stage);
    results.push(result);
    log("shark_scout_stage_finished",result);
    if(result.status!=="SUCCESS"&&!stage.continueOnFailure){
      log("shark_scout_pipeline_aborted",{stage:stage.name,result,startedAt});
      process.exitCode=1;
      return;
    }
  }
  const failed=results.filter(x=>x.status!=="SUCCESS");
  log("shark_scout_pipeline_complete",{startedAt,finishedAt:new Date().toISOString(),stageCount:results.length,failedCount:failed.length,failedStages:failed});
  if(failed.length)process.exitCode=2;
}

main().catch((e)=>{console.error(JSON.stringify({level:"error",event:"shark_scout_pipeline_fatal",at:new Date().toISOString(),error:String(e)}));process.exitCode=1;});
