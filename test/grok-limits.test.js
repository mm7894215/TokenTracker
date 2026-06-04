const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  normalizeGrokBillingResponse,
  fetchGrokLimits,
  readGrokAccessToken,
  isGrokInstalled,
} = require("../src/lib/grok-limits");

describe("normalizeGrokBillingResponse", () => {
  it("maps monthly credits and billing period reset", () => {
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

  it("fetches billing via cli-chat-proxy with stored token", async () => {
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

      const result = await fetchGrokLimits({
        home: tmp,
        env: { GROK_HOME: grokHome },
        fetchImpl: async (url, options) => {
          assert.equal(url, "https://cli-chat-proxy.grok.com/v1/billing");
          assert.equal(options.headers.Authorization, "Bearer test-token");
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                config: {
                  monthlyLimit: { val: 1000 },
                  used: { val: 250 },
                  onDemandCap: { val: 0 },
                  billingPeriodEnd: "2026-07-01T00:00:00Z",
                },
              };
            },
          };
        },
      });

      assert.equal(result.configured, true);
      assert.equal(result.error, null);
      assert.equal(result.primary_window.used_percent, 25);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});