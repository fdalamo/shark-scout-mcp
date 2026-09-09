import { spawn } from "node:child_process";
import { buildLiveEdgeController } from "./live_edge_controller.js";
import { buildFollowerPolicyLedger } from "./follower_policy_ledger.js";
import { buildOpportunityDebt } from "./opportunity_debt.js";

const MINUTE=60_000;

type QuotaPressure={
  total:number;
  http429:number;
  maxUsage:number;
  rateLimit:number;
  computeOrRps:number;
  samples:string[];
};

function clampNumber(value:string|undefined,fallback:number,min:number,max:number){
  const n=Number(value);
  return String(Math.max(min,Math.min(max,Number.isFinite(n)?n:fallback)));
}

function envWithLeanGuardrails(){
  const env={...process.env};
  env.HARVEST_PIPELINE_BUDGET_MS=clampNumber(env.HARVEST_PIPELINE_BUDGET_MS,20*MINUTE,16*MINUTE,20*MINUTE);
  env.HARVEST_FINALIZE_RESERVE_MS=clampNumber(env.HARVEST_FINALIZE_RESERVE_MS,8*MINUTE,7*MINUTE,9*MINUTE);
  env.HARVEST_DISCOVERY_BUDGET_MS=clampNumber(env.HARVEST_DISCOVERY_BUDGET_MS,4*MINUTE,2*MINUTE,4*MINUTE);
  env.HARVEST_CANONICAL_RESEARCH_BUDGET_MS=clampNumber(env.HARVEST_CANONICAL_RESEARCH_BUDGET_MS,5*MINUTE,3*MINUTE,5*MINUTE);
  env.HARVEST_DISCOVERY_CADENCE_HOURS=clampNumber(env.HARVEST_DISCOVERY_CADENCE_HOURS,4,2,6);
  env.REQUEST_TIMEOUT_MS=clampNumber(env.REQUEST_TIMEOUT_MS,15_000,8_000,20_000);

  env.HARVEST_PROFILE_LIMIT=clampNumber(env.HARVEST_PROFILE_LIMIT,20,8,24);
  env.HARVEST_TOKEN_LIMIT=clampNumber(env.HARVEST_TOKEN_LIMIT,30,10,35);
  env.CIELO_TAG_ENRICH_PER_RUN=clampNumber(env.CIELO_TAG_ENRICH_PER_RUN,20,0,25);
  env.CIELO_BRIDGE_TOKEN_LIMIT=clampNumber(env.CIELO_BRIDGE_TOKEN_LIMIT,3,0,4);
  env.CIELO_BRIDGE_TRADERS_PER_TOKEN=clampNumber(env.CIELO_BRIDGE_TRADERS_PER_TOKEN,3,1,4);

  env.DEEP_DIVE_BATCH=clampNumber(env.DEEP_DIVE_BATCH,1,1,1);
  env.DEEP_DIVE_HELIUS_PAGES=clampNumber(env.DEEP_DIVE_HELIUS_PAGES,6,4,8);
  env.DEEP_DIVE_MAX_PAGES=clampNumber(env.DEEP_DIVE_MAX_PAGES,10,6,12);
  env.DEEP_DIVE_UNFILTERED_PAGES=clampNumber(env.DEEP_DIVE_UNFILTERED_PAGES,2,1,3);

  env.CANONICAL_PROGRESSIVE_MAX_WALLETS=clampNumber(env.CANONICAL_PROGRESSIVE_MAX_WALLETS,4,2,4);
  env.CANONICAL_PROGRESSIVE_MAX_PROVIDER_CALLS=clampNumber(env.CANONICAL_PROGRESSIVE_MAX_PROVIDER_CALLS,120,60,120);
  env.CANONICAL_PROGRESSIVE_MAX_PROVIDER_CALLS_PER_WALLET=clampNumber(env.CANONICAL_PROGRESSIVE_MAX_PROVIDER_CALLS_PER_WALLET,28,16,28);
  env.CANONICAL_PROGRESSIVE_MAX_TX_PER_WALLET=clampNumber(env.CANONICAL_PROGRESSIVE_MAX_TX_PER_WALLET,24,12,24);
  env.CANONICAL_RESCUE_MAX_CALLS=clampNumber(env.CANONICAL_RESCUE_MAX_CALLS,16,8,16);
  return env;
}

async function refreshTruthSurface(phase:"pre"|"post"){
  try{await buildFollowerPolicyLedger();}
  catch(e){console.log(JSON.stringify({event:`shark_scout_follower_policy_${phase}_degraded`,error:e instanceof Error?e.message:String(e)}));}
  try{await buildLiveEdgeController();}
  catch(e){console.log(JSON.stringify({event:`shark_scout_live_edge_${phase}_degraded`,error:e instanceof Error?e.message:String(e)}));}
  try{await buildOpportunityDebt();}
  catch(e){console.log(JSON.stringify({event:`shark_scout_opportunity_debt_${phase}_degraded`,error:e instanceof Error?e.message:String(e)}));}
}

function inspectQuota(text:string,q:QuotaPressure){
  const normalized=text.toLowerCase();
  let matched=false;
  if(/(^|\D)429(\D|$)/.test(normalized)){q.http429++;matched=true;}
  if(normalized.includes("max usage reached")){q.maxUsage++;matched=true;}
  if(normalized.includes("rate limit")||normalized.includes("ratelimit")){q.rateLimit++;matched=true;}
  if(normalized.includes("compute unit")||normalized.includes("cu limit")||normalized.includes("rps limit")||normalized.includes("too many requests")){q.computeOrRps++;matched=true;}
  if(matched){
    q.total++;
    if(q.samples.length<8){
      const sample=text.replace(/\s+/g," ").trim().slice(0,240);
      if(sample&&!q.samples.includes(sample))q.samples.push(sample);
    }
  }
}

function teeAndInspect(chunk:any,target:NodeJS.WriteStream,q:QuotaPressure){
  const text=Buffer.isBuffer(chunk)?chunk.toString("utf8"):String(chunk);
  target.write(chunk);
  for(const line of text.split(/\r?\n/))if(line)inspectQuota(line,q);
}

async function runPipeline(){
  const env=envWithLeanGuardrails();
  console.log(JSON.stringify({
    event:"shark_scout_v051_guardrails",
    patch:"0.51.1-quota-truth-integrity",
    operatingScale:"~1_SOL",
    principle:"HOT truth first; cheap exploration preserved; expensive work must earn runtime",
    pipelineBudgetMs:Number(env.HARVEST_PIPELINE_BUDGET_MS),
    finalizeReserveMs:Number(env.HARVEST_FINALIZE_RESERVE_MS),
    discoveryBudgetMs:Number(env.HARVEST_DISCOVERY_BUDGET_MS),
    canonicalResearchBudgetMs:Number(env.HARVEST_CANONICAL_RESEARCH_BUDGET_MS),
    discoveryCadenceHours:Number(env.HARVEST_DISCOVERY_CADENCE_HOURS),
    harvestProfileLimit:Number(env.HARVEST_PROFILE_LIMIT),
    harvestTokenLimit:Number(env.HARVEST_TOKEN_LIMIT),
    deepDiveBatch:Number(env.DEEP_DIVE_BATCH),
    progressiveMaxWallets:Number(env.CANONICAL_PROGRESSIVE_MAX_WALLETS),
    progressiveProviderCalls:Number(env.CANONICAL_PROGRESSIVE_MAX_PROVIDER_CALLS),
    canonicalRescueMaxCalls:Number(env.CANONICAL_RESCUE_MAX_CALLS),
    opportunityDebt:true,
    quotaShield:true,
    liveOdinMutation:false
  }));
  const q:QuotaPressure={total:0,http429:0,maxUsage:0,rateLimit:0,computeOrRps:0,samples:[]};
  const code=await new Promise<number>((resolve,reject)=>{
    const child=spawn(process.execPath,["dist/harvest_pipeline.js"],{stdio:["inherit","pipe","pipe"],env});
    child.stdout?.on("data",chunk=>teeAndInspect(chunk,process.stdout,q));
    child.stderr?.on("data",chunk=>teeAndInspect(chunk,process.stderr,q));
    child.on("error",reject);
    child.on("exit",exitCode=>resolve(exitCode??1));
  });
  console.log(JSON.stringify({
    event:"shark_scout_quota_shield_summary",
    processExitCode:code,
    semanticHealth:q.total>0?"DEGRADED_PROVIDER_LIMITED":"OK",
    quotaPressure:q,
    note:q.total>0?"Process success does not imply data health while provider quota pressure is present.":"No provider quota-pressure signatures observed in pipeline output."
  }));
  return code;
}

async function main(){
  await refreshTruthSurface("pre");
  const code=await runPipeline();
  await refreshTruthSurface("post");
  process.exitCode=code;
}

main().catch(e=>{
  console.error(JSON.stringify({event:"shark_scout_v051_runner_failed",error:e instanceof Error?e.message:String(e)}));
  process.exitCode=1;
});
