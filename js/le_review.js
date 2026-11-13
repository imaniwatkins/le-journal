/** LE review rows. Facts and calculations only. No invented stops, targets, or emotions. */

import { money } from "./format.js";

export const SETUP_CHOICES = [
  ["unsure", "Unsure"],
  ["level_retest", "Level retest"],
  ["ema_8", "8 EMA entry"],
  ["gap_down", "Gap-down play"],
  ["other", "Other"],
];

export const GRADE_CHOICES = [
  ["", "Not set"],
  ["followed", "Followed"],
  ["mixed", "Mixed"],
  ["broken", "Broken"],
];

function num(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function itemById(criteria) {
  return Object.fromEntries((criteria?.items || []).map((item) => [item.id, item]));
}

function barContaining(bars, iso) {
  if (!bars || !iso) return null;
  const t = Date.parse(iso);
  let best = null;
  for (const bar of bars) {
    const start = Date.parse(bar.t);
    if (Number.isNaN(start) || start > t) continue;
    if (!best || start > Date.parse(best.t)) best = bar;
  }
  return best;
}

function etClock(iso) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(iso)).map((p) => [p.type, p.value]),
  );
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  return { hour, minute, afterOpen: hour * 60 + minute - (9 * 60 + 30) };
}

export function buildReview(trade, day, criteria) {
  const byId = itemById(criteria);
  const botTrades = day?.bot_journal?.trades || [];
  const bot = botTrades.length === 1
    ? botTrades[0]
    : botTrades.find((t) => t.occ_symbol && t.occ_symbol === trade?.occ_symbol) || botTrades[0] || {};
  const le = bot.le || {};
  const leDay = day?.bot_journal?.le_day || {};
  const pdh = num(le.pdh ?? leDay.pdh);
  const pdl = num(le.pdl ?? leDay.pdl);
  const pmh = num(le.pmh ?? leDay.pmh);
  const pml = num(le.pml ?? leDay.pml);
  const ema = num(le.ema_8_10m_at_last_completed_bar);
  const entryPx = num(bot.underlying_at_entry?.price ?? trade?.underlying_at_entry);
  const strikes = num(bot.strike_distance?.strikes_otm);
  const otm = num(bot.strike_distance?.otm_dollars);
  const rows = [];

  function add(id, origin, value, detail = "") {
    const item = byId[id];
    if (!item) return;
    rows.push({
      id,
      label: item.label,
      grade: item.grade,
      group: item.group,
      needs_confirmation: Boolean(item.needs_confirmation),
      statement: item.statement,
      apply_to_personal_rules: item.apply_to_personal_rules !== false,
      origin,
      value,
      detail,
    });
  }

  if (pdh != null && pdl != null) {
    add("levels_pdh_pdl", "imported_fact", `${pdh} / ${pdl}`, le.pdh_pdl_source || leDay.pdh_pdl_source || "");
  } else add("levels_pdh_pdl", "insufficient_data", "Not in the import");

  if (pmh != null && pml != null) {
    add("levels_pmh_pml", "imported_fact", `${pmh} / ${pml}`, le.pmh_pml_source || leDay.pmh_pml_source || "");
  } else add("levels_pmh_pml", "insufficient_data", "Not in the import");

  const bar = barContaining(day?.charts?.underlying?.bars, trade?.opened_at);
  if (bar && trade?.direction === "long" && pdh != null && pmh != null) {
    const bodyLo = Math.min(bar.o, bar.c);
    const clear = bodyLo > pdh && bodyLo > pmh;
    add(
      "entry_gate_body_both",
      "calculation",
      clear
        ? "Body of the 10-minute bar that contains the fill is above both PDH and PMH."
        : "Body of the 10-minute bar that contains the fill is not beyond both levels.",
      `${bar.label || bar.t}: O ${bar.o} H ${bar.h} L ${bar.l} C ${bar.c}. Which candle is the entry candle is still unconfirmed.`,
    );
  } else if (bar && trade?.direction === "short" && pdl != null && pml != null) {
    const bodyHi = Math.max(bar.o, bar.c);
    const clear = bodyHi < pdl && bodyHi < pml;
    add(
      "entry_gate_body_both",
      "calculation",
      clear
        ? "Body of the 10-minute bar that contains the fill is below both PDL and PML."
        : "Body of the 10-minute bar that contains the fill is not beyond both levels.",
      `${bar.label || bar.t}. Which candle is the entry candle is still unconfirmed.`,
    );
  } else add("entry_gate_body_both", "insufficient_data", "Not enough candle or level data.");

  add("levels_before_ema", "needs_review", "Not judged from the fills.");
  if (ema != null) {
    add("ema_8_10m", "calculation", String(ema), le.last_completed_10m_bar || "Imported 10-minute 8 EMA at the last completed bar before entry.");
  } else add("ema_8_10m", "insufficient_data", "No 10-minute 8 EMA in the import.");

  if (ema != null && entryPx != null) {
    const dist = Math.round((entryPx - ema) * 100) / 100;
    add(
      "ema_near_level",
      "needs_review",
      `Underlying ${entryPx} versus 8 EMA ${ema} (${dist >= 0 ? "+" : ""}${dist}).`,
      "Distance is shown. Whether it was close enough is unpublished, so it is not graded.",
    );
  } else add("ema_near_level", "insufficient_data", "Missing price or EMA.");

  add("air_gap_tolerance", "needs_review", "Needs your confirmation.");
  add("level_retest", "needs_review", "Unsure — set the setup type yourself.");
  add("ema_entry", "needs_review", "Unsure — set the setup type yourself.");
  add("whichever_first", "needs_review", "Not judged.");

  const vix = num(day?.vix);
  if (vix == null) add("vix_filter", "insufficient_data", "VIX was not imported.");
  else if (trade?.direction === "long" && vix > 20) add("vix_filter", "calculation", `VIX ${vix} is above 20.`);
  else add("vix_filter", "calculation", `VIX ${vix}.`);

  if (trade?.opened_at) {
    const clock = etClock(trade.opened_at);
    let value = "After the first 60 minutes of the regular session.";
    if (clock.afterOpen < 0) value = "Before the 9:30 ET regular-session open.";
    else if (clock.afterOpen < 30) value = "Inside the first 30 minutes of the regular session.";
    else if (clock.afterOpen < 60) value = "After the first 30 minutes and still inside the first 60.";
    const hour12 = ((clock.hour + 11) % 12) + 1;
    const ap = clock.hour >= 12 ? "PM" : "AM";
    add("first_30_60", "calculation", value, `Fill at ${hour12}:${String(clock.minute).padStart(2, "0")} ${ap} ET.`);
  } else add("first_30_60", "insufficient_data", "No entry time.");

  if (day?.gap_down == null) add("gap_down_play", "insufficient_data", "The import did not flag a gap-down session.");
  else add("gap_down_play", "imported_fact", day.gap_down ? "Flagged as a gap-down session." : "Flagged as not a gap-down session.");

  add("gap_down_target", "needs_review", "Needs your confirmation.");
  if (day?.charts?.m30 || day?.charts?.underlying_30m) add("timeframe_30m", "imported_fact", "30-minute bars are in the file.");
  else add("timeframe_30m", "insufficient_data", "No 30-minute bars were imported.");

  add("extension_limit_30m", "needs_review", "Needs your confirmation.");
  add("volume_momentum_threshold", "needs_review", "Needs your confirmation.");

  if (day?.stop_orders_in_history == null && bot.had_stop_on_open == null) {
    add("stop_entry_candle", "insufficient_data", "No stop information in the import.");
  } else if (!day?.stop_orders_in_history && bot.had_stop_on_open === false) {
    add("stop_entry_candle", "imported_fact", "No stop order in the imported history.", "A stop price is not invented.");
  } else if (day?.stop_orders_in_history) {
    add("stop_entry_candle", "imported_fact", "A stop order is in the imported history.");
  } else add("stop_entry_candle", "insufficient_data", "Stop presence is unclear.");

  add("entry_candle_which", "needs_review", "Needs your confirmation.");

  if (trade && trade.status === "closed") {
    add("scale_at_hod", "imported_fact", `Closed ${trade.qty_closed} of ${trade.qty_opened}. Nothing left open.`, "The scale fraction is a separate unconfirmed item.");
  } else if (trade && trade.status === "open") {
    add("scale_at_hod", "imported_fact", `${trade.qty_open} still open. Open quantity is not a win or a loss.`);
  } else add("scale_at_hod", "insufficient_data", "Quantity is unclear.");

  add("scaling_fraction", "needs_review", "Needs your confirmation.");
  add("trail_8ema", "needs_review", "The fills do not show a trailing stop.");
  add("reduce_risk_10et", "needs_review", "Not judged.");

  if (strikes == null) add("strike_1_2_otm", "insufficient_data", "Strike distance was not in the import.");
  else if (strikes >= 1 && strikes <= 2) {
    add("strike_1_2_otm", "calculation", `About ${strikes} strikes out of the money, inside the published 1 to 2 range.`);
  } else {
    add("strike_1_2_otm", "calculation", `About ${strikes} strikes out of the money${otm == null ? "" : ` ($${otm})`}. The published guide is 1 to 2 strikes.`);
  }

  if (entryPx != null && pmh != null && pml != null) {
    const between = entryPx < pmh && entryPx > pml;
    add(
      "chop_between_levels",
      "calculation",
      between ? "Underlying at entry was between PML and PMH." : "Underlying at entry was outside the PML–PMH band.",
      `Price ${entryPx}.`,
    );
  } else add("chop_between_levels", "insufficient_data", "Missing price or pre-market levels.");

  add("outside_both_levels", "needs_review", "Not auto-labeled.");
  add("inside_day", "needs_review", "Needs your confirmation.");
  add("daily_bias", "insufficient_data", "Daily 8 EMA and daily 20 EMA were not imported.");
  add("indices_pdh_pdl_only", "needs_review", "Not applied automatically.");
  add("add_triggers", "imported_fact", trade?.add_count ? `${trade.add_count} add fill(s).` : "No add fills.");
  add("his_size_examples", "needs_review", "Not copied into your rules.");

  const exits = (trade?.legs || []).filter((leg) => leg.effect === "partial_exit" || leg.effect === "close");
  const exitText = exits.map((leg) => `${leg.qty} @ ${leg.price}`).join(", ");

  return {
    setup_type: { value: "unsure", origin: "needs_review" },
    execution_grade: { value: "", origin: "needs_review" },
    rows,
    entry_reason: { value: "", origin: "needs_review" },
    planned_stop: { value: "", origin: "insufficient_data" },
    planned_target: { value: "", origin: "insufficient_data" },
    actual_exit: { value: exitText || "No closing fill.", origin: exitText ? "imported_fact" : "insufficient_data" },
    followed_plan: { value: "", origin: "needs_review" },
    mistakes: { value: "", origin: "needs_review" },
    emotions: { value: "", origin: "needs_review" },
    lessons: { value: "", origin: "needs_review" },
    screenshot_links: [],
  };
}

export function applyUserReview(review, user) {
  const next = structuredClone(review);
  if (!user) return next;
  for (const key of ["setup_type", "execution_grade", "entry_reason", "planned_stop", "planned_target", "followed_plan", "mistakes", "emotions", "lessons"]) {
    if (user[key] != null && user[key] !== "") next[key] = { value: user[key], origin: "user_note" };
  }
  if (Array.isArray(user.screenshot_links)) next.screenshot_links = user.screenshot_links.slice();
  if (user.rows && typeof user.rows === "object") {
    for (const line of next.rows) {
      if (user.rows[line.id] != null && user.rows[line.id] !== "") {
        line.value = user.rows[line.id];
        line.origin = "user_note";
      }
    }
  }
  return next;
}

export function suggestionLines(trade, review) {
  const lines = [];
  const strike = review.rows.find((r) => r.id === "strike_1_2_otm");
  if (strike?.origin === "calculation" && strike.value.includes("published guide")) lines.push(strike.value);
  const stop = review.rows.find((r) => r.id === "stop_entry_candle");
  if (stop && String(stop.value).includes("No stop")) {
    lines.push("No stop was in the imported history, so the entry-candle stop cannot be checked.");
  }
  const windowRow = review.rows.find((r) => r.id === "first_30_60");
  if (windowRow && String(windowRow.value).includes("After the first 60")) {
    lines.push("The fill was after the first 60 minutes of the regular session.");
  }
  if (trade && trade.fees_known === false && trade.qty_closed > 0) {
    lines.push("Fees were not itemized, so they are not subtracted from realized P&L.");
  }
  if (!lines.length) lines.push("No further suggestion from the imported facts.");
  return lines;
}

export function rMultiple(trade, plan) {
  if (!plan) {
    return { status: "insufficient_data", text: "Link a plan with a numeric entry and stop to compute R." };
  }
  const entry = num(plan.planned_entry);
  const stop = num(plan.planned_stop);
  if (entry == null || stop == null) {
    return {
      status: "insufficient_data",
      text: "R needs a numeric planned entry and a numeric planned stop. A written entry idea is not enough.",
    };
  }
  if ((trade?.asset_type === "option" || trade?.occ_symbol) && plan.stop_unit === "underlying") {
    return {
      status: "insufficient_data",
      text: "The stop is on the underlying and the position is an option. Delta was not imported, so planned risk in premium is unknown.",
    };
  }
  const qty = num(trade?.qty_closed) || num(trade?.qty_opened);
  const mult = num(trade?.multiplier) || (trade?.asset_type === "option" ? 100 : 1);
  if (!qty || !mult) {
    return { status: "insufficient_data", text: "Quantity or contract multiplier is missing." };
  }
  const risk = Math.abs(entry - stop) * qty * mult;
  if (!(risk > 0)) return { status: "insufficient_data", text: "Planned risk is zero, so R is undefined." };
  if (!trade || trade.status !== "closed" || trade.realized_pnl == null) {
    return { status: "insufficient_data", text: "R uses realized P&L after the trade is flat. Open P&L is not used." };
  }
  const r = trade.realized_pnl / risk;
  const fees = trade.fees_known
    ? "Itemized fees are included in the realized P&L."
    : "Fees were not itemized, so they are not in this R.";
  return {
    status: "calculation",
    r,
    text: `R = realized P&L ÷ planned risk. Planned risk = |${entry} − ${stop}| × ${qty} × ${mult} = ${money(risk)}. Realized ${money(trade.realized_pnl, true)} (${trade.pnl_source || "unknown source"}). ${fees} R = ${r.toFixed(2)}.`,
  };
}
