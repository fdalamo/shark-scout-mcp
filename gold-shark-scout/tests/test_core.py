from datetime import UTC, datetime, timedelta

from gold_shark_scout.collector import _market_snapshot, _select_market
from gold_shark_scout.edge import EdgePolicy, choose_signal
from gold_shark_scout.fair_value import ProbabilityInputs, terminal_yes_probability
from gold_shark_scout.fees import kalshi_taker_fee
from gold_shark_scout.models import MarketSnapshot, ModelEstimate, Side


def market() -> MarketSnapshot:
    return MarketSnapshot("TEST", datetime.now(UTC), 120, 4500, 4502, 0.59, 0.60, 0.39, 0.40)


def test_general_fee_at_50c_100_contracts():
    assert kalshi_taker_fee(100, 0.50) == 1.75


def test_tie_is_yes_at_expiry():
    assert terminal_yes_probability(ProbabilityInputs(4500, 4500, 0, 0.1)) == 1.0


def test_small_edge_passes():
    assert choose_signal(market(), [ModelEstimate("m", 0.64, 0.01)], 10000, EdgePolicy()).side == Side.PASS


def test_large_edge_qualifies():
    s = choose_signal(market(), [ModelEstimate("m", 0.78, 0.01)], 10000, EdgePolicy(base_min_net_edge=0.04))
    assert s.side == Side.YES and s.contracts > 0


def test_disagreement_passes():
    s = choose_signal(market(), [ModelEstimate("a", 0.8), ModelEstimate("b", 0.6)], 10000, EdgePolicy())
    assert s.reason == "model-disagreement"


def test_nearest_market_and_dollar_fields():
    now = datetime.now(UTC)
    markets = [{"ticker":"B","close_time":(now+timedelta(minutes=20)).isoformat()}, {"ticker":"A","close_time":(now+timedelta(minutes=5)).isoformat()}]
    assert _select_market(markets, now)["ticker"] == "A"
    m = {"ticker":"A","close_time":(now+timedelta(minutes=2)).isoformat(),"floor_strike":4500,"yes_bid_dollars":"0.5900","yes_ask_dollars":"0.6100","no_bid_dollars":"0.3900","no_ask_dollars":"0.4100"}
    assert _market_snapshot(m, 4502.5, now).yes_ask == 0.61
