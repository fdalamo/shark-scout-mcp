from __future__ import annotations

from dataclasses import dataclass, field

from .edge import EdgePolicy, choose_signal
from .fair_value import ProbabilityInputs, ReturnBuffer, robust_sigma, terminal_yes_probability
from .models import MarketSnapshot, ModelEstimate, Signal


@dataclass
class GoldScoutEngine:
    policy: EdgePolicy
    bankroll: float = 10_000.0
    returns: ReturnBuffer = field(default_factory=ReturnBuffer)

    def on_underlying(self, ts_seconds: float, price: float) -> None:
        self.returns.add(ts_seconds, price)

    def evaluate(self, market: MarketSnapshot, extra_models: list[ModelEstimate] | None = None) -> Signal:
        sigma = robust_sigma(
            self.returns.realized_sigma_per_sqrt_second(),
            self.returns.ewma_sigma_per_sqrt_second(),
        )
        baseline = terminal_yes_probability(
            ProbabilityInputs(
                spot=market.underlying,
                strike=market.strike,
                seconds_remaining=market.seconds_to_expiry,
                sigma_per_sqrt_second=sigma,
            )
        )
        uncertainty = 0.03 if len(self.returns._prices) < 120 else 0.012
        estimates = [ModelEstimate("terminal-baseline", baseline, uncertainty)]
        if extra_models:
            estimates.extend(extra_models)
        return choose_signal(market, estimates, self.bankroll, self.policy)
