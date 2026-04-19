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

  const client = getClient(req);
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
