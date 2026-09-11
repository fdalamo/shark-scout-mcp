import { promises as fs } from "node:fs";
import path from "node:path";

const CANONICAL_PATH=process.env.CANONICAL_HISTORY_FABRIC_STATE_PATH||"/data/canonical-history-fabric.json";
const AMBIGUITY_PATH=process.env.CANONICAL_AMBIGUITY_QUEUE_PATH||"/data/canonical-ambiguity-queue.json";
const TX_CACHE_PATH=process.env.TRANSACTION_FABRIC_CACHE_PATH||"/data/transaction-fabric-cache.json";
const GAUNTLET_REPORT_PATH=process.env.SCOUT_GAUNTLET_PATH||"/data/latest-gauntlet.json";
const GAUNTLET_STATE_PATH=process.env.SCOUT_GAUNTLET_STATE_PATH||"/data/gauntlet-state.json";
const ODIN_PATH=process.env.SCOUT_ODIN_SNAPSHOT_PATH||"/data/odin-config.json";
const TRUTH_PATH=process.env.SCOUT_ODIN_TRUTH_REPORT_PATH||"/data/odin-truth-report.json";
const TRANSFER_PATH=process.env.ODIN_TRANSFER_LAB_PATH||"/data/odin-transfer-lab.json";
const OUT_PATH=process.env.SCOUT_RESEARCH_CORE_HEALTH_PATH||"/data/research-core-health.json";

type AnyObj=Record<string,any>;
function now(){return new Date().toISOString();}
async function read(file:string,fallback:any){try{return JSON.parse(await fs.readFile(file,"utf8"));}catch{return fallback;}}
async function atomic(file:string,data:any){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;await fs.writeFile(tmp,JSON.stringify(data));await fs.rename(tmp,file);}
async function size(file:string){try{return (await fs.stat(file)).size;}catch{return 0;}}
function n(v:any){const x=Number(v);return Number.isFinite(x)?x:0;}
function div(a:number,b:number){return b>0?a/b:null;}
function statusOf(r:any){return String(r?.verdict?.status||r?.canonicalOverlay?.status||"UNKNOWN");}
function transferSamples(x:any){
  const candidates=[x?.actualOdin?.n,x?.layers?.ACTUAL_ODIN?.n,x?.summary?.actualOdinSamples,x?.actualOdinSamples,x?.metrics?.ACTUAL_ODIN?.n];
  for(const v of candidates){const z=Number(v);if(Number.isFinite(z))return z;}
  return null;
}

async function main(){
  const startedAt=now();
  const [canonical,ambiguity,txCache,gauntlet,cp,odin,truth,transfer,cacheBytes]=await Promise.all([
    read(CANONICAL_PATH,{}),read(AMBIGUITY_PATH,{entries:{}}),read(TX_CACHE_PATH,{transactions:{}}),read(GAUNTLET_REPORT_PATH,{}),read(GAUNTLET_STATE_PATH,{results:{}}),read(ODIN_PATH,{mirrors:[]}),read(TRUTH_PATH,{}),read(TRANSFER_PATH,{}),size(TX_CACHE_PATH)
  ]);
  const runs=Array.isArray(canonical?.runs)?canonical.runs:[],lastCanonical=runs[runs.length-1]||{},totals=canonical?.totals||{};
  const providerCalls=n(lastCanonical.providerCalls),cacheHits=n(lastCanonical.cacheHits),rowsServed=n(lastCanonical.rowsServed),swapRows=n(lastCanonical.swapRowsServed),intercepted=n(lastCanonical.intercepted),fallbacks=n(lastCanonical.fallbacks),partials=n(lastCanonical.partialResponses),budgetStops=n(lastCanonical.budgetStops);
  const txEntries=Object.keys(txCache?.transactions||{}).length,ambiguityEntries=Object.values(ambiguity?.entries||{}) as AnyObj[];
  const trackedMirrors:AnyObj[]=(Array.isArray(odin?.mirrors)?odin.mirrors:[])
    .map((x:any)=>({address:String(x?.address||x?.wallet||x?.sourceWallet||""),allowBuys:x?.allowBuys}))
    .filter((x:AnyObj)=>Boolean(x.address));
  const liveMirrors=trackedMirrors.filter((x:AnyObj)=>x.allowBuys!==false).map((x:AnyObj)=>x.address);
  const buysDisabledMirrors=trackedMirrors.filter((x:AnyObj)=>x.allowBuys===false).map((x:AnyObj)=>x.address);
  const liveSet=new Set(liveMirrors);
  const results=Object.entries(cp?.results||{}).map(([address,r0])=>({address,r:r0 as AnyObj,status:statusOf(r0)}));
  const priority={
    P0_LIVE_MIRRORS:results.filter(x=>liveSet.has(x.address)).length,
    P1_DEEP_DIVE:results.filter(x=>!liveSet.has(x.address)&&x.status==="DEEP_DIVE").length,
    P2_SIGNAL_ONLY:results.filter(x=>!liveSet.has(x.address)&&x.status==="SIGNAL_ONLY").length,
    P3_UNKNOWN:results.filter(x=>!liveSet.has(x.address)&&x.status==="UNKNOWN").length,
    P4_REJECT:results.filter(x=>!liveSet.has(x.address)&&x.status==="REJECT").length,
  };
  const actionable=results.filter(x=>String(x.r?.canonicalOverlay?.status||"")==="ACTIONABLE").length;
  const stateCounts=truth?.stateCounts||{};
  const actualSamples=transferSamples(transfer);
  const degradedReasons:string[]=[];
  if(partials>0)degradedReasons.push("canonical_partial_responses");
  if(budgetStops>0)degradedReasons.push("canonical_provider_budget_stops");
  if(fallbacks>0)degradedReasons.push("helius_enhanced_fallback_used");
  if(ambiguityEntries.length>1000)degradedReasons.push("ambiguity_backlog_over_1000");
  const health=degradedReasons.length?"DEGRADED":"HEALTHY";
  const out={
    schemaVersion:2,event:"shark_scout_research_core_health",status:health,startedAt,finishedAt:now(),degradedReasons,
    canonical:{lastRun:{scope:lastCanonical?.scope||null,startedAt:lastCanonical?.startedAt||null,finishedAt:lastCanonical?.finishedAt||null,intercepted,providerCalls,cacheHits,rowsServed,swapRowsServed:swapRows,partialResponses:partials,budgetStops,fallbacks,ambiguitiesQueued:n(lastCanonical?.ambiguitiesQueued)},totals},
    efficiency:{enhancedHistoryCallsAvoided:Math.max(0,intercepted-fallbacks),rowsPer1000ProviderCalls:providerCalls?rowsServed/providerCalls*1000:null,swapsPer1000ProviderCalls:providerCalls?swapRows/providerCalls*1000:null,cacheHitsPer1000ProviderCalls:providerCalls?cacheHits/providerCalls*1000:null},
    transactionLake:{entries:txEntries,bytes:cacheBytes,maxConfigured:Number(canonical?.runs?.[canonical.runs.length-1]?.transactionFabric?.maxCache||0)||null},
    ambiguity:{backlog:ambiguityEntries.length,oldestSeenAt:ambiguityEntries.map(x=>Date.parse(String(x?.firstSeenAt||""))).filter(Number.isFinite).sort((a,b)=>a-b)[0]?new Date(ambiguityEntries.map(x=>Date.parse(String(x?.firstSeenAt||""))).filter(Number.isFinite).sort((a,b)=>a-b)[0]!).toISOString():null},
    gauntlet:{processedCumulative:n(gauntlet?.processedCumulative),remaining:n(gauntlet?.remaining),counts:gauntlet?.counts||{},deepDiveReported:Array.isArray(gauntlet?.deepDive)?gauntlet.deepDive.length:0,actionableCanonical:actionable,priorityBacklog:priority,trackedMirrors:trackedMirrors.length,liveMirrorsTracked:liveMirrors.length,buysDisabledMirrorsTracked:buysDisabledMirrors.length},
    transferTruth:{stateCounts,capBlockedMisses:n(stateCounts?.COPY_BLOCKED_BY_ODIN_POLICY),unexplainedExpectedMisses:n(stateCounts?.EXPECTED_COPY_NOT_MATCHED),actualOdinSamples:actualSamples},
    resourcePolicy:{principle:"immutable transaction history is cached; hourly work should converge toward delta-only refresh",heliusEnhancedRole:"ambiguity/adjudication fallback only",liveExecutionMutation:false,paidProviderUpgrade:false},
    notes:["P0/P1/P2/P3/P4 are scheduling priorities, not promotion decisions.","P0 live-mirror scheduling includes only currently buy-enabled Odin mirrors; buys-disabled tracked mirrors remain visible separately and do not consume live priority.","A high ambiguity backlog is a parsing-quality issue; it does not justify bulk Helius Enhanced history calls.","Provider-efficiency ratios are descriptive for the latest canonical fabric run and are not normalized for provider-specific unit pricing.","No Odin settings, capital, speed tier, or provider plan is changed by this stage."]
  };
  await atomic(OUT_PATH,out);console.log(JSON.stringify(out));
}
main().catch(e=>{console.error(JSON.stringify({event:"shark_scout_research_core_health_failed",error:e instanceof Error?e.message:String(e)}));process.exitCode=1;});
