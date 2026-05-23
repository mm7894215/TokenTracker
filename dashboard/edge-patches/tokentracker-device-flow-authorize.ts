/**
 * InsForge Edge: OAuth-style device flow — authorize step.
 *
 * Called from a CLI / SSH session that can't open a browser. The endpoint
 * creates a pair (device_code, user_code) and stores them with a 15-minute
 * expiry; the CLI then displays user_code to the human and polls
 * `tokentracker-device-flow-poll` until the user grants the code from a
 * browser via the dashboard /device page.
 *
 * Response:
 *   {
 *     device_code: <opaque, ~64 chars>,    // CLI keeps; never shown to user
 *     user_code:   "AB12-CD34",             // user types this in the browser
 *     verification_uri: "https://www.tokentracker.cc/device",
 *     verification_uri_complete: "https://www.tokentracker.cc/device?user_code=AB12-CD34",
 *     expires_in: 900,                      // seconds
 *     interval: 5                           // poll cadence in seconds
 *   }
 *
 * Public endpoint — no auth required, since the CLI by definition does
 * not have a token yet.
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

// 64 hex chars. crypto.getRandomValues is provided by Deno.
function generateDeviceCode(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// 8 ambiguity-safe chars (no 0/O/1/I/L) split as XXXX-XXXX for easy typing.
function generateUserCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += alphabet[bytes[i] % alphabet.length];
    if (i === 3) out += "-";
  }
  return out;
}

export default async function (req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: { client_info?: string } = {};
  try {
    body = await req.json();
  } catch (_e) {
    /* empty body is fine */
  }
  const clientInfo = typeof body.client_info === "string" ? body.client_info.slice(0, 200) : null;

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

  // Try a few times in the (vanishingly unlikely) case of user_code collision
  // — collision probability per attempt is ~10^-12, but the DB UNIQUE
  // constraint will throw if it does happen.
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const device_code = generateDeviceCode();
    const user_code = generateUserCode();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const { error } = await client.database.from("tokentracker_device_codes").insert([
      {
        device_code,
        user_code,
        status: "pending",
        client_info: clientInfo,
        expires_at: expiresAt,
      },
    ]);
    if (!error) {
      return json({
        device_code,
        user_code,
        verification_uri: "https://www.tokentracker.cc/device",
        verification_uri_complete: `https://www.tokentracker.cc/device?user_code=${encodeURIComponent(user_code)}`,
        expires_in: 900,
        interval: 5,
      });
    }
    lastError = error;
  }
  return json({ error: "could not allocate device code", detail: String(lastError) }, 503);
}
