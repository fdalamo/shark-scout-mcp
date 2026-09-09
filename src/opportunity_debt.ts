import { promises as fs } from "node:fs";
import path from "node:path";

type AnyObj=Record<string,any>;
type Debt={key:string;kind:string;priority:number;mirror?:string|null;mint?:string|null;sourceSignature?:string|null;reason:string;estimatedNetSol?:number|null;waitFor?:string|null;createdAt:string;updatedAt:string};

const POLICY_PATH=process.env.SCOUT_FOLLOWER_POLICY_LEDGER_PATH||"/data/follower-policy-ledger.json";
const LIVE_EDGE_PATH=process.env.SCOUT_LIVE_EDGE_PATH||"/data/live-edge-controller.json";
const OUT_PATH=process.env.SCOUT_OPPORTUNITY_DEBT_PATH||"/data/opportunity-debt.json";

async function read(file:string,fallback:any){try{return JSON.parse(await fs.readFile(file,"utf8"));}catch{return fallback;}}
async function atomic(file:string,data:any){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;await fs.writeFile(tmp,JSON.stringify(data,null,2));await fs.rename(tmp,file);}
function num(v:any):number|null{const n=Number(v);return Number.isFinite(n)?n:null;}
function now(){return new Date().toISOString();}
function clamp(n:number,min:number,max:number){return Math.max(min,Math.min(max,n));}

export async function buildOpportunityDebt(){
  const generatedAt=now();
  const [policy,live,prior]=await Promise.all([read(POLICY_PATH,{entries:{}}),read(LIVE_EDGE_PATH,{scorecards:[]}),read(OUT_PATH,{items:{}})]);
  const old:Record<string,Debt>=prior?.items&&typeof prior.items==="object"?prior.items:{};
  const items:Record<string,Debt>={};
  const entries=Object.values(policy?.entries||{}) as AnyObj[];

  for(const row of entries){
    const mirror=String(row?.mirror||"");const sig=String(row?.sourceSignature||"");if(!mirror||!sig)continue;
    const estimated=num(row?.estimatedFollowerNetSol),mint=row?.mint?String(row.mint):null;
    if(row?.odinDecision==="ELIGIBLE_NOT_COPIED"){
      const key=`eligible_not_copied|${mirror}|${sig}`;const prev=old[key];
      const priority=estimated!==null&&estimated>0?100:92;
      items[key]={key,kind:"ELIGIBLE_NOT_COPIED",priority,mirror,mint,sourceSignature:sig,reason:estimated!==null?`Odin-eligible source trade did not match follower; modeled follower outcome ${estimated.toFixed(6)} SOL.`:"Odin-eligible source trade did not match follower; execution cause unresolved.",estimatedNetSol:estimated,waitFor:"FOLLOWER_MATCH_OR_EXECUTION_EVIDENCE",createdAt:prev?.createdAt||generatedAt,updatedAt:generatedAt};
    }
    if(row?.odinDecision==="COPIED"&&row?.sourceRoundTrip&& !row?.followerExitObserved){
      const key=`matched_open_exit|${mirror}|${sig}`;const prev=old[key];
      items[key]={key,kind:"MATCHED_COPY_EXIT_UNRESOLVED",priority:96,mirror,mint,sourceSignature:sig,reason:"Follower buy is matched and source round-trip exists, but follower exit is not yet attributed.",estimatedNetSol:estimated,waitFor:"FOLLOWER_EXIT_OR_EXIT_ATTRIBUTION",createdAt:prev?.createdAt||generatedAt,updatedAt:generatedAt};
    }
    if(row?.odinDecision==="UNKNOWN"){
      const key=`unknown_policy|${mirror}|${sig}`;const prev=old[key];
      items[key]={key,kind:"POLICY_DECISION_UNKNOWN",priority:78,mirror,mint,sourceSignature:sig,reason:"Source opportunity exists but Odin eligibility/policy disposition is unresolved.",estimatedNetSol:estimated,waitFor:"POLICY_OR_EXECUTION_EVIDENCE",createdAt:prev?.createdAt||generatedAt,updatedAt:generatedAt};
    }
  }

  const scorecards=Array.isArray(live?.scorecards)?live.scorecards:[];
  for(const card of scorecards){
    const mirror=String(card?.address||"");if(!mirror)continue;
    const permission=String(card?.capitalPermission||"SHADOW");
    const matched=Number(card?.transferTruth?.followerBuysMatched||0),paper=Number(card?.prospective?.paperBuys||0),closed=Number(card?.prospective?.closedPositions||0);
    if((permission==="SHADOW"||permission==="PROBATION")&&matched<2&&closed<3){
      const key=`mirror_transfer_sample|${mirror}`;const prev=old[key];
      const priority=permission==="PROBATION"?88:72;
      items[key]={key,kind:"MIRROR_TRANSFER_SAMPLE",priority,mirror,reason:`${permission} mirror lacks enough prospective follower evidence (${matched} matched, ${paper} paper buys, ${closed} closed).`,waitFor:"MORE_PROSPECTIVE_COPY_OUTCOMES",createdAt:prev?.createdAt||generatedAt,updatedAt:generatedAt};
    }
  }

  const ordered=Object.values(items).sort((a,b)=>b.priority-a.priority||a.key.localeCompare(b.key));
  const summary={total:ordered.length,p0:ordered.filter(x=>x.priority>=95).length,p1:ordered.filter(x=>x.priority>=80&&x.priority<95).length,p2:ordered.filter(x=>x.priority<80).length,eligibleNotCopied:ordered.filter(x=>x.kind==="ELIGIBLE_NOT_COPIED").length,matchedExitUnresolved:ordered.filter(x=>x.kind==="MATCHED_COPY_EXIT_UNRESOLVED").length,policyUnknown:ordered.filter(x=>x.kind==="POLICY_DECISION_UNKNOWN").length,mirrorTransferSample:ordered.filter(x=>x.kind==="MIRROR_TRANSFER_SAMPLE").length};
  const out={schemaVersion:1,event:"shark_scout_opportunity_debt_complete",generatedAt,summary,top:ordered.slice(0,12),items:Object.fromEntries(ordered.map(x=>[x.key,x])),notes:["Opportunity debt is not generic backlog. It contains unresolved facts that can change a live capital or configuration decision.","Items disappear automatically when the underlying follower-policy/live-edge evidence resolves them.","Priority >=95 is live execution/exit truth; fresh-wallet exploration remains separate so the engine does not overfit current mirrors."],guardrails:{observationalOnly:true,mutatesOdin:false}};
  await atomic(OUT_PATH,out);
  console.log(JSON.stringify(out));
  return out;
}

if(import.meta.url===`file://${process.argv[1]}`)buildOpportunityDebt().catch(e=>{console.error(JSON.stringify({event:"shark_scout_opportunity_debt_failed",error:e instanceof Error?e.message:String(e)}));process.exitCode=1;});
