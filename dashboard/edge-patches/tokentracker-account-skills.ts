/**
 * InsForge Edge: publish and list per-device Skills inventories.
 *
 * Privacy: this endpoint accepts metadata only. It deliberately strips
 * description, SKILL.md content, prompts, readme URLs, and absolute paths before
 * storage. Remote devices therefore provide discovery/read-only visibility,
 * never remote filesystem access or remote mutation.
 */
import { createClient } from "npm:@insforge/sdk";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

const ALLOWED_TARGETS = new Set([
  "claude",
  "codex",
  "grok",
  "antigravity",
  "gemini",
  "opencode",
  "openclaw",
  "hermes",
  "zcode",
  "agents",
]);
const ALLOWED_SCOPES = new Set(["managed", "local", "system", "plugin"]);
const MAX_SKILLS = 2000;
const MAX_BODY_BYTES = 1_000_000;

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
  const secret = Deno.env.get("JWT_SECRET");
  const parts = token.split(".");
  if (!token || !secret || parts.length !== 3) return null;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      b64urlToBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1]))) as Record<string, unknown>;
    if (typeof payload.exp === "number" && Date.now() / 1000 > payload.exp) return null;
    if (typeof payload.sub === "string" && payload.sub) return payload.sub;
    if (typeof payload.user_id === "string" && payload.user_id) return payload.user_id;
  } catch { /* invalid token */ }
  return null;
}

function cleanText(value: unknown, max: number): string {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max)
    : "";
}

function cleanRelativePath(value: unknown, max = 300): string {
  const raw = cleanText(value, max).replace(/\\/g, "/");
  // Test absoluteness before trimming. Otherwise `/home/name/...` would become
  // `home/name/...` and leak a local path disguised as a relative directory.
  if (!raw || raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) return "";
  const parts = raw.replace(/\/+$/g, "").split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) return "";
  return parts.join("/");
}

function cleanStableKey(value: unknown): string {
  const key = cleanText(value, 400).replace(/\\/g, "/");
  if (!key || key.startsWith("/") || key.includes(":/") || /[A-Za-z]:\//.test(key)) return "";
  return key;
}

interface SkillInput {
  key?: unknown;
  name?: unknown;
  directory?: unknown;
  targets?: unknown;
  managed?: unknown;
  readOnly?: unknown;
  scope?: unknown;
  sourceName?: unknown;
}

interface StoredSkill {
  key: string;
  name: string;
  directory: string;
  targets: string[];
  managed: boolean;
  readOnly: boolean;
  scope: string;
  sourceName?: string;
}

function sanitizeSkill(input: SkillInput): StoredSkill | null {
  const directory = cleanRelativePath(input?.directory);
  const key = cleanStableKey(input?.key);
  if (!directory || !key) return null;
  const targets = Array.isArray(input?.targets)
    ? [...new Set(input.targets.map((target) => cleanText(target, 40)).filter((target) => ALLOWED_TARGETS.has(target)))].slice(0, 16)
    : [];
  const scopeInput = cleanText(input?.scope, 24);
  const scope = ALLOWED_SCOPES.has(scopeInput)
    ? scopeInput
    : input?.managed === true
      ? "managed"
      : "local";
  const sourceName = cleanRelativePath(input?.sourceName, 180);
  return {
    key,
    name: cleanText(input?.name, 180) || directory.split("/").pop() || "Skill",
    directory,
    targets,
    managed: input?.managed === true,
    readOnly: input?.readOnly === true,
    scope,
    ...(sourceName ? { sourceName } : {}),
  };
}

interface DeviceRow {
  id: string;
  device_name: string | null;
  platform: string | null;
  created_at: string | null;
}

interface InventoryRow {
  device_id: string;
  skills: StoredSkill[] | null;
  scanned_at: string | null;
}

export default async function (req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "GET" && req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const baseUrl = Deno.env.get("INSFORGE_BASE_URL");
  const serviceRoleKey = Deno.env.get("INSFORGE_SERVICE_ROLE_KEY");
  if (!baseUrl || !serviceRoleKey) return json({ error: "server misconfigured" }, 500);
  const incomingApiKey =
    req.headers.get("apikey") ?? req.headers.get("Apikey") ?? req.headers.get("x-api-key") ?? undefined;
  const anonKey = Deno.env.get("INSFORGE_ANON_KEY") ?? Deno.env.get("ANON_KEY") ?? incomingApiKey;
  const client = createClient({
    baseUrl,
    edgeFunctionToken: serviceRoleKey,
    anonKey,
    ...(anonKey ? { headers: { apikey: anonKey } } : {}),
  });

  const userId = await verifiedUserIdFromJwt(req.headers.get("Authorization"));
  if (!userId) return json({ error: "Unauthorized" }, 401);

  if (req.method === "POST") {
    const raw = await req.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return json({ error: "Inventory too large" }, 413);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }
    const deviceId = cleanText(body.device_id, 80);
    if (!deviceId || !Array.isArray(body.skills) || body.skills.length > MAX_SKILLS) {
      return json({ error: "Invalid inventory" }, 400);
    }

    const { data: owned, error: deviceError } = await client.database
      .from("tokentracker_devices")
      .select("id")
      .eq("id", deviceId)
      .eq("user_id", userId)
      .is("revoked_at", null)
      .limit(1);
    if (deviceError) return json({ error: deviceError.message }, 500);
    if (!Array.isArray(owned) || owned.length !== 1) return json({ error: "Device not found" }, 404);

    const skills = (body.skills as SkillInput[]).map(sanitizeSkill).filter((item): item is StoredSkill => Boolean(item));
    const now = new Date().toISOString();
    const { error } = await client.database
      .from("tokentracker_device_skill_inventories")
      .upsert([{
        user_id: userId,
        device_id: deviceId,
        skills,
        scanned_at: now,
        updated_at: now,
      }], { onConflict: "user_id,device_id" });
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, device_id: deviceId, count: skills.length, scanned_at: now });
  }

  const [{ data: deviceData, error: deviceError }, { data: inventoryData, error: inventoryError }] = await Promise.all([
    client.database
      .from("tokentracker_devices")
      .select("id, device_name, platform, created_at")
      .eq("user_id", userId)
      .is("revoked_at", null),
    client.database
      .from("tokentracker_device_skill_inventories")
      .select("device_id, skills, scanned_at")
      .eq("user_id", userId),
  ]);
  if (deviceError || inventoryError) return json({ error: deviceError?.message || inventoryError?.message }, 500);

  const inventories = new Map(
    ((inventoryData ?? []) as InventoryRow[]).map((row) => [row.device_id, row]),
  );
  const devices = ((deviceData ?? []) as DeviceRow[])
    .map((device) => {
      const inventory = inventories.get(device.id);
      return {
        ...device,
        skills: Array.isArray(inventory?.skills) ? inventory.skills : [],
        scanned_at: inventory?.scanned_at || null,
      };
    })
    .sort((a, b) => String(a.device_name || "").localeCompare(String(b.device_name || "")));
  return json({ devices });
}
