import { spawn } from "node:child_process";
import { buildLiveEdgeController } from "./live_edge_controller.js";
import { buildFollowerPolicyLedger } from "./follower_policy_ledger.js";

const MINUTE = 60_000;
function envWithGuardrails() {
  const env = { ...process.env };
  env.HARVEST_PIPELINE_BUDGET_MS = String(Math.min(Number(env.HARVEST_PIPELINE_BUDGET_MS || 20 * MINUTE), 20 * MINUTE));
  env.HARVEST_FINALIZE_RESERVE_MS = String(Math.max(Number(env.HARVEST_FINALIZE_RESERVE_MS || 8 * MINUTE), 8 * MINUTE));
  env.CANONICAL_PROGRESSIVE_MAX_WALLETS = String(Math.min(Number(env.CANONICAL_PROGRESSIVE_MAX_WALLETS || 6), 6));
  env.CANONICAL_PROGRESSIVE_MAX_PROVIDER_CALLS = String(Math.min(Number(env.CANONICAL_PROGRESSIVE_MAX_PROVIDER_CALLS || 180), 180));
  env.CANONICAL_PROGRESSIVE_MAX_PROVIDER_CALLS_PER_WALLET = String(Math.min(Number(env.CANONICAL_PROGRESSIVE_MAX_PROVIDER_CALLS_PER_WALLET || 32), 32));
  env.CANONICAL_PROGRESSIVE_MAX_TX_PER_WALLET = String(Math.min(Number(env.CANONICAL_PROGRESSIVE_MAX_TX_PER_WALLET || 28), 28));
  env.CANONICAL_RESCUE_MAX_CALLS = String(Math.min(Number(env.CANONICAL_RESCUE_MAX_CALLS || 24), 24));
  return env;
}
async function refreshTruthSurface(phase: "pre" | "post") {
  try { await buildFollowerPolicyLedger(); }
  catch (e) { console.log(JSON.stringify({ event: `shark_scout_follower_policy_${phase}_degraded`, error: e instanceof Error ? e.message : String(e) })); }
  try { await buildLiveEdgeController(); }
  catch (e) { console.log(JSON.stringify({ event: `shark_scout_live_edge_${phase}_degraded`, error: e instanceof Error ? e.message : String(e) })); }
}
async function runPipeline() {
  const env = envWithGuardrails();
  console.log(JSON.stringify({
    event: "shark_scout_v050_guardrails",
    pipelineBudgetMs: Number(env.HARVEST_PIPELINE_BUDGET_MS),
    finalizeReserveMs: Number(env.HARVEST_FINALIZE_RESERVE_MS),
    progressiveMaxWallets: Number(env.CANONICAL_PROGRESSIVE_MAX_WALLETS),
    progressiveProviderCalls: Number(env.CANONICAL_PROGRESSIVE_MAX_PROVIDER_CALLS),
    progressivePerWalletCalls: Number(env.CANONICAL_PROGRESSIVE_MAX_PROVIDER_CALLS_PER_WALLET),
    progressiveMaxTxPerWallet: Number(env.CANONICAL_PROGRESSIVE_MAX_TX_PER_WALLET),
    canonicalRescueMaxCalls: Number(env.CANONICAL_RESCUE_MAX_CALLS),
    followerPolicyLedger: true,
    reason: "protect HOT/live truth, persist source-to-policy-to-follower attribution, and keep bounded cold research for ~1 SOL operating scale"
  }));
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, ["dist/harvest_pipeline.js"], { stdio: "inherit", env });
    child.on("error", reject);
    child.on("exit", code => resolve(code ?? 1));
  });
}
async function main() {
  await refreshTruthSurface("pre");
  const code = await runPipeline();
  await refreshTruthSurface("post");
  process.exitCode = code;
}
main().catch(e => {
  console.error(JSON.stringify({ event: "shark_scout_v050_runner_failed", error: e instanceof Error ? e.message : String(e) }));
  process.exitCode = 1;
});
