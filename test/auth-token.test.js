const { test } = require("node:test");
const assert = require("node:assert/strict");

async function loadAuthToken() {
  return await import("../dashboard/src/lib/auth-token.js");
}

test("resolveAuthAccessToken prefers getAccessToken over accessToken", async () => {
  const { resolveAuthAccessToken } = await loadAuthToken();
  const token = await resolveAuthAccessToken({
    accessToken: "token-123",
    getAccessToken: async () => "fallback",
  });
  assert.equal(token, "fallback");
});

test("resolveAuthAccessToken ignores accessToken-only objects", async () => {
  const { resolveAuthAccessToken } = await loadAuthToken();
  const token = await resolveAuthAccessToken({ accessToken: "token-123" });
  assert.equal(token, null);
});

test("normalizeAccessToken trims and nulls empty values", async () => {
  const { normalizeAccessToken } = await loadAuthToken();
  assert.equal(normalizeAccessToken("  abc  "), "abc");
  assert.equal(normalizeAccessToken("   "), null);
  assert.equal(normalizeAccessToken(""), null);
});

test("resolveAuthAccessToken handles function and normalizes output", async () => {
  const { resolveAuthAccessToken } = await loadAuthToken();
  const token = await resolveAuthAccessToken(async () => "  fn-token ");
  assert.equal(token, "fn-token");
});

test("resolveAuthAccessToken returns null when provider throws", async () => {
  const { resolveAuthAccessToken } = await loadAuthToken();
  const token = await resolveAuthAccessToken(async () => {
    throw new Error("boom");
  });
  assert.equal(token, null);
});

test("resolveAuthAccessToken returns null when getAccessToken throws", async () => {
  const { resolveAuthAccessToken } = await loadAuthToken();
  const token = await resolveAuthAccessToken({
    getAccessToken: async () => {
      throw new Error("boom");
    },
  });
  assert.equal(token, null);
});

test("isAccessTokenReady only accepts non-empty strings", async () => {
  const { isAccessTokenReady } = await loadAuthToken();
  assert.equal(isAccessTokenReady(null), false);
  assert.equal(isAccessTokenReady(""), false);
  assert.equal(isAccessTokenReady("  "), false);
  assert.equal(isAccessTokenReady("ok"), true);
});

test("isAccessTokenReady accepts token providers only", async () => {
  const { isAccessTokenReady } = await loadAuthToken();
  assert.equal(
    isAccessTokenReady(async () => "token"),
    true,
  );
  assert.equal(isAccessTokenReady({ getAccessToken: async () => "token" }), true);
  assert.equal(isAccessTokenReady({ accessToken: "token" }), false);
});

test("isValidJwtShape rejects malformed tokens and accepts real JWTs", async () => {
  const { isValidJwtShape } = await loadAuthToken();
  assert.equal(isValidJwtShape(null), false);
  assert.equal(isValidJwtShape(""), false);
  assert.equal(isValidJwtShape("abc"), false);
  assert.equal(isValidJwtShape("null"), false);
  assert.equal(isValidJwtShape("undefined"), false);
  assert.equal(isValidJwtShape("invalid.token.here"), false);
  assert.equal(isValidJwtShape("a.b"), false);
  assert.equal(isValidJwtShape("a.b.c.d"), false);

  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: "u1", exp: 9999999999 })).toString("base64url");
  const signature = "sigpart";
  assert.equal(isValidJwtShape(`${header}.${payload}.${signature}`), true);
});
