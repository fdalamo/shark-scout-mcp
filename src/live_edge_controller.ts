import { promises as fs } from "node:fs";
import path from "node:path";
import { walletPolicy } from "./wallet_policy.js";

type AnyObj=Record<string,any>;
type Scorecard=AnyObj;
const ODIN_PATH=process.env.SCOUT_ODIN_SNAPSHOT_PATH||"/data/odin-config.json";
const TRUTH_PATH=process.env.SCOUT_ODIN_TRUTH_LEDGER_PATH||"/data/odin-truth-ledger.json";
const PAPER_REPORT_PATH=process.env.SCOUT_PAPER_ODIN_REPORT_PATH||"/data/paper-odin-report.json";
const OUT_PATH=process.env.SCOUT_LIVE_EDGE_PATH||"/data/live-edge-controller.json";
const MAX_PAPER_RETURN_MULTIPLE=Math.max(1000,Number(process.env.SCOUT_LIVE_EDGE_MAX_PAPER_RETURN_MULTIPLE||10000));

async function read(file:string,fallback:any){try{return JSON.parse(await fs.readFile(file,"utf8"));}catch{return fallback;}}
async function atomic(file:string,data:any){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;await fs.writeFile(tmp,JSON.stringify(data,null,2));await fs.rename(tmp,file);}
function mean(xs:number[]){return xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;}
function sum(xs:number[]){return xs.reduce((a,b)=>a+b,0);}
function n(v:any){const x=Number(v);return Number.isFinite(x)?x:0;}
function paperPnlGuard(rawRealized:number,paperBuys:number,tradeSizeSol:number){
  const deployed=Math.max(0,paperBuys)*Math.max(0,tradeSizeSol);
  const limit=Math.max(10,deployed*MAX_PAPER_RETURN_MULTIPLE);
  const quarantined=!Number.isFinite(rawRealized)||Math.abs(rawRealized)>limit;
  return{rawRealizedNetSol:Number.isFinite(rawRealized)?rawRealized:null,realizedNetSol:quarantined?null:rawRealized,quarantined,limitSol:limit,returnMultipleLimit:MAX_PAPER_RETURN_MULTIPLE,reason:quarantined?"PAPER_PNL_EXTREME_UNVERIFIED":null};
}
function verdict(input:{closed:number;realized:number|null;paperBuys:number;matched:number;eligibleMisses:number;eligibleMissNet:number}){
  if(input.realized!==null&&input.closed>=3&&input.realized<0)return{capitalPermission:"PAUSE",verdict:"PAUSE",reason:"NEGATIVE_REALIZED_WITH_SAMPLE"};
  if(input.realized!==null&&input.closed>=2&&input.realized>0)return{capitalPermission:"PRODUCTION",verdict:"KEEP",reason:"POSITIVE_PROSPECTIVE_REALIZED"};
  if(input.paperBuys>0||input.matched>0)return{capitalPermission:"PROBATION",verdict:"RESTRICT",reason:input.realized===null?"PAPER_PNL_QUARANTINED_INSUFFICIENT_VERIFIED_SAMPLE":"SOME_PROSPECTIVE_EVIDENCE_INSUFFICIENT_SAMPLE"};
  if(input.eligibleMisses>0&&input.eligibleMissNet>0)return{capitalPermission:"SHADOW",verdict:"EXPAND_TEST",reason:"POSITIVE_MISSED_ELIGIBLE_EVIDENCE_NO_REALIZED_SAMPLE"};
  return{capitalPermission:"SHADOW",verdict:"SHADOW_ONLY",reason:"INSUFFICIENT_TRANSFER_EVIDENCE"};
}

export async function buildLiveEdgeController(){
  const generatedAt=new Date().toISOString();
  const [odin,truth,paper]=await Promise.all([read(ODIN_PATH,{}),read(TRUTH_PATH,{entries:{}}),read(PAPER_REPORT_PATH,{wallets:[]})]);
  const trackedMirrors:AnyObj[]=(Array.isArray(odin?.mirrors)?odin.mirrors:[])
    .map((x:any)=>({address:String(x?.address||x?.wallet||x?.sourceWallet||""),allowBuys:x?.allowBuys}))
    .filter((x:AnyObj)=>Boolean(x.address));
  const liveMirrors:string[]=trackedMirrors.filter((x:AnyObj)=>x.allowBuys!==false).map((x:AnyObj)=>x.address);
  const buysDisabledMirrors:string[]=trackedMirrors.filter((x:AnyObj)=>x.allowBuys===false).map((x:AnyObj)=>x.address);
  const truthEntries=Object.values(truth?.entries||{}) as AnyObj[];
  const paperPairs:[string,AnyObj][]=(Array.isArray(paper?.wallets)?paper.wallets:[]).map((x:any)=>[String(x?.address||x?.wallet||""),x] as [string,AnyObj]);
  const paperWallets=new Map<string,AnyObj>(paperPairs);
  const scorecards:Scorecard[]=liveMirrors.map((address:string)=>{
    const rows=truthEntries.filter((x:AnyObj)=>String(x?.mirror||"")===address);
    const pw=paperWallets.get(address)||{};
    const matched=rows.filter((x:AnyObj)=>x?.state==="FOLLOWER_BUY_MATCHED");
    const blocked=rows.filter((x:AnyObj)=>x?.state==="COPY_BLOCKED_BY_ODIN_POLICY");
    const eligibleMisses=rows.filter((x:AnyObj)=>x?.state==="EXPECTED_COPY_NOT_MATCHED");
    const eligibleMissNets=eligibleMisses.map((x:AnyObj)=>n(x?.sourceRoundTrip?.estimatedFollowerNetSol)).filter((x:number)=>x!==0);
    const blockedNets=blocked.map((x:AnyObj)=>n(x?.sourceRoundTrip?.estimatedFollowerNetSol)).filter((x:number)=>x!==0);
    const dailyCapBlocked=blocked.filter((x:AnyObj)=>String(x?.executionEvidence?.reason||"").includes("DAILY_CAP"));
    const tokenCapBlocked=blocked.filter((x:AnyObj)=>/TOKEN_(DAY|WEEK)_CAP/.test(String(x?.executionEvidence?.reason||"")));
    const closed=n(pw?.closedPositions),paperBuys=n(pw?.paperBuys);
    const p=walletPolicy(address);
    const paperPnl=paperPnlGuard(Number(pw?.realizedNetSol),paperBuys,n(p?.tradeSizeSol));
    const v=verdict({closed,realized:paperPnl.realizedNetSol,paperBuys,matched:matched.length,eligibleMisses:eligibleMisses.length,eligibleMissNet:sum(eligibleMissNets)});
    return{
      address,
      capitalPermission:v.capitalPermission,
      verdict:v.verdict,
      verdictReason:v.reason,
      currentPolicy:p,
      prospective:{paperBuys,closedPositions:closed,openPositions:n(pw?.openPositions),realizedNetSol:paperPnl.realizedNetSol,rawRealizedNetSol:paperPnl.rawRealizedNetSol,pnlQuarantined:paperPnl.quarantined,pnlQuarantineReason:paperPnl.reason,pnlQuarantineLimitSol:paperPnl.limitSol,winRate:paperPnl.quarantined?null:(pw?.winRate??null)},
      transferTruth:{opportunities:rows.length,followerBuysMatched:matched.length,policyBlocked:blocked.length,eligibleNotCopied:eligibleMisses.length,eligibleMissEstimatedNetSol:sum(eligibleMissNets),eligibleMissAverageNetSol:mean(eligibleMissNets),dailyCapBlocked:dailyCapBlocked.length,tokenCapBlocked:tokenCapBlocked.length,policyBlockedKnownNetSol:sum(blockedNets)},
      counterfactual:{
        currentDailyCap:p.dailyCap,
        shadowDailyCaps:p.shadowDailyCaps,
        thirdSlotEvidence:dailyCapBlocked.length?{sampleSize:dailyCapBlocked.length,estimatedNetSol:sum(dailyCapBlocked.map((x:AnyObj)=>n(x?.sourceRoundTrip?.estimatedFollowerNetSol))),note:"Only DAILY_CAP-blocked opportunities count as direct evidence for a higher daily cap."}:{sampleSize:0,estimatedNetSol:0,note:"No direct daily-cap marginal evidence yet; token-day/week blocks are intentionally excluded."}
      }
    };
  });
  const summary={production:scorecards.filter((x:Scorecard)=>x.capitalPermission==="PRODUCTION").length,probation:scorecards.filter((x:Scorecard)=>x.capitalPermission==="PROBATION").length,shadow:scorecards.filter((x:Scorecard)=>x.capitalPermission==="SHADOW").length,paused:scorecards.filter((x:Scorecard)=>x.capitalPermission==="PAUSE").length,paperPnlQuarantined:scorecards.filter((x:Scorecard)=>x?.prospective?.pnlQuarantined===true).length};
  const out={schemaVersion:3,event:"shark_scout_live_edge_controller_complete",generatedAt,principle:"actual follower and prospective evidence veto historical replay quality",trackedMirrorCount:trackedMirrors.length,liveMirrorCount:liveMirrors.length,buysDisabledMirrorCount:buysDisabledMirrors.length,liveMirrors,buysDisabledMirrors,summary,scorecards,guardrails:{mutatesOdin:false,changesCapital:false,changesTips:false,changesSpeed:false,changesFilters:false,changesCaps:false},notes:["Capital permission is advisory only and never mutates Odin.","Only buy-enabled Odin mirrors are governed as live; buys-disabled tracked records are reported separately and excluded from live scorecards.","Extreme Paper-Odin aggregate PnL is preserved as rawRealizedNetSol but quarantined from verdicts until independently verified.","Policy-blocked misses are separated from execution/transfer misses.","Only DAILY_CAP blocks are admitted into daily-cap expansion evidence; TOKEN_DAY_CAP and TOKEN_WEEK_CAP are not treated as third-slot evidence.","Historical replay is intentionally absent from the promotion rule; prospective follower/paper evidence has veto power."]};
  await atomic(OUT_PATH,out);console.log(JSON.stringify(out));return out;
}

if(import.meta.url===`file://${process.argv[1]}`)buildLiveEdgeController().catch(e=>{console.error(JSON.stringify({event:"shark_scout_live_edge_controller_failed",error:e instanceof Error?e.message:String(e)}));process.exitCode=1;});
