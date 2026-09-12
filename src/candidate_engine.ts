import { promises as fs } from "node:fs";
import path from "node:path";

const FUNNEL_PATH=process.env.SCOUT_EVIDENCE_FUNNEL_PATH||"/data/evidence-funnel.json";
const GAUNTLET_PATH=process.env.SCOUT_GAUNTLET_STATE_PATH||"/data/gauntlet-state.json";
const SCOUT_STATE_PATH=process.env.SCOUT_STATE_PATH||"/data/shark-state.json";
const PROGRESSIVE_DIR=process.env.CANONICAL_PROGRESSIVE_EVIDENCE_DIR||"/data/canonical-evidence";
const STATE_PATH=process.env.SCOUT_CANDIDATE_ENGINE_STATE_PATH||"/data/candidate-engine-state.json";
const REPORT_PATH=process.env.SCOUT_CANDIDATE_ENGINE_REPORT_PATH||"/data/candidate-engine-report.json";
const MAX_CANDIDATES=Math.max(10,Math.min(80,Number(process.env.CANDIDATE_ENGINE_MAX_CANDIDATES||40)));
const STANDARD_SHADOW_HOURS=Math.max(24,Math.min(336,Number(process.env.CANDIDATE_SHADOW_MIN_HOURS||72)));
const STANDARD_SHADOW_CLOSES=Math.max(4,Math.min(30,Number(process.env.CANDIDATE_SHADOW_MIN_CLOSES||7)));
const STANDARD_SHADOW_MINTS=Math.max(2,Math.min(10,Number(process.env.CANDIDATE_SHADOW_MIN_MINTS||3)));
const LOW_FREQ_HOURS=Math.max(STANDARD_SHADOW_HOURS,Math.min(720,Number(process.env.CANDIDATE_SHADOW_LOW_FREQ_HOURS||168)));
const LOW_FREQ_CLOSES=Math.max(3,Math.min(STANDARD_SHADOW_CLOSES,Number(process.env.CANDIDATE_SHADOW_LOW_FREQ_CLOSES||5)));
const PARK_HOURS=Math.max(LOW_FREQ_HOURS,Math.min(1440,Number(process.env.CANDIDATE_SHADOW_PARK_HOURS||504)));

type AnyObj=Record<string,any>;
export type CandidateStage="RECONSTRUCT"|"HISTORICAL_REVIEW"|"SHADOW_TRIAL"|"SHADOW_EXTEND"|"SHADOW_FAIL"|"SHADOW_PARK"|"ODIN_TRIAL_READY";
type CandidateState={firstSeenAt:string;historicalQualifiedAt:string|null;shadowStartedAt:string|null;stage:CandidateStage;lastUpdatedAt:string;frozenPolicy:{standardHours:number;standardCloses:number;standardMints:number;lowFreqHours:number;lowFreqCloses:number;parkHours:number}|null};
type EngineState={schemaVersion:1;updatedAt:string;candidates:Record<string,CandidateState>};

function now(){return new Date().toISOString();}
function n(v:any){const x=Number(v);return Number.isFinite(x)?x:null;}
function tsSeconds(v:any){const x=n(v);if(x==null||x<=0)return null;return x>1e12?x/1000:x;}
async function readJson(file:string,fallback:any){try{return JSON.parse(await fs.readFile(file,"utf8"));}catch{return fallback;}}
async function atomic(file:string,data:any){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;await fs.writeFile(tmp,JSON.stringify(data,null,2));await fs.rename(tmp,file);}
function uniq<T>(xs:T[]){return [...new Set(xs)];}
function candidatePool(funnel:any){
  const groups=["topActionable","topNearPasses","topSampleQualityBlocks","topReplayBlocks","topReconstructionPriority"];
  const out:any[]=[];const seen=new Set<string>();
  for(const g of groups)for(const x of Array.isArray(funnel?.[g])?funnel[g]:[]){const a=String(x?.address||"");if(!a||seen.has(a))continue;seen.add(a);out.push(x);if(out.length>=MAX_CANDIDATES)return out;}
  return out;
}
function progressivePath(address:string){return path.join(PROGRESSIVE_DIR,`${address}.json`);}
function sourceHints(wallet:any,r:any,progressive:any){
  const hints=["evidence_funnel"];
  if(Array.isArray(r?.canonicalReplay?.roundTrips)&&r.canonicalReplay.roundTrips.length)hints.push("canonical_replay");
  if(Array.isArray(progressive?.rows)&&progressive.rows.length)hints.push("progressive_provider_fabric");
  if(String(r?.canonicalReplay?.source||""))hints.push(String(r.canonicalReplay.source));
  for(const k of ["sources","discoverySources","evidenceSources"]){for(const x of Array.isArray(wallet?.[k])?wallet[k]:[])if(typeof x==="string"&&x)hints.push(x);}
  if(Array.isArray(wallet?.tokens)&&wallet.tokens.length)hints.push("discovery_token_context");
  return uniq(hints).sort();
}
function authoritativeReplay(x:any,r:any){
  const trips=Array.isArray(r?.canonicalReplay?.roundTrips)?r.canonicalReplay.roundTrips:[];
  if(trips.length)return{trips,trades:trips.length,net:trips.map((t:any)=>n(t?.followerNetSol)).filter((v:any):v is number=>v!=null).reduce((a:number,b:number)=>a+b,0),stress50:trips.map((t:any)=>n(t?.stress50NetSol)).filter((v:any):v is number=>v!=null).reduce((a:number,b:number)=>a+b,0),authoritative:true};
  return{trips:[],trades:Number(x?.replay?.trades||0),net:n(x?.replay?.net),stress50:n(x?.replay?.stress50),authoritative:Boolean(x?.replay?.authoritative)};
}
export function qualifiesHistorical(x:any,r:any){
  const replay=authoritativeReplay(x,r),risk=String(x?.sampleQuality?.risk||"HIGH"),contexts=Number(x?.sampleQuality?.discoveryContexts||0),hold=Number(x?.medianHoldHours||0),overlay=String(x?.canonicalOverlayStatus||r?.canonicalOverlay?.status||"");
  const reasons:string[]=[];
  if(!replay.authoritative)reasons.push("canonical_replay_required");
  if(replay.trades<10)reasons.push("canonical_trades_lt_10");
  if(replay.net==null||replay.net<=0)reasons.push("canonical_net_not_positive");
  if(replay.stress50==null||replay.stress50<=0)reasons.push("stress50_not_positive");
  if(hold<1)reasons.push("median_hold_under_1h");
  if(risk==="HIGH")reasons.push("sample_risk_high");
  if(contexts<2)reasons.push("discovery_contexts_lt_2");
  if(overlay!=="DEEP_DIVE"&&overlay!=="ODIN_PROSPECT")reasons.push("canonical_promotion_gate");
  return{ready:reasons.length===0,reasons,replay,risk,contexts,hold,overlay};
}
function tripKey(t:any){return String(t?.signature||`${t?.mint||""}|${t?.buyTimestamp||0}|${t?.sellTimestamp||0}`);}
export function prospectiveMetrics(trips:any[],shadowStartedAt:string|null){
  const start=shadowStartedAt?Date.parse(shadowStartedAt)/1000:Infinity;
  const selected=[...new Map((trips||[]).filter((t:any)=>{const b=tsSeconds(t?.buyTimestamp),s=tsSeconds(t?.sellTimestamp);return b!=null&&s!=null&&b>=start&&s>=b;}).map((t:any)=>[tripKey(t),t])).values()];
  const nets=selected.map((t:any)=>n(t?.followerNetSol)).filter((v:any):v is number=>v!=null),s50=selected.map((t:any)=>n(t?.stress50NetSol)).filter((v:any):v is number=>v!=null);
  const net=nets.length?nets.reduce((a,b)=>a+b,0):0,stress50=s50.length?s50.reduce((a,b)=>a+b,0):0,wins=nets.filter(v=>v>0).length;
  return{closed:selected.length,distinctMints:uniq(selected.map((t:any)=>String(t?.mint||"")).filter(Boolean)).length,netSol:net,stress50NetSol:stress50,wins,losses:Math.max(0,nets.length-wins),winRate:nets.length?wins/nets.length:null,firstBuyAt:selected.length?new Date(Math.min(...selected.map((t:any)=>tsSeconds(t?.buyTimestamp)||Infinity))*1000).toISOString():null,lastSellAt:selected.length?new Date(Math.max(...selected.map((t:any)=>tsSeconds(t?.sellTimestamp)||0))*1000).toISOString():null};
}
export function evaluateShadow(startedAt:string,metrics:ReturnType<typeof prospectiveMetrics>,asOf=new Date()){
  const ageHours=Math.max(0,(asOf.getTime()-Date.parse(startedAt))/3_600_000),standardSample=metrics.closed>=STANDARD_SHADOW_CLOSES&&metrics.distinctMints>=STANDARD_SHADOW_MINTS,lowFreqSample=metrics.closed>=LOW_FREQ_CLOSES&&metrics.distinctMints>=STANDARD_SHADOW_MINTS;
  const economicPass=metrics.netSol>0&&metrics.stress50NetSol>0;
  if(ageHours>=STANDARD_SHADOW_HOURS&&standardSample)return{stage:(economicPass?"ODIN_TRIAL_READY":"SHADOW_FAIL") as CandidateStage,decision:economicPass?"PASS":"FAIL",reason:economicPass?"standard_shadow_complete":"prospective_economics_failed",ageHours};
  if(ageHours>=LOW_FREQ_HOURS&&lowFreqSample)return{stage:(economicPass?"ODIN_TRIAL_READY":"SHADOW_FAIL") as CandidateStage,decision:economicPass?"PASS":"FAIL",reason:economicPass?"low_frequency_shadow_complete":"prospective_economics_failed",ageHours};
  if(ageHours>=PARK_HOURS&&metrics.closed<3)return{stage:"SHADOW_PARK" as CandidateStage,decision:"PARK",reason:"insufficient_forward_activity",ageHours};
  if(ageHours>=STANDARD_SHADOW_HOURS)return{stage:"SHADOW_EXTEND" as CandidateStage,decision:"EXTEND",reason:"forward_sample_incomplete",ageHours};
  return{stage:"SHADOW_TRIAL" as CandidateStage,decision:"MONITOR",reason:"minimum_forward_window_open",ageHours};
}
function evidenceManifest(x:any,h:any,progressive:any,shadow:any){
  const missing=[...h.reasons];
  if(!Array.isArray(progressive?.rows)||!progressive.rows.length)missing.push("progressive_history_rows_missing");
  if(h.ready&&shadow){if(shadow.metrics.closed<STANDARD_SHADOW_CLOSES)missing.push(`shadow_closed_lt_${STANDARD_SHADOW_CLOSES}`);if(shadow.metrics.distinctMints<STANDARD_SHADOW_MINTS)missing.push(`shadow_distinct_mints_lt_${STANDARD_SHADOW_MINTS}`);if(shadow.evaluation.ageHours<STANDARD_SHADOW_HOURS)missing.push(`shadow_age_lt_${STANDARD_SHADOW_HOURS}h`);}
  const blockers=Array.isArray(x?.blockers)?x.blockers:[];
  return{missing:uniq([...missing,...blockers]),nextBestEvidence:!h.replay.authoritative?"reconstruct_canonical_lifecycles":h.contexts<2?"expand_independent_discovery_context":h.risk==="HIGH"?"improve_sample_quality":h.ready?"observe_forward_buy_sell_lifecycles":"resolve_remaining_historical_guard"};
}

export async function buildCandidateEngine(){
  const generatedAt=now();
  const [funnel,gauntlet,scout,state0]=await Promise.all([readJson(FUNNEL_PATH,{}),readJson(GAUNTLET_PATH,{results:{}}),readJson(SCOUT_STATE_PATH,{wallets:{}}),readJson(STATE_PATH,{schemaVersion:1,updatedAt:generatedAt,candidates:{}})]);
  const state:EngineState={schemaVersion:1,updatedAt:generatedAt,candidates:state0?.candidates||{}};
  const rows:any[]=[];
  for(const x of candidatePool(funnel)){
    const address=String(x?.address||"");if(!address)continue;
    const r=gauntlet?.results?.[address]||{},wallet=scout?.wallets?.[address]||{},progressive=await readJson(progressivePath(address),null),historical=qualifiesHistorical(x,r);
    const prior:CandidateState=state.candidates[address]||{firstSeenAt:generatedAt,historicalQualifiedAt:null,shadowStartedAt:null,stage:historical.replay.authoritative?"HISTORICAL_REVIEW":"RECONSTRUCT",lastUpdatedAt:generatedAt,frozenPolicy:null};
    let next={...prior,lastUpdatedAt:generatedAt};
    if(historical.ready&&!next.historicalQualifiedAt)next.historicalQualifiedAt=generatedAt;
    if(historical.ready&&!next.shadowStartedAt){next.shadowStartedAt=generatedAt;next.frozenPolicy={standardHours:STANDARD_SHADOW_HOURS,standardCloses:STANDARD_SHADOW_CLOSES,standardMints:STANDARD_SHADOW_MINTS,lowFreqHours:LOW_FREQ_HOURS,lowFreqCloses:LOW_FREQ_CLOSES,parkHours:PARK_HOURS};}
    const metrics=prospectiveMetrics(historical.replay.trips,next.shadowStartedAt),evaluation=next.shadowStartedAt?evaluateShadow(next.shadowStartedAt,metrics):null;
    if(!historical.ready)next.stage=historical.replay.authoritative?"HISTORICAL_REVIEW":"RECONSTRUCT";else next.stage=evaluation?.stage||"SHADOW_TRIAL";
    state.candidates[address]=next;
    const progressiveRows=Array.isArray(progressive?.rows)?progressive.rows:[];
    rows.push({address,stage:next.stage,firstSeenAt:next.firstSeenAt,historicalQualifiedAt:next.historicalQualifiedAt,shadowStartedAt:next.shadowStartedAt,historical:{ready:historical.ready,reasons:historical.reasons,canonicalTrades:historical.replay.trades,netSol:historical.replay.net,stress50NetSol:historical.replay.stress50,medianHoldHours:historical.hold,sampleRisk:historical.risk,discoveryContexts:historical.contexts,overlay:historical.overlay},portfolio:{canonicalClosedLifecycles:historical.replay.trips.length,progressiveRows:progressiveRows.length,progressiveHistoryComplete:Boolean(progressive?.historyComplete),progressiveScanCount:Number(progressive?.scanCount||0),progressiveZeroProgressReason:progressive?.zeroProgressReason||null,sourceSurfaces:sourceHints(wallet,r,progressive),discoveryTokenContexts:Array.isArray(wallet?.tokens)?wallet.tokens.length:null},shadow:next.shadowStartedAt?{policy:next.frozenPolicy,metrics,evaluation}:null,evidenceManifest:evidenceManifest(x,historical,progressive,next.shadowStartedAt?{metrics,evaluation}:null),funnel:{actionable:Boolean(x?.actionable),nearPassScore:Number(x?.nearPassScore||0),blockers:Array.isArray(x?.blockers)?x.blockers:[]}});
  }
  state.updatedAt=generatedAt;await atomic(STATE_PATH,state);
  const order:Record<CandidateStage,number>={ODIN_TRIAL_READY:7,SHADOW_TRIAL:6,SHADOW_EXTEND:5,HISTORICAL_REVIEW:4,RECONSTRUCT:3,SHADOW_PARK:2,SHADOW_FAIL:1};rows.sort((a,b)=>order[b.stage as CandidateStage]-order[a.stage as CandidateStage]||Number(b?.funnel?.nearPassScore||0)-Number(a?.funnel?.nearPassScore||0));
  const counts=Object.fromEntries(Object.keys(order).map(k=>[k,rows.filter(r=>r.stage===k).length]));
  const out={schemaVersion:1,event:"shark_scout_candidate_engine_complete",generatedAt,policy:{guardsLowered:false,forwardOnlyShadow:true,noOdinMutation:true,noNewProviderDependency:true,multiSurfacePortfolio:true,standardShadow:{minHours:STANDARD_SHADOW_HOURS,minClosedLifecycles:STANDARD_SHADOW_CLOSES,minDistinctMints:STANDARD_SHADOW_MINTS},lowFrequencyFallback:{minHours:LOW_FREQ_HOURS,minClosedLifecycles:LOW_FREQ_CLOSES,minDistinctMints:STANDARD_SHADOW_MINTS},parkAfterHours:PARK_HOURS},evaluated:rows.length,stageCounts:counts,odinTrialReady:rows.filter(r=>r.stage==="ODIN_TRIAL_READY"),shadowActive:rows.filter(r=>r.stage==="SHADOW_TRIAL"||r.stage==="SHADOW_EXTEND"),reconstructionPriority:rows.filter(r=>r.stage==="RECONSTRUCT"||r.stage==="HISTORICAL_REVIEW").slice(0,20),candidates:rows,notes:["Historical guards are preserved: authoritative canonical replay, positive net and stress-50, >=1h median hold, non-HIGH sample risk, >=2 discovery contexts, and the existing canonical promotion gate.","Shadow evidence is forward-only from the frozen shadowStartedAt timestamp; later backfilled historical trades cannot satisfy the prospective sample.","Portfolio evidence merges existing canonical replay, progressive provider-fabric rows, discovery context, and funnel evidence without adding provider calls.","ODIN_TRIAL_READY is advisory only; actual capital remains governed by the existing Odin/ACTUAL_ODIN controls."]};
  await atomic(REPORT_PATH,out);console.log(JSON.stringify(out));return out;
}
if(import.meta.url===`file://${process.argv[1]}`)buildCandidateEngine().catch(e=>{console.error(JSON.stringify({event:"shark_scout_candidate_engine_failed",error:e instanceof Error?e.message:String(e)}));process.exitCode=1;});
