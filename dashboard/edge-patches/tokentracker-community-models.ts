/**
 * InsForge Edge: public, privacy-safe community insights snapshot.
 *
 * Reads the singleton snapshot maintained by the database-native hourly
 * refresh_tokentracker_community_stats job.
 * Public endpoint (no auth required) — data is anonymous aggregate stats.
 *
 * Response:
 * {
 *   top_models: [{ name, tokens, share }],
 *   providers: [{ name, tokens, developers, share }],
 *   daily_growth: [{ day, tokens, tokens_7d_avg, active_developers }],
 *   token_mix: [{ key, tokens, share }],
 *   user_distribution: [{ key, developers, tokens, ... }],
 *   platforms: [{ name, machines, share }],
 *   total_tokens: number,
 *   period: "total",
 *   from: string,
 *   to: string,
 *   generated_at: string
 * }
 */
import { createClient } from "npm:@insforge/sdk";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

type CommunityStatsRow = {
  total_tokens: number | string | null;
  top_models: unknown;
  provider_breakdown: unknown;
  daily_growth: unknown;
  token_mix: unknown;
  user_distribution: unknown;
  platform_distribution: unknown;
  active_developers_total: number | string | null;
  active_developers_30d: number | string | null;
  tokens_30d: number | string | null;
  token_growth_pct: number | string | null;
  developer_growth_pct: number | string | null;
  from_day: string | null;
  to_day: string | null;
  generated_at: string | null;
};

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json", ...extraHeaders },
  });
}

export default async function (req: Request): Promise<Response> {
  if (req.method === "OPTIONS")
    return new Response(null, { status: 204, headers: cors });
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const baseUrl = Deno.env.get("INSFORGE_BASE_URL")!;
  const incomingApiKey =
    req.headers.get("apikey") ??
    req.headers.get("Apikey") ??
    req.headers.get("x-api-key") ??
    undefined;
  const anonKey =
    Deno.env.get("INSFORGE_ANON_KEY") ??
    Deno.env.get("ANON_KEY") ??
    incomingApiKey ??
    undefined;
  const serviceRoleKey = Deno.env.get("INSFORGE_SERVICE_ROLE_KEY");
  if (!serviceRoleKey) return json({ error: "server misconfigured" }, 500);

  const client = createClient({
    baseUrl,
    edgeFunctionToken: serviceRoleKey,
    anonKey,
    ...(anonKey ? { headers: { apikey: anonKey } } : {}),
  });

  try {
    const { data, error } = await client.database
      .from("tokentracker_community_stats")
      .select([
        "total_tokens",
        "top_models",
        "provider_breakdown",
        "daily_growth",
        "token_mix",
        "user_distribution",
        "platform_distribution",
        "active_developers_total",
        "active_developers_30d",
        "tokens_30d",
        "token_growth_pct",
        "developer_growth_pct",
        "from_day",
        "to_day",
        "generated_at",
      ].join(","))
      .eq("id", "total")
      .limit(1);
    if (error) return json({ error: error.message }, 500);

    const rows = data as unknown as CommunityStatsRow[] | null;
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) {
      return json(
        { error: "community stats snapshot is not ready" },
        503,
        { "Cache-Control": "no-store", "Retry-After": "30" },
      );
    }

    const cacheHeaders = {
      "Cache-Control": "public, max-age=300, stale-while-revalidate=86400",
      "X-Community-Stats-Source": "snapshot",
    };

    return json(
      {
        top_models: Array.isArray(row.top_models) ? row.top_models : [],
        providers: Array.isArray(row.provider_breakdown) ? row.provider_breakdown : [],
        daily_growth: Array.isArray(row.daily_growth) ? row.daily_growth : [],
        token_mix: Array.isArray(row.token_mix) ? row.token_mix : [],
        user_distribution: Array.isArray(row.user_distribution) ? row.user_distribution : [],
        platforms: Array.isArray(row.platform_distribution) ? row.platform_distribution : [],
        total_tokens: Number(row.total_tokens) || 0,
        active_developers_total: Number(row.active_developers_total) || 0,
        active_developers_30d: Number(row.active_developers_30d) || 0,
        tokens_30d: Number(row.tokens_30d) || 0,
        token_growth_pct: row.token_growth_pct == null
          ? null
          : Number(row.token_growth_pct),
        developer_growth_pct: row.developer_growth_pct == null
          ? null
          : Number(row.developer_growth_pct),
        period: "total",
        from: row.from_day,
        to: row.to_day,
        generated_at: row.generated_at,
      },
      200,
      cacheHeaders,
    );
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
}
