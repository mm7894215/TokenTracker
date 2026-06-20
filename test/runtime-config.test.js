const assert = require("node:assert/strict");
const { test } = require("node:test");

const { resolveRuntimeConfig } = require("../src/lib/runtime-config");

test("resolveRuntimeConfig prefers CLI flags over config and env", () => {
  const config = { baseUrl: "https://config.example", deviceToken: "cfg" };
  const result = resolveRuntimeConfig({
    cli: { baseUrl: "https://cli.example" },
    config,
    env: { TOKENTRACKER_DEVICE_TOKEN: "env" },
  });

  assert.equal(result.baseUrl, "https://cli.example");
  assert.equal(result.deviceToken, "cfg");
  assert.equal(result.sources.baseUrl, "cli");
  assert.equal(result.sources.deviceToken, "config");
});

test("resolveRuntimeConfig can let env override config for sync subprocesses", () => {
  const result = resolveRuntimeConfig({
    config: { baseUrl: "https://config.example", deviceToken: "cfg" },
    env: {
      TOKENTRACKER_INSFORGE_BASE_URL: "https://env.example",
      TOKENTRACKER_DEVICE_TOKEN: "env",
    },
    envOverridesConfig: true,
  });

  assert.equal(result.baseUrl, "https://env.example");
  assert.equal(result.deviceToken, "env");
  assert.equal(result.sources.baseUrl, "env");
  assert.equal(result.sources.deviceToken, "env");
});

test("resolveRuntimeConfig ignores non-TOKENTRACKER env inputs", () => {
  const result = resolveRuntimeConfig({
    env: {
      LEGACY_BASE_URL: "https://legacy.example",
      LEGACY_DEVICE_TOKEN: "legacy",
    },
  });

  assert.equal(result.deviceToken, null);
  assert.equal(result.sources.deviceToken, "default");
});

test("resolveRuntimeConfig normalizes timeout and flags", () => {
  const result = resolveRuntimeConfig({
    env: {
      TOKENTRACKER_HTTP_TIMEOUT_MS: "500",
      TOKENTRACKER_DEBUG: "1",
      TOKENTRACKER_AUTO_RETRY_NO_SPAWN: "1",
    },
  });

  assert.equal(result.httpTimeoutMs, 1000);
  assert.equal(result.debug, true);
  assert.equal(result.autoRetryNoSpawn, true);
});
