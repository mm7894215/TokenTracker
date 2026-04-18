const DEFAULT_BASE_URL = "https://srctyff5.us-east.insforge.app";
const DEFAULT_DASHBOARD_URL = "https://token.rynn.me";
const DEFAULT_HTTP_TIMEOUT_MS = 20_000;

function resolveRuntimeConfig({ cli = {}, config = {}, env = process.env, defaults = {} } = {}) {
  const baseUrl = pickString(
    cli.baseUrl,
    config.baseUrl,
    env?.TOKENTRACKER_INSFORGE_BASE_URL,
    defaults.baseUrl,
    DEFAULT_BASE_URL,
  );
  const dashboardUrl = pickString(
    cli.dashboardUrl,
    config.dashboardUrl,
    env?.TOKENTRACKER_DASHBOARD_URL,
    defaults.dashboardUrl,
    DEFAULT_DASHBOARD_URL,
  );
  const deviceToken = pickString(
    cli.deviceToken,
    config.deviceToken,
    env?.TOKENTRACKER_DEVICE_TOKEN,
    defaults.deviceToken,
    null,
  );
  const httpTimeoutMs = pickHttpTimeoutMs(
    cli.httpTimeoutMs,
    config.httpTimeoutMs,
    env?.TOKENTRACKER_HTTP_TIMEOUT_MS,
    defaults.httpTimeoutMs,
    DEFAULT_HTTP_TIMEOUT_MS,
  );
  const debug = pickBoolean(cli.debug, config.debug, env?.TOKENTRACKER_DEBUG, defaults.debug, false);
  const autoRetryNoSpawn = pickBoolean(
    cli.autoRetryNoSpawn,
    config.autoRetryNoSpawn,
    env?.TOKENTRACKER_AUTO_RETRY_NO_SPAWN,
    defaults.autoRetryNoSpawn,
    false,
  );

  return {
    baseUrl: baseUrl.value,
    dashboardUrl: dashboardUrl.value,
    deviceToken: deviceToken.value,
    httpTimeoutMs: httpTimeoutMs.value,
    debug: debug.value,
    autoRetryNoSpawn: autoRetryNoSpawn.value,
    sources: {
      baseUrl: baseUrl.source,
      dashboardUrl: dashboardUrl.source,
      deviceToken: deviceToken.source,
      httpTimeoutMs: httpTimeoutMs.source,
      debug: debug.source,
      autoRetryNoSpawn: autoRetryNoSpawn.source,
    },
  };
}

function pickString(...candidates) {
  return pickValue(candidates, normalizeString);
}

function pickBoolean(...candidates) {
  return pickValue(candidates, normalizeBoolean);
}

function pickHttpTimeoutMs(...candidates) {
  return pickValue(candidates, normalizeHttpTimeoutMs);
}

function pickValue(candidates, normalize) {
  const labels = ["cli", "config", "env", "default", "default"];
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
  DEFAULT_DASHBOARD_URL,
  DEFAULT_HTTP_TIMEOUT_MS,
  resolveRuntimeConfig,
};
