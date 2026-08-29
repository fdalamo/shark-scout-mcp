import express, { type Request, type Response } from "express";
import { PublicKey } from "@solana/web3.js";

const PORT = Number(process.env.PORT ?? 3000);
const TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 15000);
const HELIUS_API_KEY = process.env.HELIUS_API_KEY?.trim();
const RPC_URL = process.env.SOLANA_RPC_URL?.trim() || (HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}` : "https://api.mainnet-beta.solana.com");
const LAMPORTS_PER_SOL = 1_000_000_000;
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

function validAddress(value: string): string {
  try { return new PublicKey(value).toBase58(); } catch { throw new Error(`Invalid Solana address: ${value}`); }
}

function routeParam(value: string | string[] | undefined, name: string): string {
  const resolved = Array.isArray(value) ? value[0] : value;
  if (!resolved) throw new Error(`Missing route parameter: ${name}`);
  return resolved;
}

function boundedLimit(value: unknown, fallback = 20, max = 100): number {
  const n = Number(value ?? fallback);
  return Math.min(Math.max(Number.isFinite(n) ? Math.floor(n) : fallback, 1), max);
}

async function fetchJson(url: string, init: RequestInit = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 500)}`);
    return body ? JSON.parse(body) : null;
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

async function heliusAddressTransactions(address: string, limit = 50) {
  if (!HELIUS_API_KEY) return null;
  const q = new URLSearchParams({ "api-key": HELIUS_API_KEY, limit: String(limit) });
  return fetchJson(`https://api.helius.xyz/v0/addresses/${address}/transactions?${q}`);
}

function fail(res: Response, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  res.status(400).json({ ok: false, error: message });
}

function compactEnhanced(tx: any) {
  return {
    signature: tx?.signature ?? null,
    timestamp: tx?.timestamp ?? null,
    type: tx?.type ?? null,
    source: tx?.source ?? null,
    feeLamports: tx?.fee ?? null,
    feePayer: tx?.feePayer ?? null,
    description: tx?.description ?? null,
    nativeTransfers: (tx?.nativeTransfers ?? []).slice(0, 8),
    tokenTransfers: (tx?.tokenTransfers ?? []).slice(0, 12),
  };
}

function walletTrade(tx: any, address: string) {
  const nativeTransfers = tx?.nativeTransfers ?? [];
  const tokenTransfers = tx?.tokenTransfers ?? [];

  const solOutLamports = nativeTransfers
    .filter((t: any) => t?.fromUserAccount === address)
    .reduce((sum: number, t: any) => sum + Number(t?.amount ?? 0), 0);
  const solInLamports = nativeTransfers
    .filter((t: any) => t?.toUserAccount === address)
    .reduce((sum: number, t: any) => sum + Number(t?.amount ?? 0), 0);

  const tokenNet = new Map<string, number>();
  for (const t of tokenTransfers) {
    const mint = t?.mint;
    if (!mint) continue;
    const amount = Number(t?.tokenAmount ?? 0);
    if (!Number.isFinite(amount) || amount === 0) continue;
    if (t?.toUserAccount === address) tokenNet.set(mint, (tokenNet.get(mint) ?? 0) + amount);
    if (t?.fromUserAccount === address) tokenNet.set(mint, (tokenNet.get(mint) ?? 0) - amount);
  }

  const tokenLegs = [...tokenNet.entries()]
    .filter(([, amount]) => Math.abs(amount) > 0)
    .map(([mint, amount]) => ({ mint, amount }));

  const netSolLamports = solInLamports - solOutLamports;
  const netSol = netSolLamports / LAMPORTS_PER_SOL;
  const received = tokenLegs.filter((x) => x.amount > 0).sort((a, b) => b.amount - a.amount);
  const sent = tokenLegs.filter((x) => x.amount < 0).sort((a, b) => a.amount - b.amount);

  let direction: "BUY" | "SELL" | "SWAP" | "UNKNOWN" = "UNKNOWN";
  let primaryMint: string | null = null;
  let tokenAmount: number | null = null;

  if (netSol < 0 && received.length > 0) {
    direction = "BUY";
    primaryMint = received[0]?.mint ?? null;
    tokenAmount = received[0]?.amount ?? null;
  } else if (netSol > 0 && sent.length > 0) {
    direction = "SELL";
    primaryMint = sent[0]?.mint ?? null;
    tokenAmount = sent[0] ? Math.abs(sent[0].amount) : null;
  } else if (received.length > 0 || sent.length > 0) {
    direction = "SWAP";
    primaryMint = received[0]?.mint ?? sent[0]?.mint ?? null;
    tokenAmount = received[0]?.amount ?? (sent[0] ? Math.abs(sent[0].amount) : null);
  }

  const walletParticipates = Math.abs(netSolLamports) > 0 || tokenLegs.length > 0;
  return {
    signature: tx?.signature ?? null,
    timestamp: tx?.timestamp ?? null,
    heliusType: tx?.type ?? null,
    source: tx?.source ?? null,
    feePayer: tx?.feePayer ?? null,
    walletIsFeePayer: tx?.feePayer === address,
    walletParticipates,
    direction,
    mint: primaryMint,
    tokenAmount,
    solSpent: netSol < 0 ? Math.abs(netSol) : 0,
    solReceived: netSol > 0 ? netSol : 0,
    netSol,
    feeLamports: tx?.fee ?? null,
    tokenLegs,
    evidence: {
      walletNativeTransfers: nativeTransfers.filter((t: any) => t?.fromUserAccount === address || t?.toUserAccount === address),
      walletTokenTransfers: tokenTransfers.filter((t: any) => t?.fromUserAccount === address || t?.toUserAccount === address),
    },
  };
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "shark-scout", mode: "browser-api", version: "0.4.0", readOnly: true, endpoints: ["/health", "/wallet/:address/analyst?limit=50", "/wallet/:address/report?limit=20", "/wallet/:address/balance", "/wallet/:address/activity?limit=25", "/wallet/:address/swaps?limit=25", "/wallet/:address/positions"] });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "shark-scout", version: "0.4.0", mode: "browser-api", readOnly: true, heliusConfigured: Boolean(HELIUS_API_KEY), rpc: HELIUS_API_KEY ? "helius" : "solana", time: new Date().toISOString() });
});

app.get("/wallet/:address/analyst", async (req: Request, res: Response) => {
  try {
    const address = validAddress(routeParam(req.params.address, "address"));
    const limit = boundedLimit(req.query.limit, 50, 100);
    const [balance, enhanced] = await Promise.all([
      rpc("getBalance", [address, { commitment: "confirmed" }]),
      heliusAddressTransactions(address, limit),
    ]);
    if (!enhanced) throw new Error("Analyst endpoint requires Helius enhanced transactions");

    const all = (enhanced as any[]).map((tx: any) => walletTrade(tx, address));
    const trades = all.filter((x: any) => x.walletParticipates && (x.heliusType === "SWAP" || x.direction !== "UNKNOWN"));
    const ignored = all.length - trades.length;
    const buys = trades.filter((x: any) => x.direction === "BUY");
    const sells = trades.filter((x: any) => x.direction === "SELL");

    res.json({
      ok: true,
      version: "0.4.0",
      address,
      scannedAt: new Date().toISOString(),
      balanceSol: typeof balance?.value === "number" ? balance.value / LAMPORTS_PER_SOL : null,
      source: "helius_enhanced",
      scannedTransactions: all.length,
      walletRelevantTrades: trades.length,
      ignoredTransactions: ignored,
      buys: buys.length,
      sells: sells.length,
      trades,
      analystNotes: [
        "Trades are wallet-centric: a Helius SWAP is not counted merely because it touched the address.",
        "Direction is inferred from this wallet's own native/token transfer legs; UNKNOWN is preserved rather than guessed.",
        "Market cap, liquidity, token age, realized PnL, holding time, and copy attribution are not yet claimed by this endpoint.",
        "Use signature + timestamp + mint + direction as the minimum evidence key for source-to-copy matching.",
      ],
    });
  } catch (e) { fail(res, e); }
});

app.get("/wallet/:address/report", async (req: Request, res: Response) => {
  try {
    const address = validAddress(routeParam(req.params.address, "address"));
    const limit = boundedLimit(req.query.limit, 20, 50);
    const [balance, enhanced] = await Promise.all([
      rpc("getBalance", [address, { commitment: "confirmed" }]),
      heliusAddressTransactions(address, limit),
    ]);

    if (enhanced) {
      const rows = (enhanced as any[]).map(compactEnhanced);
      const swaps = rows.filter((tx: any) => tx.type === "SWAP");
      res.json({
        ok: true,
        version: "0.4.0",
        address,
        scannedAt: new Date().toISOString(),
        balance: {
          sol: typeof balance?.value === "number" ? balance.value / LAMPORTS_PER_SOL : null,
          lamports: balance?.value ?? null,
          slot: balance?.context?.slot ?? null,
        },
        activity: {
          source: "helius_enhanced",
          scanned: rows.length,
          newestTimestamp: rows[0]?.timestamp ?? null,
          oldestTimestamp: rows.at(-1)?.timestamp ?? null,
          swapCount: swaps.length,
        },
        swaps,
        recent: rows,
        evidenceNote: "Compact evidence only. Preserve signatures and verify exact transaction details before attributing a copy trade.",
      });
      return;
    }

    const txs = await rpc("getSignaturesForAddress", [address, { limit }]);
    res.json({
      ok: true,
      version: "0.4.0",
      address,
      scannedAt: new Date().toISOString(),
      balance: {
        sol: typeof balance?.value === "number" ? balance.value / LAMPORTS_PER_SOL : null,
        lamports: balance?.value ?? null,
        slot: balance?.context?.slot ?? null,
      },
      activity: { source: "solana_rpc", scanned: txs?.length ?? 0, swapCount: null },
      recent: txs ?? [],
      evidenceNote: "Helius enhanced parsing is unavailable, so swap classification is unknown rather than inferred.",
    });
  } catch (e) { fail(res, e); }
});

app.get("/wallet/:address/balance", async (req: Request, res: Response) => {
  try {
    const address = validAddress(routeParam(req.params.address, "address"));
    const result = await rpc("getBalance", [address, { commitment: "confirmed" }]);
    res.json({ ok: true, address, lamports: result?.value ?? null, sol: typeof result?.value === "number" ? result.value / LAMPORTS_PER_SOL : null, slot: result?.context?.slot ?? null, source: HELIUS_API_KEY ? "helius_rpc" : "solana_rpc" });
  } catch (e) { fail(res, e); }
});

app.get("/wallet/:address/activity", async (req: Request, res: Response) => {
  try {
    const address = validAddress(routeParam(req.params.address, "address"));
    const limit = boundedLimit(req.query.limit, 25, 100);
    const enhanced = await heliusAddressTransactions(address, limit);
    if (enhanced) {
      res.json({ ok: true, address, source: "helius_enhanced", count: enhanced.length, transactions: enhanced });
      return;
    }
    const txs = await rpc("getSignaturesForAddress", [address, { limit }]);
    res.json({ ok: true, address, source: "solana_rpc", count: txs?.length ?? 0, transactions: txs ?? [] });
  } catch (e) { fail(res, e); }
});

app.get("/wallet/:address/swaps", async (req: Request, res: Response) => {
  try {
    const address = validAddress(routeParam(req.params.address, "address"));
    const limit = boundedLimit(req.query.limit, 25, 100);
    const enhanced = await heliusAddressTransactions(address, limit);
    if (!enhanced) throw new Error("Swap classification requires Helius in browser mode");
    const swaps = (enhanced as any[]).filter((tx: any) => tx.type === "SWAP");
    res.json({ ok: true, address, source: "helius_enhanced", confidence: "high", scanned: enhanced.length, swapCount: swaps.length, swaps });
  } catch (e) { fail(res, e); }
});

app.get("/wallet/:address/positions", async (req: Request, res: Response) => {
  try {
    const address = validAddress(routeParam(req.params.address, "address"));
    const result = await rpc("getTokenAccountsByOwner", [address, { programId: TOKEN_PROGRAM_ID }, { encoding: "jsonParsed" }]);
    const positions = (result?.value ?? []).map((row: any) => {
      const info = row?.account?.data?.parsed?.info;
      return { tokenAccount: row.pubkey, mint: info?.mint, amount: info?.tokenAmount?.uiAmount, rawAmount: info?.tokenAmount?.amount, decimals: info?.tokenAmount?.decimals };
    }).filter((row: any) => Number(row.amount ?? 0) !== 0);
    res.json({ ok: true, address, source: HELIUS_API_KEY ? "helius_rpc" : "solana_rpc", count: positions.length, positions });
  } catch (e) { fail(res, e); }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Shark Scout browser API listening on ${PORT}`);
});
