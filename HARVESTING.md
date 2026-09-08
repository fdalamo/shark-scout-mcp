# Shark Scout wallet harvester

`src/harvest_scout.ts` orchestrates discovery and `src/harvest_ultra.ts` performs the persistent Solana wallet screening/profile pass for Shark Scout.

## Required API variables

Set real values only in Railway Variables. Never commit keys.

- `HELIUS_API_KEY`
- `DUNE_API_KEY` when Dune discovery is enabled
- `BIRDEYE_API_KEY` only for endpoints available to the connected tier
- `CIELO_API_KEY` only for endpoints available to the connected tier

Optional:

- `SOLANA_RPC_URL` — leave blank to use the configured Helius mainnet RPC automatically.

Provider access is treated as capability-gated. A disabled, unavailable, or plan-restricted provider is not silently replaced with fabricated data and is not treated as proof of inactivity.

## Persistent state

Mount the Railway Volume at `/data` and keep durable paths there, including:

- `SCOUT_STATE_PATH=/data/shark-state.json`
- `SCOUT_REPORT_PATH=/data/latest-harvest.json`
- `SCOUT_HELIUS_CACHE_DIR=/data/helius-cache`
- `SCOUT_DUNE_CACHE_PATH=/data/dune-source-cache.json`
- `SCOUT_HARVEST_MARKER_PATH=/data/harvest-marker-state.json`

The registry keeps exact base58 wallet addresses, first/last seen, rediscovery count, token overlap, provider/lane attribution, tags, screening status, rejection reasons, profile snapshots, run telemetry, and cumulative unique-wallet counts.

## Evidence-tier backlog router

The profile queue is deliberately not a flat TTL queue. Refresh frequency is based on information value so the free API budget is spent on wallets most likely to improve downstream Odin evidence.

Default production tiers:

- `NEW`: never profiled; always due and highest priority.
- `HOT`: cross-token, multi-provider, repeated rediscovery, Dune/Cielo quality, or other strong convergence; refresh on `HARVEST_PROFILE_STALE_MINUTES` (currently the hot/base TTL).
- `WARM`: recently active or independently rediscovered but without hot convergence; refresh on `HARVEST_PROFILE_WARM_MINUTES`.
- `UNKNOWN`: prior Helius profile unavailable; retry on `HARVEST_PROFILE_UNKNOWN_MINUTES`.
- `COLD`: ordinary previously profiled wallets without current convergence; refresh on `HARVEST_PROFILE_COLD_MINUTES`.

Production defaults are 3h HOT, 12h WARM, 6h UNKNOWN, and 24h COLD. The hourly `HARVEST_PROFILE_LIMIT` remains a hard request budget; the router changes which wallets receive those calls rather than increasing paid-provider spend.

Within each tier, overdue ratio and discovery score determine order. Dune/Cielo/Birdeye evidence is therefore shared with Helius scheduling: cheap/bulk discovery evidence promotes a wallet into a faster refresh lane, while Helius is reserved for deeper transaction profiling. Canonical replay and promotion standards are unchanged.

Each Harvest report emits:

- due-before total and per-tier breakdown
- selected count and per-tier allocation
- due-after total and per-tier breakdown
- net due delta
- RPC entity checks
- Helius profile requests
- approximate Birdeye discovery calls
- cache writes/rows/prunes
- provider errors

This makes backlog movement measurable without pretending that a longer TTL is a completed profile.

## Dune usage under free-plan restrictions

Shark Scout reuses the latest results of configured public/accessible Dune queries and only performs a full result fetch when the query execution id changes. It does not repeatedly execute expensive SQL merely to refresh the queue. Dune evidence is used for discovery/triage and refresh priority, not as canonical follower proof.

A dedicated dynamically-created backlog query is intentionally not required by production because Dune query-management/create endpoints can require a higher plan. If a pre-existing accessible parameterized query is later supplied, it can be added as another triage lane without changing the Helius/canonical promotion contract.

## Discovery/profile lanes implemented

1. Dune curated discovery/results with persistent execution-aware caching.
2. Cielo discovery/tag enrichment only where the connected plan allows it.
3. Birdeye token-winner/top-trader discovery only where enabled and available.
4. Exact base58 canonicalization and persistent deduplication.
5. Cross-token recurrence and multi-provider convergence.
6. Cheap exclusion of executable programs, token accounts, and tagged sniper/bundler/insider/dev/bot/MEV/CEX candidates.
7. Evidence-tier queue routing.
8. Helius recent transaction/SWAP enrichment for prioritized survivors.
9. Retry/backoff, compact per-wallet caching, and provider-error telemetry instead of silently treating missing data as inactivity.
10. Downstream canonical reconstruction, Replay Shadow, Paper Odin, Dip Shadow, cap audit and Evidence Funnel determine transferability.

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

Production uses the Railway worker with start command `npm run harvest` and an hourly cron. The durable `/data` volume must remain attached to the worker.

## Important qualification

A profitable API profile is not a copy-trading recommendation. Harvest output remains upstream discovery. Promotion still requires raw economic reconstruction, hold/downside/jackpot analysis, entry liquidity/market-cap checks, and the 0.075-SOL Odin follower replay including fees, slippage, execution lag and exit transferability. Source PnL does not override failed follower economics.

## Security

This repository is public. Never put API keys in `.env.example`, source, commits, issues, logs, README files, screenshots, or chat. Use Railway Variables only.
