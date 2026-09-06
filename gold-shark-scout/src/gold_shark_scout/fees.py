from decimal import Decimal, ROUND_CEILING


def kalshi_taker_fee(count: int, price: float) -> float:
    """General Kalshi taker fee: ceil_to_cent(0.07 * C * P * (1-P))."""
    if count <= 0:
        return 0.0
    p = Decimal(str(price))
    c = Decimal(count)
    raw = Decimal("0.07") * c * p * (Decimal("1") - p)
    cents = (raw * 100).to_integral_value(rounding=ROUND_CEILING)
    return float(cents / 100)


def kalshi_maker_fee(count: int, price: float) -> float:
    """General maker formula used by current public Kalshi frameworks.

    Market-specific schedules can differ; production must fetch/verify the applicable fee schedule.
    """
    if count <= 0:
        return 0.0
    p = Decimal(str(price))
    c = Decimal(count)
    raw = Decimal("0.0175") * c * p * (Decimal("1") - p)
    cents = (raw * 100).to_integral_value(rounding=ROUND_CEILING)
    return float(cents / 100)


def taker_fee_per_contract(price: float, batch_size: int = 100) -> float:
    return kalshi_taker_fee(batch_size, price) / batch_size
