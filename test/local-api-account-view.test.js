"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { test, beforeEach, afterEach } = require("node:test");

// The handler reads/writes ~/.tokentracker/tracker/. Redirect HOME to a temp
// dir so these tests never touch the developer's real relay cookies or pref.
let tmpHome;
let prevHome;
let prevUserProfile;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tt-account-view-home-"));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  delete require.cache[require.resolve("../src/lib/cloud-account")];
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function freshHandler(queuePath) {
  // Re-require so module-level state (token cache) and the trackerDataDir
  // resolved at construction reflect the temp HOME.
  delete require.cache[require.resolve("../src/lib/local-api")];
  const { createLocalApiHandler } = require("../src/lib/local-api");
  return createLocalApiHandler({ queuePath });
}

function makeReq({ method = "GET", urlObj, headers = {}, body } = {}) {
  const base = Readable.from(body != null ? [Buffer.from(body)] : []);
  base.method = method;
  base.url = urlObj.pathname + urlObj.search;
  base.headers = { host: "localhost", ...headers };
  return base;
}

function makeRes() {
  const chunks = [];
  const headers = {};
  return {
    statusCode: 200,
    _headers: headers,
    setHeader(k, v) {
      headers[k.toLowerCase()] = v;
    },
    writeHead(status, hdrs) {
      this.statusCode = status;
      if (hdrs) for (const [k, v] of Object.entries(hdrs)) headers[k.toLowerCase()] = v;
    },
    end(body) {
      if (body) chunks.push(body);
    },
    body() {
      return chunks.join("");
    },
    json() {
      return JSON.parse(chunks.join(""));
    },
  };
}

async function call(handler, opts) {
  const urlObj = new URL(`http://localhost${opts.endpoint}`);
  const req = makeReq({ ...opts, urlObj });
  const res = makeRes();
  const handled = await handler(req, res, urlObj);
  assert.ok(handled, `endpoint must be handled: ${opts.endpoint}`);
  return res;
}

function writeQueue(queuePath, rows) {
  fs.writeFileSync(queuePath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

const SAMPLE_ROW = {
  source: "claude",
  model: "claude-sonnet-4-6",
  hour_start: "2026-04-20T10:00:00.000Z",
  input_tokens: 100,
  cached_input_tokens: 0,
  cache_creation_input_tokens: 0,
  output_tokens: 20,
  reasoning_output_tokens: 0,
  total_tokens: 120,
  conversation_count: 1,
};

test("cloud-sync-pref defaults to disabled and reports account unavailable", async () => {
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);
  const handler = freshHandler(queuePath);
  const res = await call(handler, { endpoint: "/functions/tokentracker-cloud-sync-pref" });
  assert.deepEqual(res.json(), { enabled: false, account_available: false });
});

test("user-status exposes account aggregation state", async () => {
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);
  const handler = freshHandler(queuePath);
  const res = await call(handler, { endpoint: "/functions/tokentracker-user-status" });
  const body = res.json();
  assert.deepEqual(body.account, {
    available: false,
    cloud_sync_enabled: false,
    account_view: false,
  });
});

test("POST cloud-sync-pref requires local auth, then persists and is reflected", async () => {
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);
  const handler = freshHandler(queuePath);

  // Without the local-auth token the mutation is rejected.
  const denied = await call(handler, {
    method: "POST",
    endpoint: "/functions/tokentracker-cloud-sync-pref",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(denied.statusCode, 401);

  // Fetch the token the dashboard would use.
  const authRes = await call(handler, { endpoint: "/api/local-auth" });
  const { token } = authRes.json();
  assert.ok(token);

  const ok = await call(handler, {
    method: "POST",
    endpoint: "/functions/tokentracker-cloud-sync-pref",
    headers: { "content-type": "application/json", "x-tokentracker-local-auth": token },
    body: JSON.stringify({ enabled: true }),
  });
  assert.deepEqual(ok.json(), { ok: true, enabled: true });

  // Persisted to disk and reflected by a subsequent GET (new handler instance).
  const prefFile = path.join(tmpHome, ".tokentracker", "tracker", "cloud-sync-pref.json");
  assert.equal(JSON.parse(fs.readFileSync(prefFile, "utf8")).enabled, true);

  const handler2 = freshHandler(queuePath);
  const get2 = await call(handler2, { endpoint: "/functions/tokentracker-cloud-sync-pref" });
  assert.equal(get2.json().enabled, true);

  // A non-boolean payload is rejected (400) and must NOT overwrite the pref.
  const token2 = (await call(handler2, { endpoint: "/api/local-auth" })).json().token;
  const bad = await call(handler2, {
    method: "POST",
    endpoint: "/functions/tokentracker-cloud-sync-pref",
    headers: { "content-type": "application/json", "x-tokentracker-local-auth": token2 },
    body: JSON.stringify({ enabled: "yes" }),
  });
  assert.equal(bad.statusCode, 400);
  assert.equal(JSON.parse(fs.readFileSync(prefFile, "utf8")).enabled, true, "pref must be unchanged");
});

test("usage-summary?account=1 falls back to local data when not signed in", async () => {
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);
  // Enable the pref but provide no relay refresh token → not signed in.
  const trackerDir = path.join(tmpHome, ".tokentracker", "tracker");
  fs.mkdirSync(trackerDir, { recursive: true });
  fs.writeFileSync(path.join(trackerDir, "cloud-sync-pref.json"), JSON.stringify({ enabled: true }));

  const handler = freshHandler(queuePath);
  const res = await call(handler, {
    endpoint: "/functions/tokentracker-usage-summary?from=2026-04-20&to=2026-04-20&tz=UTC&account=1",
  });
  // Local (single-machine) data served, tagged as not-account-view.
  assert.equal(res._headers["x-tokentracker-account-view"], "0");
  const body = res.json();
  assert.equal(body.scope, "all");
  assert.equal(body.totals.total_tokens, 120);
});

test("usage-summary?account=1 serves the cross-device aggregate when signed in + cloud sync on", async () => {
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);

  const trackerDir = path.join(tmpHome, ".tokentracker", "tracker");
  fs.mkdirSync(trackerDir, { recursive: true });
  fs.writeFileSync(path.join(trackerDir, "cloud-sync-pref.json"), JSON.stringify({ enabled: true }));
  // Seed a relayed refresh token (what the auth proxy would have captured).
  fs.writeFileSync(
    path.join(trackerDir, "relay-cookies.json"),
    JSON.stringify({
      insforge_refresh_token: "insforge_refresh_token=refresh-xyz; Path=/; HttpOnly; SameSite=Lax",
    }),
  );

  // Mock the network: token refresh, then the account-summary aggregate.
  const accessJwt = `${Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url")}.${Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString("base64url")}.sig`;
  const accountPayload = {
    from: "2026-04-20",
    to: "2026-04-20",
    scope: "all",
    totals: { total_tokens: 999999, total_cost_usd: "1.50" },
  };
  const realFetch = global.fetch;
  const seen = [];
  global.fetch = async (urlStr, opts) => {
    seen.push(String(urlStr));
    if (String(urlStr).includes("/api/auth/refresh")) {
      return { ok: true, status: 200, json: async () => ({ accessToken: accessJwt }) };
    }
    if (String(urlStr).includes("/functions/tokentracker-account-summary")) {
      assert.equal(opts.headers.Authorization, `Bearer ${accessJwt}`);
      return { ok: true, status: 200, json: async () => accountPayload };
    }
    throw new Error(`unexpected fetch ${urlStr}`);
  };

  try {
    const handler = freshHandler(queuePath);
    const res = await call(handler, {
      endpoint: "/functions/tokentracker-usage-summary?from=2026-04-20&to=2026-04-20&tz=UTC&account=1",
    });
    assert.equal(res._headers["x-tokentracker-account-view"], "1");
    assert.deepEqual(res.json(), accountPayload);
    assert.ok(seen.some((u) => u.includes("/api/auth/refresh")));
    assert.ok(seen.some((u) => u.includes("/functions/tokentracker-account-summary")));
  } finally {
    global.fetch = realFetch;
  }
});
