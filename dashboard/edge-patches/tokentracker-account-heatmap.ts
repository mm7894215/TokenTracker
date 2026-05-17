/**
 * InsForge Edge: account-wide activity heatmap (cross-device, by user_id).
 * Mirrors local-api.js `tokentracker-usage-heatmap` response schema.
 * Level algorithm: 0 if no billable tokens, else 1..4 based on ratio to max.
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
}

export default async function (req: Request): Promise<Response> {
  if (req.method === "OPTIONS")
    return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const url = new URL(req.url);
  const weeks = parseInt(url.searchParams.get("weeks") || "52", 10);
  const tz = url.searchParams.get("tz") || null;
  const tzOffsetRaw = url.searchParams.get("tz_offset_minutes");
  const tzOffsetMinutes = tzOffsetRaw != null && tzOffsetRaw !== "" ? Number(tzOffsetRaw) : null;
  const toParam = url.searchParams.get("to") || "";
  const weekStartsOnRaw = (url.searchParams.get("week_starts_on") || "sun").toLowerCase();
  const weekStartsOn = weekStartsOnRaw === "mon" ? "mon" : "sun";

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

  // End anchor: caller-supplied `to` in their local day, else local today.
  const toStr = toParam || zonedDayKey(new Date().toISOString(), tz, tzOffsetMinutes);
  const end = new Date(`${toStr}T00:00:00Z`);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - weeks * 7 + 1);
  const from = start.toISOString().slice(0, 10);
  const to = toStr;

  // Widen ±1 day so TZ-shifted edges still get caught by the UTC query.
  const startDate = new Date(`${from}T00:00:00Z`);
  startDate.setUTCDate(startDate.getUTCDate() - 1);
  const nextDay = new Date(`${to}T00:00:00Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 2);
  const rangeStart = startDate.toISOString();
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
        .select("hour_start, source, model, total_tokens, input_tokens, output_tokens, cached_input_tokens, cache_creation_input_tokens, reasoning_output_tokens")
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

  // Collapse same (hour_start, source, model) across device_ids to the
  // largest-total row. Prevents double-counting when a logical bucket got
  // written under multiple device_ids (cross-machine cursor reset, or
  // historic device_id rotation before partial-unique was enforced).
  const dedupKey = new Map<string, HourlyRow>();
  for (const row of rawRows) {
    if (!row.hour_start) continue;
    const key = `${row.hour_start} ${row.source ?? ""} ${row.model ?? ""}`;
    const incumbent = dedupKey.get(key);
    const incumbentTotal = incumbent ? (Number(incumbent.total_tokens) || 0) : -1;
    const challengerTotal = Number(row.total_tokens) || 0;
    if (!incumbent || challengerTotal > incumbentTotal) {
      dedupKey.set(key, row);
    }
  }
  const rows = Array.from(dedupKey.values());

  const byDay = new Map<string, { total_tokens: number; billable_total_tokens: number }>();
  for (const row of rows) {
    if (!row.hour_start) continue;
    const day = zonedDayKey(String(row.hour_start), tz, tzOffsetMinutes);
    if (day < from || day > to) continue;
    let a = byDay.get(day);
    if (!a) {
      a = { total_tokens: 0, billable_total_tokens: 0 };
      byDay.set(day, a);
    }
    const tt = Number(row.total_tokens) || 0;
    a.total_tokens += tt;
    a.billable_total_tokens += tt;
  }

  const allValues = Array.from(byDay.values())
    .map((d) => d.billable_total_tokens)
    .filter((v) => v > 0);
  const maxValue = allValues.length > 0 ? Math.max(...allValues) : 0;
  const calcLevel = (v: number): 0 | 1 | 2 | 3 | 4 => {
    if (v <= 0) return 0;
    if (maxValue === 0) return 1;
    const r = v / maxValue;
    if (r <= 0.25) return 1;
    if (r <= 0.5) return 2;
    if (r <= 0.75) return 3;
    return 4;
  };

  const cells: { day: string; total_tokens: number; billable_total_tokens: number; level: number }[] = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    const day = cursor.toISOString().slice(0, 10);
    const data = byDay.get(day);
    const billable = data?.billable_total_tokens || 0;
    cells.push({
      day,
      total_tokens: data?.total_tokens || 0,
      billable_total_tokens: billable,
      level: calcLevel(billable),
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  const weeksArr: typeof cells[] = [];
  for (let i = 0; i < cells.length; i += 7) {
    weeksArr.push(cells.slice(i, i + 7));
  }

  return json({
    from,
    to,
    week_starts_on: weekStartsOn,
    active_days: cells.filter((c) => c.billable_total_tokens > 0).length,
    streak_days: 0,
    weeks: weeksArr,
  });
}
