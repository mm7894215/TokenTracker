const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  normalizeGrokBillingResponse,
  normalizeGrokPeriodType,
  inferGrokPeriodTypeFromDates,
  sumProductUsagePercent,
  fetchGrokLimits,
  readGrokAccessToken,
  isGrokInstalled,
} = require("../src/lib/grok-limits");

describe("normalizeGrokPeriodType", () => {
  it("maps USAGE_PERIOD_TYPE_* enums for daily/weekly/monthly only", () => {
    assert.equal(normalizeGrokPeriodType("USAGE_PERIOD_TYPE_WEEKLY"), "weekly");
    assert.equal(normalizeGrokPeriodType("USAGE_PERIOD_TYPE_MONTHLY"), "monthly");
    assert.equal(normalizeGrokPeriodType("USAGE_PERIOD_TYPE_DAILY"), "daily");
    assert.equal(normalizeGrokPeriodType("weekly"), "weekly");
    // Hourly is not a recognized end-to-end period — do not emit it.
    assert.equal(normalizeGrokPeriodType("USAGE_PERIOD_TYPE_HOURLY"), null);
    assert.equal(normalizeGrokPeriodType("hourly"), null);
    assert.equal(normalizeGrokPeriodType(""), null);
    assert.equal(normalizeGrokPeriodType(null), null);
  });
});

describe("inferGrokPeriodTypeFromDates", () => {
  it("classifies daily / weekly / monthly windows and leaves gaps null", () => {
    assert.equal(
      inferGrokPeriodTypeFromDates("2026-07-13T00:00:00Z", "2026-07-14T00:00:00Z"),
      "daily",
    );
    assert.equal(
      inferGrokPeriodTypeFromDates("2026-07-13T00:00:00Z", "2026-07-20T00:00:00Z"),
      "weekly",
    );
    assert.equal(
      inferGrokPeriodTypeFromDates("2026-07-01T00:00:00Z", "2026-08-01T00:00:00Z"),
      "monthly",
    );
    // Sub-day and odd mid lengths must not be mislabeled as weekly.
    assert.equal(
      inferGrokPeriodTypeFromDates("2026-07-13T00:00:00Z", "2026-07-13T02:00:00Z"),
      null,
    );
    assert.equal(
      inferGrokPeriodTypeFromDates("2026-07-01T00:00:00Z", "2026-07-13T00:00:00Z"),
      null,
    );
  });
});

describe("sumProductUsagePercent", () => {
  it("sums shared-pool product attribution percentages", () => {
    assert.equal(
      sumProductUsagePercent([
        { product: "GrokBuild", usagePercent: 17 },
        { product: "GrokChat", usagePercent: 1 },
      ]),
      18,
    );
    assert.equal(sumProductUsagePercent([{ product: "GrokBuild", usagePercent: 42 }]), 42);
    assert.equal(sumProductUsagePercent([]), null);
    assert.equal(sumProductUsagePercent(null), null);
  });
});

describe("normalizeGrokBillingResponse", () => {
  it("maps unified format=credits weekly pool", () => {
    const result = normalizeGrokBillingResponse({
      config: {
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          start: "2026-07-13T09:23:37.846092+00:00",
          end: "2026-07-20T09:23:37.846092+00:00",
        },
        creditUsagePercent: 18.0,
        onDemandCap: { val: 0 },
        onDemandUsed: { val: 0 },
        productUsage: [
          { product: "GrokBuild", usagePercent: 17.0 },
          { product: "GrokChat", usagePercent: 1.0 },
        ],
        isUnifiedBillingUser: true,
        billingPeriodStart: "2026-07-13T09:23:37.846092+00:00",
        billingPeriodEnd: "2026-07-20T09:23:37.846092+00:00",
      },
    });

    assert.equal(result.period_type, "weekly");
    assert.equal(result.credit_usage_percent, 18);
    // Overall pool percent (not GrokBuild-only attribution) is the quota bar.
    assert.deepEqual(result.primary_window, {
      used_percent: 18,
      reset_at: "2026-07-20T09:23:37.846Z",
    });
    assert.equal(result.secondary_window, null);
    assert.equal(result.billing_period_start, "2026-07-13T09:23:37.846Z");
  });

  it("maps legacy monthly credits and billing period reset", () => {
    const result = normalizeGrokBillingResponse({
      config: {
        monthlyLimit: { val: 150_000 },
        used: { val: 4_625 },
        onDemandCap: { val: 0 },
        onDemandUsed: { val: 0 },
        billingPeriodStart: "2026-06-01T00:00:00+00:00",
        billingPeriodEnd: "2026-07-01T00:00:00+00:00",
      },
    });

    assert.equal(result.period_type, "monthly");
    assert.equal(result.monthly_credits_limit, 150_000);
    assert.equal(result.monthly_credits_used, 4_625);
    assert.deepEqual(result.primary_window, {
      used_percent: (4_625 / 150_000) * 100,
      reset_at: "2026-07-01T00:00:00.000Z",
    });
    assert.equal(result.secondary_window, null);
  });

  it("adds on-demand window when cap is positive", () => {
    const result = normalizeGrokBillingResponse({
      config: {
        monthlyLimit: { val: 100 },
        used: { val: 10 },
        onDemandCap: { val: 50 },
        onDemandUsed: { val: 25 },
        billingPeriodEnd: "2026-07-01T00:00:00Z",
      },
    });

    assert.deepEqual(result.secondary_window, {
      used_percent: 50,
      reset_at: "2026-07-01T00:00:00.000Z",
    });
  });

  it("sums all productUsage entries when creditUsagePercent is missing", () => {
    const result = normalizeGrokBillingResponse({
      config: {
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          start: "2026-07-13T00:00:00Z",
          end: "2026-07-20T00:00:00Z",
        },
        productUsage: [
          { product: "GrokBuild", usagePercent: 17 },
          { product: "GrokChat", usagePercent: 1 },
        ],
        billingPeriodEnd: "2026-07-20T00:00:00Z",
      },
    });

    assert.equal(result.period_type, "weekly");
    // Shared pool: 17 + 1 = 18, not GrokBuild-only 17.
    assert.equal(result.primary_window.used_percent, 18);
    assert.equal(result.credit_usage_percent, 18);
  });

  it("falls back to a single productUsage entry when only one is present", () => {
    const result = normalizeGrokBillingResponse({
      config: {
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          start: "2026-07-13T00:00:00Z",
          end: "2026-07-20T00:00:00Z",
        },
        productUsage: [{ product: "GrokBuild", usagePercent: 42 }],
        billingPeriodEnd: "2026-07-20T00:00:00Z",
      },
    });

    assert.equal(result.period_type, "weekly");
    assert.equal(result.primary_window.used_percent, 42);
    assert.equal(result.credit_usage_percent, 42);
  });

  it("infers daily / weekly / monthly from period length when type is omitted", () => {
    assert.equal(
      normalizeGrokBillingResponse({
        config: {
          creditUsagePercent: 5,
          billingPeriodStart: "2026-07-13T00:00:00Z",
          billingPeriodEnd: "2026-07-14T00:00:00Z",
        },
      }).period_type,
      "daily",
    );
    assert.equal(
      normalizeGrokBillingResponse({
        config: {
          creditUsagePercent: 5,
          billingPeriodStart: "2026-07-13T00:00:00Z",
          billingPeriodEnd: "2026-07-20T00:00:00Z",
        },
      }).period_type,
      "weekly",
    );
    assert.equal(
      normalizeGrokBillingResponse({
        config: {
          creditUsagePercent: 5,
          billingPeriodStart: "2026-07-01T00:00:00Z",
          billingPeriodEnd: "2026-08-01T00:00:00Z",
        },
      }).period_type,
      "monthly",
    );
  });

  it("does not emit hourly as a recognized period_type", () => {
    const result = normalizeGrokBillingResponse({
      config: {
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_HOURLY",
          start: "2026-07-13T00:00:00Z",
          end: "2026-07-13T01:00:00Z",
        },
        creditUsagePercent: 10,
      },
    });
    // Type ignored; sub-day length also does not infer weekly/daily.
    assert.equal(result.period_type, null);
    assert.equal(result.primary_window.used_percent, 10);
  });
});

describe("fetchGrokLimits", () => {
  it("returns configured false when auth is missing", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-limits-missing-"));
    try {
      assert.equal(isGrokInstalled({ home: tmp }), false);
      assert.deepEqual(await fetchGrokLimits({ home: tmp }), { configured: false });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fetches format=credits billing via cli-chat-proxy with stored token", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-limits-fetch-"));
    try {
      const grokHome = path.join(tmp, ".grok");
      fs.mkdirSync(grokHome, { recursive: true });
      fs.writeFileSync(
        path.join(grokHome, "auth.json"),
        JSON.stringify({
          "https://auth.x.ai::test": { key: "test-token" },
        }),
        "utf8",
      );

      assert.equal(readGrokAccessToken({ home: tmp, env: { GROK_HOME: grokHome } }), "test-token");

      const urls = [];
      const result = await fetchGrokLimits({
        home: tmp,
        env: { GROK_HOME: grokHome },
        fetchImpl: async (url, options) => {
          urls.push(url);
          assert.equal(options.headers.Authorization, "Bearer test-token");
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                config: {
                  currentPeriod: {
                    type: "USAGE_PERIOD_TYPE_WEEKLY",
                    start: "2026-07-13T09:23:37.846092+00:00",
                    end: "2026-07-20T09:23:37.846092+00:00",
                  },
                  creditUsagePercent: 25,
                  onDemandCap: { val: 0 },
                  billingPeriodEnd: "2026-07-20T09:23:37.846092+00:00",
                },
              };
            },
          };
        },
      });

      assert.equal(urls[0], "https://cli-chat-proxy.grok.com/v1/billing?format=credits");
      assert.equal(result.configured, true);
      assert.equal(result.error, null);
      assert.equal(result.period_type, "weekly");
      assert.equal(result.primary_window.used_percent, 25);
      assert.equal(result.primary_window.reset_at, "2026-07-20T09:23:37.846Z");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("falls back to legacy /v1/billing when format=credits fails", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-limits-fallback-"));
    try {
      const grokHome = path.join(tmp, ".grok");
      fs.mkdirSync(grokHome, { recursive: true });
      fs.writeFileSync(
        path.join(grokHome, "auth.json"),
        JSON.stringify({
          "https://auth.x.ai::test": { key: "test-token" },
        }),
        "utf8",
      );

      const urls = [];
      const result = await fetchGrokLimits({
        home: tmp,
        env: { GROK_HOME: grokHome },
        fetchImpl: async (url) => {
          urls.push(url);
          if (String(url).includes("format=credits")) {
            return { ok: false, status: 500, async json() { return {}; } };
          }
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                config: {
                  monthlyLimit: { val: 1000 },
                  used: { val: 250 },
                  onDemandCap: { val: 0 },
                  billingPeriodStart: "2026-07-01T00:00:00Z",
                  billingPeriodEnd: "2026-08-01T00:00:00Z",
                },
              };
            },
          };
        },
      });

      assert.deepEqual(urls, [
        "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
        "https://cli-chat-proxy.grok.com/v1/billing",
      ]);
      assert.equal(result.configured, true);
      assert.equal(result.period_type, "monthly");
      assert.equal(result.primary_window.used_percent, 25);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
