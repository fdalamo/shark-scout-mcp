import { promises as fs } from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";

const HELIUS_API_KEY = process.env.HELIUS_API_KEY?.trim();
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY?.trim();
const VYBE_API_KEY = process.env.VYBE_API_KEY?.trim();
const RPC_URL = process.env.SOLANA_RPC_URL?.trim() || (HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}` : "https://api.mainnet-beta.solana.com");
const STATE_PATH = process.env.SCOUT_STATE_PATH || "./data/shark-state.json";
const REPORT_PATH = process.env.SCOUT_REPORT_PATH || "./data/latest-harvest.json";
const TOKEN_LIMIT = clamp(Number(process.env.HARVEST_TOKEN_LIMIT || 40), 5, 150);
const TRADERS_PER_TOKEN = clamp(Number(process.env.HARVEST_TRADERS_PER_TOKEN || 10), 3, 50);
const GLOBAL_WALLET_LIMIT = clamp(Number(process.env.HARVEST_GLOBAL_WALLET_LIMIT || 50), 10, 250);
const PROFILE_LIMIT = clamp(Number(process.env.HARVEST_PROFILE_LIMIT || 40), 0, 200);
const TIMEOUT_MS = clamp(Number(process.env.REQUEST_TIMEOUT_MS || 15000), 3000, 60000);
const BIRDEYE_MIN_INTERVAL_MS = clamp(Number(process.env.BIRDEYE_MIN_INTERVAL_MS || 1100), 1000, 10000);
const VYBE_CONCURRENCY = clamp(Number(process.env.VYBE_CONCURRENCY || 3), 1, 10);
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN_PROGRAMS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
]);

type Lane = "TOKEN_WINNER" | "CROSS_TOKEN";
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
  discovery?: Record<string, Record<string, unknown>>;
  profile?: Record<string, unknown>;
};

type ScoutState = {
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
  wallets: Record<string, WalletRecord>;
  tokens: Record<string, { firstSeen: string; lastSeen: string; providers: string[]; hits: number }>;
  runs: Array<Record<string, unknown>>;
};

function clamp(n: number, min: number, max: number): number { return Math.max(min, Math.min(max, Number.isFinite(n) ? Math.floor(n) : min)); }
function now(): string { return new Date().toISOString(); }
function uniq<T>(rows: T[]): T[] { return [...new Set(rows)]; }
function num(value: unknown): number | null { const n = Number(value); return Number.isFinite(n) ? n : null; }
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function fetchJson(url: string, init: RequestInit = {}): Promise<any> {
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
async function rpc(method: string, params: unknown[] = []): Promise<any> {
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

function objectsDeep(value: unknown): any[] { return arraysDeep(value).flat().filter((x) => x && typeof x === "object" && !Array.isArray(x)); }

function tokenAddresses(payload: unknown): string[] {
  const out: string[] = [];
  for (const row of objectsDeep(payload)) {
    for (const key of ["address", "mint", "tokenAddress", "token_address", "contractAddress"]) {
      const value = validPubkey(row?.[key]);
      if (value) out.push(value);
    }
  }
  return uniq(out);
}

function walletAddress(row: any): string | null {
  for (const key of ["wallet", "owner", "address", "walletAddress", "wallet_address", "trader", "user", "authority"]) {
    const value = validPubkey(row?.[key]);
    if (value) return value;
  }
  return null;
}

function tagsFrom(row: any): string[] {
  const raw = [row?.tag, row?.tags, row?.walletTags, row?.wallet_tags, row?.identity?.tags, row?.identity?.platform, row?.identity?.name]
    .flat(Infinity).filter(Boolean);
  return uniq(raw.map((x: unknown) => String(x).toLowerCase()));
}

function hardBadTag(tags: string[]): string | null {
  const joined = tags.join(" ");
  for (const value of ["sniper", "bundler", "insider", "developer", " dev", "bot", "mev", "exchange", "cex"])
    if (joined.includes(value)) return value.trim();
  return null;
}

let birdeyeLastRequestAt = 0;
async function birdeye(pathname: string, query?: URLSearchParams): Promise<any> {
  if (!BIRDEYE_API_KEY) return null;
  const wait = Math.max(0, BIRDEYE_MIN_INTERVAL_MS - (Date.now() - birdeyeLastRequestAt));
  if (wait) await sleep(wait);
  birdeyeLastRequestAt = Date.now();
  const suffix = query && [...query.keys()].length ? `?${query}` : "";
  return fetchJson(`https://public-api.birdeye.so${pathname}${suffix}`, {
    headers: { "X-API-KEY": BIRDEYE_API_KEY, "x-chain": "solana" },
  });
}

async function birdeyeTrending(): Promise<string[]> {
  if (!BIRDEYE_API_KEY) return [];
  const query = new URLSearchParams({ sort_by: "rank", sort_type: "asc", interval: "24h", offset: "0", limit: String(Math.min(TOKEN_LIMIT, 50)) });
  return tokenAddresses(await birdeye("/defi/token_trending", query)).slice(0, TOKEN_LIMIT);
}

async function birdeyeTokenTraders(mint: string): Promise<any[]> {
  if (!BIRDEYE_API_KEY) return [];
  const query = new URLSearchParams({ address: mint, time_frame: "30d", sort_type: "desc", sort_by: "realized_pnl", offset: "0", limit: String(Math.min(TRADERS_PER_TOKEN, 10)), min_trade: "2" });
  const body = await birdeye("/defi/v2/tokens/top_traders", query);
  return objectsDeep(body).filter((row) => walletAddress(row)).slice(0, TRADERS_PER_TOKEN);
}

async function vybe(pathname: string, query?: URLSearchParams): Promise<any> {
  if (!VYBE_API_KEY) return null;
  const suffix = query && [...query.keys()].length ? `?${query}` : "";
  return fetchJson(`https://api.vybenetwork.xyz${pathname}${suffix}`, { headers: { "X-API-Key": VYBE_API_KEY } });
}

async function vybeTokenTraders(mint: string): Promise<any[]> {
  if (!VYBE_API_KEY) return [];
  const query = new URLSearchParams({ resolution: "30d", limit: String(Math.min(TRADERS_PER_TOKEN, 50)), page: "0", sortByDesc: "realizedPnlUsd" });
  const body = await vybe(`/v4/tokens/${mint}/top-pnl-traders`, query);
  const rows = Array.isArray(body?.data) ? body.data : objectsDeep(body);
  return rows.filter((row: any) => walletAddress(row)).slice(0, TRADERS_PER_TOKEN);
}

async function vybeWalletPnl(address: string): Promise<any | null> {
  if (!VYBE_API_KEY) return null;
  try {
    const query = new URLSearchParams({ resolution: "30d", sortByDesc: "realizedPnlUsd", limit: "100", page: "0" });
    return await vybe(`/v4/wallets/${address}/pnl`, query);
  } catch { return null; }
}

async function heliusRecent(address: string): Promise<any[] | null> {
  if (!HELIUS_API_KEY) return null;
  try {
    const query = new URLSearchParams({ "api-key": HELIUS_API_KEY, limit: "40" });
    const body = await fetchJson(`https://api.helius.xyz/v0/addresses/${address}/transactions?${query}`);
    return Array.isArray(body) ? body : null;
  } catch { return null; }
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      out[index] = await fn(items[index]!, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, () => worker()));
  return out;
}

async function entityType(address: string): Promise<{ valid: boolean; reason?: string; owner?: string }> {
  try {
    const result = await rpc("getAccountInfo", [address, { encoding: "base64", commitment: "confirmed" }]);
    const value = result?.value;
    if (!value) return { valid: true, reason: "uninitialized_or_closed_account" };
    if (value.executable) return { valid: false, reason: "executable_program", owner: value.owner };
    if (TOKEN_PROGRAMS.has(value.owner)) return { valid: false, reason: "token_account", owner: value.owner };
    if (address === SYSTEM_PROGRAM) return { valid: false, reason: "system_program" };
    return { valid: true, owner: value.owner };
  } catch { return { valid: true, reason: "entity_validation_unknown" }; }
}

function emptyState(): ScoutState { const timestamp = now(); return { schemaVersion: 2, createdAt: timestamp, updatedAt: timestamp, wallets: {}, tokens: {}, runs: [] }; }
async function loadState(): Promise<ScoutState> {
  try {
    const parsed = JSON.parse(await fs.readFile(STATE_PATH, "utf8"));
    return { schemaVersion: 2, createdAt: parsed.createdAt || now(), updatedAt: parsed.updatedAt || now(), wallets: parsed.wallets || {}, tokens: parsed.tokens || {}, runs: Array.isArray(parsed.runs) ? parsed.runs : [] };
  } catch { return emptyState(); }
}
async function saveJson(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, JSON.stringify(data, null, 2));
  await fs.rename(temp, file);
}

function discoverySnapshot(row: any, provider: string): Record<string, unknown> {
  if (provider === "vybe") return { realizedPnlUsd: num(row?.realizedPnlUsd), unrealizedPnlUsd: num(row?.unrealizedPnlUsd), totalVolumeUsd: num(row?.totalVolumeUsd), tradesCount: num(row?.tradesCount), buyCount: num(row?.buyCount), sellCount: num(row?.sellCount) };
  return { realizedPnl: num(row?.realizedPnl ?? row?.realized_pnl ?? row?.totalPnl ?? row?.total_pnl), unrealizedPnl: num(row?.unrealizedPnl ?? row?.unrealized_pnl), volumeUsd: num(row?.volumeUsd ?? row?.volume_usd), trades: num(row?.trade ?? row?.trades ?? row?.tradeCount ?? row?.trade_count) };
}
function upsertWallet(state: ScoutState, row: any, provider: string, mint: string): { address: string | null; isNew: boolean } {
  const address = walletAddress(row); if (!address) return { address: null, isNew: false };
  const timestamp = now(), tags = tagsFrom(row), existing = state.wallets[address];
  if (!existing) {
    state.wallets[address] = { address, firstSeen: timestamp, lastSeen: timestamp, rediscoveryCount: 1, tokens: [mint], providers: [provider], lanes: ["TOKEN_WINNER"], tags, status: "RAW", discovery: { [provider]: discoverySnapshot(row, provider) } };
    return { address, isNew: true };
  }
  existing.lastSeen = timestamp; existing.rediscoveryCount = Number(existing.rediscoveryCount || 0) + 1;
  existing.tokens = uniq([...(existing.tokens || []), mint]); existing.providers = uniq([...(existing.providers || []), provider]); existing.tags = uniq([...(existing.tags || []), ...tags]);
  existing.lanes = uniq([...(existing.lanes || ["TOKEN_WINNER"]), ...(existing.tokens.length >= 2 ? ["CROSS_TOKEN" as Lane] : [])]);
  existing.discovery = { ...(existing.discovery || {}), [provider]: discoverySnapshot(row, provider) };
  return { address, isNew: false };
}
function profileScore(wallet: WalletRecord): number { return (wallet.tokens?.length || 0) * 100 + (wallet.providers?.length || 0) * 20 + Math.min(wallet.rediscoveryCount || 0, 20); }
function summarizeVybePnl(body: any): Record<string, unknown> | null {
  const summary = body?.summary; if (!summary || typeof summary !== "object") return null;
  return { winRate: num(summary.winRate), realizedPnlUsd: num(summary.realizedPnlUsd), unrealizedPnlUsd: num(summary.unrealizedPnlUsd), uniqueTokensTraded: num(summary.uniqueTokensTraded), averageTradeUsd: num(summary.averageTradeUsd), tradesCount: num(summary.tradesCount), winningTradesCount: num(summary.winningTradesCount), losingTradesCount: num(summary.losingTradesCount), tradesVolumeUsd: num(summary.tradesVolumeUsd), bestPerformingToken: summary.bestPerformingToken ?? null, worstPerformingToken: summary.worstPerformingToken ?? null };
}
function summarizeHelius(rows: any[] | null): Record<string, unknown> | null {
  if (!rows) return null; const swaps = rows.filter((tx) => tx?.type === "SWAP"); const timestamps = rows.map((tx) => Number(tx?.timestamp)).filter(Number.isFinite);
  return { transactionsFetched: rows.length, swapsFetched: swaps.length, newestTimestamp: timestamps.length ? Math.max(...timestamps) : null, oldestTimestamp: timestamps.length ? Math.min(...timestamps) : null, recentSwapSignatures: swaps.slice(0, 10).map((tx) => tx?.signature).filter(Boolean) };
}

export async function runHarvest(): Promise<Record<string, unknown>> {
  const startedAt = now(), state = await loadState(), beforeUnique = Object.keys(state.wallets).length, providerErrors: string[] = [];
  const providerStatus = { helius: Boolean(HELIUS_API_KEY), birdeye: Boolean(BIRDEYE_API_KEY), vybe: Boolean(VYBE_API_KEY) };
  let rawWalletHits = 0, duplicates = 0, invalidEntities = 0, tagRejected = 0, cheapScreened = 0, profiled = 0, unknown = 0;
  let tokens: string[] = [];
  try { tokens = await birdeyeTrending(); } catch (error) { providerErrors.push(`birdeye_trending: ${String(error)}`); }
  for (const mint of tokens) {
    const timestamp = now(), existing = state.tokens[mint];
    state.tokens[mint] = existing ? { ...existing, lastSeen: timestamp, providers: uniq([...(existing.providers || []), "birdeye"]), hits: Number(existing.hits || 0) + 1 } : { firstSeen: timestamp, lastSeen: timestamp, providers: ["birdeye"], hits: 1 };
  }
  const birdeyeResults: Array<{ mint: string; rows: any[] }> = [];
  if (BIRDEYE_API_KEY) for (const mint of tokens) { try { birdeyeResults.push({ mint, rows: await birdeyeTokenTraders(mint) }); } catch (error) { providerErrors.push(`birdeye_top_traders:${mint}: ${String(error)}`); } }
  const vybeResults = VYBE_API_KEY ? await mapConcurrent(tokens, VYBE_CONCURRENCY, async (mint) => { try { return { mint, rows: await vybeTokenTraders(mint), error: null as string | null }; } catch (error) { return { mint, rows: [] as any[], error: String(error) }; } }) : [];
  for (const result of vybeResults) if (result.error) providerErrors.push(`vybe_top_traders:${result.mint}: ${result.error}`);
  for (const result of [...birdeyeResults.map((x) => ({ ...x, provider: "birdeye" })), ...vybeResults.map((x) => ({ ...x, provider: "vybe" }))]) for (const row of result.rows) { rawWalletHits++; const hit = upsertWallet(state, row, result.provider, result.mint); if (hit.address && !hit.isNew) duplicates++; }
  const candidates = Object.values(state.wallets).filter((wallet) => wallet.status !== "REJECTED").sort((a, b) => profileScore(b) - profileScore(a));
  const entityQueue = candidates.slice(0, Math.max(PROFILE_LIMIT * 2, GLOBAL_WALLET_LIMIT));
  for (const wallet of entityQueue) {
    const badTag = hardBadTag(wallet.tags || []); if (badTag) { wallet.status = "REJECTED"; wallet.rejectionReason = `tag:${badTag}`; tagRejected++; continue; }
    const entity = await entityType(wallet.address); cheapScreened++;
    if (!entity.valid) { wallet.status = "REJECTED"; wallet.rejectionReason = entity.reason || "invalid_entity"; invalidEntities++; continue; }
    wallet.status = "CHEAP_PASS"; if (wallet.rejectionReason?.startsWith("tag:") || wallet.rejectionReason === "invalid_entity") delete wallet.rejectionReason;
  }
  const profileQueue = Object.values(state.wallets).filter((wallet) => wallet.status === "CHEAP_PASS" || wallet.status === "PROFILED" || wallet.status === "UNKNOWN").sort((a, b) => profileScore(b) - profileScore(a)).slice(0, PROFILE_LIMIT);
  await mapConcurrent(profileQueue, Math.min(VYBE_CONCURRENCY, 3), async (wallet) => {
    const [vybePnl, helius] = await Promise.all([vybeWalletPnl(wallet.address), heliusRecent(wallet.address)]), vybeSummary = summarizeVybePnl(vybePnl), heliusSummary = summarizeHelius(helius);
    wallet.lastProfiledAt = now(); wallet.profile = { ...(wallet.profile || {}), vybe30d: vybeSummary, heliusRecent: heliusSummary };
    if (vybeSummary || heliusSummary) { wallet.status = "PROFILED"; profiled++; } else { wallet.status = "UNKNOWN"; wallet.rejectionReason = "profile_data_unavailable"; unknown++; }
  });
  const totalUnique = Object.keys(state.wallets).length, newUniqueWallets = Math.max(totalUnique - beforeUnique, 0), rejectedTotal = Object.values(state.wallets).filter((wallet) => wallet.status === "REJECTED").length, crossTokenWallets = Object.values(state.wallets).filter((wallet) => (wallet.tokens?.length || 0) >= 2).length, multiProviderWallets = Object.values(state.wallets).filter((wallet) => (wallet.providers?.length || 0) >= 2).length;
  const telemetry = { startedAt, finishedAt: now(), providers: providerStatus, tokensExamined: tokens.length, rawWalletHits, newUniqueWallets, duplicates, cheapScreened, invalidEntities, tagRejected, profiled, unknown, cumulativeUniqueWallets: totalUnique, cumulativeRejectedWallets: rejectedTotal, crossTokenWallets, multiProviderWallets, providerErrors };
  state.updatedAt = now(); state.runs = [...state.runs.slice(-199), telemetry]; await saveJson(STATE_PATH, state);
  const ranked = Object.values(state.wallets).filter((wallet) => wallet.status === "PROFILED").sort((a, b) => profileScore(b) - profileScore(a)).slice(0, 50).map((wallet) => ({ address: wallet.address, status: wallet.status, firstSeen: wallet.firstSeen, lastSeen: wallet.lastSeen, rediscoveryCount: wallet.rediscoveryCount, uniqueTokensSeen: wallet.tokens?.length || 0, providers: wallet.providers, tags: wallet.tags, profile: wallet.profile }));
  const report = { schemaVersion: 2, generatedAt: now(), telemetry, note: "Harvest discovery/profile output only. A wallet is not LIVE-TEST WORTHY until downstream raw economic reconstruction and Odin 0.075-SOL follower replay pass.", rankedDiscoveryCandidates: ranked };
  await saveJson(REPORT_PATH, report); return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runHarvest()
    .then((report: any) => {
      const telemetry = report?.telemetry ?? {};
      const top = Array.isArray(report?.rankedDiscoveryCandidates) ? report.rankedDiscoveryCandidates.slice(0, 5).map((row: any) => ({ address: row.address, uniqueTokensSeen: row.uniqueTokensSeen, providers: row.providers, status: row.status })) : [];
      console.log(JSON.stringify({ event: "shark_scout_harvest_complete", telemetry, topCandidates: top }));
      process.exitCode = 0;
    })
    .catch((error) => {
      console.error(JSON.stringify({ event: "shark_scout_harvest_failed", error: error instanceof Error ? error.message : String(error) }));
      process.exitCode = 1;
    });
}
