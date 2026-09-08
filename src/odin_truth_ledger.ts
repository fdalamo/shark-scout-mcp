import { promises as fs } from "node:fs";
import path from "node:path";

const OPPORTUNITY_PATH=process.env.SCOUT_OPPORTUNITY_PATH||"/data/mirror-opportunity-audit.json";
const PAPER_STATE_PATH=process.env.SCOUT_PAPER_ODIN_STATE_PATH||"/data/paper-odin-state.json";
const STATE_PATH=process.env.SCOUT_ODIN_TRUTH_LEDGER_PATH||"/data/odin-truth-ledger.json";
const OUT_PATH=process.env.SCOUT_ODIN_TRUTH_REPORT_PATH||"/data/odin-truth-report.json";

type AnyObj=Record<string,any>;
function now(){return new Date().toISOString();}
async function read(file:string,fallback:any){try{return JSON.parse(await fs.readFile(file,"utf8"));}catch{return fallback;}}
async function atomic(file:string,data:any){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;await fs.writeFile(tmp,JSON.stringify(data));await fs.rename(tmp,file);}

function paperDecision(ledger:any[],opportunityId:string){
  const rows=ledger.filter((x:any)=>x?.opportunityId===opportunityId);
  const buy=rows.find((x:any)=>x?.action==="PAPER_BUY");
  if(buy)return{classification:"ODIN_ELIGIBLE",reason:null,marketAtDetection:buy.marketAtDetection??null,policyFingerprint:buy.policyFingerprint??buy.policyAtEntry??null};
  const skip=rows.find((x:any)=>x?.action==="SKIP_BUY");
  if(skip)return{classification:"ODIN_INELIGIBLE",reason:String(skip.reason||"UNKNOWN"),marketAtDetection:skip.marketAtDetection??null,policyFingerprint:skip.policyFingerprint??null};
  const signal=rows.find((x:any)=>x?.action==="SIGNAL"&&x?.side==="BUY");
  return signal?{classification:"ELIGIBILITY_UNRESOLVED",reason:null,marketAtDetection:null,policyFingerprint:signal.policyFingerprint??null}:{classification:"PAPER_SIGNAL_NOT_OBSERVED",reason:null,marketAtDetection:null,policyFingerprint:null};
}

function terminalState(x:any,decision:any){
  if(x?.copied)return "FOLLOWER_BUY_MATCHED";
  if(decision.classification==="ODIN_INELIGIBLE")return "ODIN_INELIGIBLE";
  if(decision.classification==="ODIN_ELIGIBLE")return "EXPECTED_COPY_NOT_MATCHED";
  return "SEEN_ELIGIBILITY_UNKNOWN";
}

async function main(){
  const startedAt=now();
  const [op,paper,state]=await Promise.all([read(OPPORTUNITY_PATH,{}),read(PAPER_STATE_PATH,{ledger:[]}),read(STATE_PATH,{schemaVersion:1,entries:{}})]);
  state.schemaVersion=1;state.entries||={};
  const paperLedger=Array.isArray(paper?.ledger)?paper.ledger:[];
  let observed=0,created=0,updated=0;
  for(const mirror of Array.isArray(op?.perMirror)?op.perMirror:[]){
    for(const x of Array.isArray(mirror?.opportunityDetails)?mirror.opportunityDetails:[]){
      const sourceSignature=String(x?.sourceSignature||"").trim();
      const opportunityId=String(x?.opportunityId||`${mirror?.mirror||x?.mirror}|${sourceSignature}`).trim();
      if(!sourceSignature||!opportunityId)continue;observed++;
      const decision=paperDecision(paperLedger,opportunityId),prior=state.entries[opportunityId] as AnyObj|undefined;
      const next={
        ...(prior||{}),opportunityId,mirror:String(x?.mirror||mirror?.mirror||""),mint:String(x?.mint||""),sourceSignature,
        sourceTimestamp:Number(x?.sourceTimestamp||0)||null,sourceBuyAt:x?.sourceBuyAt||null,firstObservedAt:prior?.firstObservedAt||now(),lastObservedAt:now(),
        odinEligibility:decision.classification,odinSkipReason:decision.reason,marketAtDetection:decision.marketAtDetection??prior?.marketAtDetection??null,
        copied:Boolean(x?.copied),copySignature:x?.copySignature||prior?.copySignature||null,copyDelaySeconds:x?.copyDelaySeconds??prior?.copyDelaySeconds??null,
        sourceRoundTrip:x?.sourceRoundTrip??prior?.sourceRoundTrip??null,classification:x?.classification||prior?.classification||null,
        followerExitObserved:Boolean(x?.followerExitObserved??prior?.followerExitObserved),followerExitSignature:x?.followerExitSignature||prior?.followerExitSignature||null,
        state:terminalState(x,decision)
      };
      state.entries[opportunityId]=next;prior?updated++:created++;
    }
  }
  const entries=Object.values(state.entries) as AnyObj[];
  entries.sort((a,b)=>Number(a.sourceTimestamp||0)-Number(b.sourceTimestamp||0));
  if(entries.length>4000){const keep=entries.slice(-4000);state.entries=Object.fromEntries(keep.map(x=>[x.opportunityId,x]));}
  state.updatedAt=now();await atomic(STATE_PATH,state);
  const values=Object.values(state.entries) as AnyObj[],counts:Record<string,number>={};for(const x of values)counts[String(x.state||"UNKNOWN")]=(counts[String(x.state||"UNKNOWN")]||0)+1;
  const report={schemaVersion:1,event:"shark_scout_odin_truth_ledger_complete",startedAt,finishedAt:now(),observed,created,updated,totalEntries:values.length,stateCounts:counts,
    expectedCopyMisses:values.filter(x=>x.state==="EXPECTED_COPY_NOT_MATCHED").slice(-50),unknownEligibility:values.filter(x=>x.state==="SEEN_ELIGIBILITY_UNKNOWN").slice(-50),
    notes:["Deterministic identity is mirror|source-signature; mint/time matching is never the primary key.","Paper Odin supplies explainable eligibility when the prospective source signal was observed; otherwise eligibility remains unknown rather than guessed.","Follower matching is observational and never changes Odin controls or live capital."]};
  await atomic(OUT_PATH,report);console.log(JSON.stringify(report));
}
main().catch(e=>{console.error(JSON.stringify({event:"shark_scout_odin_truth_ledger_failed",error:e instanceof Error?e.message:String(e)}));process.exitCode=1;});
