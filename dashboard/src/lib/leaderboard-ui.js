export function clampInt(value, { min, max, fallback }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

export function buildPageItems(page, totalPages) {
  const safeTotal = clampInt(totalPages, { min: 0, max: 1_000_000, fallback: 0 });
  const safePage = clampInt(page, { min: 1, max: Math.max(1, safeTotal || 1), fallback: 1 });
  if (safeTotal <= 1) return [1];

  const candidates = new Set([
    1,
    safeTotal,
    safePage - 2,
    safePage - 1,
    safePage,
    safePage + 1,
    safePage + 2,
  ]);

  const sorted = Array.from(candidates)
    .filter((p) => Number.isInteger(p) && p >= 1 && p <= safeTotal)
    .sort((a, b) => a - b);

  const items = [];
  let prev = null;
  for (const p of sorted) {
    if (prev != null && p - prev > 1) items.push(null);
    items.push(p);
    prev = p;
  }
  return items;
}

export function getPaginationFlags({ page, totalPages }) {
  const totalKnown =
    typeof totalPages === "number" && Number.isFinite(totalPages) && totalPages >= 0;
  const safeTotal = totalKnown
    ? clampInt(totalPages, { min: 0, max: 1_000_000, fallback: 0 })
    : null;
  const safePage = clampInt(page, {
    min: 1,
    max: totalKnown ? Math.max(1, safeTotal || 1) : 1_000_000,
    fallback: 1,
  });

  const canPrev = safePage > 1;
  const canNext = totalKnown ? safePage < safeTotal : true;

  return { canPrev, canNext, safePage, safeTotal };
}

export function injectMeIntoFirstPage({ entries, me, meLabel, limit }) {
  const safeLimit = clampInt(limit, { min: 1, max: 1000, fallback: 20 });
  const rows = Array.isArray(entries) ? entries.slice(0, safeLimit) : [];
  const meRank = me && typeof me.rank === "number" ? me.rank : null;
  const hasMeInPage = rows.some((e) => Boolean(e?.is_me));

  if (!meRank || hasMeInPage) return rows;

  const injectedRow = {
    rank: meRank,
    is_me: true,
    display_name: meLabel,
    avatar_url: null,
    gpt_tokens: me?.gpt_tokens ?? "0",
    claude_tokens: me?.claude_tokens ?? "0",
    gemini_tokens: me?.gemini_tokens ?? "0",
    cursor_tokens: me?.cursor_tokens ?? "0",
    opencode_tokens: me?.opencode_tokens ?? "0",
    openclaw_tokens: me?.openclaw_tokens ?? "0",
    hermes_tokens: me?.hermes_tokens ?? "0",
    kiro_tokens: me?.kiro_tokens ?? "0",
    copilot_tokens: me?.copilot_tokens ?? "0",
    kimi_tokens: me?.kimi_tokens ?? "0",
    other_tokens: me?.other_tokens ?? "0",
    total_tokens: me?.total_tokens ?? "0",
  };

  // Pin YOU at the bottom of page 1 so users see their own rank without
  // the row looking interleaved at a random position. When their rank is
  // not contiguous with the last natural row, insert an ellipsis separator
  // row right above YOU so the "jump" is explicit instead of resembling a
  // sort bug. Keep list length stable by trimming the trailing rows we
  // displace.
  const pruned = rows.filter((e) => !e?.is_me);
  const lastRow = pruned[pruned.length - 1];
  const lastRank = lastRow && typeof lastRow.rank === "number" ? lastRow.rank : 0;
  const needsGap = meRank > lastRank + 1;

  if (needsGap) {
    const kept = pruned.slice(0, Math.max(0, safeLimit - 2));
    return [...kept, { is_ellipsis: true, rank: null, display_name: "" }, injectedRow];
  }
  const kept = pruned.slice(0, Math.max(0, safeLimit - 1));
  return [...kept, injectedRow];
}
