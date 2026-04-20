function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function toBillableTokens(row) {
  if (!row || typeof row !== "object") return 0;
  return (
    toFiniteNumber(row.billable_total_tokens) ??
    toFiniteNumber(row.total_tokens) ??
    0
  );
}

function sortRowsByDay(rows) {
  return rows
    .filter((row) => row?.day)
    .slice()
    .sort((a, b) => String(a.day).localeCompare(String(b.day)));
}

function sumTokens(rows) {
  return rows.reduce((acc, row) => acc + toBillableTokens(row), 0);
}

function pickTopDay(rows) {
  let best = null;
  for (const row of rows) {
    const tokens = toBillableTokens(row);
    if (!best || tokens > best.tokens) {
      best = { day: row.day, tokens };
    }
  }
  return best;
}

function pickTopProject(entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) return null;
  return list
    .map((entry) => ({
      name: entry?.project_key || entry?.project_ref || "Unknown",
      tokens: toBillableTokens(entry),
    }))
    .sort((a, b) => b.tokens - a.tokens)[0] || null;
}

function pickTopModel(topModels) {
  const list = Array.isArray(topModels) ? topModels : [];
  if (list.length === 0) return null;
  const row = list[0];
  return {
    name: row?.name || row?.id || "Unknown",
    percent: toFiniteNumber(row?.percent) ?? 0,
  };
}

export function buildWeeklyReview({ dailyRows, projectEntries, topModels } = {}) {
  const sortedRows = sortRowsByDay(Array.isArray(dailyRows) ? dailyRows : []);
  const currentWeek = sortedRows.slice(-7);
  const previousWeek = sortedRows.slice(-14, -7);
  const total = sumTokens(currentWeek);
  const previousTotal = sumTokens(previousWeek);
  const change = previousTotal > 0 ? total - previousTotal : null;
  const spike = pickTopDay(currentWeek);
  const topProject = pickTopProject(projectEntries);
  const topModel = pickTopModel(topModels);

  const projectShare =
    total > 0 && topProject?.tokens ? topProject.tokens / total : 0;

  let recommendationKey = "dashboard.weekly_review.recommendation.default";
  let recommendationValues = {};

  if (projectShare >= 0.4 && topProject?.name) {
    recommendationKey = "dashboard.weekly_review.recommendation.project";
    recommendationValues = { project: topProject.name };
  } else if (topModel?.name && topModel.percent >= 50) {
    recommendationKey = "dashboard.weekly_review.recommendation.model";
    recommendationValues = { model: topModel.name };
  } else if (spike?.day) {
    recommendationKey = "dashboard.weekly_review.recommendation.spike";
    recommendationValues = { day: spike.day };
  }

  return {
    total,
    previousTotal,
    change,
    topDay: spike,
    topProject,
    topModel,
    recommendationKey,
    recommendationValues,
  };
}
