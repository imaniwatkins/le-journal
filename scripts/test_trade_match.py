#!/usr/bin/env python3
"""Fixtures for partials, adds, open positions, fees, and idempotent imports."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from trade_match import (  # noqa: E402
    completed_on_session,
    dedupe_executions,
    match_executions,
    open_on_session,
    realized_on_session,
)


def opt(eid, time, side, qty, price, **extra):
    row = {
        "execution_id": eid,
        "order_id": eid,
        "time_utc": time,
        "side": side,
        "qty": qty,
        "price": price,
        "underlying": "AMD",
        "asset_type": "option",
        "occ_symbol": "AMD261113C00622500",
        "option_type": "CALL",
        "strike": 622.5,
        "expiry": "2026-11-13",
        "multiplier": 100,
        "fees": None,
        "realized_pnl": None,
    }
    row.update(extra)
    return row


class MatchTests(unittest.TestCase):
    def test_nov12_partial_exits_are_one_winner(self):
        fills = [
            opt("open", "2026-11-12T19:40:23.713Z", "buy", 3, 1.35),
            opt("s1", "2026-11-12T19:45:55.198Z", "sell", 1, 1.57),
            opt("s2", "2026-11-12T20:00:32.572Z", "sell", 2, 1.56),
        ]
        book = match_executions(fills)
        self.assertEqual(len(book["trades"]), 1)
        self.assertEqual(book["open_positions"], [])
        trade = book["trades"][0]
        self.assertEqual(trade["status"], "closed")
        self.assertEqual(trade["outcome"], "win")
        self.assertEqual(trade["gross_pnl"], 64.0)
        self.assertEqual(trade["realized_pnl"], 64.0)
        self.assertEqual(trade["pnl_source"], "fifo")
        self.assertFalse(trade["fees_known"])
        self.assertIsNone(trade["fees"])
        self.assertEqual(trade["fees_treatment"], "unknown")
        self.assertEqual(trade["qty_opened"], 3)
        self.assertEqual(trade["qty_closed"], 3)
        self.assertEqual(trade["qty_open"], 0)
        self.assertEqual(trade["avg_entry"], 1.35)
        self.assertEqual(trade["partial_exit_count"], 1)
        self.assertAlmostEqual(trade["avg_exit"], 1.563333, places=5)
        self.assertAlmostEqual(trade["pnl_pct"], 15.8025, places=3)
        self.assertEqual(trade["legs"][1]["effect"], "partial_exit")
        self.assertEqual(trade["legs"][1]["realized_pnl"], 22.0)
        self.assertEqual(trade["legs"][2]["effect"], "close")
        self.assertEqual(trade["legs"][2]["realized_pnl"], 42.0)
        self.assertEqual(len(completed_on_session(book["trades"], "2026-11-12")), 1)
        self.assertEqual(realized_on_session(book["trades"], "2026-11-12"), 64.0)

    def test_adds_then_one_exit(self):
        fills = [
            opt("a", "2026-11-12T15:00:00Z", "buy", 1, 1.00),
            opt("b", "2026-11-12T15:10:00Z", "buy", 2, 1.30),
            opt("c", "2026-11-12T15:40:00Z", "sell", 3, 1.50),
        ]
        trade = match_executions(fills)["trades"][0]
        self.assertEqual(trade["add_count"], 1)
        self.assertEqual(trade["avg_entry"], 1.2)
        self.assertEqual(trade["gross_pnl"], 90.0)
        self.assertEqual(trade["outcome"], "win")
        self.assertEqual(len(match_executions(fills)["trades"]), 1)

    def test_two_round_trips_same_contract(self):
        fills = [
            opt("a", "2026-11-12T15:00:00Z", "buy", 1, 1.00),
            opt("b", "2026-11-12T15:05:00Z", "sell", 1, 2.00),
            opt("c", "2026-11-12T16:00:00Z", "buy", 1, 3.00),
            opt("d", "2026-11-12T16:05:00Z", "sell", 1, 2.50),
        ]
        trades = match_executions(fills)["trades"]
        self.assertEqual(len(trades), 2)
        self.assertEqual([t["outcome"] for t in trades], ["win", "loss"])
        self.assertEqual(trades[0]["realized_pnl"], 100.0)
        self.assertEqual(trades[1]["realized_pnl"], -50.0)
        self.assertNotEqual(trades[0]["trade_id"], trades[1]["trade_id"])

    def test_open_position_is_not_a_win(self):
        book = match_executions([opt("a", "2026-11-12T15:00:00Z", "buy", 3, 1.35)])
        trade = book["trades"][0]
        self.assertEqual(trade["status"], "open")
        self.assertIsNone(trade["outcome"])
        self.assertEqual(trade["realized_pnl"], 0.0)
        self.assertEqual(trade["qty_open"], 3)
        self.assertEqual(len(book["open_positions"]), 1)
        self.assertEqual(completed_on_session(book["trades"], "2026-11-12"), [])
        self.assertEqual(len(open_on_session(book["trades"], "2026-11-12")), 1)

    def test_partial_exit_leaves_the_trade_open(self):
        fills = [
            opt("a", "2026-11-12T15:00:00Z", "buy", 3, 1.35),
            opt("b", "2026-11-12T15:10:00Z", "sell", 1, 1.57),
        ]
        trade = match_executions(fills)["trades"][0]
        self.assertEqual(trade["status"], "open")
        self.assertIsNone(trade["outcome"])
        self.assertEqual(trade["realized_pnl"], 22.0)
        self.assertEqual(trade["qty_open"], 2)
        self.assertEqual(realized_on_session([trade], "2026-11-12"), 22.0)
        self.assertEqual(completed_on_session([trade], "2026-11-12"), [])

    def test_position_open_across_sessions(self):
        fills = [
            opt("a", "2026-11-12T20:00:00Z", "buy", 2, 1.00),
            opt("b", "2026-11-13T15:00:00Z", "sell", 2, 1.40),
        ]
        trades = match_executions(fills)["trades"]
        self.assertEqual(trades[0]["session_open"], "2026-11-12")
        self.assertEqual(trades[0]["session_close"], "2026-11-13")
        self.assertEqual(len(open_on_session(trades, "2026-11-12")), 1)
        self.assertEqual(completed_on_session(trades, "2026-11-12"), [])
        self.assertEqual(realized_on_session(trades, "2026-11-12"), 0.0)
        self.assertEqual(len(completed_on_session(trades, "2026-11-13")), 1)
        self.assertEqual(realized_on_session(trades, "2026-11-13"), 80.0)
        self.assertEqual(open_on_session(trades, "2026-11-13"), [])

    def test_reimport_does_not_double_fills(self):
        fills = [
            opt("open", "2026-11-12T19:40:23Z", "buy", 3, 1.35),
            opt("s1", "2026-11-12T19:45:55Z", "sell", 1, 1.57),
            opt("s2", "2026-11-12T20:00:32Z", "sell", 2, 1.56),
        ]
        doubled = fills + [dict(fills[0], qty=9), dict(fills[1]), dict(fills[2])]
        self.assertEqual(len(dedupe_executions(doubled)), 3)
        once = match_executions(fills)["trades"][0]
        twice = match_executions(doubled)["trades"][0]
        self.assertEqual(once["qty_opened"], twice["qty_opened"])
        self.assertEqual(once["realized_pnl"], twice["realized_pnl"])
        self.assertEqual(once["trade_id"], twice["trade_id"])
        self.assertEqual(len(match_executions(doubled)["trades"]), 1)

    def test_broker_realized_wins_over_fifo(self):
        fills = [
            opt("a", "2026-11-12T15:00:00Z", "buy", 1, 1.00, fees=0.10),
            opt("b", "2026-11-12T15:05:00Z", "sell", 1, 2.00, fees=0.10, realized_pnl=20.0),
        ]
        trade = match_executions(fills)["trades"][0]
        self.assertEqual(trade["pnl_source"], "broker")
        self.assertEqual(trade["realized_pnl"], 20.0)
        self.assertEqual(trade["fees"], 0.2)
        self.assertEqual(trade["fees_treatment"], "broker_figure")
        self.assertEqual(trade["outcome"], "win")

    def test_fees_subtracted_only_when_itemized(self):
        fills = [
            opt("a", "2026-11-12T15:00:00Z", "buy", 1, 1.00, fees=0.20),
            opt("b", "2026-11-12T15:05:00Z", "sell", 1, 1.10, fees=0.12),
        ]
        trade = match_executions(fills)["trades"][0]
        # Gross = 10. Fees = 0.32. Realized = 9.68.
        self.assertEqual(trade["gross_pnl"], 10.0)
        self.assertEqual(trade["fees"], 0.32)
        self.assertEqual(trade["realized_pnl"], 9.68)
        self.assertEqual(trade["fees_treatment"], "subtracted")
        self.assertTrue(trade["fees_known"])

    def test_short_option(self):
        fills = [
            opt("a", "2026-11-12T15:00:00Z", "sell", 1, 2.00),
            opt("b", "2026-11-12T15:20:00Z", "buy", 1, 1.00),
        ]
        trade = match_executions(fills)["trades"][0]
        self.assertEqual(trade["direction"], "short")
        self.assertEqual(trade["realized_pnl"], 100.0)
        self.assertEqual(trade["outcome"], "win")

    def test_stock_multiplier_is_one(self):
        fills = [
            {
                "execution_id": "b",
                "time_utc": "2026-11-12T15:00:00Z",
                "side": "buy",
                "qty": 10,
                "price": 100.0,
                "underlying": "AMD",
                "asset_type": "stock",
                "fees": None,
            },
            {
                "execution_id": "s",
                "time_utc": "2026-11-12T16:00:00Z",
                "side": "sell",
                "qty": 10,
                "price": 101.5,
                "underlying": "AMD",
                "asset_type": "stock",
                "fees": None,
            },
        ]
        trade = match_executions(fills)["trades"][0]
        self.assertEqual(trade["multiplier"], 1)
        self.assertEqual(trade["realized_pnl"], 15.0)

    def test_breakeven_is_not_a_win(self):
        fills = [
            opt("a", "2026-11-12T15:00:00Z", "buy", 1, 1.00),
            opt("b", "2026-11-12T15:05:00Z", "sell", 1, 1.00),
        ]
        trade = match_executions(fills)["trades"][0]
        self.assertEqual(trade["outcome"], "breakeven")
        self.assertEqual(trade["realized_pnl"], 0.0)


if __name__ == "__main__":
    unittest.main()
