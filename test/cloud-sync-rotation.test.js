const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

test("cloud sync source includes device-session rotation and recovery", () => {
  const src = fs.readFileSync(
    path.join(process.cwd(), "dashboard/src/lib/cloud-sync.ts"),
    "utf8",
  );

  assert.match(src, /DEVICE_TOKEN_ROTATE_AFTER_MS\s*=\s*12 \* 60 \* 60 \* 1000/);
  assert.match(src, /function shouldRotateStoredDeviceSession/);
  assert.match(src, /issuedAtMs \+ DEVICE_TOKEN_ROTATE_AFTER_MS <= nowMs/);
  assert.match(src, /clearCloudDeviceSession\(\)/);
  assert.match(src, /await postLocalUsageSync/);
  assert.match(src, /runCloudUsageSyncNow[\s\S]*syncCloudUsageWithRecovery\(getAccessToken,\s*\{[\s\S]*drain:\s*true,[\s\S]*requireSync:\s*true,[\s\S]*\}\)/);
  assert.match(src, /Cloud sync requires a signed-in session/);
  assert.match(src, /Unable to prepare this device for cloud sync/);
});

test("local auth helper caches the per-process token in memory", async () => {
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, _init) => {
    calls.push(1);
    return new Response(JSON.stringify({ token: "local-token" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const mod = await import("../dashboard/src/lib/local-api-auth.ts");
    mod.clearLocalApiAuthToken();

    const first = await mod.getLocalApiAuthHeaders(globalThis.fetch);
    const second = await mod.getLocalApiAuthHeaders(globalThis.fetch);

    assert.deepEqual(first, { "x-tokentracker-local-auth": "local-token" });
    assert.deepEqual(second, { "x-tokentracker-local-auth": "local-token" });
    assert.equal(calls.length, 1);

    mod.clearLocalApiAuthToken();
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("cloud sync UI only switches to account view after successful drain", () => {
  const settings = fs.readFileSync(
    path.join(process.cwd(), "dashboard/src/components/settings/useAccountProfileSettings.js"),
    "utf8",
  );
  const settingsDrain = settings.indexOf("await runCloudUsageSyncNow(() => getAccessToken())");
  const settingsEnable = settings.indexOf("setCloudSyncEnabled(true)");
  assert.ok(settingsDrain >= 0, "settings toggle must run a cloud drain");
  assert.ok(settingsEnable > settingsDrain, "settings toggle must enable account view after drain");
  assert.ok(
    settings.indexOf("setCloudSyncEnabled(false)", settings.indexOf("catch (error)")) > settings.indexOf("catch (error)"),
    "settings toggle must roll back cloud-sync pref on drain failure",
  );

  const leaderboard = fs.readFileSync(
    path.join(process.cwd(), "dashboard/src/pages/LeaderboardPage.jsx"),
    "utf8",
  );
  const leaderboardDrain = leaderboard.indexOf("await runCloudUsageSyncNow(() => resolveAuthAccessTokenWithRetry(effectiveAuthToken))");
  const leaderboardEnable = leaderboard.indexOf("setCloudSyncEnabled(true)", leaderboardDrain);
  assert.ok(leaderboardDrain >= 0, "leaderboard CTA must run a cloud drain");
  assert.ok(leaderboardEnable > leaderboardDrain, "leaderboard CTA must enable account view after drain");
  assert.ok(
    leaderboard.indexOf("setCloudSyncEnabled(false)", leaderboard.indexOf("catch (e)")) > leaderboard.indexOf("catch (e)"),
    "leaderboard CTA must roll back cloud-sync pref on drain failure",
  );
});

test("dashboard account refresh runs cloud sync before refetching account data", () => {
  const src = fs.readFileSync(
    path.join(process.cwd(), "dashboard/src/pages/DashboardPage.jsx"),
    "utf8",
  );
  assert.ok(src.includes("if (accountView && effectiveAuthToken) {"));
  assert.ok(src.includes("await runCloudUsageSyncNow(() => resolveAuthAccessToken(effectiveAuthToken));"));
  assert.ok(src.includes("}, [accountView, effectiveAuthToken, isLocalMode, refreshAll]);"));
});
