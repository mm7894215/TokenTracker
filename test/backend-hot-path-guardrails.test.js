"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");
const readMigrationBySuffix = (suffix) => {
  const file = fs.readdirSync(path.join(ROOT, "migrations"))
    .find((name) => name.endsWith(`_${suffix}.sql`));
  assert.ok(file, `missing migration ending in _${suffix}.sql`);
  return read(`migrations/${file}`);
};

const ACCOUNT_FUNCTIONS = [
  "tokentracker-account-summary.ts",
  "tokentracker-account-daily.ts",
  "tokentracker-account-hourly.ts",
  "tokentracker-account-monthly.ts",
  "tokentracker-account-heatmap.ts",
  "tokentracker-account-model-breakdown.ts",
];

test("cloud account reads use the shared cached RPC instead of a device lookup plus aggregation", () => {
  for (const file of ACCOUNT_FUNCTIONS) {
    const source = read(`dashboard/edge-patches/${file}`);
    assert.match(source, /rpc\("account_usage_grouped_cached"/u,
      `${file} must use the cross-isolate cached RPC`);
    assert.doesNotMatch(
      source,
      /\.from\("tokentracker_devices"\)/u,
      `${file} must not spend a second PostgREST connection resolving devices`,
    );
    assert.match(source, /const groupedRowsInFlight = new Map/u,
      `${file} must coalesce identical concurrent RPC reads`);
    assert.match(source, /GROUPED_ROWS_TTL_MS = 30_000/u,
      `${file} must shield the backend from old-client polling storms`);
    assert.match(source, /GROUPED_ROWS_STALE_IF_ERROR_MS = 5 \* 60_000/u,
      `${file} must retain a bounded stale fallback for transient 5xx responses`);
  }
});

test("shared account cache is bounded, locked per key, and access controlled", () => {
  const source = read("migrations/20260718071507_add-shared-account-usage-cache.sql");
  assert.match(source, /CREATE UNLOGGED TABLE public\.tokentracker_account_usage_cache/u);
  assert.match(source, /CREATE OR REPLACE FUNCTION public\.account_usage_grouped_cached/u);
  assert.match(source, /interval '30 seconds'/u);
  assert.match(source, /pg_advisory_xact_lock\(hashtextextended\(v_cache_key, 0\)\)/u);
  assert.match(source, /public\.account_usage_grouped_v2\(/u);
  assert.match(source, /LIMIT 256/u);
  assert.match(source, /ENABLE ROW LEVEL SECURITY/u);
  assert.match(source, /REVOKE ALL ON public\.tokentracker_account_usage_cache FROM PUBLIC, anon, authenticated/u);
  assert.match(source, /REVOKE ALL ON FUNCTION public\.account_usage_grouped_cached/u);
});

test("shared account cache cleanup cannot deadlock concurrent cold fills", () => {
  const source = readMigrationBySuffix("harden-backend-concurrency");
  assert.match(
    source,
    /ORDER BY stale\.fetched_at, stale\.cache_key[\s\S]{0,80}FOR UPDATE SKIP LOCKED[\s\S]{0,80}LIMIT 256/u,
    "cleanup must lock stale rows in one deterministic, non-blocking order",
  );
  assert.match(
    source,
    /DELETE FROM public\.tokentracker_account_usage_cache AS c[\s\S]{0,160}USING stale/u,
    "cleanup must delete only the rows claimed by the skip-locked batch",
  );
});

test("leaderboard refresh fetches all user metadata with one RPC", () => {
  const source = read("dashboard/edge-patches/tokentracker-leaderboard-refresh.ts");
  assert.match(source, /rpc\("leaderboard_user_metadata"/u);
  assert.doesNotMatch(source, /const settingsResults = await Promise\.all/u);
  assert.doesNotMatch(source, /const profilesResults = await Promise\.all/u);
  assert.doesNotMatch(source, /const fallbackResults = await Promise\.all/u);
});

test("signed-in users cannot trigger expensive month, total, or all-period leaderboard refreshes", () => {
  const source = read("dashboard/edge-patches/tokentracker-leaderboard-refresh.ts");
  const clientSource = read("dashboard/src/lib/cloud-sync.ts");
  assert.match(source, /type RefreshAuthorization = "privileged" \| "signed-in";/u);
  assert.match(
    source,
    /if \(authorization === "signed-in" && body\.period !== "week"\)\s*return json\(\{ error: "signed-in users may only refresh week" \}, 403\);/u,
  );
  assert.match(clientSource, /body: JSON\.stringify\(\{ period: "week", source \}\)/u);
});

test("telemetry heartbeat uses one atomic database upsert RPC", () => {
  const source = read("dashboard/edge-patches/tokentracker-telemetry.ts");
  assert.match(source, /rpc\("upsert_tokentracker_telemetry_daily"/u);
  assert.doesNotMatch(source, /const \{ data: existingRows/u);
  assert.doesNotMatch(source, /\.from\(TABLE\)\.insert/u);
});

test("device creation absorbs concurrent unique-key races without database errors", () => {
  for (const file of ["tokentracker-device-token-issue.ts", "tokentracker-device-flow-poll.ts"]) {
    const source = read(`dashboard/edge-patches/${file}`);
    assert.match(
      source,
      /\.upsert\([\s\S]{0,180}machine_id: machineId[\s\S]{0,80}\{ ignoreDuplicates: true \}/u,
      `${file} must use INSERT ON CONFLICT DO NOTHING before selecting the winner`,
    );
    assert.doesNotMatch(source, /\.insert\([\s\S]{0,180}ignoreDuplicates/u);
  }
});

test("desktop auto refresh does not poll cloud account aggregates every 30 seconds", () => {
  const source = read("dashboard/src/pages/DashboardPage.jsx");
  assert.match(source, /if \(!isLocalMode \|\| mockEnabled \|\| accountView\) return undefined;/u);
});

test("backend hardening migration adds hot-path RPCs, index, and execute ACLs", () => {
  const source = read("migrations/20260717013000_harden-backend-hot-paths.sql");
  assert.match(source, /CREATE OR REPLACE FUNCTION public\.account_usage_grouped_v2/u);
  assert.match(source, /CREATE OR REPLACE FUNCTION public\.leaderboard_user_metadata/u);
  assert.match(source, /CREATE OR REPLACE FUNCTION public\.upsert_tokentracker_telemetry_daily/u);
  assert.match(source, /CREATE INDEX IF NOT EXISTS tokentracker_user_badges_badge_id_idx/u);
  assert.match(source, /REVOKE ALL ON FUNCTION public\.account_usage_grouped_v2/u);
  assert.match(source, /REVOKE ALL ON FUNCTION public\.leaderboard_user_metadata/u);
  assert.match(source, /REVOKE ALL ON FUNCTION public\.upsert_tokentracker_telemetry_daily/u);
});

test("unused direct profile-like table grants stay revoked", () => {
  const source = read("migrations/20260717015500_revoke-unused-profile-like-grants.sql");
  assert.match(
    source,
    /REVOKE ALL ON public\.tokentracker_profile_likes FROM anon, authenticated;/u,
  );
});
