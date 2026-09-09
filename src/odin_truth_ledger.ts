import { promises as fs } from "node:fs";
import path from "node:path";
import { researchFocusWallets, walletPolicy } from "./wallet_policy.js";

const OPPORTUNITY_PATH=process.env.SCOUT_OPPORTUNITY_PATH||"/data/mirror-opportunity-audit.json";
const PAPER_STATE_PATH=process.env.SCOUT_PAPER_ODIN_STATE_PATH||"/data/paper-odin-state.json";
const STATE_PATH=process.env.SCOUT_ODIN_TRUTH_LEDGER_PATH||"/data/odin-truth-ledger.json";
const OUT_PATH=process.env.SCOUT_ODIN_TRUTH_REPORT_PATH||"/data/odin-truth-report.json";
const EXECUTION_EVIDENCE_PATH=process.env.SCOUT_ODIN_EXECUTION_EVIDENCE_PATH||"/data/odin-execution-evidence.json";

const POLICY_KNOWN=new Set(researchFocusWallets());
type AnyObj=Record<string,any>;
function now(){return new Date().toISOString();}
async function read(file:string,fallback:any){try{return JSON.parse(await fs.readFile(file,"utf8"));}catch{return fallback;}}
async function atomic(file:string,data:any){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;await fs.writeFile(tmp,JSON.stringify(data));await fs.rename(tmp,file);}
function utcDay(ts:number){return new Date(ts*1000).toISOString().slice(0,10);}
function utcHour(ts:number){return new Date(ts*1000).toISOString().slice(0,13);}
function isoWeekKey(sec:number){const d=new Date(sec*1000),u=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()));const day=u.getUTCDay()||7;u.setUTCDate(u.getUTCDate()+4-day);const y0=new Date(Date.UTC(u.getUTCFullYear(),0,1));const week=Math.ceil((((u.getTime()-y0.getTime())/86400000)+1)/7);return `${u.getUTCFullYear()}-W${String(week).padStart(2,"0")}`;}

function paperDecision(ledger:any[],opportunityId:string){
  const rows=ledger.filter((x:any)=>x?.opportunityId===opportunityId);
  const buy=rows.find((x:any)=>x?.action==="PAPER_BUY");
  if(buy)return{classification:"ODIN_ELIGIBLE",reason:null,marketAtDetection:buy.marketAtDetection??null,policyFingerprint:buy.policyFingerprint??buy.policyAtEntry??null};
  const skip=rows.find((x:any)=>x?.action==="SKIP_BUY");
  if(skip)return{classification:"ODIN_INELIGIBLE",reason:String(skip.reason||"UNKNOWN"),marketAtDetection:skip.marketAtDetection??null,policyFingerprint:skip.policyFingerprint??null};
  const signal=rows.find((x:any)=>x?.action==="SIGNAL"&&x?.side==="BUY");
  return signal?{classification:"ELIGIBILITY_UNRESOLVED",reason:null,marketAtDetection:null,policyFingerprint:signal.policyFingerprint??null}:{classification:"PAPER_SIGNAL_NOT_OBSERVED",reason:null,marketAtDetection:null,policyFingerprint:null};
}

function exactEvidence(evidence:any,opportunityId:string,sourceSignature:string){
  const entries=evidence?.entries||evidence||{};
  const x=entries?.[opportunityId]??entries?.[sourceSignature]??null;
  if(!x)return null;
  const reason=String(x?.reason||x?.skipReason||x?.classification||"UNKNOWN").toUpperCase();
  return{reason,category:String(x?.category||(/CAP|LIMIT|MAX_BUY/.test(reason)?"POLICY_LIMIT":"EXACT_LOG")).toUpperCase(),source:String(x?.source||"EXTERNAL_ODIN_LOG"),observedAt:x?.observedAt||null,detail:x?.detail||null};
}

function reconstructedCapEvidence(x:any,prior:any[]){
  const mirror=String(x?.mirror||""),ts=Number(x?.sourceTimestamp||0),mint=String(x?.mint||"");
  if(!POLICY_KNOWN.has(mirror)||!ts)return null;
  const p=walletPolicy(mirror),earlier=prior.filter(y=>Boolean(y?.copied)&&Number(y?.sourceTimestamp||0)>0&&Number(y.sourceTimestamp)<ts);
  const day=utcDay(ts),hour=utcHour(ts),week=isoWeekKey(ts);
  const daily=earlier.filter(y=>utcDay(Number(y.sourceTimestamp))===day).length;
  const hourly=earlier.filter(y=>utcHour(Number(y.sourceTimestamp))===hour).length;
  const tokenDay=earlier.filter(y=>String(y?.mint||"")===mint&&utcDay(Number(y.sourceTimestamp))===day).length;
  const tokenWeek=earlier.filter(y=>String(y?.mint||"")===mint&&isoWeekKey(Number(y.sourceTimestamp))===week).length;
  if(daily>=p.dailyCap)return{reason:"DAILY_CAP_RECONSTRUCTED",category:"POLICY_LIMIT",source:"OBSERVED_PRIOR_MATCHED_COPIES",confidence:"HIGH",cap:p.dailyCap,observedCount:daily,window:day};
  if(hourly>=p.hourlyCap)return{reason:"HOURLY_CAP_RECONSTRUCTED",category:"POLICY_LIMIT",source:"OBSERVED_PRIOR_MATCHED_COPIES",confidence:"HIGH",cap:p.hourlyCap,observedCount:hourly,window:hour};
  if(tokenDay>=p.tokenDayCap)return{reason:"TOKEN_DAY_CAP_RECONSTRUCTED",category:"POLICY_LIMIT",source:"OBSERVED_PRIOR_MATCHED_COPIES",confidence:"HIGH",cap:p.tokenDayCap,observedCount:tokenDay,window:`${mint}|${day}`};
  if(tokenWeek>=p.tokenWeekCap)return{reason:"TOKEN_WEEK_CAP_RECONSTRUCTED",category:"POLICY_LIMIT",source:"OBSERVED_PRIOR_MATCHED_COPIES",confidence:"HIGH",cap:p.tokenWeekCap,observedCount:tokenWeek,window:`${mint}|${week}`};
  return null;
}

function terminalState(x:any,decision:any,executionEvidence:any){
  if(x?.copied)return "FOLLOWER_BUY_MATCHED";
  if(executionEvidence?.category==="POLICY_LIMIT")return "COPY_BLOCKED_BY_ODIN_POLICY";
  if(executionEvidence)return "COPY_NOT_MATCHED_EXPLAINED";
  if(decision.classification==="ODIN_INELIGIBLE")return "ODIN_INELIGIBLE";
  if(decision.classification==="ODIN_ELIGIBLE")return "EXPECTED_COPY_NOT_MATCHED";
  return "SEEN_ELIGIBILITY_UNKNOWN";
}

async function main(){
  const startedAt=now();
  const [op,paper,state,executionEvidence]=await Promise.all([read(OPPORTUNITY_PATH,{}),read(PAPER_STATE_PATH,{ledger:[]}),read(STATE_PATH,{schemaVersion:2,entries:{}}),read(EXECUTION_EVIDENCE_PATH,{schemaVersion:1,entries:{}})]);
  state.schemaVersion=2;state.entries||={};
  const paperLedger=Array.isArray(paper?.ledger)?paper.ledger:[];
  let observed=0,created=0,updated=0,exactEvidenceCount=0,reconstructedCapCount=0;
  for(const mirror of Array.isArray(op?.perMirror)?op.perMirror:[]){
    const details=(Array.isArray(mirror?.opportunityDetails)?mirror.opportunityDetails:[]).slice().sort((a:any,b:any)=>Number(a?.sourceTimestamp||0)-Number(b?.sourceTimestamp||0));
    const priorObserved:any[]=[];
    for(const x of details){
      const sourceSignature=String(x?.sourceSignature||"").trim();
      const opportunityId=String(x?.opportunityId||`${mirror?.mirror||x?.mirror}|${sourceSignature}`).trim();
      if(!sourceSignature||!opportunityId)continue;observed++;
      const decision=paperDecision(paperLedger,opportunityId),prior=state.entries[opportunityId] as AnyObj|undefined;
      const exact=exactEvidence(executionEvidence,opportunityId,sourceSignature),reconstructed=!x?.copied&&!exact?reconstructedCapEvidence({...x,mirror:String(x?.mirror||mirror?.mirror||"")},priorObserved):null;
      const execution=exact||reconstructed||null;if(exact)exactEvidenceCount++;if(reconstructed)reconstructedCapCount++;
      const next={
        ...(prior||{}),opportunityId,mirror:String(x?.mirror||mirror?.mirror||""),mint:String(x?.mint||""),sourceSignature,
        sourceTimestamp:Number(x?.sourceTimestamp||0)||null,sourceBuyAt:x?.sourceBuyAt||null,firstObservedAt:prior?.firstObservedAt||now(),lastObservedAt:now(),
        odinEligibility:decision.classification,odinSkipReason:decision.reason,marketAtDetection:decision.marketAtDetection??prior?.marketAtDetection??null,
        paperPolicyFingerprint:decision.policyFingerprint??prior?.paperPolicyFingerprint??null,
        copied:Boolean(x?.copied),copySignature:x?.copySignature||prior?.copySignature||null,copyDelaySeconds:x?.copyDelaySeconds??prior?.copyDelaySeconds??null,
        sourceRoundTrip:x?.sourceRoundTrip??prior?.sourceRoundTrip??null,classification:x?.classification||prior?.classification||null,
        followerExitObserved:Boolean(x?.followerExitObserved??prior?.followerExitObserved),followerExitSignature:x?.followerExitSignature||prior?.followerExitSignature||null,
        executionEvidence:execution,executionDisposition:execution?.category||null,state:terminalState(x,decision,execution)
      };
      state.entries[opportunityId]=next;prior?updated++:created++;priorObserved.push({...x,mirror:next.mirror});
    }
  }
  const entries=Object.values(state.entries) as AnyObj[];
  entries.sort((a,b)=>Number(a.sourceTimestamp||0)-Number(b.sourceTimestamp||0));
  if(entries.length>4000){const keep=entries.slice(-4000);state.entries=Object.fromEntries(keep.map(x=>[x.opportunityId,x]));}
  state.updatedAt=now();await atomic(STATE_PATH,state);
  const values=Object.values(state.entries) as AnyObj[],counts:Record<string,number>={};for(const x of values)counts[String(x.state||"UNKNOWN")]=(counts[String(x.state||"UNKNOWN")]||0)+1;
  const report={schemaVersion:2,event:"shark_scout_odin_truth_ledger_complete",startedAt,finishedAt:now(),observed,created,updated,totalEntries:values.length,stateCounts:counts,exactExecutionEvidenceApplied:exactEvidenceCount,reconstructedCapEvidenceApplied:reconstructedCapCount,
    capBlockedMisses:values.filter(x=>x.state==="COPY_BLOCKED_BY_ODIN_POLICY").slice(-50),expectedCopyMisses:values.filter(x=>x.state==="EXPECTED_COPY_NOT_MATCHED").slice(-50),explainedCopyMisses:values.filter(x=>x.state==="COPY_NOT_MATCHED_EXPLAINED").slice(-50),unknownEligibility:values.filter(x=>x.state==="SEEN_ELIGIBILITY_UNKNOWN").slice(-50),
    notes:["Deterministic identity is mirror|source-signature; mint/time matching is never the primary key.","Paper Odin eligibility and actual Odin execution disposition are intentionally separate dimensions.","A missing copy is not labeled transfer degradation when exact Odin evidence or a provably exhausted configured cap explains the miss.","Cap reconstruction is limited to policy-registry wallets and requires earlier observed matched copies in the same cap window; otherwise the reason remains unknown rather than guessed.","Optional exact Odin log evidence can be supplied through SCOUT_ODIN_EXECUTION_EVIDENCE_PATH without changing code or live settings.","Follower matching is observational and never changes Odin controls or live capital."]};
  await atomic(OUT_PATH,report);console.log(JSON.stringify(report));
}
main().catch(e=>{console.error(JSON.stringify({event:"shark_scout_odin_truth_ledger_failed",error:e instanceof Error?e.message:String(e)}));process.exitCode=1;});
