from __future__ import annotations

import json
import sqlite3
from dataclasses import asdict
from pathlib import Path

from .models import MarketSnapshot, Signal


class ResearchStore:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=NORMAL")
        self.db.executescript(
            """
            CREATE TABLE IF NOT EXISTS snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts TEXT NOT NULL,
                ticker TEXT NOT NULL,
                seconds_to_expiry REAL NOT NULL,
                strike REAL NOT NULL,
                underlying REAL NOT NULL,
                yes_bid REAL NOT NULL,
                yes_ask REAL NOT NULL,
                no_bid REAL NOT NULL,
                no_ask REAL NOT NULL,
                payload_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_snapshots_ticker_ts ON snapshots(ticker, ts);
            CREATE TABLE IF NOT EXISTS signals (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts TEXT NOT NULL,
                ticker TEXT NOT NULL,
                side TEXT NOT NULL,
                model_probability REAL NOT NULL,
                entry_price REAL,
                gross_edge REAL NOT NULL,
                net_edge REAL NOT NULL,
                fee_per_contract REAL NOT NULL,
                friction_reserve REAL NOT NULL,
                disagreement REAL NOT NULL,
                reason TEXT NOT NULL,
                contracts INTEGER NOT NULL,
                stake_usd REAL NOT NULL,
                payload_json TEXT NOT NULL
            );
            """
        )
        self.db.commit()

    def record_snapshot(self, s: MarketSnapshot) -> None:
        payload = asdict(s)
        payload["ts"] = s.ts.isoformat()
        self.db.execute(
            """INSERT INTO snapshots
            (ts,ticker,seconds_to_expiry,strike,underlying,yes_bid,yes_ask,no_bid,no_ask,payload_json)
            VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (s.ts.isoformat(), s.ticker, s.seconds_to_expiry, s.strike, s.underlying,
             s.yes_bid, s.yes_ask, s.no_bid, s.no_ask, json.dumps(payload, default=str)),
        )
        self.db.commit()

    def record_signal(self, ts: str, ticker: str, signal: Signal) -> None:
        payload = asdict(signal)
        payload["side"] = signal.side.value
        self.db.execute(
            """INSERT INTO signals
            (ts,ticker,side,model_probability,entry_price,gross_edge,net_edge,fee_per_contract,
             friction_reserve,disagreement,reason,contracts,stake_usd,payload_json)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (ts, ticker, signal.side.value, signal.model_probability, signal.entry_price,
             signal.gross_edge, signal.net_edge, signal.fee_per_contract, signal.friction_reserve,
             signal.disagreement, signal.reason, signal.contracts, signal.stake_usd,
             json.dumps(payload, default=str)),
        )
        self.db.commit()
