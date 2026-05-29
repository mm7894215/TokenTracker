"use strict";

const { aggregateByDay } = require("./local-api");
const { computeRowCost } = require("./pricing");
const { formatCompact } = require("./wrapped-aggregator");

const TOKEN_FIELDS = [
  "total_tokens",
  "billable_total_tokens",
  "input_tokens",
  "output_tokens",
  "cached_input_tokens",
  "cache_creation_input_tokens",
  "reasoning_output_tokens",
  "conversation_count",
];

function isDay(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function rowDay(row) {
  return typeof row?.hour_start === "string" ? row.hour_start.slice(0, 10) : null;
}

function createTotals() {
  return {
    total_tokens: 0,
    billable_total_tokens: 0,
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: 0,
    conversation_count: 0,
    total_cost_usd: 0,
  };
}

function addRowTotals(target, row) {
  for (const field of TOKEN_FIELDS) {
    if (field === "billable_total_tokens") {
      target[field] += Number(row.billable_total_tokens ?? row.total_tokens ?? 0) || 0;
    } else {
      target[field] += Number(row[field] || 0) || 0;
    }
  }
  target.total_cost_usd += computeRowCost(row);
}

function addDailyTotals(target, row) {
  for (const field of TOKEN_FIELDS) {
    target[field] += Number(row[field] || 0) || 0;
  }
  target.total_cost_usd += Number(row.total_cost_usd || 0) || 0;
}

function finalizeTotals(totals) {
  return {
    ...totals,
    total_cost_usd: totals.total_cost_usd.toFixed(6),
  };
}

function topBreakdown(rows, keyName) {
  const groups = new Map();

  for (const row of rows) {
    const key = row?.[keyName] || "unknown";
    if (!groups.has(key)) {
      groups.set(key, { name: key, totals: createTotals() });
    }
    addRowTotals(groups.get(key).totals, row);
  }

  return Array.from(groups.values())
    .map((entry) => ({ ...entry, totals: finalizeTotals(entry.totals) }))
    .sort((a, b) => b.totals.billable_total_tokens - a.totals.billable_total_tokens)
    .slice(0, 10);
}

function normalizeDailyCost(daily) {
  return daily.map((day) => ({
    ...day,
    total_cost_usd: Number(day.total_cost_usd || 0).toFixed(6),
  }));
}

function buildUsageSummary(rows, opts = {}) {
  const dailyAll = aggregateByDay(Array.isArray(rows) ? rows : []);
  const firstDay = dailyAll[0]?.day || null;
  const lastDay = dailyAll[dailyAll.length - 1]?.day || null;
  const from = opts.from || firstDay;
  const to = opts.to || lastDay;

  const daily = dailyAll.filter((day) => {
    if (from && day.day < from) return false;
    if (to && day.day > to) return false;
    return true;
  });

  const rowsInRange = (Array.isArray(rows) ? rows : []).filter((row) => {
    const day = rowDay(row);
    if (!day) return false;
    if (from && day < from) return false;
    if (to && day > to) return false;
    return true;
  });

  const totals = createTotals();
  for (const day of daily) addDailyTotals(totals, day);

  return {
    generated_at: new Date().toISOString(),
    local_only: true,
    source: "queue.jsonl",
    range: { from, to },
    rows: rowsInRange.length,
    days: daily.length,
    totals: finalizeTotals(totals),
    top_sources: topBreakdown(rowsInRange, "source"),
    top_models: topBreakdown(rowsInRange, "model"),
    daily: normalizeDailyCost(daily),
  };
}

function renderUsageSummary(summary) {
  const lines = [
    "TokenTracker usage (local)",
    "",
    `Range: ${summary.range.from || "n/a"} to ${summary.range.to || "n/a"}`,
    `Rows: ${summary.rows.toLocaleString("en-US")}`,
    `Days: ${summary.days.toLocaleString("en-US")}`,
    `Total tokens: ${formatCompact(summary.totals.total_tokens)}`,
    `Billable tokens: ${formatCompact(summary.totals.billable_total_tokens)}`,
    `Estimated cost: $${summary.totals.total_cost_usd}`,
  ];

  if (summary.top_sources.length > 0) {
    lines.push("", "Top tools:");
    for (const source of summary.top_sources.slice(0, 5)) {
      lines.push(
        `  ${source.name}: ${formatCompact(source.totals.billable_total_tokens)} · $${source.totals.total_cost_usd}`,
      );
    }
  }

  if (summary.top_models.length > 0) {
    lines.push("", "Top models:");
    for (const model of summary.top_models.slice(0, 5)) {
      lines.push(
        `  ${model.name}: ${formatCompact(model.totals.billable_total_tokens)} · $${model.totals.total_cost_usd}`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

function assertDayFlag(value, flag) {
  if (!isDay(value)) throw new Error(`${flag} expects YYYY-MM-DD, got: ${value}`);
}

module.exports = {
  buildUsageSummary,
  renderUsageSummary,
  assertDayFlag,
};
