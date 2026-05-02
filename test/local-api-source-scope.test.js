const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createLocalApiHandler } = require("../src/lib/local-api");

async function writeQueue(queuePath, rows) {
  await fs.promises.writeFile(queuePath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

async function callEndpoint(queuePath, endpoint) {
  const handler = createLocalApiHandler({ queuePath });
  const url = new URL(`http://localhost${endpoint}`);
  const req = {
    method: "GET",
    url: url.pathname + url.search,
    headers: { host: "localhost" },
  };
  const chunks = [];
  const res = {
    statusCode: 200,
    setHeader() {},
    writeHead() {},
    write(chunk) {
      chunks.push(chunk);
    },
    end(body) {
      if (body) chunks.push(body);
    },
  };
  const handled = await handler(req, res, url);
  assert.ok(handled, `endpoint must be handled: ${endpoint}`);
  return JSON.parse(chunks.join(""));
}

test("usage-summary defaults to personal scope and excludes account-level Cursor usage", async () => {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tt-localapi-source-scope-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    await writeQueue(queuePath, [
      {
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
      },
      {
        source: "cursor",
        model: "auto",
        hour_start: "2026-04-20T10:00:00.000Z",
        input_tokens: 10,
        cached_input_tokens: 870,
        cache_creation_input_tokens: 0,
        output_tokens: 20,
        reasoning_output_tokens: 0,
        total_tokens: 900,
        conversation_count: 1,
      },
    ]);

    const personal = await callEndpoint(
      queuePath,
      "/functions/tokentracker-usage-summary?from=2026-04-20&to=2026-04-20&tz=UTC",
    );
    assert.equal(personal.scope, "personal");
    assert.equal(personal.totals.total_tokens, 120);
    assert.deepEqual(personal.excluded_sources, [
      { source: "cursor", source_scope: "account", reason: "account_level_source" },
    ]);

    const all = await callEndpoint(
      queuePath,
      "/functions/tokentracker-usage-summary?from=2026-04-20&to=2026-04-20&tz=UTC&scope=all",
    );
    assert.equal(all.scope, "all");
    assert.equal(all.totals.total_tokens, 1020);
    assert.deepEqual(all.excluded_sources, []);
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});

test("usage-model-breakdown marks account-level sources and excludes them by default", async () => {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tt-localapi-breakdown-scope-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    await writeQueue(queuePath, [
      {
        source: "codex",
        model: "gpt-5.5",
        hour_start: "2026-04-20T10:00:00.000Z",
        input_tokens: 100,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 50,
        reasoning_output_tokens: 0,
        total_tokens: 150,
        conversation_count: 1,
      },
      {
        source: "cursor",
        model: "auto",
        hour_start: "2026-04-20T10:00:00.000Z",
        input_tokens: 1,
        cached_input_tokens: 999,
        cache_creation_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: 1000,
        conversation_count: 1,
      },
    ]);

    const personal = await callEndpoint(
      queuePath,
      "/functions/tokentracker-usage-model-breakdown?from=2026-04-20&to=2026-04-20&tz=UTC",
    );
    assert.equal(personal.scope, "personal");
    assert.deepEqual(personal.sources.map((entry) => entry.source), ["codex"]);
    assert.deepEqual(personal.excluded_sources, [
      { source: "cursor", source_scope: "account", reason: "account_level_source" },
    ]);

    const all = await callEndpoint(
      queuePath,
      "/functions/tokentracker-usage-model-breakdown?from=2026-04-20&to=2026-04-20&tz=UTC&scope=all",
    );
    const cursor = all.sources.find((entry) => entry.source === "cursor");
    assert.ok(cursor, "scope=all should include Cursor");
    assert.equal(cursor.source_scope, "account");
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});
