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

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Constant-time compare so a secret/key check can't be probed byte-by-byte via timing.
function timingSafeEqualStr(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

// Verify HS256 JWT against JWT_SECRET; return {sub, role} or null. Mirrors the
// account-* helper. NOTE: the PUBLIC anon key is itself a validly-signed JWT
// (role="anon"), so callers must reject role==="anon" to require a real user.
async function verifiedClaimsFromJwt(
  authHeader: string | null,
): Promise<{ sub: string; role: string } | null> {
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
    const ok = await crypto.subtle.verify("HMAC", key, b64urlToBytes(parts[2]), data);
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1]))) as Record<string, unknown>;
    if (typeof payload.exp === "number" && Date.now() / 1000 > payload.exp) return null;
    const sub = typeof payload.sub === "string" && payload.sub
      ? payload.sub
      : (typeof payload.user_id === "string" ? payload.user_id : "");
    const role = typeof payload.role === "string" ? payload.role : "";
    if (!sub) return null;
    return { sub, role };
  } catch {
    return null;
  }
}

// Refresh is a heavy write path. Until 2026-07-04 it was unauthenticated —
// anyone could POST and trigger a full snapshot rebuild, the lever behind the
// 2026-06-21 meltdown. Accept only: the cron/ops shared secret
// (LEADERBOARD_REFRESH_SECRET, sent by the pg_cron schedule), the service-role
// key (manual ops), or a SIGNED-IN user (the dashboard's per-sync week refresh).
// The public anon key is a validly-signed JWT with role="anon" and must NOT pass.
type RefreshAuthorization = "privileged" | "signed-in";

async function authorizeRefresh(req: Request): Promise<RefreshAuthorization | null> {
  const secret = Deno.env.get("LEADERBOARD_REFRESH_SECRET");
  const provided = req.headers.get("x-refresh-secret");
  if (secret && provided && timingSafeEqualStr(provided, secret)) return "privileged";

  const auth = req.headers.get("Authorization");
  const bearer = auth ? auth.replace(/^Bearer\s+/i, "").trim() : "";
  const serviceKey = Deno.env.get("INSFORGE_SERVICE_ROLE_KEY");
  if (bearer && serviceKey && timingSafeEqualStr(bearer, serviceKey)) return "privileged";

  const claims = await verifiedClaimsFromJwt(auth);
  if (claims && claims.role !== "anon" && claims.sub) return "signed-in";

  return null;
}

type Period = "week" | "month" | "total";
const ALL_PERIODS: Period[] = ["week", "month", "total"];
const BLOCKED_LEADERBOARD_USER_IDS = new Set(
  (Deno.env.get("LEADERBOARD_BLOCKED_USER_IDS") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
);

/** Per-model pricing (USD per million tokens), synced from local-api.js */
const MODEL_PRICING: Record<string, { input: number; output: number; cache_read: number; cache_write?: number }> = {
  // ── Anthropic Claude ──
  "claude-fable-5": { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
  "claude-opus-4-6": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  "claude-opus-4-5-20250414": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  "claude-sonnet-5": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
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
  // GPT-5.6 family (public 2026-07-09), developers.openai.com/api/docs/pricing.
  // Three durable capability tiers: sol (flagship) / terra (balanced default) /
  // luna (lightweight). Codex reports the tier in the model id (gpt-5.6-sol,
  // + reasoning-effort variants like gpt-5.6-solhigh). Not yet in LiteLLM.
  "gpt-5.6-sol": { input: 5, output: 30, cache_read: 0.5, cache_write: 6.25 },
  "gpt-5.6-terra": { input: 2.5, output: 15, cache_read: 0.25, cache_write: 3.125 },
  "gpt-5.6-luna": { input: 1, output: 6, cache_read: 0.1, cache_write: 1.25 },
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
  // ── Meituan LongCat-2.0, seen via ZCode custom-provider routing (#276;
  //    mirrored from src/lib/pricing/curated-overrides.json). Official
  //    longcat.chat launch-promo rate: RMB 2/0.04(cache hit)/8 per MTok
  //    in/read/out, converted at ~7.2 RMB/USD; standard list price is
  //    RMB 5/0.10/20 once the promo ends — re-verify before changing. No
  //    cache-write surcharge published, so cache_write = input. ──
  "longcat-2.0": { input: 0.278, output: 1.111, cache_read: 0.00556, cache_write: 0.278 },
  // ── StepFun Step 3.5/3.7 Flash (#283; mirrored from
  //    src/lib/pricing/curated-overrides.json). Official platform.stepfun.ai
  //    rates: 3.7-flash $0.20/$0.04(cache hit)/$1.15 per MTok in/read/out,
  //    3.5-flash $0.10/$0.02/$0.30. No cache-write surcharge published, so
  //    cache_write = input. ──
  "step-3.7-flash": { input: 0.2, output: 1.15, cache_read: 0.04, cache_write: 0.2 },
  "step-3.5-flash": { input: 0.1, output: 0.3, cache_read: 0.02, cache_write: 0.1 },
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
  // gpt-5.6 tiers: sol/terra/luna carry reasoning-effort suffixes (solhigh,
  // etc.), so match by substring. Specific tiers precede the generic gpt-5.6
  // fallback (which defaults to the balanced terra tier).
  if (lower.includes("gpt-5.6-sol")) return MODEL_PRICING["gpt-5.6-sol"];
  if (lower.includes("gpt-5.6-terra")) return MODEL_PRICING["gpt-5.6-terra"];
  if (lower.includes("gpt-5.6-luna")) return MODEL_PRICING["gpt-5.6-luna"];
  if (lower.includes("gpt-5.6")) return MODEL_PRICING["gpt-5.6-terra"];
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
  if (lower.includes("longcat")) return MODEL_PRICING["longcat-2.0"];
  // StepFun ordering: dated snapshots (step-3.5-flash-2603) hit the specific
  // matchers; bare "stepfun" (e.g. openrouter stepfun/…) falls back to 3.7.
  if (lower.includes("step-3.7-flash")) return MODEL_PRICING["step-3.7-flash"];
  if (lower.includes("step-3.5-flash")) return MODEL_PRICING["step-3.5-flash"];
  if (lower.includes("stepfun")) return MODEL_PRICING["step-3.7-flash"];
  if (lower === "auto") return MODEL_PRICING["composer-1"];
  return ZERO_PRICING;
}

function computeRowCost(row: HourlyRow): number {
  // Pi's GitHub Copilot provider is subscription-backed. Keep its token
  // counts, but do not reprice the recorded Claude model as Anthropic API use.
  if (row.source === "pi-github-copilot" || row.source === "pi-copilot") return 0;
  // WorkBuddy's auto-router logs model="auto"; price it as its default Hunyuan
  // model (hy3-preview-agent) so it isn't billed as Cursor's composer-1. Mirrors
  // normalizeWorkbuddyModel in src/lib/pricing/matcher.js.
  const modelForPricing =
    row.source === "workbuddy" && (row.model || "").toLowerCase() === "auto"
      ? "hy3-preview-agent"
      : row.model;
  const p = getModelPricing(modelForPricing);
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
  "pi-github-copilot": "copilot_tokens",
  "pi-copilot": "copilot_tokens",
  "pi-anthropic": "claude_tokens",
  kimi: "kimi_tokens",
};

interface DateRange {
  from_day: string;
  to_day: string;
}

function computeDateRange(period: Period): DateRange {
  const now = new Date();
  if (period === "week") {
    // ISO 8601 Monday-start week (matches dashboard/src/lib/date-range.ts:67
    // `period === "week"` branch, so cloud leaderboard rank and the
    // dashboard's own "Week" tab cover the same 7 days. Previously this used
    // Sunday-start which made leaderboard's week off-by-one vs the dashboard
    // and confused users comparing the two numbers.
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const offset = (d.getUTCDay() + 6) % 7; // days since Monday (Mon=0..Sun=6)
    d.setUTCDate(d.getUTCDate() - offset); // Monday
    const from_day = d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 6); // Sunday
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
  const authorization = await authorizeRefresh(req);
  if (!authorization) return json({ error: "unauthorized" }, 401);
  const requestStartedAt = Date.now();

  const baseUrl = Deno.env.get("INSFORGE_BASE_URL")!;
  const incomingApiKey =
    req.headers.get("apikey") ?? req.headers.get("Apikey") ?? req.headers.get("x-api-key") ?? undefined;
  const anonKey =
    Deno.env.get("INSFORGE_ANON_KEY") ?? Deno.env.get("ANON_KEY") ?? incomingApiKey ?? undefined;
  const serviceRoleKey = Deno.env.get("INSFORGE_SERVICE_ROLE_KEY");
  if (!serviceRoleKey) return json({ error: "server misconfigured" }, 500);

  const client = createClient({
    baseUrl,
    edgeFunctionToken: serviceRoleKey,
    anonKey,
    ...(anonKey ? { headers: { apikey: anonKey } } : {}),
  });

  // Parse requested periods
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  if (authorization === "signed-in" && body.period !== "week")
    return json({ error: "signed-in users may only refresh week" }, 403);
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

    // --- Fail-closed throttle + concurrency guard ---
    // Atomic claim on last_attempt_at, which advances on EVERY attempt (success
    // OR failure). The old throttle read snapshots.generated_at, which only
    // advances on success — so once the RPC started timing out it opened
    // permanently and every cron tick re-ran the full refresh concurrently
    // (the 2026-06-21 meltdown). The single-statement claim also serializes
    // concurrent callers (only one wins each 30s window). Fail-OPEN only on a
    // claim-infra error, never on a throttle hit — a lock fault must not be
    // able to freeze refreshes (safe now that the RPC is fast, issue #263).
    try {
      const { data: claimed, error: claimErr } = await client.database.rpc(
        "leaderboard_refresh_try_claim",
        { p_period: period, p_min_interval_s: 30 },
      );
      if (!claimErr && claimed !== true) {
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
          reason: "throttled",
          duration_ms: Date.now() - periodStartedAt,
        });
        continue;
      }
    } catch (_e) {
      // fail-open: proceed with refresh rather than block on a lock fault
    }

    // --- Aggregate via server-side RPC ---
    // leaderboard_usage_grouped does the two-class cross-device aggregation in
    // Postgres — account-level sources (cursor) deduped to ONE canonical whole
    // row per (user, source, model, hour) across all devices; machine-level
    // sources SUMmed across each user's ACTIVE devices — returning one
    // pre-aggregated {user_id, source, model, ...tokens} object per group.
    // Moving the multi-million-row hourly scan out of the edge fixes the
    // total-period failure (the in-edge scan 500'd at ~5s on the schedule and
    // 504'd at the 30s gateway once history grew). Mirrors how the account-*
    // functions delegate to account_usage_grouped.
    const rangeStart = `${from_day}T00:00:00Z`;
    const nextDay = new Date(to_day + "T00:00:00Z");
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    const rangeEnd = nextDay.toISOString();

    const __t0 = Date.now();
    const { data: groupedData, error: rpcErr } = await client.database.rpc(
      "leaderboard_usage_grouped",
      { p_from: rangeStart, p_to: rangeEnd },
    );
    const __tAfterRpc = Date.now();
    if (rpcErr) {
      logRefreshEvent({
        event: "period_error",
        request_id: requestId,
        source: requestSource,
        period,
        from_day,
        to_day,
        stage: "rpc_aggregate",
        error: rpcErr.message,
        duration_ms: Date.now() - periodStartedAt,
      });
      return json({ error: rpcErr.message }, 500);
    }
    const grouped = (Array.isArray(groupedData) ? groupedData : []) as HourlyRow[];
    const scannedRows = grouped.length; // pre-aggregated groups (not raw rows)
    const pageCount = 1; // single RPC round-trip

    const aggMap = new Map<string, UserAgg>();
    for (const row of grouped) {
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
    for (const blockedUserId of BLOCKED_LEADERBOARD_USER_IDS) {
      aggMap.delete(blockedUserId);
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
        deduped_buckets: grouped.length,
        aggregated_users: 0,
        upserted: 0,
        skipped: false,
        duration_ms: Date.now() - periodStartedAt,
      });
      continue;
    }

    // Fetch settings, profile and snapshot fallback in one database call.
    // This replaces three waves of concurrent 25-user HTTP batches that could
    // occupy nearly every PostgREST connection during a total refresh.
    const userIds = Array.from(aggMap.keys());
    type UserMetadataRow = {
      user_id: string;
      leaderboard_public: boolean;
      leaderboard_anonymous: boolean;
      github_url: string | null;
      show_github_url: boolean;
      display_name: string | null;
      avatar_url: string | null;
    };
    const { data: metadataRows, error: metadataError } = await client.database.rpc("leaderboard_user_metadata",
      { p_user_ids: userIds },
    );
    if (metadataError) {
      logRefreshEvent({
        event: "user_metadata_fetch_error",
        period,
        error: metadataError.message,
      });
      return json({ error: "Failed to fetch leaderboard user metadata" }, 500);
    }
    const metadataMap = new Map<string, UserMetadataRow>();
    for (const metadata of (Array.isArray(metadataRows) ? metadataRows : []) as UserMetadataRow[]) {
      metadataMap.set(metadata.user_id, metadata);
    }

    const __tAfterFetch = Date.now();

    // --- Rank users by total_tokens DESC ---
    const sorted = Array.from(aggMap.entries()).sort((a, b) => b[1].total_tokens - a[1].total_tokens);

    const generatedAt = new Date().toISOString();
    const upsertRows = sorted.map(([userId, agg], idx) => {
      const metadata = metadataMap.get(userId);
      const isPublic = metadata?.leaderboard_public ?? false;
      const isAnonymous = metadata?.leaderboard_anonymous ?? false;
      const displayName = isAnonymous ? "Anonymous" : (metadata?.display_name ?? "Anonymous");
      const avatarUrl = isAnonymous ? null : (metadata?.avatar_url ?? null);
      // Only surface github_url on the public snapshot when the user opted in
      // AND isn't in anonymous mode — anonymous takes precedence over any
      // identifying link.
      const githubUrl = !isAnonymous && metadata?.show_github_url && metadata?.github_url
        ? metadata.github_url
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
          deduped_buckets: grouped.length,
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
      deduped_buckets: grouped.length,
      aggregated_users: aggMap.size,
      upserted: upsertRows.length,
      skipped: false,
      // Stage timing — the 'total' period runs the whole-history RPC, whose
      // duration approaches the edge's 30s execution budget; track rpc_ms so a
      // creep toward the ceiling is visible before it starts failing again.
      rpc_ms: __tAfterRpc - __t0,
      fetch_ms: __tAfterFetch - __tAfterRpc,
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
