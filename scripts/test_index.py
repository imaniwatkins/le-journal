#!/usr/bin/env python3
"""Index build: redact account ids, keep overrides, surface no-trade and failed days."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from build_index import build  # noqa: E402
from import_bot_day import to_schema_v2  # noqa: E402
from redact import contains_long_account_token  # noqa: E402


def _write(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj) + "\n")


class IndexTests(unittest.TestCase):
    def _root(self, tmp: Path) -> None:
        _write(
            tmp / "data" / "meta.json",
            {
                "title": "Webull Trading Journal",
                "account_label": "Paper Individual Cash",
                "first_journal_date": "2026-11-12",
                "no_fills_before": "2026-11-12",
            },
        )
        _write(
            tmp / "data" / "sync_status.json",
            {
                "last_successful_sync": "2026-11-13T21:00:00Z",
                "days": {
                    "2026-11-12": {"status": "synced", "message": None},
                    "2026-11-13": {"status": "no_trades", "message": "Flat. No orders."},
                    "2026-11-16": {"status": "failed", "message": "Order history page timed out."},
                    "2026-11-17": {"status": "partial", "message": "Option candles missing."},
                },
            },
        )
        _write(
            tmp / "data" / "overrides" / "edits.json",
            {"schema_version": 1, "days": {"2026-11-12": {"notes": "keep this"}}},
        )

    def test_redact_strips_account_fields_and_long_tokens(self):
        token = "A" * 26
        cleaned = to_schema_v2(
            {
                "date": "2026-11-12",
                "account_id": token,
                "account_label": "Paper Individual Cash",
                "day_pnl": 1,
                "day_pnl_source": f"balance for {token}",
                "trades": [
                    {
                        "underlying": "AMD",
                        "option_type": "CALL",
                        "strike": 1,
                        "expiry": "2026-11-13",
                        "qty_opened": 1,
                        "buy_price": 1,
                        "buy_time_utc": "2026-11-12T15:00:00Z",
                        "order_id_open": "open-1",
                        "multiplier": 100,
                        "exits": [
                            {
                                "qty": 1,
                                "price": 2,
                                "time_utc": "2026-11-12T16:00:00Z",
                                "order_id": "close-1",
                            }
                        ],
                    }
                ],
            }
        )
        self.assertNotIn("account_id", cleaned)
        self.assertFalse(contains_long_account_token(cleaned))
        self.assertIn("[redacted]", cleaned["broker_day_pnl_source"])
        self.assertEqual(cleaned["schema_version"], 2)
        self.assertEqual(len(cleaned["executions"]), 2)

    def test_build_preserves_overrides_and_statuses(self):
        import tempfile

        with tempfile.TemporaryDirectory() as raw:
            tmp = Path(raw)
            self._root(tmp)
            token = "B" * 26
            _write(
                tmp / "data" / "days" / "2026-11-12.json",
                {
                    "schema_version": 2,
                    "date": "2026-11-12",
                    "account_id": token,
                    "broker_day_pnl": 63.68,
                    "broker_day_pnl_source": "account day P&L",
                    "tickers": ["AMD"],
                    "bot_journal": {"grade": "Mixed"},
                    "balance_close": 1063.68,
                    "executions": [
                        {
                            "execution_id": "open",
                            "time_utc": "2026-11-12T19:40:23Z",
                            "side": "buy",
                            "qty": 3,
                            "price": 1.35,
                            "underlying": "AMD",
                            "asset_type": "option",
                            "occ_symbol": "AMD261113C00622500",
                            "option_type": "CALL",
                            "strike": 622.5,
                            "expiry": "2026-11-13",
                            "multiplier": 100,
                            "fees": None,
                        },
                        {
                            "execution_id": "open",
                            "time_utc": "2026-11-12T19:40:23Z",
                            "side": "buy",
                            "qty": 9,
                            "price": 9.99,
                            "underlying": "AMD",
                            "asset_type": "option",
                            "occ_symbol": "AMD261113C00622500",
                            "multiplier": 100,
                        },
                        {
                            "execution_id": "s1",
                            "time_utc": "2026-11-12T19:45:55Z",
                            "side": "sell",
                            "qty": 1,
                            "price": 1.57,
                            "underlying": "AMD",
                            "asset_type": "option",
                            "occ_symbol": "AMD261113C00622500",
                            "multiplier": 100,
                            "fees": None,
                        },
                        {
                            "execution_id": "s2",
                            "time_utc": "2026-11-12T20:00:32Z",
                            "side": "sell",
                            "qty": 2,
                            "price": 1.56,
                            "underlying": "AMD",
                            "asset_type": "option",
                            "occ_symbol": "AMD261113C00622500",
                            "multiplier": 100,
                            "fees": None,
                        },
                    ],
                },
            )
            _write(
                tmp / "data" / "days" / "2026-11-17.json",
                {
                    "schema_version": 2,
                    "date": "2026-11-17",
                    "broker_day_pnl": None,
                    "executions": [
                        {
                            "execution_id": "late",
                            "time_utc": "2026-11-17T15:00:00Z",
                            "side": "buy",
                            "qty": 1,
                            "price": 1.0,
                            "underlying": "QQQ",
                            "asset_type": "option",
                            "occ_symbol": "QQQ261120C00500000",
                            "option_type": "CALL",
                            "strike": 500,
                            "expiry": "2026-11-20",
                            "multiplier": 100,
                            "fees": None,
                        }
                    ],
                },
            )
            before = (tmp / "data" / "overrides" / "edits.json").read_text()
            result = build(tmp)
            self.assertEqual((tmp / "data" / "overrides" / "edits.json").read_text(), before)
            stored = json.loads((tmp / "data" / "days" / "2026-11-12.json").read_text())
            self.assertNotIn("account_id", stored)
            self.assertFalse(contains_long_account_token(stored))
            by_date = {row["date"]: row for row in result["index"]["days"]}
            self.assertEqual(by_date["2026-11-12"]["sync_status"], "synced")
            self.assertEqual(by_date["2026-11-12"]["tile_pnl"], 63.68)
            self.assertEqual(by_date["2026-11-12"]["tile_pnl_source"], "broker_day")
            self.assertEqual(by_date["2026-11-12"]["fifo_realized_pnl"], 64.0)
            self.assertEqual(by_date["2026-11-12"]["completed_trades"], 1)
            self.assertEqual(by_date["2026-11-12"]["wins"], 1)
            self.assertEqual(by_date["2026-11-12"]["open_positions"], 0)
            self.assertEqual(by_date["2026-11-12"]["bot_grade"], "Mixed")
            self.assertEqual(by_date["2026-11-13"]["sync_status"], "no_trades")
            self.assertIsNone(by_date["2026-11-13"]["file"])
            self.assertEqual(by_date["2026-11-16"]["sync_status"], "failed")
            self.assertIn("timed out", by_date["2026-11-16"]["sync_message"])
            self.assertEqual(by_date["2026-11-17"]["sync_status"], "partial")
            self.assertEqual(by_date["2026-11-17"]["open_positions"], 1)
            self.assertEqual(by_date["2026-11-17"]["completed_trades"], 0)
            self.assertEqual(result["book"]["duplicate_executions_dropped"], 1)
            self.assertEqual(len(result["book"]["trades"]), 2)
            notes = json.loads(before)["days"]["2026-11-12"]["notes"]
            self.assertEqual(notes, "keep this")


if __name__ == "__main__":
    unittest.main()
