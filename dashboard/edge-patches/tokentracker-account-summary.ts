/**
 * InsForge Edge: account-wide usage summary (cross-device, aggregated by user_id).
 * Mirrors local-api.js `tokentracker-usage-summary` response schema.
 * Auth: reads `Authorization: Bearer <jwt>`; extracts user_id from payload.sub
 * (or payload.user_id). JWT signature is NOT verified in this function.
 */
import { createClient } from "npm:@insforge/sdk";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Convert UTC timestamp to local YYYY-MM-DD (see local-api.js#getZonedParts).
 * Positive offsetMinutes = east of UTC.
 */
function zonedDayKey(hourStart: string, tz: string | null, offsetMinutes: number | null): string {
  if (tz) {
    try {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(new Date(hourStart));
      const y = parts.find((p) => p.type === "year")?.value;
      const m = parts.find((p) => p.type === "month")?.value;
      const d = parts.find((p) => p.type === "day")?.value;
      if (y && m && d) return `${y}-${m}-${d}`;
    } catch { /* fall through */ }
  }
  if (offsetMinutes != null && Number.isFinite(offsetMinutes)) {
    const shifted = new Date(new Date(hourStart).getTime() + offsetMinutes * 60000);
    return shifted.toISOString().slice(0, 10);
  }
  return hourStart.slice(0, 10);
}

function decodeJwtUserId(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payloadRaw = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payloadRaw + "=".repeat((4 - (payloadRaw.length % 4)) % 4);
    const decoded = atob(padded);
    const payload = JSON.parse(decoded) as Record<string, unknown>;
    const sub = (payload.sub ?? payload.user_id) as string | undefined;
    return typeof sub === "string" && sub.length > 0 ? sub : null;
  } catch {
    return null;
  }
}

/** Per-model pricing (USD per million tokens). Synced from src/lib/local-api.js. */
const MODEL_PRICING: Record<string, { input: number; output: number; cache_read: number; cache_write?: number }> = {
  "claude-opus-4-6": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  "claude-opus-4-5-20250414": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  "claude-sonnet-4-6": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  "claude-sonnet-4-5-20250514": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  "claude-sonnet-4-20250514": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
  "claude-3-5-sonnet-20241022": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  "claude-3-5-haiku-20241022": { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
  "gpt-5": { input: 1.25, output: 10, cache_read: 0.125 },
  "gpt-5-fast": { input: 1.25, output: 10, cache_read: 0.125 },
  "gpt-5-high": { input: 1.25, output: 10, cache_read: 0.125 },
  "gpt-5-high-fast": { input: 1.25, output: 10, cache_read: 0.125 },
  "gpt-5-codex": { input: 1.25, output: 10, cache_read: 0.125 },
  "gpt-5-codex-high-fast": { input: 1.25, output: 10, cache_read: 0.125 },
  "gpt-5.1-codex": { input: 1.25, output: 10, cache_read: 0.125 },
  "gpt-5.1-codex-mini": { input: 0.25, output: 2, cache_read: 0.025 },
  "gpt-5.1-codex-max": { input: 1.25, output: 10, cache_read: 0.125 },
  "gpt-5.1-codex-max-high-fast": { input: 1.25, output: 10, cache_read: 0.125 },
  "gpt-5.1-codex-max-xhigh-fast": { input: 1.25, output: 10, cache_read: 0.125 },
  "gpt-5.1-codex-high": { input: 1.25, output: 10, cache_read: 0.125 },
  "gpt-5.1-codex-max-high": { input: 1.25, output: 10, cache_read: 0.125 },
  "gpt-5.2": { input: 1.75, output: 14, cache_read: 0.175 },
  "gpt-5.2-high": { input: 1.75, output: 14, cache_read: 0.175 },
  "gpt-5.2-high-fast": { input: 1.75, output: 14, cache_read: 0.175 },
  "gpt-5.2-codex": { input: 1.75, output: 14, cache_read: 0.175 },
  "gpt-5.2-codex-high": { input: 1.75, output: 14, cache_read: 0.175 },
  "gpt-5.3-codex": { input: 1.75, output: 14, cache_read: 0.175 },
  "gpt-5.3-codex-high": { input: 1.75, output: 14, cache_read: 0.175 },
  "gpt-5.4": { input: 2.5, output: 15, cache_read: 0.25 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5, cache_read: 0.075 },
  "gpt-5.4-medium": { input: 1.5, output: 10, cache_read: 0.15 },
  "o3": { input: 2, output: 8, cache_read: 0.5 },
  "gemini-2.5-pro": { input: 1.25, output: 10, cache_read: 0.125 },
  "gemini-2.5-pro-preview-06-05": { input: 1.25, output: 10, cache_read: 0.125 },
  "gemini-2.5-pro-preview-05-06": { input: 1.25, output: 10, cache_read: 0.125 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5, cache_read: 0.03 },
  "gemini-3-flash-preview": { input: 0.5, output: 3, cache_read: 0.05 },
  "gemini-3-pro-preview": { input: 2, output: 12, cache_read: 0.2 },
  "gemini-3.1-pro-preview": { input: 2, output: 12, cache_read: 0.2 },
  "composer-1": { input: 1.25, output: 10, cache_read: 0.125 },
  "composer-1.5": { input: 3.5, output: 17.5, cache_read: 0.35 },
  "composer-2": { input: 0.5, output: 2.5, cache_read: 0.2 },
  "composer-2-fast": { input: 1.5, output: 7.5, cache_read: 0.15 },
  "kimi-for-coding": { input: 0.6, output: 2, cache_read: 0.15 },
  "kimi-k2.5": { input: 0.6, output: 2, cache_read: 0.15 },
  "kimi-k2.5-free": { input: 0, output: 0, cache_read: 0 },
  "glm-4.7-free": { input: 0, output: 0, cache_read: 0 },
  "nemotron-3-super-free": { input: 0, output: 0, cache_read: 0 },
  "mimo-v2-pro-free": { input: 0, output: 0, cache_read: 0 },
  "minimax-m2.1-free": { input: 0, output: 0, cache_read: 0 },
  "MiniMax-M2.1": { input: 0.5, output: 3, cache_read: 0.05 },
};
const ZERO_PRICING = { input: 0, output: 0, cache_read: 0, cache_write: 0 };

function getModelPricing(model: string) {
  if (!model) return ZERO_PRICING;
  const exact = MODEL_PRICING[model];
  if (exact) return exact;
  const lower = model.toLowerCase();
  if (lower.includes("opus")) return MODEL_PRICING["claude-opus-4-6"];
  if (lower.includes("haiku")) return MODEL_PRICING["claude-haiku-4-5-20251001"];
  if (lower.includes("sonnet")) return MODEL_PRICING["claude-sonnet-4-6"];
  if (lower.includes("gpt-5.4")) return MODEL_PRICING["gpt-5.4"];
  if (lower.includes("gpt-5.3")) return MODEL_PRICING["gpt-5.3-codex"];
  if (lower.includes("gpt-5.2")) return MODEL_PRICING["gpt-5.2"];
  if (lower.includes("gpt-5.1")) return MODEL_PRICING["gpt-5.1-codex"];
  if (lower.includes("gpt-5")) return MODEL_PRICING["gpt-5"];
  if (lower.includes("gemini-3")) return MODEL_PRICING["gemini-3-flash-preview"];
  if (lower.includes("gemini-2.5")) return MODEL_PRICING["gemini-2.5-pro"];
  if (lower.includes("kimi")) return MODEL_PRICING["kimi-k2.5"];
  if (lower.includes("composer")) return MODEL_PRICING["composer-1"];
  if (lower === "auto") return MODEL_PRICING["composer-1"];
  return ZERO_PRICING;
}

interface HourlyRow {
  hour_start: string;
  source: string;
  model: string;
  total_tokens: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  reasoning_output_tokens: number | null;
  conversation_count: number | null;
}

function computeRowCost(row: HourlyRow): number {
  const p = getModelPricing(row.model);
  return (
    ((Number(row.input_tokens) || 0) * (p.input || 0) +
      (Number(row.output_tokens) || 0) * (p.output || 0) +
      (Number(row.cached_input_tokens) || 0) * (p.cache_read || 0) +
      (Number(row.cache_creation_input_tokens) || 0) * ((p.cache_write ?? 0)) +
      (Number(row.reasoning_output_tokens) || 0) * (p.output || 0)) /
    1_000_000
  );
}

interface DayAgg {
  day: string;
  total_tokens: number;
  billable_total_tokens: number;
  total_cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  cache_creation_input_tokens: number;
  reasoning_output_tokens: number;
  conversation_count: number;
}

function aggregateByDay(
  rows: HourlyRow[],
  tz: string | null,
  tzOffsetMinutes: number | null,
): DayAgg[] {
  const byDay = new Map<string, DayAgg>();
  for (const row of rows) {
    if (!row.hour_start) continue;
    const day = zonedDayKey(String(row.hour_start), tz, tzOffsetMinutes);
    let a = byDay.get(day);
    if (!a) {
      a = {
        day,
        total_tokens: 0,
        billable_total_tokens: 0,
        total_cost_usd: 0,
        input_tokens: 0,
        output_tokens: 0,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        reasoning_output_tokens: 0,
        conversation_count: 0,
      };
      byDay.set(day, a);
    }
    const tt = Number(row.total_tokens) || 0;
    a.total_tokens += tt;
    a.billable_total_tokens += tt;
    a.total_cost_usd += computeRowCost(row);
    a.input_tokens += Number(row.input_tokens) || 0;
    a.output_tokens += Number(row.output_tokens) || 0;
    a.cached_input_tokens += Number(row.cached_input_tokens) || 0;
    a.cache_creation_input_tokens += Number(row.cache_creation_input_tokens) || 0;
    a.reasoning_output_tokens += Number(row.reasoning_output_tokens) || 0;
    a.conversation_count += Number(row.conversation_count) || 0;
  }
  return Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day));
}

async function fetchAllRows(
  client: ReturnType<typeof createClient>,
  userId: string,
  rangeStart: string,
  rangeEnd: string,
  columns = "hour_start, source, model, total_tokens, input_tokens, output_tokens, cached_input_tokens, cache_creation_input_tokens, reasoning_output_tokens, conversation_count",
): Promise<HourlyRow[]> {
  const out: HourlyRow[] = [];
  let offset = 0;
  const PAGE_SIZE = 1000;
  while (true) {
    const { data, error } = await client.database
      .from("tokentracker_hourly")
      .select(columns)
      .eq("user_id", userId)
      .gte("hour_start", rangeStart)
      .lt("hour_start", rangeEnd)
      .order("hour_start", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    out.push(...(data as unknown as HourlyRow[]));
    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return out;
}

export default async function (req: Request): Promise<Response> {
  if (req.method === "OPTIONS")
    return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const userId = decodeJwtUserId(req.headers.get("Authorization"));
  if (!userId) return json({ error: "Unauthorized" }, 401);

  const url = new URL(req.url);
  const from = url.searchParams.get("from") || "";
  const to = url.searchParams.get("to") || "";
  if (!from || !to) return json({ error: "Missing from/to" }, 400);
  const tz = url.searchParams.get("tz") || null;
  const tzOffsetRaw = url.searchParams.get("tz_offset_minutes");
  const tzOffsetMinutes = tzOffsetRaw != null && tzOffsetRaw !== "" ? Number(tzOffsetRaw) : null;

  const baseUrl = Deno.env.get("INSFORGE_BASE_URL")!;
  const incomingApiKey =
    req.headers.get("apikey") ?? req.headers.get("Apikey") ?? req.headers.get("x-api-key") ?? undefined;
  const anonKey =
    Deno.env.get("INSFORGE_ANON_KEY") ?? Deno.env.get("ANON_KEY") ?? incomingApiKey ?? undefined;
  const serviceRoleKey = Deno.env.get("INSFORGE_SERVICE_ROLE_KEY");
  const dbToken = serviceRoleKey || anonKey;

  const client = createClient({
    baseUrl,
    edgeFunctionToken: dbToken,
    anonKey,
    ...(anonKey ? { headers: { apikey: anonKey } } : {}),
  });

  // Range for requested [from, to]; widen ±1 day to capture TZ-shifted
  // edge hours for non-UTC callers.
  const startDate = new Date(`${from}T00:00:00Z`);
  startDate.setUTCDate(startDate.getUTCDate() - 1);
  const nextDay = new Date(`${to}T00:00:00Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 2);
  const rangeStart = startDate.toISOString();
  const rangeEnd = nextDay.toISOString();

  // Anchor rolling windows to the caller's local "today" (matches daily
  // buckets which are keyed by local day via zonedDayKey).
  const todayStr = zonedDayKey(new Date().toISOString(), tz, tzOffsetMinutes);
  const todayUtcMidnight = new Date(`${todayStr}T00:00:00Z`);
  const thirtyAgo = new Date(todayUtcMidnight);
  thirtyAgo.setUTCDate(thirtyAgo.getUTCDate() - 29);
  const thirtyAgoStr = thirtyAgo.toISOString().slice(0, 10);
  // Widen ±1 UTC day around the local-day boundary for query safety.
  const rollingStartDate = new Date(`${(thirtyAgoStr < from ? thirtyAgoStr : from)}T00:00:00Z`);
  rollingStartDate.setUTCDate(rollingStartDate.getUTCDate() - 1);
  const rollingEndDate = new Date(todayUtcMidnight);
  rollingEndDate.setUTCDate(rollingEndDate.getUTCDate() + 2);
  const rollingStart = rollingStartDate.toISOString();
  const rollingEndNext = rollingEndDate;

  let allRows: HourlyRow[];
  try {
    allRows = await fetchAllRows(client, userId, rollingStart, rollingEndNext.toISOString());
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }

  const allDaily = aggregateByDay(allRows, tz, tzOffsetMinutes);
  const daily = allDaily.filter((d) => d.day >= from && d.day <= to);

  const totals = daily.reduce(
    (acc, r) => {
      acc.total_tokens += r.total_tokens;
      acc.billable_total_tokens += r.billable_total_tokens;
      acc.total_cost_usd += r.total_cost_usd || 0;
      acc.input_tokens += r.input_tokens;
      acc.output_tokens += r.output_tokens;
      acc.cached_input_tokens += r.cached_input_tokens;
      acc.cache_creation_input_tokens += r.cache_creation_input_tokens;
      acc.reasoning_output_tokens += r.reasoning_output_tokens;
      acc.conversation_count += r.conversation_count;
      return acc;
    },
    {
      total_tokens: 0,
      billable_total_tokens: 0,
      total_cost_usd: 0,
      input_tokens: 0,
      output_tokens: 0,
      cached_input_tokens: 0,
      cache_creation_input_tokens: 0,
      reasoning_output_tokens: 0,
      conversation_count: 0,
    },
  );
  const totalCost = totals.total_cost_usd;

  const collectDays = (n: number) => {
    const out: DayAgg[] = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(todayUtcMidnight);
      d.setUTCDate(d.getUTCDate() - i);
      const ds = d.toISOString().slice(0, 10);
      const dd = allDaily.find((x) => x.day === ds);
      if (dd) out.push(dd);
    }
    return out;
  };
  const sumDays = (days: DayAgg[]) =>
    days.reduce(
      (a, r) => {
        a.billable_total_tokens += r.billable_total_tokens;
        a.conversation_count += r.conversation_count;
        return a;
      },
      { billable_total_tokens: 0, conversation_count: 0 },
    );

  const l7 = collectDays(7);
  const l30 = collectDays(30);
  const l7t = sumDays(l7);
  const l30t = sumDays(l30);
  const l7from = new Date(todayUtcMidnight);
  l7from.setUTCDate(l7from.getUTCDate() - 6);
  const l30from = new Date(todayUtcMidnight);
  l30from.setUTCDate(l30from.getUTCDate() - 29);

  return json({
    from,
    to,
    days: daily.length,
    totals: { ...totals, total_cost_usd: totalCost.toFixed(6) },
    rolling: {
      last_7d: {
        from: l7from.toISOString().slice(0, 10),
        to: todayStr,
        active_days: l7.length,
        totals: l7t,
      },
      last_30d: {
        from: l30from.toISOString().slice(0, 10),
        to: todayStr,
        active_days: l30.length,
        totals: l30t,
        avg_per_active_day:
          l30.length > 0 ? Math.round(l30t.billable_total_tokens / l30.length) : 0,
      },
    },
  });
}
