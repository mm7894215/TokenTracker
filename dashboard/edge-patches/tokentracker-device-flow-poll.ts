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
async function issueDeviceToken(client: any, userId: string, clientInfo: string | null, machineId: string | null) {
  const platform = "cli-device-flow";
  // The machine-id suffix keeps display names unique per machine: two Macs on
  // the default "MacBook-Pro.local" hostname used to collapse into ONE device
  // (the name-keyed unique index), overwriting each other's hourly rows and
  // revoking each other's tokens on every login.
  const deviceName = `TokenTracker CLI${clientInfo ? ` (${clientInfo})` : ""}${machineId ? ` #${machineId.slice(0, 8)}` : ""}`.slice(0, 128);

  // Device identity resolution — same machine-anchored scheme as
  // tokentracker-device-token-issue.ts: (1) reuse by (user, machine_id),
  // (2) adopt a legacy same-name row by backfilling machine_id, (3) insert,
  // falling back to re-select on a unique-violation race. Legacy CLIs that
  // send no machine_id keep the old name-keyed path.
  let deviceId: string | null = null;

  if (machineId) {
    const { data: byMachine } = await client.database
      .from("tokentracker_devices")
      .select("id")
      .eq("user_id", userId)
      .eq("machine_id", machineId)
      .is("revoked_at", null)
      .limit(1)
      .maybeSingle();
    if (byMachine && (byMachine as { id: string }).id) {
      const row = byMachine as { id: string };
      deviceId = row.id;
      // Refresh the client default and converge a matching machine_id-less
      // legacy row in one database transaction. The RPC preserves custom
      // names, canonicalizes duplicate hourly snapshots, moves old tokens,
      // and absorbs a concurrent unique-name race without logging a 23505.
      const { error: refreshErr } = await client.database.rpc(
        "refresh_tokentracker_device_identity",
        {
          p_user_id: userId,
          p_device_id: deviceId,
          p_device_name: deviceName,
          p_platform: platform,
        },
      );
      if (refreshErr) {
        // The machine_id match remains authoritative; keep login available and
        // leave a structured runtime signal for a transient database failure.
        console.error("device identity refresh failed", refreshErr.message);
      }
    }

    if (!deviceId) {
      // Adoption tries the new suffixed name first, then the PRE-UPGRADE
      // suffix-less name (`TokenTracker CLI (darwin-arm64 host)`) — every
      // CLI device minted before the machine-id rollout has the latter, and
      // without this fallback an upgrade re-login would orphan the old row
      // and mint a second device (hot buckets re-emitted across the switch
      // would then mirror). If two same-hostname machines shared one legacy
      // row, the first to upgrade claims it; the second falls through to a
      // fresh anchored device — counting stays correct either way because
      // rows never move or duplicate.
      const legacyBareName = `TokenTracker CLI${clientInfo ? ` (${clientInfo})` : ""}`.slice(0, 128);
      const { data: legacyRows } = await client.database
        .from("tokentracker_devices")
        .select("id, device_name, name_customized")
        .eq("user_id", userId)
        .eq("platform", platform)
        .in("device_name", [deviceName, legacyBareName])
        .is("revoked_at", null)
        .is("machine_id", null)
        .order("created_at", { ascending: true });
      let candidates = Array.isArray(legacyRows)
        ? (legacyRows as Array<{ id: string; device_name: string; name_customized?: boolean }>)
        : [];
      if (candidates.length === 0) {
        // A renamed legacy row matches no client default by device_name; the
        // rename endpoint preserved its pre-rename default in
        // default_device_name — match that as a fallback, with the exact same
        // (user, platform, active, machine_id IS NULL) scope, so a rename
        // doesn't leave the row un-adoptable and split off a fresh device.
        const { data: renamedRows } = await client.database
          .from("tokentracker_devices")
          .select("id, device_name, name_customized")
          .eq("user_id", userId)
          .eq("platform", platform)
          .in("default_device_name", [deviceName, legacyBareName])
          .is("revoked_at", null)
          .is("machine_id", null)
          .order("created_at", { ascending: true });
        candidates = Array.isArray(renamedRows)
          ? (renamedRows as Array<{ id: string; device_name: string; name_customized?: boolean }>)
          : [];
      }
      // Prefer an exact new-name match, then the bare legacy name.
      const ordered = [
        ...candidates.filter((r) => r.device_name === deviceName),
        ...candidates.filter((r) => r.device_name !== deviceName),
      ];
      for (const candidate of ordered) {
        const { error: adoptErr } = await client.database
          .from("tokentracker_devices")
          .update(candidate.name_customized
            ? { machine_id: machineId }
            : { machine_id: machineId, device_name: deviceName })
          .eq("id", candidate.id)
          .is("machine_id", null);
        if (!adoptErr) {
          deviceId = candidate.id;
          break;
        }
      }
    }

    if (!deviceId) {
      const newDeviceId = crypto.randomUUID();
      const { data: inserted, error: insErr } = await client.database
        .from("tokentracker_devices")
        .upsert(
          [{ id: newDeviceId, user_id: userId, device_name: deviceName, platform, machine_id: machineId }],
          { ignoreDuplicates: true },
        )
        .select("id");
      if (!insErr && Array.isArray(inserted) && inserted.length > 0) {
        deviceId = (inserted[0] as { id: string }).id;
      } else {
        const { data: winner } = await client.database
          .from("tokentracker_devices")
          .select("id")
          .eq("user_id", userId)
          .eq("machine_id", machineId)
          .is("revoked_at", null)
          .limit(1)
          .maybeSingle();
        if (!winner || !(winner as { id: string }).id) {
          throw new Error(insErr?.message || "device resolution failed");
        }
        deviceId = (winner as { id: string }).id;
      }
    }
  } else {
    const newDeviceId = crypto.randomUUID();
    const { data: insertedDevice } = await client.database
      .from("tokentracker_devices")
      .upsert([{ id: newDeviceId, user_id: userId, device_name: deviceName, platform }], {
        ignoreDuplicates: true,
      })
      .select("id");

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
  if (!serviceRoleKey) return json({ error: "misconfigured" }, 500);

  const client = createClient({
    baseUrl,
    edgeFunctionToken: serviceRoleKey,
    anonKey,
    ...(anonKey ? { headers: { apikey: anonKey } } : {}),
  });

  const { data, error } = await client.database
    .from("tokentracker_device_codes")
    .select("device_code, user_id, status, expires_at, approved_at, client_info, machine_id")
    .eq("device_code", deviceCode)
    .maybeSingle();

  if (error) {
    // Log internals server-side only — this is a public endpoint and error
    // messages can leak schema/infrastructure details.
    console.error("[device-flow-poll] db error:", String(error?.message ?? error));
    return json({ error: "db error" }, 502);
  }
  if (!data) return json({ status: "unknown" }, 404);

  const row = data as { user_id: string | null; status: string; expires_at: string; client_info: string | null; machine_id: string | null };
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
      const issued = await issueDeviceToken(client, row.user_id, row.client_info, row.machine_id);
      return json({
        status: "approved",
        user_id: row.user_id,
        device_token: issued.token,
        device_id: issued.deviceId,
      });
    } catch (e) {
      console.error("[device-flow-poll] issue failed:", String((e as Error)?.message ?? e));
      return json({ error: "Failed to issue device token" }, 500);
    }
  }
  return json({ status: "pending" });
}
