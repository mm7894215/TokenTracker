const OPENROUTER_ANALYTICS_QUERY_URL = "https://openrouter.ai/api/v1/analytics/query";

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function openrouterDebugLog(message, env = process.env) {
  const dbg = String((env && env.TOKENTRACKER_DEBUG) || "").toLowerCase();
  if (dbg === "1" || dbg === "true") {
    process.stderr.write(`[openrouter] ${message}\n`);
  }
}

function resolveOpenRouterApiKey({ config, env = process.env } = {}) {
  const fromEnv = typeof env.OPENROUTER_API_KEY === "string" ? env.OPENROUTER_API_KEY.trim() : "";
  if (fromEnv) return fromEnv;
  const fromConfig =
    typeof config?.openrouter?.apiKey === "string" ? config.openrouter.apiKey.trim() : "";
  return fromConfig || null;
}

function isOpenRouterConfigured({ config, env = process.env } = {}) {
  return Boolean(resolveOpenRouterApiKey({ config, env }));
}

function resolveOpenRouterDayKey(row) {
  if (!row || typeof row !== "object") return null;
  const candidates = [
    row.date__day,
    row.created_at__day,
    row.date__,
    row.created_at__,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    const trimmed = candidate.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
      return trimmed.slice(0, 10);
    }
  }
  return null;
}

function dayKeyToIsoDate(dayKey) {
  if (!dayKey) return null;
  return `${dayKey}T12:00:00.000Z`;
}

/**
 * Parse OpenRouter analytics query rows into Cursor-like records for rollout.
 */
function parseOpenRouterAnalyticsRows(payload) {
  const rows = payload?.data?.data;
  if (!Array.isArray(rows)) return [];

  const records = [];
  for (const row of rows) {
    const dayKey = resolveOpenRouterDayKey(row);
    if (!dayKey) continue;

    const model = typeof row.model === "string" && row.model.trim() ? row.model.trim() : "unknown";
    const inputTokens = toInt(row.tokens_input);
    const outputTokens = toInt(row.tokens_output);
    const totalTokens = toInt(row.tokens_total) || inputTokens + outputTokens;
    if (totalTokens <= 0 && inputTokens <= 0 && outputTokens <= 0) continue;

    records.push({
      date: dayKeyToIsoDate(dayKey),
      model,
      inputTokens,
      outputTokens,
      totalTokens,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
    });
  }

  return records;
}

/**
 * Fetch daily OpenRouter usage via the official Analytics API.
 * Requires a management-capable API key.
 */
async function fetchOpenRouterDailyUsage({
  apiKey,
  daysBack = 90,
  timeoutMs = 30000,
  fetchImpl = fetch,
  now = new Date(),
} = {}) {
  if (!apiKey || typeof apiKey !== "string") {
    throw new Error("OpenRouter API key is required");
  }

  const end = now instanceof Date ? now : new Date(now);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - Math.max(1, Number(daysBack) || 90));

  const body = {
    metrics: ["tokens_total", "tokens_input", "tokens_output", "request_count"],
    dimensions: ["model"],
    granularity: "day",
    time_range: {
      start: start.toISOString(),
      end: end.toISOString(),
    },
    limit: 500,
  };

  const res = await fetchImpl(OPENROUTER_ANALYTICS_QUERY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error("OpenRouter API key invalid or lacks analytics access");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `OpenRouter API returned ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
    );
  }

  const payload = await res.json();
  openrouterDebugLog(`Fetched ${Array.isArray(payload?.data?.data) ? payload.data.data.length : 0} rows`);
  return parseOpenRouterAnalyticsRows(payload);
}

function normalizeOpenRouterUsage(record) {
  const inputTokens = Math.max(0, Math.floor(record.inputTokens || 0));
  const outputTokens = Math.max(0, Math.floor(record.outputTokens || 0));
  const totalTokens = Math.max(
    0,
    Math.floor(record.totalTokens || inputTokens + outputTokens),
  );
  return {
    input_tokens: inputTokens,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: outputTokens,
    reasoning_output_tokens: 0,
    total_tokens: totalTokens,
    billable_total_tokens: totalTokens,
  };
}

module.exports = {
  OPENROUTER_ANALYTICS_QUERY_URL,
  resolveOpenRouterApiKey,
  isOpenRouterConfigured,
  resolveOpenRouterDayKey,
  dayKeyToIsoDate,
  parseOpenRouterAnalyticsRows,
  fetchOpenRouterDailyUsage,
  normalizeOpenRouterUsage,
};
