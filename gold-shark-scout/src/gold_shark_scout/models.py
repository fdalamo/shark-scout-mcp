from dataclasses import dataclass
from datetime import datetime
from enum import Enum


class Side(str, Enum):
    YES = "yes"
    NO = "no"
    PASS = "pass"


@dataclass(frozen=True)
class MarketSnapshot:
    ticker: str
    ts: datetime
    seconds_to_expiry: float
    strike: float
    underlying: float
    yes_bid: float
    yes_ask: float
    no_bid: float
    no_ask: float
    yes_bid_size: int = 0
    yes_ask_size: int = 0
    no_bid_size: int = 0
    no_ask_size: int = 0


@dataclass(frozen=True)
class ModelEstimate:
    name: str
    p_yes: float
    uncertainty: float = 0.0


@dataclass(frozen=True)
class Signal:
    side: Side
    model_probability: float
    entry_price: float | None
    gross_edge: float
    net_edge: float
    fee_per_contract: float
    friction_reserve: float
    disagreement: float
    reason: str
    contracts: int = 0
    stake_usd: float = 0.0
