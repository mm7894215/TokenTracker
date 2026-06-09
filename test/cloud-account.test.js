"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  accountSlugFor,
  accessTokenFromRefreshPayload,
  refreshTokenFromRefreshPayload,
  decodeJwtExpMs,
  mintAccessToken,
  fetchAccountFunction,
  fetchAccountUsage,
  __resetCloudAccountCacheForTests,
} = require("../src/lib/cloud-account");

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeJwt({ expSeconds }) {
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub: "u1", exp: expSeconds })}.sig`;
}

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

test("accountSlugFor maps usage slugs to account slugs, null for non-cloud", () => {
  assert.equal(accountSlugFor("tokentracker-usage-summary"), "tokentracker-account-summary");
  assert.equal(accountSlugFor("tokentracker-usage-model-breakdown"), "tokentracker-account-model-breakdown");
  assert.equal(accountSlugFor("tokentracker-project-usage-summary"), null);
  assert.equal(accountSlugFor("tokentracker-usage-limits"), null);
});

test("accessTokenFromRefreshPayload reads camel/snake, top-level and nested", () => {
  assert.equal(accessTokenFromRefreshPayload({ accessToken: "a" }), "a");
  assert.equal(accessTokenFromRefreshPayload({ access_token: "b" }), "b");
  assert.equal(accessTokenFromRefreshPayload({ session: { accessToken: "c" } }), "c");
  assert.equal(accessTokenFromRefreshPayload({ session: { access_token: "d" } }), "d");
  assert.equal(accessTokenFromRefreshPayload({}), null);
  assert.equal(accessTokenFromRefreshPayload(null), null);
});

test("refreshTokenFromRefreshPayload reads rotated refresh token", () => {
  assert.equal(refreshTokenFromRefreshPayload({ refreshToken: "r1" }), "r1");
  assert.equal(refreshTokenFromRefreshPayload({ session: { refresh_token: "r2" } }), "r2");
  assert.equal(refreshTokenFromRefreshPayload({}), null);
});

test("decodeJwtExpMs decodes exp in ms, 0 on garbage", () => {
  assert.equal(decodeJwtExpMs(makeJwt({ expSeconds: 1000 })), 1000 * 1000);
  assert.equal(decodeJwtExpMs("not-a-jwt"), 0);
  assert.equal(decodeJwtExpMs(""), 0);
});

test("mintAccessToken returns null without a refresh token", async () => {
  __resetCloudAccountCacheForTests();
  const out = await mintAccessToken({ refreshToken: "", fetchImpl: async () => jsonResponse({}) });
  assert.equal(out, null);
});

test("mintAccessToken posts refresh token and returns access token", async () => {
  __resetCloudAccountCacheForTests();
  const calls = [];
  const access = makeJwt({ expSeconds: Math.floor(Date.now() / 1000) + 3600 });
  const fetchImpl = async (urlStr, opts) => {
    calls.push({ urlStr, opts });
    return jsonResponse({ accessToken: access });
  };
  const out = await mintAccessToken({
    baseUrl: "https://cloud.example",
    anonKey: "ik_test",
    refreshToken: "refresh-1",
    fetchImpl,
  });
  assert.equal(out.accessToken, access);
  assert.equal(out.refreshToken, null);
  assert.equal(calls.length, 1);
  assert.match(calls[0].urlStr, /\/api\/auth\/refresh\?client_type=mobile$/);
  assert.equal(calls[0].opts.headers.apikey, "ik_test");
  assert.deepEqual(JSON.parse(calls[0].opts.body), { refresh_token: "refresh-1" });
});

test("mintAccessToken caches by refresh token and skips re-fetch until near expiry", async () => {
  __resetCloudAccountCacheForTests();
  let fetchCount = 0;
  const access = makeJwt({ expSeconds: Math.floor(Date.now() / 1000) + 3600 });
  const fetchImpl = async () => {
    fetchCount += 1;
    return jsonResponse({ accessToken: access });
  };
  const args = { baseUrl: "https://cloud.example", refreshToken: "refresh-cache", fetchImpl };
  const a = await mintAccessToken(args);
  const b = await mintAccessToken(args);
  assert.equal(a.accessToken, access);
  assert.equal(b.accessToken, access);
  assert.equal(fetchCount, 1, "second call should hit cache");

  // A different refresh token must bypass the cache.
  await mintAccessToken({ ...args, refreshToken: "refresh-other" });
  assert.equal(fetchCount, 2);
});

test("mintAccessToken returns null on non-ok refresh and on network error", async () => {
  __resetCloudAccountCacheForTests();
  assert.equal(
    await mintAccessToken({ refreshToken: "x", fetchImpl: async () => jsonResponse({}, false, 401) }),
    null,
  );
  __resetCloudAccountCacheForTests();
  assert.equal(
    await mintAccessToken({ refreshToken: "x", fetchImpl: async () => { throw new Error("offline"); } }),
    null,
  );
});

test("mintAccessToken surfaces a rotated refresh token", async () => {
  __resetCloudAccountCacheForTests();
  const access = makeJwt({ expSeconds: Math.floor(Date.now() / 1000) + 3600 });
  const out = await mintAccessToken({
    refreshToken: "old",
    fetchImpl: async () => jsonResponse({ accessToken: access, refreshToken: "new" }),
  });
  assert.equal(out.refreshToken, "new");
});

test("fetchAccountFunction forwards query params except account/scope, sets auth headers", async () => {
  const captured = {};
  const fetchImpl = async (urlStr, opts) => {
    captured.urlStr = urlStr;
    captured.opts = opts;
    return jsonResponse({ ok: 1 });
  };
  const searchParams = new URLSearchParams("from=2026-01-01&to=2026-01-02&tz=UTC&account=1&scope=all");
  const body = await fetchAccountFunction({
    baseUrl: "https://cloud.example/",
    anonKey: "ik_x",
    accessToken: "jwt-abc",
    slug: "tokentracker-account-summary",
    searchParams,
    fetchImpl,
  });
  assert.deepEqual(body, { ok: 1 });
  const u = new URL(captured.urlStr);
  assert.equal(u.pathname, "/functions/tokentracker-account-summary");
  assert.equal(u.searchParams.get("from"), "2026-01-01");
  assert.equal(u.searchParams.get("tz"), "UTC");
  assert.equal(u.searchParams.get("account"), null, "account must be stripped");
  assert.equal(u.searchParams.get("scope"), null, "scope must be stripped");
  assert.equal(captured.opts.headers.Authorization, "Bearer jwt-abc");
  assert.equal(captured.opts.headers.apikey, "ik_x");
});

test("fetchAccountFunction throws with status on non-ok", async () => {
  await assert.rejects(
    () => fetchAccountFunction({
      accessToken: "x",
      slug: "tokentracker-account-summary",
      searchParams: new URLSearchParams(),
      fetchImpl: async () => jsonResponse({}, false, 500),
    }),
    (err) => err.status === 500,
  );
});

test("fetchAccountUsage returns null for slugs without a cloud equivalent", async () => {
  __resetCloudAccountCacheForTests();
  const out = await fetchAccountUsage({
    usageSlug: "tokentracker-usage-limits",
    searchParams: new URLSearchParams(),
    refreshToken: "r",
    fetchImpl: async () => jsonResponse({}),
  });
  assert.equal(out, null);
});

test("fetchAccountUsage returns null when not signed in (no refresh token)", async () => {
  __resetCloudAccountCacheForTests();
  const out = await fetchAccountUsage({
    usageSlug: "tokentracker-usage-summary",
    searchParams: new URLSearchParams(),
    refreshToken: "",
    fetchImpl: async () => jsonResponse({}),
  });
  assert.equal(out, null);
});

test("fetchAccountUsage mints a token then returns the account payload", async () => {
  __resetCloudAccountCacheForTests();
  const access = makeJwt({ expSeconds: Math.floor(Date.now() / 1000) + 3600 });
  const payload = { from: "2026-01-01", to: "2026-01-01", totals: { total_tokens: 4242 } };
  const fetchImpl = async (urlStr) => {
    if (urlStr.includes("/api/auth/refresh")) return jsonResponse({ accessToken: access });
    if (urlStr.includes("/functions/tokentracker-account-summary")) return jsonResponse(payload);
    throw new Error(`unexpected url ${urlStr}`);
  };
  const out = await fetchAccountUsage({
    usageSlug: "tokentracker-usage-summary",
    searchParams: new URLSearchParams("from=2026-01-01&to=2026-01-01"),
    baseUrl: "https://cloud.example",
    anonKey: "ik_x",
    refreshToken: "r",
    fetchImpl,
  });
  assert.deepEqual(out.data, payload);
  assert.equal(out.rotatedRefreshToken, null);
});
