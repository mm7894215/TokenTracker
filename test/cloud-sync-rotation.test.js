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
  assert.match(src, /export function shouldRotateStoredDeviceSession/);
  assert.match(src, /issuedAtMs \+ DEVICE_TOKEN_ROTATE_AFTER_MS <= nowMs/);
  assert.match(src, /clearCloudDeviceSession\(\)/);
  assert.match(src, /await postLocalUsageSync/);
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
