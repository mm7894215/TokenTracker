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

test("usage-summary defaults to all scope and includes account-level Cursor usage", async () => {
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

    const defaultScope = await callEndpoint(
      queuePath,
      "/functions/tokentracker-usage-summary?from=2026-04-20&to=2026-04-20&tz=UTC",
    );
    assert.equal(defaultScope.scope, "all");
    assert.equal(defaultScope.totals.total_tokens, 1020);
    assert.deepEqual(defaultScope.excluded_sources, []);

    const personal = await callEndpoint(
      queuePath,
      "/functions/tokentracker-usage-summary?from=2026-04-20&to=2026-04-20&tz=UTC&scope=personal",
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

test("usage-model-breakdown defaults to all scope and can explicitly exclude account sources", async () => {
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

    const defaultScope = await callEndpoint(
      queuePath,
      "/functions/tokentracker-usage-model-breakdown?from=2026-04-20&to=2026-04-20&tz=UTC",
    );
    assert.equal(defaultScope.scope, "all");
    assert.deepEqual(defaultScope.excluded_sources, []);
    assert.ok(defaultScope.sources.find((entry) => entry.source === "cursor"));

    const personal = await callEndpoint(
      queuePath,
      "/functions/tokentracker-usage-model-breakdown?from=2026-04-20&to=2026-04-20&tz=UTC&scope=personal",
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

test("usage-category-breakdown supports codex source", async () => {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tt-localapi-codex-context-"));
  const oldHome = process.env.HOME;
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    await writeQueue(queuePath, []);

    const sessionsRoot = path.join(tmp, ".codex", "sessions", "2026", "05", "08");
    await fs.promises.mkdir(sessionsRoot, { recursive: true });
    await fs.promises.writeFile(
      path.join(sessionsRoot, "rollout-a.jsonl"),
      [
        JSON.stringify({
          timestamp: "2026-05-08T10:00:00.000Z",
          type: "session_meta",
          payload: { id: "s1", cwd: "/tmp/project", model_provider: "openai", cli_version: "1.0.0" },
        }),
        JSON.stringify({
          timestamp: "2026-05-08T10:00:01.000Z",
          type: "response_item",
          payload: { type: "function_call", name: "exec_command", call_id: "call-1", arguments: "{\"cmd\":\"npm test\"}" },
        }),
        JSON.stringify({
          timestamp: "2026-05-08T10:00:02.000Z",
          type: "event_msg",
          payload: {
            type: "exec_command_end",
            command: ["bash", "-lc", "npm test"],
            status: "completed",
            exit_code: 0,
            duration: { secs: 1, nanos: 0 },
            aggregated_output: "ok\n",
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-08T10:00:03.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 100,
                cached_input_tokens: 20,
                cache_creation_input_tokens: 10,
                output_tokens: 60,
                reasoning_output_tokens: 5,
                total_tokens: 190,
              },
            },
          },
        }),
      ].join("\n") + "\n",
    );

    process.env.HOME = tmp;
    const result = await callEndpoint(
      queuePath,
      "/functions/tokentracker-usage-category-breakdown?from=2026-05-08&to=2026-05-08&source=codex",
    );

    assert.equal(result.source, "codex");
    assert.equal(result.scope, "supported");
    assert.equal(result.session_count, 1);
    assert.ok(Array.isArray(result.tool_calls_breakdown.categories));
    assert.ok(Array.isArray(result.exec_command_breakdown.by_type));
    assert.ok(Array.isArray(result.exec_command_breakdown.by_exit));
  } finally {
    process.env.HOME = oldHome;
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});

test("usage-category-breakdown falls back to codex queue totals when rollout sessions are unavailable", async () => {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tt-localapi-codex-context-fallback-"));
  const oldHome = process.env.HOME;
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    await writeQueue(queuePath, [
      {
        source: "codex",
        model: "gpt-5.5",
        hour_start: "2026-05-08T16:00:00.000Z",
        input_tokens: 100,
        cached_input_tokens: 200,
        cache_creation_input_tokens: 0,
        output_tokens: 50,
        reasoning_output_tokens: 10,
        total_tokens: 350,
        conversation_count: 2,
      },
    ]);

    process.env.HOME = tmp;
    const result = await callEndpoint(
      queuePath,
      "/functions/tokentracker-usage-category-breakdown?from=2026-05-09&to=2026-05-09&source=codex&tz=Asia/Shanghai",
    );

    assert.equal(result.source, "codex");
    assert.equal(result.scope, "supported");
    assert.equal(result.breakdown_status, "queue_fallback");
    assert.equal(result.fallback, "queue_totals");
    assert.equal(result.totals.total_tokens, 350);
    assert.equal(result.totals.input_tokens, 100);
    assert.equal(result.totals.cached_input_tokens, 200);
    assert.equal(result.message_count, 2);
  } finally {
    process.env.HOME = oldHome;
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});
