import { ChildProcess, spawn } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

const PATCH = "0.55.8-package38-durable-audit";
const RUNNER = "dist/cron_supervisor.js";
const WORKER_STATE_PATH = process.env.SCOUT_HOURLY_WORKER_STATE_PATH || "/data/hourly_worker_state.json";
const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;
const WATCHDOG_GRACE_MINUTES = 5;
const CORE_OVERRIDES = {
  GAUNTLET_PREFILTER_LIMIT: "20",
  GAUNTLET_FULL_LIMIT: "10",
  GAUNTLET_HELIUS_PAGES: "1",
  GAUNTLET_CONCURRENCY: "4",
  GAUNTLET_HELIUS_MIN_INTERVAL_MS: "150",
  GAUNTLET_TIME_BUDGET_SECONDS: "120",
  HARVEST_PROFILE_LIMIT: "8",
  HARVEST_TOKEN_LIMIT: "12",
  CIELO_TAG_ENRICH_PER_RUN: "8",
  CIELO_BRIDGE_TOKEN_LIMIT: "2",
  CIELO_BRIDGE_TRADERS_PER_TOKEN: "3",
  REQUEST_TIMEOUT_MS: "5000"
};
const POST_PROCESSORS = [
  ["mission_discovery", "dist/mission_discovery_runner.js"],
  ["odin_actual_reconciler", "dist/odin_actual_reconciler.js"],
  ["replacement_ladder", "dist/replacement_ladder.js"],
  ["mission_report", "dist/mission_report.js"]
] as const;

const DURABLE_PATHS = {
  pipelineTruth: process.env.SCOUT_PIPELINE_TRUTH_PATH || "/data/pipeline-truth.json",
  missionDiscovery: process.env.SCOUT_MISSION_DISCOVERY_PATH || "/data/mission-discovery-run.json",
  missionReport: process.env.SCOUT_MISSION_REPORT_PATH || "/data/mission-report.json",
  outcomeMiner: process.env.SCOUT_OUTCOME_MINER_PATH || "/data/outcome-miner-v2.json",
  quotaShield: process.env.SCOUT_QUOTA_SHIELD_PATH || "/data/quota-shield-summary.json",
  actualOdin: process.env.SCOUT_ODIN_ACTUAL_RECONCILIATION_PATH || "/data/odin-actual-reconciliation.json",
  replacementLadder: process.env.SCOUT_REPLACEMENT_LADDER_PATH || "/data/replacement-ladder.json"
};

type RunTrigger = "scheduled" | "startup_recovery" | "missed_slot_recovery";
type StageResult = { label: string; status: string; exitCode: number | null; runtimeMs: number };
type LastRunSummary = {
  slot: string;
  trigger: RunTrigger;
  runtimeMs: number;
  runnerResult: StageResult;
  postResults: StageResult[];
  finishedAt: string;
};
type WorkerState = {
  lastStartedSlot: string | null;
  lastFinishedSlot: string | null;
  lastRunStartedAt: string | null;
  lastRunFinishedAt: string | null;
  lastRunSummary: LastRunSummary | null;
};

let current: ChildProcess | null = null;
let shuttingDown = false;
let nextTimer: NodeJS.Timeout | null = null;
let watchdogTimer: NodeJS.Timeout | null = null;

function emit(event: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({
    event,
    patch: PATCH,
    workerPid: process.pid,
    at: new Date().toISOString(),
    ...extra
  }));
}

function slotKey(date = new Date()) {
  return date.toISOString().slice(0, 13);
}

function readJson(file: string, fallback: any = null) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; }
}

function loadWorkerState(): WorkerState {
  try {
    const parsed = JSON.parse(readFileSync(WORKER_STATE_PATH, "utf8")) as Partial<WorkerState>;
    return {
      lastStartedSlot: parsed.lastStartedSlot ?? null,
      lastFinishedSlot: parsed.lastFinishedSlot ?? null,
      lastRunStartedAt: parsed.lastRunStartedAt ?? null,
      lastRunFinishedAt: parsed.lastRunFinishedAt ?? null,
      lastRunSummary: parsed.lastRunSummary ?? null
    };
  } catch {
    return {
      lastStartedSlot: null,
      lastFinishedSlot: null,
      lastRunStartedAt: null,
      lastRunFinishedAt: null,
      lastRunSummary: null
    };
  }
}

let workerState = loadWorkerState();
let lastSlot: string | null = workerState.lastStartedSlot;

function persistWorkerState() {
  try {
    const tmpPath = `${WORKER_STATE_PATH}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(workerState, null, 2));
    renameSync(tmpPath, WORKER_STATE_PATH);
  } catch (error) {
    emit("shark_scout_hourly_worker_state_persist_failed", {
      statePath: WORKER_STATE_PATH,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function emitDurableAuditSnapshot(reason: "startup" | "post_run") {
  const truth = readJson(DURABLE_PATHS.pipelineTruth, {});
  const discovery = readJson(DURABLE_PATHS.missionDiscovery, {});
  const mission = readJson(DURABLE_PATHS.missionReport, {});
  const outcome = readJson(DURABLE_PATHS.outcomeMiner, {});
  const quota = readJson(DURABLE_PATHS.quotaShield, {});
  const actual = readJson(DURABLE_PATHS.actualOdin, {});
  const ladder = readJson(DURABLE_PATHS.replacementLadder, {});
  const outcomeLast = outcome?.last || (Array.isArray(outcome?.runs) ? outcome.runs[outcome.runs.length - 1] : null) || {};
  const replacements = Array.isArray(ladder?.replacementCandidates) ? ladder.replacementCandidates : [];
  emit("shark_scout_hourly_worker_durable_audit_snapshot", {
    reason,
    workerState,
    pipelineTruth: {
      startedAt: truth?.startedAt ?? null,
      finishedAt: truth?.finishedAt ?? null,
      status: truth?.status ?? null,
      runtimeMs: truth?.runtimeMs ?? truth?.durationMs ?? null,
      stageResults: Array.isArray(truth?.stageResults) ? truth.stageResults : []
    },
    missionDiscovery: {
      startedAt: discovery?.startedAt ?? null,
      finishedAt: discovery?.finishedAt ?? null,
      status: discovery?.status ?? null,
      core: discovery?.core ?? null,
      outcome: discovery?.outcome ?? null,
      outcomeMerge: discovery?.outcomeMerge ?? null,
      harvest: discovery?.harvest ?? null,
      harvestProgress: discovery?.harvestProgress ?? null
    },
    outcomeMiner: {
      startedAt: outcomeLast?.startedAt ?? null,
      finishedAt: outcomeLast?.finishedAt ?? null,
      status: outcomeLast?.status ?? null,
      poolsSelected: outcomeLast?.poolsSelected ?? null,
      poolsSucceeded: outcomeLast?.poolsSucceeded ?? null,
      poolsFailed: outcomeLast?.poolsFailed ?? null,
      poolsSkipped: outcomeLast?.poolsSkipped ?? null,
      tradesSeen: outcomeLast?.tradesSeen ?? outcomeLast?.tradeRows ?? null,
      buysSeen: outcomeLast?.buysSeen ?? outcomeLast?.buys ?? null,
      uniqueWallets: outcomeLast?.uniqueWallets ?? null,
      walletsAdmitted: outcomeLast?.walletsAdmitted ?? null,
      newWallets: outcomeLast?.newWallets ?? null,
      crossTokenWallets: outcomeLast?.crossTokenWallets ?? null
    },
    actualOdin: {
      generatedAt: actual?.generatedAt ?? mission?.generatedAt ?? null,
      summary: actual?.summary ?? mission?.actualOdin?.summary ?? {},
      byMirror: actual?.byMirror ?? mission?.actualOdin?.byMirror ?? [],
      unattributedClosedCount: Array.isArray(actual?.rows) ? actual.rows.filter((x: any) => x?.closed && !x?.mirror).length : (Array.isArray(mission?.actualOdin?.unattributedClosed) ? mission.actualOdin.unattributedClosed.length : null)
    },
    replacement: {
      gods: ladder?.tiers?.GOD ?? mission?.replacement?.gods ?? [],
      trialReady: ladder?.tiers?.TRIAL_READY ?? mission?.replacement?.trialReady ?? [],
      topCandidates: replacements.slice(0, 5).length ? replacements.slice(0, 5) : (mission?.replacement?.topCandidates ?? []),
      changes: ladder?.changes ?? mission?.replacement?.changes ?? []
    },
    discovery: mission?.discovery ?? {},
    provider: {
      health: quota?.semanticHealth ?? mission?.provider?.health ?? null,
      pressure: quota?.quotaPressure ?? mission?.provider?.pressure ?? {},
      capabilityBlocks: quota?.capabilityBlocks ?? null
    },
    odinSnapshot: mission?.odinSnapshot ?? {}
  });
}

function nextHourDelayMs(now = new Date()) {
  const next = new Date(now);
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(next.getUTCHours() + 1);
  return Math.max(1_000, next.getTime() - now.getTime());
}

async function runChild(label: string, script: string) {
  if (shuttingDown) return { label, status: "SKIPPED_SHUTDOWN", exitCode: null as number | null, runtimeMs: 0 };
  const startedAt = Date.now();
  const childEnv = label === "shark_scout_runner" ? { ...process.env, ...CORE_OVERRIDES } : process.env;
  emit("shark_scout_hourly_worker_stage_started", { label, script, envOverrides: label === "shark_scout_runner" ? CORE_OVERRIDES : null });
  const child = spawn(process.execPath, [script], { stdio: "inherit", env: childEnv });
  current = child;
  return await new Promise<StageResult>((resolve) => {
    let settled = false;
    const finish = (status: string, exitCode: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      const runtimeMs = Date.now() - startedAt;
      emit("shark_scout_hourly_worker_stage_finished", { label, script, status, exitCode, runtimeMs, error: error || null });
      if (current === child) current = null;
      resolve({ label, status, exitCode, runtimeMs });
    };
    child.once("error", e => finish("SPAWN_ERROR", 1, e.message));
    child.once("close", code => finish(code === 0 ? "SUCCESS" : "FAILED", code ?? 1));
  });
}

async function runOnce(trigger: RunTrigger) {
  if (shuttingDown) return;
  if (current) {
    emit("shark_scout_hourly_worker_overlap_skipped", {
      trigger,
      activePid: current.pid ?? null,
      slot: slotKey()
    });
    return;
  }

  const slot = slotKey();
  if (lastSlot === slot) {
    emit("shark_scout_hourly_worker_duplicate_slot_skipped", { trigger, slot });
    return;
  }
  lastSlot = slot;
  workerState = {
    ...workerState,
    lastStartedSlot: slot,
    lastRunStartedAt: new Date().toISOString()
  };
  persistWorkerState();

  emit("shark_scout_hourly_worker_run_started", { trigger, slot, runner: RUNNER, postProcessors: POST_PROCESSORS.map(x => x[0]), coreOverrides: CORE_OVERRIDES });
  const startedAt = Date.now();
  const runnerResult = await runChild("shark_scout_runner", RUNNER);
  const postResults: StageResult[] = [];
  if (!shuttingDown) {
    for (const [label, script] of POST_PROCESSORS) {
      try { postResults.push(await runChild(label, script)); }
      catch (e) { emit("shark_scout_hourly_worker_postprocessor_exception", { label, error: e instanceof Error ? e.message : String(e) }); }
    }
  }
  const finishedAt = new Date().toISOString();
  const runtimeMs = Date.now() - startedAt;
  const lastRunSummary: LastRunSummary = { slot, trigger, runtimeMs, runnerResult, postResults, finishedAt };
  workerState = {
    ...workerState,
    lastFinishedSlot: slot,
    lastRunFinishedAt: finishedAt,
    lastRunSummary
  };
  persistWorkerState();
  emit("shark_scout_hourly_worker_run_finished", {
    slot,
    runtimeMs,
    runnerResult,
    postResults,
    missionReset: true,
    package2: true,
    package3: true,
    package31: true,
    package32: true,
    package33: true,
    package34: true,
    package35: true,
    package36: true,
    package38: true
  });
  emitDurableAuditSnapshot("post_run");
}

async function watchdogCheck(reason: "startup" | "interval") {
  if (shuttingDown) return;
  const now = new Date();
  const slot = slotKey(now);
  const minute = now.getUTCMinutes();
  const slotSeen = lastSlot === slot || workerState.lastStartedSlot === slot;

  emit("shark_scout_hourly_worker_watchdog_check", {
    reason,
    slot,
    minute,
    slotSeen,
    activePid: current?.pid ?? null,
    lastStartedSlot: workerState.lastStartedSlot,
    lastFinishedSlot: workerState.lastFinishedSlot
  });

  if (minute < WATCHDOG_GRACE_MINUTES || slotSeen) return;
  if (current) {
    emit("shark_scout_hourly_worker_watchdog_deferred", {
      reason,
      slot,
      activePid: current.pid ?? null
    });
    return;
  }

  emit("shark_scout_hourly_worker_missed_slot_detected", {
    reason,
    slot,
    minute,
    recovery: "missed_slot_recovery"
  });
  await runOnce(reason === "startup" ? "startup_recovery" : "missed_slot_recovery");
}

function scheduleNext() {
  if (shuttingDown) return;
  if (nextTimer) clearTimeout(nextTimer);
  const delayMs = nextHourDelayMs();
  emit("shark_scout_hourly_worker_next_run_scheduled", {
    delayMs,
    nextRunAt: new Date(Date.now() + delayMs).toISOString()
  });
  nextTimer = setTimeout(async () => {
    nextTimer = null;
    await runOnce("scheduled");
    scheduleNext();
  }, delayMs);
}

function startWatchdog() {
  if (watchdogTimer) clearInterval(watchdogTimer);
  void watchdogCheck("startup");
  watchdogTimer = setInterval(() => {
    void watchdogCheck("interval");
  }, WATCHDOG_INTERVAL_MS);
}

async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (nextTimer) clearTimeout(nextTimer);
  if (watchdogTimer) clearInterval(watchdogTimer);
  emit("shark_scout_hourly_worker_shutdown", {
    signal,
    activePid: current?.pid ?? null
  });

  const child = current;
  if (child?.pid) {
    try { child.kill("SIGTERM"); } catch {}
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
        resolve();
      }, 10_000);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

emit("shark_scout_hourly_worker_started", {
  pid: process.pid,
  ppid: process.ppid,
  schedule: "top_of_every_hour_utc_equivalent",
  noOverlap: true,
  runner: RUNNER,
  postProcessors: POST_PROCESSORS.map(x => x[0]),
  coreOverrides: CORE_OVERRIDES,
  workerStatePath: WORKER_STATE_PATH,
  watchdogIntervalMs: WATCHDOG_INTERVAL_MS,
  watchdogGraceMinutes: WATCHDOG_GRACE_MINUTES,
  recoveredState: workerState
});
emitDurableAuditSnapshot("startup");

scheduleNext();
startWatchdog();