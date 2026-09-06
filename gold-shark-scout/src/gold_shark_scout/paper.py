from dataclasses import dataclass

from .fees import kalshi_taker_fee
from .models import Side, Signal


@dataclass(frozen=True)
class PaperFill:
    side: Side
    contracts: int
    price: float
    principal: float
    fee: float


@dataclass(frozen=True)
class PaperSettlement:
    pnl: float
    returned: float
    won: bool


def fill_from_signal(signal: Signal) -> PaperFill | None:
    if signal.side == Side.PASS or not signal.entry_price or signal.contracts <= 0:
        return None
    principal = signal.contracts * signal.entry_price
    fee = kalshi_taker_fee(signal.contracts, signal.entry_price)
    return PaperFill(signal.side, signal.contracts, signal.entry_price, principal, fee)


def settle(fill: PaperFill, yes_won: bool) -> PaperSettlement:
    won = (fill.side == Side.YES and yes_won) or (fill.side == Side.NO and not yes_won)
    payout = float(fill.contracts) if won else 0.0
    return PaperSettlement(pnl=payout - fill.principal - fill.fee, returned=payout, won=won)
