/**
 * InsForge Edge: account-wide hourly usage for a single day (cross-device).
 * Mirrors local-api.js `tokentracker-usage-hourly`. Honors `tz` / `tz_offset_minutes`.
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

interface TzCtx {
  timeZone: string | null;
  offsetMinutes: number | null;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function getZonedParts(date: Date, ctx: TzCtx): ZonedParts | null {
  if (!Number.isFinite(date.getTime())) return null;
  if (ctx.timeZone) {
    try {
      const fmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: ctx.timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      });
      const parts = fmt.formatToParts(date);
      const values: Record<string, string> = {};
      for (const p of parts) if (p.type && p.value) values[p.type] = p.value;
      const year = Number(values.year);
      const month = Number(values.month);
      const day = Number(values.day);
      const hour = Number(values.hour);
      const minute = Number(values.minute);
      const second = Number(values.second);
      if ([year, month, day, hour, minute, second].every(Number.isFinite))
        return { year, month, day, hour, minute, second };
    } catch {
      // fall through
    }
  }
  if (ctx.offsetMinutes !== null && Number.isFinite(ctx.offsetMinutes)) {
    const shifted = new Date(date.getTime() + ctx.offsetMinutes * 60 * 1000);
    return {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: shifted.getUTCHours(),
      minute: shifted.getUTCMinutes(),
      second: shifted.getUTCSeconds(),
    };
  }
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
  };
}

function formatDayKey(parts: ZonedParts): string {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export default async function (req: Request): Promise<Response> {
  if (req.method === "OPTIONS")
    return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const url = new URL(req.url);
  const day = url.searchParams.get("day") || new Date().toISOString().slice(0, 10);
  const tz = String(url.searchParams.get("tz") || "").trim();
  const rawOffset = Number(url.searchParams.get("tz_offset_minutes"));
  const tzCtx: TzCtx = {
    timeZone: tz || null,
    offsetMinutes: Number.isFinite(rawOffset) ? Math.trunc(rawOffset) : null,
  };

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

  // Query a 3-day UTC window around `day` to cover all TZ offsets (±14h max)
  const dayDate = new Date(`${day}T00:00:00Z`);
  const start = new Date(dayDate);
  start.setUTCDate(start.getUTCDate() - 1);
  const end = new Date(dayDate);
  end.setUTCDate(end.getUTCDate() + 2);
  const rangeStart = start.toISOString();
  const rangeEnd = end.toISOString();

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

  const byHour = new Map<string, {
    hour: string;
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
    const parts = getZonedParts(new Date(row.hour_start), tzCtx);
    if (!parts) continue;
    if (formatDayKey(parts) !== day) continue;
    const hourKey = `${day}T${String(parts.hour).padStart(2, "0")}:00:00`;
    let bucket = byHour.get(hourKey);
    if (!bucket) {
      bucket = {
        hour: hourKey,
        total_tokens: 0,
        billable_total_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        reasoning_output_tokens: 0,
        conversation_count: 0,
      };
      byHour.set(hourKey, bucket);
    }
    const tt = Number(row.total_tokens) || 0;
    bucket.total_tokens += tt;
    bucket.billable_total_tokens += tt;
    bucket.input_tokens += Number(row.input_tokens) || 0;
    bucket.output_tokens += Number(row.output_tokens) || 0;
    bucket.cached_input_tokens += Number(row.cached_input_tokens) || 0;
    bucket.cache_creation_input_tokens += Number(row.cache_creation_input_tokens) || 0;
    bucket.reasoning_output_tokens += Number(row.reasoning_output_tokens) || 0;
    bucket.conversation_count += Number(row.conversations) || 0;
  }

  const data = Array.from(byHour.values()).sort((a, b) => a.hour.localeCompare(b.hour));
  return json({ day, data });
}
