/**
 * InsForge Edge: public leaderboard list.
 *
 * IMPORTANT — why no Authorization header is read here:
 * InsForge's platform gateway validates any incoming `Authorization: Bearer ...`
 * against the service JWT secret *before* this function runs. Any token problem
 * (bad signature, expired, wrong issuer, stale after key rotation) is surfaced
 * as an opaque HTTP 500 JWSError instead of a proper 401. That blew up the
 * Leaderboard for real users whose stored access_token drifted (GitHub issue #6
 * / Linear 001-51).
 *
 * Fix: this endpoint is now purely public. The client passes its own `user_id`
 * as a query parameter (already known from the Insforge auth context) to get
 * `is_me` highlighting. The function never touches the Authorization header,
 * so no JWT validation path can ever fire for Leaderboard reads.
 *
 * Security note: `user_id` from the query is only used for row-highlight. All
 * leaderboard entries are public data in `tokentracker_leaderboard_snapshots`,
 * so spoofing `user_id` at worst re-highlights a different row — no PII or
 * private data is exposed.
 */
import { createClient } from "npm:@insforge/sdk";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

/**
 * Decode (without verifying) the `sub` claim from a JWT. Pure back-compat
 * fallback so v0.5.46 clients that still send an Authorization header
 * (instead of the new `user_id` query param) still get `is_me` highlighting.
 * Signature is NOT verified — the value is only used for cosmetic row
 * highlighting on public data, never for authorization.
 */
function unsafeDecodeJwtSub(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const p = parts[1];
    const padded = p
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(p.length + ((4 - (p.length % 4)) % 4), "=");
    const payload = JSON.parse(atob(padded)) as Record<string, unknown>;
    const sub = payload.sub;
    if (typeof sub === "string" && sub.length > 0) return sub;
    const uid = payload.user_id;
    if (typeof uid === "string" && uid.length > 0) return uid;
  } catch {
    /* ignore */
  }
  return null;
}

export default async function (req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const url = new URL(req.url);
  const period = url.searchParams.get("period") || "week";
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "20") || 20, 100);
  const offset = parseInt(url.searchParams.get("offset") || "0") || 0;
  // Preferred path: client passes user_id as a query param (v0.5.51+).
  // Fallback: v0.5.46 clients still send a Bearer token — decode its sub
  // claim (WITHOUT signature verification) so they keep seeing is_me
  // highlighting. Signature validation is unnecessary because sub is only
  // used to pick which public row to highlight.
  let requestedUserId =
    url.searchParams.get("user_id") || url.searchParams.get("userId") || null;
  if (!requestedUserId) {
    const authH = req.headers.get("Authorization");
    const token = authH?.startsWith("Bearer ") ? authH.slice(7) : null;
    if (token) requestedUserId = unsafeDecodeJwtSub(token);
  }

  const baseUrl = Deno.env.get("INSFORGE_BASE_URL")!;
  const incomingApiKey =
    req.headers.get("apikey") ?? req.headers.get("Apikey") ?? req.headers.get("x-api-key") ?? undefined;
  const anonKey =
    Deno.env.get("INSFORGE_ANON_KEY") ?? Deno.env.get("ANON_KEY") ?? incomingApiKey ?? undefined;
  const serviceRoleKey = Deno.env.get("INSFORGE_SERVICE_ROLE_KEY");
  // Always use service role (never the caller's token) so a stale/broken
  // caller token can't cascade into a 500 on the DB query.
  const client = createClient({
    baseUrl,
    edgeFunctionToken: serviceRoleKey,
    anonKey,
    ...(anonKey ? { headers: { apikey: anonKey } } : {}),
  });

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
    to_day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  } else {
    // period === "total": find the most recent (from_day, to_day) pair written
    // by the refresh job. Hardcoding (2024-01-01, today) used to 404 whenever
    // today's snapshot hadn't been generated yet, so the UI saw "no data".
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

  const {
    data: entries,
    error,
    count,
  } = await client.database
    .from("tokentracker_leaderboard_snapshots")
    .select("*", { count: "exact" })
    .eq("period", period)
    .eq("from_day", from_day)
    .eq("to_day", to_day)
    .order("rank", { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) return json({ error: error.message }, 500);

  let me: unknown = null;
  if (requestedUserId) {
    try {
      const { data: mr } = await client.database
        .from("tokentracker_leaderboard_snapshots")
        .select("*")
        .eq("period", period)
        .eq("from_day", from_day)
        .eq("to_day", to_day)
        .eq("user_id", requestedUserId)
        .limit(1)
        .maybeSingle();
      if (mr) me = mr;
    } catch {
      /* ignore */
    }
  }

  return json({
    entries: (entries || []).map((e: { user_id?: string }) => ({
      ...e,
      is_me: (me as { user_id?: string } | null)?.user_id === e.user_id,
    })),
    me,
    total_entries: count || 0,
    total_pages: Math.ceil((count || 0) / limit),
    from: from_day,
    to: to_day,
    generated_at: new Date().toISOString(),
  });
}
