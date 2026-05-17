import {
  buildActivityHeatmap,
  computeActiveStreakDays,
  getHeatmapRangeLocal,
} from "./activity-heatmap";
import { formatDateLocal, formatDateUTC } from "./date-range";

type AnyRecord = Record<string, any>;
type HourRow = {
  hour: string;
  total_tokens: number;
  billable_total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  reasoning_output_tokens: number;
  missing?: boolean;
};

const DEFAULT_MOCK_SEED = "tokentracker";
const MOCK_PROJECT_REPOS = [
  "victorgpt/tokentracker",
  "spacedriveapp/spacedrive",
  "acme/alpha",
  "acme/beta",
  "neo/nebula",
  "signal/flux",
  "matrix/terminal",
  "orbit/atlas",
  "lumen/core",
  "delta/horizon",
];
const MOCK_LEADERBOARD_NAMES = [
  "NEO",
  "TRINITY",
  "MORPHEUS",
  "ORACLE",
  "CYPHER",
  "SWITCH",
  "APOC",
  "TANK",
  "SMITH",
  "SERAPH",
  "NIOBE",
  "MOUSE",
  "DOZER",
  "LINK",
  "BLADE",
];

export function isMockEnabled() {
  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search);
    const q = String(params.get("mock") || "").toLowerCase();
    // 显式关闭：?mock=0 / false / off 优先于环境变量（便于联调真实接口）
    if (q === "0" || q === "false" || q === "off" || q === "no") return false;
    if (q === "1" || q === "true" || q === "on" || q === "yes") return true;
  }
  if (typeof import.meta !== "undefined" && import.meta.env) {
    const flag = String(import.meta.env.VITE_TOKENTRACKER_MOCK || "").toLowerCase();
    if (flag === "1" || flag === "true") return true;
  }
  return false;
}

function readMockNowRaw() {
  if (typeof import.meta !== "undefined" && import.meta.env) {
    const envNow = String(import.meta.env.VITE_TOKENTRACKER_MOCK_NOW || "").trim();
    if (envNow) return envNow;
    const envToday = String(import.meta.env.VITE_TOKENTRACKER_MOCK_TODAY || "").trim();
    if (envToday) return envToday;
  }
  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search);
    const queryNow = String(params.get("mock_now") || "").trim();
    if (queryNow) return queryNow;
    const queryToday = String(params.get("mock_today") || "").trim();
    if (queryToday) return queryToday;
  }
  return "";
}

function parseMockNow(raw: any) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const [y, m, d] = trimmed.split("-").map(Number);
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
      return null;
    }
    const localNoon = new Date(y, m - 1, d, 12, 0, 0);
    return Number.isFinite(localNoon.getTime()) ? localNoon : null;
  }
  const parsed = new Date(trimmed);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

export function getMockNow() {
  if (!isMockEnabled()) return null;
  return parseMockNow(readMockNowRaw());
}

function readMockSeed() {
  if (typeof import.meta !== "undefined" && import.meta.env) {
    const seed = String(import.meta.env.VITE_TOKENTRACKER_MOCK_SEED || "").trim();
    if (seed) return seed;
  }
  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search);
    const seed = String(params.get("mock_seed") || "").trim();
    if (seed) return seed;
  }
  return DEFAULT_MOCK_SEED;
}

function readMockMissingCount() {
  if (typeof import.meta !== "undefined" && import.meta.env) {
    const raw = String(import.meta.env.VITE_TOKENTRACKER_MOCK_MISSING || "").trim();
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search);
    const raw = String(params.get("mock_missing") || "").trim();
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return 0;
}

function toSeed(seed: any) {
  const raw = seed == null ? readMockSeed() : String(seed);
  return raw.trim() || DEFAULT_MOCK_SEED;
}

function hashString(value: any) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function parseUtcDate(yyyyMmDd: any) {
  if (typeof yyyyMmDd !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(yyyyMmDd.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo, d));
  if (!Number.isFinite(dt.getTime())) return null;
  return formatDateUTC(dt) === yyyyMmDd.trim() ? dt : null;
}

function addUtcDays(date: Date, days: number) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));
}

function addUtcMonths(date: Date, months: number) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
}

function formatMonthKey(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function buildDailyRows({ from, to, seed }: AnyRecord) {
  const today = parseUtcDate(formatDateLocal(new Date())) || new Date();
  const start = parseUtcDate(from) || today;
  const end = parseUtcDate(to) || start;
  const rows = [];
  const seedValue = toSeed(seed);
  const totalDays =
    Math.floor(
      (Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()) -
        Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate())) /
        86400000,
    ) + 1;

  for (let i = 0; i < totalDays; i += 1) {
    const dt = addUtcDays(start, i);
    const day = formatDateUTC(dt);
    const hash = hashString(`${seedValue}:${day}`);
    const jitter = (hash % 1000) / 1000;
    const seasonal = 0.6 + 0.4 * Math.sin((i / 6) * Math.PI * 0.5);
    const weekend = dt.getUTCDay() === 0 || dt.getUTCDay() === 6 ? 0.65 : 1;
    const base = 18000 + Math.round(12000 * jitter);
    const total = Math.max(0, Math.round(base * seasonal * weekend));

    const input = Math.round(total * 0.46);
    const output = Math.round(total * 0.34);
    const cached = Math.round(total * 0.14);
    const reasoning = Math.max(0, total - input - output - cached);

    rows.push({
      day,
      total_tokens: total,
      billable_total_tokens: total,
      input_tokens: input,
      output_tokens: output,
      cached_input_tokens: cached,
      reasoning_output_tokens: reasoning,
      conversation_count: 1 + (hash % 5),
    });
  }

  return rows;
}

function buildHourlyRows({ day, seed }: AnyRecord) {
  const base = parseUtcDate(day) || parseUtcDate(formatDateLocal(new Date())) || new Date();
  const dayKey = formatDateUTC(base);
  const seedValue = toSeed(seed);
  const rows: HourRow[] = Array.from({ length: 48 }, (_, index) => {
    const hour = Math.floor(index / 2);
    const minute = index % 2 === 0 ? 0 : 30;
    const hash = hashString(`${seedValue}:${dayKey}:${hour}:${minute}`);
    const jitter = (hash % 1000) / 1000;
    const hourFraction = (hour + minute / 60) / 24;
    const wave = 0.4 + 0.6 * Math.sin(hourFraction * Math.PI * 2);
    const baseValue = 900 + Math.round(700 * jitter);
    const total = Math.max(0, Math.round(baseValue * wave));

    const input = Math.round(total * 0.46);
    const output = Math.round(total * 0.34);
    const cached = Math.round(total * 0.14);
    const reasoning = Math.max(0, total - input - output - cached);

    return {
      hour: `${dayKey}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`,
      total_tokens: total,
      billable_total_tokens: total,
      input_tokens: input,
      output_tokens: output,
      cached_input_tokens: cached,
      reasoning_output_tokens: reasoning,
    };
  });

  const missingCount = Math.max(0, Math.min(48, readMockMissingCount()));
  if (missingCount > 0) {
    const nowMs = Date.now();
    const candidates = rows
      .map((row, index) => {
        const ts = Date.parse(row.hour);
        return Number.isFinite(ts) && ts <= nowMs ? { index, ts } : null;
      })
      .filter(Boolean) as Array<{ index: number; ts: number }>;
    const sliceStart = Math.max(0, candidates.length - missingCount);
    const targets = candidates.slice(sliceStart);
    for (const target of targets) {
      const row = rows[target.index];
      if (row) rows[target.index] = { ...row, missing: true };
    }
  }

  return rows;
}

function buildMonthlyRows({ months = 24, to, seed }: AnyRecord) {
  const end = parseUtcDate(to) || parseUtcDate(formatDateLocal(new Date())) || new Date();
  const endMonth = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  const seedValue = toSeed(seed);
  const rows = [];

  for (let i = months - 1; i >= 0; i -= 1) {
    const dt = addUtcMonths(endMonth, -i);
    const monthKey = formatMonthKey(dt);
    const hash = hashString(`${seedValue}:${monthKey}`);
    const jitter = (hash % 1000) / 1000;
    const seasonal = 0.7 + 0.3 * Math.sin((rows.length / 6) * Math.PI * 0.5);
    const base = 360000 + Math.round(200000 * jitter);
    const total = Math.max(0, Math.round(base * seasonal));

    const input = Math.round(total * 0.46);
    const output = Math.round(total * 0.34);
    const cached = Math.round(total * 0.14);
    const reasoning = Math.max(0, total - input - output - cached);

    rows.push({
      month: monthKey,
      total_tokens: total,
      billable_total_tokens: total,
      input_tokens: input,
      output_tokens: output,
      cached_input_tokens: cached,
      reasoning_output_tokens: reasoning,
    });
  }

  return rows;
}

function sumDailyRows(rows: AnyRecord[]) {
  return rows.reduce(
    (acc: AnyRecord, row: AnyRecord) => {
      acc.total_tokens += Number(row.total_tokens || 0);
      acc.billable_total_tokens += Number(row.billable_total_tokens || row.total_tokens || 0);
      acc.input_tokens += Number(row.input_tokens || 0);
      acc.output_tokens += Number(row.output_tokens || 0);
      acc.cached_input_tokens += Number(row.cached_input_tokens || 0);
      acc.reasoning_output_tokens += Number(row.reasoning_output_tokens || 0);
      acc.conversation_count += Number(row.conversation_count || 0);
      return acc;
    },
    {
      total_tokens: 0,
      billable_total_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
      cached_input_tokens: 0,
      reasoning_output_tokens: 0,
      conversation_count: 0,
    } as AnyRecord,
  );
}

function formatUsdFromTokens(totalTokens: any, ratePerMillion = 1.75) {
  const tokens = Number(totalTokens || 0);
  if (!Number.isFinite(tokens) || tokens <= 0) return "0.000000";
  const cost = (tokens * ratePerMillion) / 1_000_000;
  return cost.toFixed(6);
}

function scaleTotals(totals: any, weight: number) {
  const safeWeight = Number.isFinite(weight) ? weight : 0;
  return {
    total_tokens: Math.max(0, Math.round(totals.total_tokens * safeWeight)),
    billable_total_tokens: Math.max(
      0,
      Math.round((totals.billable_total_tokens ?? totals.total_tokens) * safeWeight),
    ),
    input_tokens: Math.max(0, Math.round(totals.input_tokens * safeWeight)),
    output_tokens: Math.max(0, Math.round(totals.output_tokens * safeWeight)),
    cached_input_tokens: Math.max(0, Math.round(totals.cached_input_tokens * safeWeight)),
    reasoning_output_tokens: Math.max(0, Math.round(totals.reasoning_output_tokens * safeWeight)),
  };
}

function withCost(totals: any) {
  return {
    ...totals,
    total_cost_usd: formatUsdFromTokens(totals.total_tokens),
  };
}

export function getMockUsageDaily({ from, to, seed }: AnyRecord = {}) {
  const rows = buildDailyRows({ from, to, seed });
  return { from, to, data: rows };
}

export function getMockUsageHourly({ day, seed }: AnyRecord = {}) {
  const base = parseUtcDate(day) || new Date();
  const dayKey = formatDateUTC(base);
  const rows = buildHourlyRows({ day: dayKey, seed });
  return { day: dayKey, data: rows };
}

export function getMockUsageMonthly({ months = 24, to, seed }: AnyRecord = {}) {
  const end = parseUtcDate(to) || parseUtcDate(formatDateLocal(new Date())) || new Date();
  const endDay = formatDateUTC(end);
  const rows = buildMonthlyRows({ months, to: endDay, seed });
  const startMonth = addUtcMonths(
    new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1)),
    -(months - 1),
  );
  return { from: formatDateUTC(startMonth), to: endDay, months, data: rows };
}

export function getMockUsageSummary({ from, to, seed, rolling = true }: AnyRecord = {}) {
  const rows = buildDailyRows({ from, to, seed });
  const totals = sumDailyRows(rows);
  const totalsWithCost = withCost(totals);
  const rollingPayload = rolling ? buildMockRollingSummary({ to, seed }) : null;
  return {
    from,
    to,
    days: rows.length,
    totals: totalsWithCost,
    ...(rollingPayload ? { rolling: rollingPayload } : {}),
  };
}

function buildMockRollingSummary({ to, seed }: AnyRecord = {}) {
  const end = parseUtcDate(to) || parseUtcDate(formatDateLocal(new Date())) || new Date();
  const endKey = formatDateUTC(end);
  const last7From = formatDateUTC(addUtcDays(end, -6));
  const last30From = formatDateUTC(addUtcDays(end, -29));
  const last7Rows = buildDailyRows({ from: last7From, to: endKey, seed });
  const last30Rows = buildDailyRows({ from: last30From, to: endKey, seed });

  return {
    last_7d: buildMockRollingWindow({ rows: last7Rows, from: last7From, to: endKey }),
    last_30d: buildMockRollingWindow({ rows: last30Rows, from: last30From, to: endKey }),
  };
}

function buildMockRollingWindow({ rows, from, to }: AnyRecord = {}) {
  const totals = sumDailyRows(rows || []);
  const activeDays = (rows || []).filter(
    (row: AnyRecord) => Number(row.billable_total_tokens ?? row.total_tokens) > 0,
  ).length;
  const avg = activeDays > 0 ? Math.floor(totals.billable_total_tokens / activeDays) : 0;

  return {
    from,
    to,
    totals: {
      billable_total_tokens: totals.billable_total_tokens,
      conversation_count: totals.conversation_count,
    },
    active_days: activeDays,
    avg_per_active_day: avg,
  };
}

export function getMockProjectUsageSummary({ seed, limit = 3 }: AnyRecord = {}) {
  const seedValue = toSeed(seed);
  const entries = MOCK_PROJECT_REPOS.map((repo, index) => {
    const hash = hashString(`${seedValue}:${repo}`);
    const base = 120000 + (hash % 900000);
    const drift = (index % 4) * 4200;
    const total = Math.max(0, base + drift);
    const billable = Math.max(0, Math.round(total * 0.96));
    return {
      project_key: repo,
      project_ref: `https://github.com/${repo}`,
      total_tokens: String(total),
      billable_total_tokens: String(billable),
    };
  })
    .sort((a, b) => Number(b.billable_total_tokens) - Number(a.billable_total_tokens))
    .slice(0, Math.max(1, Math.min(10, Math.floor(Number(limit) || 3))));

  return {
    generated_at: new Date().toISOString(),
    entries,
  };
}

function computeLeaderboardWindow(period: string) {
  const today = parseUtcDate(formatDateLocal(new Date())) || new Date();
  const safe =
    String(period || "week")
      .trim()
      .toLowerCase() || "week";

  if (safe === "total") {
    return { from: "1970-01-01", to: "9999-12-31" };
  }

  if (safe === "month") {
    const fromDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    const toDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
    return { from: formatDateUTC(fromDate), to: formatDateUTC(toDate) };
  }

  const dow = today.getUTCDay(); // 0=Sunday
  const from = formatDateUTC(addUtcDays(today, -dow));
  const to = formatDateUTC(addUtcDays(today, -dow + 6));
  return { from, to };
}

export function getMockLeaderboard({
  seed,
  period: rawPeriod,
  metric,
  limit = 20,
  offset = 0,
}: AnyRecord = {}) {
  const seedValue = toSeed(seed);
  const safeLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 20)));
  const safeOffset = Math.max(0, Math.min(10_000, Math.floor(Number(offset) || 0)));
  const safeMetric =
    String(metric || "all")
      .trim()
      .toLowerCase() || "all";
  const safePeriod =
    String(rawPeriod || "week")
      .trim()
      .toLowerCase() || "week";
  const period =
    safePeriod === "month" || safePeriod === "total" || safePeriod === "week" ? safePeriod : "week";
  const { from, to } = computeLeaderboardWindow(period);
  const totalEntries = 250;
  const totalPages = totalEntries > 0 ? Math.ceil(totalEntries / safeLimit) : 0;
  const page = Math.floor(safeOffset / safeLimit) + 1;

  const raw = Array.from({ length: totalEntries }, (_, index) => {
    const id = index + 1;
    const userId = `00000000-0000-0000-0000-${String(id).padStart(12, "0")}`;
    const name = MOCK_LEADERBOARD_NAMES[id % MOCK_LEADERBOARD_NAMES.length];
    const hash = hashString(`${seedValue}:${name}:${id}`);
    const base = 180000 + (hash % 900000);
    const total = Math.max(0, base + id * 1200);
    const gpt = Math.floor(total * 0.28);
    const claude = Math.floor(total * 0.18);
    const gemini = Math.floor(total * 0.1);
    const cursor = Math.floor(total * 0.1);
    const opencode = Math.floor(total * 0.08);
    const hermes = Math.floor(total * 0.03);
    const kiro = Math.floor(total * 0.02);
    const copilot = Math.floor(total * 0.04);
    const kimi = Math.floor(total * 0.03);
    const openclaw = Math.max(0, total - gpt - claude - gemini - cursor - opencode - hermes - kiro - copilot - kimi);
    const isPublic = id % 7 !== 0;
    return {
      id,
      user_id: userId,
      is_public: isPublic,
      is_me: false,
      display_name: isPublic ? name : "Anonymous",
      avatar_url: null,
      gpt_tokens: gpt,
      claude_tokens: claude,
      gemini_tokens: gemini,
      cursor_tokens: cursor,
      opencode_tokens: opencode,
      openclaw_tokens: openclaw,
      hermes_tokens: hermes,
      kiro_tokens: kiro,
      copilot_tokens: copilot,
      kimi_tokens: kimi,
      other_tokens: 0,
      total_tokens: total,
    };
  });

  const meIndex = Math.max(0, Math.min(totalEntries - 1, Math.floor(totalEntries * 0.8)));
  if (raw[meIndex]) raw[meIndex].is_me = true;

  const metricKey =
    safeMetric === "gpt" || safeMetric === "codex"
      ? "gpt_tokens"
      : safeMetric === "claude"
        ? "claude_tokens"
        : safeMetric === "gemini"
          ? "gemini_tokens"
          : safeMetric === "cursor"
            ? "cursor_tokens"
            : safeMetric === "opencode"
              ? "opencode_tokens"
              : safeMetric === "openclaw"
                ? "openclaw_tokens"
                : safeMetric === "hermes"
                  ? "hermes_tokens"
                  : safeMetric === "kiro"
                    ? "kiro_tokens"
                    : safeMetric === "copilot"
                      ? "copilot_tokens"
                      : safeMetric === "kimi"
                        ? "kimi_tokens"
                        : "total_tokens";

  const sorted = raw
    .slice()
    .sort((a: any, b: any) => Number(b[metricKey]) - Number(a[metricKey]) || a.id - b.id)
    .map((entry: any, index: number) => ({
      user_id: entry.is_public ? entry.user_id : null,
      rank: index + 1,
      is_me: Boolean(entry.is_me),
      display_name: entry.display_name,
      avatar_url: entry.avatar_url,
      gpt_tokens: String(entry.gpt_tokens),
      claude_tokens: String(entry.claude_tokens),
      gemini_tokens: String(entry.gemini_tokens),
      cursor_tokens: String(entry.cursor_tokens),
      opencode_tokens: String(entry.opencode_tokens),
      openclaw_tokens: String(entry.openclaw_tokens),
      hermes_tokens: String(entry.hermes_tokens ?? 0),
      kiro_tokens: String(entry.kiro_tokens ?? 0),
      copilot_tokens: String(entry.copilot_tokens ?? 0),
      kimi_tokens: String(entry.kimi_tokens ?? 0),
      other_tokens: String(entry.other_tokens ?? 0),
      total_tokens: String(entry.total_tokens),
      is_public: Boolean(entry.is_public),
    }));

  const meRow = sorted.find((entry: any) => entry?.is_me) || null;
  const me = meRow
    ? {
        rank: meRow.rank,
        gpt_tokens: meRow.gpt_tokens,
        claude_tokens: meRow.claude_tokens,
        gemini_tokens: meRow.gemini_tokens,
        cursor_tokens: meRow.cursor_tokens,
        opencode_tokens: meRow.opencode_tokens,
        openclaw_tokens: meRow.openclaw_tokens,
        hermes_tokens: meRow.hermes_tokens,
        kiro_tokens: meRow.kiro_tokens,
        copilot_tokens: meRow.copilot_tokens,
        kimi_tokens: meRow.kimi_tokens,
        other_tokens: meRow.other_tokens,
        total_tokens: meRow.total_tokens,
      }
    : {
        rank: null,
        gpt_tokens: "0",
        claude_tokens: "0",
        gemini_tokens: "0",
        cursor_tokens: "0",
        opencode_tokens: "0",
        openclaw_tokens: "0",
        hermes_tokens: "0",
        kiro_tokens: "0",
        copilot_tokens: "0",
        kimi_tokens: "0",
        other_tokens: "0",
        total_tokens: "0",
      };

  const entries = sorted.slice(safeOffset, safeOffset + safeLimit);

  return {
    period,
    metric: safeMetric,
    from,
    to,
    generated_at: new Date().toISOString(),
    page,
    limit: safeLimit,
    offset: safeOffset,
    total_entries: totalEntries,
    total_pages: totalPages,
    entries,
    me,
  };
}

export function getMockUsageHeatmap({
  weeks = 52,
  to,
  weekStartsOn = "sun",
  seed,
}: AnyRecord = {}) {
  const range = getHeatmapRangeLocal({
    weeks,
    now: parseUtcDate(to) || parseUtcDate(formatDateLocal(new Date())) || new Date(),
    weekStartsOn,
  });
  const rows = buildDailyRows({ from: range.from, to: range.to, seed });
  const heatmap = buildActivityHeatmap({
    dailyRows: rows,
    weeks,
    to: range.to,
    weekStartsOn,
  });

  return {
    ...heatmap,
    week_starts_on: weekStartsOn,
    active_days: rows.filter((r: any) => Number(r.billable_total_tokens ?? r.total_tokens) > 0)
      .length,
    streak_days: computeActiveStreakDays({ dailyRows: rows, to: range.to }),
  };
}

export function getMockUsageModelBreakdown({ from, to, seed }: AnyRecord = {}) {
  const rows = buildDailyRows({ from, to, seed });
  const totals = sumDailyRows(rows);

  const sources = [
    {
      source: "codex",
      weight: 0.7,
      models: [
        { model: "gpt-5.2-codex", model_id: "gpt-5.2-codex", weight: 0.2 },
        { model: "unknown", model_id: "unknown", weight: 0.8 },
      ],
    },
    {
      source: "claude",
      weight: 0.2,
      models: [
        { model: "claude-3.5", model_id: "claude-3.5", weight: 0.3 },
        { model: "unknown", model_id: "unknown", weight: 0.7 },
      ],
    },
    {
      source: "every-code",
      weight: 0.1,
      models: [{ model: "unknown", model_id: "unknown", weight: 1 }],
    },
  ];

  const sourcesData = sources.map((source) => {
    const sourceTotals = scaleTotals(totals, source.weight);
    const models = source.models.map((model) => {
      const modelTotals = scaleTotals(sourceTotals, model.weight);
      return {
        model: model.model,
        model_id: model.model_id || model.model,
        totals: withCost(modelTotals),
      };
    });
    return {
      source: source.source,
      totals: withCost(sourceTotals),
      models,
    };
  });

  return {
    from,
    to,
    days: rows.length,
    sources: sourcesData,
    pricing: {
      model: "mock",
      pricing_mode: "add",
      source: "mock",
      effective_from: formatDateLocal(new Date()),
      rates_per_million_usd: {
        input: "1.750000",
        cached_input: "0.175000",
        output: "14.000000",
        reasoning_output: "14.000000",
      },
    },
  };
}

export function getMockUsageCategoryBreakdown({ from, to, source = "claude" }: AnyRecord = {}) {
  if (source === "codex") {
    const totals = {
      input_tokens: 1_420_000,
      cached_input_tokens: 5_880_000,
      cache_creation_input_tokens: 920_000,
      output_tokens: 2_560_000,
      reasoning_output_tokens: 610_000,
      total_tokens: 10_780_000,
    };
    return {
      from,
      to,
      source: "codex",
      scope: "supported",
      totals,
      session_count: 188,
      message_count: 5_436,
      tool_calls_breakdown: {
        categories: [
          {
            name: "Execution",
            calls: 742,
            totals: {
              input_tokens: 320_000,
              cached_input_tokens: 1_040_000,
              cache_creation_input_tokens: 110_000,
              output_tokens: 460_000,
              reasoning_output_tokens: 120_000,
              total_tokens: 1_930_000,
            },
            tools: [
              {
                name: "exec_command",
                calls: 510,
                totals: {
                  input_tokens: 250_000,
                  cached_input_tokens: 820_000,
                  cache_creation_input_tokens: 80_000,
                  output_tokens: 370_000,
                  reasoning_output_tokens: 90_000,
                  total_tokens: 1_520_000,
                },
              },
              {
                name: "write_stdin",
                calls: 232,
                totals: {
                  input_tokens: 70_000,
                  cached_input_tokens: 220_000,
                  cache_creation_input_tokens: 30_000,
                  output_tokens: 90_000,
                  reasoning_output_tokens: 30_000,
                  total_tokens: 410_000,
                },
              },
            ],
          },
          {
            name: "Browser",
            calls: 406,
            totals: {
              input_tokens: 210_000,
              cached_input_tokens: 880_000,
              cache_creation_input_tokens: 90_000,
              output_tokens: 420_000,
              reasoning_output_tokens: 100_000,
              total_tokens: 1_700_000,
            },
            tools: [
              {
                name: "take_snapshot",
                calls: 180,
                totals: {
                  input_tokens: 100_000,
                  cached_input_tokens: 400_000,
                  cache_creation_input_tokens: 40_000,
                  output_tokens: 180_000,
                  reasoning_output_tokens: 40_000,
                  total_tokens: 760_000,
                },
              },
              {
                name: "click",
                calls: 126,
                totals: {
                  input_tokens: 60_000,
                  cached_input_tokens: 250_000,
                  cache_creation_input_tokens: 30_000,
                  output_tokens: 120_000,
                  reasoning_output_tokens: 35_000,
                  total_tokens: 495_000,
                },
              },
              {
                name: "evaluate_script",
                calls: 100,
                totals: {
                  input_tokens: 50_000,
                  cached_input_tokens: 230_000,
                  cache_creation_input_tokens: 20_000,
                  output_tokens: 120_000,
                  reasoning_output_tokens: 25_000,
                  total_tokens: 445_000,
                },
              },
            ],
          },
        ],
        tools_total: 3_630_000,
        privacy: {
          includes_inputs: false,
          note: "Aggregated tool names only; no tool arguments or outputs are included.",
        },
      },
      exec_command_breakdown: {
        by_type: [
          {
            name: "test",
            calls: 168,
            failures: 14,
            duration_ms: 482_000,
            max_duration_ms: 18_400,
            output_chars: 450_000,
            output_lines: 8_600,
            totals: {
              input_tokens: 90_000,
              cached_input_tokens: 320_000,
              output_tokens: 160_000,
              reasoning_output_tokens: 42_000,
              total_tokens: 612_000,
            },
          },
          {
            name: "build",
            calls: 116,
            failures: 9,
            duration_ms: 392_000,
            max_duration_ms: 22_100,
            output_chars: 310_000,
            output_lines: 5_200,
            totals: {
              input_tokens: 70_000,
              cached_input_tokens: 240_000,
              output_tokens: 130_000,
              reasoning_output_tokens: 30_000,
              total_tokens: 470_000,
            },
          },
        ],
        by_exit: [
          {
            name: "completed:0",
            calls: 438,
            failures: 0,
            duration_ms: 1_040_000,
            max_duration_ms: 22_100,
            output_chars: 830_000,
            output_lines: 13_100,
            totals: {
              input_tokens: 220_000,
              cached_input_tokens: 780_000,
              output_tokens: 350_000,
              reasoning_output_tokens: 82_000,
              total_tokens: 1_432_000,
            },
          },
          {
            name: "completed:1",
            calls: 72,
            failures: 72,
            duration_ms: 155_000,
            max_duration_ms: 11_800,
            output_chars: 120_000,
            output_lines: 2_300,
            totals: {
              input_tokens: 30_000,
              cached_input_tokens: 110_000,
              output_tokens: 55_000,
              reasoning_output_tokens: 8_000,
              total_tokens: 195_000,
            },
          },
        ],
      },
    };
  }

  if (source !== "claude") {
    return {
      from,
      to,
      source,
      scope: "unsupported",
      totals: {
        input_tokens: 0,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: 0,
      },
      categories: [
        "system_prefix",
        "conversation_history",
        "user_input",
        "tool_calls",
        "subagents",
        "reasoning",
        "assistant_response",
      ].map((key) => ({
        key,
        totals: {
          input_tokens: 0,
          cached_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
          total_tokens: 0,
        },
        percent: 0,
      })),
      session_count: 0,
      message_count: 0,
    };
  }

  const buckets: Array<{ key: string; total: number }> = [
    { key: "system_prefix", total: 12_896_539 },
    { key: "conversation_history", total: 320_207_200 },
    { key: "user_input", total: 998_025 },
    { key: "tool_calls", total: 4_808_739 },
    { key: "subagents", total: 1_022_828 },
    { key: "reasoning", total: 11_073_118 },
    { key: "assistant_response", total: 1_289_174 },
  ];
  const grandTotal = buckets.reduce((a, b) => a + b.total, 0);
  const categories = buckets.map(({ key, total }) => ({
    key,
    totals: {
      input_tokens: key === "user_input" ? total : 0,
      cached_input_tokens: key === "conversation_history" ? Math.round(total * 0.95) : 0,
      cache_creation_input_tokens:
        key === "system_prefix"
          ? total
          : key === "conversation_history"
          ? Math.round(total * 0.05)
          : 0,
      output_tokens: ["tool_calls", "subagents", "reasoning", "assistant_response"].includes(key)
        ? total
        : 0,
      reasoning_output_tokens: key === "reasoning" ? total : 0,
      total_tokens: total,
    },
    percent: Number(((total / grandTotal) * 100).toFixed(2)),
  }));

  return {
    from,
    to,
    source: "claude",
    scope: "supported",
    totals: {
      input_tokens: 998_025,
      cached_input_tokens: Math.round(320_207_200 * 0.95),
      cache_creation_input_tokens: 12_896_539 + Math.round(320_207_200 * 0.05),
      output_tokens: 4_808_739 + 1_022_828 + 11_073_118 + 1_289_174,
      reasoning_output_tokens: 11_073_118,
      total_tokens: grandTotal,
    },
    categories,
    session_count: 312,
    message_count: 12_046,
  };
}
