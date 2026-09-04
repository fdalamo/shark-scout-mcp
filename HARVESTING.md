# Shark Scout wallet harvester

The repository now includes `src/harvest.ts`, a persistent Solana wallet discovery pass.

## Required API variables

Set these as Railway service variables. Never commit the actual values.

- `HELIUS_API_KEY`
- `BIRDEYE_API_KEY`
- `SOLANA_TRACKER_API_KEY`

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

Increase only after checking provider quotas and runtime.

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

For production, create a second Railway service from this same repository and override its start command to `npm run harvest`. Schedule that service hourly with Railway Cron. Attach the `/data` Volume to that harvester service so cumulative state survives deployments/restarts. Keep the existing browser API service running with `npm start`.

## Discovery lanes implemented

1. Birdeye trending-token discovery.
2. Solana Tracker trending-token discovery.
3. Birdeye token top traders ranked by 30-day realized PnL.
4. Solana Tracker token PnL traders.
5. Solana Tracker global 30-day PnL leaderboard.
6. Cross-token recurrence scoring through the persistent registry.
7. Cheap exclusion of executable programs, token accounts, and tagged sniper/bundler/insider/dev/bot/MEV candidates.
8. Solana Tracker wallet PnL profile enrichment and Helius recent-transaction/SWAP enrichment for the strongest cheap-screen survivors.

The output includes per-run and cumulative telemetry. Full Odin 0.075-SOL copyability/replay remains the downstream Shark Scout forensic stage rather than an automatic promotion from headline PnL.

## Security

This repository is public. Never put API keys in `.env.example`, source, commits, issues, logs, or README files. Use Railway Variables or GitHub Actions Secrets only.
