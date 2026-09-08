import { promises as fs } from "node:fs";
import path from "node:path";
import { metrics, type Layer, type TradeResult } from "./ab_metrics.js";
import { sha256, stableJson } from "./prospective_ab_lab.js";

const OPPORTUNITY_PATH=process.env.SCOUT_OPPORTUNITY_PATH||"/data/mirror-opportunity-audit.json";
const TRUTH_PATH=process.env.SCOUT_ODIN_TRUTH_LEDGER_PATH||"/data/odin-truth-ledger.json";
const PORTFOLIO_CACHE_PATH=process.env.SCOUT_PORTFOLIO_HISTORY_CACHE||"/data/portfolio-history-cache.json";
const ODIN_PATH=process.env.SCOUT_ODIN_SNAPSHOT_PATH||"/data/odin-config.json";
const FUNNEL_PATH=process.env.SCOUT_EVIDENCE_FUNNEL_PATH||"/data/evidence-funnel.json";
const STATE_PATH=process.env.SCOUT_ODIN_TRANSFER_STATE_PATH||"/data/odin-transfer-state.json";
const OUT_PATH=process.env.SCOUT_ODIN_TRANSFER_REPORT_PATH||"/data/odin-transfer-report.json";
const RESULTS_PATH=process.env.SCOUT_EXPERIMENT_RESULTS_PATH||"/data/prospective-ab/experiment-results.jsonl";
const NORMALIZED_SOURCE_SIZE=Math.max(.01,Math.min(1,Number(process.env.ODIN_TRANSFER_SOURCE_SIZE_SOL||.075)));
const MAX_ROWS=Math.max(500,Math.min(20000,Number(process.env.ODIN_TRANSFER_MAX_ROWS||8000)));

type AnyObj=Record<string,any>;
type FollowerEvent={signature:string;ts:number|null;mint:string;side:"BUY"|"SELL";qty:number;sol:number;confidence?:string;quote?:string};
type State={schemaVersion:number;rows:Record<string,TradeResult>;updatedAt?:string};

function now(){return new Date().toISOString();}
function n(v:any){const x=Number(v);return Number.isFinite(x)?x:null;}
function clamp01(v:number){return Math.max(0,Math.min(1,v));}
async function read(file:string,fallback:any){try{return JSON.parse(await fs.readFile(file,"utf8"));}catch{return fallback;}}
async function atomic(file:string,data:string){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;await fs.writeFile(tmp,data);await fs.rename(tmp,file);}
function resultId(wallet:string,opportunityId:string,layer:Layer){return sha256(`${wallet}|${opportunityId}|${layer}`);}
function addRow(state:State,row:TradeResult){state.rows[row.tradeId]=row;}
function sourceResolvedAt(x:any){const ts=n(x?.sourceRoundTrip?.finalSellTimestamp);return ts&&ts>0?new Date(ts*1000).toISOString():String(x?.sourceBuyAt||now());}
function truthMap(truth:any){return new Map(Object.values(truth?.entries||{}).map((x:any)=>[String(x?.opportunityId||""),x]));}

function followerLots(cache:any){
  const events=(Object.values(cache?.events||{}) as FollowerEvent[]).filter(e=>e&&e.signature&&e.mint&&e.qty>0&&e.sol>=0&&e.ts!=null).sort((a,b)=>Number(a.ts)-Number(b.ts));
  type Lot={signature:string;mint:string;ts:number;qtyInitial:number;qtyRemaining:number;costSol:number;proceedsSol:number;soldQty:number;resolvedAt:string|null};
  const open=new Map<string,Lot[]>(),all=new Map<string,Lot>();
  for(const e of events){
    if(e.side==="BUY"){
      const lot:Lot={signature:e.signature,mint:e.mint,ts:Number(e.ts),qtyInitial:e.qty,qtyRemaining:e.qty,costSol:e.sol,proceedsSol:0,soldQty:0,resolvedAt:null};
      const q=open.get(e.mint)||[];q.push(lot);open.set(e.mint,q);all.set(lot.signature,lot);continue;
    }
    let remain=e.qty;const q=open.get(e.mint)||[];
    while(remain>1e-12&&q.length){
      const lot=q[0]!,take=Math.min(remain,lot.qtyRemaining),frac=e.qty>0?take/e.qty:0;
      lot.qtyRemaining-=take;lot.soldQty+=take;lot.proceedsSol+=e.sol*frac;remain-=take;
      if(lot.qtyRemaining<=lot.qtyInitial*.10){lot.resolvedAt=new Date(Number(e.ts)*1000).toISOString();q.shift();}
      else if(take<=1e-12)break;
    }
    open.set(e.mint,q);
  }
  return all;
}

function cohortSets(odin:any,funnel:any){
  const live=new Set((Array.isArray(odin?.mirrors)?odin.mirrors:[]).map((x:any)=>String(x?.address||"")).filter(Boolean));
  const research=new Set((Array.isArray(funnel?.topActionable)?funnel.topActionable:[]).map((x:any)=>String(x?.address||"")).filter((x:string)=>x&&!live.has(x)));
  const controls=new Set((Array.isArray(funnel?.topNearPasses)?funnel.topNearPasses:[]).map((x:any)=>String(x?.address||"")).filter((x:string)=>x&&!live.has(x)&&!research.has(x)));
  return{live,research,controls};
}

function otsFor(rows:TradeResult[],wallet:string,live:boolean){
  const perfect=rows.filter(x=>x.wallet===wallet&&x.layer==="PERFECT_COPY"),sim=rows.filter(x=>x.wallet===wallet&&x.layer==="SIMULATED_ODIN"),actual=rows.filter(x=>x.wallet===wallet&&x.layer==="ACTUAL_ODIN");
  const pm=metrics(perfect),sm=metrics(sim),am=metrics(actual),eligibilityCapture=perfect.length?sim.length/perfect.length:null,actualCapture=sim.length?actual.length/sim.length:null;
  const robustness=sm.netSol>0?clamp01(sm.stress50/sm.netSol):sm.stress50>0?1:0;
  const expectancy=sm.n?clamp01(.5+sm.medianTrade/.075):0;
  const transfer=sm.netSol>0&&am.n?clamp01(am.netSol/sm.netSol):live?0:1;
  const capture=eligibilityCapture==null?0:clamp01(eligibilityCapture),landing=live?(actualCapture==null?0:clamp01(actualCapture)):1;
  const sample=clamp01((live?am.n:sm.n)/20);
  const components=[Math.max(.01,capture),Math.max(.01,robustness),Math.max(.01,expectancy),Math.max(.01,transfer),Math.max(.01,landing)];
  const geometric=Math.pow(components.reduce((a,b)=>a*b,1),1/components.length);
  return{score:Math.round(100*geometric*(.35+.65*sample)),sampleAdequacy:sample,eligibilityCapture,actualCapture,perfect:pm,simulated:sm,actual:am,components:{capture,robustness,expectancy,executionTransfer:transfer,landingCapture:landing}};
}

async function main(){
  const startedAt=now();
  const [op,truth,portfolio,odin,funnel,state0]=await Promise.all([
    read(OPPORTUNITY_PATH,{}),read(TRUTH_PATH,{entries:{}}),read(PORTFOLIO_CACHE_PATH,{events:{}}),read(ODIN_PATH,{}),read(FUNNEL_PATH,{}),read(STATE_PATH,{schemaVersion:1,rows:{}})
  ]);
  const state:State={schemaVersion:1,rows:state0?.rows&&typeof state0.rows==="object"?state0.rows:{}};
  const tmap=truthMap(truth),lots=followerLots(portfolio);let opportunities=0,sourceResolved=0,simulatedResolved=0,actualResolved=0;
  for(const mirror of Array.isArray(op?.perMirror)?op.perMirror:[]){
    const wallet=String(mirror?.mirror||"");if(!wallet)continue;
    for(const x of Array.isArray(mirror?.opportunityDetails)?mirror.opportunityDetails:[]){
      const opportunityId=String(x?.opportunityId||"");if(!opportunityId)continue;opportunities++;
      const rt=x?.sourceRoundTrip,roi=n(rt?.sourceRoi),perfectNet=n(rt?.estimatedFollowerNetSol);if(roi==null||perfectNet==null)continue;
      const eligibleAt=String(x?.sourceBuyAt||new Date(Number(x?.sourceTimestamp||0)*1000).toISOString()),resolvedAt=sourceResolvedAt(x);
      addRow(state,{tradeId:resultId(wallet,opportunityId,"SOURCE"),wallet,layer:"SOURCE",netSol:NORMALIZED_SOURCE_SIZE*roi,eligibleAt,resolvedAt,topWinnerKey:String(x?.mint||opportunityId)});
      addRow(state,{tradeId:resultId(wallet,opportunityId,"PERFECT_COPY"),wallet,layer:"PERFECT_COPY",netSol:perfectNet,eligibleAt,resolvedAt,topWinnerKey:String(x?.mint||opportunityId)});sourceResolved++;
      const tv=tmap.get(opportunityId) as AnyObj|undefined;
      if(tv?.odinEligibility==="ODIN_ELIGIBLE"){
        addRow(state,{tradeId:resultId(wallet,opportunityId,"SIMULATED_ODIN"),wallet,layer:"SIMULATED_ODIN",netSol:perfectNet,eligibleAt,resolvedAt,topWinnerKey:String(x?.mint||opportunityId)});simulatedResolved++;
      }
      const copySig=String(x?.copySignature||tv?.copySignature||"");const lot=copySig?lots.get(copySig):undefined;
      if(lot&&lot.qtyInitial>0&&lot.soldQty>=lot.qtyInitial*.90&&lot.resolvedAt){
        const actualNet=lot.proceedsSol-lot.costSol;
        addRow(state,{tradeId:resultId(wallet,opportunityId,"ACTUAL_ODIN"),wallet,layer:"ACTUAL_ODIN",netSol:actualNet,eligibleAt,resolvedAt:lot.resolvedAt,topWinnerKey:String(x?.mint||opportunityId)});actualResolved++;
      }
    }
  }
  let rows=Object.values(state.rows).sort((a,b)=>String(a.resolvedAt).localeCompare(String(b.resolvedAt))||a.tradeId.localeCompare(b.tradeId));
  if(rows.length>MAX_ROWS){rows=rows.slice(-MAX_ROWS);state.rows=Object.fromEntries(rows.map(x=>[x.tradeId,x]));}
  state.updatedAt=now();
  await atomic(STATE_PATH,JSON.stringify(state));await atomic(RESULTS_PATH,rows.map(x=>JSON.stringify(x)).join("\n")+(rows.length?"\n":""));
  const cohorts=cohortSets(odin,funnel),wallets=[...new Set(rows.map(x=>x.wallet))].sort();
  const perWallet=wallets.map(wallet=>({wallet,role:cohorts.live.has(wallet)?"LIVE":cohorts.research.has(wallet)?"RESEARCH":cohorts.controls.has(wallet)?"CONTROL":"OBSERVED",ots:otsFor(rows,wallet,cohorts.live.has(wallet))})).sort((a,b)=>b.ots.score-a.ots.score);
  const layerTotals=Object.fromEntries((["SOURCE","PERFECT_COPY","SIMULATED_ODIN","ACTUAL_ODIN"] as Layer[]).map(layer=>[layer,metrics(rows.filter(x=>x.layer===layer))]));
  const report={schemaVersion:1,event:"shark_scout_odin_transfer_lab_complete",startedAt,finishedAt:now(),opportunities,sourceResolved,simulatedResolved,actualResolved,totalTradeRows:rows.length,cohorts:{live:[...cohorts.live].sort(),research:[...cohorts.research].sort(),controls:[...cohorts.controls].sort()},layerTotals,perWallet,methodology:{source:"Source ROI normalized to configured source-size SOL.",perfectCopy:"Source round-trip replayed at Odin-sized economics from opportunity audit.",simulatedOdin:"Perfect-copy result included only when Paper Odin classified the source opportunity ODIN_ELIGIBLE.",actualOdin:"Follower wallet FIFO lot reconstructed from exact matched copy signature and on-chain SOL deltas; emitted only after >=90% of that lot is sold.",ots:"Sample-adjusted geometric transferability score. Advisory research ranking only; never mutates Odin."},guardrails:{advisoryOnly:true,odinMutation:false,capitalMutation:false,mirrorMutation:false},hash:sha256(stableJson(rows))};
  await atomic(OUT_PATH,JSON.stringify(report));console.log(JSON.stringify(report));
}
main().catch(e=>{console.error(JSON.stringify({event:"shark_scout_odin_transfer_lab_failed",error:e instanceof Error?e.message:String(e)}));process.exitCode=1;});
