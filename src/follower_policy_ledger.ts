import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { walletPolicy } from "./wallet_policy.js";

type AnyObj = Record<string, any>;

const ODIN_PATH = process.env.SCOUT_ODIN_SNAPSHOT_PATH || "/data/odin-config.json";
const TRUTH_PATH = process.env.SCOUT_ODIN_TRUTH_LEDGER_PATH || "/data/odin-truth-ledger.json";
const OUT_PATH = process.env.SCOUT_FOLLOWER_POLICY_LEDGER_PATH || "/data/follower-policy-ledger.json";

async function read(file: string, fallback: any) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return fallback; }
}
async function atomic(file: string, data: any) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}
function num(v: any): number | null {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}
function sum(xs: Array<number | null | undefined>) {
  return xs.reduce<number>((a, b) => a + (typeof b === "number" && Number.isFinite(b) ? b : 0), 0);
}
function configHash(v: any) {
  return createHash("sha256").update(JSON.stringify(v ?? {})).digest("hex").slice(0, 16);
}
function decision(row: AnyObj) {
  const state = String(row?.state || "");
  const eligibility = String(row?.odinEligibility || "");
  const skip = String(row?.odinSkipReason || row?.executionEvidence?.reason || "");
  const executionSource = String(row?.executionEvidence?.source || "");

  if (state === "FOLLOWER_BUY_MATCHED") return { decision: "COPIED", evidence: "OBSERVED_FOLLOWER", reason: null, confidence: "HIGH" };
  if (state === "COPY_BLOCKED_BY_ODIN_POLICY") {
    const direct = /EXACT|ODIN_LOG|OBSERVED_EXECUTION/i.test(executionSource);
    return { decision: "BLOCKED", evidence: direct ? "OBSERVED_BLOCKED" : "INFERRED_BLOCKED", reason: skip || "POLICY_LIMIT", confidence: direct ? "HIGH" : String(row?.executionEvidence?.confidence || "HIGH") };
  }
  if (eligibility === "ODIN_INELIGIBLE") return { decision: "BLOCKED", evidence: "SIMULATED_POLICY", reason: skip || "ODIN_INELIGIBLE", confidence: "MEDIUM" };
  if (state === "EXPECTED_COPY_NOT_MATCHED" || eligibility === "ODIN_ELIGIBLE") return { decision: "ELIGIBLE_NOT_COPIED", evidence: "POLICY_ELIGIBLE", reason: null, confidence: "HIGH" };
  return { decision: "UNKNOWN", evidence: "INSUFFICIENT_EVIDENCE", reason: skip || null, confidence: "LOW" };
}
function ruleKey(row: AnyObj, d: AnyObj) {
  if (d.decision !== "BLOCKED") return null;
  const r = String(d.reason || "UNKNOWN").toUpperCase();
  if (r.includes("NEW_POSITION")) return "NEW_POSITION_ONLY";
  if (r.includes("MARKET_CAP_BELOW")) return "MIN_MARKET_CAP";
  if (r.includes("MARKET_CAP_ABOVE")) return "MAX_MARKET_CAP";
  if (r.includes("TOKEN_WEEK_CAP")) return "TOKEN_WEEK_CAP";
  if (r.includes("TOKEN_DAY_CAP")) return "TOKEN_DAY_CAP";
  if (r.includes("DAILY_CAP")) return "DAILY_CAP";
  if (r.includes("HOURLY_CAP")) return "HOURLY_CAP";
  if (r.includes("BUYS_DISABLED")) return "BUYS_DISABLED";
  return r || "OTHER_POLICY";
}

export async function buildFollowerPolicyLedger() {
  const generatedAt = new Date().toISOString();
  const [odin, truth, prior] = await Promise.all([
    read(ODIN_PATH, {}),
    read(TRUTH_PATH, { entries: {} }),
    read(OUT_PATH, { entries: {} })
  ]);
  const snapshotHash = configHash(odin);
  const priorEntries: Record<string, AnyObj> = prior?.entries && typeof prior.entries === "object" ? prior.entries : {};
  const truthEntries = Object.values(truth?.entries || {}) as AnyObj[];
  const entries: Record<string, AnyObj> = { ...priorEntries };

  for (const row of truthEntries) {
    const mirror = String(row?.mirror || "");
    const sourceSignature = String(row?.sourceSignature || "");
    if (!mirror || !sourceSignature) continue;
    const key = `${mirror}|${sourceSignature}`;
    const d = decision(row);
    const policy = walletPolicy(mirror);
    const roundTrip = row?.sourceRoundTrip || null;
    const previous = entries[key] || {};
    entries[key] = {
      ...previous,
      key,
      mirror,
      mint: row?.mint || null,
      sourceSignature,
      sourceBuyAt: row?.sourceBuyAt || null,
      sourceTimestamp: row?.sourceTimestamp ?? null,
      sourceBuySol: num(row?.sourceBuySol),
      sourceBuyQty: num(row?.sourceBuyQty),
      policySnapshotHash: snapshotHash,
      policyFingerprint: row?.paperPolicyFingerprint || null,
      policy,
      odinDecision: d.decision,
      decisionEvidence: d.evidence,
      decisionReason: d.reason,
      decisionConfidence: d.confidence,
      copied: Boolean(row?.copied || row?.state === "FOLLOWER_BUY_MATCHED"),
      followerBuySignature: row?.copySignature || null,
      followerBuyDelaySeconds: num(row?.copyDelaySeconds),
      followerExitObserved: Boolean(row?.followerExitObserved),
      followerExitSignature: row?.followerExitSignature || null,
      followerExitDelaySeconds: num(row?.followerExitDelaySeconds),
      sourceRoundTrip: roundTrip,
      estimatedFollowerNetSol: num(roundTrip?.estimatedFollowerNetSol),
      sourceRoi: num(roundTrip?.sourceRoi),
      ruleKey: ruleKey(row, d),
      firstSeenAt: previous.firstSeenAt || row?.firstObservedAt || generatedAt,
      lastSeenAt: row?.lastObservedAt || generatedAt,
      updatedAt: generatedAt
    };
  }

  const rows = Object.values(entries);
  const liveMirrors = (Array.isArray(odin?.mirrors) ? odin.mirrors : []).map((x: AnyObj) => String(x?.address || x?.wallet || x?.sourceWallet || "")).filter(Boolean);
  const byMirror = liveMirrors.map((mirror: string) => {
    const rs = rows.filter((x: AnyObj) => x.mirror === mirror);
    const copied = rs.filter((x: AnyObj) => x.odinDecision === "COPIED");
    const blocked = rs.filter((x: AnyObj) => x.odinDecision === "BLOCKED");
    const eligibleMiss = rs.filter((x: AnyObj) => x.odinDecision === "ELIGIBLE_NOT_COPIED");
    const knownBlocked = blocked.filter((x: AnyObj) => typeof x.estimatedFollowerNetSol === "number");
    const rules: Record<string, AnyObj> = {};
    for (const r of blocked) {
      const k = String(r.ruleKey || "OTHER_POLICY");
      const bucket = rules[k] || { blocked: 0, knownOutcomes: 0, avoidedLossSol: 0, missedProfitSol: 0, netRuleValueSol: 0, observed: 0, inferred: 0, simulated: 0 };
      bucket.blocked += 1;
      if (r.decisionEvidence === "OBSERVED_BLOCKED") bucket.observed += 1;
      if (r.decisionEvidence === "INFERRED_BLOCKED") bucket.inferred += 1;
      if (r.decisionEvidence === "SIMULATED_POLICY") bucket.simulated += 1;
      const net = num(r.estimatedFollowerNetSol);
      if (net !== null) {
        bucket.knownOutcomes += 1;
        if (net < 0) bucket.avoidedLossSol += Math.abs(net);
        if (net > 0) bucket.missedProfitSol += net;
        bucket.netRuleValueSol = bucket.avoidedLossSol - bucket.missedProfitSol;
      }
      rules[k] = bucket;
    }
    return {
      mirror,
      policy: walletPolicy(mirror),
      opportunitiesTracked: rs.length,
      copied: copied.length,
      blocked: blocked.length,
      eligibleNotCopied: eligibleMiss.length,
      unknown: rs.filter((x: AnyObj) => x.odinDecision === "UNKNOWN").length,
      followerMatchesWithDelay: copied.filter((x: AnyObj) => typeof x.followerBuyDelaySeconds === "number").length,
      meanFollowerDelaySeconds: (() => { const xs = copied.map((x: AnyObj) => num(x.followerBuyDelaySeconds)).filter((x: number | null): x is number => x !== null); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; })(),
      eligibleMissKnownNetSol: sum(eligibleMiss.map((x: AnyObj) => num(x.estimatedFollowerNetSol))),
      blockedKnownNetSol: sum(knownBlocked.map((x: AnyObj) => num(x.estimatedFollowerNetSol))),
      rules
    };
  });

  const out = {
    schemaVersion: 1,
    event: "shark_scout_follower_policy_ledger_complete",
    generatedAt,
    policySnapshotHash: snapshotHash,
    entryCount: rows.length,
    liveMirrorCount: liveMirrors.length,
    summary: {
      copied: rows.filter((x: AnyObj) => x.odinDecision === "COPIED").length,
      blocked: rows.filter((x: AnyObj) => x.odinDecision === "BLOCKED").length,
      observedBlocked: rows.filter((x: AnyObj) => x.decisionEvidence === "OBSERVED_BLOCKED").length,
      inferredBlocked: rows.filter((x: AnyObj) => x.decisionEvidence === "INFERRED_BLOCKED").length,
      simulatedPolicyBlocked: rows.filter((x: AnyObj) => x.decisionEvidence === "SIMULATED_POLICY").length,
      eligibleNotCopied: rows.filter((x: AnyObj) => x.odinDecision === "ELIGIBLE_NOT_COPIED").length,
      unknown: rows.filter((x: AnyObj) => x.odinDecision === "UNKNOWN").length
    },
    byMirror,
    entries,
    guardrails: { observationalOnly: true, mutatesOdin: false, changesCapital: false, changesCaps: false, changesFilters: false, changesSpeed: false },
    notes: [
      "Observed follower transactions are ground truth for copies.",
      "Inferred blocks are never silently promoted to observed Odin blocks.",
      "Policy simulation uses the current wallet-specific registry and truth-ledger evidence.",
      "Rule value is avoided modeled losses minus missed modeled profits and is only computed where a source outcome exists.",
      "Eligible-not-copied is kept distinct from policy-blocked so execution/transfer misses are not misclassified.",
      "The ledger is durable across hourly runs and keyed by mirror|source-signature."
    ]
  };
  await atomic(OUT_PATH, out);
  console.log(JSON.stringify(out));
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) buildFollowerPolicyLedger().catch(e => {
  console.error(JSON.stringify({ event: "shark_scout_follower_policy_ledger_failed", error: e instanceof Error ? e.message : String(e) }));
  process.exitCode = 1;
});
