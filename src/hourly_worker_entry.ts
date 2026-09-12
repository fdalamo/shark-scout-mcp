import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";

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
  odinSnapshot: process.env.SCOUT_ODIN_SNAPSHOT_PATH || "/data/odin-mirror-snapshot.json"
} as const;

function readJson(path: string) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
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
    odinSnapshot: readJson(PATHS.odinSnapshot)
  };
}

const server = createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/audit" || req.url === "/health")) {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify(req.url === "/health" ? { ok: true, at: new Date().toISOString() } : snapshot()));
    return;
  }
  res.statusCode = 404;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error: "not_found" }));
});

server.listen(PORT, HOST, () => {
  console.log(JSON.stringify({ event: "shark_scout_audit_server_started", at: new Date().toISOString(), port: PORT }));
});

void import("./hourly_worker.js");
