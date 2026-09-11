import { ChildProcess, spawn } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

const PATCH = "0.55.6-package36-hourly-watchdog";
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

type RunTrigger = "scheduled" | "startup_recovery" | "missed_slot_recovery";
type WorkerState = {
  lastStartedSlot: string | null;
  lastFinishedSlot: string | null;
  lastRunStartedAt: string | null;
  lastRunFinishedAt: string | null;
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

function loadWorkerState(): WorkerState {
  try {
    const parsed = JSON.parse(readFileSync(WORKER_STATE_PATH, "utf8")) as Partial<WorkerState>;
    return {
      lastStartedSlot: parsed.lastStartedSlot ?? null,
      lastFinishedSlot: parsed.lastFinishedSlot ?? null,
      lastRunStartedAt: parsed.lastRunStartedAt ?? null,
      lastRunFinishedAt: parsed.lastRunFinishedAt ?? null
    };
  } catch {
    return {
      lastStartedSlot: null,
      lastFinishedSlot: null,
      lastRunStartedAt: null,
      lastRunFinishedAt: null
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

function nextHourDelayMs(now = new Date()) {
  const next = new Date(now);
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(next.getUTCHours() + 1);
  return Math.max(1_000, next.getTime() - now.getTime());
}

async function runChild(label:string,script:string){
  if(shuttingDown)return {label,status:"SKIPPED_SHUTDOWN",exitCode:null as number|null,runtimeMs:0};
  const startedAt=Date.now();
  const childEnv=label==="shark_scout_runner"?{...process.env,...CORE_OVERRIDES}:process.env;
  emit("shark_scout_hourly_worker_stage_started",{label,script,envOverrides:label==="shark_scout_runner"?CORE_OVERRIDES:null});
  const child=spawn(process.execPath,[script],{stdio:"inherit",env:childEnv});
  current=child;
  return await new Promise<{label:string;status:string;exitCode:number|null;runtimeMs:number}>((resolve)=>{
    let settled=false;
    const finish=(status:string,exitCode:number|null,error?:string)=>{
      if(settled)return;settled=true;
      const runtimeMs=Date.now()-startedAt;
      emit("shark_scout_hourly_worker_stage_finished",{label,script,status,exitCode,runtimeMs,error:error||null});
      if(current===child)current=null;
      resolve({label,status,exitCode,runtimeMs});
    };
    child.once("error",e=>finish("SPAWN_ERROR",1,e.message));
    child.once("close",code=>finish(code===0?"SUCCESS":"FAILED",code??1));
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

  emit("shark_scout_hourly_worker_run_started", { trigger, slot, runner: RUNNER,postProcessors:POST_PROCESSORS.map(x=>x[0]),coreOverrides:CORE_OVERRIDES });
  const startedAt = Date.now();
  const runnerResult=await runChild("shark_scout_runner",RUNNER);
  const postResults=[];
  if(!shuttingDown){
    for(const [label,script] of POST_PROCESSORS){
      try{postResults.push(await runChild(label,script));}
      catch(e){emit("shark_scout_hourly_worker_postprocessor_exception",{label,error:e instanceof Error?e.message:String(e)});}
    }
  }
  workerState = {
    ...workerState,
    lastFinishedSlot: slot,
    lastRunFinishedAt: new Date().toISOString()
  };
  persistWorkerState();
  emit("shark_scout_hourly_worker_run_finished", {
    slot,
    runtimeMs: Date.now()-startedAt,
    runnerResult,
    postResults,
    missionReset:true,
    package2:true,
    package3:true,
    package31:true,
    package32:true,
    package33:true,
    package34:true,
    package35:true,
    package36:true
  });
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
  postProcessors:POST_PROCESSORS.map(x=>x[0]),
  coreOverrides:CORE_OVERRIDES,
  workerStatePath:WORKER_STATE_PATH,
  watchdogIntervalMs:WATCHDOG_INTERVAL_MS,
  watchdogGraceMinutes:WATCHDOG_GRACE_MINUTES,
  recoveredState:workerState
});

scheduleNext();
startWatchdog();