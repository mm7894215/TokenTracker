const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createLocalApiHandler } = require("../src/lib/local-api");

function createRequest({ method = "GET" } = {}) {
  return {
    method,
    headers: {},
    async *[Symbol.asyncIterator]() {},
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

test("session buckets endpoint returns recent queue buckets", async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "tokentracker-sessions-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    await fsp.writeFile(
      queuePath,
      [
        JSON.stringify({ source: "codex", model: "gpt-5.4", hour_start: "2026-04-10T02:00:00.000Z", total_tokens: 100 }),
        JSON.stringify({ source: "gemini", model: "gemini-2.5-pro", hour_start: "2026-04-11T02:00:00.000Z", total_tokens: 200 }),
      ].join("\n"),
      "utf8",
    );
    const handler = createLocalApiHandler({ queuePath });
    const req = createRequest();
    const res = createResponse();
    const handled = await handler(req, res, new URL("http://127.0.0.1/functions/tokentracker-session-buckets"));
    assert.equal(handled, true);
    const payload = JSON.parse(res.body.toString("utf8"));
    assert.equal(payload.entries.length, 2);
    assert.equal(payload.entries[0].source, "gemini");
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});

test("session outcomes helper counts labeled outcomes", async () => {
  globalThis.localStorage = {
    store: new Map(),
    getItem(key) { return this.store.get(key) || null; },
    setItem(key, value) { this.store.set(key, String(value)); },
    removeItem(key) { this.store.delete(key); },
  };
  const { buildOutcomeCounts } = await import("../dashboard/src/lib/session-outcomes.js");
  const counts = buildOutcomeCounts(
    [{ id: "a" }, { id: "b" }],
    { a: "productive", b: "wasted" },
  );
  assert.equal(counts.all, 2);
  assert.equal(counts.productive, 1);
  assert.equal(counts.wasted, 1);
});
