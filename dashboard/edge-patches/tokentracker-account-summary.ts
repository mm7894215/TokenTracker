/**
 * InsForge Edge: account-wide usage summary (cross-device, aggregated by user_id).
 * Mirrors local-api.js `tokentracker-usage-summary` response schema.
 *
 * Auth: HS256 JWT_SECRET signature verification (same template as
 * tokentracker-device-token-issue). InsForge does NOT validate JWTs at the
 * gateway, so edge functions that expose per-user data MUST verify the
 * signature themselves — otherwise any caller can forge {"sub":"<victim>"}
 * and read another user's full token history.
 *
 * Aggregation safety:
 *   1. Only rows tied to an active device row (revoked_at IS NULL) are
 *      considered. tokentracker_devices_active_unique enforces one active
 *      device per (user, platform, device_name), so this filter drops the
 *      historic device_id churn from before partial-unique was enforced.
 *
 * Cross-device semantic = SUM (intentional; see GitHub Discussion #101).
 *   The account view aggregates a user's usage ACROSS devices, so two real
 *   machines MUST add up. SUM is correct ONLY when one physical machine maps
 *   to ONE device_id. That invariant is provided by the MACHINE-stable device
 *   identity: the dashboard derives device_name from a per-machine id served by
 *   the local CLI (`/functions/tokentracker-machine-id`, see
 *   dashboard/src/lib/cloud-sync.ts → resolveDeviceNameSuffix) instead of a
 *   per-browser localStorage id. Without that, one machine opened in multiple
 *   browsers split a bucket's cumulative emissions across device_ids and SUM
 *   inflated the total.
 *
 *   PRODUCTION CHECK (30d, real data): SUM exceeds the leaderboard's
 *   cross-device MAX by ~3.8% of the active-device total — but 99.3% of that
 *   gap is GENUINE multi-machine usage (e.g. one user on MacIntel + Win32, or a
 *   Linux server + a Mac laptop) that SUM correctly adds and MAX would wrongly
 *   drop. That is exactly why this view uses SUM. True same-machine duplication
 *   is only ~0.03% of the active total (1 user, same-platform device churn).
 *   F1 (machine-stable device_name, see cloud-sync.ts) prevents NEW same-machine
 *   spray; the tiny legacy churn ages out of rolling windows. Optional
 *   fast-follow: a NON-destructive device-consolidation cleanup (back up first;
 *   NEVER an offset-reset migration — that caused the 2.17B-token loss in
 *   CLAUDE.md). The dashboard total intentionally differs from the leaderboard
 *   rank because the leaderboard's MAX under-counts true multi-machine users.
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
 * in tokentracker-device-token-issue.ts. Returns null on any failure (bad
 * shape, bad signature, expired) — caller surfaces that as 401.
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

/**
 * Fetch the list of currently-active device_ids for a user. Used to filter
 * `tokentracker_hourly` so rows tied to a revoked (historic) device_id do
 * not inflate aggregated totals.
 */
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

/** Per-model pricing (USD per million tokens). Synced from src/lib/local-api.js. */

// NOTE: MODEL_PRICING + getModelPricing synced from tokentracker-leaderboard-refresh.ts
// to fix dashboard cost under-reporting (e.g. mimo-v2.5-pro → $0, gpt-5.5 → fallback gpt-5).
// TODO: extract to a shared edge-pricing module; tracked in feedback_model_pricing_sync.
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

function aggregateByDay(rows: GroupedRow[]): DayAgg[] {
  const byDay = new Map<string, DayAgg>();
  for (const row of rows) {
    const day = row.bucket;
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
    a.conversation_count += Number(row.conversations) || 0;
  }
  return Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day));
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

  let allRows: GroupedRow[];
  try {
    allRows = await fetchGroupedRows(client, userId, activeDeviceIds, rollingStart, rollingEndNext.toISOString(), "day", tz, tzOffsetMinutes);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }

  const allDaily = aggregateByDay(allRows);
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

