/**
 * InsForge Edge: account-wide monthly usage (cross-device, aggregated by user_id).
 * Mirrors local-api.js `tokentracker-usage-monthly` response schema.
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

function decodeJwtUserId(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payloadRaw = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payloadRaw + "=".repeat((4 - (payloadRaw.length % 4)) % 4);
    const payload = JSON.parse(atob(padded)) as Record<string, unknown>;
    const sub = (payload.sub ?? payload.user_id) as string | undefined;
    return typeof sub === "string" && sub.length > 0 ? sub : null;
  } catch {
    return null;
  }
}

interface HourlyRow {
  hour_start: string;
  total_tokens: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  reasoning_output_tokens: number | null;
  conversation_count: number | null;
}

export default async function (req: Request): Promise<Response> {
  if (req.method === "OPTIONS")
    return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const userId = decodeJwtUserId(req.headers.get("Authorization"));
  if (!userId) return json({ error: "Unauthorized" }, 401);

  const url = new URL(req.url);
  let from = url.searchParams.get("from") || "";
  let to = url.searchParams.get("to") || "";
  const monthsParam = parseInt(url.searchParams.get("months") || "", 10);
  // Matches local /functions/tokentracker-usage-monthly contract: caller
  // may send months (+ optional to) instead of an explicit from/to range.
  if ((!from || !to) && Number.isFinite(monthsParam) && monthsParam > 0) {
    const toDate = to ? new Date(`${to}T00:00:00Z`) : new Date();
    if (!to) to = toDate.toISOString().slice(0, 10);
    const fromDate = new Date(Date.UTC(toDate.getUTCFullYear(), toDate.getUTCMonth() - (monthsParam - 1), 1));
    if (!from) from = fromDate.toISOString().slice(0, 10);
  }
  if (!from || !to) return json({ error: "Missing from/to or months" }, 400);

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

  const rangeStart = `${from}T00:00:00Z`;
  const nextDay = new Date(`${to}T00:00:00Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const rangeEnd = nextDay.toISOString();

  const rows: HourlyRow[] = [];
  let offset = 0;
  const PAGE_SIZE = 1000;
  while (true) {
    const { data, error } = await client.database
      .from("tokentracker_hourly")
      .select(
        "hour_start, total_tokens, input_tokens, output_tokens, cached_input_tokens, cache_creation_input_tokens, reasoning_output_tokens, conversation_count",
      )
      .eq("user_id", userId)
      .gte("hour_start", rangeStart)
      .lt("hour_start", rangeEnd)
      .order("hour_start", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) return json({ error: error.message }, 500);
    if (!data || data.length === 0) break;
    rows.push(...(data as unknown as HourlyRow[]));
    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  const byMonth = new Map<string, {
    month: string;
    total_tokens: number;
    billable_total_tokens: number;
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens: number;
    cache_creation_input_tokens: number;
    reasoning_output_tokens: number;
    conversation_count: number;
  }>();

  for (const row of rows) {
    if (!row.hour_start) continue;
    const day = String(row.hour_start).slice(0, 10);
    if (day < from || day > to) continue;
    const month = day.slice(0, 7);
    let a = byMonth.get(month);
    if (!a) {
      a = {
        month,
        total_tokens: 0,
        billable_total_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        reasoning_output_tokens: 0,
        conversation_count: 0,
      };
      byMonth.set(month, a);
    }
    const tt = Number(row.total_tokens) || 0;
    a.total_tokens += tt;
    a.billable_total_tokens += tt;
    a.input_tokens += Number(row.input_tokens) || 0;
    a.output_tokens += Number(row.output_tokens) || 0;
    a.cached_input_tokens += Number(row.cached_input_tokens) || 0;
    a.cache_creation_input_tokens += Number(row.cache_creation_input_tokens) || 0;
    a.reasoning_output_tokens += Number(row.reasoning_output_tokens) || 0;
    a.conversation_count += Number(row.conversation_count) || 0;
  }

  const data = Array.from(byMonth.values()).sort((a, b) => a.month.localeCompare(b.month));
  return json({ from, to, data });
}
