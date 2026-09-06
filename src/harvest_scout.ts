import { promises as fs } from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { cieloDiscovery } from "./cielo_discovery.js";
import { runHarvest } from "./harvest_ultra.js";

const CIELO_KEY = process.env.CIELO_API_KEY?.trim();
const BIRDEYE_KEY = process.env.BIRDEYE_API_KEY?.trim();
const STATE_PATH = process.env.SCOUT_STATE_PATH || "/data/shark-state.json";
const TAG_CACHE_PATH = process.env.SCOUT_CIELO_TAG_CACHE_PATH || "/data/cielo-tag-cache.json";
const TIMEOUT_MS = clamp(Number(process.env.REQUEST_TIMEOUT_MS || 25000), 3000, 60000);
const TAG_TTL_MS = clamp(Number(process.env.CIELO_TAG_ENRICH_HOURS || 24), 6, 168) * 3600_000;
const TAG_BATCH_LIMIT = clamp(Number(process.env.CIELO_TAG_ENRICH_PER_RUN || 50), 0, 100);
const BRIDGE_TOKEN_LIMIT = clamp(Number(process.env.CIELO_BRIDGE_TOKEN_LIMIT || 5), 0, 10);
const BRIDGE_TRADERS_PER_TOKEN = clamp(Number(process.env.CIELO_BRIDGE_TRADERS_PER_TOKEN || 5), 1, 10);
const BIRDEYE_MIN_INTERVAL_MS = clamp(Number(process.env.BIRDEYE_MIN_INTERVAL_MS || 1600), 1100, 10000);
const NEGATIVE_TAGS = ["sniper", "flipper", "mev", "bot"];
const POSITIVE_TAGS = ["human", "gem", "popular", "high win"];

type AnyObj = Record<string, any>;
type TagCache = { version: 1; wallets: Record<string, { fetchedAt: string; tags: string[] }> };

function clamp(n: number, min: number, max: number) { return Math.max(min, Math.min(max, Number.isFinite(n) ? Math.floor(n) : min)); }
function uniq<T>(x: T[]) { return [...new Set(x)]; }
function now() { return new Date().toISOString(); }
function pk(v: any): string | null { if (typeof v !== "string") return null; try { return new PublicKey(v).toBase58(); } catch { return null; } }
function deep(x: any, d = 0): any[] { if (d > 6 || x == null) return []; if (Array.isArray(x)) return x.flatMap(v => [...(v && typeof v === "object" && !Array.isArray(v) ? [v] : []), ...deep(v, d + 1)]); if (typeof x === "object") return Object.values(x).flatMap(v => deep(v, d + 1)); return []; }
function walletOf(x: any) { for (const k of ["wallet", "address", "wallet_address", "owner"]) { const a = pk(x?.[k]); if (a) return a; } return null; }
function tagsOf(x: any): string[] { return uniq([x?.tag, x?.tags, x?.wallet_tags, x?.walletTags, x?.labels].flat(Infinity).filter(Boolean).map((v: any) => String(v).toLowerCase())); }
async function readJson(file: string, fallback: any) { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return fallback; } }
async function atomicSave(file: string, data: any) { await fs.mkdir(path.dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.tmp`; await fs.writeFile(tmp, JSON.stringify(data)); await fs.rename(tmp, file); }
async function fetchJson(url: string, headers: Record<string, string>) { const c = new AbortController(), t = setTimeout(() => c.abort(), TIMEOUT_MS); try { const r = await fetch(url, { headers, signal: c.signal }); const text = await r.text(); if (!r.ok) throw new Error(`${r.status}:${text.slice(0, 160)}`); return text ? JSON.parse(text) : null; } finally { clearTimeout(t); } }

function scoreWallet(w: any) { return (w?.tokens?.length || 0) * 1000 + Math.min(Number(w?.rediscoveryCount || 0), 999); }
function applyTags(w: any, tags: string[]) {
  w.tags = uniq([...(w.tags || []), ...tags]);
  const joined = tags.join(" ").toLowerCase();
  const bad = NEGATIVE_TAGS.find(t => joined.includes(t));
  if (bad && w.status !== "REJECTED") { w.status = "REJECTED"; w.rejectionReason = `cielo_tag:${bad}`; return "rejected"; }
  if (POSITIVE_TAGS.some(t => joined.includes(t))) w.lanes = uniq([...(w.lanes || []), "CIELO_QUALITY_TAG"]);
  return "kept";
}

async function enrichExistingWithCieloTags(state: AnyObj) {
  if (!CIELO_KEY || TAG_BATCH_LIMIT <= 0) return { requested: 0, credits: 0, rejected: 0, cacheHits: 0, errors: [] as string[] };
  const cache: TagCache = await readJson(TAG_CACHE_PATH, { version: 1, wallets: {} });
  const eligible = (Object.values(state.wallets || {}) as any[]).filter((w: any) => ["RAW", "CHEAP_PASS", "UNKNOWN", "PROFILED"].includes(w?.status)).sort((a: any, b: any) => scoreWallet(b) - scoreWallet(a));
  let cacheHits = 0, rejected = 0; const due: string[] = [];
  for (const w of eligible) {
    const e = cache.wallets[w.address], age = e ? Date.now() - Date.parse(e.fetchedAt) : Infinity;
    if (e && Number.isFinite(age) && age < TAG_TTL_MS) { cacheHits++; if (applyTags(w, e.tags) === "rejected") rejected++; }
    else if (due.length < TAG_BATCH_LIMIT) due.push(w.address);
  }
  const errors: string[] = []; let requested = 0;
  if (due.length) {
    const q = new URLSearchParams(); for (const a of due) q.append("wallet", a);
    try {
      const body = await fetchJson(`https://feed-api.cielo.finance/api/v1/tags?${q}`, { "X-API-KEY": CIELO_KEY }); requested = 1;
      const byWallet = new Map<string, string[]>();
      for (const row of deep(body)) { const a = walletOf(row); if (!a) continue; byWallet.set(a, uniq([...(byWallet.get(a) || []), ...tagsOf(row)])); }
      for (const a of due) { const tags = byWallet.get(a) || []; cache.wallets[a] = { fetchedAt: now(), tags }; const w = state.wallets[a]; if (w && applyTags(w, tags) === "rejected") rejected++; }
    } catch (e) { errors.push(String(e)); }
  }
  await atomicSave(TAG_CACHE_PATH, cache);
  return { requested, credits: requested * 5, rejected, cacheHits, errors };
}

let birdNextAt = 0;
async function birdTopTraders(mint: string) {
  if (!BIRDEYE_KEY) return [];
  const wait = Math.max(0, birdNextAt - Date.now()); if (wait) await new Promise(r => setTimeout(r, wait)); birdNextAt = Math.max(Date.now(), birdNextAt) + BIRDEYE_MIN_INTERVAL_MS;
  const q = new URLSearchParams({ address: mint, time_frame: "30d", sort_type: "desc", sort_by: "realized_pnl", offset: "0", limit: String(BRIDGE_TRADERS_PER_TOKEN), min_trade: "2" });
  const body = await fetchJson(`https://public-api.birdeye.so/defi/v2/tokens/top_traders?${q}`, { "X-API-KEY": BIRDEYE_KEY, "x-chain": "solana" });
  return deep(body).filter(x => walletOf(x)).slice(0, BRIDGE_TRADERS_PER_TOKEN);
}

function upsertLead(state: AnyObj, address: string, tokens: string[], tags: string[], lanes: string[], providers: string[], discovery: any) {
  const t = now(), old = state.wallets[address];
  if (!old) { state.wallets[address] = { address, firstSeen: t, lastSeen: t, rediscoveryCount: 1, tokens: uniq(tokens), providers: uniq(providers), lanes: uniq(lanes), tags: uniq(tags), status: "RAW", discovery }; return true; }
  old.lastSeen = t; old.tokens = uniq([...(old.tokens || []), ...tokens]); old.providers = uniq([...(old.providers || []), ...providers]); old.lanes = uniq([...(old.lanes || []), ...lanes]); old.tags = uniq([...(old.tags || []), ...tags]); old.discovery = { ...(old.discovery || {}), ...discovery }; return false;
}

async function injectCieloDiscovery(state: AnyObj) {
  const d = await cieloDiscovery(); let newWallets = 0, bridgeWallets = 0, bridgeCalls = 0;
  for (const lead of d.leads) if (upsertLead(state, lead.address, lead.tokens, lead.tags, lead.lanes, ["cielo"], { cielo: { label: lead.label, tags: lead.tags } })) newWallets++;
  const trendWasFresh = d.telemetry.freshSources.some(s => s.startsWith("trend:"));
  if (trendWasFresh && BRIDGE_TOKEN_LIMIT > 0 && BIRDEYE_KEY) {
    for (const mint of d.tokens.slice(0, BRIDGE_TOKEN_LIMIT)) {
      try { const rows = await birdTopTraders(mint); bridgeCalls++; for (const row of rows) { const a = walletOf(row); if (!a) continue; const isNew = upsertLead(state, a, [mint], [], ["CIELO_TRENDING_TOKEN", "TOKEN_WINNER"], ["cielo", "birdeye"], { cieloTrendingToken: mint, birdeye: { realizedPnl: row?.realizedPnl ?? row?.realized_pnl ?? null } }); if (isNew) { newWallets++; bridgeWallets++; } } }
      catch (e) { d.errors.push(`bridge:${mint}:${String(e)}`); }
    }
  }
  return { ...d.telemetry, newWallets, bridgeWallets, bridgeCalls, errors: d.errors };
}

export async function runScoutHarvest() {
  const startedAt = now();
  const state = await readJson(STATE_PATH, { schemaVersion: 6, createdAt: startedAt, updatedAt: startedAt, wallets: {}, tokens: {}, runs: [] });
  const tagEnrichment = await enrichExistingWithCieloTags(state);
  const discovery = await injectCieloDiscovery(state);
  state.updatedAt = now(); await atomicSave(STATE_PATH, state);
  console.log(JSON.stringify({ event: "shark_scout_cielo_harvest_stage_complete", startedAt, tagEnrichment, discovery }));
  await runHarvest();
}

if (import.meta.url === `file://${process.argv[1]}`) runScoutHarvest().catch(e => { console.error(JSON.stringify({ event: "shark_scout_harvest_orchestrator_failed", error: e instanceof Error ? e.message : String(e) })); process.exitCode = 1; });
