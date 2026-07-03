const assert = require("node:assert/strict");
const { test } = require("node:test");

const { multiInstallParse, emptyResult } = require("../src/lib/multi-install-parser");

function addToBucket(cursors, key, input, output) {
  const existing = cursors.hourly?.buckets?.[key];
  const prevInput = existing?.totals?.input_tokens || 0;
  const prevOutput = existing?.totals?.output_tokens || 0;
  cursors.hourly.buckets[key] = {
    totals: { input_tokens: prevInput + input, output_tokens: prevOutput + output },
  };
}

test("emptyResult returns zeroed result", () => {
  const r = emptyResult();
  assert.equal(r.recordsProcessed, 0);
  assert.equal(r.eventsAggregated, 0);
  assert.equal(r.bucketsQueued, 0);
});

test("multiInstallParse returns emptyResult when no paths", async () => {
  const r = await multiInstallParse({
    paths: { native: null, wsl: null },
    parserFn: async () => ({ recordsProcessed: 5 }),
    providerName: "test",
    cursors: { hourly: {} },
    getParams: () => ({}),
  });
  assert.equal(r.recordsProcessed, 0);
});

test("multiInstallParse single path passes through directly", async () => {
  const cursors = { hourly: {} };
  const r = await multiInstallParse({
    paths: { native: "/path", wsl: null },
    parserFn: async ({ cursors: c }) => {
      c.testKey = "was-called";
      return { recordsProcessed: 10, eventsAggregated: 5, bucketsQueued: 3 };
    },
    providerName: "test",
    cursors,
    getParams: (path) => ({ resolvedPath: path }),
  });
  assert.equal(r.recordsProcessed, 10);
  assert.equal(cursors.testKey, "was-called");
});

test("multiInstallParse dual paths merge when no prefer set (default)", async () => {
  const cursors = { hourly: { buckets: {} } };

  const r = await multiInstallParse({
    paths: { native: "/native", wsl: "/wsl" },
    parserFn: async ({ resolvedPath, cursors: c }) => {
      addToBucket(c, "hermes|gpt-4|2026-01-01T00:00:00.000Z", 100, 50);
      return { recordsProcessed: 1, eventsAggregated: 1, bucketsQueued: 1 };
    },
    providerName: "hermes",
    cursors,
    getParams: (path) => ({ resolvedPath: path }),
  });

  assert.equal(r.recordsProcessed, 2);
  // Both installs contributed to the same bucket — merged without filtering
  const bucket = cursors.hourly.buckets["hermes|gpt-4|2026-01-01T00:00:00.000Z"];
  assert.ok(bucket);
  assert.equal(bucket.totals.input_tokens, 200, "both installs merged (100+100)");
  assert.equal(bucket.totals.output_tokens, 100, "both installs merged (50+50)");
});

test("multiInstallParse dual paths with prefer=native resolves conflict", async () => {
  const cursors = { hourly: { buckets: {} } };
  const env = { TOKENTRACKER_WSL_PREFER: "native" };

  const r = await multiInstallParse({
    paths: { native: "/native", wsl: "/wsl" },
    parserFn: async ({ resolvedPath, cursors: c }) => {
      addToBucket(c, "hermes|gpt-4|2026-01-01T00:00:00.000Z", 100, 50);
      return { recordsProcessed: 1, eventsAggregated: 1, bucketsQueued: 1 };
    },
    providerName: "hermes",
    cursors,
    env,
    getParams: (path) => ({ resolvedPath: path }),
  });

  assert.equal(r.recordsProcessed, 2);
  const bucket = cursors.hourly.buckets["hermes|gpt-4|2026-01-01T00:00:00.000Z"];
  assert.equal(bucket.totals.input_tokens, 100, "native data kept (WSL discarded)");
});

test("multiInstallParse dual paths with prefer=wsl resolves conflict", async () => {
  const cursors = { hourly: { buckets: {} } };
  const env = { TOKENTRACKER_WSL_PREFER: "wsl" };

  const r = await multiInstallParse({
    paths: { native: "/native", wsl: "/wsl" },
    parserFn: async ({ resolvedPath, cursors: c }) => {
      addToBucket(c, "hermes|gpt-4|2026-01-01T00:00:00.000Z", 100, 50);
      return { recordsProcessed: 1, eventsAggregated: 1, bucketsQueued: 1 };
    },
    providerName: "hermes",
    cursors,
    env,
    getParams: (path) => ({ resolvedPath: path }),
  });

  assert.equal(r.recordsProcessed, 2);
  const bucket = cursors.hourly.buckets["hermes|gpt-4|2026-01-01T00:00:00.000Z"];
  assert.equal(bucket.totals.input_tokens, 100, "WSL data kept (native discarded)");
});

test("multiInstallParse cursor isolation between installs", async () => {
  const cursors = { hourly: {} };

  await multiInstallParse({
    paths: { native: "/a", wsl: "/b" },
    parserFn: async ({ resolvedPath, cursors: c }) => {
      c.hermes = { startedAt: resolvedPath === "/a" ? 100 : 200 };
      return { recordsProcessed: 1 };
    },
    providerName: "hermes",
    cursors,
    getParams: (path) => ({ resolvedPath: path }),
  });

  assert.equal(cursors.hermes.native.startedAt, 100);
  assert.equal(cursors.hermes.wsl.startedAt, 200);
});

test("multiInstallParse partial parse failure propagates error", async () => {
  const cursors = { hourly: {} };

  await assert.rejects(
    () => multiInstallParse({
      paths: { native: "/a", wsl: "/b" },
      parserFn: async ({ resolvedPath }) => {
        if (resolvedPath === "/b") throw new Error("second install failed");
        return { recordsProcessed: 1 };
      },
      providerName: "hermes",
      cursors,
      getParams: (path) => ({ resolvedPath: path }),
    }),
    { message: "second install failed" },
  );

  assert.ok(cursors.hermes.native !== undefined, "first install's cursor should be preserved");
});

test("multiInstallParse empty install produces correct partial result", async () => {
  const cursors = { hourly: { buckets: {} } };

  const r = await multiInstallParse({
    paths: { native: "/native-data", wsl: "/wsl-empty" },
    parserFn: async ({ resolvedPath, cursors: c }) => {
      if (resolvedPath === "/wsl-empty") return { recordsProcessed: 0 };
      c.hourly.buckets["test|model|2026-01-01T00:00:00.000Z"] = {
        totals: { input_tokens: 100, output_tokens: 50 },
      };
      return { recordsProcessed: 5, eventsAggregated: 3, bucketsQueued: 1 };
    },
    providerName: "test",
    cursors,
    getParams: (path) => ({ resolvedPath: path }),
  });

  assert.equal(r.recordsProcessed, 5, "only the non-empty install's records");
  assert.equal(r.eventsAggregated, 3);
  assert.equal(r.bucketsQueued, 1);
});
