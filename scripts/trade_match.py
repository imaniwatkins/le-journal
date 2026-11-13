#!/usr/bin/env python3
"""Group raw executions into trades.

This module never contacts a broker. It only matches fills that are already
on disk. Running it again on the same executions does not create duplicate
fills: identity is the execution id.

Session dates are the America/New_York calendar date of each fill. Realized
P&L is recognized when quantity closes. Open quantity is not a win, a loss,
or a breakeven.

P&L source, in order:
  1. Broker realized P&L on the closing fill, when that field is present.
  2. Otherwise FIFO, option multiplier 100 unless the fill says otherwise.
Fees are subtracted only when every fill in the trade itemized them. Missing
fees stay unknown. They are not guessed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
QTY_EPS = 1e-9


def parse_time(value: str) -> datetime:
    raw = value.strip()
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    dt = datetime.fromisoformat(raw)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def session_date(value: str) -> str:
    return parse_time(value).astimezone(ET).date().isoformat()


def instrument_key(ex: dict[str, Any]) -> str:
    occ = ex.get("occ_symbol")
    if occ:
        return str(occ)
    if ex.get("asset_type") == "option" or ex.get("option_type"):
        return "|".join(
            [
                "OPT",
                str(ex.get("underlying") or ""),
                str(ex.get("expiry") or ""),
                str(ex.get("strike") or ""),
                str(ex.get("option_type") or ""),
            ]
        )
    return "STK|" + str(ex.get("underlying") or ex.get("symbol") or "")


def multiplier_of(ex: dict[str, Any]) -> float:
    if ex.get("multiplier") is not None:
        return float(ex["multiplier"])
    if ex.get("asset_type") == "option" or ex.get("occ_symbol") or ex.get("option_type"):
        return 100.0
    return 1.0


def dedupe_executions(executions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep the first copy of each execution id. Later copies are ignored."""
    seen: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for ex in executions:
        eid = ex.get("execution_id")
        if not eid:
            raise ValueError("execution is missing execution_id")
        eid = str(eid)
        if eid in seen:
            continue
        seen[eid] = ex
        order.append(eid)
    return [seen[eid] for eid in order]


def _money(value: float) -> float:
    return round(value + 0.0, 2)


def _price(value: float) -> float:
    return round(value + 0.0, 6)


@dataclass
class Lot:
    qty: float
    price: float
    time: str
    execution_id: str
    fee_per_qty: float | None


@dataclass
class Book:
    key: str
    spec: dict[str, Any]
    lots: list[Lot] = field(default_factory=list)
    direction: str | None = None
    trade: dict[str, Any] | None = None

    def qty_open(self) -> float:
        return sum(lot.qty for lot in self.lots)

    def apply(self, ex: dict[str, Any]) -> dict[str, Any] | None:
        side = str(ex["side"]).lower()
        if side not in {"buy", "sell"}:
            raise ValueError(f"bad side on {ex.get('execution_id')}")
        qty = float(ex["qty"])
        if qty <= 0:
            raise ValueError(f"qty must be positive on {ex.get('execution_id')}")
        price = float(ex["price"])
        opening = _is_opening(side, self.direction, self.qty_open(), ex.get("position_effect"))
        if opening:
            return self._open(ex, side, qty, price)
        return self._close(ex, side, qty, price)

    def _ensure_trade(self, ex: dict[str, Any], direction: str) -> dict[str, Any]:
        if self.trade is None:
            self.direction = direction
            self.trade = {
                "trade_id": "tr_" + str(ex["execution_id"]),
                "instrument_key": self.key,
                "underlying": ex.get("underlying"),
                "asset_type": ex.get("asset_type") or ("option" if ex.get("option_type") or ex.get("occ_symbol") else "stock"),
                "occ_symbol": ex.get("occ_symbol"),
                "option_type": ex.get("option_type"),
                "strike": ex.get("strike"),
                "expiry": ex.get("expiry"),
                "contract": ex.get("contract"),
                "direction": direction,
                "multiplier": multiplier_of(ex),
                "opened_at": ex["time_utc"],
                "closed_at": None,
                "session_open": session_date(ex["time_utc"]),
                "session_close": None,
                "qty_opened": 0.0,
                "qty_closed": 0.0,
                "legs": [],
                "execution_ids": [],
                "fees_known": True,
                "_gross": 0.0,
                "_fees": 0.0,
                "_broker_pnl": 0.0,
                "_broker_qty": 0.0,
                "_fifo_qty": 0.0,
                "_entry_notional": 0.0,
                "_exit_notional": 0.0,
            }
        return self.trade

    def _open(self, ex: dict[str, Any], side: str, qty: float, price: float) -> None:
        direction = "long" if side == "buy" else "short"
        if self.direction and direction != self.direction and self.qty_open() > QTY_EPS:
            raise ValueError(
                f"execution {ex.get('execution_id')} would flip an open {self.direction} position; split the fill"
            )
        trade = self._ensure_trade(ex, direction)
        effect = "open" if trade["qty_opened"] <= QTY_EPS else "add"
        fee_per = _fee_per_qty(ex, qty)
        if fee_per is None:
            trade["fees_known"] = False
        self.lots.append(
            Lot(qty, price, ex["time_utc"], str(ex["execution_id"]), fee_per)
        )
        trade["qty_opened"] = trade["qty_opened"] + qty
        trade["_entry_notional"] += price * qty
        _append_leg(trade, ex, effect, qty, price, None, None)
        return None

    def _close(self, ex: dict[str, Any], side: str, qty: float, price: float) -> dict[str, Any] | None:
        if self.qty_open() <= QTY_EPS or self.trade is None:
            # Flat book: this fill opens the opposite direction.
            return self._open(ex, side, qty, price)
        expected = "sell" if self.direction == "long" else "buy"
        if side != expected:
            raise ValueError(
                f"execution {ex.get('execution_id')} side {side} does not close a {self.direction} position"
            )
        trade = self.trade
        remaining = qty
        gross = 0.0
        fee_total = 0.0
        fee_known = _fee_per_qty(ex, qty) is not None
        close_fee_per = _fee_per_qty(ex, qty)
        broker = ex.get("realized_pnl")
        broker_given = broker is not None and broker != ""
        while remaining > QTY_EPS and self.lots:
            lot = self.lots[0]
            take = min(lot.qty, remaining)
            sign = 1.0 if self.direction == "long" else -1.0
            gross += sign * (price - lot.price) * take * trade["multiplier"]
            if lot.fee_per_qty is None or close_fee_per is None:
                fee_known = False
            else:
                fee_total += (lot.fee_per_qty + close_fee_per) * take
            lot.qty -= take
            remaining -= take
            if lot.qty <= QTY_EPS:
                self.lots.pop(0)
        if remaining > QTY_EPS:
            raise ValueError(
                f"execution {ex.get('execution_id')} closes more than the open quantity"
            )
        if not fee_known:
            trade["fees_known"] = False
        elif fee_total or fee_total == 0:
            trade["_fees"] += fee_total
        trade["qty_closed"] = trade["qty_closed"] + qty
        trade["_exit_notional"] += price * qty
        if broker_given:
            trade["_broker_pnl"] += float(broker)
            trade["_broker_qty"] += qty
            leg_pnl = float(broker)
            leg_source = "broker"
        else:
            trade["_gross"] += gross
            trade["_fifo_qty"] += qty
            leg_pnl = _money(gross)
            leg_source = "fifo"
        flat = self.qty_open() <= QTY_EPS
        effect = "close" if flat else "partial_exit"
        _append_leg(trade, ex, effect, qty, price, _money(leg_pnl) if leg_source == "broker" or True else leg_pnl, leg_source)
        # Store slice gross on the leg for FIFO slices. Broker slices keep the broker number.
        trade["legs"][-1]["realized_pnl"] = _money(float(broker)) if broker_given else _money(gross)
        trade["legs"][-1]["pnl_source"] = leg_source
        if flat:
            finished = self.finish_closed()
            self.trade = None
            self.lots = []
            self.direction = None
            return finished
        return None

    def finish_closed(self) -> dict[str, Any]:
        trade = self.trade
        assert trade is not None
        last_close = next(leg for leg in reversed(trade["legs"]) if leg["effect"] in {"close", "partial_exit"})
        trade["closed_at"] = last_close["time_utc"]
        trade["session_close"] = session_date(last_close["time_utc"])
        return _finalize(trade, status="closed")

    def finish_open(self) -> dict[str, Any]:
        assert self.trade is not None
        return _finalize(self.trade, status="open")


def _fee_per_qty(ex: dict[str, Any], qty: float) -> float | None:
    fees = ex.get("fees")
    if fees is None or fees == "":
        return None
    return float(fees) / qty


def _is_opening(side: str, direction: str | None, qty_open: float, effect: Any) -> bool:
    if isinstance(effect, str) and effect.lower() in {"open", "opening"}:
        return True
    if isinstance(effect, str) and effect.lower() in {"close", "closing"}:
        return False
    if qty_open <= QTY_EPS or direction is None:
        return True
    if direction == "long":
        return side == "buy"
    return side == "sell"


def _append_leg(
    trade: dict[str, Any],
    ex: dict[str, Any],
    effect: str,
    qty: float,
    price: float,
    realized: float | None,
    source: str | None,
) -> None:
    trade["execution_ids"].append(str(ex["execution_id"]))
    trade["legs"].append(
        {
            "execution_id": str(ex["execution_id"]),
            "order_id": ex.get("order_id"),
            "time_utc": ex["time_utc"],
            "session_date": session_date(ex["time_utc"]),
            "side": str(ex["side"]).lower(),
            "effect": effect,
            "qty": qty,
            "price": price,
            "fees": ex.get("fees"),
            "realized_pnl": realized,
            "pnl_source": source,
        }
    )


def _finalize(trade: dict[str, Any], status: str) -> dict[str, Any]:
    qty_opened = trade["qty_opened"]
    qty_closed = trade["qty_closed"]
    avg_entry = trade["_entry_notional"] / qty_opened if qty_opened else None
    avg_exit = trade["_exit_notional"] / qty_closed if qty_closed else None
    itemized = bool(trade["fees_known"])
    broker_qty = trade["_broker_qty"]
    fifo_qty = trade["_fifo_qty"]
    gross = float(trade["_gross"])
    broker_pnl = float(trade["_broker_pnl"])
    fee_sum = float(trade["_fees"]) if itemized else None
    if qty_closed <= QTY_EPS:
        source = None
        realized = 0.0
        fees_treatment = "unknown" if not itemized else "not_applicable"
    elif broker_qty > QTY_EPS and fifo_qty <= QTY_EPS:
        source = "broker"
        realized = broker_pnl
        # The broker number is used as given. Itemized fees are disclosed, not subtracted again.
        fees_treatment = "broker_figure" if itemized else "unknown"
    elif broker_qty <= QTY_EPS:
        source = "fifo"
        if itemized and fee_sum is not None:
            realized = gross - fee_sum
            fees_treatment = "subtracted"
        else:
            realized = gross
            fee_sum = None
            fees_treatment = "unknown"
    else:
        source = "mixed"
        if itemized and fee_sum is not None:
            realized = broker_pnl + (gross - fee_sum)
            fees_treatment = "subtracted_on_fifo_only"
        else:
            realized = broker_pnl + gross
            fee_sum = None
            fees_treatment = "unknown"
    outcome = None
    if status == "closed":
        realized_cents = _money(realized)
        if realized_cents > 0:
            outcome = "win"
        elif realized_cents < 0:
            outcome = "loss"
        else:
            outcome = "breakeven"
    pnl_pct = None
    if avg_entry is not None and qty_closed > QTY_EPS:
        cost = abs(avg_entry) * qty_closed * trade["multiplier"]
        if cost:
            pnl_pct = round(realized / cost * 100.0, 4)
    opened = parse_time(trade["opened_at"])
    duration = None
    if trade.get("closed_at"):
        duration = int(round((parse_time(trade["closed_at"]) - opened).total_seconds()))
    if broker_qty <= QTY_EPS:
        gross_out = gross
    elif fifo_qty <= QTY_EPS:
        gross_out = broker_pnl
    else:
        gross_out = gross + broker_pnl
    return {
        "trade_id": trade["trade_id"],
        "instrument_key": trade["instrument_key"],
        "underlying": trade["underlying"],
        "asset_type": trade["asset_type"],
        "occ_symbol": trade["occ_symbol"],
        "option_type": trade["option_type"],
        "strike": trade["strike"],
        "expiry": trade["expiry"],
        "contract": trade["contract"],
        "direction": trade["direction"],
        "multiplier": trade["multiplier"],
        "opened_at": trade["opened_at"],
        "closed_at": trade["closed_at"],
        "session_open": trade["session_open"],
        "session_close": trade["session_close"],
        "qty_opened": qty_opened,
        "qty_closed": qty_closed,
        "qty_open": round(max(qty_opened - qty_closed, 0.0), 6),
        "avg_entry": None if avg_entry is None else _price(avg_entry),
        "avg_exit": None if avg_exit is None else _price(avg_exit),
        "fees": None if fee_sum is None else _money(fee_sum),
        "fees_known": itemized if status == "open" or qty_closed > QTY_EPS else False,
        "fees_treatment": fees_treatment,
        "gross_pnl": _money(gross_out) if qty_closed > QTY_EPS else 0.0,
        "realized_pnl": _money(realized) if qty_closed > QTY_EPS else 0.0,
        "pnl_source": source,
        "pnl_pct": pnl_pct,
        "status": status,
        "outcome": outcome,
        "duration_seconds": duration,
        "legs": trade["legs"],
        "execution_ids": trade["execution_ids"],
        "add_count": sum(1 for leg in trade["legs"] if leg["effect"] == "add"),
        "partial_exit_count": sum(1 for leg in trade["legs"] if leg["effect"] == "partial_exit"),
    }


def match_executions(executions: list[dict[str, Any]]) -> dict[str, Any]:
    cleaned = dedupe_executions(executions)
    cleaned.sort(key=lambda ex: (parse_time(ex["time_utc"]), str(ex["execution_id"])))
    books: dict[str, Book] = {}
    closed: list[dict[str, Any]] = []
    for ex in cleaned:
        key = instrument_key(ex)
        if key not in books:
            books[key] = Book(key, ex)
        finished = books[key].apply(ex)
        if finished is not None:
            closed.append(finished)
    open_trades: list[dict[str, Any]] = []
    open_positions: list[dict[str, Any]] = []
    for book in books.values():
        if book.trade is not None and book.qty_open() > QTY_EPS:
            trade = book.finish_open()
            open_trades.append(trade)
            open_positions.append(
                {
                    "trade_id": trade["trade_id"],
                    "instrument_key": trade["instrument_key"],
                    "underlying": trade["underlying"],
                    "occ_symbol": trade["occ_symbol"],
                    "option_type": trade["option_type"],
                    "strike": trade["strike"],
                    "expiry": trade["expiry"],
                    "direction": trade["direction"],
                    "qty_open": trade["qty_open"],
                    "avg_entry": trade["avg_entry"],
                    "multiplier": trade["multiplier"],
                    "opened_at": trade["opened_at"],
                    "session_open": trade["session_open"],
                }
            )
    trades = closed + open_trades
    trades.sort(key=lambda t: (t["opened_at"], t["trade_id"]))
    return {"trades": trades, "open_positions": open_positions}


def realized_on_session(trades: list[dict[str, Any]], day: str) -> float:
    """FIFO/broker realized dollars whose closing leg falls on this New York session.

    Open quantity contributes nothing. Partial exits contribute on the session
    of that exit only.
    """
    total = 0.0
    for trade in trades:
        for leg in trade["legs"]:
            if leg["effect"] in {"partial_exit", "close"} and leg["session_date"] == day:
                if leg.get("realized_pnl") is not None:
                    total += float(leg["realized_pnl"])
    return _money(total)


def completed_on_session(trades: list[dict[str, Any]], day: str) -> list[dict[str, Any]]:
    return [
        t
        for t in trades
        if t["status"] == "closed" and t.get("session_close") == day and t.get("outcome") in {"win", "loss", "breakeven"}
    ]


def open_on_session(trades: list[dict[str, Any]], day: str) -> list[dict[str, Any]]:
    """Positions that were still open at the end of the New York session."""
    held = []
    for trade in trades:
        if trade["session_open"] > day:
            continue
        if trade["status"] == "open" or (trade.get("session_close") and trade["session_close"] > day):
            held.append(trade)
        elif trade["status"] == "closed" and trade.get("session_close") == day:
            continue
    return held
