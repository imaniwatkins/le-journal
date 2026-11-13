#!/usr/bin/env python3
"""Turn one legacy builder JSON file into schema v2 for data/days/.

The legacy file is the read-only session builder output (one object, trades,
charts, lessons). This script does not call a broker. It strips account ids,
keeps the raw fills as executions, and groups them with trade_match.

    python3 scripts/import_bot_day.py --in legacy.json --out data/days/YYYY-MM-DD.json
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from redact import redact
from trade_match import match_executions


def _occ(day: dict[str, Any]) -> str | None:
    charts = day.get("charts") or {}
    for key in ("option_5m", "option"):
        block = charts.get(key) or {}
        if block.get("symbol"):
            return block["symbol"]
    return None


def executions_from_legacy(day: dict[str, Any]) -> list[dict[str, Any]]:
    if day.get("schema_version") == 2 and day.get("executions"):
        return list(day["executions"])
    occ = _occ(day)
    out = []
    for trade in day.get("trades") or []:
        contract = trade.get("contract")
        common = {
            "underlying": trade.get("underlying"),
            "asset_type": "option" if trade.get("option_type") else "stock",
            "occ_symbol": trade.get("occ_symbol") or occ,
            "option_type": trade.get("option_type"),
            "strike": trade.get("strike"),
            "expiry": trade.get("expiry"),
            "contract": contract,
            "multiplier": trade.get("multiplier") if trade.get("multiplier") is not None else 100,
            "fees": None,
            "realized_pnl": None,
        }
        out.append(
            {
                **common,
                "execution_id": trade["order_id_open"],
                "order_id": trade["order_id_open"],
                "time_utc": trade["buy_time_utc"],
                "side": "buy",
                "position_effect": "open",
                "qty": trade["qty_opened"],
                "price": trade["buy_price"],
                "limit_price": trade.get("buy_limit"),
            }
        )
        for exit_fill in trade.get("exits") or []:
            out.append(
                {
                    **common,
                    "execution_id": exit_fill["order_id"],
                    "order_id": exit_fill["order_id"],
                    "time_utc": exit_fill["time_utc"],
                    "side": "sell",
                    "position_effect": "close",
                    "qty": exit_fill["qty"],
                    "price": exit_fill["price"],
                    "limit_price": exit_fill.get("limit_price"),
                }
            )
    return out


def _charts(day: dict[str, Any]) -> dict[str, Any]:
    charts = day.get("charts") or {}
    kept: dict[str, Any] = {}
    if charts.get("underlying"):
        kept["underlying"] = charts["underlying"]
    if charts.get("option_5m"):
        kept["option_5m"] = charts["option_5m"]
    elif charts.get("option"):
        # The page charts 5-minute option candles. Keep 1-minute only when no 5-minute rollup exists.
        kept["option"] = charts["option"]
    return kept


def _slim_trade(trade: dict[str, Any]) -> dict[str, Any]:
    keep = [
        "underlying",
        "option_type",
        "strike",
        "expiry",
        "contract",
        "qty_opened",
        "qty_closed",
        "buy_price",
        "buy_limit",
        "buy_time_utc",
        "buy_time_pt",
        "multiplier",
        "exits",
        "cost",
        "gross_pnl",
        "return_on_premium_pct",
        "dte_at_entry",
        "is_0dte",
        "underlying_at_entry",
        "strike_distance",
        "le",
        "grade",
        "rules_followed",
        "rules_broken",
        "rules_unverified",
        "size_pct_of_account",
        "size_note",
        "had_stop_on_open",
        "runner_left",
    ]
    return {key: trade.get(key) for key in keep if key in trade}


def to_schema_v2(day: dict[str, Any]) -> dict[str, Any]:
    cleaned = redact(day)
    if cleaned.get("schema_version") == 2 and cleaned.get("executions"):
        executions = cleaned["executions"]
    else:
        executions = executions_from_legacy(cleaned)
    matched = match_executions(executions)
    broker = cleaned.get("broker_day_pnl")
    if broker is None:
        broker = cleaned.get("day_pnl")
    source = cleaned.get("broker_day_pnl_source") or cleaned.get("day_pnl_source")
    bot_trades = cleaned.get("bot_journal", {}).get("trades")
    if bot_trades is None:
        bot_trades = [_slim_trade(trade) for trade in cleaned.get("trades") or []]
    le_day = cleaned.get("le_day") or (cleaned.get("bot_journal") or {}).get("le_day")
    return {
        "schema_version": 2,
        "date": cleaned["date"],
        "session_timezone": "America/New_York",
        "recorded_timezone": cleaned.get("timezone") or "America/Los_Angeles",
        "account_label": cleaned.get("account_label"),
        "as_of_pt": cleaned.get("as_of_pt"),
        "as_of_note": cleaned.get("as_of_note"),
        "balance_close": cleaned.get("balance_close"),
        "cash_close": cleaned.get("cash_close"),
        "starting_cash": cleaned.get("starting_cash"),
        "starting_cash_source": cleaned.get("starting_cash_source"),
        "broker_day_pnl": broker,
        "broker_day_pnl_source": source,
        "fees_from_api": cleaned.get("fees_from_api"),
        "implied_fees_note": (
            "A difference between account day P&L and FIFO gross is not treated as a fee "
            "unless the broker itemized it."
        ),
        "tickers": cleaned.get("tickers") or [],
        "bot_journal": {
            "origin": "imported_session_builder",
            "grade": cleaned.get("grade") or (cleaned.get("bot_journal") or {}).get("grade"),
            "lessons": cleaned.get("lessons") or (cleaned.get("bot_journal") or {}).get("lessons") or [],
            "notes": cleaned.get("notes") if cleaned.get("notes") is not None else (cleaned.get("bot_journal") or {}).get("notes"),
            "le_day": le_day,
            "trades": bot_trades,
            "caveat": (
                "Imported builder text can mention thresholds that were never published. "
                "Those sentences are history, not journal rules. B and D criteria stay unconfirmed."
            ),
        },
        "executions": executions,
        "open_positions_eod": matched["open_positions"],
        "charts": _charts(cleaned),
        "filled_order_count": cleaned.get("filled_order_count") or len(executions),
        "stop_orders_in_history": cleaned.get("stop_orders_in_history"),
        "vix": cleaned.get("vix"),
        "gap_down": cleaned.get("gap_down"),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Import one legacy or v2 day file into schema v2.")
    parser.add_argument("--in", dest="src", required=True)
    parser.add_argument("--out", dest="dest", required=True)
    args = parser.parse_args()
    day = json.loads(Path(args.src).read_text())
    out = to_schema_v2(day)
    dest = Path(args.dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(out, indent=2) + "\n")
    print(f"wrote {dest} executions={len(out['executions'])}")


if __name__ == "__main__":
    main()
