const STORAGE_KEY = "tokentracker_budget_alerts_v1";

function toPositiveNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function toDate(value) {
  if (typeof value !== "string" || !value) return null;
  const date = new Date(`${value}T00:00:00`);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function getBudgetAlertPrefs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { daily: null, weekly: null, monthly: null };
    const parsed = JSON.parse(raw);
    return {
      daily: toPositiveNumber(parsed?.daily),
      weekly: toPositiveNumber(parsed?.weekly),
      monthly: toPositiveNumber(parsed?.monthly),
    };
  } catch {
    return { daily: null, weekly: null, monthly: null };
  }
}

export function setBudgetAlertPrefs(prefs) {
  const normalized = {
    daily: toPositiveNumber(prefs?.daily),
    weekly: toPositiveNumber(prefs?.weekly),
    monthly: toPositiveNumber(prefs?.monthly),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}

function resolveBudget(period, budgets) {
  if (period === "day") return toPositiveNumber(budgets?.daily);
  if (period === "week") return toPositiveNumber(budgets?.weekly);
  if (period === "month") return toPositiveNumber(budgets?.monthly);
  return null;
}

function elapsedFraction(from, to, now = new Date()) {
  const start = toDate(from);
  const end = toDate(to);
  if (!start || !end || end < start) return 1;
  const totalDays = Math.max(1, Math.round((end - start) / 86400000) + 1);
  const nowDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const elapsedDays = Math.min(
    totalDays,
    Math.max(1, Math.round((nowDate - start) / 86400000) + 1),
  );
  return elapsedDays / totalDays;
}

export function buildBudgetAlert({
  period,
  from,
  to,
  totalCostUsd,
  budgets,
  topProject,
  now = new Date(),
}) {
  const budget = resolveBudget(period, budgets);
  const total = Number(totalCostUsd);
  if (!budget || !Number.isFinite(total) || total <= 0) return null;

  const fraction = period === "week" || period === "month"
    ? elapsedFraction(from, to, now)
    : 1;
  const projected = fraction > 0 ? total / fraction : total;

  if (total < budget && projected <= budget) return null;

  const overrunPct = Math.max(
    total >= budget ? ((total - budget) / budget) * 100 : ((projected - budget) / budget) * 100,
    0,
  );

  return {
    budget,
    total,
    projected,
    topProject: topProject?.project_key || topProject?.project_ref || null,
    overrunPct: Math.round(overrunPct),
    status: total >= budget ? "over" : "forecast",
  };
}
