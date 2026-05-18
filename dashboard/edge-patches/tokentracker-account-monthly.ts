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

interface HourlyRow {
  hour_start: string;
  source: string | null;
  model: string | null;
  total_tokens: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  reasoning_output_tokens: number | null;
  conversations: number | null;
}

export default async function (req: Request): Promise<Response> {
  if (req.method === "OPTIONS")
    return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

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

  const userId = await verifiedUserIdFromJwt(req.headers.get("Authorization"));
  if (!userId) return json({ error: "Unauthorized" }, 401);

  let activeDeviceIds: string[];
  try {
    activeDeviceIds = await fetchActiveDeviceIds(client, userId);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }

  const rangeStart = `${from}T00:00:00Z`;
  const nextDay = new Date(`${to}T00:00:00Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const rangeEnd = nextDay.toISOString();

  const rawRows: HourlyRow[] = [];
  const PAGE_SIZE = 1000;
  const DEVICE_CHUNK = 25;
  for (let i = 0; i < activeDeviceIds.length; i += DEVICE_CHUNK) {
    const chunk = activeDeviceIds.slice(i, i + DEVICE_CHUNK);
    let offset = 0;
    while (true) {
      const { data, error } = await client.database
        .from("tokentracker_hourly")
        .select(
          "hour_start, source, model, total_tokens, input_tokens, output_tokens, cached_input_tokens, cache_creation_input_tokens, reasoning_output_tokens, conversations",
        )
        .eq("user_id", userId)
        .in("device_id", chunk)
        .gte("hour_start", rangeStart)
        .lt("hour_start", rangeEnd)
        .order("hour_start", { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);
      if (error) return json({ error: error.message }, 500);
      if (!data || data.length === 0) break;
      rawRows.push(...(data as unknown as HourlyRow[]));
      if (data.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
  }

  const rows = rawRows;

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
    a.conversation_count += Number(row.conversations) || 0;
  }

  const data = Array.from(byMonth.values()).sort((a, b) => a.month.localeCompare(b.month));
  return json({ from, to, data });
}
