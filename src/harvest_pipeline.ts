import { spawn } from "node:child_process";

type Phase="MONITOR"|"DISCOVERY"|"CANONICAL"|"FINALIZE";
type Stage={name:string;args:string[];timeoutMs:number;phase:Phase;continueOnFailure?:boolean;env?:Record<string,string>};
type StageResult={name:string;phase:Phase;status:"SUCCESS"|"FAILED"|"TIMED_OUT"|"SKIPPED_BUDGET";durationMs:number;exitCode:number|null;signal:NodeJS.Signals|null};

const MINUTE=60_000;
const PIPELINE_BUDGET_MS=Math.max(20*MINUTE,Math.min(58*MINUTE,Number(process.env.HARVEST_PIPELINE_BUDGET_MS||50*MINUTE)));
const FINALIZE_RESERVE_MS=Math.max(5*MINUTE,Math.min(15*MINUTE,Number(process.env.HARVEST_FINALIZE_RESERVE_MS||8*MINUTE)));

// MONITOR is intentionally first. Live follower truth and prospective labs must not wait on heavy discovery.
const stages:Stage[]=[
  {name:"maintenance",phase:"MONITOR",args:["dist/maintenance.js"],timeoutMs:2*MINUTE,continueOnFailure:true},
  {name:"odin_sync",phase:"MONITOR",args:["dist/odin_sync.js"],timeoutMs:2*MINUTE,continueOnFailure:true},
  {name:"portfolio_audit",phase:"MONITOR",args:["dist/portfolio_audit_v2.js"],timeoutMs:3*MINUTE,continueOnFailure:true},
  {name:"opportunity_audit",phase:"MONITOR",args:["dist/mirror_opportunity_audit.js"],timeoutMs:4*MINUTE,continueOnFailure:true},
  {name:"paper_odin_fast",phase:"MONITOR",args:["dist/paper_odin.js"],timeoutMs:4*MINUTE,continueOnFailure:true},
  {name:"dip_shadow_fast",phase:"MONITOR",args:["dist/dip_shadow.js"],timeoutMs:4*MINUTE,continueOnFailure:true},

  {name:"dune_alpha",phase:"DISCOVERY",args:["dist/dune_alpha_runner.js"],timeoutMs:3*MINUTE,continueOnFailure:true},
  {name:"outcome_miner_v2",phase:"DISCOVERY",args:["dist/outcome_miner_v2.js"],timeoutMs:10*MINUTE,continueOnFailure:true},
  {name:"harvest_scout",phase:"DISCOVERY",args:["dist/harvest_scout_fabric.js"],timeoutMs:12*MINUTE,continueOnFailure:true},

  // Snapshot/restore bracket protects the mutating Deep Dive + Gauntlet work only.
  {name:"canonical_snapshot_pre",phase:"CANONICAL",args:["dist/canonical_state_guard.js","snapshot"],timeoutMs:2*MINUTE},
  {name:"deep_dive",phase:"CANONICAL",args:["dist/deep_dive_reinvestigate.js"],timeoutMs:10*MINUTE,continueOnFailure:true},
  {name:"gauntlet_v6",phase:"CANONICAL",args:["dist/gauntlet_v6.js"],timeoutMs:10*MINUTE,continueOnFailure:true,env:{VYBE_API_KEY:""}},
  {name:"canonical_restore",phase:"CANONICAL",args:["dist/canonical_state_guard.js","restore"],timeoutMs:2*MINUTE},
  {name:"replay_shadow",phase:"CANONICAL",args:["dist/replay_shadow.js"],timeoutMs:6*MINUTE,continueOnFailure:true},
  {name:"canonical_snapshot_post",phase:"CANONICAL",args:["dist/canonical_state_guard.js","snapshot"],timeoutMs:2*MINUTE},
  {name:"selection_skill",phase:"CANONICAL",args:["dist/selection_skill.js"],timeoutMs:3*MINUTE,continueOnFailure:true},
  {name:"canonical_overlay",phase:"CANONICAL",args:["dist/canonical_gauntlet_overlay.js"],timeoutMs:3*MINUTE},

  {name:"paper_odin_refresh",phase:"FINALIZE",args:["dist/paper_odin.js"],timeoutMs:4*MINUTE,continueOnFailure:true},
  {name:"dip_shadow_refresh",phase:"FINALIZE",args:["dist/dip_shadow.js"],timeoutMs:4*MINUTE,continueOnFailure:true},
  {name:"odin_cap_audit",phase:"FINALIZE",args:["dist/odin_cap_audit.js"],timeoutMs:3*MINUTE,continueOnFailure:true},
  {name:"cielo_validate",phase:"FINALIZE",args:["dist/cielo_validate.js"],timeoutMs:3*MINUTE,continueOnFailure:true},
  {name:"evidence_funnel",phase:"FINALIZE",args:["dist/evidence_funnel.js"],timeoutMs:3*MINUTE},
  {name:"engine_intelligence",phase:"FINALIZE",args:["dist/engine_intelligence.js"],timeoutMs:3*MINUTE},
  {name:"external_evidence_overlay",phase:"FINALIZE",args:["dist/external_evidence_overlay.js"],timeoutMs:2*MINUTE}
];

const protectedCanonicalStages=new Set(["deep_dive","gauntlet_v6","canonical_restore"]);

function log(event:string,extra:Record<string,unknown>={}){
  console.log(JSON.stringify({level:"info",event,at:new Date().toISOString(),...extra}));
}

async function runStage(stage:Stage,timeoutMs:number):Promise<StageResult>{
  const started=Date.now();
  log("shark_scout_stage_started",{stage:stage.name,phase:stage.phase,timeoutMs});
  return await new Promise<StageResult>((resolve)=>{
    let timedOut=false,settled=false;
    const finish=(r:StageResult)=>{if(settled)return;settled=true;resolve(r);};
    const child=spawn(process.execPath,stage.args,{stdio:"inherit",env:{...process.env,...stage.env}});
    const timer=setTimeout(()=>{
      timedOut=true;
      log("shark_scout_stage_timeout",{stage:stage.name,phase:stage.phase,elapsedMs:Date.now()-started});
      child.kill("SIGTERM");
      // child.killed only means a signal was sent; exitCode is the reliable liveness check.
      setTimeout(()=>{if(child.exitCode===null)child.kill("SIGKILL");},5000).unref();
    },timeoutMs);
    child.on("error",()=>{
      clearTimeout(timer);
      finish({name:stage.name,phase:stage.phase,status:timedOut?"TIMED_OUT":"FAILED",durationMs:Date.now()-started,exitCode:null,signal:null});
    });
    child.on("exit",(code,signal)=>{
      clearTimeout(timer);
      finish({name:stage.name,phase:stage.phase,status:timedOut?"TIMED_OUT":code===0?"SUCCESS":"FAILED",durationMs:Date.now()-started,exitCode:code,signal});
    });
  });
}

async function main(){
  const pipelineStarted=Date.now(),startedAt=new Date(pipelineStarted).toISOString();
  const deadline=pipelineStarted+PIPELINE_BUDGET_MS;
  const results:StageResult[]=[];
  let lastPhase:Phase|null=null;
  let canonicalSnapshotTaken=false;
  log("shark_scout_pipeline_started",{version:4,stageCount:stages.length,budgetMs:PIPELINE_BUDGET_MS,finalizeReserveMs:FINALIZE_RESERVE_MS});

  const emergencyRestore=async(reason:string)=>{
    if(!canonicalSnapshotTaken)return true;
    log("shark_scout_emergency_restore_started",{reason});
    // Canonical integrity outranks the global runtime budget: always allow a bounded restore attempt.
    const restore=await runStage({name:"canonical_restore_emergency",phase:"FINALIZE",args:["dist/canonical_state_guard.js","restore"],timeoutMs:2*MINUTE},2*MINUTE);
    results.push(restore);log("shark_scout_stage_finished",restore);
    if(restore.status==="SUCCESS"){canonicalSnapshotTaken=false;return true;}
    log("shark_scout_emergency_restore_failed",{reason,restore});
    return false;
  };

  for(const stage of stages){
    if(stage.phase!==lastPhase){lastPhase=stage.phase;log("shark_scout_phase_started",{phase:lastPhase,elapsedMs:Date.now()-pipelineStarted,remainingMs:deadline-Date.now()});}
    const remaining=Math.max(0,deadline-Date.now());

    // Heavy discovery/canonical work is sacrificed before the live monitor/final reporting path.
    if((stage.phase==="DISCOVERY"||stage.phase==="CANONICAL")&&remaining<=FINALIZE_RESERVE_MS){
      const skipped:StageResult={name:stage.name,phase:stage.phase,status:"SKIPPED_BUDGET",durationMs:0,exitCode:null,signal:null};
      results.push(skipped);log("shark_scout_stage_finished",skipped);continue;
    }
    // Never start a new canonical mutation bracket unless there is enough room to restore it.
    if(stage.name==="canonical_snapshot_pre"&&remaining<=FINALIZE_RESERVE_MS+6*MINUTE){
      const skipped:StageResult={name:stage.name,phase:stage.phase,status:"SKIPPED_BUDGET",durationMs:0,exitCode:null,signal:null};
      results.push(skipped);log("shark_scout_stage_finished",skipped);continue;
    }
    // Only the mutating snapshot-protected stages require the pre-snapshot to remain open.
    // Replay/selection/overlay run after restore by design and must not be suppressed here.
    if(protectedCanonicalStages.has(stage.name)&&!canonicalSnapshotTaken){
      const skipped:StageResult={name:stage.name,phase:stage.phase,status:"SKIPPED_BUDGET",durationMs:0,exitCode:null,signal:null};
      results.push(skipped);log("shark_scout_stage_finished",skipped);continue;
    }

    const reserved=stage.phase==="FINALIZE"?0:FINALIZE_RESERVE_MS;
    const allowed=Math.max(1_000,Math.min(stage.timeoutMs,deadline-Date.now()-reserved));
    const result=await runStage(stage,allowed);
    results.push(result);log("shark_scout_stage_finished",result);
    if(stage.name==="canonical_snapshot_pre"&&result.status==="SUCCESS")canonicalSnapshotTaken=true;
    if(stage.name==="canonical_restore"&&result.status==="SUCCESS")canonicalSnapshotTaken=false;

    if(result.status!=="SUCCESS"&&!stage.continueOnFailure){
      const restored=await emergencyRestore(`critical_stage_${stage.name}_${result.status}`);
      log("shark_scout_pipeline_aborted",{stage:stage.name,result,startedAt,canonicalSnapshotTaken,emergencyRestoreOk:restored});
      process.exitCode=1;return;
    }
  }

  // Safety invariant: never intentionally leave a canonical snapshot bracket unrestored.
  if(canonicalSnapshotTaken){
    const restored=await emergencyRestore("pipeline_end_snapshot_open");
    if(!restored)process.exitCode=1;
  }

  const failed=results.filter(x=>x.status==="FAILED"||x.status==="TIMED_OUT");
  const skipped=results.filter(x=>x.status==="SKIPPED_BUDGET");
  log("shark_scout_pipeline_complete",{startedAt,finishedAt:new Date().toISOString(),durationMs:Date.now()-pipelineStarted,stageCount:results.length,failedCount:failed.length,skippedBudgetCount:skipped.length,failedStages:failed,skippedStages:skipped.map(x=>x.name)});
  if(failed.length&&process.exitCode!==1)process.exitCode=2;
}

main().catch((e)=>{console.error(JSON.stringify({level:"error",event:"shark_scout_pipeline_fatal",at:new Date().toISOString(),error:String(e)}));process.exitCode=1;});
