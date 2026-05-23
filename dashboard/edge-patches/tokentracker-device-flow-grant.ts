/**
 * InsForge Edge: OAuth-style device flow — grant step.
 *
 * Called from the dashboard /device page after the user (already
 * authenticated in their browser) types in the 8-char user_code shown by
 * their CLI. We:
 *   1. Verify the caller's JWT (must be signed with our project secret)
 *   2. Look up the user_code → device_code row
 *   3. Mark it approved with the caller's user_id
 *
 * The CLI's next poll then returns { status: "approved", user_id }.
 *
 * Auth: requires a valid Bearer JWT (the browser session). Anonymous
 * callers are rejected. We verify locally — never via the InsForge
 * gateway — for the same JWSError-cascade reasons that the leaderboard
 * profile endpoint documents.
 */
import { createClient } from "npm:@insforge/sdk";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
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

function isValidUserCode(c: string): boolean {
  // XXXX-XXXX from the alphabet "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
  return /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/.test(c);
}

export default async function (req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const callerUserId = await verifyCallerUserId(req);
  if (!callerUserId) return json({ error: "unauthorized" }, 401);

  let body: { user_code?: string } = {};
  try { body = await req.json(); } catch (_e) { /* */ }
  const userCode = typeof body.user_code === "string" ? body.user_code.toUpperCase().trim() : "";
  if (!isValidUserCode(userCode)) return json({ error: "invalid user_code format" }, 400);

  const baseUrl = Deno.env.get("INSFORGE_BASE_URL");
  const serviceRoleKey = Deno.env.get("INSFORGE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("INSFORGE_ANON_KEY") ?? Deno.env.get("ANON_KEY");
  if (!baseUrl) return json({ error: "misconfigured" }, 500);
  const dbToken = serviceRoleKey || anonKey;

  const client = createClient({
    baseUrl,
    edgeFunctionToken: dbToken,
    anonKey,
    ...(anonKey ? { headers: { apikey: anonKey } } : {}),
  });

  const { data, error: lookupErr } = await client.database
    .from("tokentracker_device_codes")
    .select("device_code, status, expires_at, client_info")
    .eq("user_code", userCode)
    .maybeSingle();
  if (lookupErr) return json({ error: "db error", detail: String(lookupErr?.message ?? lookupErr) }, 502);
  if (!data) return json({ error: "user_code not found" }, 404);

  const row = data as { device_code: string; status: string; expires_at: string; client_info: string | null };
  if (Date.now() > new Date(row.expires_at).getTime()) {
    return json({ error: "user_code expired", expired_at: row.expires_at }, 410);
  }
  if (row.status === "approved") {
    return json({ status: "already_approved", client_info: row.client_info });
  }

  const { error: updateErr } = await client.database
    .from("tokentracker_device_codes")
    .update({
      status: "approved",
      user_id: callerUserId,
      approved_at: new Date().toISOString(),
    })
    .eq("device_code", row.device_code);
  if (updateErr) return json({ error: "db error", detail: String(updateErr?.message ?? updateErr) }, 502);

  return json({ status: "approved", client_info: row.client_info });
}
