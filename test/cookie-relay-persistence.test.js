const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createLocalApiHandler } = require("../src/lib/local-api");

function createRequest({ method = "GET", headers = {}, body } = {}) {
  return {
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body != null) yield Buffer.from(body);
    },
  };
}

function createResponse() {
  return {
    statusCode: null,
    headers: null,
    body: Buffer.alloc(0),
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(chunk) {
      this.body = chunk ? Buffer.from(chunk) : Buffer.alloc(0);
    },
  };
}

async function withTempHome(run) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-relay-cookies-"));
  const prevHome = process.env.HOME;
  const prevBaseUrl = process.env.TOKENTRACKER_INSFORGE_BASE_URL;
  const prevFetch = globalThis.fetch;

  try {
    process.env.HOME = tmp;
    process.env.TOKENTRACKER_INSFORGE_BASE_URL = "https://example.invalid";
    await run(tmp);
  } finally {
    globalThis.fetch = prevFetch;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevBaseUrl === undefined) delete process.env.TOKENTRACKER_INSFORGE_BASE_URL;
    else process.env.TOKENTRACKER_INSFORGE_BASE_URL = prevBaseUrl;
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

function getCookiePath(home) {
  return path.join(home, ".tokentracker", "tracker", "relay-cookies.json");
}

test("auth proxy loads persisted relay cookies into outbound requests", async () => {
  await withTempHome(async (home) => {
    const cookiePath = getCookiePath(home);
    await fs.mkdir(path.dirname(cookiePath), { recursive: true });
    await fs.writeFile(
      cookiePath,
      JSON.stringify({
        session: "session=persisted; Path=/; HttpOnly",
      }),
      "utf8",
    );

    let proxiedCookieHeader = null;
    globalThis.fetch = async (_url, options = {}) => {
      proxiedCookieHeader = options.headers?.cookie || "";
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };

    const handler = createLocalApiHandler({ queuePath: path.join(home, "queue.jsonl") });
    const req = createRequest({ headers: {} });
    const res = createResponse();

    const handled = await handler(req, res, new URL("http://localhost/api/auth/session"));

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.match(proxiedCookieHeader, /session=persisted/);
  });
});

test("auth proxy captures set-cookie headers and persists them under an isolated HOME", async () => {
  await withTempHome(async (home) => {
    const cookiePath = getCookiePath(home);

    globalThis.fetch = async () =>
      new Response("{}", {
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-cookie": "relay_session=abc123; Path=/; HttpOnly",
        },
      });

    const handler = createLocalApiHandler({ queuePath: path.join(home, "queue.jsonl") });
    const req = createRequest({ headers: {} });
    const res = createResponse();

    const handled = await handler(req, res, new URL("http://localhost/api/auth/login"));

    assert.equal(handled, true);

    const saved = JSON.parse(await fs.readFile(cookiePath, "utf8"));
    assert.equal(saved.relay_session, "relay_session=abc123; Path=/; HttpOnly");
  });
});

test("empty in-memory relay cookies do not wipe an existing on-disk session file", async () => {
  await withTempHome(async (home) => {
    const cookiePath = getCookiePath(home);
    await fs.mkdir(path.dirname(cookiePath), { recursive: true });
    const original = '{"session":"keep-me"}\n';
    await fs.writeFile(cookiePath, original, "utf8");

    globalThis.fetch = async () =>
      new Response("{}", {
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-cookie": "temp_cookie=1; Path=/, temp_cookie=; Max-Age=0; Path=/",
        },
      });

    const handler = createLocalApiHandler({ queuePath: path.join(home, "queue.jsonl") });
    const req = createRequest({ headers: {} });
    const res = createResponse();

    const handled = await handler(req, res, new URL("http://localhost/api/auth/refresh"));

    assert.equal(handled, true);
    const saved = JSON.parse(await fs.readFile(cookiePath, "utf8"));
    assert.deepEqual(saved, { session: "keep-me" });
  });
});

test("refresh requests without browser auth context do not inject persisted relay cookies", async () => {
  await withTempHome(async (home) => {
    const cookiePath = getCookiePath(home);
    await fs.mkdir(path.dirname(cookiePath), { recursive: true });
    await fs.writeFile(
      cookiePath,
      JSON.stringify({
        refresh: "refresh=stale-token; Path=/; HttpOnly",
      }),
      "utf8",
    );

    let proxiedCookieHeader = null;
    globalThis.fetch = async (_url, options = {}) => {
      proxiedCookieHeader = options.headers?.cookie || "";
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };

    const handler = createLocalApiHandler({ queuePath: path.join(home, "queue.jsonl") });
    const req = createRequest({ method: "POST", headers: {} });
    const res = createResponse();

    const handled = await handler(req, res, new URL("http://localhost/api/auth/refresh"));

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(proxiedCookieHeader, "");
  });
});

test("refresh requests with csrf context still receive persisted relay cookies", async () => {
  await withTempHome(async (home) => {
    const cookiePath = getCookiePath(home);
    await fs.mkdir(path.dirname(cookiePath), { recursive: true });
    await fs.writeFile(
      cookiePath,
      JSON.stringify({
        refresh: "refresh=valid-token; Path=/; HttpOnly",
      }),
      "utf8",
    );

    let proxiedCookieHeader = null;
    globalThis.fetch = async (_url, options = {}) => {
      proxiedCookieHeader = options.headers?.cookie || "";
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };

    const handler = createLocalApiHandler({ queuePath: path.join(home, "queue.jsonl") });
    const req = createRequest({
      method: "POST",
      headers: {
        "x-csrf-token": "csrf-123",
      },
    });
    const res = createResponse();

    const handled = await handler(req, res, new URL("http://localhost/api/auth/refresh"));

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.match(proxiedCookieHeader, /refresh=valid-token/);
  });
});

test("stale refresh errors clear persisted relay cookies when no browser auth context exists", async () => {
  await withTempHome(async (home) => {
    const cookiePath = getCookiePath(home);
    await fs.mkdir(path.dirname(cookiePath), { recursive: true });
    await fs.writeFile(
      cookiePath,
      JSON.stringify({
        refresh: "refresh=stale-token; Path=/; HttpOnly",
      }),
      "utf8",
    );

    globalThis.fetch = async () =>
      new Response(JSON.stringify({ message: "Invalid CSRF token" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });

    const handler = createLocalApiHandler({ queuePath: path.join(home, "queue.jsonl") });
    const req = createRequest({ method: "POST", headers: {} });
    const res = createResponse();

    const handled = await handler(req, res, new URL("http://localhost/api/auth/refresh"));

    assert.equal(handled, true);
    await assert.rejects(fs.readFile(cookiePath, "utf8"), { code: "ENOENT" });
  });
});
