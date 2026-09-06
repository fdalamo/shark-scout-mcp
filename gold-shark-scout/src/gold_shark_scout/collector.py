from __future__ import annotations

import time
from datetime import UTC, datetime
from pathlib import Path

from .config import Settings
from .edge import EdgePolicy
from .engine import GoldScoutEngine
from .feeds.kalshi import KalshiClient
from .feeds.pyth import PythHermesClient
from .models import MarketSnapshot
from .store import ResearchStore


def _f(x, default=0.0) -> float:
    try:
        return float(x)
    except (TypeError, ValueError):
        return default


def _parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _select_market(markets: list[dict], now: datetime) -> dict | None:
    candidates = []
    for m in markets:
        close = m.get("close_time") or m.get("expected_expiration_time") or m.get("expiration_time")
        if not close:
            continue
        dt = _parse_time(close)
        if dt > now:
            candidates.append((dt, m))
    return min(candidates, key=lambda x: x[0])[1] if candidates else None


def _market_snapshot(m: dict, underlying: float, now: datetime) -> MarketSnapshot:
    close = _parse_time(m.get("close_time") or m["expiration_time"])
    strike = _f(m.get("floor_strike") or m.get("functional_strike"))
    return MarketSnapshot(
        ticker=m["ticker"], ts=now, seconds_to_expiry=max(0.0, (close - now).total_seconds()),
        strike=strike, underlying=underlying,
        yes_bid=_f(m.get("yes_bid_dollars")), yes_ask=_f(m.get("yes_ask_dollars")),
        no_bid=_f(m.get("no_bid_dollars")), no_ask=_f(m.get("no_ask_dollars")),
        yes_bid_size=int(_f(m.get("yes_bid_size_fp"))), yes_ask_size=int(_f(m.get("yes_ask_size_fp"))),
    )


def collect_loop(settings: Settings, db_path: Path, interval_seconds: float = 1.0) -> None:
    if not settings.pyth_api_key or not settings.pyth_gold_feed_id:
        raise RuntimeError("PYTH_API_KEY and PYTH_GOLD_FEED_ID are required for collection")

    kalshi = KalshiClient("https://external-api.kalshi.com/trade-api/v2")
    pyth = PythHermesClient(settings.pyth_api_key, settings.pyth_gold_feed_id)
    policy = EdgePolicy(
        base_min_net_edge=settings.base_min_net_edge,
        min_model_prob=settings.min_model_prob,
        max_model_disagreement=settings.max_model_disagreement,
        slippage_reserve=settings.slippage_reserve,
        model_uncertainty_reserve=settings.model_uncertainty_reserve,
        max_stake_usd=settings.max_stake_usd,
        max_fractional_kelly=settings.max_fractional_kelly,
        min_seconds_to_expiry=settings.min_seconds_to_expiry,
        max_seconds_to_expiry=settings.max_seconds_to_expiry,
    )
    engine = GoldScoutEngine(policy=policy, bankroll=10_000.0)
    store = ResearchStore(db_path)

    while True:
        started = time.monotonic()
        now = datetime.now(UTC)
        px = pyth.latest()
        engine.on_underlying(float(px.publish_time), px.price)
        payload = kalshi.get_markets(series_ticker="KXGOLD15M", limit=100)
        m = _select_market(payload.get("markets", []), now)
        if m:
            snap = _market_snapshot(m, px.price, now)
            store.record_snapshot(snap)
            signal = engine.evaluate(snap)
            store.record_signal(now.isoformat(), snap.ticker, signal)
            print(
                f"{now.isoformat()} {snap.ticker} pyth={snap.underlying:.2f} strike={snap.strike:.2f} "
                f"yes={snap.yes_bid:.3f}/{snap.yes_ask:.3f} signal={signal.side.value} "
                f"net={signal.net_edge:.4f} reason={signal.reason}", flush=True,
            )
        time.sleep(max(0.0, interval_seconds - (time.monotonic() - started)))
