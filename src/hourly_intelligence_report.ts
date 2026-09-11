import { promises as fs } from "node:fs";
import path from "node:path";

type AnyObj = Record<string, any>;

const FOLLOWER_PATH=process.env.SCOUT_FOLLOWER_POLICY_LEDGER_PATH||"/data/follower-policy-ledger.json";
const LIVE_EDGE_PATH=process.env.SCOUT_LIVE_EDGE_PATH||"/data/live-edge-controller.json";
const DEBT_PATH=process.env.SCOUT_OPPORTUNITY_DEBT_PATH||"/data/opportunity-debt.json";
const TRUTH_PATH=process.env.SCOUT_ODIN_TRUTH_LEDGER_PATH||"/data/odin-truth-ledger.json";
const QUOTA_PATH=process.env.SCOUT_QUOTA_SHIELD_PATH||"/data/quota-shield-summary.json";
const OUT_PATH=process.env.SCOUT_HOURLY_REPORT_PATH||"/data/hourly-intelligence-report.json";
const STATE_PATH=process.env.SCOUT_HOURLY_REPORT_STATE_PATH||"/data/hourly-intelligence-state.json";
const HISTORY_PATH=process.env.SCOUT_HOURLY_REPORT_HISTORY_PATH||"/data/hourly-intelligence-history.json";

async function read(file:string,fallback:any){try{return JSON.parse(await fs.readFile(file,"utf8"));}catch{return fallback;}}
async function atomic(file:string,data:any){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;await fs.writeFile(tmp,JSON.stringify(data,null,2));await fs.rename(tmp,file);}
function num(v:any){const n=Number(v);return Number.isFinite(n)?n:null;}
function delta(now:any,prior:any){const a=num(now),b=num(prior);return a===null||b===null?null:a-b;}
function mapBy<T extends AnyObj>(rows:T[],key:string){const m:Record<string,T>={};for(const r of rows){const k=String(r?.[key]||"");if(k)m[k]=r;}return m;}
function topChangedMirrors(current:any[],prior:any[]){
  const pm=mapBy(prior||[],"mirror");
  return (current||[]).map((r:any)=>{
    const p=pm[String(r.mirror)]||{};
    return {
      mirror:r.mirror,
      verdict:r.verdict||r.recommendation||r.status||null,
      opportunitiesTracked:r.opportunitiesTracked??null,
      copied:r.copied??null,
      blocked:r.blocked??null,
      eligibleNotCopied:r.eligibleNotCopied??null,
      actualFollowerRealizedNetSol:r.actualFollowerRealizedNetSol??null,
      changes:{
        opportunitiesTracked:delta(r.opportunitiesTracked,p.opportunitiesTracked),
        copied:delta(r.copied,p.copied),
        blocked:delta(r.blocked,p.blocked),
        eligibleNotCopied:delta(r.eligibleNotCopied,p.eligibleNotCopied),
        actualFollowerRealizedNetSol:delta(r.actualFollowerRealizedNetSol,p.actualFollowerRealizedNetSol)
      }
    };
  }).filter((r:any)=>Object.values(r.changes).some((v:any)=>typeof v==="number"&&v!==0));
}
function compactEntry(e:any){return {
  mirror:e.mirror||null,mint:e.mint||null,sourceSignature:e.sourceSignature||null,sourceBuyAt:e.sourceBuyAt||null,
  decision:e.odinDecision||null,evidence:e.decisionEvidence||null,reason:e.decisionReason||null,ruleKey:e.ruleKey||null,
  copied:Boolean(e.copied),followerBuyDelaySeconds:e.followerBuyDelaySeconds??null,lifecycle:e.followerLifecycle||null,
  estimatedFollowerNetSol:e.estimatedFollowerNetSol??null,actualFollowerNetSol:e.actualFollowerNetSol??null,sourceRoi:e.sourceRoi??null
};}
function reportAnalysis(follower:any,live:any,quota:any,newEntries:any[],changedMirrors:any[]){
  const notes:string[]=[];
  if(quota?.semanticHealth==="DEGRADED_PROVIDER_LIMITED")notes.push(`Provider pressure degraded evidence quality (${quota?.quotaPressure?.total??"?"} quota signatures); process success should not be treated as full data health.`);
  const realized=num(follower?.summary?.realizedActualOdinAvailable)||0;
  const pending=num(follower?.summary?.sourceExitFollowerPending)||0;
  if(pending>0)notes.push(`${pending} copied position(s) have a source exit observed but follower exit is still pending; ACTUAL_ODIN P&L is incomplete.`);
  if(realized===0)notes.push("No fully realized ACTUAL_ODIN lifecycle is currently available; promotion decisions should remain conservative.");
  const misses=(follower?.summary?.eligibleNotCopied??0);
  if(misses>0)notes.push(`${misses} eligible-not-copied opportunity/opportunities remain distinct from policy blocks and require execution/transfer diagnosis.`);
  if(newEntries.length)notes.push(`${newEntries.length} new source opportunity/opportunities entered the durable policy ledger this hour.`);
  if(changedMirrors.length===0)notes.push("No live-mirror evidence counters changed since the prior hourly snapshot.");
  const decisions=(live?.byMirror||live?.mirrors||live?.scorecards||[]).map((x:any)=>({mirror:x.mirror||x.address,verdict:x.verdict||x.recommendation||x.status})).filter((x:any)=>x.mirror);
  return {notes,decisions};
}

export async function buildHourlyIntelligenceReport(){
  const generatedAt=new Date().toISOString();
  const [follower,live,debt,truth,quota,priorState,history]=await Promise.all([
    read(FOLLOWER_PATH,{}),read(LIVE_EDGE_PATH,{}),read(DEBT_PATH,{}),read(TRUTH_PATH,{}),read(QUOTA_PATH,{}),read(STATE_PATH,{}),read(HISTORY_PATH,{reports:[]})
  ]);
  const entries=Object.values(follower?.entries||{}) as AnyObj[];
  const priorEntryKeys=new Set<string>(Array.isArray(priorState?.entryKeys)?priorState.entryKeys:[]);
  const newEntries=entries.filter(e=>!priorEntryKeys.has(String(e.key||`${e.mirror}|${e.sourceSignature}`))).map(compactEntry);
  const currentByMirror=Array.isArray(follower?.byMirror)?follower.byMirror:[];
  const liveAddresses=(Array.isArray(live?.liveMirrors)?live.liveMirrors:(live?.scorecards||[]).map((x:any)=>x?.address||x?.mirror)).map((x:any)=>String(x||"")).filter(Boolean);
  const disabledAddresses=(Array.isArray(live?.buysDisabledMirrors)?live.buysDisabledMirrors:[]).map((x:any)=>String(x||"")).filter(Boolean);
  const liveSet=new Set<string>(liveAddresses);
  const disabledSet=new Set<string>(disabledAddresses);
  const liveByMirror=currentByMirror.filter((r:any)=>liveSet.has(String(r?.mirror||"")));
  const disabledByMirror=currentByMirror.filter((r:any)=>disabledSet.has(String(r?.mirror||"")));
  const allChangedMirrors=topChangedMirrors(currentByMirror,Array.isArray(priorState?.byMirror)?priorState.byMirror:[]);
  const changedMirrors=allChangedMirrors.filter((r:any)=>liveSet.has(String(r?.mirror||"")));
  const current={
    followerSummary:follower?.summary||{},
    trackedMirrors:currentByMirror,
    liveMirrors:liveByMirror,
    buysDisabledMirrors:disabledByMirror,
    liveEdge:live?.byMirror||live?.mirrors||live?.scorecards||[],
    opportunityDebt:debt?.summary||debt,
    truthSummary:truth?.summary||{},
    quotaHealth:quota?.semanticHealth||"UNKNOWN",
    quotaPressure:quota?.quotaPressure||{}
  };
  const changes={
    newSourceOpportunities:newEntries,
    changedMirrors,
    changedTrackedMirrors:allChangedMirrors,
    totals:{
      entries:delta(follower?.entryCount,priorState?.entryCount),
      copied:delta(follower?.summary?.copied,priorState?.summary?.copied),
      blocked:delta(follower?.summary?.blocked,priorState?.summary?.blocked),
      eligibleNotCopied:delta(follower?.summary?.eligibleNotCopied,priorState?.summary?.eligibleNotCopied),
      followerEntryMatched:delta(follower?.summary?.followerEntryMatched,priorState?.summary?.followerEntryMatched),
      sourceExitFollowerPending:delta(follower?.summary?.sourceExitFollowerPending,priorState?.summary?.sourceExitFollowerPending),
      followerExitMatched:delta(follower?.summary?.followerExitMatched,priorState?.summary?.followerExitMatched),
      realizedActualOdinAvailable:delta(follower?.summary?.realizedActualOdinAvailable,priorState?.summary?.realizedActualOdinAvailable)
    }
  };
  const analysis=reportAnalysis(follower,live,quota,newEntries,changedMirrors);
  const report={
    schemaVersion:2,event:"shark_scout_hourly_intelligence_report_complete",generatedAt,
    purpose:"Hourly change/progress/analysis surface for buy-enabled live mirrors, tracked mirrors, source opportunities, Odin decisions, follower outcomes, policy value, provider health, and research debt.",
    current,changes,analysis,
    guardrails:{observationalOnly:true,mutatesOdin:false,changesCapital:false,changesCaps:false,changesFilters:false,changesSpeed:false}
  };
  const nextState={generatedAt,entryCount:follower?.entryCount??entries.length,entryKeys:entries.map(e=>String(e.key||`${e.mirror}|${e.sourceSignature}`)),summary:follower?.summary||{},byMirror:currentByMirror};
  const reports=Array.isArray(history?.reports)?history.reports:[];
  const compactHistory=[...reports,{generatedAt,changes:changes.totals,quotaHealth:current.quotaHealth,changedMirrors:changedMirrors.map((x:any)=>x.mirror),newSourceOpportunities:newEntries.length}].slice(-168);
  await Promise.all([atomic(OUT_PATH,report),atomic(STATE_PATH,nextState),atomic(HISTORY_PATH,{schemaVersion:1,reports:compactHistory})]);
  console.log(JSON.stringify(report));
  return report;
}

if(import.meta.url===`file://${process.argv[1]}`)buildHourlyIntelligenceReport().catch(e=>{console.error(JSON.stringify({event:"shark_scout_hourly_intelligence_report_failed",error:e instanceof Error?e.message:String(e)}));process.exitCode=1;});
