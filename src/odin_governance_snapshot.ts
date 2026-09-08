import { promises as fs } from "node:fs";
import path from "node:path";
import { bootstrapProbabilityPositive, metrics, type Layer, type TradeResult } from "./ab_metrics.js";
import { sha256, stableJson } from "./prospective_ab_lab.js";

const TRANSFER_PATH=process.env.SCOUT_ODIN_TRANSFER_REPORT_PATH||"/data/odin-transfer-report.json";
const RESULTS_PATH=process.env.SCOUT_EXPERIMENT_RESULTS_PATH||"/data/prospective-ab/experiment-results.jsonl";
const CAP_PATH=process.env.SCOUT_ODIN_CAP_AUDIT_PATH||"/data/odin-cap-audit.json";
const OUT_PATH=process.env.SCOUT_ODIN_GOVERNANCE_REPORT_PATH||"/data/odin-governance-report.json";
const HISTORY_PATH=process.env.SCOUT_ODIN_GOVERNANCE_HISTORY_PATH||"/data/odin-governance-history.jsonl";
const MIN_SAMPLES=Math.max(5,Number(process.env.ODIN_GOV_MIN_SAMPLES||12));
const PROMOTION_SAMPLES=Math.max(MIN_SAMPLES,Number(process.env.ODIN_GOV_PROMOTION_SAMPLES||25));
const MIN_CONF=Math.max(0,Math.min(1,Number(process.env.ODIN_GOV_MIN_BOOTSTRAP_POSITIVE||.80)));
const PROMOTION_CONF=Math.max(MIN_CONF,Math.min(1,Number(process.env.ODIN_GOV_PROMOTION_BOOTSTRAP_POSITIVE||.92)));
const MAX_DD=Math.max(.05,Number(process.env.ODIN_GOV_MAX_DRAWDOWN_SOL||.75));
const MIN_PF=Math.max(.5,Number(process.env.ODIN_GOV_MIN_PROFIT_FACTOR||1.15));
const DEGRADE_WINDOW=Math.max(5,Number(process.env.ODIN_GOV_DEGRADE_WINDOW||10));
const DEGRADE_RATIO=Math.max(.1,Math.min(1,Number(process.env.ODIN_GOV_DEGRADE_RATIO||.50)));

type AnyObj=Record<string,any>;
type Decision="KEEP"|"WATCH"|"DEMOTE"|"PROMOTION-READY"|"INSUFFICIENT DATA";
function now(){return new Date().toISOString();}
async function readJson(file:string,fallback:any){try{return JSON.parse(await fs.readFile(file,"utf8"));}catch{return fallback;}}
async function readRows(file:string){try{return (await fs.readFile(file,"utf8")).split("\n").filter(Boolean).map(x=>JSON.parse(x) as TradeResult);}catch{return[];}}
async function atomic(file:string,data:string){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;await fs.writeFile(tmp,data);await fs.rename(tmp,file);}
function degrade(rows:TradeResult[]){if(rows.length<DEGRADE_WINDOW*2)return{detected:false,recentNetSol:null,priorNetSol:null,ratio:null};const x=[...rows].sort((a,b)=>String(a.resolvedAt).localeCompare(String(b.resolvedAt))),recent=x.slice(-DEGRADE_WINDOW),prior=x.slice(-2*DEGRADE_WINDOW,-DEGRADE_WINDOW),rn=recent.reduce((s,r)=>s+r.netSol,0),pn=prior.reduce((s,r)=>s+r.netSol,0),ratio=pn>0?rn/pn:null;return{detected:pn>0&&rn<pn*DEGRADE_RATIO,recentNetSol:rn,priorNetSol:pn,ratio};}
function policyPass(m:ReturnType<typeof metrics>,conf:number|null){return (conf??0)>=MIN_CONF&&m.stress50>0&&m.maxDrawdown<=MAX_DD&&(m.profitFactor??Infinity)>=MIN_PF;}

async function main(){
  const startedAt=now(),[transfer,rows,capAudit]=await Promise.all([readJson(TRANSFER_PATH,{}),readRows(RESULTS_PATH),readJson(CAP_PATH,{rows:[]})]),live=new Set<string>(transfer?.cohorts?.live||[]),research=new Set<string>(transfer?.cohorts?.research||[]),controls=new Set<string>(transfer?.cohorts?.controls||[]),wallets=[...new Set([...live,...research])].sort(),capByWallet=new Map<string,AnyObj>((Array.isArray(capAudit?.rows)?capAudit.rows:[]).map((x:AnyObj)=>[String(x?.address||""),x]));
  const controlRows=rows.filter(r=>controls.has(r.wallet)&&r.layer==="SIMULATED_ODIN"),controlMetrics=metrics(controlRows),controlConfidence=bootstrapProbabilityPositive(controlRows),decisions:any[]=[];
  for(const wallet of wallets){
    const isLive=live.has(wallet),layer:Layer=isLive?"ACTUAL_ODIN":"SIMULATED_ODIN",wr=rows.filter(r=>r.wallet===wallet&&r.layer===layer),m=metrics(wr),conf=bootstrapProbabilityPositive(wr),d=degrade(wr),reasons:string[]=[];let decision:Decision="WATCH";
    const controlPerWallet=controls.size?controlMetrics.netSol/controls.size:null,controlDelta=controlPerWallet==null?null:m.netSol-controlPerWallet,transferRow=transfer?.perWallet?.find((x:AnyObj)=>x?.wallet===wallet)??null,capRow=capByWallet.get(wallet)??null;
    if(wr.length<MIN_SAMPLES){decision="INSUFFICIENT DATA";reasons.push(`sample ${wr.length}/${MIN_SAMPLES}`);}else if(d.detected){decision=isLive?"WATCH":"DEMOTE";reasons.push("recent prospective net degraded versus prior window");}else if(!policyPass(m,conf)){decision=isLive?"WATCH":"DEMOTE";if((conf??0)<MIN_CONF)reasons.push("bootstrap-positive confidence below floor");if(m.stress50<=0)reasons.push("stress50 nonpositive");if(m.maxDrawdown>MAX_DD)reasons.push("drawdown above policy");if((m.profitFactor??Infinity)<MIN_PF)reasons.push("profit factor below policy");}else if(!isLive&&wr.length>=PROMOTION_SAMPLES&&(conf??0)>=PROMOTION_CONF&&(controlDelta==null||controlDelta>0)){decision="PROMOTION-READY";reasons.push("prospective simulated-Odin thresholds passed");if(controlDelta!=null)reasons.push("outperformed near-pass controls");}else{decision="KEEP";reasons.push(isLive?"actual-Odin prospective thresholds passed":"simulated-Odin prospective thresholds passed");}
    if(isLive&&capRow?.recommendation?.nextSlotHistoricalSupport==="NOT_ROBUSTLY_POSITIVE")reasons.push("higher daily-cap slot lacks robust historical support; hold live cap");
    if(isLive&&capRow?.recommendation?.nextSlotHistoricalSupport==="UNKNOWN")reasons.push("higher daily-cap evidence unknown; hold live cap");
    decisions.push({wallet,role:isLive?"LIVE":"RESEARCH",layer,decision,reasons,n:wr.length,confidence:conf,metrics:m,controlDeltaSol:controlDelta,degradation:d,ots:transferRow?.ots??null,execution:transferRow?.execution??null,capCounterfactual:capRow?{evidenceStatus:capRow.evidenceStatus,diagnostic:capRow.diagnostic,liveDailyCap:capRow?.recommendation?.liveDailyCap??capRow?.policy?.dailyCap??null,shadowDailyCaps:capRow?.recommendation?.shadowDailyCaps??capRow?.policy?.shadowDailyCaps??[],nextSlotHistoricalSupport:capRow?.recommendation?.nextSlotHistoricalSupport??"UNKNOWN",marginalLiveToNext:capRow?.recommendation?.marginalLiveToNext??null,recommendation:capRow?.recommendation?.recommendation??"HOLD_LIVE_CAP"}:null});
  }
  const counts:Record<Decision,number>={"KEEP":0,"WATCH":0,"DEMOTE":0,"PROMOTION-READY":0,"INSUFFICIENT DATA":0};for(const d of decisions)counts[d.decision as Decision]++;
  const report={schemaVersion:2,event:"shark_scout_odin_governance_complete",startedAt,finishedAt:now(),policy:{liveLayer:"ACTUAL_ODIN",researchLayer:"SIMULATED_ODIN",controlLayer:"SIMULATED_ODIN",minSamples:MIN_SAMPLES,promotionSamples:PROMOTION_SAMPLES,minBootstrapPositive:MIN_CONF,promotionBootstrapPositive:PROMOTION_CONF,maxDrawdownSol:MAX_DD,minProfitFactor:MIN_PF,degradeWindow:DEGRADE_WINDOW,degradeRatio:DEGRADE_RATIO,capPolicy:"counterfactual evidence is advisory and never changes Odin automatically"},summary:counts,controls:{wallets:[...controls].sort(),n:controlRows.length,metrics:controlMetrics,confidence:controlConfidence},decisions,transferExecutionSummary:transfer?.executionSummary??null,capAudit:{finishedAt:capAudit?.finishedAt??null,focusDiagnostics:capAudit?.focusDiagnostics??[],notes:capAudit?.notes??[]},guardrails:{authoritativeHourlyResearchGovernance:true,advisoryOnly:true,odinMutation:false,capitalMutation:false,mirrorMutation:false,capMutation:false},hash:sha256(stableJson({counts,decisions}))};
  await atomic(OUT_PATH,JSON.stringify(report));await fs.mkdir(path.dirname(HISTORY_PATH),{recursive:true});await fs.appendFile(HISTORY_PATH,JSON.stringify(report)+"\n");console.log(JSON.stringify(report));
}
main().catch(e=>{console.error(JSON.stringify({event:"shark_scout_odin_governance_failed",error:e instanceof Error?e.message:String(e)}));process.exitCode=1;});
