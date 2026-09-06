from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Iterator

import httpx


@dataclass(frozen=True)
class PythPrice:
    price: float
    confidence: float
    publish_time: int


class PythHermesClient:
    def __init__(self, api_key: str, feed_id: str, base_url: str = "https://pyth.dourolabs.app/hermes"):
        self.api_key = api_key
        self.feed_id = feed_id.removeprefix("0x")
        self.base_url = base_url.rstrip("/")

    @property
    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.api_key}"}

    @staticmethod
    def _decode(parsed: dict) -> PythPrice:
        px = parsed["price"]
        scale = 10 ** int(px["expo"])
        return PythPrice(int(px["price"]) * scale, int(px["conf"]) * scale, int(px["publish_time"]))

    def latest(self) -> PythPrice:
        url = f"{self.base_url}/v2/updates/price/latest"
        params = [("ids[]", self.feed_id), ("parsed", "true")]
        with httpx.Client(timeout=10.0) as client:
            r = client.get(url, params=params, headers=self.headers)
            r.raise_for_status()
            return self._decode(r.json()["parsed"][0])

    def stream(self) -> Iterator[PythPrice]:
        url = f"{self.base_url}/v2/updates/price/stream"
        params = [("ids[]", self.feed_id), ("parsed", "true")]
        with httpx.Client(timeout=None) as client:
            with client.stream("GET", url, params=params, headers=self.headers) as response:
                response.raise_for_status()
                for line in response.iter_lines():
                    if line and line.startswith("data:"):
                        payload = json.loads(line[5:])
                        if payload.get("parsed"):
                            yield self._decode(payload["parsed"][0])
