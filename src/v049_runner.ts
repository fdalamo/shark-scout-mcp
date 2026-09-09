import { spawn } from "node:child_process";
import { buildLiveEdgeController } from "./live_edge_controller.js";

const MINUTE=60_000;
function envWithGuardrails(){
  const env={...process.env};
  env.HARVEST_PIPELINE_BUDGET_MS=String(Math.min(Number(env.HARVEST_PIPELINE_BUDGET_MS||20*MINUTE),20*MINUTE));
  env.HARVEST_FINALIZE_RESERVE_MS=String(Math.max(Number(env.HARVEST_FINALIZE_RESERVE_MS||8*MINUTE),8*MINUTE));
  env.CANONICAL_PROGRESSIVE_MAX_WALLETS=String(Math.min(Number(env.CANONICAL_PROGRESSIVE_MAX_WALLETS||6),6));
  env.CANONICAL_PROGRESSIVE_MAX_PROVIDER_CALLS=String(Math.min(Number(env.CANONICAL_PROGRESSIVE_MAX_PROVIDER_CALLS||180),180));
  env.CANONICAL_PROGRESSIVE_MAX_PROVIDER_CALLS_PER_WALLET=String(Math.min(Number(env.CANONICAL_PROGRESSIVE_MAX_PROVIDER_CALLS_PER_WALLET||32),32));
  env.CANONICAL_PROGRESSIVE_MAX_TX_PER_WALLET=String(Math.min(Number(env.CANONICAL_PROGRESSIVE_MAX_TX_PER_WALLET||28),28));
  env.CANONICAL_RESCUE_MAX_CALLS=String(Math.min(Number(env.CANONICAL_RESCUE_MAX_CALLS||24),24));
  return env;
}
async function runPipeline(){
  const env=envWithGuardrails();
  console.log(JSON.stringify({event:"shark_scout_v049_guardrails",pipelineBudgetMs:Number(env.HARVEST_PIPELINE_BUDGET_MS),finalizeReserveMs:Number(env.HARVEST_FINALIZE_RESERVE_MS),progressiveMaxWallets:Number(env.CANONICAL_PROGRESSIVE_MAX_WALLETS),progressiveProviderCalls:Number(env.CANONICAL_PROGRESSIVE_MAX_PROVIDER_CALLS),progressivePerWalletCalls:Number(env.CANONICAL_PROGRESSIVE_MAX_PROVIDER_CALLS_PER_WALLET),progressiveMaxTxPerWallet:Number(env.CANONICAL_PROGRESSIVE_MAX_TX_PER_WALLET),canonicalRescueMaxCalls:Number(env.CANONICAL_RESCUE_MAX_CALLS),reason:"protect HOT/live truth and force bounded cold research for ~1 SOL operating scale"}));
  return await new Promise<number>((resolve,reject)=>{
    const child=spawn(process.execPath,["dist/harvest_pipeline.js"],{stdio:"inherit",env});
    child.on("error",reject);child.on("exit",code=>resolve(code??1));
  });
}
async function main(){
  try{await buildLiveEdgeController();}catch(e){console.log(JSON.stringify({event:"shark_scout_live_edge_pre_degraded",error:e instanceof Error?e.message:String(e)}));}
  const code=await runPipeline();
  try{await buildLiveEdgeController();}catch(e){console.log(JSON.stringify({event:"shark_scout_live_edge_post_degraded",error:e instanceof Error?e.message:String(e)}));}
  process.exitCode=code;
}
main().catch(e=>{console.error(JSON.stringify({event:"shark_scout_v049_runner_failed",error:e instanceof Error?e.message:String(e)}));process.exitCode=1;});
