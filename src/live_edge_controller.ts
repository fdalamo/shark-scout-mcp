import { promises as fs } from "node:fs";
import path from "node:path";
import { walletPolicy } from "./wallet_policy.js";

type AnyObj=Record<string,any>;
const ODIN_PATH=process.env.SCOUT_ODIN_SNAPSHOT_PATH||"/data/odin-config.json";
const TRUTH_PATH=process.env.SCOUT_ODIN_TRUTH_LEDGER_PATH||"/data/odin-truth-ledger.json";
const PAPER_REPORT_PATH=process.env.SCOUT_PAPER_ODIN_REPORT_PATH||"/data/paper-odin-report.json";
const OUT_PATH=process.env.SCOUT_LIVE_EDGE_PATH||"/data/live-edge-controller.json";

async function read(file:string,fallback:any){try{return JSON.parse(await fs.readFile(file,"utf8"));}catch{return fallback;}}
async function atomic(file:string,data:any){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;await fs.writeFile(tmp,JSON.stringify(data,null,2));await fs.rename(tmp,file);}
function mean(xs:number[]){return xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;}
function sum(xs:number[]){return xs.reduce((a,b)=>a+b,0);}
function n(v:any){const x=Number(v);return Number.isFinite(x)?x:0;}
function verdict(input:{closed:number;realized:number;paperBuys:number;matched:number;eligibleMisses:number;eligibleMissNet:number}){
  if(input.closed>=3&&input.realized<0)return{capitalPermission:"PAUSE",verdict:"PAUSE",reason:"NEGATIVE_REALIZED_WITH_SAMPLE"};
  if(input.closed>=2&&input.realized>0)return{capitalPermission:"PRODUCTION",verdict:"KEEP",reason:"POSITIVE_PROSPECTIVE_REALIZED"};
  if(input.paperBuys>0||input.matched>0)return{capitalPermission:"PROBATION",verdict:"RESTRICT",reason:"SOME_PROSPECTIVE_EVIDENCE_INSUFFICIENT_SAMPLE"};
  if(input.eligibleMisses>0&&input.eligibleMissNet>0)return{capitalPermission:"SHADOW",verdict:"EXPAND_TEST",reason:"POSITIVE_MISSED_ELIGIBLE_EVIDENCE_NO_REALIZED_SAMPLE"};
  return{capitalPermission:"SHADOW",verdict:"SHADOW_ONLY",reason:"INSUFFICIENT_TRANSFER_EVIDENCE"};
}

export async function buildLiveEdgeController(){
  const generatedAt=new Date().toISOString();
  const [odin,truth,paper]=await Promise.all([read(ODIN_PATH,{}),read(TRUTH_PATH,{entries:{}}),read(PAPER_REPORT_PATH,{wallets:[]})]);
  const liveMirrors=(Array.isArray(odin?.mirrors)?odin.mirrors:[]).map((x:any)=>String(x?.address||x?.wallet||x?.sourceWallet||"")).filter(Boolean);
  const truthEntries=Object.values(truth?.entries||{}) as AnyObj[];
  const paperWallets=new Map<string,AnyObj>((Array.isArray(paper?.wallets)?paper.wallets:[]).map((x:any)=>[String(x?.address||x?.wallet||""),x]));
  const scorecards=liveMirrors.map(address=>{
    const rows=truthEntries.filter(x=>String(x?.mirror||"")===address);
    const pw=paperWallets.get(address)||{};
    const matched=rows.filter(x=>x?.state==="FOLLOWER_BUY_MATCHED");
    const blocked=rows.filter(x=>x?.state==="COPY_BLOCKED_BY_ODIN_POLICY");
    const eligibleMisses=rows.filter(x=>x?.state==="EXPECTED_COPY_NOT_MATCHED");
    const eligibleMissNets=eligibleMisses.map(x=>n(x?.sourceRoundTrip?.estimatedFollowerNetSol)).filter(x=>x!==0);
    const blockedNets=blocked.map(x=>n(x?.sourceRoundTrip?.estimatedFollowerNetSol)).filter(x=>x!==0);
    const dailyCapBlocked=blocked.filter(x=>String(x?.executionEvidence?.reason||"").includes("DAILY_CAP"));
    const tokenCapBlocked=blocked.filter(x=>/TOKEN_(DAY|WEEK)_CAP/.test(String(x?.executionEvidence?.reason||"")));
    const closed=n(pw?.closedPositions),realized=n(pw?.realizedNetSol),paperBuys=n(pw?.paperBuys);
    const v=verdict({closed,realized,paperBuys,matched:matched.length,eligibleMisses:eligibleMisses.length,eligibleMissNet:sum(eligibleMissNets)});
    const p=walletPolicy(address);
    return{
      address,
      capitalPermission:v.capitalPermission,
      verdict:v.verdict,
      verdictReason:v.reason,
      currentPolicy:p,
      prospective:{paperBuys,closedPositions:closed,openPositions:n(pw?.openPositions),realizedNetSol:realized,winRate:pw?.winRate??null},
      transferTruth:{opportunities:rows.length,followerBuysMatched:matched.length,policyBlocked:blocked.length,eligibleNotCopied:eligibleMisses.length,eligibleMissEstimatedNetSol:sum(eligibleMissNets),eligibleMissAverageNetSol:mean(eligibleMissNets),dailyCapBlocked:dailyCapBlocked.length,tokenCapBlocked:tokenCapBlocked.length,policyBlockedKnownNetSol:sum(blockedNets)},
      counterfactual:{
        currentDailyCap:p.dailyCap,
        shadowDailyCaps:p.shadowDailyCaps,
        thirdSlotEvidence:dailyCapBlocked.length?{sampleSize:dailyCapBlocked.length,estimatedNetSol:sum(dailyCapBlocked.map(x=>n(x?.sourceRoundTrip?.estimatedFollowerNetSol))),note:"Only DAILY_CAP-blocked opportunities count as direct evidence for a higher daily cap."}:{sampleSize:0,estimatedNetSol:0,note:"No direct daily-cap marginal evidence yet; token-day/week blocks are intentionally excluded."}
      }
    };
  });
  const summary={production:scorecards.filter(x=>x.capitalPermission==="PRODUCTION").length,probation:scorecards.filter(x=>x.capitalPermission==="PROBATION").length,shadow:scorecards.filter(x=>x.capitalPermission==="SHADOW").length,paused:scorecards.filter(x=>x.capitalPermission==="PAUSE").length};
  const out={schemaVersion:1,event:"shark_scout_live_edge_controller_complete",generatedAt,principle:"actual follower and prospective evidence veto historical replay quality",liveMirrorCount:liveMirrors.length,summary,scorecards,guardrails:{mutatesOdin:false,changesCapital:false,changesTips:false,changesSpeed:false,changesFilters:false,changesCaps:false},notes:["Capital permission is advisory only and never mutates Odin.","Policy-blocked misses are separated from execution/transfer misses.","Only DAILY_CAP blocks are admitted into daily-cap expansion evidence; TOKEN_DAY_CAP and TOKEN_WEEK_CAP are not treated as third-slot evidence.","Historical replay is intentionally absent from the promotion rule; prospective follower/paper evidence has veto power."]};
  await atomic(OUT_PATH,out);console.log(JSON.stringify(out));return out;
}

if(import.meta.url===`file://${process.argv[1]}`)buildLiveEdgeController().catch(e=>{console.error(JSON.stringify({event:"shark_scout_live_edge_controller_failed",error:e instanceof Error?e.message:String(e)}));process.exitCode=1;});
