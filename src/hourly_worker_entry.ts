import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";
const AUDIT_TOKEN = process.env.SHARK_TELEMETRY_TOKEN || "";

const PATHS = {
  workerState: process.env.SCOUT_HOURLY_WORKER_STATE_PATH || "/data/hourly_worker_state.json",
  pipelineTruth: process.env.SCOUT_PIPELINE_TRUTH_PATH || "/data/pipeline-truth.json",
  missionDiscovery: process.env.SCOUT_MISSION_DISCOVERY_PATH || "/data/mission-discovery-run.json",
  missionReport: process.env.SCOUT_MISSION_REPORT_PATH || "/data/mission-report.json",
  outcomeMiner: process.env.SCOUT_OUTCOME_MINER_PATH || "/data/outcome-miner-v2.json",
  quotaShield: process.env.SCOUT_QUOTA_SHIELD_PATH || "/data/quota-shield-summary.json",
  actualOdin: process.env.SCOUT_ODIN_ACTUAL_RECONCILIATION_PATH || "/data/odin-actual-reconciliation.json",
  candidateEngine: process.env.SCOUT_CANDIDATE_ENGINE_REPORT_PATH || "/data/candidate-engine-report.json",
  replacementLadder: process.env.SCOUT_REPLACEMENT_LADDER_PATH || "/data/replacement-ladder.json",
  odinSnapshot: process.env.SCOUT_ODIN_SNAPSHOT_PATH || "/data/odin-mirror-snapshot.json",
  paperOdin: process.env.SCOUT_PAPER_ODIN_REPORT_PATH || "/data/paper-odin-report.json",
  dipShadow: process.env.SCOUT_DIP_SHADOW_REPORT_PATH || "/data/dip-shadow-report.json",
  portfolio: process.env.SCOUT_PORTFOLIO_PATH || "/data/portfolio.json",
  opportunity: process.env.SCOUT_OPPORTUNITY_PATH || "/data/opportunity-audit.json",
  odinCapAudit: process.env.SCOUT_ODIN_CAP_AUDIT_PATH || "/data/odin-cap-audit.json",
  liveLedger: process.env.SCOUT_LIVE_LEDGER_PATH || "/data/live-ledger.json"
} as const;

function readJson(path: string) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function compactStudy(value: any) {
  if (!value || typeof value !== "object") return null;
  const take = (v: any) => Array.isArray(v) ? v.slice(0, 12) : undefined;
  return {
    event: value.event ?? null,
    generatedAt: value.generatedAt ?? value.finishedAt ?? value.updatedAt ?? null,
    startedAt: value.startedAt ?? null,
    finishedAt: value.finishedAt ?? null,
    status: value.status ?? null,
    summary: value.summary ?? value.totals ?? null,
    targets: take(value.targets),
    byMirror: take(value.byMirror),
    mirrors: take(value.mirrors),
    wallets: take(value.wallets),
    positions: take(value.positions),
    openPositions: take(value.openPositions),
    holdings: take(value.holdings),
    findings: take(value.findings),
    opportunities: Array.isArray(value.opportunities) ? take(value.opportunities) : value.opportunities ?? null,
    branches: take(value.branches),
    levels: take(value.levels),
    horizonHours: value.horizonHours ?? null,
    active: value.active ?? null,
    closed: value.closed ?? null,
    skippedSignals: value.skippedSignals ?? null,
    rows: take(value.rows),
    counters: value.counters ?? null,
    errors: take(value.errors),
    notes: take(value.notes)
  };
}

function compactJson(value: any, depth = 0): any {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.length > 1000 ? `${value.slice(0, 1000)}…` : value;
  if (depth >= 6) return "[depth-truncated]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => compactJson(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, any> = {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) out[key] = compactJson(item, depth + 1);
    return out;
  }
  return String(value);
}

function snapshot() {
  return {
    generatedAt: new Date().toISOString(),
    workerState: readJson(PATHS.workerState),
    pipelineTruth: readJson(PATHS.pipelineTruth),
    missionDiscovery: readJson(PATHS.missionDiscovery),
    missionReport: readJson(PATHS.missionReport),
    outcomeMiner: readJson(PATHS.outcomeMiner),
    quotaShield: readJson(PATHS.quotaShield),
    actualOdin: readJson(PATHS.actualOdin),
    candidateEngine: readJson(PATHS.candidateEngine),
    replacementLadder: readJson(PATHS.replacementLadder),
    odinSnapshot: readJson(PATHS.odinSnapshot),
    paperOdin: readJson(PATHS.paperOdin),
    dipShadow: readJson(PATHS.dipShadow),
    portfolio: readJson(PATHS.portfolio),
    opportunity: readJson(PATHS.opportunity),
    odinCapAudit: readJson(PATHS.odinCapAudit),
    liveLedger: readJson(PATHS.liveLedger)
  };
}

function emitStudyAuditSnapshot(reason: "startup") {
  console.log(JSON.stringify({
    event: "shark_scout_study_audit_snapshot",
    at: new Date().toISOString(),
    reason,
    candidateEngine: compactStudy(readJson(PATHS.candidateEngine)),
    paperOdin: compactStudy(readJson(PATHS.paperOdin)),
    dipShadow: compactStudy(readJson(PATHS.dipShadow)),
    portfolio: compactStudy(readJson(PATHS.portfolio)),
    opportunity: compactStudy(readJson(PATHS.opportunity)),
    odinCapAudit: compactStudy(readJson(PATHS.odinCapAudit)),
    liveLedger: compactStudy(readJson(PATHS.liveLedger))
  }));
}

function emitDurableArtifactSnapshots(reason: "startup") {
  const current = snapshot();
  for (const [artifact, value] of Object.entries(current)) {
    if (artifact === "generatedAt") continue;
    console.log(JSON.stringify({
      event: "shark_scout_durable_artifact_snapshot",
      at: new Date().toISOString(),
      reason,
      artifact,
      snapshot: compactJson(value)
    }));
  }
}

const server = createServer((req, res) => {
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");

  if (req.method === "GET" && req.url === "/health") {
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, at: new Date().toISOString() }));
    return;
  }

  if (req.method === "GET" && req.url === "/audit") {
    const supplied = req.headers.authorization || "";
    if (!AUDIT_TOKEN || supplied !== `Bearer ${AUDIT_TOKEN}`) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    res.statusCode = 200;
    res.end(JSON.stringify(snapshot()));
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not_found" }));
});

server.listen(PORT, HOST, () => {
  console.log(JSON.stringify({ event: "shark_scout_audit_server_started", at: new Date().toISOString(), port: PORT, auditAuth: "bearer" }));
  emitStudyAuditSnapshot("startup");
  emitDurableArtifactSnapshots("startup");
});

void import("./hourly_worker.js");