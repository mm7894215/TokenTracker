const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { before, describe, it } = require("node:test");

// Sandbox HOME so the handler's local-auth + skills registry stay under tmp.
const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "tt-localapi-skills-"));
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;

const { createLocalApiHandler } = require("../src/lib/local-api");

const queuePath = path.join(sandboxHome, "queue.jsonl");
fs.writeFileSync(queuePath, "");
const handler = createLocalApiHandler({ queuePath });

function makeReq({ method = "GET", pathname = "/functions/tokentracker-skills", search = "", headers = {}, body }) {
  const url = new URL(`http://localhost${pathname}${search}`);
  let listeners = {};
  const req = {
    method,
    url: url.pathname + url.search,
    headers: { host: "localhost", ...headers },
    on(event, fn) { listeners[event] = fn; return req; },
  };
  if (body !== undefined) {
    // Simulate IncomingMessage event stream for readJsonBody.
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
    chunks,
    get body() { return chunks.join(""); },
    get status() { return statusCode; },
    setHeader() {},
    writeHead(code) { statusCode = code; },
    write(chunk) { chunks.push(chunk); },
    end(chunk) { if (chunk) chunks.push(chunk); },
  };
}

async function call({ method, pathname, search = "", headers = {}, body } = {}) {
  const { req, url } = makeReq({ method, pathname, search, headers, body });
  const res = makeRes();
  const handled = await handler(req, res, url);
  return { handled, status: res.status, body: res.body ? JSON.parse(res.body) : null };
}

describe("/functions/tokentracker-skills auth + input", () => {
  let token;

  before(async () => {
    const result = await call({ method: "GET", pathname: "/api/local-auth" });
    assert.ok(result.handled);
    token = result.body.token;
    assert.ok(token && typeof token === "string");
  });

  it("rejects POST without the local-auth header with 401", async () => {
    const { status, body } = await call({
      method: "POST",
      headers: { origin: "http://localhost:7680" },
      body: { action: "add_repo", repo: { owner: "anthropics", name: "skills" } },
    });
    assert.equal(status, 401);
    assert.equal(body.ok, false);
  });

  it("rejects POST with mismatched token with 401", async () => {
    const { status } = await call({
      method: "POST",
      headers: {
        origin: "http://localhost:7680",
        "x-tokentracker-local-auth": "not-the-right-token",
      },
      body: { action: "add_repo", repo: { owner: "anthropics", name: "skills" } },
    });
    assert.equal(status, 401);
  });

  it("returns 400 for unknown action with valid auth", async () => {
    const { status, body } = await call({
      method: "POST",
      headers: {
        origin: "http://localhost:7680",
        "x-tokentracker-local-auth": token,
      },
      body: { action: "not-a-real-action" },
    });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });

  it("returns 400 for unknown GET mode", async () => {
    const { status, body } = await call({
      method: "GET",
      search: "?mode=nonsense",
    });
    assert.equal(status, 400);
    assert.ok(body.error);
  });

  it("returns 405 for PUT", async () => {
    const { status } = await call({
      method: "PUT",
      headers: {
        origin: "http://localhost:7680",
        "x-tokentracker-local-auth": token,
      },
    });
    assert.equal(status, 405);
  });

  it("GET mode=installed returns {targets, skills} shape", async () => {
    const { status, body } = await call({ method: "GET", search: "?mode=installed" });
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.targets));
    assert.ok(Array.isArray(body.skills));
  });

  it("surfaces addRepo validation error via 500 with message", async () => {
    const { status, body } = await call({
      method: "POST",
      headers: {
        origin: "http://localhost:7680",
        "x-tokentracker-local-auth": token,
      },
      body: { action: "add_repo", repo: { owner: "..", name: "skills" } },
    });
    assert.equal(status, 500);
    assert.match(body.error, /owner and name/);
  });
});
