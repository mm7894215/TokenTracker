/**
 * InsForge Edge: OAuth-style device flow — poll step.
 *
 * Called by the CLI at the cadence indicated by the authorize response
 * (default 5s). Returns:
 *   - 200 { status: "pending" }            – still waiting on the user
 *   - 200 { status: "approved", user_id, device_token, device_id }
 *                                         – user granted the code
 *   - 410 { status: "expired" }            – the 15-minute window lapsed
 *   - 404 { status: "unknown" }            – device_code is bogus
 *
 * Public endpoint — the device_code itself is the bearer credential.
 */
import { createClient } from "npm:@insforge/sdk";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// deno-lint-ignore no-explicit-any
async function issueDeviceToken(client: any, userId: string, clientInfo: string | null) {
  const platform = "cli-device-flow";
  const deviceName = `TokenTracker CLI${clientInfo ? ` (${clientInfo})` : ""}`.slice(0, 128);
  const newDeviceId = crypto.randomUUID();
  const { data: insertedDevice } = await client.database
    .from("tokentracker_devices")
    .insert([{ id: newDeviceId, user_id: userId, device_name: deviceName, platform }], {
      onConflict: "user_id,platform,device_name",
      ignoreDuplicates: true,
    })
    .select("id");

  let deviceId: string;
  if (Array.isArray(insertedDevice) && insertedDevice.length > 0) {
    deviceId = (insertedDevice[0] as { id: string }).id;
  } else {
    const { data: winner, error: lookupErr } = await client.database
      .from("tokentracker_devices")
      .select("id")
      .eq("user_id", userId)
      .eq("platform", platform)
      .eq("device_name", deviceName)
      .is("revoked_at", null)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (lookupErr || !winner) {
      throw new Error(lookupErr?.message || "device lookup failed");
    }
    deviceId = (winner as { id: string }).id;
  }

  const createdAt = new Date().toISOString();
  const { error: revokeErr } = await client.database
    .from("tokentracker_device_tokens")
    .update({ revoked_at: createdAt })
    .eq("device_id", deviceId)
    .is("revoked_at", null);
  if (revokeErr) throw new Error(revokeErr.message);

  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const { error: tokenErr } = await client.database.from("tokentracker_device_tokens").insert([
    {
      id: crypto.randomUUID(),
      device_id: deviceId,
      user_id: userId,
      token_hash: await sha256Hex(token),
    },
  ]);
  if (tokenErr) throw new Error(tokenErr.message);

  return { token, deviceId };
}

export default async function (req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: { device_code?: string } = {};
  try { body = await req.json(); } catch (_e) { /* */ }
  const deviceCode = typeof body.device_code === "string" ? body.device_code.trim() : "";
  if (!/^[0-9a-f]{64}$/.test(deviceCode)) return json({ status: "unknown" }, 404);

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

  const { data, error } = await client.database
    .from("tokentracker_device_codes")
    .select("device_code, user_id, status, expires_at, approved_at, client_info")
    .eq("device_code", deviceCode)
    .maybeSingle();

  if (error) return json({ error: "db error", detail: String(error?.message ?? error) }, 502);
  if (!data) return json({ status: "unknown" }, 404);

  const row = data as { user_id: string | null; status: string; expires_at: string; client_info: string | null };
  const expiresAt = new Date(row.expires_at).getTime();
  if (Date.now() > expiresAt) {
    // Best-effort cleanup. Scope the UPDATE to status='pending' so two
    // concurrent CLI polls racing past the same expiry don't both write —
    // PostgREST has no transactional read-modify-write here, but the
    // predicate makes the second update a no-op.
    await client.database
      .from("tokentracker_device_codes")
      .update({ status: "expired" })
      .eq("device_code", deviceCode)
      .eq("status", "pending");
    return json({ status: "expired" }, 410);
  }

  if (row.status === "approved" && row.user_id) {
    try {
      const issued = await issueDeviceToken(client, row.user_id, row.client_info);
      return json({
        status: "approved",
        user_id: row.user_id,
        device_token: issued.token,
        device_id: issued.deviceId,
      });
    } catch (e) {
      return json({ error: "Failed to issue device token", detail: String((e as Error)?.message ?? e) }, 500);
    }
  }
  return json({ status: "pending" });
}
