const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { before, describe, it } = require("node:test");

const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "tt-localapi-openrouter-"));
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;
delete process.env.OPENROUTER_API_KEY;

const { createLocalApiHandler } = require("../src/lib/local-api");

const VALID_KEY = "sk-or-v1-abcdefghijklmnopqrst";
const trackerDir = path.join(sandboxHome, ".tokentracker", "tracker");
fs.mkdirSync(trackerDir, { recursive: true });
const queuePath = path.join(trackerDir, "queue.jsonl");
fs.writeFileSync(queuePath, "");
const handler = createLocalApiHandler({ queuePath });

function makeReq({ method = "GET", pathname = "/functions/tokentracker-openrouter-config", headers = {}, body }) {
  const url = new URL(`http://localhost${pathname}`);
  let listeners = {};
  const req = {
    method,
    url: url.pathname,
    headers: { host: "localhost", ...headers },
    on(event, fn) {
      listeners[event] = fn;
      return req;
    },
  };
  if (body !== undefined) {
    process.nextTick(() => {
      listeners.data?.(Buffer.from(typeof body === "string" ? body : JSON.stringify(body)));
      listeners.end?.();
    });
  } else {
    process.nextTick(() => listeners.end?.());
  }
  return { req, url };
}

function makeRes() {
  const chunks = [];
  let statusCode = 200;
  return {
    get body() {
      return chunks.join("");
    },
    get status() {
      return statusCode;
    },
    setHeader() {},
    writeHead(code) {
      statusCode = code;
    },
    write(chunk) {
      chunks.push(chunk);
    },
    end(chunk) {
      if (chunk) chunks.push(chunk);
    },
  };
}

async function call({ method, pathname = "/functions/tokentracker-openrouter-config", headers = {}, body } = {}) {
  const { req, url } = makeReq({ method, pathname, headers, body });
  const res = makeRes();
  const handled = await handler(req, res, url);
  return {
    handled,
    status: res.status,
    body: res.body ? JSON.parse(res.body) : null,
  };
}

describe("/functions/tokentracker-openrouter-config", () => {
  let token;

  before(async () => {
    const result = await call({ method: "GET", pathname: "/api/local-auth" });
    token = result.body.token;
    assert.ok(token);
  });

  it("GET returns masked snapshot without full key", async () => {
    fs.writeFileSync(
      path.join(trackerDir, "config.json"),
      JSON.stringify({ openrouter: { apiKey: VALID_KEY } }, null, 2),
    );
    const { status, body } = await call({ method: "GET" });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.configured, true);
    assert.ok(body.masked_key);
    assert.notEqual(body.masked_key, VALID_KEY);
    assert.equal(body.apiKey, undefined);
  });

  it("POST without auth returns 401", async () => {
    const { status } = await call({
      method: "POST",
      body: { apiKey: VALID_KEY },
    });
    assert.equal(status, 401);
  });

  it("POST probe-only verifies without saving", async () => {
    fs.writeFileSync(path.join(trackerDir, "config.json"), JSON.stringify({}, null, 2));

    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => "",
    });

    try {
      const { status, body } = await call({
        method: "POST",
        headers: {
          origin: "http://localhost:7680",
          "x-tokentracker-local-auth": token,
        },
        body: { apiKey: VALID_KEY, probe: true, save: false },
      });
      assert.equal(status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.verified, true);
      const config = JSON.parse(fs.readFileSync(path.join(trackerDir, "config.json"), "utf8"));
      assert.equal(config.openrouter, undefined);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("POST saves key and DELETE clears it", async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => "",
    });

    try {
      const save = await call({
        method: "POST",
        headers: {
          origin: "http://localhost:7680",
          "x-tokentracker-local-auth": token,
        },
        body: { apiKey: VALID_KEY, verify: true },
      });
      assert.equal(save.status, 200);
      assert.equal(save.body.configured, true);
      assert.equal(typeof save.body.last_verified_at, "string");

      const savedConfig = JSON.parse(fs.readFileSync(path.join(trackerDir, "config.json"), "utf8"));
      assert.equal(typeof savedConfig.openrouter.lastVerifiedAt, "string");

      const cleared = await call({
        method: "DELETE",
        headers: {
          origin: "http://localhost:7680",
          "x-tokentracker-local-auth": token,
        },
      });
      assert.equal(cleared.status, 200);
      assert.equal(cleared.body.configured, false);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
