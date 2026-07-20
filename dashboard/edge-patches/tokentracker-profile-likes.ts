/**
 * Tokentracker profile likes — per-liker relation table.
 *
 * Storage: `tokentracker_profile_likes`, one row per (target_user_id, liker_id).
 *   count = COUNT(*) for a target; liked = the caller's liker_id has a row.
 *   This makes the count a self-consistent truth (no client-trusted delta), so
 *   it can never drift, double-count, or roll back on a stale optimistic update.
 *
 * Liker identity (`liker_id`):
 *   - signed-in  → verified JWT `sub` (cannot be forged; identical across
 *                  devices and the browser / macOS WKWebView / Windows WebView2).
 *   - anonymous  → client-persisted random UUID, sent as `anon_id`, stored as
 *                  `anon_<uuid>` (per-browser dedup; resets on clear/new device).
 *   - legacy     → migrated historical counter rows ('legacy_<uuid>_<n>'),
 *                  never revocable — a permanent floor for the count.
 *   - compat     → old clients still on the {user_id, delta} protocol get
 *                  'compat_<uuid>' rows so their count still moves (see below).
 *
 * Endpoints (new protocol):
 *   GET  ?target_user_id=X[&anon_id=Y]  (optional Bearer) → { count, liked }
 *   POST { target_user_id, action: 'like'|'unlike', anon_id? } (optional Bearer)
 *                                                        → { count, liked }
 *
 * Backward compatibility (embedded desktop dashboards lag behind on releases):
 *   GET  ?user_id=X                     → { count, liked:false }
 *   POST { user_id, delta: 1 | -1 }     → { count, liked:false }
 *   The old delta protocol has no stable liker identity, so +1 inserts a
 *   'compat_<uuid>' row and -1 removes one — the count still tracks, and old
 *   clients that previously hit a 404 on settings-less targets now work too.
 *
 * Notes:
 *   - target must exist in tokentracker_leaderboard_snapshots (mirrors the
 *     profile-visibility gate) before any write → otherwise 404, so an
 *     arbitrary UUID can't seed rows.
 *   - target in LEADERBOARD_BLOCKED_USER_IDS → 404 (consistent with profile).
 *   - Anonymous likes are allowed (no JWT required); anon dedup is best-effort
 *     ONLY. This is a decorative counter, not a trust source: it does not affect
 *     leaderboard rank (rank is token-based), and a caller can mint fresh
 *     anon_<uuid> values — or POST the legacy {user_id, delta} protocol, which
 *     carries no identity at all — to inflate a target's count. The UNIQUE
 *     constraint only stops the SAME liker_id from double-counting. Do not treat
 *     the count as verified. (Schema + threat model: scripts/ops/
 *     tokentracker-profile-likes-schema.sql.)
 *   - anon→account merge: a signed-in caller may also send its anon_id; on
 *     like the anon row is migrated to the account row, on unlike both are
 *     cleared, and reads treat either row as "liked" — so liking anonymously
 *     then logging in never double-counts and keeps the button in sync.
 *   - The table has RLS enabled with no policy: only this function's
 *     service-role key can read/write it (direct PostgREST access is denied).
 */
import { createClient } from "npm:@insforge/sdk";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

const BLOCKED_LEADERBOARD_USER_IDS = new Set(
  (Deno.env.get("LEADERBOARD_BLOCKED_USER_IDS") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
);

const LIKES_TABLE = "tokentracker_profile_likes";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 * InsForge does NOT validate JWTs at the gateway, so this edge function must
 * do it — otherwise any caller could forge `{"sub":"<victim>"}` and like as
 * someone else. Returns null on any failure (bad shape/signature/expired);
 * the caller falls back to anonymous identity rather than hard-failing, since
 * a like is decorative. Mirrors tokentracker-public-visibility.ts.
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

function getClient(incomingApiKey?: string) {
  const serviceRoleKey = Deno.env.get("INSFORGE_SERVICE_ROLE_KEY");
  const anonKey =
    Deno.env.get("INSFORGE_ANON_KEY") ?? Deno.env.get("ANON_KEY") ?? incomingApiKey ?? undefined;
  return createClient({
    baseUrl: Deno.env.get("INSFORGE_BASE_URL")!,
    edgeFunctionToken: serviceRoleKey,
    anonKey: anonKey ?? undefined,
    ...(anonKey ? { headers: { apikey: anonKey } } : {}),
    isServerMode: true,
  });
}

/**
 * Resolve the caller's liker identity. Signed-in identity is taken ONLY from a
 * verified JWT (never from the body), so it can't be forged. Otherwise an
 * `anon_id` (a client-persisted random UUID) becomes `anon_<uuid>`. The
 * `anon_`/`legacy_`/`compat_` prefixes keep anonymous ids in a separate
 * namespace from raw-UUID account ids, so an anon caller can't impersonate an
 * account. Returns null when no usable identity is present.
 */
function anonLikerIdFrom(anonId?: string | null): string | null {
  return anonId && UUID_RE.test(anonId) ? `anon_${anonId}` : null;
}

async function resolveLiker(
  req: Request,
  anonId?: string | null,
): Promise<{ likerId: string; isAuth: boolean } | null> {
  const authH = req.headers.get("Authorization");
  const token = authH?.startsWith("Bearer ") ? authH.slice(7) : undefined;
  if (token) {
    const sub = await verifiedUserIdFromJwt(token);
    if (sub) return { likerId: sub, isAuth: true };
    // token present but invalid → fall through to anon (don't hard-fail).
  }
  const anon = anonLikerIdFrom(anonId);
  if (anon) return { likerId: anon, isAuth: false };
  return null;
}

// deno-lint-ignore no-explicit-any
async function targetInSnapshots(client: any, userId: string): Promise<boolean> {
  const { data, error } = await client.database
    .from("tokentracker_leaderboard_snapshots")
    .select("user_id")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();
  // Fail closed (treat as not-found → 404) but log so a real DB fault is
  // distinguishable from a genuinely absent target.
  if (error) console.error("targetInSnapshots query failed:", error.message);
  return Boolean(data);
}

// deno-lint-ignore no-explicit-any
async function readState(
  client: any,
  target: string,
  likerId?: string | null,
  // A signed-in caller may also carry an anon liker id from likes made before
  // they logged in; treat the profile as liked if EITHER identity has a row.
  secondaryLikerId?: string | null,
): Promise<{ count: number; liked: boolean }> {
  // count:"exact" returns the precise full-set size via Content-Range even if
  // the row payload is capped — so this is exact regardless of max-rows.
  // head:true skips transferring the id rows entirely; only the count is read.
  const { count, error } = await client.database
    .from(LIKES_TABLE)
    .select("id", { count: "exact", head: true })
    .eq("target_user_id", target);
  if (error) throw new Error(error.message);
  let liked = false;
  const likerIds = [likerId, secondaryLikerId].filter(Boolean) as string[];
  if (likerIds.length) {
    const { data, error: likedErr } = await client.database
      .from(LIKES_TABLE)
      .select("id")
      .eq("target_user_id", target)
      .in("liker_id", likerIds)
      .limit(1);
    // Default to liked=false on error (safe for a decorative flag) but log so
    // the failure isn't silently masked as "not liked".
    if (likedErr) console.error("readState liked query failed:", likedErr.message);
    liked = Array.isArray(data) && data.length > 0;
  }
  return { count: Number(count) || 0, liked };
}

export default async function (req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const incomingApiKey =
    req.headers.get("apikey") ?? req.headers.get("Apikey") ?? req.headers.get("x-api-key") ?? undefined;
  if (!Deno.env.get("INSFORGE_SERVICE_ROLE_KEY")) {
    return json({ error: "server misconfigured" }, 500);
  }
  const client = getClient(incomingApiKey ?? undefined);

  if (req.method === "GET") {
    const url = new URL(req.url);
    const target = url.searchParams.get("target_user_id") ?? url.searchParams.get("user_id");
    const anonId = url.searchParams.get("anon_id");
    if (!target || !UUID_RE.test(target)) return json({ error: "target_user_id is required" }, 400);
    if (BLOCKED_LEADERBOARD_USER_IDS.has(target)) return json({ error: "Not found" }, 404);
    try {
      const liker = await resolveLiker(req, anonId);
      // For a signed-in caller also check their pre-login anon row, so the
      // button shows "liked" right after login instead of resetting to unliked.
      const secondary = liker?.isAuth ? anonLikerIdFrom(anonId) : null;
      const state = await readState(client, target, liker?.likerId, secondary);
      return json(state);
    } catch (e) {
      return json({ error: (e as Error).message || "read failed" }, 500);
    }
  }

  if (req.method === "POST") {
    let body: { target_user_id?: string; user_id?: string; action?: string; anon_id?: string; delta?: number };
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }
    const target = body.target_user_id ?? body.user_id;
    if (!target || !UUID_RE.test(target)) return json({ error: "target_user_id is required" }, 400);
    if (BLOCKED_LEADERBOARD_USER_IDS.has(target)) return json({ error: "Not found" }, 404);

    const isLegacyDelta = body.action == null && (body.delta === 1 || body.delta === -1);
    if (!isLegacyDelta && body.action !== "like" && body.action !== "unlike") {
      return json({ error: "action must be 'like' or 'unlike'" }, 400);
    }

    // New protocol needs a liker identity; legacy delta protocol does not.
    const liker = isLegacyDelta ? null : await resolveLiker(req, body.anon_id);
    if (!isLegacyDelta && !liker) return json({ error: "identity required" }, 401);

    if (!(await targetInSnapshots(client, target))) return json({ error: "Not found" }, 404);

    try {
      if (isLegacyDelta) {
        // Old {user_id, delta} clients: keep the count moving without a stable
        // liker. +1 inserts a throwaway compat row; -1 removes one if present.
        if (body.delta === 1) {
          const { error } = await client.database
            .from(LIKES_TABLE)
            .insert([{ target_user_id: target, liker_id: `compat_${crypto.randomUUID()}`, is_authenticated: false }]);
          if (error) throw new Error(error.message);
        } else {
          const { data: row } = await client.database
            .from(LIKES_TABLE)
            .select("id")
            .eq("target_user_id", target)
            // escape the SQL LIKE wildcard `_` so this matches a literal
            // "compat_" prefix (the namespace is controlled, but be precise).
            .like("liker_id", "compat\\_%")
            .limit(1)
            .maybeSingle();
          if (row) {
            const { error } = await client.database.from(LIKES_TABLE).delete().eq("id", (row as { id: string }).id);
            if (error) throw new Error(error.message);
          }
        }
        const state = await readState(client, target, liker?.likerId);
        return json(state);
      }

      // New protocol (like / unlike) with a resolved liker identity.
      // When a signed-in caller also sends their anon_id, migrate/clear that
      // pre-login anon row. The merge is EVENTUALLY consistent, not atomic: the
      // account write and the anon-row delete are two steps, so a concurrent
      // anon like landing in the gap can transiently re-create the anon row and
      // briefly count one human twice. Acceptable for a decorative counter — the
      // next like/unlike or page reload re-runs the merge and reconverges.
      const mergeAnonId = liker!.isAuth ? anonLikerIdFrom(body.anon_id) : null;
      if (body.action === "like") {
        const { error } = await client.database
          .from(LIKES_TABLE)
          .insert([{ target_user_id: target, liker_id: liker!.likerId, is_authenticated: liker!.isAuth }]);
        // A duplicate means the like already exists — idempotent success, not
        // an error. The SDK's onConflict/ignoreDuplicates option did NOT
        // suppress the unique-violation in practice, so swallow it explicitly.
        if (error && !/duplicate key|unique constraint/i.test(error.message)) {
          throw new Error(error.message);
        }
        // Migrate: now that the account row exists, drop the redundant anon row.
        if (mergeAnonId) {
          const { error: delErr } = await client.database
            .from(LIKES_TABLE)
            .delete()
            .eq("target_user_id", target)
            .eq("liker_id", mergeAnonId);
          // Don't fail the like if cleanup fails (the account row already landed);
          // log it, and the readState below still reports liked correctly because
          // the lingering anon row is checked as the secondary identity.
          if (delErr) console.error("like: anon-row merge delete failed:", delErr.message);
        }
      } else {
        const { error } = await client.database
          .from(LIKES_TABLE)
          .delete()
          .eq("target_user_id", target)
          .eq("liker_id", liker!.likerId);
        if (error) throw new Error(error.message);
        // Also remove a pre-login anon like so unlike fully clears this human.
        if (mergeAnonId) {
          const { error: delErr } = await client.database
            .from(LIKES_TABLE)
            .delete()
            .eq("target_user_id", target)
            .eq("liker_id", mergeAnonId);
          if (delErr) console.error("unlike: anon-row merge delete failed:", delErr.message);
        }
      }
      // Pass mergeAnonId as the secondary identity: normally the anon row was
      // just deleted (so it adds nothing), but if a merge delete above failed it
      // catches the lingering row so `liked` still reflects reality.
      const state = await readState(client, target, liker!.likerId, mergeAnonId);
      return json(state);
    } catch (e) {
      return json({ error: (e as Error).message || "update failed" }, 500);
    }
  }

  return json({ error: "Method not allowed" }, 405);
}
