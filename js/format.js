export function money(value, signed = false) {
  if (value == null || value === "" || Number.isNaN(Number(value))) return "—";
  const n = Number(value);
  const abs = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (!signed) return (n < 0 ? "−" : "") + "$" + abs;
  if (n > 0) return "+$" + abs;
  if (n < 0) return "−$" + abs;
  return "$" + abs;
}

export function compactCount(n) {
  if (n == null) return "—";
  return String(n);
}

export function localZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  } catch {
    return "local";
  }
}

export function formatWhen(iso, timeZone) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone || undefined,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

export function formatLocal(iso) {
  return formatWhen(iso, localZone());
}

export function formatEt(iso) {
  return formatWhen(iso, "America/New_York");
}

export function zoneLabel() {
  const zone = localZone();
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      timeZoneName: "short",
    }).formatToParts(new Date());
    const name = parts.find((p) => p.type === "timeZoneName")?.value || zone;
    return { zone, name };
  } catch {
    return { zone, name: zone };
  }
}

export function isoDate(y, m, d) {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function monthCells(year, month) {
  const dim = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const weekday = (d) => {
    const wd = new Date(Date.UTC(year, month - 1, d)).getUTCDay();
    return wd === 0 ? 6 : wd - 1;
  };
  const lead = weekday(1);
  const first = lead === 5 ? 3 : lead === 6 ? 2 : 1;
  const blanks = lead >= 5 ? 0 : lead;
  const cells = [];
  for (let i = 0; i < blanks; i += 1) cells.push(null);
  for (let d = first; d <= dim; d += 1) {
    if (weekday(d) > 4) continue;
    cells.push(d);
  }
  while (cells.length % 5) cells.push(null);
  return cells;
}

export function isoWeekKey(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((dt - yearStart) / 86400000 + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function weekDates(weekKey) {
  const [yearStr, wStr] = weekKey.split("-W");
  const year = Number(yearStr);
  const week = Number(wStr);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - (jan4Day - 1) + (week - 1) * 7);
  const days = [];
  for (let i = 0; i < 7; i += 1) {
    const d = new Date(monday);
    d.setUTCDate(monday.getUTCDate() + i);
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

export function shiftMonth(year, month, delta) {
  const d = new Date(Date.UTC(year, month - 1 + delta, 1));
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 };
}

export function monthName(month) {
  return [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ][month - 1];
}

export function durationLabel(seconds) {
  if (seconds == null) return "Open";
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }
  return `${m}m ${rem}s`;
}

export function download(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
