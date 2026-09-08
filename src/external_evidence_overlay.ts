import { promises as fs } from "node:fs";
import path from "node:path";

type AnyObj=Record<string,any>;
const ENGINE_PATH=process.env.SCOUT_ENGINE_INTELLIGENCE_PATH||"/data/engine-intelligence.json";
const EVIDENCE_PATH=process.env.SCOUT_EXTERNAL_EVIDENCE_PATH||path.join(process.cwd(),"config","wallet_external_evidence.json");
const OUT_PATH=process.env.SCOUT_EXTERNAL_EVIDENCE_REPORT_PATH||"/data/external-evidence-overlay.json";
const STALE_DAYS=Math.max(7,Math.min(180,Number(process.env.SCOUT_EXTERNAL_EVIDENCE_STALE_DAYS||30)));

async function readJson(file:string,fallback:any){try{return JSON.parse(await fs.readFile(file,"utf8"));}catch{return fallback;}}
async function atomicSave(file:string,data:any){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;await fs.writeFile(tmp,JSON.stringify(data));await fs.rename(tmp,file);}
function n(v:any){const x=Number(v);return Number.isFinite(x)?x:0;}
function clamp(v:number,min:number,max:number){return Math.max(min,Math.min(max,v));}
function ageDays(v:any){const t=Date.parse(String(v||""));return Number.isFinite(t)?Math.max(0,(Date.now()-t)/86400000):null;}

// v2 is intentionally transparent and conservative, not an empirically fitted model.
// It converts wallet-analyzer copyability hazards into a bounded 0-25 point adjustment.
function riskPenalty(metrics:AnyObj){
  const raw=
    .15*n(metrics?.soldGreaterThanBoughtPct)+
    .20*n(metrics?.didntBuyPct)+
    .25*n(metrics?.instantSellPct)+
    .25*n(metrics?.scamRugTokenPct);
  return Math.round(clamp(raw,0,25));
}

function annotate(row:any,evidenceByWallet:AnyObj){
  if(!row?.address)return row;
  const canonicalPromotionEligible=Boolean(row?.promotionEligible),baseRaw=Number(row?.scores?.overallCopyabilityScore),base=Number.isFinite(baseRaw)?baseRaw:null;
  const ev=evidenceByWallet[row.address];
  if(!ev){
    const blockers=canonicalPromotionEligible?["EXTERNAL_EVIDENCE_UNASSESSED"]:[];
    return {...row,externalEvidence:null,externalRiskPenalty:0,externalRiskStatus:"UNASSESSED",adjustedCopyabilityScore:base,canonicalPromotionEligible,newPromotionReady:false,newPromotionBlockers:blockers};
  }
  const penalty=riskPenalty(ev.metrics||{}),adjusted=base!=null?Math.max(0,base-penalty):null,days=ageDays(ev.observedAt),stale=days!=null&&days>STALE_DAYS,reviewRequired=Boolean(ev.reviewRequired);
  const blockers:string[]=[];
  if(!canonicalPromotionEligible)blockers.push("CANONICAL_PROMOTION_GATE");
  if(reviewRequired)blockers.push("EXTERNAL_REVIEW_REQUIRED");
  if(stale)blockers.push("EXTERNAL_EVIDENCE_STALE");
  const status=reviewRequired?"REVIEW_REQUIRED":stale?"STALE":"OBSERVED";
  return {...row,externalEvidence:{source:ev.source||null,observedAt:ev.observedAt||null,sourceType:ev.sourceType||null,ageDays:days,staleAfterDays:STALE_DAYS,metrics:ev.metrics||{},reviewRequired,notes:Array.isArray(ev.notes)?ev.notes:[]},externalRiskPenalty:penalty,externalRiskStatus:status,adjustedCopyabilityScore:adjusted,canonicalPromotionEligible,newPromotionReady:blockers.length===0,newPromotionBlockers:blockers};
}

async function main(){
  const startedAt=new Date().toISOString(),engine=await readJson(ENGINE_PATH,null),cfg=await readJson(EVIDENCE_PATH,{schemaVersion:1,wallets:{}});
  if(!engine)throw new Error(`engine intelligence not found at ${ENGINE_PATH}`);
  const evidenceByWallet=cfg?.wallets||{};
  const topActionable=(engine?.topActionable||[]).map((x:any)=>annotate(x,evidenceByWallet));
  const topCanonicalOverall=(engine?.topCanonicalOverall||[]).map((x:any)=>annotate(x,evidenceByWallet));
  const topReconstructionPriority=(engine?.topReconstructionPriority||[]).map((x:any)=>annotate(x,evidenceByWallet));
  const newPromotionReady=topActionable.filter((x:any)=>x.newPromotionReady).sort((a:any,b:any)=>Number(b.adjustedCopyabilityScore||0)-Number(a.adjustedCopyabilityScore||0));
  const heldForReview=topActionable.filter((x:any)=>x.canonicalPromotionEligible&&!x.newPromotionReady);
  const out={schemaVersion:2,event:"shark_scout_external_evidence_overlay_complete",startedAt,finishedAt:new Date().toISOString(),evidencePath:EVIDENCE_PATH,evidenceWalletCount:Object.keys(evidenceByWallet).length,canonicalActionableCount:Number(engine?.actionableCount||0),newPromotionReadyCount:newPromotionReady.length,newPromotionReady,heldForReview,topActionableRiskAdjusted:topActionable,topCanonicalOverallRiskAdjusted:topCanonicalOverall,topReconstructionPriorityRiskAdjusted:topReconstructionPriority,notes:["External evidence never changes canonical replay history.","The risk penalty is a transparent bounded heuristic, not a trained probability model.","New promotion requires canonical eligibility plus assessed, non-stale external evidence with no reviewRequired flag.","UNASSESSED applies to new-promotion readiness only; it does not instruct removal of an already-live mirror.","Paper Odin and Dip Shadow remain the forward-validation lanes while a candidate is held for review."]};
  await atomicSave(OUT_PATH,out);
  console.log(JSON.stringify(out));
}

main().catch(e=>{console.error(JSON.stringify({event:"shark_scout_external_evidence_overlay_failed",error:e instanceof Error?e.message:String(e)}));process.exitCode=1;});
