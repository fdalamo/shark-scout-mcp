import { promises as fs } from "node:fs";
import path from "node:path";

const KEY = process.env.CIELO_API_KEY?.trim();
const BASE = "https://feed-api.cielo.finance/api/v1";
const CACHE_PATH = process.env.SCOUT_CIELO_DISCOVERY_CACHE_PATH || "/data/cielo-discovery-cache.json";
const TIMEOUT_MS = clamp(Number(process.env.REQUEST_TIMEOUT_MS || 25000), 3000, 60000);
const TAG_TTL_MS = clamp(Number(process.env.CIELO_TAG_DISCOVERY_HOURS || 6), 1, 48) * 3600_000;
const TREND_1H_TTL_MS = clamp(Number(process.env.CIELO_TREND_1H_HOURS || 2), 1, 24) * 3600_000;
const TREND_24H_TTL_MS = clamp(Number(process.env.CIELO_TREND_24H_HOURS || 6), 1, 48) * 3600_000;
const TAGS = ["human-operated", "gem-finder", "high-winrate", "popular-wallet"];

export type CieloLead = { address: string; tags: string[]; lanes: string[]; tokens: string[]; label?: string };
export type CieloDiscoveryResult = {
  leads: CieloLead[];
  tokens: string[];
  errors: string[];
  telemetry: { requests: number; cacheHits: number; estimatedCredits: number; freshSources: string[]; leadCount: number; tokenCount: number };
};

type CacheEntry = { fetchedAt: string; value: any };
type Cache = { version: 1; entries: Record<string, CacheEntry> };

function clamp(n: number, min: number, max: number) { return Math.max(min, Math.min(max, Number.isFinite(n) ? n : min)); }
function uniq<T>(x: T[]) { return [...new Set(x)]; }
function pk(v: any) { return typeof v === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v) ? v : null; }
function deep(x: any, d = 0): any[] { if (d > 6 || x == null) return []; if (Array.isArray(x)) return x.flatMap(v => [...(v && typeof v === "object" && !Array.isArray(v) ? [v] : []), ...deep(v, d + 1)]); if (typeof x === "object") return Object.values(x).flatMap(v => deep(v, d + 1)); return []; }
function walletOf(x: any) { for (const k of ["wallet", "address", "wallet_address", "owner"]) { const a = pk(x?.[k]); if (a) return a; } return null; }
function tokenOf(x: any) { for (const k of ["token_address", "mint", "address"]) { const a = pk(x?.[k]); if (a) return a; } return null; }
async function readCache(): Promise<Cache> { try { const x = JSON.parse(await fs.readFile(CACHE_PATH, "utf8")); return { version: 1, entries: x?.entries || {} }; } catch { return { version: 1, entries: {} }; } }
async function writeCache(c: Cache) { await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true }); const tmp = `${CACHE_PATH}.${process.pid}.tmp`; await fs.writeFile(tmp, JSON.stringify(c)); await fs.rename(tmp, CACHE_PATH); }
async function get(pathname: string, q: URLSearchParams) { if (!KEY) throw new Error("CIELO_API_KEY_missing"); const c = new AbortController(), t = setTimeout(() => c.abort(), TIMEOUT_MS); try { const r = await fetch(`${BASE}${pathname}?${q}`, { headers: { "X-API-KEY": KEY }, signal: c.signal }); const text = await r.text(); if (!r.ok) throw new Error(`${r.status}:${text.slice(0, 160)}`); return text ? JSON.parse(text) : null; } finally { clearTimeout(t); } }

export async function cieloDiscovery(): Promise<CieloDiscoveryResult> {
  const errors: string[] = [], leads = new Map<string, CieloLead>(), tokens: string[] = [], cache = await readCache();
  let requests = 0, cacheHits = 0, estimatedCredits = 0; const freshSources: string[] = [];
  if (!KEY) return { leads: [], tokens: [], errors: ["CIELO_API_KEY_missing"], telemetry: { requests, cacheHits, estimatedCredits, freshSources, leadCount: 0, tokenCount: 0 } };

  const cached = async (key: string, ttlMs: number, credits: number, fn: () => Promise<any>) => {
    const e = cache.entries[key], age = e ? Date.now() - Date.parse(e.fetchedAt) : Infinity;
    if (e && Number.isFinite(age) && age < ttlMs) { cacheHits++; return e.value; }
    try { const value = await fn(); requests++; estimatedCredits += credits; freshSources.push(key); cache.entries[key] = { fetchedAt: new Date().toISOString(), value }; return value; }
    catch (err) { errors.push(`${key}:${String(err)}`); return e?.value ?? null; }
  };

  const addLead = (a: string, tag: string, row: any) => { const e = leads.get(a) || { address: a, tags: [], lanes: [], tokens: [] }; e.tags = uniq([...e.tags, tag]); e.lanes = uniq([...e.lanes, "CIELO_TAG"]); const label = row?.label || row?.wallet_label || row?.name; if (label) e.label = String(label); leads.set(a, e); };

  for (const tag of TAGS) {
    const q = new URLSearchParams({ wallet_type: "solana", limit: "50" }); q.append("tags", tag);
    const body = await cached(`tag:${tag}`, TAG_TTL_MS, 10, () => get("/tags/wallets", q));
    for (const row of deep(body)) { const a = walletOf(row); if (a) addLead(a, tag, row); }
  }

  for (const [interval, ttl] of [["1h", TREND_1H_TTL_MS], ["24h", TREND_24H_TTL_MS]] as const) {
    const q = new URLSearchParams({ chain: "solana", interval, limit: "20" });
    const body = await cached(`trend:${interval}`, ttl, 20, () => get("/trending-tokens", q));
    for (const row of deep(body)) { const a = tokenOf(row); if (a) tokens.push(a); }
  }

  await writeCache(cache);
  const out = { leads: [...leads.values()], tokens: uniq(tokens), errors, telemetry: { requests, cacheHits, estimatedCredits, freshSources, leadCount: leads.size, tokenCount: uniq(tokens).length } };
  console.log(JSON.stringify({ event: "shark_scout_cielo_discovery_complete", ...out.telemetry, errors }));
  return out;
}
