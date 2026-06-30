/**
 * Tokentracker leaderboard profile (DETAIL).
 *
 * Aggregates a single user's hourly rows into a rich profile payload used by
 * the in-page profile modal: hero totals, streak, best day, model favorites,
 * per-provider breakdown, 365-day activity heatmap and a period-scoped daily
 * trend.
 *
 * Previous implementation returned the existing snapshot row. The modal
 * needs time-series data the snapshot table doesn't carry, so we scan
 * `tokentracker_hourly` directly (single-user scan — small enough to walk
 * in one request, much smaller than the cross-user refresh job).
 *
 * Pricing tables are inline-mirrored from `tokentracker-leaderboard-refresh.ts`
 * to keep `getModelPricing` / `computeRowCost` byte-for-byte aligned across
 * cloud aggregators. Memory: feedback_model_pricing_sync — every edit here
 * MUST be mirrored to refresh.ts and src/lib/local-api.js.
 */
import { createClient } from "npm:@insforge/sdk";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, apikey, x-tokentracker-device-token-hash",
};
const BLOCKED_LEADERBOARD_USER_IDS = new Set(
  (Deno.env.get("LEADERBOARD_BLOCKED_USER_IDS") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
);

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (b64.length % 4)) % 4;
  const raw = atob(b64 + "=".repeat(pad));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function verifyCallerUserId(req: Request): Promise<string | null> {
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
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
    const payloadStr = new TextDecoder().decode(b64urlToBytes(parts[1]));
    const payload = JSON.parse(payloadStr) as Record<string, unknown>;
    if (typeof payload.exp === "number" && Date.now() / 1000 > payload.exp) return null;
    const sub = payload.sub;
    return typeof sub === "string" && sub.length > 0 ? sub : null;
  } catch {
    return null;
  }
}

function getClient() {
  const serviceRoleKey = Deno.env.get("INSFORGE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("INSFORGE_ANON_KEY") ?? Deno.env.get("ANON_KEY");
  return createClient({
    baseUrl: Deno.env.get("INSFORGE_BASE_URL")!,
    edgeFunctionToken: serviceRoleKey,
    anonKey: anonKey ?? undefined,
    isServerMode: true,
  });
}

// ─────────────────────────── Pricing (mirror from refresh.ts) ──────────────────────────
const MODEL_PRICING: Record<string, { input: number; output: number; cache_read: number; cache_write?: number }> = {
  // ── Anthropic Claude ──
  "claude-fable-5": { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
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
  // gpt-5.4-pro per developers.openai.com/api/docs/pricing; cache_read 3
  // mirrors the local LiteLLM entry. There is NO "-medium" SKU —
  // medium/high/xhigh are reasoning-effort levels billed at the base rate;
  // a stale "gpt-5.4-medium" 1.5/10 entry here undercut the local engine
  // (suffix-strip → gpt-5.4 at 2.5/15) by 40% until 2026-06.
  "gpt-5.4-pro": { input: 30, output: 180, cache_read: 3 },
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
  "kimi-k2.7-code": { input: 0.95, output: 4, cache_read: 0.19 },
  // ── Z.ai GLM (mirrored from src/lib/pricing/curated-overrides.json).
  //    LiteLLM only keys these under provider prefixes like `zai/glm-5`,
  //    `openrouter/z-ai/glm-4.6`, etc. The reverse-substring fallback in the
  //    matcher requires the user-supplied model name to CONTAIN the LiteLLM
  //    key, so the bare `glm-5.1` / `glm-4.6` strings reported by Claude
  //    Code-compatible GLM endpoints never match. Curate them here. ──
  "glm-5.2": { input: 1.4, output: 4.4, cache_read: 0.26 },
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
  "minimax-m3": { input: 0.3, output: 1.2, cache_read: 0.06, cache_write: 0 },
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
  // ── Tencent CodeBuddy / WorkBuddy (hy3-preview family). Tencent TokenHub
  //    official rate: 1.2 / 0.4 (cache hit) / 4.0 RMB per MTok in/read/out,
  //    converted at ~7.2 RMB/USD. DeepSeek-style cache: cache_write = input. ──
  "hy3-preview-agent": { input: 0.167, output: 0.556, cache_read: 0.056, cache_write: 0.167 },
  "hy3-preview": { input: 0.167, output: 0.556, cache_read: 0.056, cache_write: 0.167 },
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
  // ── Sakana Fugu (OpenAI-compatible API via sakana.ai PAYG / OpenRouter,
  //    used through Codex/Cursor/Cline/ZCode etc.; mirrored from
  //    src/lib/pricing/curated-overrides.json). OpenRouter rate: $5/$30 per
  //    MTok in/out, cache_read $0.5/M; no cache-write surcharge so
  //    cache_write = input. ──
  "sakana/fugu-ultra": { input: 5, output: 30, cache_read: 0.5, cache_write: 5 },
};
const ZERO_PRICING = { input: 0, output: 0, cache_read: 0, cache_write: 0 };

function getModelPricing(model: string) {
  if (!model) return ZERO_PRICING;
  const exact = MODEL_PRICING[model];
  if (exact) return exact;
  const lower = model.toLowerCase();
  if (lower.includes("fable")) return MODEL_PRICING["claude-fable-5"];
  if (lower.includes("opus")) return MODEL_PRICING["claude-opus-4-6"];
  if (lower.includes("haiku")) return MODEL_PRICING["claude-haiku-4-5-20251001"];
  if (lower.includes("sonnet")) return MODEL_PRICING["claude-sonnet-4-6"];
  if (lower.includes("gpt-5.4-pro")) return MODEL_PRICING["gpt-5.4-pro"];
  if (lower.includes("gpt-5.4")) return MODEL_PRICING["gpt-5.4"];
  if (lower.includes("gpt-5.5")) return MODEL_PRICING["gpt-5.5"];
  if (lower.includes("gpt-5-mini")) return MODEL_PRICING["gpt-5-mini"];
  if (lower.includes("gpt-5.3")) return MODEL_PRICING["gpt-5.3-codex"];
  if (lower.includes("gpt-5.2")) return MODEL_PRICING["gpt-5.2"];
  // -codex-mini variants (e.g. gpt-5.1-codex-mini-high) must resolve before
  // the broader gpt-5.1 matcher — the base codex rate is 5x the mini rate.
  if (lower.includes("gpt-5.1-codex-mini")) return MODEL_PRICING["gpt-5.1-codex-mini"];
  if (lower.includes("gpt-5.1")) return MODEL_PRICING["gpt-5.1-codex"];
  if (lower.includes("gpt-5")) return MODEL_PRICING["gpt-5"];
  // gemini-3 pro tiers (gemini-3-pro, gemini-3.1-pro, -high, -customtools…)
  // must not fall through to the flash rate (4x undercount).
  if (lower.includes("gemini-3") && lower.includes("pro")) return MODEL_PRICING["gemini-3-pro-preview"];
  if (lower.includes("gemini-3")) return MODEL_PRICING["gemini-3-flash-preview"];
  if (lower.includes("gemini-2.5")) return MODEL_PRICING["gemini-2.5-pro"];
  if (lower.includes("minimax-m3")) return MODEL_PRICING["minimax-m3"];
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
  if (lower.includes("kimi-k2.7-code")) return MODEL_PRICING["kimi-k2.7-code"];
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
  if (lower.includes("glm-5.2")) return MODEL_PRICING["glm-5.2"];
  if (lower.includes("glm-5.1")) return MODEL_PRICING["glm-5.1"];
  if (lower.includes("glm-5")) return MODEL_PRICING["glm-5"];
  if (lower.includes("kiro")) return MODEL_PRICING["kiro-cli-agent"];
  if (lower.includes("hy3")) return MODEL_PRICING["hy3-preview-agent"];
  if (lower.includes("composer")) return MODEL_PRICING["composer-1"];
  if (lower.includes("fugu")) return MODEL_PRICING["sakana/fugu-ultra"];
  if (lower === "auto") return MODEL_PRICING["composer-1"];
  return ZERO_PRICING;
}

interface HourlyRow {
  device_id: string;
  source: string;
  model: string;
  hour_start: string;
  total_tokens: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  reasoning_output_tokens: number | null;
}

function computeRowCost(row: HourlyRow): number {
  // WorkBuddy's auto-router logs model="auto"; price it as its default Hunyuan
  // model (hy3-preview-agent) so it isn't billed as Cursor's composer-1. Mirrors
  // normalizeWorkbuddyModel in src/lib/pricing/matcher.js.
  const modelForPricing =
    row.source === "workbuddy" && (row.model || "").toLowerCase() === "auto"
      ? "hy3-preview-agent"
      : row.model;
  const p = getModelPricing(modelForPricing);
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

/** Map raw `source` to the canonical bucket used by the modal's by_provider list. */
const KNOWN_SOURCES = new Set([
  "codex", "claude", "gemini", "cursor", "opencode", "openclaw",
  "hermes", "kiro", "copilot", "kimi", "droid",
]);
function canonicalSource(s: string) {
  return KNOWN_SOURCES.has(s) ? s : "other";
}

// Account-level sources (data from a per-ACCOUNT cloud API, e.g. Cursor's usage
// CSV — NOT machine-local logs) are stored IDENTICALLY on every device that
// synced them, so they must be DEDUPED across devices, not summed. Machine-level
// sources are real independent per-machine work and SUM across active devices.
// Keep in sync with ACCOUNT_LEVEL_SOURCES in src/lib/source-metadata.js, the
// account_usage_grouped RPC, and tokentracker-leaderboard-refresh.ts
// (parity: test/account-source-parity.test.js).
const ACCOUNT_LEVEL_SOURCES = new Set<string>(["cursor"]);

// ─────────────────────────── Window bounds ──────────────────────────
function windowBoundsForPeriod(period: string): { from_day: string; to_day: string } {
  const now = new Date();
  if (period === "week") {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)) /* ISO Mon-start, matches leaderboard-refresh+dashboard */;
    const from = d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 6);
    return { from_day: from, to_day: d.toISOString().slice(0, 10) };
  }
  if (period === "month") {
    const from = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
    const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0))
      .toISOString()
      .slice(0, 10);
    return { from_day: from, to_day: to };
  }
  // total: use heatmap range (365 days) — caller uses this same bound for trend
  const heatmapStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  heatmapStart.setUTCDate(heatmapStart.getUTCDate() - 364);
  return {
    from_day: heatmapStart.toISOString().slice(0, 10),
    to_day: now.toISOString().slice(0, 10),
  };
}

/** Compute current & longest consecutive-day streaks within a date set. */
function computeStreak(daysWithActivity: Set<string>): { current_days: number; longest_days: number } {
  const today = new Date();
  const todayUTC = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  // Current: start from today; if today has nothing, allow yesterday as starting point.
  let cursor = new Date(todayUTC);
  let current = 0;
  if (!daysWithActivity.has(cursor.toISOString().slice(0, 10))) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  while (daysWithActivity.has(cursor.toISOString().slice(0, 10))) {
    current += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  // Longest: walk all days chronologically.
  const sorted = Array.from(daysWithActivity).sort();
  let longest = 0;
  let run = 0;
  let prev: Date | null = null;
  for (const d of sorted) {
    const dt = new Date(d + "T00:00:00Z");
    if (prev && dt.getTime() - prev.getTime() === 86_400_000) {
      run += 1;
    } else {
      run = 1;
    }
    if (run > longest) longest = run;
    prev = dt;
  }
  return { current_days: current, longest_days: longest };
}

// ─────────────────────────── Main handler ──────────────────────────
// deno-lint-ignore no-explicit-any
async function scanHourlyForUser(client: any, userId: string, rangeStartIso: string, rangeEndIso: string) {
  // Two-class cross-device aggregation, matching the account_usage_grouped RPC
  // and tokentracker-leaderboard-refresh.ts:
  //   * ACCOUNT-LEVEL sources (cursor): same data on every device → keep ONE
  //     canonical whole row per (source, model, hour) (highest total_tokens),
  //     across ALL devices (device-independent, not active-filtered).
  //   * MACHINE-LEVEL sources: real per-machine work → SUM across the user's
  //     ACTIVE devices (revoked_at IS NULL), dropping historic device churn.
  // Returns one merged map; the handler consumes its values() unchanged.
  const activeDeviceIds = new Set<string>();
  {
    let dOff = 0;
    const DPAGE = 1000;
    while (true) {
      const { data: devs, error: dErr } = await client.database
        .from("tokentracker_devices")
        .select("id")
        .eq("user_id", userId)
        .is("revoked_at", null)
        .order("id", { ascending: true })
        .range(dOff, dOff + DPAGE - 1);
      if (dErr) throw new Error(dErr.message);
      if (!devs || devs.length === 0) break;
      for (const d of devs as Array<{ id: string }>) activeDeviceIds.add(d.id);
      if (devs.length < DPAGE) break;
      dOff += DPAGE;
    }
  }

  const accountMap = new Map<string, HourlyRow>(); // canonical whole row
  const machineMap = new Map<string, HourlyRow>(); // SUM accumulator
  let offset = 0;
  const PAGE_SIZE = 1000;
  while (true) {
    const { data: rows, error } = await client.database
      .from("tokentracker_hourly")
      .select("device_id, source, model, hour_start, total_tokens, input_tokens, output_tokens, cached_input_tokens, cache_creation_input_tokens, reasoning_output_tokens")
      .eq("user_id", userId)
      .gte("hour_start", rangeStartIso)
      .lt("hour_start", rangeEndIso)
      // hour_start alone is NOT unique (one row per device×source×model), and
      // PostgREST pagination over a non-unique sort can skip/duplicate rows
      // at page boundaries. The trailing keys make the order total — the
      // five columns together are the table's upsert conflict key.
      .order("hour_start", { ascending: true })
      .order("device_id", { ascending: true })
      .order("source", { ascending: true })
      .order("model", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    if (!rows || rows.length === 0) break;
    for (const row of rows as HourlyRow[]) {
      const key = `${row.source}|${row.model}|${row.hour_start}`;
      if (ACCOUNT_LEVEL_SOURCES.has(row.source)) {
        const existing = accountMap.get(key);
        if (!existing || (Number(row.total_tokens) || 0) > (Number(existing.total_tokens) || 0)) {
          accountMap.set(key, row);
        }
      } else {
        if (!activeDeviceIds.has(row.device_id)) continue;
        const acc = machineMap.get(key);
        if (!acc) {
          machineMap.set(key, {
            ...row,
            total_tokens: Number(row.total_tokens) || 0,
            input_tokens: Number(row.input_tokens) || 0,
            output_tokens: Number(row.output_tokens) || 0,
            cached_input_tokens: Number(row.cached_input_tokens) || 0,
            cache_creation_input_tokens: Number(row.cache_creation_input_tokens) || 0,
            reasoning_output_tokens: Number(row.reasoning_output_tokens) || 0,
          });
        } else {
          acc.total_tokens = (Number(acc.total_tokens) || 0) + (Number(row.total_tokens) || 0);
          acc.input_tokens = (Number(acc.input_tokens) || 0) + (Number(row.input_tokens) || 0);
          acc.output_tokens = (Number(acc.output_tokens) || 0) + (Number(row.output_tokens) || 0);
          acc.cached_input_tokens = (Number(acc.cached_input_tokens) || 0) + (Number(row.cached_input_tokens) || 0);
          acc.cache_creation_input_tokens = (Number(acc.cache_creation_input_tokens) || 0) + (Number(row.cache_creation_input_tokens) || 0);
          acc.reasoning_output_tokens = (Number(acc.reasoning_output_tokens) || 0) + (Number(row.reasoning_output_tokens) || 0);
        }
      }
    }
    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  // Merge (account and machine keys never collide — disjoint source sets).
  const merged = new Map<string, HourlyRow>(machineMap);
  for (const [k, v] of accountMap) merged.set(k, v);
  return merged;
}

export default async function (req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const url = new URL(req.url);
  const userId = url.searchParams.get("user_id");
  const periodInput = url.searchParams.get("period") || "week";
  const period = ["week", "month", "total"].includes(periodInput) ? periodInput : "week";
  if (!userId) return json({ error: "user_id is required" }, 400);
  if (BLOCKED_LEADERBOARD_USER_IDS.has(userId)) return json({ error: "Not found" }, 404);

  const callerUserId = await verifyCallerUserId(req);
  const isSelf = Boolean(callerUserId && callerUserId === userId);
  const client = getClient();

  // Privacy gate. Mirror the leaderboard list's exposure policy: if the user
  // already appears in the public snapshot table, their aggregate numbers are
  // visible to anyone scrolling the leaderboard — so the modal should not
  // gate them behind `leaderboard_public`. The `leaderboard_anonymous` flag
  // is enforced separately below by hiding display_name/avatar/github_url.
  // (A `leaderboard_public=true` check would 404 ~60% of listed rows here.)
  if (!isSelf) {
    const { data: snap } = await client.database
      .from("tokentracker_leaderboard_snapshots")
      .select("user_id")
      .eq("user_id", userId)
      .limit(1)
      .maybeSingle();
    if (!snap) {
      return json({ error: "Not found" }, 404);
    }
  }

  // Hero/identity row: pull display_name + avatar from profile, and
  // anonymous/github flags + url from settings.
  const [settingsRes, profileRes] = await Promise.all([
    client.database
      .from("tokentracker_user_settings")
      .select("leaderboard_anonymous, github_url, show_github_url")
      .eq("user_id", userId)
      .maybeSingle(),
    client.database
      .from("tokentracker_user_profiles")
      .select("display_name, avatar_url")
      .eq("user_id", userId)
      .maybeSingle(),
  ]);
  const settings = (settingsRes.data || {}) as {
    leaderboard_anonymous?: boolean;
    github_url?: string | null;
    show_github_url?: boolean;
  };
  const profile = (profileRes.data || {}) as {
    display_name?: string | null;
    avatar_url?: string | null;
  };

  // Rank: read from the period snapshot (the refresh job already computes it).
  // The query is pinned to the CURRENT (from_day, to_day) window — taking the
  // latest generated_at row for the period regardless of window returned the
  // PREVIOUS week/month's rank next to freshly-computed current-window totals
  // right after a window rollover ("Rank #3, 0 tokens").
  const periodBounds = windowBoundsForPeriod(period);
  let snapFromDay = periodBounds.from_day;
  let snapToDay = periodBounds.to_day;
  if (period === "total") {
    // total snapshots are keyed (1970-01-01, <refresh day>) — mirror the
    // reader (tokentracker-leaderboard.ts) and resolve the latest pair.
    const { data: latestTotal } = await client.database
      .from("tokentracker_leaderboard_snapshots")
      .select("from_day, to_day")
      .eq("period", "total")
      .order("to_day", { ascending: false })
      .limit(1)
      .maybeSingle();
    const lt = latestTotal as { from_day?: string; to_day?: string } | null;
    snapFromDay = (lt?.from_day ?? "1970-01-01").slice(0, 10);
    snapToDay = (lt?.to_day ?? new Date().toISOString()).slice(0, 10);
  }
  const { data: snapRow } = await client.database
    .from("tokentracker_leaderboard_snapshots")
    .select("rank, display_name, avatar_url, generated_at")
    .eq("user_id", userId)
    .eq("period", period)
    .eq("from_day", snapFromDay)
    .eq("to_day", snapToDay)
    .order("generated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const snap = (snapRow || null) as { rank?: number | null; display_name?: string | null; avatar_url?: string | null; generated_at?: string | null } | null;

  // Heatmap window: trailing 365 days (always).
  const now = new Date();
  const heatmapEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const heatmapStart = new Date(heatmapEnd);
  heatmapStart.setUTCDate(heatmapStart.getUTCDate() - 365);
  // Period range may be wider than 365d ("total" maps to 365d here); we scan
  // the heatmap window and slice the period window from the same map.
  const periodStartIso = `${periodBounds.from_day}T00:00:00Z`;
  const periodEndIso = (() => {
    const d = new Date(periodBounds.to_day + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString();
  })();
  const scanStartIso = heatmapStart < new Date(periodStartIso)
    ? heatmapStart.toISOString()
    : periodStartIso;
  const scanEndIso = heatmapEnd > new Date(periodEndIso)
    ? heatmapEnd.toISOString()
    : periodEndIso;

  let bucketMap: Map<string, HourlyRow>;
  try {
    bucketMap = await scanHourlyForUser(client, userId, scanStartIso, scanEndIso);
  } catch (e) {
    return json({ error: (e as Error).message || "scan failed" }, 500);
  }

  // ── Aggregate into the modal's shape. Two parallel passes:
  //   - period-scoped: totals/by_provider/best_day/favorite_model/active_days/streak/daily_trend
  //   - 365d heatmap: per-day token totals
  const periodFrom = new Date(periodStartIso);
  const periodTo = new Date(periodEndIso);

  const heatmapByDay = new Map<string, number>();
  // Per-day model breakdown for the hover tooltip. Same shape the dashboard
  // ActivityHeatmap consumes (cell.models = { [model_name]: tokens }).
  const heatmapModelsByDay = new Map<string, Map<string, number>>();
  const periodByDay = new Map<string, number>();
  const periodByDayCost = new Map<string, number>();
  const periodByProvider = new Map<string, { tokens: number; cost: number }>();
  const periodByModel = new Map<string, number>();
  let periodTotalTokens = 0;
  let periodTotalCost = 0;

  for (const row of bucketMap.values()) {
    const hourMs = new Date(row.hour_start).getTime();
    const day = row.hour_start.slice(0, 10);
    const tokens = Number(row.total_tokens) || 0;
    const cost = computeRowCost(row);
    if (hourMs >= heatmapStart.getTime() && hourMs < heatmapEnd.getTime()) {
      heatmapByDay.set(day, (heatmapByDay.get(day) || 0) + tokens);
      if (row.model && tokens > 0) {
        let dayModels = heatmapModelsByDay.get(day);
        if (!dayModels) {
          dayModels = new Map();
          heatmapModelsByDay.set(day, dayModels);
        }
        dayModels.set(row.model, (dayModels.get(row.model) || 0) + tokens);
      }
    }
    if (hourMs >= periodFrom.getTime() && hourMs < periodTo.getTime()) {
      periodByDay.set(day, (periodByDay.get(day) || 0) + tokens);
      periodByDayCost.set(day, (periodByDayCost.get(day) || 0) + cost);
      const src = canonicalSource(row.source);
      const provider = periodByProvider.get(src) || { tokens: 0, cost: 0 };
      provider.tokens += tokens;
      provider.cost += cost;
      periodByProvider.set(src, provider);
      if (row.model) periodByModel.set(row.model, (periodByModel.get(row.model) || 0) + tokens);
      periodTotalTokens += tokens;
      periodTotalCost += cost;
    }
  }

  // best_day in period
  let bestDay: { date: string; total_tokens: number; estimated_cost_usd: number } | null = null;
  for (const [day, tokens] of periodByDay.entries()) {
    if (!bestDay || tokens > bestDay.total_tokens) {
      bestDay = { date: day, total_tokens: tokens, estimated_cost_usd: periodByDayCost.get(day) || 0 };
    }
  }

  // favorite_model
  let favoriteModel: { model_name: string; total_tokens: number } | null = null;
  for (const [model, tokens] of periodByModel.entries()) {
    if (!favoriteModel || tokens > favoriteModel.total_tokens) {
      favoriteModel = { model_name: model, total_tokens: tokens };
    }
  }

  // streak (over period — set of active day strings)
  const activeDaySet = new Set(periodByDay.keys());
  const streak = computeStreak(activeDaySet);

  // daily_trend (period, dense — include 0 days so frontend can chart cleanly)
  const dailyTrend: Array<{ date: string; total_tokens: number }> = [];
  for (let cur = new Date(periodFrom); cur < periodTo; cur.setUTCDate(cur.getUTCDate() + 1)) {
    const day = cur.toISOString().slice(0, 10);
    dailyTrend.push({ date: day, total_tokens: periodByDay.get(day) || 0 });
  }
  // heatmap (365d dense). `models` powers the dashboard ActivityHeatmap's
  // per-cell model breakdown tooltip. Days with no activity get no models
  // key (the heatmap component already handles that gracefully).
  const heatmap: Array<{ date: string; total_tokens: number; models?: Record<string, number> }> = [];
  for (let cur = new Date(heatmapStart); cur < heatmapEnd; cur.setUTCDate(cur.getUTCDate() + 1)) {
    const day = cur.toISOString().slice(0, 10);
    const cell: { date: string; total_tokens: number; models?: Record<string, number> } = {
      date: day,
      total_tokens: heatmapByDay.get(day) || 0,
    };
    const dayModels = heatmapModelsByDay.get(day);
    if (dayModels && dayModels.size > 0) {
      cell.models = Object.fromEntries(dayModels);
    }
    heatmap.push(cell);
  }

  // by_provider sorted desc with percent
  const byProvider = Array.from(periodByProvider.entries())
    .map(([source, v]) => ({
      source,
      total_tokens: v.tokens,
      estimated_cost_usd: v.cost,
      percent: periodTotalTokens > 0 ? v.tokens / periodTotalTokens : 0,
    }))
    .sort((a, b) => b.total_tokens - a.total_tokens);

  const activeDays = activeDaySet.size;
  const periodDayCount = dailyTrend.length || 1;
  const avgPerDayUsd = periodTotalCost / periodDayCount;

  const isAnonymous = Boolean(settings.leaderboard_anonymous);
  const displayName = isAnonymous
    ? "Anonymous"
    : (profile.display_name || snap?.display_name || "");
  const avatarUrl = isAnonymous ? null : (profile.avatar_url || snap?.avatar_url || null);
  const githubUrl = !isAnonymous && settings.show_github_url ? (settings.github_url || null) : null;

  return json({
    user: {
      user_id: userId,
      display_name: displayName,
      avatar_url: avatarUrl,
      github_url: githubUrl,
      is_anonymous: isAnonymous,
      rank: snap?.rank ?? null,
    },
    period: {
      kind: period,
      from: periodBounds.from_day,
      to: periodBounds.to_day,
      generated_at: snap?.generated_at || new Date().toISOString(),
    },
    totals: {
      total_tokens: periodTotalTokens,
      estimated_cost_usd: periodTotalCost,
      active_days: activeDays,
      avg_per_day_usd: avgPerDayUsd,
    },
    streak,
    best_day: bestDay,
    models: {
      count: periodByModel.size,
      favorite: favoriteModel,
    },
    by_provider: byProvider,
    heatmap,
    daily_trend: dailyTrend,
  });
}
