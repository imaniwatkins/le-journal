import { mountCharts } from "./charts.js";
import { download, durationLabel, formatEt, formatLocal, isoDate, isoWeekKey, localZone, money, monthCells, monthName, shiftMonth, weekDates, zoneLabel } from "./format.js";
import { GRADE_CHOICES, SETUP_CHOICES, applyUserReview, buildReview, rMultiple, suggestionLines } from "./le_review.js";
import { effectiveEdits, emptyEdits } from "./merge.js";

const KEY = "wtj.edits.v1";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const state = {
  index: null,
  sync: null,
  calendar: null,
  criteria: null,
  book: null,
  meta: null,
  committed: null,
  local: null,
  dayCache: {},
  error: "",
  toast: "",
  info: false,
  chartRange: "fills",
  charts: null,
};

const app = document.getElementById("app");

function h(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false || kid === "") continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

function route() {
  const raw = (location.hash || "#/").replace(/^#/, "");
  const parts = raw.split("/").filter(Boolean);
  if (parts[0] === "day" && parts[1]) return { name: "day", date: parts[1] };
  if (parts[0] === "insights") return { name: "insights" };
  if (parts[0] === "week") return { name: "week", week: parts[1] || "" };
  if (parts[0] === "settings") return { name: "settings" };
  if (parts[0] === "plan") return { name: "plan", date: parts[1] || "" };
  if (parts.length === 2 && /^\d{4}$/.test(parts[0])) return { name: "month", y: Number(parts[0]), m: Number(parts[1]) };
  return { name: "month" };
}

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

async function idbGet(key) {
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open("wtj", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return new Promise((resolve) => {
    const tx = db.transaction("kv", "readonly");
    const req = tx.objectStore("kv").get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
}

async function idbSet(key, value) {
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open("wtj", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  await new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").put(value, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

function readLocalSync() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function saveLocal(next) {
  state.local = next;
  const raw = JSON.stringify(next);
  try { localStorage.setItem(KEY, raw); } catch { /* quota; IndexedDB still holds it */ }
  try { await idbSet(KEY, raw); } catch { /* private mode */ }
}

function edits() {
  return effectiveEdits(state.committed, state.local);
}

function patchEdits(mutator) {
  const next = structuredClone(state.local && Object.keys(state.local).length ? state.local : emptyEdits());
  if (!next.days) next.days = {};
  if (!next.plans) next.plans = [];
  if (!next.weekly_reviews) next.weekly_reviews = {};
  if (!next.personal_rules) next.personal_rules = emptyEdits().personal_rules;
  mutator(next);
  next.updated_at = new Date().toISOString();
  saveLocal(next);
  const note = document.querySelector("[data-save-state]");
  if (note) note.textContent = "Saved on this phone";
}

async function loadJson(path, bust) {
  const url = new URL(path, document.baseURI);
  if (bust) url.searchParams.set("t", String(Date.now()));
  const res = await fetch(url.href, { cache: bust ? "no-store" : "default" });
  if (!res.ok) throw new Error(`${path} (${res.status})`);
  return res.json();
}

async function loadAll(bust = false) {
  const [index, sync, calendar, criteria, book, meta, committed] = await Promise.all([
    loadJson("data/index.json", bust),
    loadJson("data/sync_status.json", bust),
    loadJson("data/market_calendar.json", bust),
    loadJson("config/le_criteria.json", bust),
    loadJson("data/derived/book.json", bust),
    loadJson("data/meta.json", bust),
    loadJson("data/overrides/edits.json", bust).catch(() => emptyEdits()),
  ]);
  state.index = index;
  state.sync = sync;
  state.calendar = calendar;
  state.criteria = criteria;
  state.book = book;
  state.meta = meta;
  state.committed = committed;
  if (!state.local) {
    state.local = readLocalSync();
    if (!state.local) {
      try {
        const raw = await idbGet(KEY);
        state.local = raw ? JSON.parse(raw) : {};
      } catch {
        state.local = {};
      }
    }
  }
}

function dayRow(date) {
  return (state.index?.days || []).find((d) => d.date === date) || null;
}

function holiday(date) {
  return (state.calendar?.closed || []).find((d) => d.date === date) || null;
}

function earlyClose(date) {
  return (state.calendar?.early_close || []).find((d) => d.date === date) || null;
}

function tradesForDay(date) {
  return (state.book?.trades || []).filter((t) => t.session_open === date || t.session_close === date || (t.session_open < date && (!t.session_close || t.session_close > date)));
}

function openCount(date, row) {
  if (row && row.open_positions) return row.open_positions;
  return (state.book?.trades || []).filter((t) => t.session_open <= date && (t.status === "open" || (t.session_close && t.session_close > date))).length;
}

function shell(title, body, active) {
  const zone = zoneLabel();
  const syncAt = state.sync?.last_successful_sync
    ? formatLocal(state.sync.last_successful_sync)
    : "not recorded";
  return h("div", { class: "shell" },
    h("header", { class: "top" },
      h("div", { class: "top-row" },
        h("div", {},
          h("p", { class: "eyebrow" }, "Paper journal"),
          h("h1", {}, title),
        ),
        h("button", { class: "icon-btn", type: "button", onclick: () => refresh(), "aria-label": "Refresh saved files" }, "Refresh"),
      ),
      h("p", { class: "sub" }, `Times in ${zone.name} (${zone.zone}). Sessions are New York dates. Last sync ${syncAt}.`),
    ),
    state.toast ? h("p", { class: "toast", role: "status" }, state.toast) : null,
    state.error ? h("p", { class: "banner bad", role: "alert" }, state.error) : null,
    body,
    h("nav", { class: "nav", "aria-label": "Sections" },
      navBtn("Month", "#/", active === "month"),
      navBtn("Insights", "#/insights", active === "insights"),
      navBtn("Week", "#/week", active === "week"),
      navBtn("Settings", "#/settings", active === "settings"),
    ),
  );
}

function navBtn(label, hash, on) {
  return h("button", {
    type: "button",
    class: on ? "nav-btn on" : "nav-btn",
    onclick: () => go(hash === "#/" ? monthHash(currentMonth()) : hash),
  }, label);
}

function currentMonth() {
  const r = route();
  if (r.name === "month" && r.y) return { y: r.y, m: r.m };
  const asOf = state.index?.as_of || "2026-11-12";
  const [y, m] = asOf.split("-").map(Number);
  return { y, m };
}

function monthHash(cursor) {
  return `#/${cursor.y}/${String(cursor.m).padStart(2, "0")}`;
}

function renderMonth() {
  const cursor = currentMonth();
  const title = `${monthName(cursor.m)} ${cursor.y}`;
  const cells = monthCells(cursor.y, cursor.m);
  const rows = (state.index?.days || []).filter((d) => d.date.startsWith(`${cursor.y}-${String(cursor.m).padStart(2, "0")}`));
  const traded = rows.filter((d) => d.sync_status === "synced" || d.sync_status === "partial");
  const pnlRows = traded.filter((d) => d.tile_pnl != null && d.file);
  const net = pnlRows.reduce((s, d) => s + Number(d.tile_pnl), 0);
  const completed = traded.reduce((s, d) => s + Number(d.completed_trades || 0), 0);
  const wins = traded.reduce((s, d) => s + Number(d.wins || 0), 0);
  const profitDays = pnlRows.filter((d) => Number(d.tile_pnl) > 0).length;
  const lossDays = pnlRows.filter((d) => Number(d.tile_pnl) < 0).length;
  const failed = rows.filter((d) => d.sync_status === "failed").length;
  const before = state.meta?.no_fills_before || state.index?.no_fills_before;
  const monthStart = isoDate(cursor.y, cursor.m, 1);
  const intro = pnlRows.length
    ? "Open a day for the fills, the charts, and the LE review."
    : before && monthStart < before.slice(0, 7)
      ? `No imported fills before ${before}. Empty weekdays are not marked as no-trade days unless the sync file says so.`
      : "No journal file for this month yet. Future weekdays stay blank until your assistant commits a session.";

  const body = h("div", {},
    h("div", { class: "month-bar" },
      h("button", { class: "text-btn", type: "button", onclick: () => go(monthHash(shiftMonth(cursor.y, cursor.m, -1))) }, "Previous"),
      h("h2", {}, title),
      h("button", { class: "text-btn", type: "button", onclick: () => go(monthHash(shiftMonth(cursor.y, cursor.m, 1))) }, "Next"),
    ),
    h("p", { class: "lede" }, intro),
    h("div", { class: "metrics" },
      metric("Realized P&L", pnlRows.length ? money(net, true) : "—", net >= 0 ? "good" : "bad"),
      metric("Completed", String(completed), ""),
      metric("Win rate", completed ? `${wins} of ${completed}` : "—", ""),
      metric("Profit / loss days", pnlRows.length ? `${profitDays} / ${lossDays}` : "—", ""),
    ),
    failed ? h("p", { class: "banner warn" }, `${failed} day${failed === 1 ? "" : "s"} failed to import. Open the tile for the message.`) : null,
    h("button", { class: "linkish", type: "button", onclick: () => { state.info = true; render(); } }, "What these numbers mean"),
    sparkline(rows),
    h("div", { class: "cal", role: "grid", "aria-label": `${title} Monday to Friday` },
      ["Mon", "Tue", "Wed", "Thu", "Fri"].map((name) => h("div", { class: "dow", role: "columnheader" }, name)),
      cells.map((d, i) => d == null ? h("div", { class: "tile blank", key: i }) : tile(cursor.y, cursor.m, d)),
    ),
    h("ul", { class: "legend" },
      h("li", {}, h("i", { class: "swatch up" }), "Profit"),
      h("li", {}, h("i", { class: "swatch down" }), "Loss"),
      h("li", {}, h("i", { class: "swatch flat" }), "No trades"),
      h("li", {}, h("i", { class: "swatch warn" }), "Import problem"),
      h("li", {}, h("i", { class: "swatch shut" }), "Closed or early"),
    ),
    h("div", { class: "row-actions" },
      h("button", { class: "text-btn", type: "button", onclick: () => go("#/plan") }, "New pre-trade plan"),
    ),
    state.info ? infoDialog() : null,
  );
  app.replaceChildren(shell(state.index?.title || "Webull Trading Journal", body, "month"));
}

function metric(label, value, tone) {
  return h("div", { class: "metric" },
    h("span", { class: "metric-label" }, label),
    h("strong", { class: tone ? `metric-value ${tone}` : "metric-value" }, value),
  );
}

function sparkline(rows) {
  const points = [];
  const withBal = rows.filter((d) => d.balance_close != null).sort((a, b) => a.date.localeCompare(b.date));
  if (!withBal.length) return null;
  if (withBal[0].starting_cash != null) points.push({ label: "Start", value: Number(withBal[0].starting_cash) });
  for (const row of withBal) points.push({ label: row.date.slice(8), value: Number(row.balance_close) });
  if (points.length < 2) return null;
  const w = 320;
  const ht = 72;
  const min = Math.min(...points.map((p) => p.value));
  const max = Math.max(...points.map((p) => p.value));
  const span = max - min || 1;
  const coords = points.map((p, i) => {
    const x = 8 + (i * (w - 16)) / (points.length - 1);
    const y = 8 + (1 - (p.value - min) / span) * (ht - 16);
    return `${x},${y}`;
  }).join(" ");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${w} ${ht}`);
  svg.setAttribute("class", "spark");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Closing balance from ${money(points[0].value)} to ${money(points[points.length - 1].value)}`);
  const poly = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  poly.setAttribute("points", coords);
  poly.setAttribute("fill", "none");
  poly.setAttribute("stroke", "#8eb4ff");
  poly.setAttribute("stroke-width", "2");
  svg.append(poly);
  return h("figure", { class: "equity" }, svg, h("figcaption", {}, "Closing balance on imported days. Not a forecast."));
}

function tile(y, m, d) {
  const date = isoDate(y, m, d);
  const row = dayRow(date);
  const closed = holiday(date);
  const early = earlyClose(date);
  const status = row?.sync_status || (state.sync?.days || {})[date]?.status || "";
  const message = row?.sync_message || (state.sync?.days || {})[date]?.message || "";
  const open = openCount(date, row);
  const pnl = row && row.tile_pnl != null && row.file ? Number(row.tile_pnl) : null;
  let tone = "empty";
  if (closed) tone = "shut";
  else if (status === "failed" || status === "partial") tone = "warn";
  else if (status === "no_trades") tone = "flat";
  else if (pnl != null && pnl > 0) tone = "up";
  else if (pnl != null && pnl < 0) tone = "down";
  else if (pnl === 0) tone = "flat";
  const labelBits = [date];
  if (closed) labelBits.push(closed.name);
  if (pnl != null) labelBits.push(money(pnl, true));
  if (status) labelBits.push(status);
  return h("button", {
    type: "button",
    class: `tile ${tone}${early ? " early" : ""}${open ? " has-open" : ""}`,
    onclick: () => go(`#/day/${date}`),
    "aria-label": labelBits.join(", "),
  },
    h("span", { class: "dnum" }, String(d), closed ? " · closed" : early ? " · early" : ""),
    closed ? h("span", { class: "muted" }, closed.name) : null,
    !closed && pnl != null ? h("span", { class: "pnl" }, money(pnl, true)) : null,
    !closed && status === "no_trades" ? h("span", { class: "muted" }, "No trades") : null,
    !closed && status === "failed" ? h("span", { class: "warn-text" }, "Import failed") : null,
    !closed && status === "partial" ? h("span", { class: "warn-text" }, "Incomplete") : null,
    !closed && row && row.file && status !== "failed" ? h("span", { class: "tiny" }, `${row.completed_trades} done · ${row.wins}W ${row.losses}L`) : null,
    !closed && row?.bot_grade ? h("span", { class: "tiny" }, row.bot_grade) : null,
    open ? h("span", { class: "pill" }, "Open") : null,
    early && !closed ? h("span", { class: "tiny" }, `Closes ${early.close_et} ET`) : null,
    message && (status === "failed" || status === "partial") ? h("span", { class: "tiny clamp" }, message) : null,
  );
}

function infoDialog() {
  return h("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": "Metric definitions" },
    h("div", { class: "sheet" },
      h("h2", {}, "What the month counts"),
      h("dl", { class: "defs" },
        def("Realized P&L", "Sum of the tile figures. A tile uses the broker account day P&L when the import included one. Otherwise it sums realized P&L from closes that New York session. Open quantity is not included."),
        def("Completed trade", "A position that went flat. Adds and partial exits stay in the same trade until it is flat. A partial exit realizes P&L that day but is not a win or a loss yet."),
        def("Win rate", "Winning completed trades divided by completed trades. Breakeven is not a win. Open trades are left out."),
        def("Profit and loss days", "Sessions whose tile P&L is above zero, and sessions below zero. No-trade days, flat days, and failed imports are neither."),
        def("Fees", "Subtracted only when every fill in the trade itemized them. If the broker omitted fees, they stay unknown."),
        def("Imported grade", "The session builder's word, such as Mixed. It is not your execution grade."),
      ),
      h("button", { class: "icon-btn", type: "button", onclick: () => { state.info = false; render(); } }, "Close"),
    ),
  );
}

function def(term, text) {
  return [h("dt", {}, term), h("dd", {}, text)];
}

async function renderDay(date) {
  const row = dayRow(date);
  const closed = holiday(date);
  const early = earlyClose(date);
  const status = row?.sync_status || state.sync?.days?.[date]?.status || (closed ? "closed" : "");
  const message = row?.sync_message || state.sync?.days?.[date]?.message || "";
  let day = state.dayCache[date] || null;
  if (row?.file && !day) {
    app.replaceChildren(shell("Session", h("p", { class: "lede" }, "Opening the session…"), "month"));
    try {
      day = await loadJson(`data/${row.file}`);
      state.dayCache[date] = day;
    } catch (err) {
      state.error = `Could not load ${date}. ${err.message}. Ask your assistant to re-sync if the file is missing.`;
    }
  }
  const userDay = edits().days?.[date] || {};
  const trades = (state.book?.trades || []).filter((t) => t.session_open === date || t.session_close === date);
  const held = (state.book?.trades || []).filter((t) => t.status === "open" && t.session_open <= date);
  const title = new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  const parts = [
    h("button", { class: "back", type: "button", onclick: () => go(monthHash({ y: Number(date.slice(0, 4)), m: Number(date.slice(5, 7)) })) }, "Back"),
    h("div", { class: "day-head" },
      h("h2", {}, title),
      statusPill(status || (closed ? "closed" : "unmarked")),
    ),
  ];
  if (closed) parts.push(h("p", { class: "banner" }, `${closed.name}. The stock market is closed.`));
  if (early) parts.push(h("p", { class: "banner" }, `${early.name}. Early close ${early.close_et} ET.`));
  if (status === "failed" || status === "partial") {
    parts.push(h("p", { class: "banner warn" }, message || "This session is incomplete."));
  }
  if (status === "no_trades") parts.push(h("p", { class: "banner" }, message || "Synced as a no-trade day."));
  if (!row && !closed) parts.push(h("p", { class: "lede" }, "No file for this session. Refresh only reloads what is already on the site. Ask your assistant to re-sync if it should be here."));

  if (day) {
    const broker = day.broker_day_pnl;
    const fifo = row?.fifo_realized_pnl;
    const wins = trades.filter((t) => t.outcome === "win" && t.session_close === date);
    const losses = trades.filter((t) => t.outcome === "loss" && t.session_close === date);
    const flats = trades.filter((t) => t.outcome === "breakeven" && t.session_close === date);
    const done = wins.length + losses.length + flats.length;
    parts.push(h("div", { class: "metrics" },
      metric("Broker day P&L", money(broker, true), Number(broker) > 0 ? "good" : Number(broker) < 0 ? "bad" : ""),
      metric("FIFO realized", money(fifo, true), ""),
      metric("Fees", feesLine(trades), ""),
      metric("Completed", String(done), ""),
      metric("W / L / BE", `${wins.length} / ${losses.length} / ${flats.length}`, ""),
      metric("Open", String(held.length), ""),
    ));
    if (day.broker_day_pnl_source) parts.push(h("p", { class: "fine" }, `Broker source: ${day.broker_day_pnl_source}`));
    if (day.balance_close != null) parts.push(h("p", { class: "fine" }, `Close ${money(day.balance_close)} · start ${money(day.starting_cash)}`));
    parts.push(botCard(day));
    if (day.charts?.underlying || day.charts?.option_5m || day.charts?.option) parts.push(chartBlock(day));
    parts.push(timeline(day));
  }

  if (held.length) {
    parts.push(h("section", { class: "card" },
      h("h3", {}, "Open positions"),
      h("p", { class: "fine" }, "Still open. Not counted as wins or losses. Unrealized P&L is not estimated."),
      ...held.map(tradeCard),
    ));
  }
  const closedTrades = trades.filter((t) => t.status === "closed");
  if (closedTrades.length) {
    parts.push(h("section", { class: "card" },
      h("h3", {}, "Completed trades"),
      ...closedTrades.map((t) => tradeCard(t, day, userDay)),
    ));
  }

  parts.push(reflectBlock(date, day, trades, userDay));
  parts.push(notesBlock(date, userDay));
  parts.push(plansBlock(date));

  if (route().name !== "day" || route().date !== date) return;
  app.replaceChildren(shell("Session", h("div", { class: "day" }, parts), "month"));
  mountDayCharts(day);
}

function feesLine(trades) {
  if (!trades.length) return "—";
  if (trades.every((t) => t.fees_known && t.fees != null)) {
    const sum = trades.reduce((s, t) => s + Number(t.fees || 0), 0);
    return money(sum);
  }
  return "Unknown";
}

function statusPill(status) {
  const label = {
    synced: "Synced",
    no_trades: "No trades",
    failed: "Failed",
    partial: "Incomplete",
    closed: "Market closed",
    unmarked: "Not imported",
  }[status] || status;
  return h("span", { class: `pill status-${status}` }, label);
}

function botCard(day) {
  const bot = day.bot_journal || {};
  return h("section", { class: "card" },
    h("div", { class: "section-title" },
      h("h3", {}, "Imported journal"),
      bot.grade ? h("span", { class: "pill" }, bot.grade) : null,
    ),
    h("p", { class: "fine" }, bot.caveat || "Imported from the session file. This is not your execution grade."),
    bot.notes ? h("p", {}, bot.notes) : null,
    (bot.lessons || []).length ? h("ol", { class: "lessons" }, ...bot.lessons.map((line) => h("li", {}, line))) : null,
    ...(bot.trades || []).map((trade) => h("div", { class: "imported-rules" },
      h("p", { class: "fine" }, trade.contract || trade.underlying || "Trade"),
      listBlock("Builder said these fit", trade.rules_followed),
      listBlock("Builder said these broke", trade.rules_broken),
      listBlock("Builder could not check", trade.rules_unverified),
      trade.size_note ? h("p", { class: "fine" }, trade.size_note) : null,
    )),
  );
}

function listBlock(title, items) {
  if (!items || !items.length) return null;
  return h("div", {}, h("p", { class: "k" }, title), h("ul", {}, ...items.map((item) => h("li", {}, item))));
}

function chartBlock(day) {
  const und = day.charts?.underlying;
  const opt = day.charts?.option_5m || day.charts?.option;
  return h("section", { class: "card" },
    h("div", { class: "section-title" },
      h("h3", {}, "Charts"),
      h("div", { class: "seg", role: "group", "aria-label": "Chart window" },
        seg("Around fills", "fills"),
        seg("Full session", "session"),
      ),
    ),
    und ? h("div", { class: "chart-block" },
      h("h4", {}, `${und.symbol || "Underlying"} · ${und.timeframe || "10m"}`),
      h("div", { class: "chart-host", "data-chart": "underlying" }),
      h("p", { class: "fine", "data-readout": "1" }, "Loading chart…"),
      und.timeframe_note ? h("p", { class: "fine" }, und.timeframe_note) : null,
    ) : null,
    opt ? h("div", { class: "chart-block" },
      h("h4", {}, `${opt.symbol || "Option"} · ${opt.timeframe || "5m"}`),
      h("div", { class: "chart-host", "data-chart": "option" }),
      h("p", { class: "fine", "data-readout": "1" }, "Loading chart…"),
      opt.note ? h("p", { class: "fine" }, opt.note) : null,
    ) : null,
  );
}

function seg(label, value) {
  return h("button", {
    type: "button",
    class: state.chartRange === value ? "seg-btn on" : "seg-btn",
    onclick: () => { state.chartRange = value; render(); },
  }, label);
}

function mountDayCharts(day) {
  if (state.charts) state.charts.remove();
  state.charts = null;
  if (!day) return;
  requestAnimationFrame(() => {
    const root = app;
    if (!root.querySelector("[data-chart]")) return;
    state.charts = mountCharts(root, day, state.chartRange);
  });
}

function timeline(day) {
  const fills = [...(day.executions || [])].sort((a, b) => String(a.time_utc).localeCompare(String(b.time_utc)));
  if (!fills.length) return null;
  return h("section", { class: "card" },
    h("h3", {}, "Executions"),
    h("p", { class: "fine" }, `Local time first (${localZone()}). New York time under it. Raw fills, not combined.`),
    h("ol", { class: "timeline" }, ...fills.map((fill) => h("li", {},
      h("strong", {}, `${fill.side} ${fill.qty} @ ${fill.price}`),
      h("span", {}, formatLocal(fill.time_utc)),
      h("span", { class: "fine" }, `NY ${formatEt(fill.time_utc)}`),
      h("span", { class: "tiny" }, fill.occ_symbol || fill.underlying || ""),
    ))),
  );
}

function tradeCard(trade, day, userDay) {
  const user = userDay?.trades?.[trade.trade_id] || {};
  const review = applyUserReview(buildReview(trade, day, state.criteria), user.le || null);
  if (user.execution_grade) review.execution_grade = { value: user.execution_grade, origin: "user_note" };
  const plan = (edits().plans || []).find((p) => p.trade_id === trade.trade_id);
  const r = rMultiple(trade, plan);
  const contract = [trade.underlying, trade.expiry, trade.strike, trade.option_type].filter((x) => x != null && x !== "").join(" ");
  return h("article", { class: "trade" },
    h("header", { class: "trade-head" },
      h("h4", {}, contract || trade.instrument_key),
      h("span", { class: trade.outcome === "win" ? "pill good" : trade.outcome === "loss" ? "pill bad" : "pill" }, trade.status === "open" ? "Open" : (trade.outcome || trade.status)),
    ),
    h("dl", { class: "kv" },
      pair("Direction", trade.direction),
      pair("Qty", `${trade.qty_closed} closed / ${trade.qty_opened} opened`),
      pair("Entry", formatLocal(trade.opened_at)),
      pair("Exit", trade.closed_at ? formatLocal(trade.closed_at) : "Still open"),
      pair("Avg entry", trade.avg_entry == null ? "—" : String(trade.avg_entry)),
      pair("Avg exit", trade.avg_exit == null ? "—" : String(trade.avg_exit)),
      pair("Fees", trade.fees_known ? money(trade.fees) : "Unknown"),
      pair("P&L", `${money(trade.realized_pnl, true)} (${trade.pnl_source || "no close"})`),
      pair("P&L %", trade.pnl_pct == null ? "—" : `${trade.pnl_pct}%`),
      pair("Gross", money(trade.gross_pnl, true)),
      pair("Duration", durationLabel(trade.duration_seconds)),
      pair("Adds", String(trade.add_count || 0)),
      pair("Partials", String(trade.partial_exit_count || 0)),
    ),
    h("p", { class: "fine" }, `NY entry ${formatEt(trade.opened_at)}${trade.closed_at ? ` · NY exit ${formatEt(trade.closed_at)}` : ""}`),
    trade.legs?.some((leg) => leg.effect === "add" || leg.effect === "partial_exit")
      ? h("ul", { class: "legs" }, ...trade.legs.map((leg) => h("li", {}, `${leg.effect} · ${leg.side} ${leg.qty} @ ${leg.price} · ${formatLocal(leg.time_utc)}`)))
      : null,
    h("label", { class: "field" }, "Execution grade",
      h("select", {
        onchange: (e) => patchEdits((doc) => {
          const slot = ensureTrade(doc, trade.session_close || trade.session_open, trade.trade_id);
          slot.execution_grade = e.target.value;
        }),
      }, ...GRADE_CHOICES.map(([value, label]) => h("option", { value, selected: review.execution_grade.value === value ? "selected" : null }, label))),
    ),
    h("p", { class: "fine" }, "Execution grade is separate from P&L. The imported journal grade stays in the builder section."),
    leBlock(trade, review),
    h("div", { class: "suggest" },
      h("p", { class: "k" }, "Suggestions"),
      h("ul", {}, ...suggestionLines(trade, review).map((line) => h("li", {}, line))),
    ),
    h("p", { class: "fine" }, r.text),
    plan ? h("p", { class: "fine" }, `Linked plan: ${plan.ticker || "untitled"} · ${plan.timing || "untimed"}`) : null,
  );
}

function pair(k, v) {
  return [h("dt", {}, k), h("dd", {}, v)];
}

function ensureTrade(doc, date, tradeId) {
  doc.days[date] = doc.days[date] || {};
  doc.days[date].trades = doc.days[date].trades || {};
  doc.days[date].trades[tradeId] = doc.days[date].trades[tradeId] || {};
  doc.days[date].trades[tradeId].le = doc.days[date].trades[tradeId].le || {};
  return doc.days[date].trades[tradeId];
}

function leBlock(trade, review) {
  const date = trade.session_close || trade.session_open;
  return h("div", { class: "le" },
    h("h4", {}, "LE review"),
    h("label", { class: "field" }, "Setup",
      h("select", {
        onchange: (e) => patchEdits((doc) => { ensureTrade(doc, date, trade.trade_id).le.setup_type = e.target.value; }),
      }, ...SETUP_CHOICES.map(([value, label]) => h("option", { value, selected: review.setup_type.value === value ? "selected" : null }, label))),
    ),
    h("p", { class: "origin" }, originLabel(review.setup_type.origin)),
    ...review.rows.map((line) => h("div", { class: "check" },
      h("div", { class: "check-top" },
        h("strong", {}, line.label),
        h("span", { class: `badge g-${line.grade}` }, line.grade),
        line.needs_confirmation ? h("span", { class: "badge confirm" }, "Needs your confirmation") : null,
      ),
      h("p", {}, line.value),
      line.detail ? h("p", { class: "fine" }, line.detail) : null,
      h("p", { class: "origin" }, originLabel(line.origin)),
    )),
    textField("Entry reason", review.entry_reason, (value) => patchEdits((doc) => { ensureTrade(doc, date, trade.trade_id).le.entry_reason = value; })),
    textField("Planned stop", review.planned_stop, (value) => patchEdits((doc) => { ensureTrade(doc, date, trade.trade_id).le.planned_stop = value; })),
    textField("Planned target", review.planned_target, (value) => patchEdits((doc) => { ensureTrade(doc, date, trade.trade_id).le.planned_target = value; })),
    h("p", { class: "fine" }, `Actual exit · ${originLabel(review.actual_exit.origin)}: ${review.actual_exit.value}`),
    textField("Followed the plan?", review.followed_plan, (value) => patchEdits((doc) => { ensureTrade(doc, date, trade.trade_id).le.followed_plan = value; })),
    textField("Mistakes", review.mistakes, (value) => patchEdits((doc) => { ensureTrade(doc, date, trade.trade_id).le.mistakes = value; })),
    textField("Emotions", review.emotions, (value) => patchEdits((doc) => { ensureTrade(doc, date, trade.trade_id).le.emotions = value; })),
    textField("Lesson", review.lessons, (value) => patchEdits((doc) => { ensureTrade(doc, date, trade.trade_id).le.lessons = value; })),
    h("label", { class: "field" }, "Screenshot link",
      h("input", {
        type: "url",
        placeholder: "https://…",
        onchange: (e) => {
          const href = e.target.value.trim();
          if (!href) return;
          patchEdits((doc) => {
            const le = ensureTrade(doc, date, trade.trade_id).le;
            le.screenshot_links = [...(le.screenshot_links || []), href];
          });
          e.target.value = "";
          render();
        },
      }),
    ),
    h("p", { class: "fine" }, "Screenshots are links only. The file itself is not stored in the journal."),
    ...(review.screenshot_links || []).map((href) => h("a", { href, target: "_blank", rel: "noreferrer" }, href)),
  );
}

function originLabel(origin) {
  return {
    imported_fact: "Imported fact",
    calculation: "Calculation",
    automated_interpretation: "Automated interpretation",
    user_note: "Your note",
    needs_review: "Needs review",
    insufficient_data: "Insufficient data",
  }[origin] || origin;
}

function textField(label, model, onvalue) {
  return h("label", { class: "field" }, label,
    h("textarea", {
      rows: "2",
      oninput: (e) => onvalue(e.target.value),
    }, model?.value || ""),
    h("span", { class: "origin" }, originLabel(model?.origin)),
  );
}

function reflectBlock(date, day, trades, userDay) {
  const review = trades[0] && day ? buildReview(trades[0], day, state.criteria) : null;
  const lines = [];
  for (const trade of trades) {
    if (!day) break;
    const built = buildReview(trade, day, state.criteria);
    for (const line of suggestionLines(trade, built)) {
      if (!lines.includes(line)) lines.push(line);
    }
  }
  if (!lines.length) lines.push(trades.length ? "No further suggestion from the imported facts." : "Not enough data for an end-of-day suggestion.");
  return h("section", { class: "card" },
    h("h3", {}, "End of day"),
    h("p", { class: "k" }, "Suggestions"),
    h("ul", {}, ...lines.map((line) => h("li", {}, line))),
    h("label", { class: "field" }, "Your reflection",
      h("textarea", {
        rows: "4",
        oninput: (e) => patchEdits((doc) => {
          doc.days[date] = doc.days[date] || {};
          doc.days[date].eod_reflection = e.target.value;
        }),
      }, userDay.eod_reflection || ""),
    ),
    h("p", { class: "fine", "data-save-state": "1" }, "Edits stay on this phone until you export them."),
    review ? null : null,
  );
}

function notesBlock(date, userDay) {
  return h("section", { class: "card" },
    h("h3", {}, "Your notes"),
    h("label", { class: "field" }, "Session note",
      h("textarea", {
        rows: "3",
        placeholder: "No-trade note, context, anything the import should not overwrite.",
        oninput: (e) => patchEdits((doc) => {
          doc.days[date] = doc.days[date] || {};
          doc.days[date].notes = e.target.value;
        }),
      }, userDay.notes || ""),
    ),
  );
}

function plansBlock(date) {
  const plans = (edits().plans || []).filter((p) => !date || p.session_date === date || !p.session_date);
  return h("section", { class: "card" },
    h("div", { class: "section-title" },
      h("h3", {}, "Pre-trade plans"),
      h("button", { class: "text-btn", type: "button", onclick: () => go(`#/plan/${date || ""}`) }, "Add"),
    ),
    plans.length ? plans.map(planCard) : h("p", { class: "fine" }, "None linked yet."),
  );
}

function planCard(plan) {
  return h("article", { class: "plan" },
    h("p", {}, h("strong", {}, plan.ticker || "Untitled"), " · ", plan.timing === "after" ? "After the trade" : "Before the trade"),
    h("p", { class: "fine" }, formatLocal(plan.created_at)),
    plan.setup ? h("p", {}, plan.setup) : null,
    plan.entry_idea ? h("p", {}, plan.entry_idea) : null,
    h("p", { class: "fine" }, `Stop ${plan.planned_stop || "—"} · target ${plan.planned_target || "—"} · size ${plan.size || "—"}`),
    plan.reasoning ? h("p", {}, plan.reasoning) : null,
  );
}

function renderPlan(date) {
  const trades = date ? (state.book?.trades || []).filter((t) => t.session_open === date || t.session_close === date) : (state.book?.trades || []);
  const form = {
    ticker: "",
    setup: "",
    entry_idea: "",
    planned_entry: "",
    planned_stop: "",
    planned_target: "",
    stop_unit: "premium",
    size: "",
    reasoning: "",
    timing: "before",
    trade_id: "",
    session_date: date || "",
  };
  const body = h("form", {
    class: "card form",
    onsubmit: (e) => {
      e.preventDefault();
      const data = new FormData(e.target);
      const plan = {
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
        session_date: String(data.get("session_date") || ""),
        timing: String(data.get("timing") || "before"),
        ticker: String(data.get("ticker") || ""),
        setup: String(data.get("setup") || ""),
        entry_idea: String(data.get("entry_idea") || ""),
        planned_entry: String(data.get("planned_entry") || ""),
        planned_stop: String(data.get("planned_stop") || ""),
        planned_target: String(data.get("planned_target") || ""),
        stop_unit: String(data.get("stop_unit") || "premium"),
        size: String(data.get("size") || ""),
        reasoning: String(data.get("reasoning") || ""),
        trade_id: String(data.get("trade_id") || ""),
      };
      patchEdits((doc) => { doc.plans = [...(doc.plans || []), plan]; });
      go(plan.session_date ? `#/day/${plan.session_date}` : "#/");
    },
  },
    h("button", { class: "back", type: "button", onclick: () => history.back() }, "Back"),
    h("h2", {}, "Pre-trade plan"),
    h("p", { class: "fine" }, "Saved on this phone and included in the edits export. Timing is labeled so a note written afterward is not mistaken for a plan."),
    labeled("Ticker", h("input", { name: "ticker", required: "required", value: form.ticker })),
    labeled("When", h("select", { name: "timing" },
      h("option", { value: "before" }, "Before the trade"),
      h("option", { value: "after" }, "After the trade"),
    )),
    labeled("Session date", h("input", { name: "session_date", type: "date", value: date || "" })),
    labeled("Setup", h("input", { name: "setup", placeholder: "Level retest, 8 EMA, gap-down, or your words" })),
    labeled("Entry idea", h("textarea", { name: "entry_idea", rows: "3" })),
    labeled("Planned entry (number)", h("input", { name: "planned_entry", inputmode: "decimal", placeholder: "Premium if this is an option" })),
    labeled("Planned stop (number)", h("input", { name: "planned_stop", inputmode: "decimal" })),
    labeled("Stop is on", h("select", { name: "stop_unit" },
      h("option", { value: "premium" }, "The option premium"),
      h("option", { value: "underlying" }, "The underlying"),
    )),
    labeled("Planned target", h("input", { name: "planned_target" })),
    labeled("Size", h("input", { name: "size", placeholder: "Contracts or dollars" })),
    labeled("Reasoning", h("textarea", { name: "reasoning", rows: "3" })),
    labeled("Link to a trade", h("select", { name: "trade_id" },
      h("option", { value: "" }, "None yet"),
      ...trades.map((t) => h("option", { value: t.trade_id }, `${t.underlying || ""} ${t.opened_at?.slice(0, 16) || ""}`)),
    )),
    h("button", { class: "icon-btn", type: "submit" }, "Save plan"),
  );
  app.replaceChildren(shell("Plan", body, "month"));
}

function labeled(text, control) {
  return h("label", { class: "field" }, text, control);
}

function renderInsights() {
  const closed = (state.book?.trades || []).filter((t) => t.status === "closed" && t.outcome);
  const wins = closed.filter((t) => t.outcome === "win");
  const losses = closed.filter((t) => t.outcome === "loss");
  const avg = (list) => list.length ? list.reduce((s, t) => s + Number(t.realized_pnl), 0) / list.length : null;
  const dates = closed.flatMap((t) => [t.session_open, t.session_close]).filter(Boolean).sort();
  const range = dates.length ? `${dates[0]} to ${dates[dates.length - 1]}` : "No completed trades";
  const byTicker = groupBy(closed, (t) => t.underlying || "Unknown");
  const bySetup = groupBy(closed, (t) => setupOf(t) || "Not set");
  const days = (state.index?.days || []).filter((d) => d.file && d.tile_pnl != null && d.sync_status !== "failed");
  const best = days.reduce((a, b) => (a == null || Number(b.tile_pnl) > Number(a.tile_pnl) ? b : a), null);
  const worst = days.reduce((a, b) => (a == null || Number(b.tile_pnl) < Number(a.tile_pnl) ? b : a), null);
  const mistakes = mistakeLines();
  const rules = edits().personal_rules || {};
  const body = h("div", {},
    h("h2", {}, "Insights"),
    h("p", { class: "lede" }, `${closed.length} completed trade${closed.length === 1 ? "" : "s"} · ${range}.`),
    closed.length < 10 ? h("p", { class: "banner warn" }, "Small sample. These figures describe this journal only. They are not a forecast.") : h("p", { class: "fine" }, "These figures describe this journal only. They are not a forecast."),
    h("div", { class: "metrics" },
      metric("Win rate", closed.length ? `${wins.length} of ${closed.length}` : "—", ""),
      metric("Avg win", money(avg(wins), true), wins.length ? "good" : ""),
      metric("Avg loss", money(avg(losses), true), losses.length ? "bad" : ""),
    ),
    h("section", { class: "card" },
      h("h3", {}, "By ticker"),
      bucketTable(byTicker),
    ),
    h("section", { class: "card" },
      h("h3", {}, "By setup"),
      h("p", { class: "fine" }, "Setup comes from your LE review. Unset trades stay in Not set."),
      bucketTable(bySetup),
    ),
    h("section", { class: "card" },
      h("h3", {}, "Best and worst days"),
      best ? h("p", {}, `Best ${best.date}: ${money(best.tile_pnl, true)} (${best.tile_pnl_source === "broker_day" ? "broker day" : "FIFO"})`) : h("p", {}, "No imported day P&L yet."),
      worst && worst !== best ? h("p", {}, `Worst ${worst.date}: ${money(worst.tile_pnl, true)}`) : null,
    ),
    h("section", { class: "card" },
      h("h3", {}, "Mistakes you wrote down"),
      mistakes.length ? h("ul", {}, ...mistakes.map((m) => h("li", {}, `${m.text} `, h("span", { class: "fine" }, `(${m.n})`)))) : h("p", { class: "fine" }, "None yet. The journal does not invent them."),
    ),
    h("section", { class: "card" },
      h("h3", {}, "Your rules"),
      rulesInsight(rules, days),
    ),
  );
  app.replaceChildren(shell("Insights", body, "insights"));
}

function setupOf(trade) {
  const date = trade.session_close || trade.session_open;
  const value = edits().days?.[date]?.trades?.[trade.trade_id]?.le?.setup_type;
  const found = SETUP_CHOICES.find(([id]) => id === value);
  if (!found || found[0] === "unsure") return value === "unsure" ? "Unsure" : "";
  return found[1];
}

function groupBy(list, keyFn) {
  const map = new Map();
  for (const item of list) {
    const key = keyFn(item) || "Not set";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return [...map.entries()];
}

function bucketTable(groups) {
  if (!groups.length) return h("p", { class: "fine" }, "Not enough data.");
  return h("div", { class: "table-wrap" },
    h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "Group"), h("th", {}, "n"), h("th", {}, "Wins"), h("th", {}, "Avg P&L"))),
      h("tbody", {}, ...groups.map(([name, list]) => {
        const wins = list.filter((t) => t.outcome === "win").length;
        const avg = list.reduce((s, t) => s + Number(t.realized_pnl || 0), 0) / list.length;
        return h("tr", {}, h("td", {}, name), h("td", {}, String(list.length)), h("td", {}, String(wins)), h("td", {}, money(avg, true)));
      })),
    ),
  );
}

function mistakeLines() {
  const counts = new Map();
  for (const [date, day] of Object.entries(edits().days || {})) {
    for (const trade of Object.values(day.trades || {})) {
      const text = (trade.le?.mistakes || "").trim();
      if (!text) continue;
      counts.set(text, (counts.get(text) || 0) + 1);
    }
  }
  return [...counts.entries()].map(([text, n]) => ({ text, n })).sort((a, b) => b.n - a.n);
}

function rulesInsight(rules, days) {
  const bits = [];
  if (rules.daily_trade_limit == null && rules.daily_loss_limit == null && !(rules.custom_rules || []).length) {
    return h("p", { class: "fine" }, "No personal rules yet. His example limits are not filled in. Add your own under Settings.");
  }
  if (rules.daily_trade_limit != null && rules.daily_trade_limit !== "") {
    const limit = Number(rules.daily_trade_limit);
    const over = days.filter((d) => Number(d.completed_trades) > limit);
    bits.push(h("p", {}, `${over.length} imported day${over.length === 1 ? "" : "s"} closed more than ${limit} trade${limit === 1 ? "" : "s"}.`));
  }
  if (rules.daily_loss_limit != null && rules.daily_loss_limit !== "") {
    const limit = Math.abs(Number(rules.daily_loss_limit));
    const over = days.filter((d) => d.tile_pnl != null && Number(d.tile_pnl) <= -limit);
    bits.push(h("p", {}, `${over.length} imported day${over.length === 1 ? "" : "s"} lost at least ${money(limit)} on the tile figure.`));
  }
  for (const rule of rules.custom_rules || []) {
    bits.push(h("p", {}, `“${rule.text || rule}” is written down. Free-text rules are not auto-scored.`));
  }
  return h("div", {}, ...bits);
}

function renderWeek() {
  const current = route();
  const asOf = state.index?.as_of || "2026-11-12";
  const week = current.week || isoWeekKey(asOf);
  const days = weekDates(week);
  const [start, end] = [days[0], days[6]];
  const trades = (state.book?.trades || []).filter((t) => t.status === "closed" && t.session_close >= start && t.session_close <= end);
  const saved = edits().weekly_reviews?.[week] || {};
  const enough = trades.length >= 3;
  const prev = shiftWeek(week, -1);
  const next = shiftWeek(week, 1);
  const field = (key, label) => h("label", { class: "field" }, label,
    h("textarea", {
      rows: "3",
      oninput: (e) => patchEdits((doc) => {
        doc.weekly_reviews[week] = doc.weekly_reviews[week] || {};
        doc.weekly_reviews[week][key] = e.target.value;
      }),
    }, saved[key] || ""),
  );
  const body = h("div", {},
    h("div", { class: "month-bar" },
      h("button", { class: "text-btn", type: "button", onclick: () => go(`#/week/${prev}`) }, "Previous"),
      h("h2", {}, week),
      h("button", { class: "text-btn", type: "button", onclick: () => go(`#/week/${next}`) }, "Next"),
    ),
    h("p", { class: "fine" }, `${start} to ${end} · ${trades.length} completed trade${trades.length === 1 ? "" : "s"}.`),
    h("section", { class: "card suggest" },
      h("p", { class: "k" }, "Suggestions"),
      enough
        ? h("p", {}, "You can compare the completed trades below. These notes are still yours to write. Nothing here is a prediction.")
        : h("p", {}, "Not enough data to suggest a best-executed trade, a recurring mistake, or a focus for next week."),
    ),
    h("section", { class: "card" },
      field("best_executed", "Best-executed trade"),
      field("biggest_lesson", "Biggest lesson"),
      field("recurring_mistakes", "Recurring mistakes"),
      field("focus_next", "One focus for next week"),
      h("p", { class: "fine", "data-save-state": "1" }, "Labeled as your review, not a grade of the market."),
    ),
    trades.length ? h("section", { class: "card" }, h("h3", {}, "Closed this week"), ...trades.map((t) => h("p", {}, `${t.session_close} ${t.underlying} ${money(t.realized_pnl, true)} ${t.outcome}`))) : null,
  );
  app.replaceChildren(shell("Week", body, "week"));
}

function shiftWeek(week, delta) {
  const days = weekDates(week);
  const anchor = new Date(`${days[0]}T12:00:00Z`);
  anchor.setUTCDate(anchor.getUTCDate() + delta * 7);
  return isoWeekKey(anchor.toISOString().slice(0, 10));
}

function renderSettings() {
  const rules = edits().personal_rules || emptyEdits().personal_rules;
  const standalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone;
  const groups = new Map();
  for (const item of state.criteria?.items || []) {
    if (!groups.has(item.group)) groups.set(item.group, []);
    groups.get(item.group).push(item);
  }
  const body = h("div", {},
    h("h2", {}, "Settings"),
    h("section", { class: "card" },
      h("h3", {}, "Personal rules"),
      h("p", { class: "fine" }, state.criteria?.personal_rules_policy || "Blank until you set them."),
      h("label", { class: "field" }, "Daily trade limit",
        h("input", {
          inputmode: "numeric",
          placeholder: "Blank",
          value: rules.daily_trade_limit ?? "",
          oninput: (e) => patchEdits((doc) => { doc.personal_rules.daily_trade_limit = e.target.value === "" ? null : Number(e.target.value); }),
        }),
      ),
      h("label", { class: "field" }, "Daily loss limit, dollars",
        h("input", {
          inputmode: "decimal",
          placeholder: "Blank",
          value: rules.daily_loss_limit ?? "",
          oninput: (e) => patchEdits((doc) => { doc.personal_rules.daily_loss_limit = e.target.value === "" ? null : Number(e.target.value); }),
        }),
      ),
      h("label", { class: "field" }, "Add a custom rule",
        h("input", {
          placeholder: "Your words",
          onchange: (e) => {
            const text = e.target.value.trim();
            if (!text) return;
            patchEdits((doc) => {
              doc.personal_rules.custom_rules = [...(doc.personal_rules.custom_rules || []), { id: crypto.randomUUID(), text }];
            });
            render();
          },
        }),
      ),
      ...(rules.custom_rules || []).map((rule) => h("p", { class: "rule-line" },
        rule.text,
        h("button", {
          class: "text-btn",
          type: "button",
          onclick: () => {
            patchEdits((doc) => {
              doc.personal_rules.custom_rules = (doc.personal_rules.custom_rules || []).filter((r) => r.id !== rule.id);
            });
            render();
          },
        }, "Remove"),
      )),
    ),
    h("section", { class: "card" },
      h("h3", {}, "LE criteria"),
      h("p", { class: "fine" }, `${state.criteria?.source?.name || "LE criteria"} ${state.criteria?.source?.version || ""}. ${state.criteria?.source?.note || ""}`),
      h("ol", { class: "gates" }, ...(state.criteria?.gate_order || []).map((step) => h("li", {}, step))),
      ...[...groups.entries()].map(([name, items]) => h("div", { class: "criteria-group" },
        h("h4", {}, name),
        ...items.map((item) => h("article", { class: "check" },
          h("div", { class: "check-top" },
            h("strong", {}, item.label),
            h("span", { class: `badge g-${item.grade}` }, item.grade),
            item.needs_confirmation ? h("span", { class: "badge confirm" }, "Needs your confirmation") : null,
          ),
          h("p", {}, item.statement),
          item.numeric_threshold != null ? h("p", { class: "fine" }, `Published number: ${item.numeric_threshold}`) : null,
          item.apply_to_personal_rules === false ? h("p", { class: "fine" }, "Shown for reference. Not copied into your rules.") : null,
        )),
      )),
    ),
    h("section", { class: "card" },
      h("h3", {}, "Export and import"),
      h("p", { class: "fine" }, "Export writes the merged edits file. Commit it as data/overrides/edits.json so a later import of fills cannot wipe the notes. Screenshot fields are URLs only."),
      h("div", { class: "row-actions" },
        h("button", { class: "text-btn", type: "button", onclick: exportEdits }, "Export edits JSON"),
        h("button", { class: "text-btn", type: "button", onclick: exportTradesJson }, "Export trades JSON"),
        h("button", { class: "text-btn", type: "button", onclick: exportTradesCsv }, "Export trades CSV"),
      ),
      h("label", { class: "field" }, "Import an edits JSON",
        h("input", { type: "file", accept: "application/json", onchange: importEdits }),
      ),
    ),
    h("section", { class: "card" },
      h("h3", {}, "On your phone"),
      standalone
        ? h("p", {}, "Opened from the home screen.")
        : h("p", {}, "Add to Home Screen from the browser share sheet (iPhone) or menu (Android). It opens full screen and keeps the last loaded journal for offline reading."),
      h("p", { class: "fine" }, "This app never places, changes, or cancels orders, and it has no brokerage login."),
    ),
  );
  app.replaceChildren(shell("Settings", body, "settings"));
}

function exportEdits() {
  const doc = edits();
  doc.updated_at = new Date().toISOString();
  download("journal-edits.json", JSON.stringify(doc, null, 2), "application/json");
}

function exportTradesJson() {
  const payload = {
    exported_at: new Date().toISOString(),
    note: "Screenshot fields are links only.",
    trades: (state.book?.trades || []).map(decorateTrade),
  };
  download("trades.json", JSON.stringify(payload, null, 2), "application/json");
}

function decorateTrade(trade) {
  const date = trade.session_close || trade.session_open;
  const user = edits().days?.[date]?.trades?.[trade.trade_id] || {};
  return { ...trade, your_notes: user };
}

function exportTradesCsv() {
  const header = ["trade_id", "session_open", "session_close", "underlying", "contract", "direction", "qty_opened", "qty_closed", "avg_entry", "avg_exit", "fees", "fees_known", "realized_pnl", "pnl_source", "pnl_pct", "outcome", "duration_seconds", "notes", "screenshot_links"];
  const lines = [header.join(",")];
  for (const trade of state.book?.trades || []) {
    const date = trade.session_close || trade.session_open;
    const user = edits().days?.[date]?.trades?.[trade.trade_id] || {};
    const le = user.le || {};
    const cells = [
      trade.trade_id, trade.session_open, trade.session_close, trade.underlying,
      [trade.expiry, trade.strike, trade.option_type].filter(Boolean).join(" "),
      trade.direction, trade.qty_opened, trade.qty_closed, trade.avg_entry, trade.avg_exit,
      trade.fees, trade.fees_known, trade.realized_pnl, trade.pnl_source, trade.pnl_pct,
      trade.outcome, trade.duration_seconds, le.lessons || user.notes || "",
      (le.screenshot_links || []).join(" "),
    ];
    lines.push(cells.map(csvEscape).join(","));
  }
  download("trades.csv", lines.join("\n"), "text/csv");
}

function csvEscape(value) {
  const text = value == null ? "" : String(value);
  if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

async function importEdits(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    if (!parsed || parsed.kind !== "journal-edits" && parsed.schema_version == null) {
      throw new Error("That file is not a journal edits export.");
    }
    await saveLocal(parsed);
    state.toast = "Imported onto this phone. Export again and commit data/overrides/edits.json to keep it in the repo.";
    render();
  } catch (err) {
    state.error = err.message;
    render();
  }
}

async function refresh() {
  state.error = "";
  state.toast = "Reloading saved files…";
  render();
  try {
    state.dayCache = {};
    state.local = state.local || readLocalSync() || {};
    await loadAll(true);
    state.toast = "Reloaded the saved journal. This app cannot pull from Webull. Ask your assistant to re-sync if a session is missing.";
  } catch (err) {
    state.error = `Refresh failed (${err.message}). Showing the last loaded copy if it is still on screen. Ask your assistant to re-sync.`;
    state.toast = "";
  }
  render();
}

function render() {
  if (state.charts) {
    state.charts.remove();
    state.charts = null;
  }
  const current = route();
  if (!state.index) {
    app.replaceChildren(h("p", { class: "lede" }, state.error || "Loading the journal…"));
    return;
  }
  if (current.name === "day") return renderDay(current.date);
  if (current.name === "insights") return renderInsights();
  if (current.name === "week") return renderWeek();
  if (current.name === "settings") return renderSettings();
  if (current.name === "plan") return renderPlan(current.date);
  return renderMonth();
}

async function boot() {
  try {
    await loadAll(false);
    if (!location.hash) {
      const asOf = state.index.as_of || "2026-11-12";
      const [y, m] = asOf.split("-");
      history.replaceState(null, "", `#/${y}/${m}`);
    }
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register(new URL("sw.js", document.baseURI).href).catch(() => {});
    }
  } catch (err) {
    state.error = `The journal files did not load (${err.message}).`;
  }
  render();
}

window.addEventListener("hashchange", render);
boot();
