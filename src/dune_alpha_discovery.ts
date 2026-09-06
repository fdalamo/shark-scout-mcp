import { promises as fs } from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";

const KEY = process.env.DUNE_API_KEY?.trim();
const ENABLED = /^(1|true|yes)$/i.test(process.env.DUNE_ALPHA_ENABLED || "true");
const QUERY_ID = Number(process.env.DUNE_ALPHA_QUERY_ID || 4387975);
const LIMIT = Math.max(10, Math.min(250, Number(process.env.DUNE_ALPHA_LIMIT || 100)));
const POLL_HOURS = Math.max(6, Math.min(48, Number(process.env.DUNE_ALPHA_POLL_HOURS || 12)));
const CACHE_PATH = process.env.SCOUT_DUNE_ALPHA_CACHE_PATH || "/data/dune-alpha-cache.json";
const TIMEOUT_MS = Math.max(3000, Math.min(60000, Number(process.env.REQUEST_TIMEOUT_MS || 25000)));

type AnyObj = Record<string, any>;
type Cache = { lastCheckedAt?: string; lastExecutionId?: string; lastError?: string; lastRowCount?: number };

function now() { return new Date().toISOString(); }
function validPubkey(v: unknown): string | null { if (typeof v !== "string") return null; try { return new PublicKey(v.trim()).toBase58(); } catch { return null; } }
function extractWallet(row: AnyObj): string | null {
  const preferred = Object.entries(row).filter(([k]) => /(wallet|trader|owner|user|account|address)/i.test(k) && !/(token|mint|pool|program)/i.test(k));
  for (const [, raw] of preferred) {
    if (typeof raw !== "string") continue;
    const direct = validPubkey(raw); if (direct) return direct;
    for (const m of raw.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) || []) { const p = validPubkey(m); if (p) return p; }
  }
  return null;
}
function compactMetrics(row: AnyObj) {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(row)) {
    if (Object.keys(out).length >= 16) break;
    if (!/(pnl|profit|roi|win|trade|token|volume|swap|balance|age)/i.test(k)) continue;
    if (v == null || ["string", "number", "boolean"].includes(typeof v)) out[k.slice(0, 80)] = typeof v === "string" ? v.slice(0, 180) : v as any;
  }
  return out;
}
async function readJson(file: string, fallback: any) { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return fallback; } }
async function atomicSave(file: string, data: any) { await fs.mkdir(path.dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.tmp`; await fs.writeFile(tmp, JSON.stringify(data)); await fs.rename(tmp, file); }
function due(c: Cache) { if (!c.lastCheckedAt) return true; const t = Date.parse(c.lastCheckedAt); return !Number.isFinite(t) || Date.now() - t >= POLL_HOURS * 3600_000; }
async function fetchResult(limit: number) {
  const c = new AbortController(), timer = setTimeout(() => c.abort(), TIMEOUT_MS);
  try {
    const u = new URL(`https://api.dune.com/api/v1/query/${QUERY_ID}/results`); u.searchParams.set("limit", String(limit));
    const r = await fetch(u, { headers: { "X-DUNE-API-KEY": KEY! }, signal: c.signal });
    const text = await r.text(); if (!r.ok) throw new Error(`dune_${r.status}:${text.slice(0,180)}`); return text ? JSON.parse(text) : null;
  } finally { clearTimeout(timer); }
}

export async function runDuneAlphaDiscovery(state: AnyObj) {
  const telemetry: AnyObj = { event: "shark_scout_dune_alpha_complete", enabled: ENABLED, queryId: QUERY_ID, limit: LIMIT, pollHours: POLL_HOURS, metadataPolls: 0, fullFetches: 0, rowsFetched: 0, walletRows: 0, newWallets: 0, convergenceHits: 0, existingSkipped: 0, errors: [] as string[] };
  if (!ENABLED) return { ...telemetry, finishedAt: now(), skipped: "disabled" };
  if (!KEY) return { ...telemetry, finishedAt: now(), skipped: "missing_key" };
  const cache: Cache = await readJson(CACHE_PATH, {});
  if (!due(cache)) return { ...telemetry, finishedAt: now(), skipped: "not_due" };
  try {
    const probe = await fetchResult(1); telemetry.metadataPolls++;
    const executionId = String(probe?.execution_id || ""); cache.lastCheckedAt = now(); cache.lastError = undefined;
    if (!executionId) telemetry.errors.push("missing_execution_id");
    else if (cache.lastExecutionId === executionId) telemetry.unchangedExecution = true;
    else {
      const body = await fetchResult(LIMIT); telemetry.fullFetches++;
      const rows: AnyObj[] = Array.isArray(body?.result?.rows) ? body.result.rows : []; telemetry.rowsFetched = rows.length;
      const seen = new Set<string>();
      for (const row of rows) {
        const address = extractWallet(row); if (!address || seen.has(address)) continue; seen.add(address); telemetry.walletRows++;
        const old = state.wallets?.[address];
        const source = { queryId: QUERY_ID, label: "Top 100 Profitable Solana Wallets 80%+ Winrate Excluding Bots", executionId, metrics: compactMetrics(row), seenAt: now() };
        if (old) {
          old.lastSeen = now(); old.rediscoveryCount = Number(old.rediscoveryCount || 0) + 1;
          old.providers = [...new Set([...(old.providers || []), "dune"] )];
          old.lanes = [...new Set([...(old.lanes || []), "DUNE_ALPHA_80WR", "DUNE_SOURCE_CONVERGENCE"] )];
          old.discovery = { ...(old.discovery || {}), duneAlpha: source }; telemetry.convergenceHits++; telemetry.existingSkipped++;
        } else {
          if (!state.wallets) state.wallets = {};
          state.wallets[address] = { address, firstSeen: now(), lastSeen: now(), rediscoveryCount: 1, tokens: [], providers: ["dune"], lanes: ["DUNE_ALPHA_80WR"], tags: ["dune:80wr_excluding_bots"], status: "RAW", discovery: { duneAlpha: source } };
          telemetry.newWallets++;
        }
      }
      cache.lastExecutionId = executionId; cache.lastRowCount = rows.length;
    }
  } catch (e) { const msg = e instanceof Error ? e.message : String(e); cache.lastCheckedAt = now(); cache.lastError = msg.slice(0,240); telemetry.errors.push(msg); }
  await atomicSave(CACHE_PATH, cache);
  return { ...telemetry, finishedAt: now() };
}
