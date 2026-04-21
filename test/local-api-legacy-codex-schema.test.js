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

test("usage-summary normalizes legacy Codex rows whose input still includes cache reads", async () => {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tt-localapi-codex-summary-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    await writeQueue(queuePath, [
      {
        source: "codex",
        model: "gpt-5.4",
        hour_start: "2026-04-20T10:00:00.000Z",
        input_tokens: 1000,
        cached_input_tokens: 950,
        output_tokens: 10,
        reasoning_output_tokens: 4,
        total_tokens: 1010,
        conversation_count: 1,
      },
    ]);

    const body = await callEndpoint(
      queuePath,
      "/functions/tokentracker-usage-summary?from=2026-04-20&to=2026-04-20&tz=UTC",
    );

    assert.equal(body.totals.total_tokens, 1010);
    assert.equal(body.totals.billable_total_tokens, 1010);
    assert.equal(
      body.totals.input_tokens,
      50,
      "legacy inclusive-of-cache input must be converted to pure non-cached input",
    );
    assert.equal(body.totals.cached_input_tokens, 950);
    assert.equal(body.totals.output_tokens, 10);
    assert.equal(body.totals.reasoning_output_tokens, 4);
    assert.equal(body.totals.total_cost_usd, "0.000513");
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});

test("usage-model-breakdown applies the same legacy Codex normalization before pricing", async () => {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tt-localapi-codex-breakdown-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    await writeQueue(queuePath, [
      {
        source: "codex",
        model: "gpt-5.4",
        hour_start: "2026-04-20T10:00:00.000Z",
        input_tokens: 1000,
        cached_input_tokens: 950,
        output_tokens: 10,
        reasoning_output_tokens: 4,
        total_tokens: 1010,
        conversation_count: 1,
      },
    ]);

    const body = await callEndpoint(
      queuePath,
      "/functions/tokentracker-usage-model-breakdown?from=2026-04-20&to=2026-04-20&tz=UTC",
    );

    assert.ok(Array.isArray(body.sources));
    const codex = body.sources.find((entry) => entry.source === "codex");
    assert.ok(codex, "response must include the codex source");
    assert.equal(codex.totals.total_tokens, 1010);
    assert.equal(codex.totals.billable_total_tokens, 1010);
    assert.equal(codex.totals.input_tokens, 50);
    assert.equal(codex.totals.cached_input_tokens, 950);
    assert.equal(codex.totals.output_tokens, 10);
    assert.equal(codex.totals.reasoning_output_tokens, 4);
    assert.equal(codex.totals.total_cost_usd, "0.000513");
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});
