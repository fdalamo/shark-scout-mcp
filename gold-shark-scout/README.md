# Gold Shark Scout

Research-first fair-value and paper-trading engine for Kalshi `KXGOLD15M`.

**v0.1 is deliberately paper/research only.** It is designed to prove an out-of-sample edge using executable prices, fees, spread, slippage and model uncertainty before live order placement is added.

## Core idea

Gold Scout estimates the true probability of YES, compares it with Kalshi's executable ask, then subtracts trading friction and an uncertainty reserve. It trades only when the **net** modeled edge clears a conservative threshold.

## Safeguards

- Uses executable ask, never midpoint.
- Models Kalshi taker fees with aggregate cent-rounding.
- Reserves for half-spread, slippage and model uncertainty.
- Model disagreement forces PASS.
- Conservative fractional Kelly plus hard dollar cap.
- Time-to-expiry gate.
- Paper positions are evaluated to settlement rather than assuming an easy exit.
- Live trading is not implemented in v0.1.

## Baseline probability model

The first model is a short-horizon digital/terminal probability using one-second realized volatility and EWMA volatility; the larger estimate is used to reduce overconfidence during volatility expansion. A half-tick continuity correction approximates two-decimal settlement and tie-to-YES behavior.

Planned ensemble members: empirical conditional frequency, residual ML (`outcome - Kalshi probability`), COMEX GC lead/lag, Kalshi microprice/OFI and edge-decay/latency models.

## Install

```bash
cd gold-shark-scout
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env
pytest -q
gold-scout demo
```

## Collect live research data

Set `PYTH_API_KEY` and `PYTH_GOLD_FEED_ID`, then:

```bash
gold-scout collect --db data/research.sqlite3 --interval 1
```

Kalshi market data is read from the public production endpoint. Pyth Hermes supplies the underlying oracle. Every snapshot and every PASS/YES/NO decision is stored so rejected trades remain part of the dataset.

## Promotion gates before live money

Require chronological executable-price backtests, applicable fees, pessimistic slippage, walk-forward validation, hundreds of forward paper signals, calibration tests, positive expectancy with uncertainty bounds, stable regime performance, drawdown testing, and proof that the measured edge survives realistic order-arrival latency.

See `research/EDGE_NOTES.md` for the public-project and Reddit research behind the design.
