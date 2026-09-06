# Shark Scout wallet harvester

`src/harvest.ts` is the persistent Solana wallet-discovery/profile pass for Shark Scout.

## Required API variables

Set real values only in Railway Variables. Never commit keys.

- `HELIUS_API_KEY`
- `BIRDEYE_API_KEY`
- `VYBE_API_KEY`

Solana Tracker is no longer required. Vybe is the secondary trader/PnL provider.

Optional:

- `SOLANA_RPC_URL` — leave blank to use Helius mainnet RPC automatically.

## Persistent state

Mount a Railway Volume at `/data` and set:

- `SCOUT_STATE_PATH=/data/shark-state.json`
- `SCOUT_REPORT_PATH=/data/latest-harvest.json`

The registry keeps exact base58 wallet addresses, first/last seen, rediscovery count, token overlap, provider/lane attribution, tags, screening status, rejection reasons, profile snapshots, run telemetry, and cumulative unique-wallet counts.

## Recommended first-run breadth

- `HARVEST_TOKEN_LIMIT=40`
- `HARVEST_TRADERS_PER_TOKEN=10`
- `HARVEST_GLOBAL_WALLET_LIMIT=50`
- `HARVEST_PROFILE_LIMIT=40`
- `BIRDEYE_MIN_INTERVAL_MS=1100`
- `VYBE_CONCURRENCY=3`

The Birdeye delay deliberately stays below 60 requests/minute. Increase breadth only after checking provider quotas, errors, and runtime.

## Running

Build:

```bash
npm install
npm run build
```

One harvesting cycle:

```bash
npm run harvest
```

For production, use a second Railway service from this same repository with start command `npm run harvest`, scheduled hourly. Keep the browser/MCP API service running with `npm start`.

Railway Volumes attach to a single service. The durable `/data` volume must be attached to the service that actually runs `npm run harvest`. If the current volume is attached to the browser service, move it to the harvester worker when that worker is created.

## Discovery/profile lanes implemented

1. Birdeye 24h trending-token universe.
2. Birdeye token Top Traders ranked by 30-day realized PnL.
3. Vybe `GET /v4/tokens/{mint}/top-pnl-traders`, also ranked by 30-day realized PnL.
4. Exact base58 canonicalization and persistent deduplication.
5. Cross-token recurrence and multi-provider confirmation.
6. Cheap exclusion of executable programs, token accounts, and tagged sniper/bundler/insider/dev/bot/MEV/CEX candidates.
7. Vybe 30-day wallet PnL enrichment.
8. Helius recent enhanced-transaction/SWAP enrichment for prioritized survivors.
9. Retry/backoff and provider-error telemetry instead of silently treating missing data as inactivity.

`latest-harvest.json` includes per-run telemetry, cumulative unique-wallet counts, rejection counts, cross-token recurrence, multi-provider confirmation, provider availability/errors, and the strongest profiled discovery candidates.

## Important qualification

A profitable API profile is not a copy-trading recommendation. Harvest output remains upstream discovery. Promotion to LIVE-TEST WORTHY still requires the downstream Shark Scout forensic stage: raw economic reconstruction, hold-time/downside/jackpot analysis, entry liquidity/market-cap checks, and a 0.075-SOL Odin follower replay including fees, slippage, execution lag and exit transferability.

## Security

This repository is public. Never put API keys in `.env.example`, source, commits, issues, logs, README files, screenshots, or chat. Use Railway Variables only.
