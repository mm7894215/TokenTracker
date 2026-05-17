import { createClient } from "npm:@insforge/sdk";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, apikey, x-tokentracker-device-token-hash",
};

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

/**
 * Verify a HS256 JWT locally and return its `sub` (user_id).
 *
 * We can't let the InsForge gateway validate the caller's Authorization —
 * a stale/rotated token makes the gateway 500 with JWSError, which broke
 * the leaderboard for real users (see leaderboard.ts, Linear 001-51).
 * Instead verify signature ourselves with the project JWT_SECRET and
 * return null silently on any failure (treated as "no caller identity").
 */
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

function getClient(_req: Request) {
  // Public endpoint: snapshots are public data. Use the service role key
  // (or fall through to anon) so the caller's Authorization header — which
  // may be stale/malformed/rotated — never feeds the InsForge gateway's
  // JWT validator. A bad caller token previously cascaded into HTTP 500
  // JWSError (see Linear 001-51 / GitHub #6).
  const serviceRoleKey = Deno.env.get("INSFORGE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("INSFORGE_ANON_KEY") ?? Deno.env.get("ANON_KEY");
  return createClient({
    baseUrl: Deno.env.get("INSFORGE_BASE_URL")!,
    edgeFunctionToken: serviceRoleKey,
    anonKey: anonKey ?? undefined,
    isServerMode: true,
  });
}

// deno-lint-ignore no-explicit-any
async function windowBounds(client: any, period: string) {
  const now = new Date();
  let from_day: string;
  let to_day: string;
  if (period === "week") {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    d.setUTCDate(d.getUTCDate() - d.getUTCDay());
    from_day = d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 6);
    to_day = d.toISOString().slice(0, 10);
  } else if (period === "month") {
    from_day = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
    to_day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0))
      .toISOString()
      .slice(0, 10);
  } else {
    const { data: latest } = await client.database
      .from("tokentracker_leaderboard_snapshots")
      .select("from_day, to_day")
      .eq("period", "total")
      .order("to_day", { ascending: false })
      .limit(1)
      .maybeSingle();
    const row = latest as { from_day?: string; to_day?: string } | null;
    from_day = (row?.from_day ?? "2024-01-01").slice(0, 10);
    to_day = (row?.to_day ?? now.toISOString()).slice(0, 10);
  }
  return { from_day, to_day };
}

export default async function (req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const url = new URL(req.url);
  const userId = url.searchParams.get("user_id");
  const period = url.searchParams.get("period") || "week";
  if (!userId) return json({ error: "user_id is required" }, 400);

  // Caller identity comes from a signature-verified JWT only — never from a
  // query param. Anonymous callers (no Authorization header or bad JWT) get
  // treated as non-self and are subject to the public gate below; this is
  // the design: unauthenticated visitors can still view the leaderboard and
  // any opted-in public profile.
  const callerUserId = await verifyCallerUserId(req);

  const client = getClient(req);

  // Privacy gate: self-access is always allowed; anyone else (including
  // anonymous) must wait for the target to opt-in via leaderboard_public.
  // Return the same 404 shape for "not found" and "not public" so we don't
  // fingerprint membership — a 403 vs 404 would otherwise leak account
  // existence for anyone who guesses a real UUID.
  const isSelf = Boolean(callerUserId && callerUserId === userId);
  if (!isSelf) {
    const { data: settings } = await client.database
      .from("tokentracker_user_settings")
      .select("leaderboard_public")
      .eq("user_id", userId)
      .maybeSingle();
    const isPublic = Boolean(
      (settings as { leaderboard_public?: boolean } | null)?.leaderboard_public,
    );
    if (!isPublic) return json({ error: "Not found" }, 404);
  }

  const { from_day, to_day } = await windowBounds(client, period);

  const { data, error } = await client.database
    .from("tokentracker_leaderboard_snapshots")
    .select("*")
    .eq("user_id", userId)
    .eq("period", period)
    .eq("from_day", from_day)
    .eq("to_day", to_day)
    .maybeSingle();

  if (error) return json({ error: error.message }, 500);
  if (!data) return json({ error: "Not found" }, 404);

  return json({
    period,
    from: from_day,
    to: to_day,
    generated_at: data.generated_at ?? new Date().toISOString(),
    entry: data,
  });
}
