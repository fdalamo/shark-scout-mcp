import { promises as fs } from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";

const HELIUS_API_KEY = process.env.HELIUS_API_KEY?.trim();
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY?.trim();
const ST_API_KEY = (process.env.SOLANA_TRACKER_API_KEY || process.env.ST_API_KEY)?.trim();
const RPC_URL = process.env.SOLANA_RPC_URL?.trim() || (HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}` : "https://api.mainnet-beta.solana.com");
const STATE_PATH = process.env.SCOUT_STATE_PATH || "./data/shark-state.json";
const REPORT_PATH = process.env.SCOUT_REPORT_PATH || "./data/latest-harvest.json";
const TOKEN_LIMIT = clamp(Number(process.env.HARVEST_TOKEN_LIMIT || 40), 5, 150);
const TRADERS_PER_TOKEN = clamp(Number(process.env.HARVEST_TRADERS_PER_TOKEN || 10), 3, 50);
const GLOBAL_WALLET_LIMIT = clamp(Number(process.env.HARVEST_GLOBAL_WALLET_LIMIT || 50), 10, 250);
const PROFILE_LIMIT = clamp(Number(process.env.HARVEST_PROFILE_LIMIT || 40), 0, 200);
const TIMEOUT_MS = clamp(Number(process.env.REQUEST_TIMEOUT_MS || 15000), 3000, 60000);
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN_PROGRAMS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
]);

type Lane = "TOKEN_WINNER" | "GLOBAL_LEADERBOARD" | "CROSS_TOKEN" | "CONTROL_COHORT" | "RELATED_GRAPH";
type WalletStatus = "RAW" | "CHEAP_PASS" | "PROFILED" | "REJECTED" | "UNKNOWN";

type WalletRecord = {
  address: string;
  firstSeen: string;
  lastSeen: string;
  rediscoveryCount: number;
  tokens: string[];
  providers: string[];
  lanes: Lane[];
  tags: string[];
  status: WalletStatus;
  rejectionReason?: string;
  lastProfiledAt?: string;
  snapshot?: Record<string, unknown>;
};

type ScoutState = {
  schemaVersion: 1;
  createdAt: string;
  updatedAt: string;
  wallets: Record<string, WalletRecord>;
  tokens: Record<string, { firstSeen: string; lastSeen: string; providers: string[]; hits: number }>;
  runs: Array<Record<string, unknown>>;
};

function clamp(n: number, min: number, max: number) { return Math.max(min, Math.min(max, Number.isFinite(n) ? Math.floor(n) : min)); }
function now() { return new Date().toISOString(); }
function uniq<T>(rows: T[]): T[] { return [...new Set(rows)]; }

async function fetchJson(url: string, init: RequestInit = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${url}: ${text.slice(0, 400)}`);
    return text ? JSON.parse(text) : null;
  } finally { clearTimeout(timer); }
}

let rpcId = 1;
async function rpc(method: string, params: unknown[] = []) {
  const body = await fetchJson(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
  });
  if (body?.error) throw new Error(`RPC ${method}: ${JSON.stringify(body.error)}`);
  return body?.result;
}

function validPubkey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try { return new PublicKey(value).toBase58(); } catch { return null; }
}

function arraysDeep(value: unknown, depth = 0): any[][] {
  if (depth > 6 || value == null) return [];
  if (Array.isArray(value)) return [value, ...value.flatMap((v) => arraysDeep(v, depth + 1))];
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).flatMap((v) => arraysDeep(v, depth + 1));
  return [];
}

function objectsDeep(value: unknown): any[] {
  return arraysDeep(value).flat().filter((x) => x && typeof x === "object" && !Array.isArray(x));
}

function tokenAddresses(payload: unknown): string[] {
  const out: string[] = [];
  for (const row of objectsDeep(payload)) {
    for (const key of ["address", "mint", "tokenAddress", "token_address", "contractAddress"]) {
      const v = validPubkey(row?.[key]);
      if (v) out.push(v);
    }
  }
  return uniq(out);
}

function walletAddress(row: any): string | null {
  for (const key of ["wallet", "owner", "address", "walletAddress", "wallet_address", "trader", "user"]) {
    const v = validPubkey(row?.[key]);
    if (v) return v;
  }
  return null;
}

function tagsFrom(row: any): string[] {
  const raw = [row?.tag, row?.tags, row?.walletTags, row?.wallet_tags, row?.identity?.tags, row?.identity?.platform, row?.identity?.name].flat(Infinity).filter(Boolean);
  return uniq(raw.map((x: unknown) => String(x).toLowerCase()));
}

function numeric(row: any, paths: string[][]): number | null {
  for (const p of paths) {
    let v: any = row;
    for (const k of p) v = v?.[k];
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

async function birdeyeTrending(): Promise<string[]> {
  if (!BIRDEYE_API_KEY) return [];
  const q = new URLSearchParams({ sort_by: "rank", sort_type: "asc", interval: "24h", offset: "0", limit: String(Math.min(TOKEN_LIMIT, 50)) });
  const body = await fetchJson(`https://public-api.birdeye.so/defi/token_trending?${q}`, { headers: { "X-API-KEY": BIRDEYE_API_KEY, "x-chain": "solana" } });
  return tokenAddresses(body).slice(0, TOKEN_LIMIT);
}

async function stTrending(): Promise<string[]> {
  if (!ST_API_KEY) return [];
  const body = await fetchJson(`https://data.solanatracker.io/tokens/trending/24h`, { headers: { "x-api-key": ST_API_KEY } });
  return tokenAddresses(body).slice(0, TOKEN_LIMIT);
}

async function birdeyeTokenTraders(mint: string): Promise<any[]> {
  if (!BIRDEYE_API_KEY) return [];
  const q = new URLSearchParams({
    address: mint, time_frame: "30d", sort_type: "desc", sort_by: "realized_pnl", offset: "0",
    limit: String(Math.min(TRADERS_PER_TOKEN, 10)), min_trade: "2",
  });
  const body = await fetchJson(`https://public-api.birdeye.so/defi/v2/tokens/top_traders?${q}`, { headers: { "X-API-KEY": BIRDEYE_API_KEY, "x-chain": "solana" } });
  return objectsDeep(body).filter((x) => walletAddress(x)).slice(0, TRADERS_PER_TOKEN);
}

async function stTokenTraders(mint: string): Promise<any[]> {
  if (!ST_API_KEY) return [];
  const q = new URLSearchParams({ sort: "pnl", direction: "desc", limit: String(TRADERS_PER_TOKEN), pnlMode: "adjusted" });
  const body = await fetchJson(`https://data.solanatracker.io/v2/pnl/tokens/${mint}/traders?${q}`, { headers: { "x-api-key": ST_API_KEY } });
  return objectsDeep(body).filter((x) => walletAddress(x)).slice(0, TRADERS_PER_TOKEN);
}

async function stGlobalLeaderboard(): Promise<any[]> {
  if (!ST_API_KEY) return [];
  const q = new URLSearchParams({ days: "30", limit: String(GLOBAL_WALLET_LIMIT), pnlMode: "adjusted" });
  const body = await fetchJson(`https://data.solanatracker.io/v2/pnl/leaderboard/top?${q}`, { headers: { "x-api-key": ST_API_KEY } });
  return objectsDeep(body).filter((x) => walletAddress(x)).slice(0, GLOBAL_WALLET_LIMIT);
}

async function stWalletProfile(address: string): Promise<any | null> {
  if (!ST_API_KEY) return null;
  try {
    return await fetchJson(`https://data.solanatracker.io/v2/pnl/wallets/${address}`, { headers: { "x-api-key": ST_API_KEY } });
  } catch { return null; }
}

async function heliusRecent(address: string): Promise<any[] | null> {
  if (!HELIUS_API_KEY) return null;
  try {
    const q = new URLSearchParams({ "api-key": HELIUS_API_KEY, limit: "25" });
    const body = await fetchJson(`https://api.helius.xyz/v0/addresses/${address}/transactions?${q}`);
    return Array.isArray(body) ? body : null;
  } catch { return null; }
}

async function entityType(address: string): Promise<{ valid: boolean; reason?: string; owner?: string }> {
  try {
    const result = await rpc("getAccountInfo", [address, { encoding: "base64", commitment: "confirmed" }]);
    const v = result?.value;
    if (!v) return { valid: true, reason: "uninitialized_or_closed_account" };
    if (v.executable) return { valid: false, reason: "executable_program", owner: v.owner };
    if (TOKEN_PROGRAMS.has(v.owner)) return { valid: false, reason: "token_account", owner: v.owner };
    return { valid: true, owner: v.owner };
  } catch { return { valid: true, reason: "entity_validation_unknown" }; }
}

function hardBadTag(tags: string[]) {
  const joined = tags.join(" ");
  for (const x of ["sniper", "bundler", "insider", "developer", " dev", "bot", "mev"]) if (joined.includes(x)) return x.trim();
  return null;
}

async function loadState(): Promise<ScoutState> {
  try { return JSON.parse(await fs.readFile(STATE_PATH, "utf8")); }
  catch {
    const t = now();
    return { schemaVersion: 1, createdAt: t, updatedAt: t, wallets: {}, tokens: {}, runs: [] };
  }
}

async function saveJson(file: string, data: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}

function upsertWallet(state: ScoutState, row: any, provider: string, lane: Lane, mint?: string) {
  const address = walletAddress(row);
  if (!address) return { address: null, isNew: false };
  const t = now();
  const tags = tagsFrom(row);
  const existing = state.wallets[address];
  if (!existing) {
    state.wallets[address] = {
      address, firstSeen: t, lastSeen: t, rediscoveryCount: 1,
      tokens: mint ? [mint] : [], providers: [provider], lanes: [lane], tags,
      status: "RAW",
      snapshot: {
        realizedPnl: numeric(row, [["realizedPnl"], ["realized_pnl"], ["period", "realized"], ["summary", "pnl", "realized"]]),
        roi: numeric(row, [["roi"], ["period", "roi"], ["summary", "roi"]]),
        winRate: numeric(row, [["winRate"], ["win_rate"], ["analysis", "winRate"]]),
      },
    };
    return { address, isNew: true };
  }
  existing.lastSeen = t;
  existing.rediscoveryCount += 1;
  existing.providers = uniq([...existing.providers, provider]);
  existing.lanes = uniq([...existing.lanes, lane]);
  existing.tags = uniq([...existing.tags, ...tags]);
  if (mint) existing.tokens = uniq([...existing.tokens, mint]);
  if (existing.tokens.length >= 2 && !existing.lanes.includes("CROSS_TOKEN")) existing.lanes.push("CROSS_TOKEN");
  return { address, isNew: false };
}

export async function runHarvest() {
  const startedAt = now();
  const state = await loadState();
  const beforeUnique = Object.keys(state.wallets).length;
  const providerErrors: string[] = [];
  let rawWalletHits = 0, duplicates = 0, invalidEntities = 0, cheapScreened = 0, rejected = 0, profiled = 0, unknown = 0;

  const tokenSources = await Promise.allSettled([birdeyeTrending(), stTrending()]);
  const tokenRows: Array<{ mint: string; provider: string }> = [];
  for (let i = 0; i < tokenSources.length; i++) {
    const r = tokenSources[i]!;
    const provider = i === 0 ? "birdeye" : "solana_tracker";
    if (r.status === "rejected") { providerErrors.push(`${provider}: ${String(r.reason)}`); continue; }
    for (const mint of r.value) tokenRows.push({ mint, provider });
  }
  const tokenMap = new Map<string, string[]>();
  for (const row of tokenRows) tokenMap.set(row.mint, uniq([...(tokenMap.get(row.mint) || []), row.provider]));
  const tokens = [...tokenMap.keys()].slice(0, TOKEN_LIMIT);
  for (const mint of tokens) {
    const t = now();
    const old = state.tokens[mint];
    state.tokens[mint] = old ? { ...old, lastSeen: t, providers: uniq([...old.providers, ...(tokenMap.get(mint) || [])]), hits: old.hits + 1 } : { firstSeen: t, lastSeen: t, providers: tokenMap.get(mint) || [], hits: 1 };
  }

  const traderJobs: Array<Promise<{ provider: string; mint: string; rows: any[] }>> = [];
  for (const mint of tokens) {
    if (BIRDEYE_API_KEY) traderJobs.push(birdeyeTokenTraders(mint).then((rows) => ({ provider: "birdeye", mint, rows })));
    if (ST_API_KEY) traderJobs.push(stTokenTraders(mint).then((rows) => ({ provider: "solana_tracker", mint, rows })));
  }
  const traderResults = await Promise.allSettled(traderJobs);
  for (const result of traderResults) {
    if (result.status === "rejected") { providerErrors.push(`token_traders: ${String(result.reason)}`); continue; }
    for (const row of result.value.rows) {
      rawWalletHits++;
      const hit = upsertWallet(state, row, result.value.provider, "TOKEN_WINNER", result.value.mint);
      if (hit.address && !hit.isNew) duplicates++;
    }
  }

  if (ST_API_KEY) {
    try {
      for (const row of await stGlobalLeaderboard()) {
        rawWalletHits++;
        const hit = upsertWallet(state, row, "solana_tracker", "GLOBAL_LEADERBOARD");
        if (hit.address && !hit.isNew) duplicates++;
      }
    } catch (e) { providerErrors.push(`global_leaderboard: ${String(e)}`); }
  }

  const newlySeen = Object.values(state.wallets).filter((w) => w.firstSeen >= startedAt).slice(0, 300);
  for (const wallet of newlySeen) {
    cheapScreened++;
    const entity = await entityType(wallet.address);
    if (!entity.valid) {
      wallet.status = "REJECTED"; wallet.rejectionReason = entity.reason; invalidEntities++; rejected++; continue;
    }
    const badTag = hardBadTag(wallet.tags);
    if (badTag) {
      wallet.status = "REJECTED"; wallet.rejectionReason = `tag_${badTag}`; rejected++; continue;
    }
    wallet.status = "CHEAP_PASS";
  }

  const toProfile = Object.values(state.wallets)
    .filter((w) => w.status === "CHEAP_PASS")
    .sort((a, b) => (b.tokens.length - a.tokens.length) || (b.rediscoveryCount - a.rediscoveryCount))
    .slice(0, PROFILE_LIMIT);
  for (const wallet of toProfile) {
    const [pnl, txs] = await Promise.all([stWalletProfile(wallet.address), heliusRecent(wallet.address)]);
    const swaps = txs?.filter((x: any) => x?.type === "SWAP") ?? null;
    wallet.lastProfiledAt = now();
    wallet.snapshot = { ...(wallet.snapshot || {}), solanaTrackerPnl: pnl, heliusRecentSwapCount: swaps?.length ?? null, heliusRecentTxCount: txs?.length ?? null };
    if (!pnl && !txs) { wallet.status = "UNKNOWN"; unknown++; }
    else { wallet.status = "PROFILED"; profiled++; }
  }

  const afterUnique = Object.keys(state.wallets).length;
  const telemetry = {
    startedAt, finishedAt: now(),
    configured: { helius: !!HELIUS_API_KEY, birdeye: !!BIRDEYE_API_KEY, solanaTracker: !!ST_API_KEY },
    tokensSampled: tokens.length,
    rawWalletHits,
    newUniqueWallets: afterUnique - beforeUnique,
    duplicateWalletHits: duplicates,
    invalidEntitiesExcluded: invalidEntities,
    cheapScreened,
    rejected,
    fullProfiled: profiled,
    dataUnknown: unknown,
    cumulativeUniqueWallets: afterUnique,
    cumulativeTokensSeen: Object.keys(state.tokens).length,
    providerErrors: providerErrors.slice(0, 25),
    statePath: STATE_PATH,
  };
  state.updatedAt = telemetry.finishedAt;
  state.runs = [...state.runs.slice(-199), telemetry];
  await saveJson(STATE_PATH, state);
  await saveJson(REPORT_PATH, telemetry);
  return telemetry;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;
if (isMain) {
  runHarvest().then((r) => { console.log(JSON.stringify(r, null, 2)); }).catch((e) => { console.error(e); process.exitCode = 1; });
}
