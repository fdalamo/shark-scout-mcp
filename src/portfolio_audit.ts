import { promises as fs } from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";

const HELIUS_KEY = process.env.HELIUS_API_KEY?.trim();
const WALLET = process.env.SCOUT_WALLET_ADDRESS?.trim();
const SNAPSHOT_PATH = process.env.SCOUT_PORTFOLIO_PATH || "/data/portfolio-audit.json";
const SIG_LIMIT = clamp(Number(process.env.PORTFOLIO_SIGNATURE_LIMIT || 250), 50, 500);
const MAX_POSITIONS = clamp(Number(process.env.PORTFOLIO_MAX_POSITIONS || 25), 5, 50);
const TIMEOUT_MS = clamp(Number(process.env.REQUEST_TIMEOUT_MS || 25000), 3000, 60000);
const WSOL = "So11111111111111111111111111111111111111112";

type AnyObj = Record<string, any>;
type Lot = { qty: number; costSol: number; signature: string; ts: number | null };
type TokenBook = {
  mint: string;
  lots: Lot[];
  realizedPnlSol: number;
  realizedProceedsSol: number;
  realizedCostSol: number;
  buys: number;
  sells: number;
  lastBuyPriceSol: number | null;
  lastSellPriceSol: number | null;
  lastTradeAt: number | null;
  basisIncomplete: boolean;
};

function clamp(n: number, min: number, max: number) { return Math.max(min, Math.min(max, Number.isFinite(n) ? Math.floor(n) : min)); }
function now() { return new Date().toISOString(); }
async function atomicSave(file: string, data: any) { await fs.mkdir(path.dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.tmp`; await fs.writeFile(tmp, JSON.stringify(data)); await fs.rename(tmp, file); }
function validWallet(v?: string) { if (!v) return false; try { return new PublicKey(v).toBase58() === v; } catch { return false; } }

async function rpc(method: string, params: any[]) {
  const c = new AbortController(); const timer = setTimeout(() => c.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(HELIUS_KEY!)}`, {
      method: "POST", headers: { "content-type": "application/json" }, signal: c.signal,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = await r.json() as AnyObj;
    if (!r.ok || body?.error) throw new Error(`rpc_${method}:${body?.error?.message || r.status}`);
    return body?.result;
  } finally { clearTimeout(timer); }
}

async function tokenBalances() {
  const result = await rpc("getTokenAccountsByOwner", [WALLET, { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }, { encoding: "jsonParsed", commitment: "confirmed" }]);
  const byMint = new Map<string, number>();
  for (const row of result?.value || []) {
    const info = row?.account?.data?.parsed?.info;
    const mint = String(info?.mint || "");
    const amount = Number(info?.tokenAmount?.uiAmountString || 0);
    if (mint && amount > 0) byMint.set(mint, (byMint.get(mint) || 0) + amount);
  }
  return byMint;
}

function keyOf(x: any): string { return typeof x === "string" ? x : String(x?.pubkey || ""); }
function aggregateOwnerTokenBalances(list: any[], owner: string) {
  const m = new Map<string, number>();
  for (const b of list || []) {
    if (String(b?.owner || "") !== owner) continue;
    const mint = String(b?.mint || "");
    const qty = Number(b?.uiTokenAmount?.uiAmountString || 0);
    if (mint) m.set(mint, (m.get(mint) || 0) + qty);
  }
  return m;
}

function ensureBook(map: Map<string, TokenBook>, mint: string) {
  let b = map.get(mint);
  if (!b) { b = { mint, lots: [], realizedPnlSol: 0, realizedProceedsSol: 0, realizedCostSol: 0, buys: 0, sells: 0, lastBuyPriceSol: null, lastSellPriceSol: null, lastTradeAt: null, basisIncomplete: false }; map.set(mint, b); }
  return b;
}

function fifoSell(book: TokenBook, qty: number, proceedsSol: number) {
  let remain = qty, cost = 0;
  while (remain > 1e-12 && book.lots.length) {
    const lot = book.lots[0]!;
    const take = Math.min(remain, lot.qty);
    const unit = lot.qty > 0 ? lot.costSol / lot.qty : 0;
    cost += take * unit;
    lot.qty -= take; lot.costSol -= take * unit; remain -= take;
    if (lot.qty <= 1e-12) book.lots.shift();
  }
  if (remain > Math.max(1e-9, qty * 0.001)) book.basisIncomplete = true;
  book.realizedProceedsSol += proceedsSol;
  book.realizedCostSol += cost;
  book.realizedPnlSol += proceedsSol - cost;
}

async function reconstructHistory(current: Map<string, number>) {
  const sigRows = await rpc("getSignaturesForAddress", [WALLET, { limit: SIG_LIMIT }, "confirmed"]);
  const txs: AnyObj[] = [];
  for (const s of (sigRows || []).slice().reverse()) {
    try {
      const tx = await rpc("getTransaction", [s.signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
      if (tx?.meta && !tx.meta.err) txs.push({ ...tx, _signature: s.signature, _blockTime: s.blockTime ?? tx.blockTime ?? null });
    } catch { /* one bad tx must not kill hourly audit */ }
  }

  const books = new Map<string, TokenBook>();
  let classified = 0;
  for (const tx of txs) {
    const keys = tx?.transaction?.message?.accountKeys || [];
    const ownerIndex = keys.findIndex((k: any) => keyOf(k) === WALLET);
    if (ownerIndex < 0) continue;
    const preLam = Number(tx?.meta?.preBalances?.[ownerIndex] || 0);
    const postLam = Number(tx?.meta?.postBalances?.[ownerIndex] || 0);
    const solDelta = (postLam - preLam) / 1e9;
    if (Math.abs(solDelta) < 0.0005) continue;

    const pre = aggregateOwnerTokenBalances(tx?.meta?.preTokenBalances || [], WALLET!);
    const post = aggregateOwnerTokenBalances(tx?.meta?.postTokenBalances || [], WALLET!);
    const mints = new Set([...pre.keys(), ...post.keys()]);
    const deltas = [...mints].filter(m => m !== WSOL).map(m => ({ mint: m, delta: (post.get(m) || 0) - (pre.get(m) || 0) })).filter(x => Math.abs(x.delta) > 1e-9);
    if (!deltas.length) continue;

    let chosen: { mint: string; delta: number } | undefined;
    if (solDelta < 0) chosen = deltas.filter(x => x.delta > 0).sort((a, b) => b.delta - a.delta)[0];
    else chosen = deltas.filter(x => x.delta < 0).sort((a, b) => a.delta - b.delta)[0];
    if (!chosen) continue;

    const b = ensureBook(books, chosen.mint);
    b.lastTradeAt = tx._blockTime;
    if (chosen.delta > 0 && solDelta < 0) {
      const qty = chosen.delta, costSol = -solDelta;
      b.lots.push({ qty, costSol, signature: tx._signature, ts: tx._blockTime });
      b.buys++; b.lastBuyPriceSol = costSol / qty; classified++;
    } else if (chosen.delta < 0 && solDelta > 0) {
      const qty = -chosen.delta, proceedsSol = solDelta;
      fifoSell(b, qty, proceedsSol);
      b.sells++; b.lastSellPriceSol = proceedsSol / qty; classified++;
    }
  }

  // If current quantity exceeds reconstructed lots, keep the known basis but mark incomplete.
  for (const [mint, qty] of current) {
    const b = ensureBook(books, mint);
    const lotQty = b.lots.reduce((s, l) => s + l.qty, 0);
    if (qty > lotQty + Math.max(1e-8, qty * 0.001)) b.basisIncomplete = true;
  }
  return { books, scanned: txs.length, classified };
}

async function dexPrice(mint: string) {
  const c = new AbortController(); const timer = setTimeout(() => c.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: c.signal });
    if (!r.ok) return { symbol: null as string | null, priceUsd: null as number | null };
    const body = await r.json() as AnyObj;
    const pairs = Array.isArray(body?.pairs) ? body.pairs.filter((p: any) => p?.chainId === "solana" && p?.baseToken?.address === mint) : [];
    pairs.sort((a: any, b: any) => Number(b?.liquidity?.usd || 0) - Number(a?.liquidity?.usd || 0));
    const p = pairs[0];
    return { symbol: p?.baseToken?.symbol ? String(p.baseToken.symbol) : null, priceUsd: Number.isFinite(Number(p?.priceUsd)) ? Number(p.priceUsd) : null };
  } catch { return { symbol: null, priceUsd: null }; } finally { clearTimeout(timer); }
}

export async function runPortfolioAudit() {
  const startedAt = now();
  const telemetry: AnyObj = { event: "shark_scout_portfolio_complete", startedAt, enabled: Boolean(HELIUS_KEY && validWallet(WALLET)), walletConfigured: Boolean(WALLET), errors: [] as string[] };
  if (!HELIUS_KEY || !validWallet(WALLET)) return { ...telemetry, finishedAt: now(), skipped: !HELIUS_KEY ? "missing_helius_key" : "missing_or_invalid_wallet" };
  try {
    const [lamports, balances] = await Promise.all([rpc("getBalance", [WALLET, { commitment: "confirmed" }]), tokenBalances()]);
    const history = await reconstructHistory(balances);
    const solMarket = await dexPrice(WSOL);
    const solUsd = solMarket.priceUsd;
    const rows: AnyObj[] = [];

    for (const [mint, qty] of [...balances.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_POSITIONS)) {
      const [market, book] = await Promise.all([dexPrice(mint), Promise.resolve(history.books.get(mint) || ensureBook(history.books, mint))]);
      const openQtyKnown = book.lots.reduce((s, l) => s + l.qty, 0);
      const openCostSol = book.lots.reduce((s, l) => s + l.costSol, 0);
      const avgEntrySol = openQtyKnown > 0 ? openCostSol / openQtyKnown : null;
      const valueUsd = market.priceUsd != null ? market.priceUsd * qty : null;
      const valueSol = valueUsd != null && solUsd ? valueUsd / solUsd : null;
      const unrealizedPnlSol = valueSol != null && !book.basisIncomplete ? valueSol - openCostSol : null;
      const totalPnlSol = unrealizedPnlSol != null ? book.realizedPnlSol + unrealizedPnlSol : null;
      const totalCost = !book.basisIncomplete ? book.realizedCostSol + openCostSol : null;
      const totalPnlPct = totalPnlSol != null && totalCost && totalCost > 0 ? 100 * totalPnlSol / totalCost : null;
      rows.push({
        symbol: market.symbol || mint.slice(0, 6), mint, quantity: qty,
        currentPriceUsd: market.priceUsd, currentValueUsd: valueUsd, currentValueSol: valueSol,
        entryPriceSolPerToken: avgEntrySol ?? book.lastBuyPriceSol,
        lastExitPriceSolPerToken: book.lastSellPriceSol,
        openCostSol: book.basisIncomplete ? null : openCostSol,
        realizedPnlSol: book.realizedPnlSol,
        unrealizedPnlSol,
        totalPnlSol, totalPnlPct,
        buysSeen: book.buys, sellsSeen: book.sells,
        costBasisStatus: book.basisIncomplete ? "PARTIAL_OR_UNKNOWN" : (book.buys ? "RECONSTRUCTED" : "UNKNOWN"),
        lastTradeAt: book.lastTradeAt ? new Date(book.lastTradeAt * 1000).toISOString() : null,
      });
    }
    rows.sort((a, b) => Number(b.currentValueUsd || 0) - Number(a.currentValueUsd || 0));
    const solBalance = Number(lamports?.value || 0) / 1e9;
    const tokenValueUsd = rows.reduce((s, r) => s + Number(r.currentValueUsd || 0), 0);
    const portfolioValueUsd = solUsd ? solBalance * solUsd + tokenValueUsd : tokenValueUsd || null;
    const out = { ...telemetry, solBalance, solPriceUsd: solUsd, tokenPositionCount: rows.length, portfolioValueUsd, transactionsScanned: history.scanned, tradesClassified: history.classified, positions: rows, finishedAt: now() };
    await atomicSave(SNAPSHOT_PATH, out);
    return out;
  } catch (e) {
    telemetry.errors.push(e instanceof Error ? e.message : String(e));
    return { ...telemetry, finishedAt: now() };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) runPortfolioAudit().then(x => console.log(JSON.stringify(x))).catch(e => { console.error(JSON.stringify({ event: "shark_scout_portfolio_failed", error: e instanceof Error ? e.message : String(e) })); process.exitCode = 1; });
