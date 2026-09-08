import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

type Phase="MONITOR"|"DISCOVERY"|"CANONICAL"|"FINALIZE";
type WorkClass="HOT"|"COLD"|"SYSTEM";
type Stage={name:string;args:string[];timeoutMs:number;phase:Phase;workClass:WorkClass;continueOnFailure?:boolean;env?:Record<string,string>};
type StageResult={name:string;phase:Phase;workClass:WorkClass;status:"SUCCESS"|"FAILED"|"TIMED_OUT"|"SKIPPED_BUDGET"|"SKIPPED_EVENT"|"SKIPPED_PROVIDER";durationMs:number;exitCode:number|null;signal:NodeJS.Signals|null};

const MINUTE=60_000;
const PIPELINE_BUDGET_MS=Math.max(20*MINUTE,Math.min(58*MINUTE,Number(process.env.HARVEST_PIPELINE_BUDGET_MS||50*MINUTE)));
const FINALIZE_RESERVE_MS=Math.max(5*MINUTE,Math.min(15*MINUTE,Number(process.env.HARVEST_FINALIZE_RESERVE_MS||8*MINUTE)));
const HOT_EVENT_DECISION_PATH=process.env.HOT_EVENT_DECISION_PATH||"/data/hot-event-decision.json";
const GAUNTLET_REPORT_PATH=process.env.SCOUT_GAUNTLET_PATH||"/data/latest-gauntlet.json";
const HELIUS_HARD_QUOTA_COOLDOWN_MS=Math.max(15*MINUTE,Math.min(3*60*MINUTE,Number(process.env.HELIUS_HARD_QUOTA_COOLDOWN_MS||75*MINUTE)));

const stages:Stage[]=[
  {name:"maintenance",phase:"MONITOR",workClass:"HOT",args:["dist/maintenance.js"],timeoutMs:2*MINUTE,continueOnFailure:true},
  {name:"odin_sync",phase:"MONITOR",workClass:"HOT",args:["dist/odin_sync.js"],timeoutMs:2*MINUTE,continueOnFailure:true},
  {name:"portfolio_audit",phase:"MONITOR",workClass:"HOT",args:["dist/portfolio_audit_v2.js"],timeoutMs:3*MINUTE,continueOnFailure:true},
  {name:"opportunity_audit",phase:"MONITOR",workClass:"HOT",args:["dist/mirror_opportunity_audit_v2.js"],timeoutMs:4*MINUTE,continueOnFailure:true},
  {name:"paper_odin_fast",phase:"MONITOR",workClass:"HOT",args:["dist/paper_odin_v2.js"],timeoutMs:4*MINUTE,continueOnFailure:true},
  {name:"odin_truth_ledger",phase:"MONITOR",workClass:"HOT",args:["dist/odin_truth_ledger.js"],timeoutMs:1*MINUTE,continueOnFailure:true},
  {name:"dip_shadow_fast",phase:"MONITOR",workClass:"HOT",args:["dist/dip_shadow.js"],timeoutMs:4*MINUTE,continueOnFailure:true},
  {name:"dune_alpha",phase:"DISCOVERY",workClass:"COLD",args:["dist/dune_alpha_runner.js"],timeoutMs:3*MINUTE,continueOnFailure:true},
  {name:"outcome_miner_v2",phase:"DISCOVERY",workClass:"COLD",args:["dist/outcome_miner_v2.js"],timeoutMs:10*MINUTE,continueOnFailure:true},
  {name:"harvest_scout",phase:"DISCOVERY",workClass:"COLD",args:["dist/harvest_scout_fabric.js"],timeoutMs:12*MINUTE,continueOnFailure:true},
  {name:"canonical_snapshot_pre",phase:"CANONICAL",workClass:"SYSTEM",args:["dist/canonical_state_guard.js","snapshot"],timeoutMs:2*MINUTE},
  {name:"deep_dive",phase:"CANONICAL",workClass:"COLD",args:["dist/deep_dive_reinvestigate.js"],timeoutMs:10*MINUTE,continueOnFailure:true},
  {name:"gauntlet_v6",phase:"CANONICAL",workClass:"COLD",args:["dist/gauntlet_v6.js"],timeoutMs:10*MINUTE,continueOnFailure:true,env:{VYBE_API_KEY:""}},
  {name:"canonical_restore",phase:"CANONICAL",workClass:"SYSTEM",args:["dist/canonical_state_guard.js","restore"],timeoutMs:2*MINUTE},
  {name:"replay_shadow",phase:"CANONICAL",workClass:"COLD",args:["dist/replay_shadow.js"],timeoutMs:6*MINUTE,continueOnFailure:true},
  {name:"canonical_snapshot_post",phase:"CANONICAL",workClass:"SYSTEM",args:["dist/canonical_state_guard.js","snapshot"],timeoutMs:2*MINUTE},
  {name:"selection_skill",phase:"CANONICAL",workClass:"COLD",args:["dist/selection_skill.js"],timeoutMs:3*MINUTE,continueOnFailure:true},
  {name:"canonical_overlay",phase:"CANONICAL",workClass:"SYSTEM",args:["dist/canonical_gauntlet_overlay.js"],timeoutMs:3*MINUTE},
  {name:"hot_event_gate",phase:"FINALIZE",workClass:"SYSTEM",args:["dist/hot_event_gate.js"],timeoutMs:2*MINUTE,continueOnFailure:true},
  {name:"paper_odin_refresh",phase:"FINALIZE",workClass:"HOT",args:["dist/paper_odin_v2.js"],timeoutMs:4*MINUTE,continueOnFailure:true},
  {name:"odin_truth_refresh",phase:"FINALIZE",workClass:"HOT",args:["dist/odin_truth_ledger.js"],timeoutMs:1*MINUTE,continueOnFailure:true},
  {name:"dip_shadow_refresh",phase:"FINALIZE",workClass:"HOT",args:["dist/dip_shadow.js"],timeoutMs:4*MINUTE,continueOnFailure:true},
  {name:"odin_cap_audit",phase:"FINALIZE",workClass:"HOT",args:["dist/odin_cap_audit.js"],timeoutMs:3*MINUTE,continueOnFailure:true},
  {name:"cielo_validate",phase:"FINALIZE",workClass:"COLD",args:["dist/cielo_validate.js"],timeoutMs:3*MINUTE,continueOnFailure:true},
  {name:"evidence_funnel",phase:"FINALIZE",workClass:"SYSTEM",args:["dist/evidence_funnel.js"],timeoutMs:3*MINUTE},
  {name:"prospective_walkforward",phase:"FINALIZE",workClass:"SYSTEM",args:["dist/prospective_walkforward.js"],timeoutMs:1*MINUTE,continueOnFailure:true},
  {name:"odin_transfer_lab",phase:"FINALIZE",workClass:"SYSTEM",args:["dist/odin_transfer_lab.js"],timeoutMs:1*MINUTE,continueOnFailure:true},
  {name:"odin_fixture_guard",phase:"FINALIZE",workClass:"SYSTEM",args:["dist/odin_fixture_guard.js"],timeoutMs:1*MINUTE,continueOnFailure:true},
  {name:"odin_governance",phase:"FINALIZE",workClass:"SYSTEM",args:["dist/odin_governance_snapshot.js"],timeoutMs:1*MINUTE,continueOnFailure:true},
  {name:"odin_policy_fragility",phase:"FINALIZE",workClass:"SYSTEM",args:["dist/odin_policy_fragility.js"],timeoutMs:1*MINUTE,continueOnFailure:true},
  {name:"engine_intelligence",phase:"FINALIZE",workClass:"SYSTEM",args:["dist/engine_intelligence.js"],timeoutMs:3*MINUTE},
  {name:"external_evidence_overlay",phase:"FINALIZE",workClass:"SYSTEM",args:["dist/external_evidence_overlay.js"],timeoutMs:2*MINUTE}
];
const protectedCanonicalStages=new Set(["deep_dive","gauntlet_v6","canonical_restore"]);
const eventRefreshStages=new Set(["paper_odin_refresh","dip_shadow_refresh"]);
const heliusSpecialtyDirectStages=new Set(["portfolio_audit","paper_odin_fast","dip_shadow_fast","deep_dive","paper_odin_refresh","dip_shadow_refresh"]);
function log(event:string,extra:Record<string,unknown>={}){console.log(JSON.stringify({level:"info",event,at:new Date().toISOString(),...extra}));}
function skipped(stage:Stage,status:"SKIPPED_BUDGET"|"SKIPPED_EVENT"|"SKIPPED_PROVIDER"="SKIPPED_BUDGET"):StageResult{return{name:stage.name,phase:stage.phase,workClass:stage.workClass,status,durationMs:0,exitCode:null,signal:null};}
function hotRefreshNeeded(){try{const x=JSON.parse(readFileSync(HOT_EVENT_DECISION_PATH,"utf8"));return x?.refresh!==false;}catch{return true;}}
function heliusHardQuotaCoolingDown(){try{const x=JSON.parse(readFileSync(GAUNTLET_REPORT_PATH,"utf8"));const opens=Number(x?.providerStats?.heliusCircuitOpens||0),at=Date.parse(String(x?.finishedAt||x?.generatedAt||"")),ageMs=Date.now()-at;if(opens<=0||!Number.isFinite(ageMs)||ageMs<0||ageMs>HELIUS_HARD_QUOTA_COOLDOWN_MS)return null;return{opens,ageMs,until:new Date(at+HELIUS_HARD_QUOTA_COOLDOWN_MS).toISOString()};}catch{return null;}}
async function runStage(stage:Stage,timeoutMs:number):Promise<StageResult>{const started=Date.now();log("shark_scout_stage_started",{stage:stage.name,phase:stage.phase,workClass:stage.workClass,timeoutMs});return await new Promise<StageResult>((resolve)=>{let timedOut=false,settled=false;const finish=(r:StageResult)=>{if(settled)return;settled=true;resolve(r);};const child=spawn(process.execPath,stage.args,{stdio:"inherit",env:{...process.env,SCOUT_WORK_CLASS:stage.workClass,...stage.env}});const timer=setTimeout(()=>{timedOut=true;log("shark_scout_stage_timeout",{stage:stage.name,phase:stage.phase,workClass:stage.workClass,elapsedMs:Date.now()-started});child.kill("SIGTERM");setTimeout(()=>{if(child.exitCode===null)child.kill("SIGKILL");},5000).unref();},timeoutMs);child.on("error",()=>{clearTimeout(timer);finish({name:stage.name,phase:stage.phase,workClass:stage.workClass,status:timedOut?"TIMED_OUT":"FAILED",durationMs:Date.now()-started,exitCode:null,signal:null});});child.on("exit",(code,signal)=>{clearTimeout(timer);finish({name:stage.name,phase:stage.phase,workClass:stage.workClass,status:timedOut?"TIMED_OUT":code===0?"SUCCESS":"FAILED",durationMs:Date.now()-started,exitCode:code,signal});});});}

async function main(){const pipelineStarted=Date.now(),startedAt=new Date(pipelineStarted).toISOString(),deadline=pipelineStarted+PIPELINE_BUDGET_MS,results:StageResult[]=[];let lastPhase:Phase|null=null,canonicalSnapshotTaken=false;const queueCounts={HOT:stages.filter(x=>x.workClass==="HOT").length,COLD:stages.filter(x=>x.workClass==="COLD").length,SYSTEM:stages.filter(x=>x.workClass==="SYSTEM").length};log("shark_scout_pipeline_started",{version:11,stageCount:stages.length,queueCounts,budgetMs:PIPELINE_BUDGET_MS,finalizeReserveMs:FINALIZE_RESERVE_MS,eventDrivenHotRefresh:true,sharedHeliusHardQuotaCircuit:true,odinResearchCore:"v0.44.0"});
const emergencyRestore=async(reason:string)=>{if(!canonicalSnapshotTaken)return true;log("shark_scout_emergency_restore_started",{reason});const restoreStage:Stage={name:"canonical_restore_emergency",phase:"FINALIZE",workClass:"SYSTEM",args:["dist/canonical_state_guard.js","restore"],timeoutMs:2*MINUTE};const restore=await runStage(restoreStage,2*MINUTE);results.push(restore);log("shark_scout_stage_finished",restore);if(restore.status==="SUCCESS"){canonicalSnapshotTaken=false;return true;}log("shark_scout_emergency_restore_failed",{reason,restore});return false;};
for(const stage of stages){if(stage.phase!==lastPhase){lastPhase=stage.phase;log("shark_scout_phase_started",{phase:lastPhase,elapsedMs:Date.now()-pipelineStarted,remainingMs:deadline-Date.now()});}const remaining=Math.max(0,deadline-Date.now());if(stage.workClass==="COLD"&&remaining<=FINALIZE_RESERVE_MS){const r=skipped(stage);results.push(r);log("shark_scout_stage_finished",r);continue;}if(stage.name==="canonical_snapshot_pre"&&remaining<=FINALIZE_RESERVE_MS+6*MINUTE){const r=skipped(stage);results.push(r);log("shark_scout_stage_finished",r);continue;}if(protectedCanonicalStages.has(stage.name)&&!canonicalSnapshotTaken){const r=skipped(stage);results.push(r);log("shark_scout_stage_finished",r);continue;}if(heliusSpecialtyDirectStages.has(stage.name)){const circuit=heliusHardQuotaCoolingDown();if(circuit){const r=skipped(stage,"SKIPPED_PROVIDER");results.push(r);log("shark_scout_helius_specialty_stage_skipped",{stage:stage.name,reason:"RECENT_HARD_QUOTA",...circuit});log("shark_scout_stage_finished",r);continue;}}if(eventRefreshStages.has(stage.name)&&!hotRefreshNeeded()){const r=skipped(stage,"SKIPPED_EVENT");results.push(r);log("shark_scout_stage_finished",r);continue;}const reserved=stage.workClass==="HOT"||stage.workClass==="SYSTEM"?0:FINALIZE_RESERVE_MS;const allowed=Math.max(1000,Math.min(stage.timeoutMs,deadline-Date.now()-reserved));const result=await runStage(stage,allowed);results.push(result);log("shark_scout_stage_finished",result);if(stage.name==="canonical_snapshot_pre"&&result.status==="SUCCESS")canonicalSnapshotTaken=true;if(stage.name==="canonical_restore"&&result.status==="SUCCESS")canonicalSnapshotTaken=false;if(result.status!=="SUCCESS"&&result.status!=="SKIPPED_EVENT"&&result.status!=="SKIPPED_PROVIDER"&&!stage.continueOnFailure){const restored=await emergencyRestore(`critical_stage_${stage.name}_${result.status}`);log("shark_scout_pipeline_aborted",{stage:stage.name,result,startedAt,canonicalSnapshotTaken,emergencyRestoreOk:restored});process.exitCode=1;return;}}
if(canonicalSnapshotTaken){const restored=await emergencyRestore("pipeline_end_snapshot_open");if(!restored)process.exitCode=1;}const failed=results.filter(x=>x.status==="FAILED"||x.status==="TIMED_OUT"),skippedRows=results.filter(x=>x.status==="SKIPPED_BUDGET"),eventSkipped=results.filter(x=>x.status==="SKIPPED_EVENT"),providerSkipped=results.filter(x=>x.status==="SKIPPED_PROVIDER");log("shark_scout_pipeline_complete",{startedAt,finishedAt:new Date().toISOString(),durationMs:Date.now()-pipelineStarted,stageCount:results.length,failedCount:failed.length,skippedBudgetCount:skippedRows.length,skippedEventCount:eventSkipped.length,skippedProviderCount:providerSkipped.length,failedStages:failed,skippedStages:skippedRows.map(x=>({name:x.name,workClass:x.workClass})),eventSkippedStages:eventSkipped.map(x=>x.name),providerSkippedStages:providerSkipped.map(x=>x.name)});if(failed.length&&process.exitCode!==1)process.exitCode=2;}
main().catch((e)=>{console.error(JSON.stringify({level:"error",event:"shark_scout_pipeline_fatal",at:new Date().toISOString(),error:String(e)}));process.exitCode=1;});
