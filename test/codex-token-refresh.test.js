const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it } = require("node:test");

const {
  isTokenStale,
  refreshCodexTokens,
  persistRefreshedAuth,
  REFRESH_THRESHOLD_MS,
  REFRESH_ENDPOINT,
} = require("../src/lib/codex-token-refresh");

describe("isTokenStale", () => {
  it("treats missing last_refresh as stale", () => {
    assert.equal(isTokenStale(null), true);
    assert.equal(isTokenStale(""), true);
    assert.equal(isTokenStale(undefined), true);
  });

  it("treats invalid timestamp strings as stale", () => {
    assert.equal(isTokenStale("not-a-date"), true);
  });

  it("returns false when last_refresh is fresh (within 8 days)", () => {
    const now = Date.parse("2026-05-05T00:00:00Z");
    assert.equal(isTokenStale("2026-05-04T00:00:00Z", now), false);
    assert.equal(isTokenStale("2026-04-28T00:00:00Z", now), false);
  });

  it("returns true when last_refresh is past the 8-day threshold", () => {
    const now = Date.parse("2026-05-05T00:00:00Z");
    assert.equal(isTokenStale("2026-04-26T23:00:00Z", now), true);
    assert.equal(isTokenStale("2026-01-01T00:00:00Z", now), true);
  });

  it("uses an 8-day threshold (not 7, not 30)", () => {
    assert.equal(REFRESH_THRESHOLD_MS, 8 * 24 * 60 * 60 * 1000);
  });
});

describe("refreshCodexTokens", () => {
  it("posts to the OpenAI oauth endpoint with the public Codex client id", async () => {
    let observedUrl = null;
    let observedBody = null;
    const result = await refreshCodexTokens({
      refreshToken: "rt-abc",
      fetchImpl: async (url, opts) => {
        observedUrl = url;
        observedBody = JSON.parse(opts.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: "new-access",
            refresh_token: "new-refresh",
            id_token: "new-id",
          }),
        };
      },
    });

    assert.equal(observedUrl, REFRESH_ENDPOINT);
    assert.equal(observedBody.client_id, "app_EMoamEEZ73f0CkXaXp7hrann");
    assert.equal(observedBody.grant_type, "refresh_token");
    assert.equal(observedBody.refresh_token, "rt-abc");
    assert.deepEqual(result, {
      access_token: "new-access",
      refresh_token: "new-refresh",
      id_token: "new-id",
    });
  });

  it("preserves the old refresh_token when the response omits a new one", async () => {
    const result = await refreshCodexTokens({
      refreshToken: "rt-abc",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ access_token: "new-access" }),
      }),
    });
    assert.equal(result.refresh_token, "rt-abc");
    assert.equal(result.id_token, null);
  });

  it("throws REFRESH_TOKEN_EXPIRED on 401 with refresh_token_expired", async () => {
    let thrown = null;
    try {
      await refreshCodexTokens({
        refreshToken: "rt-abc",
        fetchImpl: async () => ({
          ok: false,
          status: 401,
          json: async () => ({ error: { code: "refresh_token_expired" } }),
        }),
      });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown);
    assert.equal(thrown.code, "REFRESH_TOKEN_EXPIRED");
    assert.equal(thrown.openaiErrorCode, "refresh_token_expired");
    assert.match(thrown.message, /Run `codex` to re-authenticate/);
  });

  it("throws NO_REFRESH_TOKEN when no refresh_token is available", async () => {
    let thrown = null;
    try {
      await refreshCodexTokens({ refreshToken: null, fetchImpl: async () => ({ ok: true }) });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown);
    assert.equal(thrown.code, "NO_REFRESH_TOKEN");
  });

  it("throws on non-200 non-401 responses", async () => {
    let thrown = null;
    try {
      await refreshCodexTokens({
        refreshToken: "rt-abc",
        fetchImpl: async () => ({
          ok: false,
          status: 500,
          json: async () => ({}),
        }),
      });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown);
    assert.equal(thrown.code, "REFRESH_HTTP_ERROR");
    assert.equal(thrown.status, 500);
  });

  it("throws REFRESH_INVALID_RESPONSE when access_token is missing", async () => {
    let thrown = null;
    try {
      await refreshCodexTokens({
        refreshToken: "rt-abc",
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => ({ refresh_token: "rt-new" }),
        }),
      });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown);
    assert.equal(thrown.code, "REFRESH_INVALID_RESPONSE");
  });
});

describe("persistRefreshedAuth", () => {
  it("atomically writes refreshed tokens preserving non-token fields", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-codex-refresh-"));
    try {
      const authPath = path.join(tmp, "auth.json");
      const original = {
        auth_mode: "chatgpt",
        OPENAI_API_KEY: "sk-existing",
        tokens: {
          id_token: "old-id",
          access_token: "old-access",
          refresh_token: "old-refresh",
          account_id: "acc-123",
        },
        last_refresh: "2026-04-01T00:00:00Z",
      };
      fs.writeFileSync(authPath, JSON.stringify(original));

      const updated = await persistRefreshedAuth(authPath, original, {
        access_token: "new-access",
        refresh_token: "new-refresh",
        id_token: "new-id",
      });

      assert.equal(updated.tokens.access_token, "new-access");
      assert.equal(updated.tokens.refresh_token, "new-refresh");
      assert.equal(updated.tokens.id_token, "new-id");
      assert.equal(updated.tokens.account_id, "acc-123", "account_id must be preserved");
      assert.equal(updated.auth_mode, "chatgpt");
      assert.equal(updated.OPENAI_API_KEY, "sk-existing");
      assert.notEqual(updated.last_refresh, "2026-04-01T00:00:00Z");

      // Persisted file matches the in-memory result
      const onDisk = JSON.parse(fs.readFileSync(authPath, "utf8"));
      assert.deepEqual(onDisk, updated);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
