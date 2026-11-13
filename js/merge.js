/** Deep-merge journal edits. The overlay wins. Arrays replace. Null clears a key. */

export function emptyEdits() {
  return {
    schema_version: 1,
    kind: "journal-edits",
    updated_at: null,
    days: {},
    plans: [],
    weekly_reviews: {},
    personal_rules: {
      daily_trade_limit: null,
      daily_loss_limit: null,
      custom_rules: [],
    },
  };
}

export function mergeEdits(base, overlay) {
  if (overlay === undefined) return base;
  if (overlay === null) return null;
  if (Array.isArray(overlay)) return overlay.map((item) => item);
  if (typeof overlay !== "object") return overlay;
  const src = base && typeof base === "object" && !Array.isArray(base) ? base : {};
  const out = { ...src };
  for (const key of Object.keys(overlay)) {
    out[key] = mergeEdits(src[key], overlay[key]);
  }
  return out;
}

/** Committed overrides win over bot fields because bot files are not in this tree. */
export function effectiveEdits(committed, local) {
  return mergeEdits(mergeEdits(emptyEdits(), committed || {}), local || {});
}
