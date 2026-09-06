from __future__ import annotations

import base64
import time
from pathlib import Path
from urllib.parse import urlparse

import httpx
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding


class KalshiClient:
    def __init__(self, base_url: str, key_id: str | None = None, private_key_path: Path | None = None):
        self.base_url = base_url.rstrip("/")
        self.key_id = key_id
        self.private_key_path = private_key_path
        self._private_key = None

    def _load_key(self):
        if self._private_key is None:
            if not self.private_key_path:
                raise RuntimeError("Kalshi private key path is not configured")
            self._private_key = serialization.load_pem_private_key(self.private_key_path.read_bytes(), password=None)
        return self._private_key

    def _auth_headers(self, method: str, path: str) -> dict[str, str]:
        if not self.key_id:
            raise RuntimeError("Kalshi API key ID is not configured")
        ts = str(int(time.time() * 1000))
        clean_path = urlparse(path).path
        message = (ts + method.upper() + clean_path).encode()
        signature = self._load_key().sign(
            message,
            padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=padding.PSS.DIGEST_LENGTH),
            hashes.SHA256(),
        )
        return {
            "KALSHI-ACCESS-KEY": self.key_id,
            "KALSHI-ACCESS-TIMESTAMP": ts,
            "KALSHI-ACCESS-SIGNATURE": base64.b64encode(signature).decode(),
        }

    def get_markets(self, series_ticker: str = "KXGOLD15M", limit: int = 100) -> dict:
        with httpx.Client(timeout=10.0) as client:
            r = client.get(self.base_url + "/markets", params={"series_ticker": series_ticker, "limit": limit, "status": "open"})
            r.raise_for_status()
            return r.json()

    def get_orderbook(self, ticker: str, depth: int = 10) -> dict:
        with httpx.Client(timeout=10.0) as client:
            r = client.get(self.base_url + f"/markets/{ticker}/orderbook", params={"depth": depth})
            r.raise_for_status()
            return r.json()
