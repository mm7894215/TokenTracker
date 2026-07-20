const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createLocalApiHandler } = require("../src/lib/local-api");
const pricing = require("../src/lib/pricing");

function queueRow(totalTokens, { source = "codex", model = "gpt-5.5" } = {}) {
  return {
    source,
    model,
    hour_start: "2026-07-17T02:00:00.000Z",
    input_tokens: totalTokens - 10,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 10,
    reasoning_output_tokens: 0,
    total_tokens: totalTokens,
    billable_total_tokens: totalTokens,
    conversation_count: 1,
  };
}

async function callEndpoint(handler, endpoint) {
  const url = new URL(`http://localhost${endpoint}`);
  const chunks = [];
  const req = {
    method: "GET",
    url: url.pathname + url.search,
    headers: { host: "localhost" },
  };
  const res = {
    statusCode: 200,
    setHeader() {},
    writeHead(statusCode) {
      this.statusCode = statusCode;
    },
    write(chunk) {
      chunks.push(chunk);
    },
    end(body) {
      if (body) chunks.push(body);
    },
  };
  assert.equal(await handler(req, res, url), true);
  assert.equal(res.statusCode, 200);
  return JSON.parse(chunks.join(""));
}

test("local usage endpoints reuse one parsed queue until the file changes", async () => {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tt-queue-cache-"));
  const queuePath = path.join(tmp, "queue.jsonl");
  await fs.promises.writeFile(queuePath, `${JSON.stringify(queueRow(100))}\n`);
  const handler = createLocalApiHandler({ queuePath });

  const originalReadFileSync = fs.readFileSync;
  let queueReads = 0;
  fs.readFileSync = function countedRead(filePath, ...args) {
    if (path.resolve(String(filePath)) === path.resolve(queuePath)) queueReads += 1;
    return originalReadFileSync.call(this, filePath, ...args);
  };

  try {
    const summary = await callEndpoint(
      handler,
      "/functions/tokentracker-usage-summary?from=2026-07-17&to=2026-07-17&tz=UTC",
    );
    const daily = await callEndpoint(
      handler,
      "/functions/tokentracker-usage-daily?from=2026-07-17&to=2026-07-17&tz=UTC",
    );
    assert.equal(summary.totals.total_tokens, 100);
    assert.equal(daily.data[0].total_tokens, 100);
    assert.equal(queueReads, 1);

    // Appending invalidates the signature, but the queue is append-only, so
    // the refresh reads just the new tail instead of the whole file.
    await fs.promises.appendFile(queuePath, `${JSON.stringify(queueRow(250))}\n`);
    const refreshed = await callEndpoint(
      handler,
      "/functions/tokentracker-usage-summary?from=2026-07-17&to=2026-07-17&tz=UTC",
    );
    assert.equal(refreshed.totals.total_tokens, 250);
    assert.equal(queueReads, 1);
  } finally {
    fs.readFileSync = originalReadFileSync;
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});

test("cached day aggregation preserves IANA time-zone day boundaries", async () => {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tt-day-cache-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const rows = [
      { ...queueRow(100), hour_start: "2026-03-08T07:30:00.000Z" },
      { ...queueRow(200), hour_start: "2026-03-08T10:30:00.000Z" },
    ];
    await fs.promises.writeFile(queuePath, `${rows.map(JSON.stringify).join("\n")}\n`);
    const handler = createLocalApiHandler({ queuePath });

    const march7 = await callEndpoint(
      handler,
      "/functions/tokentracker-usage-summary?from=2026-03-07&to=2026-03-07&tz=America%2FLos_Angeles",
    );
    const march8 = await callEndpoint(
      handler,
      "/functions/tokentracker-usage-summary?from=2026-03-08&to=2026-03-08&tz=America%2FLos_Angeles",
    );
    assert.equal(march7.totals.total_tokens, 100);
    assert.equal(march8.totals.total_tokens, 200);
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});

test("pricing revision invalidates cached daily cost without rereading the queue", async () => {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tt-pricing-revision-cache-"));
  const queuePath = path.join(tmp, "queue.jsonl");
  const cachePath = path.join(tmp, "pricing.json");
  const row = {
    ...queueRow(1_000_000, { source: "revision-source", model: "revision-only-model" }),
    input_tokens: 1_000_000,
    output_tokens: 0,
  };
  await fs.promises.writeFile(queuePath, `${JSON.stringify(row)}\n`);
  const handler = createLocalApiHandler({ queuePath });
  pricing.resetPricingForTests();

  try {
    const before = await callEndpoint(
      handler,
      "/functions/tokentracker-usage-summary?from=2026-07-17&to=2026-07-17&tz=UTC",
    );
    assert.equal(Number(before.totals.total_cost_usd), 0);

    await pricing.ensurePricingLoaded({
      cachePath,
      fetchImpl: async () => ({
        "revision-only-model": {
          input_cost_per_token: 2e-6,
          output_cost_per_token: 0,
        },
      }),
    });

    const after = await callEndpoint(
      handler,
      "/functions/tokentracker-usage-summary?from=2026-07-17&to=2026-07-17&tz=UTC",
    );
    assert.equal(Number(after.totals.total_cost_usd), 2);
  } finally {
    pricing.resetPricingForTests();
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});
