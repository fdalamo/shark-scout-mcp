from __future__ import annotations

import math
from dataclasses import dataclass, field
from statistics import pstdev

import numpy as np
from scipy.stats import norm


@dataclass
class ReturnBuffer:
    maxlen: int = 3600
    _prices: list[tuple[float, float]] = field(default_factory=list)

    def add(self, ts_seconds: float, price: float) -> None:
        if price <= 0:
            return
        self._prices.append((ts_seconds, price))
        if len(self._prices) > self.maxlen:
            del self._prices[: len(self._prices) - self.maxlen]

    def log_returns(self, horizon_seconds: int = 1) -> list[float]:
        if len(self._prices) < 3:
            return []
        values = [p for _, p in self._prices]
        step = max(1, horizon_seconds)
        return [math.log(values[i] / values[i - step]) for i in range(step, len(values))]

    def realized_sigma_per_sqrt_second(self) -> float:
        r = self.log_returns(1)
        return pstdev(r) if len(r) >= 20 else 0.0

    def ewma_sigma_per_sqrt_second(self, lam: float = 0.94) -> float:
        r = self.log_returns(1)
        if len(r) < 20:
            return 0.0
        var = r[0] ** 2
        for x in r[1:]:
            var = lam * var + (1 - lam) * x * x
        return math.sqrt(max(var, 0.0))


@dataclass(frozen=True)
class ProbabilityInputs:
    spot: float
    strike: float
    seconds_remaining: float
    sigma_per_sqrt_second: float
    drift_per_second: float = 0.0
    settlement_tick: float = 0.01


def terminal_yes_probability(x: ProbabilityInputs) -> float:
    """Approximate P(S_T >= K), including a half-tick continuity correction for rounded ties."""
    if x.seconds_remaining <= 0:
        return float(round(x.spot, 2) >= round(x.strike, 2))
    if x.sigma_per_sqrt_second <= 0:
        projected = x.spot * math.exp(x.drift_per_second * x.seconds_remaining)
        return float(round(projected, 2) >= round(x.strike, 2))

    tau = x.seconds_remaining
    effective_strike = max(x.strike - x.settlement_tick / 2.0, 1e-9)
    vol = x.sigma_per_sqrt_second * math.sqrt(tau)
    mean_log = math.log(x.spot) + x.drift_per_second * tau - 0.5 * (x.sigma_per_sqrt_second**2) * tau
    z = (math.log(effective_strike) - mean_log) / vol
    return float(np.clip(1.0 - norm.cdf(z), 0.0, 1.0))


def robust_sigma(realized: float, ewma: float, floor: float = 1e-7) -> float:
    vals = [v for v in (realized, ewma) if v > 0]
    if not vals:
        return floor
    return max(max(vals), floor)
