import express, { type Request, type Response } from "express";
import { PublicKey } from "@solana/web3.js";

const PORT = Number(process.env.PORT ?? 3000);
const TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 15000);
const HELIUS_API_KEY = process.env.HELIUS_API_KEY?.trim();
const RPC_URL = process.env.SOLANA_RPC_URL?.trim() || (HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}` : "https://api.mainnet-beta.solana.com");
const LAMPORTS_PER_SOL = 1_000_000_000;
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const SOL_DUST_LAMPORTS = 3_000_000;
const STABLE_DUST = 0.01;
const VERSION = "0.5.0";

type Direction = "BUY" | "SELL" | "TOKEN_SWAP" | "TRANSFER_IN" | "TRANSFER_OUT" | "IGNORED" | "UNKNOWN";

type TokenDelta = {
  mint: string;
  decimals: number;
  preRaw: bigint;
  postRaw: bigint;
  deltaRaw: bigint;
  deltaUi: number;
};

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

async function parsedTransaction(signature: string) {
  return rpc("getTransaction", [signature, {
    encoding: "jsonParsed",
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  }]);
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
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

function accountKeys(raw: any): string[] {
  const message = raw?.transaction?.message ?? {};
  const base = (message?.accountKeys ?? []).map((key: any) => typeof key === "string" ? key : String(key?.pubkey ?? ""));
  const expected = raw?.meta?.preBalances?.length ?? 0;
  if (base.length < expected) {
    const loaded = raw?.meta?.loadedAddresses ?? {};
    const extras = [...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])].map(String);
    if (base.length + extras.length === expected) base.push(...extras);
  }
  return base;
}

function tokenTotals(entries: any[] | null | undefined, wallet: string): Map<string, { raw: bigint; decimals: number }> {
  const totals = new Map<string, { raw: bigint; decimals: number }>();
  for (const entry of entries ?? []) {
    if (entry?.owner !== wallet || !entry?.mint) continue;
    const amount = entry?.uiTokenAmount ?? {};
    let raw = 0n;
    try { raw = BigInt(amount?.amount ?? "0"); } catch { continue; }
    const decimals = Number(amount?.decimals ?? 0);
    const previous = totals.get(entry.mint) ?? { raw: 0n, decimals };
    totals.set(entry.mint, { raw: previous.raw + raw, decimals: previous.decimals || decimals });
  }
  return totals;
}

function tokenDeltas(raw: any, wallet: string): TokenDelta[] {
  const pre = tokenTotals(raw?.meta?.preTokenBalances, wallet);
  const post = tokenTotals(raw?.meta?.postTokenBalances, wallet);
  const mints = new Set([...pre.keys(), ...post.keys()]);
  const deltas: TokenDelta[] = [];
  for (const mint of mints) {
    const before = pre.get(mint) ?? { raw: 0n, decimals: post.get(mint)?.decimals ?? 0 };
    const after = post.get(mint) ?? { raw: 0n, decimals: before.decimals };
    const decimals = after.decimals || before.decimals;
    const deltaRaw = after.raw - before.raw;
    if (deltaRaw === 0n) continue;
    const divisor = 10 ** decimals;
    deltas.push({
      mint,
      decimals,
      preRaw: before.raw,
      postRaw: after.raw,
      deltaRaw,
      deltaUi: Number(deltaRaw) / divisor,
    });
  }
  return deltas;
}

function nativeEconomicDeltaLamports(raw: any, wallet: string): number {
  const keys = accountKeys(raw);
  const pre: number[] = raw?.meta?.preBalances ?? [];
  const post: number[] = raw?.meta?.postBalances ?? [];
  const fee = Number(raw?.meta?.fee ?? 0);
  let total = 0;
  keys.forEach((key, index) => {
    if (key !== wallet || index >= pre.length || index >= post.length) return;
    let delta = Number(post[index]) - Number(pre[index]);
    if (index === 0) delta += fee;
    total += delta;
  });
  return total;
}

function stableQuote(deltas: TokenDelta[], spent: boolean): { mint: string; amount: number } | null {
  const candidates = deltas
    .filter((d) => d.mint === USDC_MINT || d.mint === USDT_MINT)
    .filter((d) => spent ? d.deltaUi < -STABLE_DUST : d.deltaUi > STABLE_DUST)
    .map((d) => ({ mint: d.mint, amount: Math.abs(d.deltaUi) }))
    .sort((a, b) => b.amount - a.amount);
  return candidates[0] ?? null;
}

function economicTrade(raw: any, enhanced: any, address: string) {
  if (!raw?.meta) {
    return {
      signature: enhanced?.signature ?? null,
      timestamp: enhanced?.timestamp ?? null,
      slot: null,
      direction: "UNKNOWN" as Direction,
      confidence: "low",
      classificationReason: "raw_transaction_unavailable",
      mint: null,
      tokenAmount: null,
      quote: null,
      priceInQuote: null,
      feeLamports: enhanced?.fee ?? null,
      walletIsFeePayer: enhanced?.feePayer === address,
      heliusType: enhanced?.type ?? null,
      source: enhanced?.source ?? null,
    };
  }

  const deltas = tokenDeltas(raw, address);
  const wsol = deltas.find((d) => d.mint === WSOL_MINT);
  const nativeLamports = nativeEconomicDeltaLamports(raw, address);
  const solQuoteLamports = nativeLamports + Number(wsol?.deltaRaw ?? 0n);
  const solQuote = solQuoteLamports / LAMPORTS_PER_SOL;
  const nonQuote = deltas.filter((d) => d.mint !== WSOL_MINT && d.mint !== USDC_MINT && d.mint !== USDT_MINT);
  const received = nonQuote.filter((d) => d.deltaRaw > 0n).sort((a, b) => Math.abs(b.deltaUi) - Math.abs(a.deltaUi));
  const sent = nonQuote.filter((d) => d.deltaRaw < 0n).sort((a, b) => Math.abs(b.deltaUi) - Math.abs(a.deltaUi));

  const solSpent = solQuoteLamports < -SOL_DUST_LAMPORTS;
  const solReceived = solQuoteLamports > SOL_DUST_LAMPORTS;
  const stableSpent = stableQuote(deltas, true);
  const stableReceived = stableQuote(deltas, false);

  const quoteSpent = solSpent
    ? { mint: "SOL", amount: Math.abs(solQuote) }
    : stableSpent;
  const quoteReceived = solReceived
    ? { mint: "SOL", amount: solQuote }
    : stableReceived;

  let direction: Direction = "IGNORED";
  let reason = "no_meaningful_wallet_economic_exchange";
  let primary: TokenDelta | null = null;
  let quote: { mint: string; amount: number } | null = null;
  let confidence: "high" | "medium" | "low" = "high";

  if (quoteSpent && received.length > 0) {
    direction = "BUY";
    primary = received[0]!;
    quote = quoteSpent;
    reason = "quote_currency_out_and_token_balance_in";
    if (sent.length > 0 || received.length > 1) confidence = "medium";
  } else if (quoteReceived && sent.length > 0) {
    direction = "SELL";
    primary = sent[0]!;
    quote = quoteReceived;
    reason = "token_balance_out_and_quote_currency_in";
    if (received.length > 0 || sent.length > 1) confidence = "medium";
  } else if (!quoteSpent && !quoteReceived && received.length > 0 && sent.length > 0) {
    direction = "TOKEN_SWAP";
    primary = received[0]!;
    reason = "token_out_and_token_in_without_quote_currency_delta";
    confidence = "medium";
  } else if (!quoteSpent && !quoteReceived && received.length > 0 && sent.length === 0) {
    direction = "TRANSFER_IN";
    primary = received[0]!;
    reason = "token_balance_in_without_payment";
  } else if (!quoteSpent && !quoteReceived && sent.length > 0 && received.length === 0) {
    direction = "TRANSFER_OUT";
    primary = sent[0]!;
    reason = "token_balance_out_without_consideration_received";
  } else if ((quoteSpent || quoteReceived) && received.length === 0 && sent.length === 0) {
    direction = "IGNORED";
    reason = "quote_only_or_wrap_unwrap_activity";
  } else if (received.length > 0 || sent.length > 0) {
    direction = "UNKNOWN";
    primary = received[0] ?? sent[0] ?? null;
    reason = "ambiguous_multi_leg_wallet_balance_change";
    confidence = "low";
  }

  const amount = primary ? Math.abs(primary.deltaUi) : null;
  const priceInQuote = quote && amount && amount > 0 ? quote.amount / amount : null;
  const keys = accountKeys(raw);
  const rawFeePayer = keys[0] ?? null;

  return {
    signature: enhanced?.signature ?? raw?.transaction?.signatures?.[0] ?? null,
    timestamp: enhanced?.timestamp ?? raw?.blockTime ?? null,
    slot: raw?.slot ?? null,
    direction,
    confidence,
    classificationReason: reason,
    mint: primary?.mint ?? null,
    tokenAmount: amount,
    tokenPreRaw: primary?.preRaw.toString() ?? null,
    tokenPostRaw: primary?.postRaw.toString() ?? null,
    quote,
    priceInQuote,
    economicSolDelta: solQuote,
    nativeEconomicSolDelta: nativeLamports / LAMPORTS_PER_SOL,
    wsolDelta: Number(wsol?.deltaRaw ?? 0n) / LAMPORTS_PER_SOL,
    feeLamports: raw?.meta?.fee ?? enhanced?.fee ?? null,
    rawFeePayer,
    walletIsFeePayer: rawFeePayer === address,
    heliusType: enhanced?.type ?? null,
    source: enhanced?.source ?? null,
    rawSucceeded: raw?.meta?.err == null,
    tokenDeltas: nonQuote.map((d) => ({
      mint: d.mint,
      decimals: d.decimals,
      preRaw: d.preRaw.toString(),
      postRaw: d.postRaw.toString(),
      deltaRaw: d.deltaRaw.toString(),
      deltaUi: d.deltaUi,
    })),
    quoteTokenDeltas: deltas
      .filter((d) => d.mint === WSOL_MINT || d.mint === USDC_MINT || d.mint === USDT_MINT)
      .map((d) => ({ mint: d.mint, deltaUi: d.deltaUi, deltaRaw: d.deltaRaw.toString() })),
  };
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "shark-scout",
    mode: "browser-api",
    version: VERSION,
    readOnly: true,
    endpoints: [
      "/health",
      "/wallet/:address/analyst?limit=25",
      "/wallet/:address/report?limit=20",
      "/wallet/:address/balance",
      "/wallet/:address/activity?limit=25",
      "/wallet/:address/swaps?limit=25",
      "/wallet/:address/positions",
    ],
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "shark-scout",
    version: VERSION,
    mode: "browser-api",
    readOnly: true,
    heliusConfigured: Boolean(HELIUS_API_KEY),
    rpc: HELIUS_API_KEY ? "helius" : "solana",
    analystParser: "raw_wallet_balance_deltas",
    time: new Date().toISOString(),
  });
});

app.get("/wallet/:address/analyst", async (req: Request, res: Response) => {
  try {
    const address = validAddress(routeParam(req.params.address, "address"));
    const limit = boundedLimit(req.query.limit, 25, 50);
    const [balance, enhanced] = await Promise.all([
      rpc("getBalance", [address, { commitment: "confirmed" }]),
      heliusAddressTransactions(address, limit),
    ]);
    if (!enhanced) throw new Error("Analyst endpoint requires Helius enhanced transaction history");

    const enhancedRows = enhanced as any[];
    const parsedRows = await mapConcurrent(enhancedRows, 8, async (tx: any) => {
      const signature = String(tx?.signature ?? "");
      if (!signature) return economicTrade(null, tx, address);
      try {
        const raw = await parsedTransaction(signature);
        return economicTrade(raw, tx, address);
      } catch {
        return economicTrade(null, tx, address);
      }
    });

    const trades = parsedRows.filter((x: any) => x.direction === "BUY" || x.direction === "SELL" || x.direction === "TOKEN_SWAP");
    const transfers = parsedRows.filter((x: any) => x.direction === "TRANSFER_IN" || x.direction === "TRANSFER_OUT");
    const ignored = parsedRows.filter((x: any) => x.direction === "IGNORED");
    const unknown = parsedRows.filter((x: any) => x.direction === "UNKNOWN");
    const buys = trades.filter((x: any) => x.direction === "BUY");
    const sells = trades.filter((x: any) => x.direction === "SELL");

    res.json({
      ok: true,
      version: VERSION,
      address,
      scannedAt: new Date().toISOString(),
      balanceSol: typeof balance?.value === "number" ? balance.value / LAMPORTS_PER_SOL : null,
      sources: ["helius_enhanced_history", HELIUS_API_KEY ? "helius_rpc_raw_transactions" : "solana_rpc_raw_transactions"],
      parser: "wallet_pre_post_balance_deltas",
      scannedTransactions: parsedRows.length,
      tradeEvents: trades.length,
      buys: buys.length,
      sells: sells.length,
      tokenSwaps: trades.filter((x: any) => x.direction === "TOKEN_SWAP").length,
      transferEvents: transfers.length,
      ignoredTransactions: ignored.length,
      unknownTransactions: unknown.length,
      trades,
      transfers,
      unknown,
      analystNotes: [
        "BUY/SELL classification is based on this wallet's pre/post SOL and token balances, not on a program name or Helius SWAP label alone.",
        "The network fee is removed from the wallet's native SOL delta when the wallet is the fee payer so fee spend is not mistaken for trade consideration.",
        "Incoming token balances without payment are TRANSFER_IN; outgoing tokens without consideration are TRANSFER_OUT. Neither is counted as a trade.",
        "Small native SOL changes below 0.003 SOL are treated as account-rent/housekeeping noise for trade classification.",
        "Signature + timestamp + mint + direction remain the minimum evidence key for source-to-copy matching.",
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
        version: VERSION,
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
        evidenceNote: "Compact Helius evidence only. Use /analyst for wallet-economic BUY/SELL classification.",
      });
      return;
    }

    const txs = await rpc("getSignaturesForAddress", [address, { limit }]);
    res.json({
      ok: true,
      version: VERSION,
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
    res.json({ ok: true, address, source: "helius_enhanced", confidence: "semantic_only_not_wallet_economic", scanned: enhanced.length, swapCount: swaps.length, swaps });
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
  console.log(`Shark Scout browser API ${VERSION} listening on ${PORT}`);
});
