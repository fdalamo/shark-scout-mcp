# Shark Scout MCP

Read-only Solana wallet intelligence for ChatGPT / MCP.

Shark Scout is built for evidence-first copy-trading research: exact wallet activity, parsed swaps, transaction evidence, current positions, token snapshots, source-vs-copy comparison, watchlist scans, and partial Odin-rule classification.

## Safety model

- Read-only. No signing, transfers, swaps, key custody, or transaction submission.
- Never store a seed phrase, private key, Odin login, or signing key.
- Keep `HELIUS_API_KEY` in Railway Variables, never in GitHub.
- Missing market/history evidence is returned as `unknown`, not guessed.
- Exact signatures, timestamps, source labels, and parser confidence are preserved wherever possible.

## MCP tools

- `wallet_balance(address)` — current SOL balance.
- `wallet_activity(address, limit, before?)` — recent exact-address activity.
- `wallet_swaps(address, limit)` — Helius SWAP classification when configured; heuristic RPC fallback otherwise.
- `transaction(signature)` — raw parsed transaction plus Helius semantic parse when available.
- `wallet_positions(address)` — current fungible holdings.
- `token_snapshot(mint)` — supply, largest accounts, and DAS metadata when available.
- `compare_wallets(sourceAddress, copyAddress, mint, limitPerWallet)` — evidence for source→copy timing research.
- `scan_watchlist(addresses, limitPerWallet)` — batch recent activity scan.
- `classify_trade_for_odin(address, signature, rules)` — evaluates only rules supported by available evidence; unsupported dimensions remain unknown.
- `wallet_stats(address, limit)` — bounded activity/cadence summary; explicitly not lifetime P&L.

## Environment

Copy `.env.example` locally if needed. For Railway, create Variables instead.

```text
HELIUS_API_KEY=<your secret Helius key>
SOLANA_RPC_URL=
PORT=3000
REQUEST_TIMEOUT_MS=15000
MAX_WATCHLIST=12
```

If `HELIUS_API_KEY` is set and `SOLANA_RPC_URL` is blank, Shark Scout automatically uses Helius mainnet RPC and Helius Enhanced Transactions.

Without Helius it falls back to the public Solana mainnet RPC for core read operations. Some semantic classification becomes heuristic or unavailable.

## Local run

```bash
npm install
npm run build
npm start
```

Health endpoint:

```text
GET /health
```

MCP endpoint:

```text
POST /mcp
```

The MCP server uses stateless Streamable HTTP with JSON responses.

## Railway deployment

1. Create a Railway project from this GitHub repository.
2. Add `HELIUS_API_KEY` under Railway Variables.
3. Deploy. `railway.json` supplies the build, start, and health-check settings.
4. Generate a public Railway domain.
5. Verify `https://<your-domain>/health` returns `ok: true` and `heliusConfigured: true`.
6. In ChatGPT Developer Mode, create a custom MCP app using `https://<your-domain>/mcp`.
7. Scan tools and connect.

## Design goal

The project intentionally separates **evidence** from **inference**. A nearby timestamp alone is not enough to claim a copy. Market cap at entry is not inferred from present supply. If indexing cannot verify activity, the answer should be unknown rather than “no activity.”

Future layers can add historical market-cap/liquidity reconstruction, token age at entry, realized/unrealized P&L, hold-time reconstruction, entry cadence, Odin counterfactual filtering, fee-adjusted capture ratio, and source→copy execution analysis.
