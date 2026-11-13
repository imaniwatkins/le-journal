# Webull Trading Journal

A personal paper-trading journal as an installable web app. It is a static site on GitHub Pages. The phone reads files that are already in this repo. It does not log into Webull, and it never places, changes, or cancels an order.

Live site: https://imaniwatkins.github.io/le-journal/

The repo is public on purpose. Brokerage account ids are stripped before they are committed. There is no encryption, because these are paper trades.

## What you see

- A Monday–Friday month calendar. Tiles show realized P&L, completed trades, and the win/loss count. Green, red, and neutral marks follow that P&L. Open positions, failed or incomplete imports, no-trade days, holidays, and early closes look different.
- A day page with the imported journal, broker day P&L and FIFO P&L, fees (or “unknown”), a timeline of raw fills, and one card per trade.
- Candlestick charts for the underlying (10-minute, with PDH/PMH/PML and the 8 EMA) and the option (5-minute). Buy and sell markers sit on the fill price. Pinch to zoom. Drag sideways to pan.
- An LE review per trade. Each line is marked as an imported fact, a calculation, your note, needs review, or insufficient data. Grades A/B/D from the criteria file are shown in Settings. B and D items say “needs your confirmation” and have no invented number.
- Plans, notes, an end-of-day reflection, a weekly review, and an insights page. Insights name the sample size and the date range, and they do not predict anything.
- Times display in the phone’s time zone, with the zone name. A session belongs to its New York calendar date.

**Refresh** reloads the files on the site. It cannot start a new import. If a session is missing, ask your assistant to re-sync.

## Add a day

1. Produce `data/days/YYYY-MM-DD.json` (schema version 2, below). The date is the New York session, not a Pacific clock date that disagrees with the fills.
2. Update `data/sync_status.json` for that date: `synced`, `no_trades`, `partial`, or `failed`, plus a short `message` when something went wrong. Set `last_successful_sync` when the pull worked.
3. Commit and push to `main`.

You do not hand-edit `data/index.json` or `data/derived/book.json`. The GitHub Action rebuilds them, groups fills into trades, and strips account ids. Pushing the day file is enough.

A legacy file from the older session builder can be converted locally:

```bash
python3 scripts/import_bot_day.py --in legacy.json --out data/days/YYYY-MM-DD.json
python3 scripts/build_index.py
```

`import_bot_day.py` only reads the file you give it. It does not call a broker.

## Day file (schema version 2)

See `schema/day.v2.json`. The fields the assistant should write:

| Field | Meaning |
| --- | --- |
| `schema_version` | `2` |
| `date` | `YYYY-MM-DD` in America/New_York |
| `session_timezone` | `America/New_York` |
| `account_label` | A nickname such as `Paper Individual Cash`. No account id. |
| `broker_day_pnl` | Account day P&L from the balance pull, or `null` |
| `broker_day_pnl_source` | Where that number came from |
| `fees_from_api` | Itemized fees, or `null` if the API did not itemize them |
| `balance_close`, `starting_cash` | Optional closes |
| `vix`, `gap_down` | Omit or `null` when they were not pulled. Do not guess. |
| `stop_orders_in_history` | Count of stop orders seen, or `null` if you did not look |
| `executions` | Every fill. `execution_id` must stay stable across re-syncs. |
| `bot_journal` | Lessons, notes, and the builder’s rule lists. The app shows this as imported text. |
| `charts.underlying` | 10-minute RTH bars (`t`, `o`, `h`, `l`, `c`, `ema8`), `levels`, `markers` |
| `charts.option_5m` | 5-minute option candles and markers at the fill price |

Each execution needs `execution_id`, `time_utc`, `side` (`buy` or `sell`), `qty`, and `price`. Also send `underlying`, `asset_type` (`option` or `stock`), `multiplier` (100 for equity options), `fees` (number or `null`), and `realized_pnl` (the broker’s realized number for that fill, or `null`). For options include `occ_symbol`, `option_type`, `strike`, and `expiry`. Optional `position_effect` is `open` or `close`. If you omit it, the matcher infers it from the running position.

Do not put an `account_id` field in the file. The index build deletes account-id keys and 26-character uppercase account tokens anyway.

## How fills become trades

`scripts/trade_match.py` is the matcher the index build runs. The same rules are what the tests lock in:

- Fills are deduped by `execution_id`. Importing the same fill twice does not double the quantity.
- Buys and sells on one contract are one position. A later fill in the same direction is an add. A partial sell while quantity remains is a partial exit. The next entry after a flat position is a new trade.
- Several round trips in the same ticker stay separate trades.
- A position can stay open across New York sessions. It is marked open on the days it is held. It becomes a win, loss, or breakeven only on the session it goes flat.
- Realized P&L uses the broker’s `realized_pnl` on a closing fill when that field is present, and says so. Otherwise it is FIFO. Equity options use a 100 multiplier unless the fill sets one.
- Fees are subtracted only when every fill in the trade itemized them. Otherwise fees stay unknown. They are not invented from the gap between FIFO gross and the account day P&L.
- Open quantity is never a win or a loss, and the app does not invent an unrealized price.

## Sync status

`data/sync_status.json`:

```json
{
  "schema_version": 1,
  "last_successful_sync": "2026-11-12T21:00:00Z",
  "days": {
    "2026-11-12": { "status": "synced", "message": null },
    "2026-11-13": { "status": "no_trades", "message": "No orders." }
  }
}
```

`status` is `synced`, `no_trades`, `partial`, or `failed`. A failed or partial day should include `message`. A no-trade day does not need a day file. Holidays and early closes live in `data/market_calendar.json` (NYSE, 2026–2027), not in the sync file.

## Notes, plans, and overrides

Anything you type (notes, plans, LE edits, execution grade, weekly review, personal rules) is stored in `localStorage` and IndexedDB on the phone. The imported day file is not edited.

**Export edits JSON** downloads one document. Commit that file as `data/overrides/edits.json` and push. On the next visit the site loads it. Committed edits win over anything a re-imported day file might say, because day files do not contain those fields and the index build never writes `data/overrides/`.

On the phone, a newer local edit still sits on top of the committed file until you export again. Importing an edits file replaces the phone copy.

The trades CSV and trades JSON are for your own spreadsheet. Screenshot fields are URLs only. Image files are not embedded.

Personal rules start blank. The criteria page mentions his published examples (position size, daily loss, three trades). Those are not copied into your settings, and insights only compare days with limits you actually saved.

## LE criteria

`config/le_criteria.json` is the checklist, taken from the v5 research note “EllyDTrades LE Model: Strategy Research & Bot Spec” (as of 2026-11-11). Grade A was stated plainly, B was contradictory, D was not published. Air-gap, the volume cutoff, the 30-minute extension limit, the scaling fraction, the gap-down target formula, which candle the stop uses, and inside-day handling are B or D. They are labeled “needs your confirmation” and the file stores no number for them. VIX above 20 and the 1-to-2-strike guide are published, so those are the only numeric checks, and only when the import actually contains the inputs.

## Install

Open the site in Safari or Chrome, then Add to Home Screen. The manifest, icons, Apple touch icon, and standalone tags are included. A service worker keeps the last loaded journal available offline. Refresh while online to pick up a new day.

## Tests

```bash
python3 -m unittest discover -s scripts -p "test_*.py"
node scripts/test_client.mjs
```

The Python tests cover partial exits, adds, two trades on one ticker, open positions, positions held overnight, idempotent re-import, broker P&L versus FIFO, fees, the index redact step, override preservation, and no-trade versus failed days. The Node checks cover edit merging, the November 12 review (no invented stop, emotion, or VIX), and R, including the case where the stop is on the underlying and delta was not imported.

Charts use TradingView Lightweight Charts 5.3.0, Apache-2.0, vendored at `vendor/lightweight-charts.standalone.production.js`.
