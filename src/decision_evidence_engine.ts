import { promises as fs } from "node:fs";
import path from "node:path";
import { hydrateProgressiveEvidence, type ProgressiveCandidate } from "./progressive_evidence.js";

const FUNNEL_PATH=process.env.SCOUT_EVIDENCE_FUNNEL_PATH||"/data/evidence-funnel.json";
const CANDIDATE_PATH=process.env.SCOUT_CANDIDATE_ENGINE_REPORT_PATH||"/data/candidate-engine-report.json";
const LADDER_PATH=process.env.SCOUT_REPLACEMENT_LADDER_PATH||"/data/replacement-ladder.json";
const ODIN_PATH=process.env.SCOUT_ODIN_SNAPSHOT_PATH||"/data/odin-config.json";
const OUT_PATH=process.env.SCOUT_DECISION_EVIDENCE_ENGINE_PATH||"/data/decision-evidence-engine.json";
const MAX_QUEUE=Math.max(6,Math.min(30,Number(process.env.DECISION_EVIDENCE_MAX_QUEUE||16)));

type AnyObj=Record<string,any>;
type QueueRow=Omit<ProgressiveCandidate,"canonicalTrades">&{\n  canonicalTrades:number;
  score:number;
  contexts:number;
  source:string[];
  reasons:string[];
  decisionValue:number;
};

function now(){return new Date().toISOString();}
function n(v:any,d=0){const x=Number(v);return Number.isFinite(x)?x:d;}
async function readJson(file:string,fallback:any){try{return JSON.parse(await fs.readFile(file,"utf8"));}catch{return fallback;}}
async function atomic(file:string,data:any){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;await fs.writeFile(tmp,JSON.stringify(data,null,2));await fs.rename(tmp,file);}
function pushUnique(map:Map<string,QueueRow>,x:any,source:string,forcedTier=0){
  const address=String(x?.address||x?.wallet||"");if(!address)return;
  const replay=x?.replay||x?.historical||{};
  const quality=x?.sampleQuality||{};
  const canonicalTrades=Math.max(0,n(replay?.trades??x?.historical?.canonicalTrades));
  const closed=Math.max(canonicalTrades,n(quality?.closed??x?.portfolio?.sourceSurfaces?.closed));
  const deficit=Math.max(0,closed-canonicalTrades);
  const contexts=Math.max(0,n(quality?.discoveryContexts??x?.historical?.discoveryContexts));
  const score=Math.max(n(x?.score),n(x?.nearPassScore),n(x?.funnel?.nearPassScore));
  const existing=map.get(address);
  const reasons:string[]=[];
  if(deficit>0)reasons.push(`canonical_deficit_${deficit}`);
  if(contexts<2)reasons.push("independent_context_lt_2");
  if(String(x?.stage||x?.candidateStage||"").includes("RECONSTRUCT"))reasons.push("candidate_reconstruct");
  if(String(x?.stage||x?.candidateStage||"").includes("HISTORICAL_REVIEW"))reasons.push("historical_review");
  let priorityTier=forcedTier;
  if(priorityTier===0){
    if(String(x?.stage||"").startsWith("SHADOW"))priorityTier=4;
    else if(score>=120)priorityTier=3;
    else if(Boolean(x?.actionable))priorityTier=2;
    else priorityTier=1;
  }
  const decisionValue=priorityTier*1000+Math.min(300,score)+Math.min(100,canonicalTrades*2)+Math.min(80,contexts*20)-Math.min(200,deficit);
  if(!existing){
    map.set(address,{address,priorityTier,deficit,closed,canonicalTrades,score,contexts,source:[source],reasons,decisionValue});
  }else{
    existing.priorityTier=Math.max(existing.priorityTier,priorityTier);
    existing.score=Math.max(existing.score,score);
    existing.contexts=Math.max(existing.contexts,contexts);
    existing.closed=Math.max(existing.closed,closed);
    existing.canonicalTrades=Math.max(existing.canonicalTrades,canonicalTrades);
    existing.deficit=Math.max(0,existing.closed-existing.canonicalTrades);
    existing.decisionValue=Math.max(existing.decisionValue,decisionValue);
    if(!existing.source.includes(source))existing.source.push(source);
    for(const r of reasons)if(!existing.reasons.includes(r))existing.reasons.push(r);
  }
}

export async function runDecisionEvidenceEngine(){
  const startedAt=now();
  const [funnel,candidate,ladder,odin]=await Promise.all([
    readJson(FUNNEL_PATH,{}),readJson(CANDIDATE_PATH,{}),readJson(LADDER_PATH,{}),readJson(ODIN_PATH,{})
  ]);
  const queue=new Map<string,QueueRow>();
  for(const x of Array.isArray(candidate?.shadowActive)?candidate.shadowActive:[])pushUnique(queue,x,"candidate_shadow",4);
  for(const x of Array.isArray(candidate?.reconstructionPriority)?candidate.reconstructionPriority:[])pushUnique(queue,x,"candidate_reconstruction",3);
  for(const x of Array.isArray(ladder?.historicalLeaders)?ladder.historicalLeaders:[])pushUnique(queue,x,"historical_leader",3);
  for(const key of ["topActionable","topNearPasses","topReplayBlocks","topSampleQualityBlocks"]){
    for(const x of Array.isArray(funnel?.[key])?funnel[key]:[])pushUnique(queue,x,`funnel_${key}`);
  }
  const live=new Set<string>((Array.isArray(odin?.mirrors)?odin.mirrors:[]).filter((x:any)=>x?.allowBuys!==false).map((x:any)=>String(x?.address||"")).filter(Boolean));
  for(const address of live){const row=queue.get(address);if(row){row.priorityTier=5;row.decisionValue+=2000;if(!row.reasons.includes("live_incumbent"))row.reasons.push("live_incumbent");}}
  const ranked=[...queue.values()]
    .filter(x=>x.deficit>0)
    .sort((a,b)=>b.priorityTier-a.priorityTier||b.decisionValue-a.decisionValue||a.deficit-b.deficit)
    .slice(0,MAX_QUEUE);
  const progressive=await hydrateProgressiveEvidence(ranked.map(({address,priorityTier,deficit,closed,canonicalTrades})=>({address,priorityTier,deficit,closed,canonicalTrades})));
  const providerCalls=n(progressive?.totalProviderCalls),rowsAdded=n(progressive?.totalRowsAdded);
  const out={
    schemaVersion:1,event:"shark_scout_decision_evidence_engine_complete",startedAt,finishedAt:now(),
    policy:{
      objective:"capital_decisions_per_expensive_evidence_call",
      queueMode:"decision_value_first",
      maxQueue:MAX_QUEUE,
      liveIncumbentPriority:true,
      shadowPriority:true,
      historicalLeaderPriority:true,
      noOdinMutation:true,
      providerNeutral:true,
      discoveryThrottleRecommended:true
    },
    queueDepth:ranked.length,
    queue:ranked,
    progressive,
    metrics:{
      providerCalls,
      rowsAdded,
      rowsPerProviderCall:providerCalls>0?rowsAdded/providerCalls:0,
      walletsWithProgress:n(progressive?.progressWallets),
      zeroProgressWallets:n(progressive?.zeroProgressWallets)
    },
    notes:[
      "This stage converts existing high-decision-value wallets before spending more research budget on generic backlog.",
      "It reuses Progressive Evidence and Transaction Fabric; cache-first/provider-neutral behavior remains intact.",
      "Wallets with no canonical deficit are not fetched here; independent-context-only blockers remain a separate discovery problem.",
      "This stage never changes Odin settings or spends capital."
    ]
  };
  await atomic(OUT_PATH,out);console.log(JSON.stringify(out));return out;
}
if(import.meta.url===`file://${process.argv[1]}`)runDecisionEvidenceEngine().catch(e=>{console.error(JSON.stringify({event:"shark_scout_decision_evidence_engine_failed",error:e instanceof Error?e.message:String(e)}));process.exitCode=1;});
