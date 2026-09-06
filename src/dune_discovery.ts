import { promises as fs } from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";

const DUNE_KEY = process.env.DUNE_API_KEY?.trim();
const ENABLED = /^(1|true|yes)$/i.test(process.env.DUNE_ENABLED || "false");
const STATE_PATH = process.env.SCOUT_STATE_PATH || "/data/shark-state.json";
const CACHE_PATH = process.env.SCOUT_DUNE_CACHE_PATH || "/data/dune-source-cache.json";
const QUERY_IDS = (process.env.DUNE_QUERY_IDS || "5263787").split(",").map(x => Number(x.trim())).filter(Number.isFinite);
const POLL_HOURS = clamp(Number(process.env.DUNE_POLL_HOURS || 6), 1, 48);
const RESULT_LIMIT = clamp(Number(process.env.DUNE_RESULT_LIMIT || 1000), 100, 1000);
const BATCH_SIZE = clamp(Number(process.env.DUNE_BATCH_SIZE || 100), 10, 200);
const MIN_HOLD_HOURS = clampFloat(Number(process.env.DUNE_MIN_HOLD_HOURS || 1), 0.25, 24);
const PREFERRED_HOLD_HOURS = clampFloat(Number(process.env.DUNE_PREFERRED_HOLD_HOURS || 6), MIN_HOLD_HOURS, 72);
const IDEAL_HOLD_HOURS = clampFloat(Number(process.env.DUNE_IDEAL_HOLD_HOURS || 12), PREFERRED_HOLD_HOURS, 168);
const MIN_BUY_SWAPS = clamp(Number(process.env.DUNE_MIN_BUY_SWAPS || 8), 1, 100);
const MAX_LAST_SWAP_DAYS = clamp(Number(process.env.DUNE_MAX_LAST_SWAP_DAYS || 14), 1, 90);
const MIN_FIRST_EXIT_MINUTES = clamp(Number(process.env.DUNE_MIN_FIRST_EXIT_MINUTES || 10), 1, 180);
const TIMEOUT_MS = clamp(Number(process.env.REQUEST_TIMEOUT_MS || 25000), 3000, 60000);

const KNOWN: Record<number, { author: string; label: string; lane: string }> = {
  5263787: { author: "couldbebasic", label: "Top Traders Query", lane: "DUNE_COULDBEBASIC" },
};

type AnyObj = Record<string, any>;
type QueueCandidate = {
  address: string;
  queryId: number;
  executionId: string;
  score: number;
  holdHours: number;
  firstExitHours: number | null;
  lastSwapDays: number | null;
  buySwaps: number | null;
  metrics: Record<string, string | number | boolean | null>;
};
type CacheEntry = {
  lastCheckedAt?: string;
  lastExecutionId?: string;
  lastExecutionEndedAt?: string;
  lastRowCount?: number;
  lastCandidates?: number;
  lastEligible?: number;
  lastFiltered?: number;
  pendingExecutionId?: string;
  pending?: QueueCandidate[];
  lastError?: string;
};
type Cache = { schemaVersion: 2; queries: Record<string, CacheEntry> };

function clamp(n: number, min: number, max: number) { return Math.max(min, Math.min(max, Number.isFinite(n) ? Math.floor(n) : min)); }
function clampFloat(n: number, min: number, max: number) { return Math.max(min, Math.min(max, Number.isFinite(n) ? n : min)); }
function now() { return new Date().toISOString(); }
function uniq<T>(x: T[]) { return [...new Set(x)]; }
async function readJson(file: string, fallback: any) { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return fallback; } }
async function atomicSave(file: string, data: any) { await fs.mkdir(path.dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.tmp`; await fs.writeFile(tmp, JSON.stringify(data)); await fs.rename(tmp, file); }
function validPubkey(v: unknown): string | null { if (typeof v !== "string") return null; try { return new PublicKey(v).toBase58(); } catch { return null; } }
function extractWallet(row: AnyObj): string | null {
  const preferred = Object.entries(row).filter(([k]) => /(wallet|trader|owner|user|account)/i.test(k) && !/(token|mint|pool|program)/i.test(k));
  for (const [, raw] of preferred) {
    if (typeof raw !== "string") continue;
    const direct = validPubkey(raw.trim()); if (direct) return direct;
    for (const m of raw.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) || []) { const p = validPubkey(m); if (p) return p; }
  }
  return null;
}
function compactMetrics(row: AnyObj) {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(row)) {
    if (Object.keys(out).length >= 24) break;
    if (!/(pnl|profit|roi|win|trade|token|volume|hold|bought|sold|return|score|swap|balance|spent|wallet.*old|first.*sell)/i.test(k)) continue;
    if (v == null || ["string", "number", "boolean"].includes(typeof v)) out[k.slice(0, 80)] = typeof v === "string" ? v.slice(0, 180) : v as any;
  }
  return out;
}
function due(e: CacheEntry | undefined) { if (!e?.lastCheckedAt) return true; const t = Date.parse(e.lastCheckedAt); return !Number.isFinite(t) || Date.now() - t >= POLL_HOURS * 3600_000; }
async function duneResult(queryId: number, limit: number) {
  const c = new AbortController(), timer = setTimeout(() => c.abort(), TIMEOUT_MS);
  try {
    const u = new URL(`https://api.dune.com/api/v1/query/${queryId}/results`);
    u.searchParams.set("limit", String(limit));
    const r = await fetch(u, { headers: { "X-DUNE-API-KEY": DUNE_KEY! }, signal: c.signal });
    const text = await r.text();
    if (!r.ok) throw new Error(`dune_${r.status}:${text.slice(0, 180)}`);
    return text ? JSON.parse(text) : null;
  } finally { clearTimeout(timer); }
}
function rowsOf(body: AnyObj): AnyObj[] { return Array.isArray(body?.result?.rows) ? body.result.rows : []; }
function norm(s: string) { return s.toLowerCase().replace(/[^a-z0-9]+/g, ""); }
function findMetric(row: AnyObj, aliases: string[]) {
  const entries = Object.entries(row).map(([k, v]) => [norm(k), v] as const);
  for (const alias of aliases.map(norm)) {
    const exact = entries.find(([k]) => k === alias); if (exact) return exact[1];
  }
  for (const alias of aliases.map(norm)) {
    const loose = entries.find(([k]) => k.includes(alias)); if (loose) return loose[1];
  }
  return null;
}
function parseNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const n = Number(v.replace(/[$,%\s]/g, "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}
function parseDurationHours(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v > 168 ? v / 3600 : v;
  if (typeof v !== "string") return null;
  const s = v.trim();
  const day = s.match(/^(\d+)\s*d(?:ays?)?\s*(?:(\d{1,2}):(\d{2}):(\d{2}))?$/i);
  if (day) return Number(day[1]) * 24 + Number(day[2] || 0) + Number(day[3] || 0) / 60 + Number(day[4] || 0) / 3600;
  const parts = s.split(":").map(Number);
  if (parts.length === 3 && parts.every(Number.isFinite)) return parts[0]! + parts[1]! / 60 + parts[2]! / 3600;
  if (parts.length === 2 && parts.every(Number.isFinite)) return parts[0]! + parts[1]! / 60;
  return null;
}
function ageDays(v: unknown): number | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const t = Date.parse(String(v));
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (Date.now() - t) / 86_400_000);
}
function candidateFromRow(row: AnyObj, queryId: number, executionId: string): { candidate?: QueueCandidate; reason?: string } {
  const address = extractWallet(row); if (!address) return { reason: "unmapped_wallet" };
  const holdHours = parseDurationHours(findMetric(row, ["Median Hold Time", "median_hold_time"]));
  if (holdHours == null) return { reason: "missing_median_hold" };
  if (holdHours < MIN_HOLD_HOURS) return { reason: "median_hold_below_min" };

  const firstExitHours = parseDurationHours(findMetric(row, ["Median First Buy <> First Sell", "Median First Buy First Sell", "median_first_buy_first_sell"]));
  if (firstExitHours != null && firstExitHours * 60 < MIN_FIRST_EXIT_MINUTES) return { reason: "first_exit_too_fast" };

  const buySwaps = parseNumber(findMetric(row, ["Buy Swaps", "buy_swaps"]));
  if (buySwaps != null && buySwaps < MIN_BUY_SWAPS) return { reason: "sample_too_small" };

  const lastSwapDays = ageDays(findMetric(row, ["Last Swap", "last_swap"]));
  if (lastSwapDays != null && lastSwapDays > MAX_LAST_SWAP_DAYS) return { reason: "stale_wallet" };

  const medianRoi = parseNumber(findMetric(row, ["Median ROI", "median_roi"]));
  const winrate = parseNumber(findMetric(row, ["Winrate", "win_rate", "winrate"]));
  const walletDaysOld = parseNumber(findMetric(row, ["Wallet Days Old", "wallet_days_old"]));

  let score = 0;
  if (holdHours >= IDEAL_HOLD_HOURS) score += 40;
  else if (holdHours >= PREFERRED_HOLD_HOURS) score += 30;
  else score += 10 + 20 * ((holdHours - MIN_HOLD_HOURS) / Math.max(0.01, PREFERRED_HOLD_HOURS - MIN_HOLD_HOURS));

  if (firstExitHours == null) score -= 3;
  else if (firstExitHours >= IDEAL_HOLD_HOURS) score += 24;
  else if (firstExitHours >= PREFERRED_HOLD_HOURS) score += 18;
  else if (firstExitHours >= 1) score += 6 + 10 * Math.min(1, firstExitHours / PREFERRED_HOLD_HOURS);
  else score -= 8;

  if (holdHours >= PREFERRED_HOLD_HOURS && firstExitHours != null && firstExitHours < 1) score -= 18;
  else if (holdHours >= PREFERRED_HOLD_HOURS && firstExitHours != null && firstExitHours / holdHours < 0.1) score -= 10;

  if (lastSwapDays != null) score += lastSwapDays <= 2 ? 14 : lastSwapDays <= 5 ? 10 : lastSwapDays <= 10 ? 5 : 0;
  if (buySwaps != null) score += Math.min(10, Math.log2(Math.max(1, buySwaps)) * 2);
  if (medianRoi != null) score += Math.max(-8, Math.min(12, medianRoi / 5));
  if (winrate != null) score += Math.max(-5, Math.min(8, (winrate - 50) / 5));
  if (walletDaysOld != null && walletDaysOld < 7) score -= 6;

  return { candidate: { address, queryId, executionId, score: Math.round(score * 100) / 100, holdHours, firstExitHours, lastSwapDays, buySwaps, metrics: compactMetrics(row) } };
}
function buildQueue(rows: AnyObj[], queryId: number, executionId: string) {
  const byWallet = new Map<string, QueueCandidate>();
  const reasons: Record<string, number> = {};
  let walletRows = 0;
  for (const row of rows) {
    const wallet = extractWallet(row); if (wallet) walletRows++;
    const x = candidateFromRow(row, queryId, executionId);
    if (!x.candidate) { const r = x.reason || "filtered"; reasons[r] = (reasons[r] || 0) + 1; continue; }
    const prior = byWallet.get(x.candidate.address);
    if (!prior || x.candidate.score > prior.score) byWallet.set(x.candidate.address, x.candidate);
  }
  const queue = [...byWallet.values()].sort((a, b) => b.score - a.score || b.holdHours - a.holdHours || (a.lastSwapDays ?? 999) - (b.lastSwapDays ?? 999));
  return { queue, reasons, walletRows };
}
function upsertCandidate(state: AnyObj, c: QueueCandidate) {
  const t = now(), known = KNOWN[c.queryId] || { author: "unknown", label: `query_${c.queryId}`, lane: "DUNE_CURATED" };
  if (!state.wallets) state.wallets = {};
  const source = {
    queryId: c.queryId,
    author: known.author,
    label: known.label,
    executionId: c.executionId,
    metrics: c.metrics,
    selection: { score: c.score, holdHours: c.holdHours, firstExitHours: c.firstExitHours, lastSwapDays: c.lastSwapDays, buySwaps: c.buySwaps },
    seenAt: t,
  };
  state.wallets[c.address] = {
    address: c.address,
    firstSeen: t,
    lastSeen: t,
    rediscoveryCount: 1,
    tokens: [],
    providers: ["dune"],
    lanes: ["DUNE_CURATED", known.lane, c.holdHours >= IDEAL_HOLD_HOURS ? "DUNE_SLOW_IDEAL" : c.holdHours >= PREFERRED_HOLD_HOURS ? "DUNE_SLOW_PREFERRED" : "DUNE_SLOW_CONSIDER"],
    tags: [],
    status: "RAW",
    discovery: { dune: source },
  };
}

export async function runDuneDiscoveryStage(stateOverride?: AnyObj) {
  const startedAt = now();
  const telemetry: AnyObj = {
    event: "shark_scout_dune_discovery_complete",
    startedAt,
    enabled: ENABLED,
    queryIds: QUERY_IDS,
    pollHours: POLL_HOURS,
    resultLimit: RESULT_LIMIT,
    batchSize: BATCH_SIZE,
    minHoldHours: MIN_HOLD_HOURS,
    preferredHoldHours: PREFERRED_HOLD_HOURS,
    idealHoldHours: IDEAL_HOLD_HOURS,
    metadataPolls: 0,
    fullFetches: 0,
    unchangedExecutions: 0,
    rowsFetched: 0,
    walletRows: 0,
    eligibleRows: 0,
    filteredRows: 0,
    filterReasons: {} as Record<string, number>,
    queuedBefore: 0,
    queuedAfter: 0,
    batchAdded: 0,
    existingSkipped: 0,
    knownRejected: 0,
    errors: [] as string[],
  };
  if (!ENABLED) return { ...telemetry, finishedAt: now(), skipped: "disabled" };
  if (!DUNE_KEY) return { ...telemetry, finishedAt: now(), skipped: "missing_key" };
  if (!QUERY_IDS.length) return { ...telemetry, finishedAt: now(), skipped: "no_queries" };

  const ownState = !stateOverride;
  const state = stateOverride || await readJson(STATE_PATH, { schemaVersion: 6, createdAt: startedAt, updatedAt: startedAt, wallets: {}, tokens: {}, runs: [] });
  const cache: Cache = await readJson(CACHE_PATH, { schemaVersion: 2, queries: {} });
  cache.schemaVersion = 2;

  for (const queryId of QUERY_IDS) {
    const key = String(queryId), ce: CacheEntry = cache.queries[key] || {};
    ce.pending = Array.isArray(ce.pending) ? ce.pending : [];

    if (due(ce)) {
      try {
        const probe = await duneResult(queryId, 1); telemetry.metadataPolls++;
        const executionId = String(probe?.execution_id || "");
        ce.lastCheckedAt = now(); ce.lastError = undefined;
        if (!executionId) {
          telemetry.errors.push(`${queryId}:missing_execution_id`);
        } else if (ce.lastExecutionId === executionId) {
          telemetry.unchangedExecutions++;
        } else {
          const body = await duneResult(queryId, RESULT_LIMIT); telemetry.fullFetches++;
          const rows = rowsOf(body); telemetry.rowsFetched += rows.length;
          const built = buildQueue(rows, queryId, executionId);
          telemetry.walletRows += built.walletRows;
          telemetry.eligibleRows += built.queue.length;
          telemetry.filteredRows += Math.max(0, rows.length - built.queue.length);
          for (const [r, n] of Object.entries(built.reasons)) telemetry.filterReasons[r] = (telemetry.filterReasons[r] || 0) + n;
          ce.pending = built.queue;
          ce.pendingExecutionId = executionId;
          ce.lastExecutionId = executionId;
          ce.lastExecutionEndedAt = body?.execution_ended_at || body?.submitted_at || null;
          ce.lastRowCount = Number(body?.result?.metadata?.total_row_count ?? body?.result?.metadata?.row_count ?? rows.length);
          ce.lastCandidates = built.walletRows;
          ce.lastEligible = built.queue.length;
          ce.lastFiltered = Math.max(0, rows.length - built.queue.length);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        ce.lastCheckedAt = now(); ce.lastError = msg.slice(0, 240);
        telemetry.errors.push(`${queryId}:${msg}`);
      }
    }

    telemetry.queuedBefore += ce.pending.length;
    const remaining: QueueCandidate[] = [];
    let addedThisQuery = 0;
    for (const c of ce.pending) {
      const old = state.wallets?.[c.address];
      if (old) {
        if (old.status === "REJECTED") telemetry.knownRejected++;
        else telemetry.existingSkipped++;
        continue;
      }
      if (addedThisQuery < BATCH_SIZE) {
        upsertCandidate(state, c);
        addedThisQuery++;
        telemetry.batchAdded++;
      } else remaining.push(c);
    }
    ce.pending = remaining;
    telemetry.queuedAfter += remaining.length;
    cache.queries[key] = ce;
  }

  await atomicSave(CACHE_PATH, cache);
  if (ownState) { state.updatedAt = now(); await atomicSave(STATE_PATH, state); }
  return { ...telemetry, finishedAt: now() };
}

if (import.meta.url === `file://${process.argv[1]}`) runDuneDiscoveryStage().then(x => console.log(JSON.stringify(x))).catch(e => { console.error(JSON.stringify({ event: "shark_scout_dune_discovery_failed", error: e instanceof Error ? e.message : String(e) })); process.exitCode = 1; });
