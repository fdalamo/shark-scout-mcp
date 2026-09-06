from __future__ import annotations

import argparse
import json
import math
import time
from datetime import UTC, datetime
from pathlib import Path

from .collector import collect_loop
from .config import Settings
from .edge import EdgePolicy
from .engine import GoldScoutEngine
from .models import MarketSnapshot


def build_policy(s: Settings) -> EdgePolicy:
    return EdgePolicy(
        base_min_net_edge=s.base_min_net_edge,
        min_model_prob=s.min_model_prob,
        max_model_disagreement=s.max_model_disagreement,
        slippage_reserve=s.slippage_reserve,
        model_uncertainty_reserve=s.model_uncertainty_reserve,
        max_stake_usd=s.max_stake_usd,
        max_fractional_kelly=s.max_fractional_kelly,
        min_seconds_to_expiry=s.min_seconds_to_expiry,
        max_seconds_to_expiry=s.max_seconds_to_expiry,
    )


def demo() -> None:
    settings = Settings()
    engine = GoldScoutEngine(build_policy(settings), bankroll=10_000)
    now = time.time()
    base = 4500.0
    for i in range(300):
        px = base * math.exp(0.000018 * math.sin(i / 7) + 0.000002 * i)
        engine.on_underlying(now - (300 - i), px)

    market = MarketSnapshot(
        ticker="KXGOLD15M-DEMO", ts=datetime.now(UTC), seconds_to_expiry=150,
        strike=4500.00, underlying=4503.80,
        yes_bid=0.58, yes_ask=0.60, no_bid=0.39, no_ask=0.41,
    )
    print(json.dumps(engine.evaluate(market).__dict__, indent=2, default=str))


def main() -> None:
    parser = argparse.ArgumentParser(description="Gold Shark Scout")
    parser.add_argument("command", choices=["demo", "collect"], nargs="?", default="demo")
    parser.add_argument("--db", default="data/research.sqlite3")
    parser.add_argument("--interval", type=float, default=1.0)
    args = parser.parse_args()
    if args.command == "demo":
        demo()
    elif args.command == "collect":
        collect_loop(Settings(), Path(args.db), args.interval)


if __name__ == "__main__":
    main()
