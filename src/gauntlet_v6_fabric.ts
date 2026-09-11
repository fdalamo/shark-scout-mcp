// Package 3.5 deliberately runs Gauntlet outside the canonical-history fetch
// interceptor. Package 3.4 proved that interceptor does not propagate the
// Gauntlet request AbortSignal: a nominal 3s Gauntlet request can expand into
// many routed raw-RPC calls and keep the stage alive until the 150s supervisor
// kill. Canonical reconstruction still runs in its dedicated pipeline stages;
// Gauntlet should remain a bounded copyability screen, not another canonical
// backfill worker. Direct provider failures remain UNKNOWN/provider evidence.
const configuredRequestTimeout = Number(process.env.REQUEST_TIMEOUT_MS || 0);
process.env.REQUEST_TIMEOUT_MS = "3000";
console.log(JSON.stringify({
  event: "shark_scout_gauntlet_fabric_budget_guard",
  at: new Date().toISOString(),
  internalBudgetSeconds: Number(process.env.GAUNTLET_TIME_BUDGET_SECONDS || 120),
  requestTimeoutMs: 3000,
  inheritedRequestTimeoutMs: Number.isFinite(configuredRequestTimeout) ? configuredRequestTimeout : null,
  canonicalHistoryIntercept: false,
  purpose: "isolate_bounded_gauntlet_from_unbounded_canonical_backfill"
}));

const { runGauntlet } = await import("./gauntlet_v6.js");

runGauntlet().catch(e=>{
  console.error(JSON.stringify({event:"shark_scout_gauntlet_failed",error:e instanceof Error?e.message:String(e)}));
  process.exitCode=1;
});