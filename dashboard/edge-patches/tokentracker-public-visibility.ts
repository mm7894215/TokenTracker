/**
 * InsForge Edge：公开资料开关。
 * Deno 内优先用 fetch 调 /api/auth/sessions/current 解析 user id（与浏览器 curl 一致）；
 * SDK 的 getCurrentUser() 在部分 Edge 运行时上对出站请求处理不稳定。
 */
import { createClient } from "npm:@insforge/sdk";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
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
 * Previously this endpoint trusted an unverified JWT payload, which let any
 * caller forge `{"sub":"<victim>"}` and POST to mutate that victim's public
 * profile (leaderboard_public, display_name, github_url, etc.). InsForge
 * does NOT validate JWTs at the gateway (see tokentracker-leaderboard-
 * profile.ts for the matching pattern), so this edge function must do it.
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

export default async function (req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const baseUrl = Deno.env.get("INSFORGE_BASE_URL")!;
  /** 与浏览器请求一致：优先环境变量，否则沿用调用方传入的 apikey（Edge 运行时未必注入 INSFORGE_ANON_KEY） */
  const incomingApiKey =
    req.headers.get("apikey") ?? req.headers.get("Apikey") ?? req.headers.get("x-api-key") ?? undefined;
  const anonKey =
    Deno.env.get("INSFORGE_ANON_KEY") ?? Deno.env.get("ANON_KEY") ?? incomingApiKey ?? undefined;
  const authH = req.headers.get("Authorization");
  const token = authH?.startsWith("Bearer ") ? authH.slice(7) : undefined;
  if (!token) return json({ error: "Unauthorized" }, 401);

  const userId = await verifiedUserIdFromJwt(token);
  if (!userId) return json({ error: "Unauthorized" }, 401);

  const serviceRoleKey = Deno.env.get("INSFORGE_SERVICE_ROLE_KEY");
  // 优先用 service role key 操作 DB，避免用户短期 JWT 过期导致 401
  const dbToken = serviceRoleKey || token;
  const client = createClient({
    baseUrl,
    edgeFunctionToken: dbToken,
    anonKey,
    ...(anonKey ? { headers: { apikey: anonKey } } : {}),
  });

  if (req.method === "GET") {
    const { data } = await client.database
      .from("tokentracker_user_settings")
      .select("leaderboard_public, leaderboard_anonymous, github_url, show_github_url, updated_at")
      .eq("user_id", userId)
      .maybeSingle();
    const { data: pv } = await client.database
      .from("tokentracker_public_views")
      .select("token_hash, updated_at")
      .eq("user_id", userId)
      .is("revoked_at", null)
      .maybeSingle();
    const { data: profile } = await client.database
      .from("tokentracker_user_profiles")
      .select("display_name")
      .eq("user_id", userId)
      .maybeSingle();
    return json({
      enabled: data?.leaderboard_public || false,
      anonymous: data?.leaderboard_anonymous || false,
      share_token: pv?.token_hash || null,
      updated_at: data?.updated_at || null,
      display_name: profile?.display_name || null,
      github_url: data?.github_url || null,
      show_github_url: data?.show_github_url || false,
    });
  }
  if (req.method === "POST") {
    const body = await req.json().catch(() => ({})) as {
      enabled?: boolean;
      anonymous?: boolean;
      display_name?: string;
      github_url?: string | null;
      show_github_url?: boolean;
    };
    const now = new Date().toISOString();

    // Validate github_url (optional). Accept public GitHub profile URLs only —
    // any host/path shape that isn't a bare user/org page is rejected so we
    // don't render arbitrary external links next to names on the leaderboard.
    // `null` / empty string explicitly clears the value.
    let normalizedGithubUrl: string | null | undefined = undefined;
    if (body.github_url !== undefined) {
      if (body.github_url === null || (typeof body.github_url === "string" && body.github_url.trim() === "")) {
        normalizedGithubUrl = null;
      } else if (typeof body.github_url === "string") {
        const raw = body.github_url.trim();
        // Allow bare handle, "@handle", or full URL. Normalize to canonical URL.
        const handleMatch = raw.match(/^@?([A-Za-z0-9][A-Za-z0-9-]{0,38})$/);
        const urlMatch = raw.match(/^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/?$/i);
        if (handleMatch) {
          normalizedGithubUrl = `https://github.com/${handleMatch[1]}`;
        } else if (urlMatch) {
          normalizedGithubUrl = `https://github.com/${urlMatch[1]}`;
        } else {
          return json({ error: "Invalid GitHub URL. Use https://github.com/<username> or a bare username." }, 400);
        }
      }
    }

    // Update settings (enabled / anonymous / github_url / show_github_url)
    if (
      body.enabled !== undefined ||
      body.anonymous !== undefined ||
      normalizedGithubUrl !== undefined ||
      body.show_github_url !== undefined
    ) {
      const upsertRow: Record<string, unknown> = {
        user_id: userId,
        updated_at: now,
      };
      if (body.enabled !== undefined) upsertRow.leaderboard_public = Boolean(body.enabled);
      if (body.anonymous !== undefined) upsertRow.leaderboard_anonymous = Boolean(body.anonymous);
      if (normalizedGithubUrl !== undefined) upsertRow.github_url = normalizedGithubUrl;
      if (body.show_github_url !== undefined) upsertRow.show_github_url = Boolean(body.show_github_url);
      await client.database.from("tokentracker_user_settings").upsert(
        upsertRow,
        { onConflict: "user_id" },
      );
    }

    // Update display_name in user_profiles
    if (typeof body.display_name === "string") {
      const trimmed = body.display_name.trim().slice(0, 50);
      await client.database.from("tokentracker_user_profiles").upsert(
        {
          user_id: userId,
          display_name: trimmed || null,
          updated_at: now,
        },
        { onConflict: "user_id" },
      );
    }

    const result: Record<string, unknown> = { updated_at: now };
    if (body.enabled !== undefined) result.enabled = Boolean(body.enabled);
    if (body.anonymous !== undefined) result.anonymous = Boolean(body.anonymous);
    if (typeof body.display_name === "string") result.display_name = body.display_name.trim().slice(0, 50) || null;
    if (normalizedGithubUrl !== undefined) result.github_url = normalizedGithubUrl;
    if (body.show_github_url !== undefined) result.show_github_url = Boolean(body.show_github_url);
    return json(result);
  }
  return json({ error: "Method not allowed" }, 405);
}
