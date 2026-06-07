/**
 * InsForge Edge: account-wide daily usage (cross-device, aggregated by user_id).
 * Mirrors local-api.js `tokentracker-usage-daily` response schema.
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
 * Convert a UTC timestamp to the caller's local YYYY-MM-DD. Mirrors the
 * convention used by src/lib/local-api.js#getZonedParts:
 *   - tz: IANA name (preferred); resolved via Intl.DateTimeFormat("en-CA")
 *   - offsetMinutes: positive = east of UTC (e.g. +480 for Asia/Shanghai)
 * Falls back to UTC slice when neither is provided/valid.
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

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (b64.length % 4)) % 4;
  const raw = atob(b64 + "=".repeat(pad));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Verify HS256 JWT against JWT_SECRET and return its sub. Mirrors the helper
 * in tokentracker-device-token-issue.ts. Returns null on any failure — caller
 * surfaces that as 401. InsForge does NOT validate JWTs at the gateway, so
 * exposing per-user data without local verification lets anyone forge
 * {"sub":"<victim>"} and read another user's data.
 */
async function verifiedUserIdFromJwt(authHeader: string | null): Promise<string | null> {
  if (!authHeader) return null;
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const secret = Deno.env.get("JWT_SECRET");
  if (!secret) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const sig = b64urlToBytes(parts[2]);
    const ok = await crypto.subtle.verify("HMAC", key, sig, data);
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1]))) as Record<string, unknown>;
    if (typeof payload.exp === "number" && Date.now() / 1000 > payload.exp) return null;
    const sub = payload.sub;
    if (typeof sub === "string" && sub.length > 0) return sub;
    const uid = payload.user_id;
    if (typeof uid === "string" && uid.length > 0) return uid;
  } catch { /* ignore */ }
  return null;
}

async function fetchActiveDeviceIds(
  client: ReturnType<typeof createClient>,
  userId: string,
): Promise<string[]> {
  const { data, error } = await client.database
    .from("tokentracker_devices")
    .select("id")
    .eq("user_id", userId)
    .is("revoked_at", null);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<{ id: string }>;
  return rows.map((r) => r.id).filter((id): id is string => typeof id === "string" && id.length > 0);
}


// MODEL_PRICING + getModelPricing synced from tokentracker-leaderboard-refresh.ts
// 2026-05-28: includes mimo, gpt-5.5, glm, grok, deepseek-v4, kiro, hy3-preview (86 models).
// Keep this block byte-identical with leaderboard-refresh.ts; see feedback_model_pricing_sync.
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
  "kimi-k2.6": { input: 0.95, output: 4, cache_read: 0.16 },
  // ── Z.ai GLM (mirrored from src/lib/pricing/curated-overrides.json).
  //    LiteLLM only keys these under provider prefixes like `zai/glm-5`,
  //    `openrouter/z-ai/glm-4.6`, etc. The reverse-substring fallback in the
  //    matcher requires the user-supplied model name to CONTAIN the LiteLLM
  //    key, so the bare `glm-5.1` / `glm-4.6` strings reported by Claude
  //    Code-compatible GLM endpoints never match. Curate them here. ──
  "glm-5.1": { input: 1.4, output: 4.4, cache_read: 0.26 },
  "glm-5": { input: 1.0, output: 3.2, cache_read: 0.2 },
  "glm-5-turbo": { input: 1.2, output: 4.0, cache_read: 0.24 },
  "glm-4.7": { input: 0.6, output: 2.2, cache_read: 0.11 },
  "glm-4.7-flashx": { input: 0.07, output: 0.4, cache_read: 0.01 },
  "glm-4.7-flash": { input: 0, output: 0, cache_read: 0 },
  "glm-4.6": { input: 0.6, output: 2.2, cache_read: 0.11 },
  "glm-4.5": { input: 0.6, output: 2.2, cache_read: 0.11 },
  "glm-4.5-x": { input: 2.2, output: 8.9, cache_read: 0.45 },
  "glm-4.5-air": { input: 0.2, output: 1.1, cache_read: 0.03 },
  "glm-4.5-airx": { input: 1.1, output: 4.5, cache_read: 0.22 },
  "glm-4.5-flash": { input: 0, output: 0, cache_read: 0 },
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
  // ── Xiaomi MiMo (mirrored from src/lib/pricing/seed-snapshot.json LiteLLM
  //    entries openrouter/xiaomi/mimo-*; queue rows report the bare names.
  //    Kept in lockstep with the matcher's litellm:prefix-strip resolution —
  //    cache_read for mimo-v2-flash uses novita's 0.02 (the lexicographically
  //    smallest provider key the matcher deterministically picks). ──
  "mimo-v2.5-pro": { input: 1, output: 3, cache_read: 0.2 },
  "mimo-v2.5": { input: 0.4, output: 2, cache_read: 0.08 },
  "mimo-v2-flash": { input: 0.1, output: 0.3, cache_read: 0.02 },
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
  if (lower.includes("kimi-k2.6")) return MODEL_PRICING["kimi-k2.6"];
  if (lower.includes("kimi")) return MODEL_PRICING["kimi-k2.5"];
  // MiMo ordering: more specific suffixes first (mimo-v2.5-pro before
  // mimo-v2.5 which is a substring; the free tier is a distinct name).
  if (lower.includes("mimo-v2-pro-free")) return MODEL_PRICING["mimo-v2-pro-free"];
  if (lower.includes("mimo-v2.5-pro")) return MODEL_PRICING["mimo-v2.5-pro"];
  if (lower.includes("mimo-v2.5")) return MODEL_PRICING["mimo-v2.5"];
  if (lower.includes("mimo-v2-flash")) return MODEL_PRICING["mimo-v2-flash"];
  // GLM ordering: more specific suffixes (-airx/-air/-x/-flash/-flashx/-turbo)
  // must precede the base matchers. glm-5.1 must precede glm-5 (substring).
  if (lower.includes("glm-4.5-airx")) return MODEL_PRICING["glm-4.5-airx"];
  if (lower.includes("glm-4.5-air")) return MODEL_PRICING["glm-4.5-air"];
  if (lower.includes("glm-4.5-x")) return MODEL_PRICING["glm-4.5-x"];
  if (lower.includes("glm-4.5-flash")) return MODEL_PRICING["glm-4.5-flash"];
  if (lower.includes("glm-4.5")) return MODEL_PRICING["glm-4.5"];
  if (lower.includes("glm-4.7-flashx")) return MODEL_PRICING["glm-4.7-flashx"];
  if (lower.includes("glm-4.7-flash")) return MODEL_PRICING["glm-4.7-flash"];
  if (lower.includes("glm-4.7")) return MODEL_PRICING["glm-4.7"];
  if (lower.includes("glm-4.6")) return MODEL_PRICING["glm-4.6"];
  if (lower.includes("glm-5-turbo")) return MODEL_PRICING["glm-5-turbo"];
  if (lower.includes("glm-5.1")) return MODEL_PRICING["glm-5.1"];
  if (lower.includes("glm-5")) return MODEL_PRICING["glm-5"];
  if (lower.includes("kiro")) return MODEL_PRICING["kiro-cli-agent"];
  if (lower.includes("hy3")) return MODEL_PRICING["hy3-preview-agent"];
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
  conversations: number | null;
}

interface GroupedRow {
  bucket: string;
  source: string;
  model: string;
  total_tokens: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  reasoning_output_tokens: number | null;
  conversations: number | null;
}

/**
 * Server-side aggregation. One RPC replaces the old N paginated 1000-row raw
 * fetches: account_usage_grouped() GROUPs BY (tz-local bucket, source, model)
 * in Postgres and returns a single JSONB array. SUM across the user's active
 * devices is byte-identical to the old in-edge aggregation; tz-local bucketing
 * uses `AT TIME ZONE` (same IANA database as the old JS Intl path, incl. DST).
 */
async function fetchGroupedRows(
  client: ReturnType<typeof createClient>,
  userId: string,
  activeDeviceIds: string[],
  fromIso: string,
  toIso: string,
  trunc: "hour" | "day" | "month" | "none",
  tz: string | null,
  tzOffsetMinutes: number | null,
): Promise<GroupedRow[]> {
  if (activeDeviceIds.length === 0) return [];
  const { data, error } = await client.database.rpc("account_usage_grouped", {
    p_user_id: userId,
    p_device_ids: activeDeviceIds,
    p_from: fromIso,
    p_to: toIso,
    p_trunc: trunc,
    p_tz: tz,
    p_offset_min: tzOffsetMinutes,
  });
  if (error) throw new Error(error.message);
  return (Array.isArray(data) ? data : []) as GroupedRow[];
}

function computeRowCost(row: GroupedRow): number {
  const p = getModelPricing(row.model);
  // Codex / every-code fold reasoning into output_tokens (OpenAI convention),
  // so charging reasoning_output_tokens again at the output rate double-counts.
  // Must stay in lockstep with src/lib/pricing/index.js:computeRowCost and
  // tokentracker-leaderboard-refresh.ts (both guard on source).
  const reasoningCost =
    row.source === "codex" || row.source === "every-code"
      ? 0
      : (Number(row.reasoning_output_tokens) || 0) * (p.output || 0);
  return (
    ((Number(row.input_tokens) || 0) * (p.input || 0) +
      (Number(row.output_tokens) || 0) * (p.output || 0) +
      (Number(row.cached_input_tokens) || 0) * (p.cache_read || 0) +
      (Number(row.cache_creation_input_tokens) || 0) * ((p.cache_write ?? 0)) +
      reasoningCost) /
    1_000_000
  );
}

export default async function (req: Request): Promise<Response> {
  if (req.method === "OPTIONS")
    return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

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

  const userId = await verifiedUserIdFromJwt(req.headers.get("Authorization"));
  if (!userId) return json({ error: "Unauthorized" }, 401);

  let activeDeviceIds: string[];
  try {
    activeDeviceIds = await fetchActiveDeviceIds(client, userId);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }

  // Widen the UTC query window by ±1 day so TZ-shifted buckets at the
  // edges still capture the relevant hours (up to 14h offset worldwide).
  const startDate = new Date(`${from}T00:00:00Z`);
  startDate.setUTCDate(startDate.getUTCDate() - 1);
  const endDate = new Date(`${to}T00:00:00Z`);
  endDate.setUTCDate(endDate.getUTCDate() + 2);
  const rangeStart = startDate.toISOString();
  const rangeEnd = endDate.toISOString();

  let rows: GroupedRow[];
  try {
    rows = await fetchGroupedRows(client, userId, activeDeviceIds, rangeStart, rangeEnd, "day", tz, tzOffsetMinutes);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }

  const byDay = new Map<string, {
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
    // Per-model token totals for the day, so the dashboard Usage Trend can stack
    // by MODEL in cloud (account) mode — mirrors src/lib/local-api.js daily output.
    // Without this the trend falls back to a token-type breakdown in cloud mode.
    models: Record<string, number>;
  }>();
  for (const row of rows) {
    const day = row.bucket;
    if (day < from || day > to) continue;
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
        models: {},
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
    a.conversation_count += Number(row.conversations) || 0;
    const mdl = String(row.model || "unknown");
    a.models[mdl] = (a.models[mdl] || 0) + tt;
  }

  const data = Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day));
  return json({ from, to, data });
}

