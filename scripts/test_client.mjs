import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { effectiveEdits, emptyEdits, mergeEdits } from "../js/merge.js";
import { isoWeekKey, weekDates } from "../js/format.js";
import { applyUserReview, buildReview, rMultiple } from "../js/le_review.js";

const committed = {
  days: { "2026-11-12": { notes: "committed note" } },
  plans: [{ id: "p1", ticker: "AMD" }],
  personal_rules: { daily_trade_limit: null, daily_loss_limit: null, custom_rules: [] },
};
const local = { days: { "2026-11-13": { notes: "phone note" } } };
const merged = effectiveEdits(committed, local);
assert.equal(merged.days["2026-11-12"].notes, "committed note");
assert.equal(merged.days["2026-11-13"].notes, "phone note");
assert.equal(merged.plans.length, 1);

const overwritten = mergeEdits(committed, { days: { "2026-11-12": { notes: "phone wins" } } });
assert.equal(overwritten.days["2026-11-12"].notes, "phone wins");
assert.equal(effectiveEdits(overwritten, {}).days["2026-11-12"].notes, "phone wins");

const cleared = mergeEdits({ days: { a: { notes: "x" } } }, { days: { a: { notes: null } } });
assert.equal(cleared.days.a.notes, null);

const day = JSON.parse(readFileSync(new URL("../data/days/2026-11-12.json", import.meta.url)));
const book = JSON.parse(readFileSync(new URL("../data/derived/book.json", import.meta.url)));
const criteria = JSON.parse(readFileSync(new URL("../config/le_criteria.json", import.meta.url)));
const trade = book.trades[0];
const review = buildReview(trade, day, criteria);
assert.equal(review.emotions.value, "");
assert.equal(review.emotions.origin, "needs_review");
assert.equal(review.planned_stop.origin, "insufficient_data");
assert.equal(review.planned_target.value, "");
const stop = review.rows.find((row) => row.id === "stop_entry_candle");
assert.match(stop.value, /No stop/);
assert.doesNotMatch(stop.value, /\d+\.\d+/);
const vix = review.rows.find((row) => row.id === "vix_filter");
assert.equal(vix.origin, "insufficient_data");
const strike = review.rows.find((row) => row.id === "strike_1_2_otm");
assert.equal(strike.origin, "calculation");
assert.match(strike.value, /1 to 2/);
const air = review.rows.find((row) => row.id === "air_gap_tolerance");
assert.equal(air.needs_confirmation, true);
assert.equal(air.value, "Needs your confirmation.");
const windowRow = review.rows.find((row) => row.id === "first_30_60");
assert.match(windowRow.value, /After the first 60/);
const edited = applyUserReview(review, { emotions: "patient", setup_type: "level_retest" });
assert.equal(edited.emotions.origin, "user_note");
assert.equal(edited.setup_type.value, "level_retest");
assert.equal(review.emotions.value, "");

const r = rMultiple(trade, { planned_entry: "1.35", planned_stop: "1.00", stop_unit: "premium" });
assert.equal(r.status, "calculation");
assert.match(r.text, /R = /);
const missing = rMultiple(trade, { planned_stop: "1.00", stop_unit: "premium" });
assert.equal(missing.status, "insufficient_data");
const underlyingStop = rMultiple(trade, { planned_entry: "580", planned_stop: "575", stop_unit: "underlying" });
assert.match(underlyingStop.text, /Delta was not imported/);

const week = isoWeekKey("2026-11-12");
assert.ok(weekDates(week).includes("2026-11-12"));
assert.equal(emptyEdits().personal_rules.daily_trade_limit, null);

console.log("client checks ok", week);
