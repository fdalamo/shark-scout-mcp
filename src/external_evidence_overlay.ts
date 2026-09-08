import { promises as fs } from "node:fs";
import path from "node:path";

type AnyObj=Record<string,any>;
const ENGINE_PATH=process.env.SCOUT_ENGINE_INTELLIGENCE_PATH||"/data/engine-intelligence.json";
const EVIDENCE_PATH=process.env.SCOUT_EXTERNAL_EVIDENCE_PATH||path.join(process.cwd(),"config","wallet_external_evidence.json");
const OUT_PATH=process.env.SCOUT_EXTERNAL_EVIDENCE_REPORT_PATH||"/data/external-evidence-overlay.json";

async function readJson(file:string,fallback:any){try{return JSON.parse(await fs.readFile(file,"utf8"));}catch{return fallback;}}
async function atomicSave(file:string,data:any){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;await fs.writeFile(tmp,JSON.stringify(data));await fs.rename(tmp,file);}
function n(v:any){const x=Number(v);return Number.isFinite(x)?x:0;}
function clamp(v:number,min:number,max:number){return Math.max(min,Math.min(max,v));}

// v1 is intentionally transparent and conservative, not an empirically fitted model.
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
  const ev=evidenceByWallet[row.address];
  if(!ev)return {...row,externalEvidence:null,externalRiskPenalty:0,externalRiskStatus:"UNASSESSED",adjustedCopyabilityScore:row?.scores?.overallCopyabilityScore??null,liveReady:Boolean(row?.promotionEligible)};
  const penalty=riskPenalty(ev.metrics||{}),base=Number(row?.scores?.overallCopyabilityScore),adjusted=Number.isFinite(base)?Math.max(0,base-penalty):null;
  return {...row,externalEvidence:{source:ev.source||null,observedAt:ev.observedAt||null,sourceType:ev.sourceType||null,metrics:ev.metrics||{},reviewRequired:Boolean(ev.reviewRequired),notes:Array.isArray(ev.notes)?ev.notes:[]},externalRiskPenalty:penalty,externalRiskStatus:ev.reviewRequired?"REVIEW_REQUIRED":"OBSERVED",adjustedCopyabilityScore:adjusted,canonicalPromotionEligible:Boolean(row?.promotionEligible),liveReady:Boolean(row?.promotionEligible)&&!Boolean(ev.reviewRequired)};
}

async function main(){
  const startedAt=new Date().toISOString(),engine=await readJson(ENGINE_PATH,null),cfg=await readJson(EVIDENCE_PATH,{schemaVersion:1,wallets:{}});
  if(!engine)throw new Error(`engine intelligence not found at ${ENGINE_PATH}`);
  const evidenceByWallet=cfg?.wallets||{};
  const topActionable=(engine?.topActionable||[]).map((x:any)=>annotate(x,evidenceByWallet));
  const topCanonicalOverall=(engine?.topCanonicalOverall||[]).map((x:any)=>annotate(x,evidenceByWallet));
  const topReconstructionPriority=(engine?.topReconstructionPriority||[]).map((x:any)=>annotate(x,evidenceByWallet));
  const topLiveReady=topActionable.filter((x:any)=>x.liveReady).sort((a:any,b:any)=>Number(b.adjustedCopyabilityScore||0)-Number(a.adjustedCopyabilityScore||0));
  const heldForExternalReview=topActionable.filter((x:any)=>x.externalRiskStatus==="REVIEW_REQUIRED");
  const out={schemaVersion:1,event:"shark_scout_external_evidence_overlay_complete",startedAt,finishedAt:new Date().toISOString(),evidencePath:EVIDENCE_PATH,evidenceWalletCount:Object.keys(evidenceByWallet).length,canonicalActionableCount:Number(engine?.actionableCount||0),topLiveReadyCount:topLiveReady.length,topLiveReady,heldForExternalReview,topActionableRiskAdjusted:topActionable,topCanonicalOverallRiskAdjusted:topCanonicalOverall,topReconstructionPriorityRiskAdjusted:topReconstructionPriority,notes:["External evidence never changes canonical replay history.","The v1 risk penalty is a transparent bounded heuristic, not a trained probability model.","reviewRequired blocks live-readiness while preserving Paper Odin/Dip Shadow tracking.","Missing external evidence is UNASSESSED, not evidence of low risk."]};
  await atomicSave(OUT_PATH,out);
  console.log(JSON.stringify(out));
}

main().catch(e=>{console.error(JSON.stringify({event:"shark_scout_external_evidence_overlay_failed",error:e instanceof Error?e.message:String(e)}));process.exitCode=1;});
