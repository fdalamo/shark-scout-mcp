import express, { type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";

const PORT = Number(process.env.PORT ?? 3000);
const TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 15000);
const MAX_WATCHLIST = Number(process.env.MAX_WATCHLIST ?? 12);
const HELIUS_API_KEY = process.env.HELIUS_API_KEY?.trim();
const RPC_URL =
  process.env.SOLANA_RPC_URL?.trim() ||
  (HELIUS_API_KEY
    ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
    : "https://api.mainnet-beta.solana.com");

const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const LAMPORTS_PER_SOL = 1_000_000_000;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function textResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }, null, 2) }],
  };
}

function validAddress(value: string): string {
  try {
    return new PublicKey(value).toBase58();
  } catch {
    throw new Error(`Invalid Solana address: ${value}`);
  }
}

function validSignature(value: string): string {
  if (!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(value)) {
    throw new Error("Invalid Solana transaction signature");
  }
  return value;
}

async function fetchJson(url: string, init: RequestInit = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${body.slice(0, 500)}`);
    }
    return body ? JSON.parse(body) : null;
  } finally {
    clearTimeout(timer);
  }
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

async function heliusAddressTransactions(address: string, limit = 50, before?: string) {
  if (!HELIUS_API_KEY) return null;
  const query = new URLSearchParams({ "api-key": HELIUS_API_KEY, limit: String(limit) });
  if (before) query.set("before", before);
  return fetchJson(`https://api.helius.xyz/v0/addresses/${address}/transactions?${query}`);
}

async function heliusParseTransactions(signatures: string[]) {
  if (!HELIUS_API_KEY || signatures.length === 0) return null;
  return fetchJson(`https://api.helius.xyz/v0/transactions/?api-key=${HELIUS_API_KEY}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transactions: signatures.slice(0, 100) }),
  });
}

async function heliusDas(method: string, params: Record<string, unknown>) {
  if (!HELIUS_API_KEY) return null;
  return rpc(method, [params]);
}

function tokenDeltas(tx: any, owner?: string) {
  const pre = tx?.meta?.preTokenBalances ?? [];
  const post = tx?.meta?.postTokenBalances ?? [];
  const map = new Map<string, { mint: string; owner?: string; pre: number; post: number; decimals: number }>();
  for (const row of pre) {
    const key = `${row.accountIndex}:${row.mint}`;
    map.set(key, {
      mint: row.mint,
      owner: row.owner,
      pre: Number(row.uiTokenAmount?.uiAmount ?? 0),
      post: 0,
      decimals: Number(row.uiTokenAmount?.decimals ?? 0),
    });
  }
  for (const row of post) {
    const key = `${row.accountIndex}:${row.mint}`;
    const old = map.get(key);
    map.set(key, {
      mint: row.mint,
      owner: row.owner ?? old?.owner,
      pre: old?.pre ?? 0,
      post: Number(row.uiTokenAmount?.uiAmount ?? 0),
      decimals: Number(row.uiTokenAmount?.decimals ?? old?.decimals ?? 0),
    });
  }
  return [...map.values()]
    .filter((x) => !owner || x.owner === owner)
    .map((x) => ({ ...x, delta: x.post - x.pre }))
    .filter((x) => Math.abs(x.delta) > 0);
}

function solDelta(tx: any, address: string) {
  const keys = tx?.transaction?.message?.accountKeys ?? [];
  const index = keys.findIndex((k: any) => (typeof k === "string" ? k : k?.pubkey) === address);
  if (index < 0) return null;
  const pre = tx?.meta?.preBalances?.[index];
  const post = tx?.meta?.postBalances?.[index];
  if (typeof pre !== "number" || typeof post !== "number") return null;
  return (post - pre) / LAMPORTS_PER_SOL;
}

async function getRawTransaction(signature: string) {
  return rpc("getTransaction", [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
}

async function activity(address: string, limit: number, before?: string) {
  const options: Record<string, unknown> = { limit };
  if (before) options.before = before;
  return rpc("getSignaturesForAddress", [address, options]);
}

async function parsedActivity(address: string, limit: number, before?: string) {
  const enhanced = await heliusAddressTransactions(address, limit, before);
  if (enhanced) return { source: "helius_enhanced", transactions: enhanced };
  const signatures = await activity(address, limit, before);
  return { source: "solana_rpc", transactions: signatures };
}

async function walletTokenPositions(address: string) {
  if (HELIUS_API_KEY) {
    const das = await heliusDas("getAssetsByOwner", {
      ownerAddress: address,
      page: 1,
      limit: 1000,
      displayOptions: { showFungible: true, showNativeBalance: true },
    });
    if (das) return { source: "helius_das", data: das };
  }
  const result = await rpc("getTokenAccountsByOwner", [
    address,
    { programId: TOKEN_PROGRAM_ID },
    { encoding: "jsonParsed" },
  ]);
  const positions = (result?.value ?? [])
    .map((row: any) => {
      const info = row?.account?.data?.parsed?.info;
      return {
        tokenAccount: row.pubkey,
        mint: info?.mint,
        owner: info?.owner,
        amount: info?.tokenAmount?.uiAmount,
        rawAmount: info?.tokenAmount?.amount,
        decimals: info?.tokenAmount?.decimals,
      };
    })
    .filter((row: any) => Number(row.amount ?? 0) !== 0);
  return { source: "solana_rpc", data: positions };
}

function createServer() {
  const server = new McpServer(
    { name: "shark-scout", version: "0.1.0" },
    {
      instructions:
        "Read-only Solana wallet intelligence for copy-trading research. Never infer missing activity. Preserve signatures, timestamps, source labels, and uncertainty. Prefer Helius enhanced data when configured; otherwise clearly label raw RPC results.",
    },
  );

  server.registerTool(
    "wallet_balance",
    {
      title: "Wallet Balance",
      description: "Get current native SOL balance for an exact Solana wallet address.",
      inputSchema: z.object({ address: z.string() }),
    },
    async ({ address }) => {
      try {
        address = validAddress(address);
        const result = await rpc("getBalance", [address, { commitment: "confirmed" }]);
        return textResult({
          address,
          lamports: result?.value ?? null,
          sol: typeof result?.value === "number" ? result.value / LAMPORTS_PER_SOL : null,
          slot: result?.context?.slot ?? null,
          source: HELIUS_API_KEY ? "helius_rpc" : "solana_rpc",
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "wallet_activity",
    {
      title: "Wallet Activity",
      description: "Fetch recent exact-address activity. Uses Helius enhanced transactions when configured, otherwise raw Solana signatures.",
      inputSchema: z.object({
        address: z.string(),
        limit: z.number().int().min(1).max(100).default(50),
        before: z.string().optional(),
      }),
    },
    async ({ address, limit, before }) => {
      try {
        address = validAddress(address);
        return textResult({ address, ...(await parsedActivity(address, limit, before)) });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "wallet_swaps",
    {
      title: "Wallet Swaps",
      description: "Return recent swap-like transactions for a wallet. Helius gives high-confidence SWAP classification; RPC fallback returns candidates with token and SOL balance deltas and is explicitly labeled heuristic.",
      inputSchema: z.object({
        address: z.string(),
        limit: z.number().int().min(1).max(100).default(50),
      }),
    },
    async ({ address, limit }) => {
      try {
        address = validAddress(address);
        const enhanced = await heliusAddressTransactions(address, limit);
        if (enhanced) {
          const swaps = (enhanced as any[]).filter((tx: any) => tx.type === "SWAP");
          return textResult({ address, source: "helius_enhanced", confidence: "high", swaps });
        }
        const sigs = await activity(address, Math.min(limit, 25));
        const rows = [];
        for (const s of sigs ?? []) {
          const tx = await getRawTransaction(s.signature);
          if (!tx) continue;
          const deltas = tokenDeltas(tx, address);
          const nativeDelta = solDelta(tx, address);
          if (deltas.length > 0 && nativeDelta !== null) {
            rows.push({
              signature: s.signature,
              blockTime: s.blockTime,
              tokenDeltas: deltas,
              solDelta: nativeDelta,
              classification: "swap_candidate",
            });
          }
        }
        return textResult({ address, source: "solana_rpc", confidence: "heuristic", swaps: rows });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "transaction",
    {
      title: "Transaction Evidence",
      description: "Fetch a transaction by exact signature with raw parsed Solana evidence and, when available, Helius semantic parsing.",
      inputSchema: z.object({ signature: z.string() }),
    },
    async ({ signature }) => {
      try {
        signature = validSignature(signature);
        const raw = await getRawTransaction(signature);
        const enhanced = await heliusParseTransactions([signature]);
        return textResult({ signature, raw, enhanced: enhanced?.[0] ?? null, sources: enhanced ? ["solana_rpc", "helius_enhanced"] : ["solana_rpc"] });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "wallet_positions",
    {
      title: "Wallet Positions",
      description: "Get current fungible token holdings for a wallet. Helius DAS is preferred; raw SPL token accounts are the fallback.",
      inputSchema: z.object({ address: z.string() }),
    },
    async ({ address }) => {
      try {
        address = validAddress(address);
        return textResult({ address, ...(await walletTokenPositions(address)) });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "token_snapshot",
    {
      title: "Token Snapshot",
      description: "Inspect a Solana mint using on-chain supply/largest-account data and Helius DAS metadata when available. Does not invent market cap or liquidity when unavailable.",
      inputSchema: z.object({ mint: z.string() }),
    },
    async ({ mint }) => {
      try {
        mint = validAddress(mint);
        const [supply, largest, asset] = await Promise.all([
          rpc("getTokenSupply", [mint]),
          rpc("getTokenLargestAccounts", [mint]),
          HELIUS_API_KEY ? heliusDas("getAsset", { id: mint }) : Promise.resolve(null),
        ]);
        return textResult({ mint, supply, largestAccounts: largest, asset, note: "Market cap/liquidity require a market-data provider and are intentionally not inferred from on-chain supply alone." });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "compare_wallets",
    {
      title: "Compare Wallets",
      description: "Compare two wallets around a token mint, retaining exact signatures/timestamps. Useful for source-to-copy delay research. Results are evidence, not attribution unless token and timing align.",
      inputSchema: z.object({
        sourceAddress: z.string(),
        copyAddress: z.string(),
        mint: z.string(),
        limitPerWallet: z.number().int().min(5).max(100).default(50),
      }),
    },
    async ({ sourceAddress, copyAddress, mint, limitPerWallet }) => {
      try {
        sourceAddress = validAddress(sourceAddress);
        copyAddress = validAddress(copyAddress);
        mint = validAddress(mint);
        const collect = async (address: string) => {
          const enhanced = await heliusAddressTransactions(address, limitPerWallet);
          if (enhanced) {
            return (enhanced as any[])
              .filter((tx: any) => JSON.stringify(tx).includes(mint))
              .map((tx: any) => ({ signature: tx.signature, timestamp: tx.timestamp, type: tx.type, source: tx.source, description: tx.description, raw: tx }));
          }
          const sigs = await activity(address, Math.min(limitPerWallet, 30));
          const rows = [];
          for (const s of sigs ?? []) {
            const tx = await getRawTransaction(s.signature);
            if (JSON.stringify(tx).includes(mint)) {
              rows.push({ signature: s.signature, timestamp: s.blockTime, tokenDeltas: tokenDeltas(tx, address), solDelta: solDelta(tx, address) });
            }
          }
          return rows;
        };
        const [sourceRows, copyRows] = await Promise.all([collect(sourceAddress), collect(copyAddress)]);
        const pairs = [];
        for (const s of sourceRows) {
          for (const c of copyRows) {
            if (typeof s.timestamp === "number" && typeof c.timestamp === "number") {
              pairs.push({ sourceSignature: s.signature, copySignature: c.signature, delaySeconds: c.timestamp - s.timestamp });
            }
          }
        }
        pairs.sort((a, b) => Math.abs(a.delaySeconds) - Math.abs(b.delaySeconds));
        return textResult({ sourceAddress, copyAddress, mint, sourceRows, copyRows, closestTimestampPairs: pairs.slice(0, 10), attributionRule: "Do not claim a copy match solely from proximity; verify direction, mint, amounts, and source/copy semantics." });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "scan_watchlist",
    {
      title: "Scan Watchlist",
      description: "Scan multiple exact wallet addresses for recent activity in one call. Designed for recurring source-wallet monitoring.",
      inputSchema: z.object({
        addresses: z.array(z.string()).min(1).max(MAX_WATCHLIST),
        limitPerWallet: z.number().int().min(1).max(25).default(10),
      }),
    },
    async ({ addresses, limitPerWallet }) => {
      try {
        const normalized = addresses.map(validAddress);
        const results = await Promise.all(
          normalized.map(async (address) => ({ address, ...(await parsedActivity(address, limitPerWallet)) })),
        );
        return textResult({ scannedAt: new Date().toISOString(), results });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "classify_trade_for_odin",
    {
      title: "Classify Trade For Odin",
      description: "Evaluate a source transaction against copy-trading rule inputs that can be verified from chain data. Unsupported dimensions are returned as unknown rather than guessed.",
      inputSchema: z.object({
        address: z.string(),
        signature: z.string(),
        rules: z.object({
          minMarketCapUsd: z.number().nonnegative().optional(),
          maxBuysPerDay: z.number().int().positive().optional(),
          onlyNewPositions: z.boolean().optional(),
          pumpFunAllowed: z.boolean().optional(),
        }),
      }),
    },
    async ({ address, signature, rules }) => {
      try {
        address = validAddress(address);
        signature = validSignature(signature);
        const raw = await getRawTransaction(signature);
        if (!raw) throw new Error("Transaction not found");
        const enhanced = await heliusParseTransactions([signature]);
        const semantic = enhanced?.[0] ?? null;
        const deltas = tokenDeltas(raw, address);
        const acquired = deltas.filter((x) => x.delta > 0);
        const disposed = deltas.filter((x) => x.delta < 0);
        const checks = {
          exactWalletPresent: solDelta(raw, address) !== null || deltas.length > 0,
          transactionSucceeded: raw?.meta?.err == null,
          swapClassification: semantic ? semantic.type === "SWAP" : "unknown",
          acquiredTokens: acquired,
          disposedTokens: disposed,
          marketCapRule: rules.minMarketCapUsd === undefined ? "not_requested" : "unknown_requires_market_data_at_entry_time",
          onlyNewPositionRule: rules.onlyNewPositions ? "unknown_requires_pre_entry_position_history" : "not_requested",
          dailyBuyLimitRule: rules.maxBuysPerDay ? "unknown_requires_same_day_trade_reconstruction" : "not_requested",
          pumpFunRule: rules.pumpFunAllowed === undefined ? "not_requested" : semantic ? { requested: rules.pumpFunAllowed, source: semantic.source ?? null } : "unknown_without_semantic_parser",
        };
        return textResult({ address, signature, rules, checks, decision: "partial_only", note: "Shark Scout refuses to guess market cap, prior-position state, or daily eligibility without the required historical/market evidence." });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "wallet_stats",
    {
      title: "Wallet Stats",
      description: "Summarize recent activity cadence and swap counts from a bounded sample. This is not lifetime P&L and is labeled accordingly.",
      inputSchema: z.object({ address: z.string(), limit: z.number().int().min(10).max(100).default(100) }),
    },
    async ({ address, limit }) => {
      try {
        address = validAddress(address);
        const enhanced = await heliusAddressTransactions(address, limit);
        if (enhanced) {
          const txs = enhanced as any[];
          const swaps = txs.filter((x) => x.type === "SWAP");
          const times = txs.map((x) => Number(x.timestamp)).filter(Number.isFinite).sort((a, b) => a - b);
          const spanDays = times.length > 1 ? (times[times.length - 1] - times[0]) / 86400 : 0;
          return textResult({ address, source: "helius_enhanced", sampleSize: txs.length, swapCount: swaps.length, firstTimestamp: times[0] ?? null, lastTimestamp: times.at(-1) ?? null, observedSpanDays: spanDays, swapsPerObservedDay: spanDays > 0 ? swaps.length / spanDays : null, warning: "Sample-window cadence only; not profitability, win rate, or median hold." });
        }
        const sigs = await activity(address, limit);
        const times = (sigs ?? []).map((x: any) => x.blockTime).filter(Number.isFinite).sort((a: number, b: number) => a - b);
        const spanDays = times.length > 1 ? (times[times.length - 1] - times[0]) / 86400 : 0;
        return textResult({ address, source: "solana_rpc", sampleSize: sigs?.length ?? 0, firstTimestamp: times[0] ?? null, lastTimestamp: times.at(-1) ?? null, observedSpanDays: spanDays, warning: "Raw RPC cannot reliably classify all swaps; use Helius for stronger wallet_stats." });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  return server;
}

const app = express();
app.use(express.json({ limit: "2mb" }));
app.disable("x-powered-by");

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "shark-scout-mcp",
    version: "0.1.0",
    readOnly: true,
    heliusConfigured: Boolean(HELIUS_API_KEY),
    rpc: HELIUS_API_KEY && !process.env.SOLANA_RPC_URL ? "helius" : "custom_or_public",
    time: new Date().toISOString(),
  });
});

app.post("/mcp", async (req: Request, res: Response) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    transport.close().catch(() => undefined);
    server.close().catch(() => undefined);
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request failed", error);
    if (!res.headersSent) res.status(500).json({ error: "MCP request failed" });
  }
});

app.get("/mcp", (_req, res) => {
  res.status(405).json({ error: "Use POST for stateless Streamable HTTP MCP" });
});

app.delete("/mcp", (_req, res) => {
  res.status(405).json({ error: "Stateless MCP has no persistent session to delete" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Shark Scout MCP listening on :${PORT}`);
  console.log(`RPC provider: ${HELIUS_API_KEY && !process.env.SOLANA_RPC_URL ? "Helius" : RPC_URL}`);
});
