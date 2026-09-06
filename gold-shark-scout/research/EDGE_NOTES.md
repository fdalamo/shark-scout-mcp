# Gold Shark Scout — Edge Research Notes (2026-09-05)

Public projects reviewed: `reedjacobp/kalshi-trading-bot`, `kapelame/kalshi-crypto-bot`, `spencerfletcher/market-maker`, `zainbacchus/bacchus-mm`, `Rawanalytics/kalshi-bitcoin-ml-trading-system`, `lukeyin08/Order-Flow-Imbalance`, and `nsoxbekdn/microstructure-lab`.

Key lessons carried into v0.1:

- Treat external order flow as a feature, not an automatic signal.
- Separate collector, research model, backtester, paper execution and live execution.
- Use exact exchange arithmetic and executable quotes; paper midpoint fills are not credible.
- Passive spread capture can be dominated by adverse selection.
- Statistically predictive OFI may still be untradeable after spread and fees.
- Log rejected signals as carefully as accepted signals.

Reddit failure modes repeatedly reported for 15-minute Kalshi markets:

- High paper win rates turning negative live because spread, fees and fill quality were omitted.
- Candle/midpoint backtests overstating returns.
- Grid/high-frequency strategies losing through overtrading friction.
- Near-expiry high-probability farming producing many small wins followed by a large reversal loss.
- Order-fill inability making the difference between paper and live outcomes.
- Lead/lag ideas looking promising but remaining unproven without queue, latency and slippage realism.

## v0.1 design decisions

1. Assume taker economics unless maker fills are empirically demonstrated.
2. Hold-to-settlement baseline rather than inventing an exit fill.
3. Minimum net edge after fees + half-spread + slippage + uncertainty.
4. Model disagreement forces PASS.
5. Use the larger of realized and EWMA volatility to reduce false certainty.
6. Fractional Kelly is capped aggressively.
7. No live-order path until forward-paper promotion gates are met.

## Highest-value next experiments

1. Pyth fair-value residual: settlement calibration by fair value versus Kalshi ask.
2. COMEX -> Pyth: conditional next-Pyth movement at 50ms, 100ms, 250ms, 500ms, 1s, 2s and 5s horizons.
3. Pyth -> Kalshi: book repricing delay and edge-decay half-life.
4. Final 180-second empirical tail model to replace Gaussian assumptions where they fail.
5. Kalshi microprice and multi-depth OFI as execution/timing modifiers.
6. Time-of-day regimes: COMEX open, London overlap, US macro release windows, Asia and after-hours.
7. Adverse-selection markouts at +100ms, +500ms, +1s, +5s and +30s after hypothetical fills.
8. Brier score, log loss and reliability bins before ranking models by P&L.
9. Reject signals whose historical edge half-life is shorter than measured p95 order latency.
10. Test $100/$250/$500/$1,000 stake sizes against displayed depth so backtests do not assume impossible fills.
