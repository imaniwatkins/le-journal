#!/usr/bin/env python3
"""Rebuild data/index.json and data/derived/book.json from day files.

Day files are the bot import. data/overrides/ is never written here, so a
re-sync cannot wipe committed edits. Account id fields are stripped in place
when a day file still has them.

Usage:
    python3 scripts/build_index.py
    python3 scripts/build_index.py --root /path/to/repo
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from redact import contains_long_account_token, redact
from trade_match import (
    completed_on_session,
    dedupe_executions,
    match_executions,
    open_on_session,
    realized_on_session,
    session_date,
)

SCHEMA = 1


def _read(path: Path) -> Any:
    return json.loads(path.read_text())


def _write(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2) + "\n")


def load_days(days_dir: Path) -> list[tuple[Path, dict[str, Any], bool]]:
    """Return (path, redacted day, changed)."""
    found = []
    if not days_dir.exists():
        return found
    for path in sorted(days_dir.glob("*.json")):
        original = _read(path)
        cleaned = redact(original)
        changed = cleaned != original or contains_long_account_token(cleaned)
        if changed and not contains_long_account_token(cleaned):
            _write(path, cleaned)
        found.append((path, cleaned, changed and cleaned != original))
    return found


def _sync_map(root: Path) -> dict[str, Any]:
    path = root / "data" / "sync_status.json"
    if not path.exists():
        return {"days": {}, "last_successful_sync": None}
    doc = _read(path)
    return doc


def _meta(root: Path) -> dict[str, Any]:
    path = root / "data" / "meta.json"
    if not path.exists():
        return {}
    return redact(_read(path))


def build(root: Path) -> dict[str, Any]:
    root = root.resolve()
    days = load_days(root / "data" / "days")
    overrides_path = root / "data" / "overrides" / "edits.json"
    overrides_before = overrides_path.read_text() if overrides_path.exists() else None

    executions: list[dict[str, Any]] = []
    warnings: list[str] = []
    by_date: dict[str, dict[str, Any]] = {}
    for path, day, _changed in days:
        file_date = day.get("date") or path.stem
        by_date[file_date] = day
        for ex in day.get("executions") or []:
            executions.append(ex)
            try:
                stamped = session_date(ex["time_utc"])
            except (KeyError, ValueError):
                warnings.append(f"{path.name}: execution {ex.get('execution_id')} has no usable time")
                continue
            if stamped != file_date:
                warnings.append(
                    f"{path.name}: execution {ex.get('execution_id')} falls on New York session {stamped}"
                )

    unique = dedupe_executions(executions) if executions else []
    matched = match_executions(unique) if unique else {"trades": [], "open_positions": []}
    trades = matched["trades"]

    sync = _sync_map(root)
    sync_days = sync.get("days") or {}
    meta = _meta(root)

    summaries = []
    for file_date, day in sorted(by_date.items()):
        sync_row = sync_days.get(file_date) or {}
        status = sync_row.get("status") or "synced"
        completed = completed_on_session(trades, file_date)
        held = open_on_session(trades, file_date)
        wins = sum(1 for t in completed if t["outcome"] == "win")
        losses = sum(1 for t in completed if t["outcome"] == "loss")
        breakeven = sum(1 for t in completed if t["outcome"] == "breakeven")
        fifo_realized = realized_on_session(trades, file_date)
        broker = day.get("broker_day_pnl")
        if broker is None:
            broker = day.get("day_pnl")
        broker_source = day.get("broker_day_pnl_source") or day.get("day_pnl_source")
        if broker is not None and status == "synced":
            tile = float(broker)
            tile_source = "broker_day"
        else:
            tile = fifo_realized
            tile_source = "fifo"
        tickers = list(day.get("tickers") or [])
        for trade in trades:
            if trade["session_open"] == file_date or trade.get("session_close") == file_date:
                u = trade.get("underlying")
                if u and u not in tickers:
                    tickers.append(u)
        bot = day.get("bot_journal") or {}
        summaries.append(
            {
                "date": file_date,
                "file": f"days/{file_date}.json",
                "sync_status": status,
                "sync_message": sync_row.get("message"),
                "tile_pnl": round(tile, 2),
                "tile_pnl_source": tile_source,
                "broker_day_pnl": None if broker is None else round(float(broker), 2),
                "broker_day_pnl_source": broker_source,
                "fifo_realized_pnl": fifo_realized,
                "fees_known": all(
                    t["fees_known"] for t in completed
                ) if completed else False,
                "completed_trades": len(completed),
                "wins": wins,
                "losses": losses,
                "breakeven": breakeven,
                "open_positions": len(held),
                "tickers": tickers,
                "balance_close": day.get("balance_close"),
                "starting_cash": day.get("starting_cash"),
                "bot_grade": bot.get("grade") or day.get("grade"),
            }
        )

    # Sync rows with no day file (no-trade, failed, partial) still belong on the calendar.
    known = {row["date"] for row in summaries}
    for date, row in sorted(sync_days.items()):
        if date in known:
            continue
        summaries.append(
            {
                "date": date,
                "file": None,
                "sync_status": row.get("status") or "failed",
                "sync_message": row.get("message"),
                "tile_pnl": None,
                "tile_pnl_source": None,
                "broker_day_pnl": None,
                "broker_day_pnl_source": None,
                "fifo_realized_pnl": 0,
                "fees_known": False,
                "completed_trades": 0,
                "wins": 0,
                "losses": 0,
                "breakeven": 0,
                "open_positions": 0,
                "tickers": [],
                "balance_close": None,
                "bot_grade": None,
            }
        )
    summaries.sort(key=lambda row: row["date"])

    index = {
        "schema_version": SCHEMA,
        "title": meta.get("title") or "Webull Trading Journal",
        "account_label": meta.get("account_label"),
        "session_timezone": "America/New_York",
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "as_of": summaries[-1]["date"] if summaries else meta.get("first_journal_date"),
        "first_journal_date": meta.get("first_journal_date"),
        "no_fills_before": meta.get("no_fills_before"),
        "last_successful_sync": sync.get("last_successful_sync"),
        "warnings": warnings,
        "days": summaries,
    }
    book = {
        "schema_version": SCHEMA,
        "session_timezone": "America/New_York",
        "generated_at": index["generated_at"],
        "execution_count": len(unique),
        "duplicate_executions_dropped": max(len(executions) - len(unique), 0),
        "trades": trades,
        "open_positions": matched["open_positions"],
    }
    def _same(path: Path, obj: dict[str, Any], volatile: set[str]) -> bool:
        if not path.exists():
            return False
        try:
            old = json.loads(path.read_text())
        except json.JSONDecodeError:
            return False
        left = {k: v for k, v in old.items() if k not in volatile}
        right = {k: v for k, v in obj.items() if k not in volatile}
        return left == right

    index_path = root / "data" / "index.json"
    book_path = root / "data" / "derived" / "book.json"
    if _same(index_path, index, {"generated_at"}):
        index["generated_at"] = json.loads(index_path.read_text()).get("generated_at")
    else:
        _write(index_path, index)
    if _same(book_path, book, {"generated_at"}):
        book["generated_at"] = json.loads(book_path.read_text()).get("generated_at")
    else:
        _write(book_path, book)

    if overrides_before is not None and overrides_path.read_text() != overrides_before:
        raise RuntimeError("build_index must not modify data/overrides")
    return {"index": index, "book": book, "warnings": warnings}


def main() -> None:
    parser = argparse.ArgumentParser(description="Rebuild the journal index and trade book.")
    parser.add_argument("--root", default=str(Path(__file__).resolve().parents[1]))
    args = parser.parse_args()
    result = build(Path(args.root))
    days = result["index"]["days"]
    print(f"indexed {len(days)} days, {len(result['book']['trades'])} trades")


if __name__ == "__main__":
    main()
