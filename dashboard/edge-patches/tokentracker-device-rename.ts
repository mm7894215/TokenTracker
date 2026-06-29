/**
 * InsForge Edge: rename one of the signed-in user's own devices.
 *
 * POST { device_id, device_name }. The user is identified by HS256 JWT
 * signature verification (JWT_SECRET) — InsForge does NOT validate JWTs at
 * the gateway, so we verify locally, same template as
 * tokentracker-account-devices / tokentracker-device-token-issue.
 *
 * The UPDATE is scoped to (id = device_id AND user_id = <verified sub> AND
 * revoked_at IS NULL): a caller can only rename an active device they own;
 * any other id matches zero rows → 404. The partial unique index
 * `tokentracker_devices_active_unique` on (user_id, platform, device_name)
 * means renaming to a name already held by another active device on the same
 * platform raises a unique violation → surfaced as 409 (name_taken).
 */
import { createClient } from "npm:@insforge/sdk";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

const MAX_NAME_LEN = 60;

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

export default async function (req: Request): Promise<Response> {
  if (req.method === "OPTIONS")
    return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const baseUrl = Deno.env.get("INSFORGE_BASE_URL");
  if (!baseUrl) return json({ error: "server misconfigured" }, 500);
  const serviceRoleKey = Deno.env.get("INSFORGE_SERVICE_ROLE_KEY");
  if (!serviceRoleKey) return json({ error: "server misconfigured" }, 500);
  const incomingApiKey =
    req.headers.get("apikey") ?? req.headers.get("Apikey") ?? req.headers.get("x-api-key") ?? undefined;
  const anonKey =
    Deno.env.get("INSFORGE_ANON_KEY") ?? Deno.env.get("ANON_KEY") ?? incomingApiKey ?? undefined;

  const userId = await verifiedUserIdFromJwt(req.headers.get("Authorization"));
  if (!userId) return json({ error: "Unauthorized" }, 401);

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const deviceId = typeof body.device_id === "string" ? body.device_id.trim() : "";
  if (!deviceId) return json({ error: "device_id is required" }, 400);
  const name = (typeof body.device_name === "string" ? body.device_name : "").trim().slice(0, MAX_NAME_LEN);
  if (!name) return json({ error: "device_name is required" }, 400);

  const client = createClient({
    baseUrl,
    edgeFunctionToken: serviceRoleKey,
    anonKey,
    ...(anonKey ? { headers: { apikey: anonKey } } : {}),
  });

  try {
    const { data, error } = await client.database
      .from("tokentracker_devices")
      .update({ device_name: name })
      .eq("id", deviceId)
      .eq("user_id", userId)
      .is("revoked_at", null)
      .select("id, device_name, platform");
    if (error) {
      const msg = error.message || "";
      if (/unique|duplicate|conflict|already exists/i.test(msg))
        return json({ error: "name_taken" }, 409);
      return json({ error: msg }, 500);
    }
    const rows = (Array.isArray(data) ? data : []) as Array<Record<string, unknown>>;
    if (rows.length === 0) return json({ error: "not_found" }, 404);
    return json({ ok: true, device: rows[0] });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
}
