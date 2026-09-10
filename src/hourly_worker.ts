import { ChildProcess, spawn } from "node:child_process";

const PATCH = "0.53.0-hourly-worker";
const RUNNER = "dist/cron_supervisor.js";

let current: ChildProcess | null = null;
let shuttingDown = false;
let lastSlot: string | null = null;
let nextTimer: NodeJS.Timeout | null = null;

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

function nextHourDelayMs(now = new Date()) {
  const next = new Date(now);
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(next.getUTCHours() + 1);
  return Math.max(1_000, next.getTime() - now.getTime());
}

async function runOnce(trigger: "scheduled" | "startup_recovery") {
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

  emit("shark_scout_hourly_worker_run_started", { trigger, slot, runner: RUNNER });
  const startedAt = Date.now();

  const child = spawn(process.execPath, [RUNNER], {
    stdio: "inherit",
    env: process.env
  });
  current = child;

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (result: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      const runtimeMs = Date.now() - startedAt;
      emit("shark_scout_hourly_worker_run_finished", {
        slot,
        runtimeMs,
        childPid: child.pid ?? null,
        ...result
      });
      current = null;
      resolve();
    };

    child.once("error", (error) => finish({ status: "SPAWN_ERROR", error: error.message }));
    child.once("close", (code, signal) => finish({ status: "CLOSED", exitCode: code, signal }));
  });
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

async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (nextTimer) clearTimeout(nextTimer);
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
  runner: RUNNER
});

// Intentionally wait for the next top-of-hour boundary after a deployment so
// the deployment itself cannot create an unscheduled duplicate Shark Scout run.
scheduleNext();
