const DEFAULT_BASE_URL = "https://srctyff5.us-east.insforge.app";
const DEFAULT_DASHBOARD_URL = "https://www.tokentracker.cc";
const DEFAULT_HTTP_TIMEOUT_MS = 20_000;
// Public InsForge anon key (JWT, role=anon). Mirrors dashboard/src/lib/insforge-config.ts
// (PROD_INSFORGE_ANON_KEY) — public by design (ships in the browser bundle and
// appears in .github/workflows/*.yml). The local server needs it to call the
// cross-device `tokentracker-account-*` edge functions on the popover's behalf.
// (Previously this mistakenly used the full-access `ik_*` API key, which has
// admin access and must never be shipped to clients.)
const DEFAULT_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3OC0xMjM0LTU2NzgtOTBhYi1jZGVmMTIzNDU2NzgiLCJlbWFpbCI6ImFub25AaW5zZm9yZ2UuY29tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNDU5NDd9.T0auta_IrVIh0uXW1bob5QSnzvsnJmN28r5XkSGEuQY";

function resolveRuntimeConfig({
  cli = {},
  config = {},
  env = process.env,
  defaults = {},
  envOverridesConfig = false,
} = {}) {
  const baseUrl = pickRuntimeValue({
    cliValue: cli.baseUrl,
    configValue: config.baseUrl,
    envValue: env?.TOKENTRACKER_INSFORGE_BASE_URL,
    defaultValue: defaults.baseUrl,
    hardDefaultValue: DEFAULT_BASE_URL,
    normalize: normalizeString,
    envOverridesConfig,
  });
  const anonKey = pickRuntimeValue({
    cliValue: cli.anonKey,
    configValue: config.anonKey,
    envValue: env?.TOKENTRACKER_INSFORGE_ANON_KEY,
    defaultValue: defaults.anonKey,
    hardDefaultValue: DEFAULT_ANON_KEY,
    normalize: normalizeString,
    envOverridesConfig,
  });
  const dashboardUrl = pickRuntimeValue({
    cliValue: cli.dashboardUrl,
    configValue: config.dashboardUrl,
    envValue: env?.TOKENTRACKER_DASHBOARD_URL,
    defaultValue: defaults.dashboardUrl,
    hardDefaultValue: DEFAULT_DASHBOARD_URL,
    normalize: normalizeString,
    envOverridesConfig,
  });
  const deviceToken = pickRuntimeValue({
    cliValue: cli.deviceToken,
    configValue: config.deviceToken,
    envValue: env?.TOKENTRACKER_DEVICE_TOKEN,
    defaultValue: defaults.deviceToken,
    hardDefaultValue: null,
    normalize: normalizeString,
    envOverridesConfig,
  });
  const httpTimeoutMs = pickRuntimeValue({
    cliValue: cli.httpTimeoutMs,
    configValue: config.httpTimeoutMs,
    envValue: env?.TOKENTRACKER_HTTP_TIMEOUT_MS,
    defaultValue: defaults.httpTimeoutMs,
    hardDefaultValue: DEFAULT_HTTP_TIMEOUT_MS,
    normalize: normalizeHttpTimeoutMs,
    envOverridesConfig,
  });
  const debug = pickRuntimeValue({
    cliValue: cli.debug,
    configValue: config.debug,
    envValue: env?.TOKENTRACKER_DEBUG,
    defaultValue: defaults.debug,
    hardDefaultValue: false,
    normalize: normalizeBoolean,
    envOverridesConfig,
  });
  const autoRetryNoSpawn = pickRuntimeValue({
    cliValue: cli.autoRetryNoSpawn,
    configValue: config.autoRetryNoSpawn,
    envValue: env?.TOKENTRACKER_AUTO_RETRY_NO_SPAWN,
    defaultValue: defaults.autoRetryNoSpawn,
    hardDefaultValue: false,
    normalize: normalizeBoolean,
    envOverridesConfig,
  });

  return {
    baseUrl: baseUrl.value,
    anonKey: anonKey.value,
    dashboardUrl: dashboardUrl.value,
    deviceToken: deviceToken.value,
    httpTimeoutMs: httpTimeoutMs.value,
    debug: debug.value,
    autoRetryNoSpawn: autoRetryNoSpawn.value,
    sources: {
      baseUrl: baseUrl.source,
      anonKey: anonKey.source,
      dashboardUrl: dashboardUrl.source,
      deviceToken: deviceToken.source,
      httpTimeoutMs: httpTimeoutMs.source,
      debug: debug.source,
      autoRetryNoSpawn: autoRetryNoSpawn.source,
    },
  };
}

function pickRuntimeValue({
  cliValue,
  configValue,
  envValue,
  defaultValue,
  hardDefaultValue,
  normalize,
  envOverridesConfig,
}) {
  const middleValues = envOverridesConfig
    ? [envValue, configValue]
    : [configValue, envValue];
  const middleLabels = envOverridesConfig
    ? ["env", "config"]
    : ["config", "env"];
  return pickValue(
    [cliValue, ...middleValues, defaultValue, hardDefaultValue],
    normalize,
    ["cli", ...middleLabels, "default", "default"],
  );
}

function pickValue(candidates, normalize, labels) {
  for (let i = 0; i < candidates.length; i += 1) {
    const value = normalize(candidates[i]);
    if (value !== undefined) {
      return { value, source: labels[i] || "default" };
    }
  }
  return { value: null, source: "default" };
}

function normalizeString(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

function normalizeBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) return undefined;
    if (trimmed === "1" || trimmed === "true") return true;
    if (trimmed === "0" || trimmed === "false") return false;
  }
  return undefined;
}

function normalizeHttpTimeoutMs(value) {
  if (value == null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  if (n <= 0) return 0;
  return clampInt(n, 1000, 120_000);
}

function clampInt(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_ANON_KEY,
  DEFAULT_DASHBOARD_URL,
  DEFAULT_HTTP_TIMEOUT_MS,
  resolveRuntimeConfig,
};
