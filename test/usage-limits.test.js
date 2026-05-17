const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  extractGeminiOauthClientCredentials,
  getUsageLimits,
  loadKimiCredentials,
  normalizeCursorUsageSummary,
  normalizeGeminiQuotaResponse,
  normalizeKimiUsageResponse,
  parseKiroUsageOutput,
  resetUsageLimitsCache,
  normalizeAntigravityResponse,
  parseListeningPorts,
  detectAntigravityProcess,
} = require("../src/lib/usage-limits");

describe("extractGeminiOauthClientCredentials", () => {
  it("finds OAuth constants from bundled Gemini CLI chunk files", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-gemini-bundle-"));
    try {
      const root = path.join(tmp, "lib", "node_modules", "@google", "gemini-cli");
      const bundleDir = path.join(root, "bundle");
      fs.mkdirSync(bundleDir, { recursive: true });
      const geminiPath = path.join(bundleDir, "gemini.js");
      fs.writeFileSync(geminiPath, "#!/usr/bin/env node\n", "utf8");
      fs.writeFileSync(
        path.join(bundleDir, "chunk-test.js"),
        [
          'var OAUTH_CLIENT_ID = "client.apps.googleusercontent.com";',
          'var OAUTH_CLIENT_SECRET = "secret-value";',
        ].join("\n"),
        "utf8",
      );

      const result = extractGeminiOauthClientCredentials({
        commandRunner(command, args) {
          assert.equal(command, "which");
          assert.deepEqual(args, ["gemini"]);
          return { status: 0, stdout: `${geminiPath}\n` };
        },
      });

      assert.deepEqual(result, {
        clientId: "client.apps.googleusercontent.com",
        clientSecret: "secret-value",
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("falls back to nvm-installed Gemini when launchd PATH cannot find gemini", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-gemini-nvm-"));
    try {
      const home = path.join(tmp, "home");
      const root = path.join(home, ".nvm", "versions", "node", "v22.21.1");
      const binDir = path.join(root, "bin");
      const bundleDir = path.join(root, "lib", "node_modules", "@google", "gemini-cli", "bundle");
      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(bundleDir, { recursive: true });
      const geminiTarget = path.join(bundleDir, "gemini.js");
      const geminiLink = path.join(binDir, "gemini");
      fs.writeFileSync(geminiTarget, "#!/usr/bin/env node\n", "utf8");
      fs.symlinkSync("../lib/node_modules/@google/gemini-cli/bundle/gemini.js", geminiLink);
      fs.writeFileSync(
        path.join(bundleDir, "chunk-test.js"),
        [
          'var OAUTH_CLIENT_ID = "fallback-client.apps.googleusercontent.com";',
          'var OAUTH_CLIENT_SECRET = "fallback-secret";',
        ].join("\n"),
        "utf8",
      );

      const result = extractGeminiOauthClientCredentials({
        home,
        commandRunner() {
          return { status: 1, stdout: "" };
        },
      });

      assert.deepEqual(result, {
        clientId: "fallback-client.apps.googleusercontent.com",
        clientSecret: "fallback-secret",
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

function makeFakeCodexJwt(planType) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_plan_type: planType },
    }),
  ).toString("base64url");
  return `${header}.${payload}.`;
}

describe("getUsageLimits", () => {
  it("classifies a 5h session window into primary regardless of slot position", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-codex-classify-"));
    try {
      const codexHome = path.join(tmp, ".codex");
      fs.mkdirSync(codexHome, { recursive: true });
      fs.writeFileSync(
        path.join(codexHome, "auth.json"),
        JSON.stringify({
          tokens: {
            access_token: makeFakeCodexJwt("plus"),
            id_token: makeFakeCodexJwt("plus"),
            account_id: "acc-classify",
          },
        }),
      );

      let observedHeader = null;
      const result = await getUsageLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: 2000,
        securityRunner() {
          return { status: 1, stdout: "" };
        },
        commandRunner() {
          return { status: 1, stdout: "" };
        },
        fetchImpl(url, opts) {
          if (typeof url === "string" && url.includes("chatgpt.com/backend-api/wham/usage")) {
            observedHeader = opts?.headers?.["ChatGPT-Account-Id"] || null;
            return Promise.resolve({
              ok: true,
              status: 200,
              // API delivers 7d in primary slot and 5h in secondary — sorter must swap them.
              json: async () => ({
                rate_limit: {
                  primary_window: { used_percent: 30, limit_window_seconds: 604800, reset_at: 99999 },
                  secondary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: 11111 },
                },
              }),
            });
          }
          return new Promise(() => {});
        },
      });

      assert.equal(observedHeader, "acc-classify", "ChatGPT-Account-Id header must be sent");
      assert.equal(result.codex.configured, true);
      assert.equal(result.codex.error, null);
      assert.equal(result.codex.plan_type, "plus");
      assert.deepEqual(result.codex.primary_window, {
        used_percent: 12,
        limit_window_seconds: 18000,
        reset_at: 11111,
      });
      assert.deepEqual(result.codex.secondary_window, {
        used_percent: 30,
        limit_window_seconds: 604800,
        reset_at: 99999,
      });
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("renders free-tier weekly-only response into the secondary (7d) lane", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-codex-free-weekly-"));
    try {
      const codexHome = path.join(tmp, ".codex");
      fs.mkdirSync(codexHome, { recursive: true });
      fs.writeFileSync(
        path.join(codexHome, "auth.json"),
        JSON.stringify({
          tokens: {
            access_token: makeFakeCodexJwt("free"),
            id_token: makeFakeCodexJwt("free"),
          },
        }),
      );

      const result = await getUsageLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: 2000,
        securityRunner() {
          return { status: 1, stdout: "" };
        },
        commandRunner() {
          return { status: 1, stdout: "" };
        },
        fetchImpl(url) {
          if (typeof url === "string" && url.includes("chatgpt.com/backend-api/wham/usage")) {
            // Free plans get a single 7-day window in the primary slot.
            return Promise.resolve({
              ok: true,
              status: 200,
              json: async () => ({
                rate_limit: {
                  primary_window: { used_percent: 8, limit_window_seconds: 604800, reset_at: 42 },
                  secondary_window: null,
                },
              }),
            });
          }
          return new Promise(() => {});
        },
      });

      assert.equal(result.codex.configured, true);
      assert.equal(result.codex.error, null);
      assert.equal(result.codex.plan_type, "free");
      // No 5h session window for free — primary lane stays empty, weekly fills secondary.
      assert.equal(result.codex.primary_window, null);
      assert.deepEqual(result.codex.secondary_window, {
        used_percent: 8,
        limit_window_seconds: 604800,
        reset_at: 42,
      });
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("proactively refreshes a stale Codex token and persists the new one before calling wham", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-codex-refresh-"));
    try {
      const codexHome = path.join(tmp, ".codex");
      fs.mkdirSync(codexHome, { recursive: true });
      const authPath = path.join(codexHome, "auth.json");
      // Write an auth.json whose last_refresh is >8 days old → must be refreshed.
      fs.writeFileSync(
        authPath,
        JSON.stringify({
          auth_mode: "chatgpt",
          tokens: {
            access_token: makeFakeCodexJwt("plus"),
            id_token: makeFakeCodexJwt("plus"),
            refresh_token: "rt-stale",
            account_id: "acc-stale",
          },
          last_refresh: "2026-01-01T00:00:00Z",
        }),
      );

      let refreshCalled = false;
      let whamAuthHeader = null;
      const result = await getUsageLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: 2000,
        securityRunner() {
          return { status: 1, stdout: "" };
        },
        commandRunner() {
          return { status: 1, stdout: "" };
        },
        fetchImpl(url, opts) {
          if (typeof url === "string" && url.includes("auth.openai.com/oauth/token")) {
            refreshCalled = true;
            return Promise.resolve({
              ok: true,
              status: 200,
              json: async () => ({
                access_token: "fresh-access",
                refresh_token: "fresh-refresh",
                id_token: "fresh-id",
              }),
            });
          }
          if (typeof url === "string" && url.includes("chatgpt.com/backend-api/wham/usage")) {
            whamAuthHeader = opts?.headers?.Authorization || null;
            return Promise.resolve({
              ok: true,
              status: 200,
              json: async () => ({
                rate_limit: {
                  primary_window: { used_percent: 1, limit_window_seconds: 18000, reset_at: 100 },
                  secondary_window: { used_percent: 9, limit_window_seconds: 604800, reset_at: 200 },
                },
              }),
            });
          }
          return new Promise(() => {});
        },
      });

      assert.equal(refreshCalled, true, "refresh endpoint must be called when token is stale");
      assert.equal(whamAuthHeader, "Bearer fresh-access", "wham must use the new token");
      assert.equal(result.codex.configured, true);
      assert.equal(result.codex.error, null);
      assert.deepEqual(result.codex.primary_window, { used_percent: 1, limit_window_seconds: 18000, reset_at: 100 });

      // Persisted auth.json gets the new tokens + a fresh last_refresh.
      const updated = JSON.parse(fs.readFileSync(authPath, "utf8"));
      assert.equal(updated.tokens.access_token, "fresh-access");
      assert.equal(updated.tokens.refresh_token, "fresh-refresh");
      assert.notEqual(updated.last_refresh, "2026-01-01T00:00:00Z");
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("surfaces a reauth-required error when the refresh token itself is expired", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-codex-reauth-"));
    try {
      const codexHome = path.join(tmp, ".codex");
      fs.mkdirSync(codexHome, { recursive: true });
      fs.writeFileSync(
        path.join(codexHome, "auth.json"),
        JSON.stringify({
          tokens: {
            access_token: makeFakeCodexJwt("plus"),
            refresh_token: "rt-dead",
          },
          last_refresh: "2026-01-01T00:00:00Z",
        }),
      );

      const result = await getUsageLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: 2000,
        securityRunner() {
          return { status: 1, stdout: "" };
        },
        commandRunner() {
          return { status: 1, stdout: "" };
        },
        fetchImpl(url) {
          if (typeof url === "string" && url.includes("auth.openai.com/oauth/token")) {
            return Promise.resolve({
              ok: false,
              status: 401,
              json: async () => ({ error: { code: "refresh_token_expired" } }),
            });
          }
          return new Promise(() => {});
        },
      });

      assert.equal(result.codex.configured, true);
      assert.equal(result.codex.auth_action_required, "reauth");
      assert.match(result.codex.error, /Run `codex` to re-authenticate/);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("treats wham 403 (free / unauthorized) as no-data instead of a hard error", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-codex-403-"));
    try {
      const codexHome = path.join(tmp, ".codex");
      fs.mkdirSync(codexHome, { recursive: true });
      fs.writeFileSync(
        path.join(codexHome, "auth.json"),
        JSON.stringify({ tokens: { access_token: "opaque-token" } }),
      );

      const result = await getUsageLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: 1000,
        securityRunner() {
          return { status: 1, stdout: "" };
        },
        commandRunner() {
          return { status: 1, stdout: "" };
        },
        fetchImpl(url) {
          if (typeof url === "string" && url.includes("chatgpt.com/backend-api/wham/usage")) {
            return Promise.resolve({ ok: false, status: 403, json: async () => ({}) });
          }
          return new Promise(() => {});
        },
      });

      assert.equal(result.codex.configured, true);
      assert.equal(result.codex.error, null);
      assert.equal(result.codex.primary_window, null);
      assert.equal(result.codex.secondary_window, null);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not block the whole response when Claude usage hangs", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-timeout-"));
    try {
      const started = Date.now();
      const result = await getUsageLimits({
        home: tmp,
        platform: "darwin",
        providerTimeoutMs: 10,
        securityRunner() {
          return {
            status: 0,
            stdout: JSON.stringify({ claudeAiOauth: { accessToken: "claude-token" } }),
          };
        },
        commandRunner(command) {
          if (command === "/bin/ps") return { status: 1, stdout: "" };
          return { status: 1, stdout: "" };
        },
        fetchImpl() {
          return new Promise(() => {});
        },
      });

      assert.ok(Date.now() - started < 500);
      assert.equal(result.claude.configured, true);
      assert.match(result.claude.error, /Claude usage request timed out/);
      assert.equal(result.codex.configured, false);
      assert.equal(result.gemini.configured, false);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not wait for Claude 429 retry delays on limits page refresh", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-429-"));
    try {
      let calls = 0;
      const result = await getUsageLimits({
        home: tmp,
        platform: "darwin",
        providerTimeoutMs: 1000,
        securityRunner() {
          return {
            status: 0,
            stdout: JSON.stringify({ claudeAiOauth: { accessToken: "claude-token" } }),
          };
        },
        commandRunner() {
          return { status: 1, stdout: "" };
        },
        fetchImpl() {
          calls += 1;
          return Promise.resolve({
            status: 429,
            ok: false,
            headers: { get: () => "30" },
          });
        },
      });

      assert.equal(calls, 1);
      assert.equal(result.claude.configured, true);
      assert.match(result.claude.error, /rate limited/);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not block the whole response when Kimi usage hangs", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-kimi-timeout-"));
    try {
      const kimiHome = path.join(tmp, ".kimi");
      fs.mkdirSync(path.join(kimiHome, "credentials"), { recursive: true });
      fs.writeFileSync(path.join(kimiHome, "config.toml"), 'default_model = "kimi-code/kimi-for-coding"\n');
      fs.writeFileSync(
        path.join(kimiHome, "credentials", "kimi-code.json"),
        JSON.stringify({ access_token: "kimi-token" }),
      );

      const started = Date.now();
      const result = await getUsageLimits({
        home: tmp,
        platform: "darwin",
        providerTimeoutMs: 10,
        securityRunner() {
          return { status: 1, stdout: "" };
        },
        commandRunner() {
          return { status: 1, stdout: "" };
        },
        fetchImpl() {
          return new Promise(() => {});
        },
      });

      assert.ok(Date.now() - started < 500);
      assert.equal(result.kimi.configured, true);
      assert.match(result.kimi.error, /Kimi usage request timed out/);
      assert.equal(result.claude.configured, false);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refreshes expired Kimi credentials before fetching usage limits", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-kimi-refresh-"));
    try {
      const kimiHome = path.join(tmp, ".kimi");
      const credsPath = path.join(kimiHome, "credentials", "kimi-code.json");
      fs.mkdirSync(path.dirname(credsPath), { recursive: true });
      fs.writeFileSync(path.join(kimiHome, "config.toml"), 'default_model = "kimi-code/kimi-for-coding"\n');
      fs.writeFileSync(
        credsPath,
        JSON.stringify({
          access_token: "expired-kimi-token",
          refresh_token: "refresh-kimi-token",
          expires_at: 1,
          scope: "kimi-code",
          token_type: "Bearer",
          expires_in: 900,
        }),
      );

      const calls = [];
      const result = await getUsageLimits({
        home: tmp,
        platform: "darwin",
        securityRunner() {
          return { status: 1, stdout: "" };
        },
        commandRunner() {
          return { status: 1, stdout: "" };
        },
        fetchImpl(url, options = {}) {
          calls.push({ url, authorization: options.headers?.Authorization || null, body: String(options.body || "") });
          if (url === "https://auth.kimi.com/api/oauth/token") {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: async () => ({
                access_token: "fresh-kimi-token",
                refresh_token: "fresh-refresh-token",
                expires_in: 900,
                scope: "kimi-code",
                token_type: "Bearer",
              }),
            });
          }
          if (url === "https://api.kimi.com/coding/v1/usages") {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: async () => ({
                usage: { used: 4, limit: 10, resetTime: "2026-05-04T06:02:56.054Z" },
              }),
            });
          }
          return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
        },
      });

      assert.equal(calls[0].url, "https://auth.kimi.com/api/oauth/token");
      assert.match(calls[0].body, /grant_type=refresh_token/);
      assert.match(calls[0].body, /refresh_token=refresh-kimi-token/);
      assert.equal(calls[1].authorization, "Bearer fresh-kimi-token");
      assert.equal(result.kimi.error, null);
      assert.equal(result.kimi.primary_window.used_percent, 40);

      const saved = JSON.parse(fs.readFileSync(credsPath, "utf8"));
      assert.equal(saved.access_token, "fresh-kimi-token");
      assert.equal(saved.refresh_token, "fresh-refresh-token");
      assert.ok(saved.expires_at > Date.now() / 1000);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("loadKimiCredentials", () => {
  it("returns null when Kimi credentials are absent", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-kimi-missing-"));
    try {
      assert.equal(loadKimiCredentials({ home: tmp }), null);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("normalizeKimiUsageResponse", () => {
  it("maps weekly, 5h, total, and parallel quota windows", () => {
    const result = normalizeKimiUsageResponse({
      usage: {
        limit: "100",
        used: "64",
        remaining: "36",
        resetTime: "2026-05-04T06:02:56.054721Z",
      },
      limits: [
        {
          window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
          detail: {
            limit: "100",
            used: "4",
            remaining: "96",
            resetTime: "2026-05-02T05:02:56.054721Z",
          },
        },
      ],
      parallel: { limit: "20" },
      totalQuota: { limit: "100", remaining: "99" },
      user: { membership: { level: "LEVEL_INTERMEDIATE" } },
      subType: "TYPE_PURCHASE",
    });

    assert.equal(result.membership_level, "LEVEL_INTERMEDIATE");
    assert.equal(result.subscription_type, "TYPE_PURCHASE");
    assert.equal(result.parallel_limit, 20);
    assert.deepEqual(result.primary_window, {
      used_percent: 64,
      reset_at: "2026-05-04T06:02:56.054Z",
    });
    assert.deepEqual(result.secondary_window, {
      used_percent: 4,
      reset_at: "2026-05-02T05:02:56.054Z",
    });
    assert.deepEqual(result.tertiary_window, {
      used_percent: 1,
      reset_at: null,
    });
  });

  it("returns null windows for invalid or zero limits", () => {
    const result = normalizeKimiUsageResponse({
      usage: { limit: "0", used: "12", remaining: "0" },
      limits: [{ detail: { limit: "bad", used: "1" } }],
      totalQuota: { limit: "0", remaining: "0" },
    });

    assert.equal(result.primary_window, null);
    assert.equal(result.secondary_window, null);
    assert.equal(result.tertiary_window, null);
    assert.equal(result.parallel_limit, null);
  });
});

describe("normalizeCursorUsageSummary", () => {
  it("maps total, auto, and api windows from usage-summary", () => {
    const result = normalizeCursorUsageSummary({
      billingCycleEnd: "2026-04-30T00:00:00.000Z",
      membershipType: "pro",
      individualUsage: {
        plan: {
          totalPercentUsed: 42.4,
          autoPercentUsed: 31.2,
          apiPercentUsed: 78.9,
        },
      },
    });

    assert.equal(result.membership_type, "pro");
    assert.deepEqual(result.primary_window, {
      used_percent: 42.4,
      reset_at: "2026-04-30T00:00:00.000Z",
    });
    assert.deepEqual(result.secondary_window, {
      used_percent: 31.2,
      reset_at: "2026-04-30T00:00:00.000Z",
    });
    assert.deepEqual(result.tertiary_window, {
      used_percent: 78.9,
      reset_at: "2026-04-30T00:00:00.000Z",
    });
  });

  it("falls back to used/limit when total percent is missing", () => {
    const result = normalizeCursorUsageSummary({
      billingCycleEnd: "2026-04-30T00:00:00.000Z",
      individualUsage: {
        plan: {
          used: 250,
          limit: 1000,
        },
      },
    });

    assert.equal(result.primary_window.used_percent, 25);
    assert.equal(result.secondary_window, null);
    assert.equal(result.tertiary_window, null);
  });

  it("prefers auto/api percent lanes over raw plan cents when both exist", () => {
    const result = normalizeCursorUsageSummary({
      billingCycleEnd: "2026-04-30T00:00:00.000Z",
      individualUsage: {
        plan: {
          used: 1,
          limit: 1_000_000,
          autoPercentUsed: 40,
          apiPercentUsed: 60,
        },
      },
    });

    assert.equal(result.primary_window.used_percent, 50);
    assert.equal(result.secondary_window.used_percent, 40);
    assert.equal(result.tertiary_window.used_percent, 60);
  });

  it("maps team onDemand when individual plan has no usable headline", () => {
    const result = normalizeCursorUsageSummary({
      billingCycleEnd: "2026-04-30T00:00:00.000Z",
      membershipType: "team",
      individualUsage: {},
      teamUsage: {
        onDemand: { used: 5000, limit: 10000 },
      },
    });

    assert.equal(result.primary_window.used_percent, 50);
  });

  it("uses team onDemand when enterprise individual lanes are 0% but pool has usage", () => {
    const result = normalizeCursorUsageSummary({
      billingCycleEnd: "2026-05-04T03:32:21.000Z",
      membershipType: "enterprise",
      limitType: "team",
      individualUsage: {
        plan: {
          enabled: true,
          used: 0,
          limit: 2000,
          totalPercentUsed: 0,
          autoPercentUsed: 0,
          apiPercentUsed: 0,
        },
        onDemand: { enabled: true, used: 0, limit: null },
      },
      teamUsage: {
        onDemand: { enabled: true, used: 1655, limit: 630000 },
      },
    });

    assert.ok(result.primary_window.used_percent > 0);
    assert.ok(result.primary_window.used_percent < 1);
  });
});

describe("parseKiroUsageOutput", () => {
  const now = new Date("2026-04-03T00:00:00.000Z");

  it("parses legacy usage output with bonus credits", () => {
    const output = `
\u001b[32m┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\u001b[0m
┃                                                          | KIRO FREE      ┃
┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫
┃ Monthly credits:                                                          ┃
┃ ████████████████████████████████████████████████████████ 100% (resets on 01/01) ┃
┃                              (0.00 of 50 covered in plan)                 ┃
┃ Bonus credits:                                                            ┃
┃ 0.00/100 credits used, expires in 88 days                                 ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛`;

    const result = parseKiroUsageOutput(output, { now });

    assert.equal(result.plan_name, "KIRO FREE");
    assert.equal(result.primary_window.used_percent, 100);
    assert.equal(result.primary_window.reset_at, "2027-01-01T00:00:00.000Z");
    assert.equal(result.secondary_window.used_percent, 0);
    assert.ok(result.secondary_window.reset_at.startsWith("2026-06-30T"));
  });

  it("parses managed plan output without usage metrics", () => {
    const output = `
Plan: Q Developer Pro
Usage is managed by organization admin.
`;

    const result = parseKiroUsageOutput(output, { now });

    assert.equal(result.plan_name, "Q Developer Pro");
    assert.equal(result.primary_window.used_percent, 0);
    assert.equal(result.primary_window.reset_at, null);
    assert.equal(result.secondary_window, null);
  });
});

describe("normalizeGeminiQuotaResponse", () => {
  it("maps pro, flash, and flash-lite windows", () => {
    const result = normalizeGeminiQuotaResponse({
      email: "me@example.com",
      tier: "standard-tier",
      buckets: [
        { modelId: "gemini-2.5-pro", remainingFraction: 0.4, resetTime: "2026-04-04T10:00:00Z" },
        { modelId: "gemini-2.5-flash", remainingFraction: 0.8, resetTime: "2026-04-04T09:00:00Z" },
        { modelId: "gemini-2.5-flash-lite", remainingFraction: 0.9, resetTime: "2026-04-04T08:00:00Z" },
      ],
    });

    assert.equal(result.account_email, "me@example.com");
    assert.equal(result.account_plan, "Paid");
    assert.equal(result.primary_window.used_percent, 60);
    assert.equal(result.secondary_window.used_percent, 20);
    assert.equal(result.tertiary_window.used_percent, 10);
  });

  it("does not show epoch reset time when Gemini returns resetTime 0", () => {
    const result = normalizeGeminiQuotaResponse({
      buckets: [
        { modelId: "gemini-2.5-pro", remainingFraction: 0, resetTime: "0" },
        { modelId: "gemini-3-pro-preview", remainingFraction: 0, resetTime: "1970-01-01T00:00:00Z" },
      ],
    });

    assert.equal(result.primary_window.used_percent, 100);
    assert.equal(result.primary_window.reset_at, null);
  });
});

describe("normalizeAntigravityResponse", () => {
  it("maps Claude, Gemini Pro, and Gemini Flash windows from GetUserStatus", () => {
    const result = normalizeAntigravityResponse({
      code: 0,
      userStatus: {
        email: "agent@example.com",
        planStatus: {
          planInfo: {
            planDisplayName: "Antigravity Pro",
          },
        },
        cascadeModelConfigData: {
          clientModelConfigs: [
            {
              label: "Claude Sonnet",
              modelOrAlias: { model: "claude-sonnet-4" },
              quotaInfo: {
                remainingFraction: 0.25,
                resetTime: "2026-04-04T10:00:00.000Z",
              },
            },
            {
              label: "Gemini Pro Low",
              modelOrAlias: { model: "gemini-pro-low" },
              quotaInfo: {
                remainingFraction: 0.4,
                resetTime: "2026-04-04T12:00:00.000Z",
              },
            },
            {
              label: "Gemini Flash",
              modelOrAlias: { model: "gemini-flash" },
              quotaInfo: {
                remainingFraction: 0.8,
                resetTime: "2026-04-04T14:00:00.000Z",
              },
            },
          ],
        },
      },
    });

    assert.equal(result.account_email, "agent@example.com");
    assert.equal(result.account_plan, "Antigravity Pro");
    assert.equal(result.primary_window.used_percent, 75);
    assert.equal(result.secondary_window.used_percent, 60);
    assert.equal(result.tertiary_window.used_percent, 20);
  });

  it("supports GetCommandModelConfigs fallback payloads", () => {
    const result = normalizeAntigravityResponse({
      code: "ok",
      clientModelConfigs: [
        {
          label: "Claude Sonnet",
          modelOrAlias: { model: "claude-sonnet-4" },
          quotaInfo: {
            remainingFraction: 0.5,
            resetTime: "1712311200",
          },
        },
      ],
    }, { fallbackToConfigs: true });

    assert.equal(result.account_email, null);
    assert.equal(result.account_plan, null);
    assert.equal(result.primary_window.used_percent, 50);
    assert.equal(result.primary_window.reset_at, "2024-04-05T10:00:00.000Z");
  });
});

describe("Antigravity helpers", () => {
  it("parses listening ports", () => {
    const output = `
COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
lang      123 me    22u  IPv4 0x123                0t0  TCP 127.0.0.1:51234 (LISTEN)
lang      123 me    23u  IPv4 0x124                0t0  TCP 127.0.0.1:51235 (LISTEN)
`;

    assert.deepEqual(parseListeningPorts(output), [51234, 51235]);
  });

  it("detects antigravity process info from ps output", () => {
    const commandRunner = () => ({
      stdout: `
123 /Applications/Antigravity.app/Contents/MacOS/language_server_macos --app_data_dir antigravity --csrf_token abc123 --extension_server_port 42427
`,
      status: 0,
    });

    const result = detectAntigravityProcess({ commandRunner });

    assert.equal(result.configured, true);
    assert.equal(result.pid, 123);
    assert.equal(result.csrfToken, "abc123");
    assert.equal(result.extensionPort, 42427);
  });
});
