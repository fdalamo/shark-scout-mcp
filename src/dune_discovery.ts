import { promises as fs } from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";

const DUNE_KEY = process.env.DUNE_API_KEY?.trim();
const ENABLED = /^(1|true|yes)$/i.test(process.env.DUNE_ENABLED || "false");
const STATE_PATH = process.env.SCOUT_STATE_PATH || "/data/shark-state.json";
const CACHE_PATH = process.env.SCOUT_DUNE_CACHE_PATH || "/data/dune-source-cache.json";
const QUERY_IDS = (process.env.DUNE_QUERY_IDS || "5263787").split(",").map(x => Number(x.trim())).filter(Number.isFinite);
const POLL_HOURS = clamp(Number(process.env.DUNE_POLL_HOURS || 6), 1, 48);
const RESULT_LIMIT = clamp(Number(process.env.DUNE_RESULT_LIMIT || 100), 10, 250);
const TIMEOUT_MS = clamp(Number(process.env.REQUEST_TIMEOUT_MS || 25000), 3000, 60000);

const KNOWN: Record<number, { author: string; label: string; lane: string }> = {
  5263787: { author: "couldbebasic", label: "Top Traders Query", lane: "DUNE_COULDBEBASIC" },
};

type AnyObj = Record<string, any>;
type CacheEntry = {
  lastCheckedAt?: string;
  lastExecutionId?: string;
  lastExecutionEndedAt?: string;
  lastRowCount?: number;
  lastCandidates?: number;
  lastError?: string;
};
type Cache = { schemaVersion: 1; queries: Record<string, CacheEntry> };

function clamp(n: number, min: number, max: number) { return Math.max(min, Math.min(max, Number.isFinite(n) ? Math.floor(n) : min)); }
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
    if (Object.keys(out).length >= 14) break;
    if (!/(pnl|profit|roi|win|trade|token|volume|hold|bought|sold|return|score)/i.test(k)) continue;
    if (v == null || ["string", "number", "boolean"].includes(typeof v)) out[k.slice(0, 64)] = typeof v === "string" ? v.slice(0, 160) : v as any;
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
function upsert(state: AnyObj, address: string, queryId: number, row: AnyObj, executionId: string) {
  const t = now(), known = KNOWN[queryId] || { author: "unknown", label: `query_${queryId}`, lane: "DUNE_CURATED" };
  const old = state.wallets?.[address];
  const source = { queryId, author: known.author, label: known.label, executionId, metrics: compactMetrics(row), seenAt: t };
  if (!state.wallets) state.wallets = {};
  if (!old) {
    state.wallets[address] = { address, firstSeen: t, lastSeen: t, rediscoveryCount: 1, tokens: [], providers: ["dune"], lanes: ["DUNE_CURATED", known.lane], tags: [], status: "RAW", discovery: { dune: source } };
    return "new";
  }
  old.lastSeen = t;
  old.rediscoveryCount = Math.max(1, Number(old.rediscoveryCount || 0) + 1);
  old.providers = uniq([...(old.providers || []), "dune"]);
  old.lanes = uniq([...(old.lanes || []), "DUNE_CURATED", known.lane]);
  old.discovery = { ...(old.discovery || {}), dune: source };
  return old.status === "REJECTED" ? "known_rejected" : "existing";
}

export async function runDuneDiscoveryStage(stateOverride?: AnyObj) {
  const startedAt = now();
  const telemetry: AnyObj = { event: "shark_scout_dune_discovery_complete", startedAt, enabled: ENABLED, queryIds: QUERY_IDS, pollHours: POLL_HOURS, metadataPolls: 0, fullFetches: 0, unchangedExecutions: 0, rowsFetched: 0, walletRows: 0, newWallets: 0, existingWallets: 0, knownRejected: 0, unmappedRows: 0, errors: [] as string[] };
  if (!ENABLED) return { ...telemetry, finishedAt: now(), skipped: "disabled" };
  if (!DUNE_KEY) return { ...telemetry, finishedAt: now(), skipped: "missing_key" };
  if (!QUERY_IDS.length) return { ...telemetry, finishedAt: now(), skipped: "no_queries" };

  const ownState = !stateOverride;
  const state = stateOverride || await readJson(STATE_PATH, { schemaVersion: 6, createdAt: startedAt, updatedAt: startedAt, wallets: {}, tokens: {}, runs: [] });
  const cache: Cache = await readJson(CACHE_PATH, { schemaVersion: 1, queries: {} });

  for (const queryId of QUERY_IDS) {
    const key = String(queryId), ce = cache.queries[key] || {};
    if (!due(ce)) continue;
    try {
      const probe = await duneResult(queryId, 1); telemetry.metadataPolls++;
      const executionId = String(probe?.execution_id || "");
      ce.lastCheckedAt = now(); ce.lastError = undefined;
      if (!executionId) { telemetry.errors.push(`${queryId}:missing_execution_id`); cache.queries[key] = ce; continue; }
      if (ce.lastExecutionId === executionId) { telemetry.unchangedExecutions++; cache.queries[key] = ce; continue; }

      const body = await duneResult(queryId, RESULT_LIMIT); telemetry.fullFetches++;
      const rows = rowsOf(body); telemetry.rowsFetched += rows.length;
      let queryWalletRows = 0;
      for (const row of rows) {
        const wallet = extractWallet(row);
        if (!wallet) { telemetry.unmappedRows++; continue; }
        queryWalletRows++; telemetry.walletRows++;
        const outcome = upsert(state, wallet, queryId, row, executionId);
        if (outcome === "new") telemetry.newWallets++;
        else if (outcome === "known_rejected") telemetry.knownRejected++;
        else telemetry.existingWallets++;
      }
      ce.lastExecutionId = executionId;
      ce.lastExecutionEndedAt = body?.execution_ended_at || body?.submitted_at || null;
      ce.lastRowCount = Number(body?.result?.metadata?.total_row_count ?? body?.result?.metadata?.row_count ?? rows.length);
      ce.lastCandidates = queryWalletRows;
      cache.queries[key] = ce;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ce.lastCheckedAt = now(); ce.lastError = msg.slice(0, 240); cache.queries[key] = ce;
      telemetry.errors.push(`${queryId}:${msg}`);
    }
  }

  await atomicSave(CACHE_PATH, cache);
  if (ownState) { state.updatedAt = now(); await atomicSave(STATE_PATH, state); }
  return { ...telemetry, finishedAt: now() };
}

if (import.meta.url === `file://${process.argv[1]}`) runDuneDiscoveryStage().then(x => console.log(JSON.stringify(x))).catch(e => { console.error(JSON.stringify({ event: "shark_scout_dune_discovery_failed", error: e instanceof Error ? e.message : String(e) })); process.exitCode = 1; });
