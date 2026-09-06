from __future__ import annotations

from dataclasses import dataclass

from .fees import taker_fee_per_contract
from .models import MarketSnapshot, ModelEstimate, Side, Signal


@dataclass(frozen=True)
class EdgePolicy:
    base_min_net_edge: float = 0.06
    min_model_prob: float = 0.55
    max_model_disagreement: float = 0.08
    slippage_reserve: float = 0.005
    model_uncertainty_reserve: float = 0.015
    max_stake_usd: float = 100.0
    max_fractional_kelly: float = 0.10
    min_seconds_to_expiry: int = 20
    max_seconds_to_expiry: int = 600


def fractional_kelly_binary(prob: float, price: float, fraction: float) -> float:
    if not (0 < price < 1) or not (0 <= prob <= 1):
        return 0.0
    b = (1.0 - price) / price
    q = 1.0 - prob
    full = (b * prob - q) / b
    return max(0.0, min(full * fraction, fraction))


def choose_signal(market: MarketSnapshot, estimates: list[ModelEstimate], bankroll: float, policy: EdgePolicy) -> Signal:
    if not estimates:
        return _pass("no-model-estimates")
    if not (policy.min_seconds_to_expiry <= market.seconds_to_expiry <= policy.max_seconds_to_expiry):
        return _pass("outside-time-window")

    ps = [max(0.0, min(1.0, x.p_yes)) for x in estimates]
    weights = [1.0 / max(0.01, x.uncertainty + 0.01) for x in estimates]
    p_yes = sum(p * w for p, w in zip(ps, weights, strict=True)) / sum(weights)
    disagreement = max(ps) - min(ps)
    if disagreement > policy.max_model_disagreement:
        return _pass("model-disagreement", p_yes=p_yes, disagreement=disagreement)

    candidates = [(Side.YES, p_yes, market.yes_ask), (Side.NO, 1.0 - p_yes, market.no_ask)]
    side, prob, price = max(candidates, key=lambda x: x[1] - x[2])
    if prob < policy.min_model_prob or not (0 < price < 1):
        return _pass("insufficient-confidence", p_yes=p_yes, disagreement=disagreement)

    fee_pc = taker_fee_per_contract(price)
    spread = max(0.0, (market.yes_ask - market.yes_bid) if side == Side.YES else (market.no_ask - market.no_bid))
    observable_execution_reserve = min(0.03, spread / 2.0)
    uncertainty = max(policy.model_uncertainty_reserve, max(x.uncertainty for x in estimates))
    friction = fee_pc + policy.slippage_reserve + observable_execution_reserve + uncertainty
    gross_edge = prob - price
    net_edge = gross_edge - friction
    dynamic_threshold = max(policy.base_min_net_edge, 1.5 * spread)

    if net_edge < dynamic_threshold:
        return Signal(Side.PASS, prob, price, gross_edge, net_edge, fee_pc, friction, disagreement, f"edge-below-threshold:{dynamic_threshold:.4f}")

    kelly = fractional_kelly_binary(prob, price, policy.max_fractional_kelly)
    stake = min(policy.max_stake_usd, bankroll * kelly)
    contracts = int(stake / price)
    if contracts < 1:
        return _pass("stake-too-small", p_yes=p_yes, disagreement=disagreement)

    return Signal(side, prob, price, gross_edge, net_edge, fee_pc, friction, disagreement, "qualified", contracts, contracts * price)


def _pass(reason: str, p_yes: float = 0.0, disagreement: float = 0.0) -> Signal:
    return Signal(Side.PASS, p_yes, None, 0.0, 0.0, 0.0, 0.0, disagreement, reason)
