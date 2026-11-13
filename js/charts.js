/** Candles, level lines, 8 EMA, and fill markers at the actual price. */

function unix(iso) {
  return Math.floor(Date.parse(iso) / 1000);
}

function mountOne(host, readout, spec) {
  const LC = window.LightweightCharts;
  if (!LC) {
    host.textContent = "Chart library failed to load.";
    return { remove() {} };
  }
  const bars = [...(spec.bars || [])].filter((b) => b && b.t).sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  const seen = new Set();
  const data = [];
  for (const bar of bars) {
    const time = unix(bar.t);
    if (seen.has(time)) continue;
    seen.add(time);
    data.push({ time, open: bar.o, high: bar.h, low: bar.l, close: bar.c, ema: bar.ema8 });
  }
  if (!data.length) {
    host.textContent = "No candles in this import.";
    return { remove() {} };
  }
  const chart = LC.createChart(host, {
    autoSize: true,
    layout: {
      background: { type: LC.ColorType?.Solid ?? "solid", color: "#14181f" },
      textColor: "#93a0b4",
      fontFamily: "ui-sans-serif, system-ui, sans-serif",
      attributionLogo: false,
    },
    grid: {
      vertLines: { color: "#222836" },
      horzLines: { color: "#222836" },
    },
    rightPriceScale: { borderColor: "#2a3140" },
    timeScale: {
      borderColor: "#2a3140",
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 3,
      tickMarkFormatter: (time) => {
        const ms = typeof time === "number" ? time * 1000 : Date.parse(`${time.year}-${time.month}-${time.day}T00:00:00Z`);
        return new Intl.DateTimeFormat(undefined, {
          hour: "numeric",
          minute: "2-digit",
          timeZoneName: "short",
        }).format(new Date(ms));
      },
    },
    crosshair: { mode: LC.CrosshairMode?.Normal ?? 0 },
    handleScroll: { vertTouchDrag: false, horzTouchDrag: true, mouseWheel: true, pressedMouseMove: true },
    handleScale: { pinch: true, mouseWheel: true, axisPressedMouseMove: true },
    kineticScroll: { touch: true, mouse: false },
    localization: {
      timeFormatter: (time) => new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(new Date(time * 1000)),
    },
  });
  const candles = chart.addSeries(LC.CandlestickSeries, {
    upColor: "#3dd68c",
    downColor: "#ff5d73",
    borderUpColor: "#3dd68c",
    borderDownColor: "#ff5d73",
    wickUpColor: "#3dd68c",
    wickDownColor: "#ff5d73",
    priceLineVisible: false,
    priceFormat: { type: "price", precision: spec.precision ?? 2, minMove: spec.minMove ?? 0.01 },
  });
  candles.setData(data.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));

  const notes = [];
  if (spec.showEma) {
    const ema = chart.addSeries(LC.LineSeries, {
      color: "#e2b657",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      title: "8 EMA",
    });
    ema.setData(data.filter((b) => b.ema != null).map((b) => ({ time: b.time, value: b.ema })));
  }

  const lows = data.map((b) => b.low);
  const highs = data.map((b) => b.high);
  const span = Math.max(...highs) - Math.min(...lows) || 1;
  const lo = Math.min(...lows) - span * 0.15;
  const hi = Math.max(...highs) + span * 0.15;
  for (const level of spec.levels || []) {
    if (level.value == null || Number.isNaN(Number(level.value))) continue;
    if (spec.exclude?.includes(level.key) || level.value < lo || level.value > hi) {
      notes.push(`${level.label} ${Number(level.value).toFixed(2)} is off this scale`);
      continue;
    }
    candles.createPriceLine({
      price: Number(level.value),
      color: "#8eb4ff",
      lineWidth: 1,
      lineStyle: LC.LineStyle?.Dashed ?? 2,
      axisLabelVisible: true,
      title: level.label,
    });
  }

  const markers = (spec.markers || []).filter((m) => m.t && m.price != null).map((m) => ({
    time: unix(m.t),
    position: "atPriceMiddle",
    price: Number(m.price),
    shape: m.side === "buy" ? "arrowUp" : "arrowDown",
    color: m.side === "buy" ? "#3dd68c" : "#ff5d73",
    text: `${m.side === "buy" ? "B" : "S"} ${m.qty}`,
  }));
  LC.createSeriesMarkers(candles, markers);

  const applyRange = (mode) => {
    if (mode === "fills" && markers.length) {
      const times = markers.map((m) => m.time).sort((a, b) => a - b);
      const padBefore = 30 * 60;
      const padAfter = 20 * 60;
      chart.timeScale().setVisibleRange({
        from: times[0] - padBefore,
        to: times[times.length - 1] + padAfter,
      });
    } else {
      chart.timeScale().fitContent();
    }
  };
  applyRange(spec.range || "session");

  chart.subscribeCrosshairMove((param) => {
    if (!readout) return;
    const row = param?.seriesData?.get(candles);
    if (!row || row.open == null) {
      readout.textContent = notes.length ? `${notes.join(". ")}.` : "Drag to move. Pinch to zoom. Markers sit on the fill price.";
      return;
    }
    const when = new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(new Date(param.time * 1000));
    readout.textContent = `${when}  O ${row.open}  H ${row.high}  L ${row.low}  C ${row.close}`;
  });
  if (readout) {
    readout.textContent = notes.length ? `${notes.join(". ")}.` : "Drag to move. Pinch to zoom. Markers sit on the fill price.";
  }
  return {
    remove() { chart.remove(); },
    setRange(mode) { applyRange(mode); },
  };
}

export function mountCharts(root, day, range) {
  const handles = [];
  root.querySelectorAll("[data-chart]").forEach((host) => {
    const kind = host.getAttribute("data-chart");
    const readout = host.parentElement.querySelector("[data-readout]");
    const charts = day.charts || {};
    if (kind === "underlying") {
      const block = charts.underlying;
      if (!block) return;
      const markers = (block.markers || []).map((m) => ({
        t: m.t,
        side: m.side,
        qty: m.qty,
        price: m.underlying,
      }));
      const levels = block.levels || {};
      handles.push(mountOne(host, readout, {
        bars: block.bars,
        markers,
        showEma: true,
        range,
        exclude: ["pdl"],
        levels: [
          { key: "pdh", label: "PDH", value: levels.pdh },
          { key: "pdl", label: "PDL", value: levels.pdl },
          { key: "pmh", label: "PMH", value: levels.pmh },
          { key: "pml", label: "PML", value: levels.pml },
        ],
      }));
    } else if (kind === "option") {
      const block = charts.option_5m || charts.option;
      if (!block) return;
      handles.push(mountOne(host, readout, {
        bars: block.bars,
        markers: block.markers || [],
        showEma: false,
        range,
        precision: 2,
        minMove: 0.01,
        levels: [],
      }));
    }
  });
  return {
    remove() { handles.forEach((h) => h.remove()); },
  };
}
