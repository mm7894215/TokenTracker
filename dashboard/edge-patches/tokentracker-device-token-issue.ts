/**
 * InsForge Edge：为当前登录用户签发 device token（写入 tokentracker_devices / tokentracker_device_tokens）。
 * 与文档中 historical 名称 vibeusage-device-token-issue 不同：本项目云端 slug 为 tokentracker-device-token-issue。
 */
import { createClient } from "npm:@insforge/sdk";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-tokentracker-device-token-hash",
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
 * Verify a HS256 JWT signature locally with JWT_SECRET and return its `sub`.
 *
 * Previously this function only decoded the payload without verifying the
 * signature, which let any caller forge `{"sub":"<victim>"}` and obtain a
 * service-role-signed device token bound to that victim's account. The
 * companion endpoint `tokentracker-leaderboard-profile.ts` already verifies
 * signatures here for the same reason — InsForge does NOT validate JWTs at
 * the gateway, so edge functions must do it themselves.
 *
 * Returns null on any failure (bad shape, bad signature, expired); the
 * caller surfaces that as 401.
 */
async function verifiedUserIdFromJwt(token: string): Promise<string | null> {
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
    if (typeof sub === "string" && sub.length > 0) return sub;
    const uid = payload.user_id;
    if (typeof uid === "string" && uid.length > 0) return uid;
  } catch {
    /* ignore */
  }
  return null;
}

function resolveUserIdForUserMode(bearer: string): Promise<string | null> {
  return verifiedUserIdFromJwt(bearer);
}

async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export default async function (req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const baseUrl = Deno.env.get("INSFORGE_BASE_URL")!;
  const incomingApiKey =
    req.headers.get("apikey") ?? req.headers.get("Apikey") ?? req.headers.get("x-api-key") ?? undefined;
  const anonKey =
    Deno.env.get("INSFORGE_ANON_KEY") ?? Deno.env.get("ANON_KEY") ?? incomingApiKey ?? undefined;

  const bearer = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!bearer) return json({ error: "Missing bearer token" }, 401);

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const serviceRoleKey = Deno.env.get("INSFORGE_SERVICE_ROLE_KEY");
  const adminMode = Boolean(serviceRoleKey && bearer === serviceRoleKey);

  let userId: string | null = null;
  let dbClient: ReturnType<typeof createClient>;

  if (adminMode) {
    const fromBody = typeof body.user_id === "string" ? body.user_id : null;
    const dataObj = body.data && typeof body.data === "object" ? (body.data as Record<string, unknown>) : null;
    const fromData = dataObj && typeof dataObj.user_id === "string" ? dataObj.user_id : null;
    userId = fromBody || fromData;
    if (!userId) return json({ error: "user_id is required (admin mode)" }, 400);
    dbClient = createClient({
      baseUrl,
      edgeFunctionToken: serviceRoleKey!,
      anonKey,
      ...(anonKey ? { headers: { apikey: anonKey } } : {}),
    });
  } else {
    userId = await resolveUserIdForUserMode(bearer);
    if (!userId) return json({ error: "Unauthorized" }, 401);
    // 用 service role key 操作 DB：用户身份已通过 JWT 签名验证（HS256 + JWT_SECRET），
    // 不再依赖用户的短期 access token（15 min 过期）做 DB 写入。
    const dbToken = serviceRoleKey || bearer;
    dbClient = createClient({
      baseUrl,
      edgeFunctionToken: dbToken,
      anonKey,
      ...(anonKey ? { headers: { apikey: anonKey } } : {}),
    });
  }

  const deviceName = String(body.device_name ?? (body.data as Record<string, unknown> | undefined)?.device_name ?? "Token Tracker")
    .slice(0, 128);
  const platform = String(body.platform ?? (body.data as Record<string, unknown> | undefined)?.platform ?? "web").slice(
    0,
    32,
  );

  // Reuse an existing active device for the same (user, platform, device_name)
  // instead of minting a fresh one on every issue. Client localStorage is
  // isolated across Safari / Chrome / WKWebView, so the client asks for a new
  // token on every environment — if we created a fresh device_id each time,
  // `tokentracker_hourly` ends up with the same logical bucket written under
  // many device_ids, and leaderboard SUM would double-count. Keeping a single
  // device_id per logical device means every sync upserts onto the same row.
  //
  // Concurrency: two parallel calls (tab + webview on first login) must not
  // each INSERT a fresh row. The partial unique index
  // `tokentracker_devices_active_unique` on (user_id, platform, device_name)
  // WHERE revoked_at IS NULL guarantees one active row per logical device.
  // We INSERT with ON CONFLICT DO NOTHING; if the insert loses the race it
  // returns zero rows, and we SELECT to get the winner's id.
  const newDeviceId = crypto.randomUUID();
  const { data: insertedDevice } = await dbClient.database
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
    const { data: winner, error: lookupErr } = await dbClient.database
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
      return json(
        { error: "Failed to issue device token", detail: lookupErr?.message || "device lookup failed" },
        500,
      );
    }
    deviceId = (winner as { id: string }).id;
  }

  const tokenId = crypto.randomUUID();
  const token =
    crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const tokenHash = await sha256Hex(token);
  const createdAt = new Date().toISOString();

  const { error: revokeErr } = await dbClient.database
    .from("tokentracker_device_tokens")
    .update({ revoked_at: createdAt })
    .eq("device_id", deviceId)
    .is("revoked_at", null);

  if (revokeErr) {
    return json({ error: "Failed to rotate device token", detail: revokeErr.message }, 500);
  }

  const { error: tokenErr } = await dbClient.database.from("tokentracker_device_tokens").insert([
    {
      id: tokenId,
      device_id: deviceId,
      user_id: userId,
      token_hash: tokenHash,
    },
  ]);

  if (tokenErr) {
    return json({ error: "Failed to issue device token", detail: tokenErr.message }, 500);
  }

  return json({ token, device_id: deviceId, created_at: createdAt });
}
