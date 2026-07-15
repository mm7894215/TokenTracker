const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  cmdSync,
  migrateRolloutCumulativeDeltaBuckets,
} = require("../src/commands/sync");
const {
  filterColdCodexRolloutFiles,
  parseRolloutIncremental,
} = require("../src/lib/rollout");
const { withHome } = require("./helpers/with-home");

const LARGE_HASH_COUNT = 379_000;

function buildProductionScaleHashes() {
  const suffix = "x".repeat(158);
  return Array.from(
    { length: LARGE_HASH_COUNT },
    (_, index) => `${index.toString(36).padStart(6, "0")}:${suffix}`,
  );
}

function observeWholeArrayReads(values) {
  const metrics = {
    iterator_reads: 0,
    indexed_reads: 0,
    copy_method_reads: 0,
  };
  const copyMethods = new Set(["concat", "filter", "flat", "flatMap", "map", "slice", "toSpliced"]);
  const proxy = new Proxy(values, {
    get(target, property, receiver) {
      if (property === Symbol.iterator) metrics.iterator_reads += 1;
      if (typeof property === "string" && /^\d+$/.test(property)) metrics.indexed_reads += 1;
      if (copyMethods.has(property)) metrics.copy_method_reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  return { proxy, metrics };
}

test("idle Codex parsing does not materialize a production-scale hash Set or array copy", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-sync-hot-"));
  try {
    const hashes = buildProductionScaleHashes();
    const cursorBytes = Buffer.byteLength(JSON.stringify({ version: 1, files: {}, codexHashes: hashes }));
    assert.ok(cursorBytes >= 60 * 1024 * 1024, `expected >=60 MiB, got ${cursorBytes}`);
    assert.ok(cursorBytes <= 62 * 1024 * 1024, `expected <=62 MiB, got ${cursorBytes}`);
    const observedHashes = observeWholeArrayReads(hashes);
    const cursors = { version: 1, files: {}, codexHashes: observedHashes.proxy };

    const diagnostics = {};
    await parseRolloutIncremental({
      rolloutFiles: [],
      cursors,
      queuePath: path.join(root, "queue.jsonl"),
      source: "codex",
      diagnostics,
    });

    assert.strictEqual(cursors.codexHashes, observedHashes.proxy, "idle parsing must not copy the hash array");
    assert.deepEqual(observedHashes.metrics, {
      iterator_reads: 0,
      indexed_reads: 0,
      copy_method_reads: 0,
    });
    assert.equal(diagnostics.discovered_rollouts, 0);
    assert.equal(diagnostics.stat_candidates, 0);
    assert.equal(diagnostics.content_files_read, 0);
    assert.equal(diagnostics.hash_set_constructions, 0);
    assert.equal(diagnostics.hash_array_materializations, 0);
    assert.equal(diagnostics.hash_array_materialized_items, 0);
    assert.equal(diagnostics.codex_hash_count, LARGE_HASH_COUNT);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("cold filtering distinguishes discovered rollouts, cursor keys, parse candidates, and skipped files", async () => {
  const oldPath = path.join(
    "/tmp", "sessions", "2029", "01", "01",
    "rollout-2029-01-01T00-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl",
  );
  const activePath = path.join(
    "/tmp", "sessions", "2030", "06", "02",
    "rollout-2030-06-02T00-00-00-bbbbbbbb-cccc-dddd-eeee-ffffffffffff.jsonl",
  );
  const rolloutFiles = [
    { path: oldPath, source: "codex" },
    { path: activePath, source: "codex" },
  ];
  const cursors = {
    version: 1,
    files: {
      [oldPath]: { inode: 1, offset: 100 },
      [activePath]: { inode: 2, offset: 100 },
    },
    codexHashes: [],
  };
  const diagnostics = {};

  const filtered = await filterColdCodexRolloutFiles({
    rolloutFiles,
    cursors,
    diagnostics,
    nowMs: Date.UTC(2030, 5, 2, 12, 0, 0),
    recentDays: 2,
  });

  assert.deepEqual(filtered.rolloutFiles, [rolloutFiles[1]]);
  assert.equal(filtered.skipped, 1);
  assert.equal(diagnostics.discovered_rollouts, 2);
  assert.equal(diagnostics.cursor_keys, 2);
  assert.equal(diagnostics.parse_candidates, 1);
  assert.equal(diagnostics.cold_skipped, 1);
  assert.ok(diagnostics.cold_skipped <= diagnostics.discovered_rollouts);
});

test("Codex sync diagnostics keep candidate counts source-scoped after mixed-source parsing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-sync-mixed-diagnostics-"));
  try {
    const oldPath = path.join(root, "rollout-2029-01-01T00-00-00-old.jsonl");
    const activePath = path.join(root, "rollout-2030-06-02T00-00-00-active.jsonl");
    const everyCodePath = path.join(root, "every-code.jsonl");
    const rolloutFiles = [
      { path: oldPath, source: "codex" },
      { path: activePath, source: "codex" },
      { path: everyCodePath, source: "every-code" },
    ];
    const cursors = {
      version: 1,
      files: {
        [oldPath]: { inode: 1, offset: 100 },
        [activePath]: { inode: 2, offset: 100 },
        [everyCodePath]: { inode: 3, offset: 100 },
      },
      codexHashes: [],
    };
    const diagnostics = {};
    const filtered = await filterColdCodexRolloutFiles({
      rolloutFiles,
      cursors,
      diagnostics,
      nowMs: Date.UTC(2030, 5, 2, 12, 0, 0),
      recentDays: 2,
    });
    assert.equal(diagnostics.discovered_rollouts, 2);
    assert.equal(diagnostics.parse_candidates, 1);

    await parseRolloutIncremental({
      rolloutFiles: filtered.rolloutFiles,
      cursors,
      queuePath: path.join(root, "queue.jsonl"),
      diagnostics,
    });
    assert.equal(diagnostics.discovered_rollouts, 2);
    assert.equal(diagnostics.parse_candidates, 1, "Every Code must not inflate the Codex candidate count");
    assert.equal(diagnostics.stat_candidates, 1);
    assert.equal(diagnostics.content_files_read, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a production-scale same-inode append avoids the historical Codex hash Set", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-sync-append-"));
  try {
    const hashes = buildProductionScaleHashes();
    const observedHashes = observeWholeArrayReads(hashes);
    const rolloutPath = path.join(
      root,
      "rollout-2030-06-02T00-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl",
    );
    const baseline = {
      timestamp: "2030-06-02T00:30:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 4,
            cached_input_tokens: 1,
            cache_creation_input_tokens: 0,
            output_tokens: 2,
            reasoning_output_tokens: 1,
            total_tokens: 6,
          },
        },
      },
    };
    const appended = {
      timestamp: "2030-06-02T01:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 10,
            cached_input_tokens: 2,
            cache_creation_input_tokens: 0,
            output_tokens: 3,
            reasoning_output_tokens: 1,
            total_tokens: 14,
          },
          total_token_usage: {
            input_tokens: 10,
            cached_input_tokens: 2,
            cache_creation_input_tokens: 0,
            output_tokens: 3,
            reasoning_output_tokens: 1,
            total_tokens: 14,
          },
        },
      },
    };
    const baselineLine = `${JSON.stringify(baseline)}\n`;
    await fs.writeFile(rolloutPath, baselineLine, "utf8");
    await fs.appendFile(rolloutPath, `${JSON.stringify(appended)}\n`, "utf8");
    const stat = await fs.stat(rolloutPath);
    const cursors = {
      version: 1,
      files: {
        [rolloutPath]: {
          inode: stat.ino,
          offset: Buffer.byteLength(baselineLine),
          lastTotal: baseline.payload.info.total_token_usage,
        },
      },
      codexHashes: observedHashes.proxy,
    };
    const diagnostics = {};

    const first = await parseRolloutIncremental({
      rolloutFiles: [rolloutPath],
      cursors,
      queuePath: path.join(root, "queue.jsonl"),
      source: "codex",
      diagnostics,
    });
    assert.equal(first.filesProcessed, 1);
    assert.equal(first.eventsAggregated, 1);
    assert.equal(diagnostics.discovered_rollouts, 1);
    assert.equal(diagnostics.stat_candidates, 1);
    assert.equal(diagnostics.content_files_read, 1);
    assert.equal(diagnostics.hash_set_constructions, 0);
    assert.equal(diagnostics.hash_array_materializations, 0);
    assert.equal(diagnostics.hash_array_materialized_items, 0);
    assert.equal(cursors.codexHashes.length, LARGE_HASH_COUNT + 1);
    assert.strictEqual(cursors.codexHashes, observedHashes.proxy);
    assert.equal(observedHashes.metrics.iterator_reads, 0);
    assert.equal(observedHashes.metrics.indexed_reads, 0);
    assert.equal(observedHashes.metrics.copy_method_reads, 0);

    const persistedHashes = cursors.codexHashes;
    const idleDiagnostics = {};
    await parseRolloutIncremental({
      rolloutFiles: [rolloutPath],
      cursors,
      queuePath: path.join(root, "queue.jsonl"),
      source: "codex",
      diagnostics: idleDiagnostics,
    });
    assert.strictEqual(cursors.codexHashes, persistedHashes);
    assert.equal(idleDiagnostics.hash_set_constructions, 0);
    assert.equal(idleDiagnostics.hash_array_materializations, 0);
    assert.equal(idleDiagnostics.content_files_read, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a legacy same-inode append without lastTotal rebuilds its cumulative baseline", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-sync-legacy-baseline-"));
  try {
    const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const baselineTimestamp = "2030-06-02T01:00:00.000Z";
    const targetTimestamp = "2030-06-02T01:05:00.000Z";
    const rolloutPath = path.join(
      root,
      `rollout-2030-06-02T01-00-00-${sessionId}.jsonl`,
    );
    const baselineUsage = {
      input_tokens: 20,
      cached_input_tokens: 5,
      cache_creation_input_tokens: 0,
      output_tokens: 4,
      reasoning_output_tokens: 1,
      total_tokens: 24,
    };
    const targetUsage = {
      input_tokens: 35,
      cached_input_tokens: 10,
      cache_creation_input_tokens: 0,
      output_tokens: 9,
      reasoning_output_tokens: 2,
      total_tokens: 44,
    };
    const event = (timestamp, usage) => ({
      timestamp,
      type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: usage } },
    });
    const baselineLine = `${JSON.stringify(event(baselineTimestamp, baselineUsage))}\n`;
    await fs.writeFile(rolloutPath, baselineLine, "utf8");
    await fs.appendFile(
      rolloutPath,
      `${JSON.stringify(event(targetTimestamp, targetUsage))}\n`,
      "utf8",
    );
    const stat = await fs.stat(rolloutPath);
    const cursors = {
      version: 1,
      files: {
        [rolloutPath]: {
          inode: stat.ino,
          offset: Buffer.byteLength(baselineLine),
        },
      },
      codexHashes: [`${sessionId}:${baselineTimestamp}`],
    };
    const diagnostics = {};

    const result = await parseRolloutIncremental({
      rolloutFiles: [{ path: rolloutPath, source: "codex" }],
      cursors,
      queuePath: path.join(root, "queue.jsonl"),
      diagnostics,
    });

    assert.equal(result.eventsAggregated, 1);
    assert.equal(diagnostics.hash_set_constructions, 1);
    assert.deepEqual(cursors.files[rolloutPath].lastTotal, targetUsage);
    assert.deepEqual(cursors.codexHashes, [
      `${sessionId}:${baselineTimestamp}`,
      `${sessionId}:${targetTimestamp}`,
    ]);
    const codexTotal = Object.entries(cursors.hourly.buckets)
      .filter(([key]) => key.startsWith("codex|"))
      .reduce((sum, [, bucket]) => sum + Number(bucket.totals.total_tokens || 0), 0);
    assert.equal(codexTotal, 20, "only the cumulative growth after the legacy cursor is new");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an inode rewrite still uses historical Codex hashes without rematerializing the array", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-sync-rewrite-hot-"));
  try {
    const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const timestamp = "2030-06-02T01:00:00.000Z";
    const rolloutPath = path.join(
      root,
      `rollout-2030-06-02T00-00-00-${sessionId}.jsonl`,
    );
    await fs.writeFile(rolloutPath, `${JSON.stringify({
      timestamp,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 10,
            cached_input_tokens: 2,
            cache_creation_input_tokens: 0,
            output_tokens: 3,
            reasoning_output_tokens: 1,
            total_tokens: 13,
          },
        },
      },
    })}\n`, "utf8");
    const stat = await fs.stat(rolloutPath);
    const hashes = [`${sessionId}:${timestamp}`];
    const observedHashes = observeWholeArrayReads(hashes);
    const cursors = {
      version: 1,
      files: {
        [rolloutPath]: { inode: stat.ino + 1, offset: stat.size, lastTotal: null },
      },
      codexHashes: observedHashes.proxy,
    };
    const diagnostics = {};

    const result = await parseRolloutIncremental({
      rolloutFiles: [rolloutPath],
      cursors,
      queuePath: path.join(root, "queue.jsonl"),
      source: "codex",
      diagnostics,
    });

    assert.equal(result.eventsAggregated, 0);
    assert.equal(diagnostics.hash_set_constructions, 1);
    assert.equal(diagnostics.hash_array_materializations, 0);
    assert.strictEqual(cursors.codexHashes, observedHashes.proxy);
    assert.equal(observedHashes.metrics.iterator_reads, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the cumulative-delta migration rebuilds Codex hashes when a session has a stale path cursor", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-sync-migration-"));
  try {
    const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const timestamp = "2030-06-02T01:00:00.000Z";
    const livePath = path.join(
      root,
      "sessions",
      "2030",
      "06",
      "02",
      `rollout-2030-06-02T00-00-00-${sessionId}.jsonl`,
    );
    const archivedPath = path.join(
      root,
      "archived_sessions",
      `rollout-2030-06-02T00-00-00-${sessionId}.jsonl`,
    );
    await fs.mkdir(path.dirname(archivedPath), { recursive: true });
    await fs.writeFile(archivedPath, `${JSON.stringify({
      timestamp,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 10,
            cached_input_tokens: 2,
            cache_creation_input_tokens: 0,
            output_tokens: 3,
            reasoning_output_tokens: 1,
            total_tokens: 13,
          },
        },
      },
    })}\n`, "utf8");
    const stat = await fs.stat(archivedPath);
    const queuePath = path.join(root, "queue.jsonl");
    const cursors = {
      version: 1,
      files: {
        [livePath]: { inode: stat.ino, offset: stat.size },
        [archivedPath]: { inode: stat.ino, offset: stat.size },
      },
      codexHashes: [`${sessionId}:${timestamp}`],
      hourly: {
        buckets: {
          "codex|unknown|2030-06-02T01:00:00.000Z": {
            totals: { total_tokens: 13 },
          },
        },
        groupQueued: {},
      },
    };

    await migrateRolloutCumulativeDeltaBuckets({
      cursors,
      queuePath,
      rolloutFiles: [{ path: archivedPath, source: "codex" }],
    });
    const result = await parseRolloutIncremental({
      rolloutFiles: [{ path: archivedPath, source: "codex" }],
      cursors,
      queuePath,
    });

    assert.equal(result.eventsAggregated, 1);
    assert.deepEqual(cursors.codexHashes, [`${sessionId}:${timestamp}`]);
    assert.equal(
      cursors.hourly.buckets["codex|unknown|2030-06-02T01:00:00.000Z"].totals.total_tokens,
      13,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("source-scoped sync preserves audit state and reports the actual cursor commit path and bytes", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-sync-commit-"));
  const restoreHome = withHome(home);
  const previousCodexHome = process.env.CODEX_HOME;
  const RealDate = Date;
  const fixedNow = "2030-06-02T12:34:56.789Z";
  const fixedNowMs = RealDate.parse(fixedNow);
  global.Date = class FixedDate extends RealDate {
    constructor(...args) {
      super(...(args.length > 0 ? args : [fixedNowMs]));
    }

    static now() {
      return fixedNowMs;
    }
  };
  try {
    const codexHome = path.join(home, ".codex");
    const trackerDir = path.join(home, ".tokentracker", "tracker");
    const cursorsPath = path.join(trackerDir, "cursors.json");
    await fs.mkdir(path.join(codexHome, "sessions"), { recursive: true });
    await fs.mkdir(trackerDir, { recursive: true });
    process.env.CODEX_HOME = codexHome;

    const auditState = {
      version: 1,
      lastFullScanAtMs: Date.UTC(2030, 5, 1),
      lastFullScanAt: "2030-06-01T00:00:00.000Z",
      syncsSinceFullScan: 7,
      lastSkippedFiles: 123,
      updatedAt: "2030-06-01T00:00:00.000Z",
    };
    const hashes = buildProductionScaleHashes();
    const initial = {
      version: 1,
      files: {},
      codexHashes: hashes,
      codexColdScanAudit: auditState,
    };
    await fs.writeFile(cursorsPath, `${JSON.stringify(initial)}\n`, "utf8");

    const diagnostics = {};
    await cmdSync(
      ["--auto", "--from-retry", "--source=codex"],
      { diagnostics },
    );

    const raw = await fs.readFile(cursorsPath, "utf8");
    const persisted = JSON.parse(raw);
    assert.deepEqual(persisted, {
      ...initial,
      codexDayInventoryCache: { version: 1, days: {} },
      hourly: {
        version: 3,
        buckets: {},
        groupQueued: {},
        updatedAt: fixedNow,
      },
      projectHourly: {
        version: 2,
        buckets: {},
        projects: {},
        updatedAt: fixedNow,
      },
      updatedAt: fixedNow,
    });
    assert.deepEqual(diagnostics, {
      discovered_rollouts: 0,
      cursor_keys: 0,
      parse_candidates: 0,
      stat_candidates: 0,
      cold_skipped: 0,
      content_files_read: 0,
      hash_set_constructions: 0,
      hash_array_materializations: 0,
      hash_array_materialized_items: 0,
      codex_hash_count: LARGE_HASH_COUNT,
      cursor_commits: 1,
      cursor_bytes: Buffer.byteLength(raw),
      cursor_path: cursorsPath,
    });
  } finally {
    global.Date = RealDate;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    restoreHome();
    await fs.rm(home, { recursive: true, force: true });
  }
});
