import { runWithCanonicalHistoryFabric } from "./canonical_history_fabric.js";

// Gauntlet has its own 120s work budget, while the pipeline grants a 150s outer
// envelope. Provider calls launched near the internal deadline must not consume
// the entire 30s finalization reserve. Force the Gauntlet-specific request
// timeout to 3s before loading gauntlet_v6, whose module constants are evaluated
// at import time. This does not change provider selection, candidate limits, or
// trading behavior; it only bounds individual network-call overhang.
const configuredRequestTimeout = Number(process.env.REQUEST_TIMEOUT_MS || 0);
process.env.REQUEST_TIMEOUT_MS = "3000";
console.log(JSON.stringify({
  event: "shark_scout_gauntlet_fabric_budget_guard",
  at: new Date().toISOString(),
  internalBudgetSeconds: Number(process.env.GAUNTLET_TIME_BUDGET_SECONDS || 120),
  requestTimeoutMs: 3000,
  inheritedRequestTimeoutMs: Number.isFinite(configuredRequestTimeout) ? configuredRequestTimeout : null,
  purpose: "preserve_outer_finalization_reserve"
}));

const { runGauntlet } = await import("./gauntlet_v6.js");

runWithCanonicalHistoryFabric("gauntlet",()=>runGauntlet()).catch(e=>{
  console.error(JSON.stringify({event:"shark_scout_gauntlet_fabric_failed",error:e instanceof Error?e.message:String(e)}));
  process.exitCode=1;
});