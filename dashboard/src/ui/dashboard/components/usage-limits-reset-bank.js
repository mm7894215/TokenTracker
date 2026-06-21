import { copy, getCopyLocale } from "../../../lib/copy";

const FULL_BAR_PERCENT = 100;

function parseMs(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function clampPercent(value) {
  return Math.max(0, Math.min(FULL_BAR_PERCENT, Math.round(value)));
}

function formatResetBankDateTime(ms) {
  return new Intl.DateTimeFormat(getCopyLocale(), {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ms));
}

function lifetimePercent(grantedMs, expiresMs, nowMs) {
  if (grantedMs == null || grantedMs >= expiresMs) return FULL_BAR_PERCENT;
  const lifetimeMs = expiresMs - grantedMs;
  const remainingMs = expiresMs - nowMs;
  return clampPercent((remainingMs / lifetimeMs) * FULL_BAR_PERCENT);
}

function readAvailableCount(resetCredits) {
  const count = resetCredits.available_count;
  if (count === null) return null;
  return Number.isInteger(count) && count >= 0 ? count : undefined;
}

export function buildResetBankRows(resetCredits, { now } = {}) {
  if (!resetCredits || typeof resetCredits !== "object") return null;

  const availableCount = readAvailableCount(resetCredits);
  if (availableCount === undefined) return null;

  const credits = Array.isArray(resetCredits.credits) ? resetCredits.credits : [];
  const nowMs = now instanceof Date ? now.getTime() : Number(now ?? Date.now());
  const rows = [];
  for (const credit of credits) {
    const expiresMs = parseMs(credit?.expires_at);
    if (expiresMs == null) continue;
    const index = rows.length + 1;
    rows.push({
      key: `reset-${index}`,
      label: copy("limits.codex_reset_bank.row_label", { index }),
      expiresAt: formatResetBankDateTime(expiresMs),
      percent: lifetimePercent(parseMs(credit?.granted_at), expiresMs, nowMs),
    });
  }

  if (availableCount === 0) return null;
  if (rows.length > 0) {
    return {
      kind: "rows",
      availableCount: availableCount ?? rows.length,
      rows,
    };
  }
  if (availableCount > 0) return { kind: "count_only", availableCount, rows: [] };
  return null;
}
