from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    kalshi_env: str = "demo"
    kalshi_api_key_id: str | None = None
    kalshi_private_key_path: Path | None = None
    pyth_api_key: str | None = None
    pyth_gold_feed_id: str | None = None

    base_min_net_edge: float = 0.06
    min_model_prob: float = 0.55
    max_model_disagreement: float = 0.08
    slippage_reserve: float = 0.005
    model_uncertainty_reserve: float = 0.015
    max_stake_usd: float = 100.0
    max_fractional_kelly: float = 0.10
    min_seconds_to_expiry: int = 20
    max_seconds_to_expiry: int = 600
    allow_live_trading: bool = False

    @property
    def kalshi_base_url(self) -> str:
        if self.kalshi_env.lower() == "prod":
            return "https://api.elections.kalshi.com/trade-api/v2"
        return "https://demo-api.kalshi.co/trade-api/v2"
