/**
 * InsForge Edge：排行榜快照刷新。
 * 从 tokentracker_hourly 聚合数据，按 period 写入 tokentracker_leaderboard_snapshots。
 * 接受 POST，可选 body: { period: "week"|"month"|"total" }，不传则刷新全部三个。
 */
import { createClient } from "npm:@insforge/sdk";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function logRefreshEvent(event: Record<string, unknown>) {
  console.log(JSON.stringify({ scope: "leaderboard-refresh", ...event }));
}

type Period = "week" | "month" | "total";
const ALL_PERIODS: Period[] = ["week", "month", "total"];

/** Per-model pricing (USD per million tokens), synced from local-api.js */
const MODEL_PRICING: Record<string, { input: number; output: number; cache_read: number; cache_write?: number }> = {
  // ── Anthropic Claude ──
  "claude-opus-4-6": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  "claude-opus-4-5-20250414": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  "claude-sonnet-4-6": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  "claude-sonnet-4-5-20250514": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  "claude-sonnet-4-20250514": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
  "claude-3-5-sonnet-20241022": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  "claude-3-5-haiku-20241022": { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
  // ── OpenAI GPT / Codex ──
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
  "gpt-5.5": { input: 5, output: 30, cache_read: 0.5 },
  "gpt-5-mini": { input: 0.25, output: 2, cache_read: 0.025 },
  "o3": { input: 2, output: 8, cache_read: 0.5 },
  // ── Google Gemini ──
  "gemini-2.5-pro": { input: 1.25, output: 10, cache_read: 0.125 },
  "gemini-2.5-pro-preview-06-05": { input: 1.25, output: 10, cache_read: 0.125 },
  "gemini-2.5-pro-preview-05-06": { input: 1.25, output: 10, cache_read: 0.125 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5, cache_read: 0.03 },
  "gemini-3-flash-preview": { input: 0.5, output: 3, cache_read: 0.05 },
  "gemini-3-pro-preview": { input: 2, output: 12, cache_read: 0.2 },
  "gemini-3.1-pro-preview": { input: 2, output: 12, cache_read: 0.2 },
  // ── Cursor Composer ──
  "composer-1": { input: 1.25, output: 10, cache_read: 0.125 },
  "composer-1.5": { input: 3.5, output: 17.5, cache_read: 0.35 },
  "composer-2": { input: 0.5, output: 2.5, cache_read: 0.2 },
  "composer-2-fast": { input: 1.5, output: 7.5, cache_read: 0.15 },
  // ── Moonshot Kimi ──
  "kimi-for-coding": { input: 0.6, output: 2, cache_read: 0.15 },
  "kimi-k2.5": { input: 0.6, output: 2, cache_read: 0.15 },
  "kimi-k2.5-free": { input: 0, output: 0, cache_read: 0 },
  // ── MiniMax / DeepSeek ──
  "MiniMax-M2.7": { input: 0.3, output: 1.2, cache_read: 0.06, cache_write: 0.375 },
  "MiniMax-M2.7-highspeed": { input: 0.6, output: 2.4, cache_read: 0.06, cache_write: 0.375 },
  "deepseek-v4-flash": { input: 0.14, output: 0.28, cache_read: 0.0028, cache_write: 0.14 },
  "deepseek-v4-pro": { input: 0.435, output: 0.87, cache_read: 0.003625, cache_write: 0.435 },
  "deepseek-chat": { input: 0.14, output: 0.28, cache_read: 0.0028, cache_write: 0.14 },
  "deepseek-reasoner": { input: 0.14, output: 0.28, cache_read: 0.0028, cache_write: 0.14 },
  // ── xAI Grok (mirrored from src/lib/pricing/curated-overrides.json;
  //    Grok parser emits cache_creation_input_tokens = 0, so cache_write is
  //    omitted — same as the canonical table). ──
  "grok-build": { input: 1.25, output: 2.50, cache_read: 0.20 },
  "grok-4-0709": { input: 3.00, output: 15.00, cache_read: 0.75 },
  "grok-4": { input: 3.00, output: 15.00, cache_read: 0.75 },
  "grok-4-latest": { input: 3.00, output: 15.00, cache_read: 0.75 },
  "grok-4-fast": { input: 0.20, output: 0.50, cache_read: 0.05 },
  "grok-4-fast-reasoning": { input: 0.20, output: 0.50, cache_read: 0.05 },
  "grok-4-fast-non-reasoning": { input: 0.20, output: 0.50, cache_read: 0.05 },
  "grok-4-1-fast-non-reasoning": { input: 0.20, output: 0.50, cache_read: 0.05 },
  // ── AWS Kiro (mirrored byte-for-byte from src/lib/local-api.js to
  //    prevent cloud/local cost drift — Kiro routes through Bedrock,
  //    most commonly claude-sonnet-4). ──
  "kiro-agent": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  "kiro-cli-agent": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  // ── Tencent CodeBuddy (hy3-preview family). Mirrored from
  //    src/lib/local-api.js — Tencent has not published $/MTok rates so
  //    these stay at 0. TODO: confirm Tencent hy3 pricing. ──
  "hy3-preview-agent": { input: 0, output: 0, cache_read: 0 },
  "hy3-preview": { input: 0, output: 0, cache_read: 0 },
  // ── Misc / Free ──
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
  if (lower.includes("gpt-5.5")) return MODEL_PRICING["gpt-5.5"];
  if (lower.includes("gpt-5-mini")) return MODEL_PRICING["gpt-5-mini"];
  if (lower.includes("gpt-5.3")) return MODEL_PRICING["gpt-5.3-codex"];
  if (lower.includes("gpt-5.2")) return MODEL_PRICING["gpt-5.2"];
  if (lower.includes("gpt-5.1")) return MODEL_PRICING["gpt-5.1-codex"];
  if (lower.includes("gpt-5")) return MODEL_PRICING["gpt-5"];
  if (lower.includes("gemini-3")) return MODEL_PRICING["gemini-3-flash-preview"];
  if (lower.includes("gemini-2.5")) return MODEL_PRICING["gemini-2.5-pro"];
  if (lower.includes("minimax-m2.7-highspeed")) return MODEL_PRICING["MiniMax-M2.7-highspeed"];
  if (lower.includes("minimax-m2.7")) return MODEL_PRICING["MiniMax-M2.7"];
  if (lower.includes("deepseek-v4-flash")) return MODEL_PRICING["deepseek-v4-flash"];
  if (lower.includes("deepseek-v4-pro")) return MODEL_PRICING["deepseek-v4-pro"];
  if (lower.includes("deepseek-reasoner")) return MODEL_PRICING["deepseek-reasoner"];
  if (lower.includes("deepseek-chat")) return MODEL_PRICING["deepseek-chat"];
  if (lower.includes("grok-build")) return MODEL_PRICING["grok-build"];
  if (lower.includes("grok-4-fast")) return MODEL_PRICING["grok-4-fast"];
  // grok-4-1-fast-* must precede the generic grok-4 matcher. Cloud rows may
  // carry a provider prefix or `-latest` suffix (e.g. xai/grok-4-1-fast-
  // non-reasoning-latest), and the substring "grok-4-fast" does NOT match
  // "grok-4-1-fast" (the "-1-" separates them). Without this specific match
  // these rows fall through to grok-4 and get billed at $3/$15 MTok instead
  // of the $0.20/$0.50 MTok fast-tier rate (15x / 30x overestimate).
  if (lower.includes("grok-4-1-fast")) return MODEL_PRICING["grok-4-1-fast-non-reasoning"];
  if (lower.includes("grok-4")) return MODEL_PRICING["grok-4"];
  if (lower.includes("kimi")) return MODEL_PRICING["kimi-k2.5"];
  if (lower.includes("kiro")) return MODEL_PRICING["kiro-cli-agent"];
  if (lower.includes("hy3")) return MODEL_PRICING["hy3-preview-agent"];
  if (lower.includes("composer")) return MODEL_PRICING["composer-1"];
  if (lower === "auto") return MODEL_PRICING["composer-1"];
  return ZERO_PRICING;
}

function computeRowCost(row: HourlyRow): number {
  const p = getModelPricing(row.model);
  // For Codex-family rollouts, `output_tokens` already includes any reasoning
  // tokens (OpenAI API convention), so `reasoning_output_tokens * output_rate`
  // would double-charge the reasoning slice. Kept explicit for other sources
  // where reasoning is NOT guaranteed to be folded into output_tokens.
  // Must stay in lockstep with local-api.js:computeRowCost.
  const reasoningIncludedInOutput = row.source === "codex" || row.source === "every-code";
  const reasoningCost = reasoningIncludedInOutput
    ? 0
    : (row.reasoning_output_tokens || 0) * (p.output || 0);
  return (
    ((row.input_tokens || 0) * (p.input || 0) +
      (row.output_tokens || 0) * (p.output || 0) +
      (row.cached_input_tokens || 0) * (p.cache_read || 0) +
      (row.cache_creation_input_tokens || 0) * (p.cache_write || 0) +
      reasoningCost) /
    1_000_000
  );
}

/** source -> snapshot column name */
const SOURCE_COLUMN_MAP: Record<string, string> = {
  codex: "gpt_tokens",
  claude: "claude_tokens",
  gemini: "gemini_tokens",
  cursor: "cursor_tokens",
  opencode: "opencode_tokens",
  openclaw: "openclaw_tokens",
  hermes: "hermes_tokens",
  kiro: "kiro_tokens",
  copilot: "copilot_tokens",
  kimi: "kimi_tokens",
};

interface DateRange {
  from_day: string;
  to_day: string;
}

function computeDateRange(period: Period): DateRange {
  const now = new Date();
  if (period === "week") {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    d.setUTCDate(d.getUTCDate() - d.getUTCDay()); // Sunday start
    const from_day = d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 6); // Saturday end
    const to_day = d.toISOString().slice(0, 10);
    return { from_day, to_day };
  }
  if (period === "month") {
    const from_day = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
    const to_day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0))
      .toISOString()
      .slice(0, 10);
    return { from_day, to_day };
  }
  // total — full lifetime. `from_day` is a static epoch sentinel so snapshot
  // rows always have identical (period, from_day, to_day) and upsert cleanly.
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { from_day: "1970-01-01", to_day: end.toISOString().slice(0, 10) };
}

interface HourlyRow {
  user_id: string;
  device_id: string;
  source: string;
  model: string;
  hour_start: string;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  cache_creation_input_tokens: number;
  reasoning_output_tokens: number;
}

interface UserAgg {
  gpt_tokens: number;
  claude_tokens: number;
  gemini_tokens: number;
  cursor_tokens: number;
  opencode_tokens: number;
  openclaw_tokens: number;
  hermes_tokens: number;
  kiro_tokens: number;
  copilot_tokens: number;
  kimi_tokens: number;
  other_tokens: number;
  total_tokens: number;
  estimated_cost_usd: number;
}

function newUserAgg(): UserAgg {
  return {
    gpt_tokens: 0,
    claude_tokens: 0,
    gemini_tokens: 0,
    cursor_tokens: 0,
    opencode_tokens: 0,
    openclaw_tokens: 0,
    hermes_tokens: 0,
    kiro_tokens: 0,
    copilot_tokens: 0,
    kimi_tokens: 0,
    other_tokens: 0,
    total_tokens: 0,
    estimated_cost_usd: 0,
  };
}

export default async function (req: Request): Promise<Response> {
  if (req.method === "OPTIONS")
    return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const requestStartedAt = Date.now();

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

  // Parse requested periods
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const requestSource =
    typeof body.source === "string" && body.source.trim().length > 0
      ? body.source.trim().slice(0, 80)
      : "unknown";
  let periods: Period[];
  if (body.period && ALL_PERIODS.includes(body.period as Period)) {
    periods = [body.period as Period];
  } else {
    periods = [...ALL_PERIODS];
  }

  const results: Record<string, { upserted: number; skipped?: boolean }> = {};
  const requestId = crypto.randomUUID();

  for (const period of periods) {
    const periodStartedAt = Date.now();
    const { from_day, to_day } = computeDateRange(period);

    // --- Rate limit: skip if generated_at within last 30s ---
    const { data: recentSnap } = await client.database
      .from("tokentracker_leaderboard_snapshots")
      .select("generated_at")
      .eq("period", period)
      .eq("from_day", from_day)
      .eq("to_day", to_day)
      .order("generated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (recentSnap?.generated_at) {
      const elapsed = Date.now() - new Date(recentSnap.generated_at as string).getTime();
      if (elapsed < 30_000) {
        results[period] = { upserted: 0, skipped: true };
        logRefreshEvent({
          event: "period_skipped",
          request_id: requestId,
          source: requestSource,
          period,
          from_day,
          to_day,
          upserted: 0,
          skipped: true,
          duration_ms: Date.now() - periodStartedAt,
          recent_snapshot_age_ms: elapsed,
        });
        continue;
      }
    }

    // --- Query hourly data for date range ---
    // hour_start is timestamptz; filter by >= from_day 00:00 UTC and < to_day+1 00:00 UTC
    const rangeStart = `${from_day}T00:00:00Z`;
    const nextDay = new Date(to_day + "T00:00:00Z");
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    const rangeEnd = nextDay.toISOString();

    // Pull the set of currently-active device IDs once per period. We use it
    // to drop hourly rows owned by revoked devices (historical device_id
    // churn would otherwise inflate totals — e.g. one user accumulated 17
    // device_ids before partial-unique-index was enforced).
    const activeDeviceIds = new Set<string>();
    {
      let dOffset = 0;
      const DPAGE = 1000;
      while (true) {
        const { data: devs, error: devErr } = await client.database
          .from("tokentracker_devices")
          .select("id")
          .is("revoked_at", null)
          .range(dOffset, dOffset + DPAGE - 1);
        if (devErr) return json({ error: devErr.message }, 500);
        if (!devs || devs.length === 0) break;
        for (const d of devs as Array<{ id: string }>) {
          if (typeof d.id === "string") activeDeviceIds.add(d.id);
        }
        if (devs.length < DPAGE) break;
        dOffset += DPAGE;
      }
    }

    // Paginate through hourly rows and SUM across active devices per
    // (user_id, source, model). Two machines running the same model in the
    // same hour are independent sessions and must add up — that's the
    // user-facing leaderboard expectation. Historic device_id churn is
    // handled by the active-device filter above, not by dedup.
    const aggMap = new Map<string, UserAgg>();
    let offset = 0;
    const PAGE_SIZE = 1000;
    let hasMore = true;
    let scannedRows = 0;
    let droppedInactive = 0;
    let pageCount = 0;

    while (hasMore) {
      const { data: rows, error } = await client.database
        .from("tokentracker_hourly")
        .select("user_id, device_id, source, model, hour_start, total_tokens, input_tokens, output_tokens, cached_input_tokens, cache_creation_input_tokens, reasoning_output_tokens")
        .gte("hour_start", rangeStart)
        .lt("hour_start", rangeEnd)
        .order("hour_start", { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);

      if (error) {
        logRefreshEvent({
          event: "period_error",
          request_id: requestId,
          source: requestSource,
          period,
          from_day,
          to_day,
          stage: "scan_hourly",
          error: error.message,
          scanned_rows: scannedRows,
          pages_fetched: pageCount,
          duration_ms: Date.now() - periodStartedAt,
        });
        return json({ error: error.message }, 500);
      }
      if (!rows || rows.length === 0) break;
      scannedRows += rows.length;
      pageCount += 1;

      for (const row of rows as HourlyRow[]) {
        if (!activeDeviceIds.has(row.device_id)) {
          droppedInactive += 1;
          continue;
        }
        let agg = aggMap.get(row.user_id);
        if (!agg) {
          agg = newUserAgg();
          aggMap.set(row.user_id, agg);
        }
        const tokens = Number(row.total_tokens) || 0;
        const col = SOURCE_COLUMN_MAP[row.source] ?? "other_tokens";
        (agg as unknown as Record<string, number>)[col] += tokens;
        agg.total_tokens += tokens;
        agg.estimated_cost_usd += computeRowCost(row);
      }

      hasMore = rows.length === PAGE_SIZE;
      offset += PAGE_SIZE;
    }

    if (aggMap.size === 0) {
      results[period] = { upserted: 0 };
      logRefreshEvent({
        event: "period_completed",
        request_id: requestId,
        source: requestSource,
        period,
        from_day,
        to_day,
        scanned_rows: scannedRows,
        pages_fetched: pageCount,
        dropped_inactive_device_rows: droppedInactive,
        aggregated_users: 0,
        upserted: 0,
        skipped: false,
        duration_ms: Date.now() - periodStartedAt,
      });
      continue;
    }

    // --- Fetch user settings for public/anonymous flags ---
    const userIds = Array.from(aggMap.keys());
    type UserSettingsRow = {
      user_id: string;
      leaderboard_public: boolean;
      leaderboard_anonymous: boolean;
      github_url: string | null;
      show_github_url: boolean;
    };
    const settingsMap = new Map<string, UserSettingsRow>();

    // Fetch in batches of 25. PostgREST .in() encodes user_ids into the URL
    // (~42 bytes per UUID after URL-encoding); a batch of 100 produces a
    // ~4 KB URL that the InsForge gateway silently truncates, returning
    // {data: null, error}. The bug surfaced once the all-time leaderboard
    // crossed ~80 users and produced an entirely Anonymous snapshot. 25
    // keeps the URL well under 1.5 KB regardless of user count.
    for (let i = 0; i < userIds.length; i += 25) {
      const batch = userIds.slice(i, i + 25);
      const { data: settings, error: settingsErr } = await client.database
        .from("tokentracker_user_settings")
        .select("user_id, leaderboard_public, leaderboard_anonymous, github_url, show_github_url")
        .in("user_id", batch);

      if (settingsErr) {
        logRefreshEvent({
          event: "user_settings_fetch_error",
          period,
          batch_size: batch.length,
          error: settingsErr.message,
        });
      }
      if (settings) {
        for (const s of settings as UserSettingsRow[]) {
          settingsMap.set(s.user_id, s);
        }
      }
    }

    // --- Fetch display_name/avatar_url from auth.users ---
    const userProfiles = new Map<string, { display_name: string | null; avatar_url: string | null }>();
    for (let i = 0; i < userIds.length; i += 25) {
      const batch = userIds.slice(i, i + 25);
      const { data: users, error: profilesErr } = await client.database
        .from("tokentracker_user_profiles")
        .select("user_id, display_name, avatar_url")
        .in("user_id", batch);

      if (profilesErr) {
        logRefreshEvent({
          event: "user_profiles_fetch_error",
          period,
          batch_size: batch.length,
          error: profilesErr.message,
        });
      }
      if (users) {
        for (const u of users as { user_id: string; display_name: string | null; avatar_url: string | null }[]) {
          userProfiles.set(u.user_id, { display_name: u.display_name, avatar_url: u.avatar_url });
        }
      }
    }

    // Fallback: existing snapshots for users not in auth.users
    for (let i = 0; i < userIds.length; i += 25) {
      if ([...userIds.slice(i, i + 25)].every(id => userProfiles.has(id))) continue;
      const missing = userIds.slice(i, i + 25).filter(id => !userProfiles.has(id));
      if (missing.length === 0) continue;
      const { data: existing, error: fallbackErr } = await client.database
        .from("tokentracker_leaderboard_snapshots")
        .select("user_id, display_name, avatar_url")
        .in("user_id", missing)
        .order("generated_at", { ascending: false });
      if (fallbackErr) {
        logRefreshEvent({
          event: "snapshot_fallback_fetch_error",
          period,
          batch_size: missing.length,
          error: fallbackErr.message,
        });
      }
      if (existing) {
        for (const e of existing as { user_id: string; display_name: string | null; avatar_url: string | null }[]) {
          if (!userProfiles.has(e.user_id)) {
            userProfiles.set(e.user_id, { display_name: e.display_name, avatar_url: e.avatar_url });
          }
        }
      }
    }

    // --- Rank users by total_tokens DESC ---
    const sorted = Array.from(aggMap.entries()).sort((a, b) => b[1].total_tokens - a[1].total_tokens);

    const generatedAt = new Date().toISOString();
    const upsertRows = sorted.map(([userId, agg], idx) => {
      const settings = settingsMap.get(userId);
      const isPublic = settings?.leaderboard_public ?? false;
      const isAnonymous = settings?.leaderboard_anonymous ?? false;
      const profile = userProfiles.get(userId);
      const displayName = isAnonymous ? "Anonymous" : (profile?.display_name ?? "Anonymous");
      const avatarUrl = isAnonymous ? null : (profile?.avatar_url ?? null);
      // Only surface github_url on the public snapshot when the user opted in
      // AND isn't in anonymous mode — anonymous takes precedence over any
      // identifying link.
      const githubUrl = !isAnonymous && settings?.show_github_url && settings?.github_url
        ? settings.github_url
        : null;

      return {
        user_id: userId,
        period,
        from_day,
        to_day,
        rank: idx + 1,
        gpt_tokens: agg.gpt_tokens,
        claude_tokens: agg.claude_tokens,
        gemini_tokens: agg.gemini_tokens,
        cursor_tokens: agg.cursor_tokens,
        opencode_tokens: agg.opencode_tokens,
        openclaw_tokens: agg.openclaw_tokens,
        hermes_tokens: agg.hermes_tokens,
        kiro_tokens: agg.kiro_tokens,
        copilot_tokens: agg.copilot_tokens,
        kimi_tokens: agg.kimi_tokens,
        other_tokens: agg.other_tokens,
        total_tokens: agg.total_tokens,
        estimated_cost_usd: Math.round(agg.estimated_cost_usd * 100) / 100,
        display_name: displayName,
        avatar_url: avatarUrl,
        github_url: githubUrl,
        is_public: isPublic,
        generated_at: generatedAt,
      };
    });

    // Upsert in batches of 200
    for (let i = 0; i < upsertRows.length; i += 200) {
      const batch = upsertRows.slice(i, i + 200);
      const { error: upsertErr } = await client.database
        .from("tokentracker_leaderboard_snapshots")
        .upsert(batch, { onConflict: "user_id,period,from_day,to_day" });

      if (upsertErr) {
        logRefreshEvent({
          event: "period_error",
          request_id: requestId,
          source: requestSource,
          period,
          from_day,
          to_day,
          stage: "upsert_snapshot",
          error: upsertErr.message,
          scanned_rows: scannedRows,
          pages_fetched: pageCount,
          dropped_inactive_device_rows: droppedInactive,
          aggregated_users: aggMap.size,
          duration_ms: Date.now() - periodStartedAt,
        });
        return json({ error: upsertErr.message }, 500);
      }
    }

    results[period] = { upserted: upsertRows.length };
    logRefreshEvent({
      event: "period_completed",
      request_id: requestId,
      source: requestSource,
      period,
      from_day,
      to_day,
      scanned_rows: scannedRows,
      pages_fetched: pageCount,
      dropped_inactive_device_rows: droppedInactive,
      aggregated_users: aggMap.size,
      upserted: upsertRows.length,
      skipped: false,
      duration_ms: Date.now() - periodStartedAt,
    });
  }

  logRefreshEvent({
    event: "request_completed",
    request_id: requestId,
    source: requestSource,
    requested_periods: periods,
    duration_ms: Date.now() - requestStartedAt,
    results,
  });
  return json({ ok: true, results });
}
