import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PUBLIC_AUDIT_DIR = process.env.SCOUT_PUBLIC_AUDIT_DIR || "/data/public-audit";
const WORKER_STATE_PATH = process.env.SCOUT_HOURLY_WORKER_STATE_PATH || "/data/hourly_worker_state.json";
const RETAIN = Math.max(24, Math.min(168, Number(process.env.SCOUT_PUBLIC_AUDIT_RETAIN || 72)));
const POLL_MS = Math.max(2_000, Number(process.env.SCOUT_PUBLIC_AUDIT_POLL_MS || 5_000));

const PATHS = {
  pipelineTruth: process.env.SCOUT_PIPELINE_TRUTH_PATH || "/data/pipeline-truth.json",
  missionDiscovery: process.env.SCOUT_MISSION_DISCOVERY_PATH || "/data/mission-discovery-run.json",
  missionReport: process.env.SCOUT_MISSION_REPORT_PATH || "/data/mission-report.json",
  outcomeMiner: process.env.SCOUT_OUTCOME_MINER_PATH || "/data/outcome-miner-v2.json",
  quotaShield: process.env.SCOUT_QUOTA_SHIELD_PATH || "/data/quota-shield-summary.json",
  gauntlet: process.env.SCOUT_GAUNTLET_REPORT_PATH || "/data/gauntlet-report.json",
  actualOdin: process.env.SCOUT_ODIN_ACTUAL_RECONCILIATION_PATH || "/data/odin-actual-reconciliation.json",
  candidateEngine: process.env.SCOUT_CANDIDATE_ENGINE_REPORT_PATH || "/data/candidate-engine-report.json",
  candidateAccelerator: process.env.SCOUT_CANDIDATE_ACCELERATOR_PATH || "/data/candidate-decision-accelerator.json",
  replacementLadder: process.env.SCOUT_REPLACEMENT_LADDER_PATH || "/data/replacement-ladder.json",
  odinSnapshot: process.env.SCOUT_ODIN_SNAPSHOT_PATH || "/data/odin-mirror-snapshot.json",
  paperOdin: process.env.SCOUT_PAPER_ODIN_REPORT_PATH || "/data/paper-odin-report.json",
  dipShadow: process.env.SCOUT_DIP_SHADOW_REPORT_PATH || "/data/dip-shadow-report.json",
  capitalExpansion: process.env.SCOUT_CAPITAL_EXPANSION_LAB_PATH || "/data/capital-expansion-lab.json",
  portfolio: process.env.SCOUT_PORTFOLIO_PATH || "/data/portfolio.json",
  opportunity: process.env.SCOUT_OPPORTUNITY_PATH || "/data/opportunity-audit.json",
  odinCapAudit: process.env.SCOUT_ODIN_CAP_AUDIT_PATH || "/data/odin-cap-audit.json",
  liveLedger: process.env.SCOUT_LIVE_LEDGER_PATH || "/data/live-ledger.json"
} as const;

const KNOWN_LABELS: Record<string, string> = {
  "6mzEFZ458A6qcaQLgtBuYYaGJ1qN5tz2Wsr6PC1fLFzx": "6mz",
  "ianCETBFexGgK8TA3gSLeAaNiLMsJPgUN1H44jhxQtB": "Ian",
  "43Xr2qhHh4RYM5eqBe3QN9ntjKBE2aubiKYXShhQ5nuw": "43Xr",
  "BQnTBqFymxqfiWUrrwckcEU2Umyc2YwzuhTPrgmxU52n": "BQn",
  "CEej4Kvte9CrN7DTyH5ADHMiQVH2GHqEQGoLuB4aaVd3": "CEej",
  "CkTwpth6KSF2LsEMxvEQrmgY8fQ2u4kkaAsrnMC8sAYU": "CkTw",
  "5mcTKhm5iyb8Zz3jpxuNr7BT78i6AKy5RqoMGkFNj8ZZ": "5mc",
  "EaHfi377diE3zHeY3miaaegDt5Yw7emEQ5ZU4RfLmnYK": "EaHfi",
  "HNY9N7vrkgMAQbBoZBpx5QQkieNqyqBQ3vcRhikHvHQP": "HNY",
  "5WXARcGzGVxofbeY6jK69Ab17noxF3gXjLpFAWkLW3ec": "5WX",
  "GUXfDqM59MPpY31rFMhM8nm3Zrpim68AUCeX5Zm3nyyt": "GUXf"
};

type Json = Record<string, any>;

function readJson(path: string, fallback: any = null) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function atomicWrite(path: string, value: unknown) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

function asArray<T = any>(value: any): T[] { return Array.isArray(value) ? value : []; }
function num(value: any) { return Number.isFinite(Number(value)) ? Number(value) : null; }
function generatedAt(value: any) { return value?.generatedAt ?? value?.finishedAt ?? value?.updatedAt ?? null; }
function ageHours(ts: any) { const t = Date.parse(String(ts || "")); return Number.isFinite(t) ? Math.max(0, (Date.now() - t) / 3_600_000) : null; }
function addrLabel(address: any) {
  const a = typeof address === "string" ? address : "";
  if (!a) return null;
  return KNOWN_LABELS[a] || `${a.slice(0, 5)}…${a.slice(-4)}`;
}

function sanitizeStage(stage: any) {
  return {
    name: stage?.name ?? stage?.label ?? null,
    status: stage?.status ?? null,
    runtimeMs: num(stage?.durationMs ?? stage?.runtimeMs),
    execution: stage?.execution ?? null,
    degradedReason: stage?.degradedReason ?? null
  };
}

function sanitizeShadowCandidate(row: any) {
  const monitor = row?.shadow?.monitor ?? {};
  const vitality = row?.vitality ?? row?.acceleration?.vitality ?? monitor?.vitality ?? {};
  return {
    wallet: addrLabel(row?.address),
    stage: row?.stage ?? row?.candidateStage ?? null,
    score: num(row?.funnel?.nearPassScore ?? row?.nearPassScore ?? row?.score),
    historical: {
      canonicalTrades: num(row?.historical?.canonicalTrades ?? row?.replay?.trades),
      netSol: num(row?.historical?.netSol ?? row?.replay?.net),
      stress50NetSol: num(row?.historical?.stress50NetSol ?? row?.replay?.stress50),
      medianHoldHours: num(row?.historical?.medianHoldHours ?? row?.medianHoldHours),
      sampleRisk: row?.historical?.sampleRisk ?? row?.sampleQuality?.risk ?? null,
      discoveryContexts: num(row?.historical?.discoveryContexts ?? row?.sampleQuality?.discoveryContexts)
    },
    shadow: row?.shadow ? {
      ageHours: num(row?.shadow?.evaluation?.ageHours),
      decision: row?.shadow?.evaluation?.decision ?? null,
      reason: row?.shadow?.evaluation?.reason ?? null,
      closed: num(row?.shadow?.metrics?.closed),
      distinctMints: num(row?.shadow?.metrics?.distinctMints),
      netSol: num(row?.shadow?.metrics?.netSol),
      stress50NetSol: num(row?.shadow?.metrics?.stress50NetSol),
      wins: num(row?.shadow?.metrics?.wins),
      losses: num(row?.shadow?.metrics?.losses),
      lastSellAt: row?.shadow?.metrics?.lastSellAt ?? null,
      scanCount: num(monitor?.scanCount),
      ambiguity: num(monitor?.replayDiagnostics?.ambiguous),
      ambiguityReasons: monitor?.replayDiagnostics?.ambiguousReasons ?? null
    } : null,
    vitality: {
      lastSourceSwapAt: vitality?.lastSourceSwapAt ?? vitality?.lastSourceActivityAt ?? null,
      hoursSinceLastSourceSwap: num(vitality?.hoursSinceLastSourceSwap ?? vitality?.hoursSinceLastSourceActivity),
      sourceRowsSinceTrial: num(vitality?.sourceRowsSinceTrial ?? vitality?.sourceSwapsSinceTrial),
      sourceRows6h: num(vitality?.sourceRows6h ?? vitality?.sourceSwaps6h),
      sourceRows24h: num(vitality?.sourceRows24h ?? vitality?.sourceSwaps24h),
      sourceRows72h: num(vitality?.sourceRows72h ?? vitality?.sourceSwaps72h)
    },
    nextBestEvidence: row?.evidenceManifest?.nextBestEvidence ?? null
  };
}

function sanitizeActual(actual: any) {
  return {
    generatedAt: generatedAt(actual),
    summary: actual?.summary ? {
      followerLots: num(actual.summary.followerLots),
      closedLots: num(actual.summary.closedLots),
      openLots: num(actual.summary.openLots),
      attributedClosed: num(actual.summary.attributedClosed),
      unattributedClosed: num(actual.summary.unattributedClosed),
      attributedNetSol: num(actual.summary.attributedNetSol),
      unattributedNetSol: num(actual.summary.unattributedNetSol),
      totalClosedNetSol: num(actual.summary.totalClosedNetSol),
      governanceSafe: Boolean(actual.summary.governanceSafe)
    } : null,
    byMirror: asArray(actual?.byMirror).slice(0, 12).map((x: any) => ({
      wallet: addrLabel(x?.mirror ?? x?.address),
      closed: num(x?.closed), wins: num(x?.wins), losses: num(x?.losses), netSol: num(x?.netSol)
    }))
  };
}

function sanitizeOdin(snapshot: any) {
  return {
    generatedAt: snapshot?.fetchedAt ?? generatedAt(snapshot),
    changedSincePrevious: snapshot?.changedSincePrevious ?? null,
    mirrors: asArray(snapshot?.mirrors).slice(0, 16).map((x: any) => ({
      wallet: addrLabel(x?.address),
      buyEnabled: x?.allowBuys !== false,
      allowBuys: x?.allowBuys ?? null,
      maxBuysPerMirrorPerDay: num(x?.maxBuysPerMirrorPerDay),
      tradeSizeSol: num(x?.tradeSizeLamports) == null ? null : Number(x.tradeSizeLamports) / 1_000_000_000,
      minMarketCap: num(x?.minMarketCap),
      maxMarketCap: num(x?.maxMarketCap),
      onlyCopyNewPositions: x?.onlyCopyNewPositions ?? null
    }))
  };
}

function sanitizePaper(paper: any) {
  return {
    generatedAt: generatedAt(paper),
    wallets: asArray(paper?.wallets).slice(0, 12).map((x: any) => ({
      wallet: addrLabel(x?.address),
      signals: num(x?.signals),
      paperBuys: num(x?.paperBuys),
      openPositions: num(x?.openPositions),
      closedPositions: num(x?.closedPositions),
      realizedNetSol: Math.abs(Number(x?.realizedNetSol || 0)) > 1_000 ? null : num(x?.realizedNetSol),
      pnlQuarantined: Math.abs(Number(x?.realizedNetSol || 0)) > 1_000,
      winRate: num(x?.winRate),
      skipReasons: x?.skipReasons ?? null,
      policy: x?.policy ? {
        tradeSizeSol: num(x.policy.tradeSizeSol), dailyCap: num(x.policy.dailyCap), hourlyCap: num(x.policy.hourlyCap),
        tokenDayCap: num(x.policy.tokenDayCap), tokenWeekCap: num(x.policy.tokenWeekCap),
        newPositionOnly: x.policy.newPositionOnly ?? null, minMarketCapUsd: num(x.policy.minMarketCapUsd)
      } : null
    }))
  };
}

function sanitizeDip(dip: any) {
  return {
    generatedAt: generatedAt(dip),
    opportunities: num(dip?.opportunities),
    active: num(dip?.active),
    closed: num(dip?.closed),
    branches: asArray(dip?.branches).slice(0, 8).map((x: any) => ({
      label: x?.label ?? null, eligible: num(x?.eligible), triggered: num(x?.triggered), open: num(x?.open), closed: num(x?.closed), expired: num(x?.expired), realizedNetSol: num(x?.realizedNetSol)
    })),
    wallets: asArray(dip?.wallets).slice(0, 12).map((x: any) => ({ wallet: addrLabel(x?.wallet), opportunities: num(x?.opportunities), active: num(x?.active) })),
    errorCount: asArray(dip?.errors).length
  };
}

function sanitizeCapitalExpansion(cap: any) {
  return {
    generatedAt: generatedAt(cap),
    guardrails: cap?.guardrails ?? null,
    wallets: asArray(cap?.wallets).slice(0, 10).map((x: any) => ({
      wallet: addrLabel(x?.address ?? x?.wallet),
      recommendation: x?.recommendation ?? x?.decision ?? null,
      branches: asArray(x?.branches ?? x?.experiments).slice(0, 10).map((b: any) => ({
        label: b?.label ?? b?.name ?? b?.branch ?? null,
        opportunities: num(b?.opportunities ?? b?.eligible),
        observedExits: num(b?.observedExits ?? b?.closed),
        distinctMints: num(b?.distinctMints),
        netSol: num(b?.netSol ?? b?.baseNetSol),
        stress50NetSol: num(b?.stress50NetSol),
        largestWinnerShare: num(b?.largestWinnerShare),
        decision: b?.decision ?? b?.recommendation ?? null
      }))
    }))
  };
}

function sanitizeReplacement(ladder: any) {
  const pool = [
    ...asArray(ladder?.tiers?.TRIAL_READY),
    ...asArray(ladder?.tiers?.SHADOW_TRIAL),
    ...asArray(ladder?.historicalLeaders),
    ...asArray(ladder?.replacementCandidates)
  ];
  const seen = new Set<string>();
  return pool.filter((x: any) => {
    const a = String(x?.address || ""); if (!a || seen.has(a)) return false; seen.add(a); return true;
  }).slice(0, 12).map((x: any) => ({
    wallet: addrLabel(x?.address),
    tier: x?.tier ?? x?.candidateStage ?? null,
    historicalTier: x?.historicalTier ?? null,
    score: num(x?.score ?? x?.nearPassScore),
    status: x?.status ?? null,
    replay: x?.replay ? { trades: num(x.replay.trades), netSol: num(x.replay.net), stress50NetSol: num(x.replay.stress50) } : null,
    blockers: asArray(x?.blockers).slice(0, 8)
  }));
}

function portfolioFreshness(portfolio: any) {
  const ts = generatedAt(portfolio);
  const hours = ageHours(ts);
  return {
    generatedAt: ts,
    ageHours: hours,
    stale: hours == null ? true : hours > 3,
    positionCount: asArray(portfolio?.positions).length,
    errorCount: asArray(portfolio?.errors).length
  };
}

function buildPublicSnapshot() {
  const worker = readJson(WORKER_STATE_PATH, {});
  const truth = readJson(PATHS.pipelineTruth, {});
  const discovery = readJson(PATHS.missionDiscovery, {});
  const mission = readJson(PATHS.missionReport, {});
  const outcomeRaw = readJson(PATHS.outcomeMiner, {});
  const outcome = outcomeRaw?.last || asArray(outcomeRaw?.runs).at(-1) || outcomeRaw || {};
  const quota = readJson(PATHS.quotaShield, {});
  const gauntlet = readJson(PATHS.gauntlet, {});
  const actual = readJson(PATHS.actualOdin, {});
  const candidate = readJson(PATHS.candidateEngine, {});
  const accelerator = readJson(PATHS.candidateAccelerator, {});
  const ladder = readJson(PATHS.replacementLadder, {});
  const odin = readJson(PATHS.odinSnapshot, {});
  const paper = readJson(PATHS.paperOdin, {});
  const dip = readJson(PATHS.dipShadow, {});
  const cap = readJson(PATHS.capitalExpansion, {});
  const portfolio = readJson(PATHS.portfolio, {});
  const opportunity = readJson(PATHS.opportunity, {});
  const capAudit = readJson(PATHS.odinCapAudit, {});
  const liveLedger = readJson(PATHS.liveLedger, {});

  const summary = worker?.lastRunSummary ?? {};
  const postResults = asArray(summary?.postResults);
  const runSucceeded = summary?.runnerResult?.status === "SUCCESS" && postResults.every((x: any) => x?.status === "SUCCESS");
  const slot = worker?.lastFinishedSlot ?? summary?.slot ?? null;
  const coreStages = asArray(truth?.stageResults).map(sanitizeStage);
  const harvestStage = coreStages.find((x: any) => x.name === "harvest_scout") ?? null;
  const providerPressure = quota?.quotaPressure ?? mission?.provider?.pressure ?? {};
  const canonicalCoverage = mission?.discovery?.canonicalCoverage ?? mission?.canonicalCoverage ?? null;

  const anomalies: string[] = [];
  if (!runSucceeded) anomalies.push("RUN_NOT_FULLY_SUCCESSFUL");
  if (String(quota?.semanticHealth ?? mission?.provider?.health ?? "").includes("DEGRADED")) anomalies.push("PROVIDER_DEGRADED");
  if (portfolioFreshness(portfolio).stale) anomalies.push("PORTFOLIO_STALE");
  const attr = Number(actual?.summary?.attributedClosed || 0), closed = Number(actual?.summary?.closedLots || 0);
  if (closed > 0 && attr / closed < 0.5) anomalies.push("ACTUAL_ATTRIBUTION_LOW");
  const pending = Number(gauntlet?.pendingAtStart ?? mission?.gauntlet?.pendingAtStart ?? 0);
  if (pending > 5000) anomalies.push("GAUNTLET_BACKLOG_HIGH");

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    slot,
    status: runSucceeded ? "SUCCESS" : "DEGRADED_OR_UNKNOWN",
    startedAt: worker?.lastRunStartedAt ?? truth?.startedAt ?? null,
    finishedAt: worker?.lastRunFinishedAt ?? truth?.finishedAt ?? null,
    runtimeMs: num(summary?.runtimeMs),
    trigger: summary?.trigger ?? null,
    stages: {
      runner: sanitizeStage(summary?.runnerResult ?? {}),
      postProcessors: postResults.map(sanitizeStage),
      core: coreStages
    },
    provider: {
      health: quota?.semanticHealth ?? mission?.provider?.health ?? null,
      pressure: {
        total: num(providerPressure?.total), http429: num(providerPressure?.http429), maxUsage: num(providerPressure?.maxUsage),
        rateLimit: num(providerPressure?.rateLimit), computeOrRps: num(providerPressure?.computeOrRps)
      },
      capabilityBlocks: quota?.capabilityBlocks ?? null
    },
    discovery: {
      status: discovery?.status ?? null,
      tradesSeen: num(outcome?.tradesSeen ?? outcome?.tradeRows),
      buysSeen: num(outcome?.buysSeen ?? outcome?.buys),
      uniqueWallets: num(outcome?.uniqueWallets),
      walletsAdmitted: num(outcome?.walletsAdmitted),
      newWallets: num(outcome?.newWallets),
      crossTokenWallets: num(outcome?.crossTokenWallets),
      poolsSelected: num(outcome?.poolsSelected),
      poolsSucceeded: num(outcome?.poolsSucceeded),
      poolsFailed: num(outcome?.poolsFailed)
    },
    harvest: {
      stage: harvestStage,
      mission: discovery?.harvest ?? null,
      progress: discovery?.harvestProgress ?? null
    },
    gauntlet: {
      eligible: num(gauntlet?.eligible ?? mission?.gauntlet?.eligible),
      pendingAtStart: num(gauntlet?.pendingAtStart ?? mission?.gauntlet?.pendingAtStart),
      prefiltered: num(gauntlet?.prefiltered ?? mission?.gauntlet?.prefiltered),
      fullEvaluated: num(gauntlet?.fullEvaluated ?? gauntlet?.evaluated ?? mission?.gauntlet?.fullEvaluated),
      remaining: num(gauntlet?.remaining ?? mission?.gauntlet?.remaining),
      canonicalCoverage: canonicalCoverage ? { wallets: num(canonicalCoverage.wallets), pct: num(canonicalCoverage.pct) } : null
    },
    candidates: {
      generatedAt: generatedAt(candidate),
      stageCounts: candidate?.stageCounts ?? null,
      shadowMonitoring: candidate?.shadowMonitoring ?? null,
      acceleration: candidate?.acceleration ?? accelerator ?? null,
      shadowActive: asArray(candidate?.shadowActive).slice(0, 8).map(sanitizeShadowCandidate),
      trialReady: asArray(candidate?.odinTrialReady).slice(0, 8).map(sanitizeShadowCandidate),
      reconstructionPriority: asArray(candidate?.reconstructionPriority).slice(0, 8).map(sanitizeShadowCandidate)
    },
    replacement: sanitizeReplacement(ladder),
    actualOdin: sanitizeActual(actual),
    odin: sanitizeOdin(odin),
    paperOdin: sanitizePaper(paper),
    dipShadow: sanitizeDip(dip),
    capitalExpansion: sanitizeCapitalExpansion(cap),
    portfolio: portfolioFreshness(portfolio),
    experiments: {
      opportunityGeneratedAt: generatedAt(opportunity),
      opportunityStatus: opportunity?.status ?? null,
      opportunityFindingCount: asArray(opportunity?.findings).length,
      capAuditGeneratedAt: generatedAt(capAudit),
      capAuditRowCount: asArray(capAudit?.rows).length,
      liveLedgerGeneratedAt: generatedAt(liveLedger)
    },
    freshness: {
      worker: worker?.lastRunFinishedAt ?? null,
      pipeline: generatedAt(truth), discovery: generatedAt(discovery), candidates: generatedAt(candidate), actualOdin: generatedAt(actual),
      odin: odin?.fetchedAt ?? generatedAt(odin), paperOdin: generatedAt(paper), dipShadow: generatedAt(dip), capitalExpansion: generatedAt(cap), portfolio: generatedAt(portfolio)
    },
    anomalies,
    privacy: {
      publicReadOnly: true,
      secretsIncluded: false,
      exactUnknownWalletAddressesIncluded: false,
      tradingActionsAvailable: false
    }
  };
}

function ensureDir() { mkdirSync(PUBLIC_AUDIT_DIR, { recursive: true }); }
function slotPath(slot: string) { return join(PUBLIC_AUDIT_DIR, `${slot}.json`); }
function latestPath() { return join(PUBLIC_AUDIT_DIR, "latest.json"); }
function historyPath() { return join(PUBLIC_AUDIT_DIR, "history.json"); }

function publishSnapshot() {
  ensureDir();
  const snapshot = buildPublicSnapshot();
  if (!snapshot.slot) return null;
  atomicWrite(slotPath(snapshot.slot), snapshot);
  atomicWrite(latestPath(), snapshot);
  const oldHistory = asArray(readJson(historyPath(), []));
  const history = [...oldHistory.filter((x: any) => x?.slot !== snapshot.slot), snapshot]
    .sort((a: any, b: any) => String(a?.slot || "").localeCompare(String(b?.slot || "")))
    .slice(-RETAIN);
  atomicWrite(historyPath(), history);
  const keep = new Set(history.map((x: any) => `${x.slot}.json`));
  for (const name of readdirSync(PUBLIC_AUDIT_DIR)) {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}\.json$/.test(name) && !keep.has(name)) {
      try { unlinkSync(join(PUBLIC_AUDIT_DIR, name)); } catch {}
    }
  }
  console.log(JSON.stringify({ event: "shark_scout_public_audit_published", at: new Date().toISOString(), slot: snapshot.slot, status: snapshot.status, path: latestPath(), retained: history.length }));
  return snapshot;
}

let timer: NodeJS.Timeout | null = null;
let lastPublishedSlot: string | null = null;

export function startPublicAuditFeed() {
  ensureDir();
  const latest = readJson(latestPath(), null);
  lastPublishedSlot = latest?.slot ?? null;
  const check = () => {
    const worker = readJson(WORKER_STATE_PATH, {});
    const slot = worker?.lastFinishedSlot ?? null;
    if (slot && slot !== lastPublishedSlot) {
      const published = publishSnapshot();
      if (published?.slot) lastPublishedSlot = published.slot;
    }
  };
  check();
  if (!timer) timer = setInterval(check, POLL_MS);
  return { directory: PUBLIC_AUDIT_DIR, retain: RETAIN, pollMs: POLL_MS, lastPublishedSlot };
}

export function readPublicAuditLatest() { return readJson(latestPath(), null); }
export function readPublicAuditHistory() { return asArray(readJson(historyPath(), [])); }
export function readPublicAuditSlot(slot: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(slot)) return null;
  return readJson(slotPath(slot), null);
}
