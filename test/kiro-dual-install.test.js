/**
 * Kiro IDE WSL dual-install support (#306).
 *
 * Verifies:
 *   - multiInstallParse over two Kiro IDE installs keeps lastDbId / jsonl
 *     cursors namespaced per install (native vs wsl) with no double count
 *   - second run is a zero-delta no-op for both namespaces
 *   - the .chat model timeline is built from the SAME install as the rows
 *     being parsed (basePath parameterization)
 *   - JSONL fallback line cursors stay isolated per install
 *   - kiroInstallOwnsCursor flat-cursor migration probe semantics
 *   - resolveKiroBasePath platform branches
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { runSql } = require("./helpers/sqlite-write");
const { mockPlatform } = require("./helpers/mock");

const { multiInstallParse } = require("../src/lib/multi-install-parser");
const {
  parseKiroIncremental,
  kiroInstallOwnsCursor,
  resolveKiroBasePath,
  resolveKiroDbPath,
  resolveKiroJsonlPath,
} = require("../src/lib/rollout");

function tmpdir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Creates <base>/dev_data/devdata.sqlite with tokens_generated rows.
// rows: [{ id, prompt, generated, timestamp }]
function makeKiroInstall(base, rows) {
  const devData = path.join(base, "dev_data");
  fs.mkdirSync(devData, { recursive: true });
  const inserts = rows
    .map(
      (r) =>
        `INSERT INTO tokens_generated (id, model, provider, tokens_prompt, tokens_generated, timestamp) ` +
        `VALUES (${r.id}, 'agent', 'kiro', ${r.prompt}, ${r.generated}, '${r.timestamp}');`,
    )
    .join("\n");
  runSql(
    path.join(devData, "devdata.sqlite"),
    `CREATE TABLE tokens_generated (id INTEGER PRIMARY KEY, model TEXT, provider TEXT, ` +
      `tokens_prompt INTEGER, tokens_generated INTEGER, timestamp TEXT);\n${inserts}`,
  );
  return base;
}

function getParamsFor(base) {
  return {
    basePath: base,
    dbPath: resolveKiroDbPath(base),
    jsonlPath: resolveKiroJsonlPath(base),
  };
}

// queue.jsonl is append-only and buckets carry cumulative absolutes; readers
// take the LATEST entry per (source, model, hour_start).
function sumLatestPerBucket(rows, field) {
  const latest = new Map();
  for (const r of rows) latest.set(`${r.source}|${r.model}|${r.hour_start}`, r);
  return [...latest.values()].reduce((s, r) => s + (r[field] || 0), 0);
}

test("kiro IDE dual-install: cursors namespaced per install, totals sum, second run idle", async (t) => {
  const dir = tmpdir(t, "kiro-dual-");
  const native = makeKiroInstall(path.join(dir, "native"), [
    { id: 1, prompt: 100, generated: 10, timestamp: "2026-01-09 10:05:00" },
    { id: 2, prompt: 200, generated: 20, timestamp: "2026-01-09 10:10:00" },
  ]);
  const wsl = makeKiroInstall(path.join(dir, "wsl"), [
    { id: 1, prompt: 1000, generated: 100, timestamp: "2026-01-09 11:05:00" },
    { id: 2, prompt: 2000, generated: 200, timestamp: "2026-01-09 11:10:00" },
    { id: 3, prompt: 3000, generated: 300, timestamp: "2026-01-09 11:20:00" },
  ]);

  const queuePath = path.join(dir, "queue.jsonl");
  const cursors = {};
  const result = await multiInstallParse({
    paths: { native, wsl },
    parserFn: parseKiroIncremental,
    providerName: "kiro",
    cursors,
    getParams: getParamsFor,
    queuePath,
  });

  assert.equal(result.recordsProcessed, 5, "2 native + 3 wsl rows");
  // Per-install AUTOINCREMENT id cursors MUST NOT be shared: both DBs count
  // from 1, sharing one lastDbId would skip or double rows.
  assert.equal(cursors.kiro.native.lastDbId, 2);
  assert.equal(cursors.kiro.wsl.lastDbId, 3);

  const rows = fs
    .readFileSync(queuePath, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.equal(sumLatestPerBucket(rows, "input_tokens"), 100 + 200 + 1000 + 2000 + 3000, "no double count across installs");
  assert.equal(sumLatestPerBucket(rows, "output_tokens"), 10 + 20 + 100 + 200 + 300);
  assert.ok(rows.every((r) => r.source === "kiro"));

  // Second run: both namespaces are caught up → zero delta.
  const again = await multiInstallParse({
    paths: { native, wsl },
    parserFn: parseKiroIncremental,
    providerName: "kiro",
    cursors,
    getParams: getParamsFor,
    queuePath,
  });
  assert.equal(again.recordsProcessed, 0);
  assert.equal(again.eventsAggregated, 0);
});

test("kiro IDE dual-install: model timeline comes from the row's own install", async (t) => {
  const dir = tmpdir(t, "kiro-dual-model-");
  const rowTs = "2026-01-09 11:05:00";
  const rowMs = Date.parse(rowTs.replace(" ", "T") + "Z");
  const native = makeKiroInstall(path.join(dir, "native"), [
    { id: 1, prompt: 100, generated: 10, timestamp: rowTs },
  ]);
  const wsl = makeKiroInstall(path.join(dir, "wsl"), [
    { id: 1, prompt: 50, generated: 5, timestamp: rowTs },
  ]);
  // .chat metadata exists ONLY in the wsl install; the native install's rows
  // must NOT pick it up (pre-#306 the timeline was always resolved from the
  // process-global base path).
  const chatDir = path.join(wsl, "session-1");
  fs.mkdirSync(chatDir, { recursive: true });
  fs.writeFileSync(
    path.join(chatDir, "a.chat"),
    JSON.stringify({
      metadata: {
        modelId: "CLAUDE_SONNET_4_20250514_V1_0",
        startTime: rowMs - 60_000,
        endTime: rowMs + 60_000,
      },
    }),
  );

  const queuePath = path.join(dir, "queue.jsonl");
  const cursors = {};
  await multiInstallParse({
    paths: { native, wsl },
    parserFn: parseKiroIncremental,
    providerName: "kiro",
    cursors,
    getParams: getParamsFor,
    queuePath,
  });

  const rows = fs
    .readFileSync(queuePath, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const byModel = new Map(rows.map((r) => [r.model, r]));
  assert.ok(byModel.has("claude-sonnet-4"), "wsl row resolves model from its own .chat timeline");
  assert.ok(byModel.has("kiro-agent"), "native row falls back — no .chat files in its install");
  assert.equal(byModel.get("claude-sonnet-4").input_tokens, 50);
  assert.equal(byModel.get("kiro-agent").input_tokens, 100);
});

test("kiro IDE dual-install: JSONL fallback line cursors are isolated", async (t) => {
  const dir = tmpdir(t, "kiro-dual-jsonl-");
  const mkJsonl = (base, lines) => {
    const devData = path.join(base, "dev_data");
    fs.mkdirSync(devData, { recursive: true });
    fs.writeFileSync(
      path.join(devData, "tokens_generated.jsonl"),
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    );
    return base;
  };
  const native = mkJsonl(path.join(dir, "native"), [
    { model: "agent", provider: "kiro", promptTokens: 10, generatedTokens: 1 },
  ]);
  const wsl = mkJsonl(path.join(dir, "wsl"), [
    { model: "agent", provider: "kiro", promptTokens: 20, generatedTokens: 2 },
    { model: "agent", provider: "kiro", promptTokens: 30, generatedTokens: 3 },
  ]);

  const queuePath = path.join(dir, "queue.jsonl");
  const cursors = {};
  const result = await multiInstallParse({
    paths: { native, wsl },
    parserFn: parseKiroIncremental,
    providerName: "kiro",
    cursors,
    getParams: getParamsFor,
    queuePath,
  });

  assert.equal(result.recordsProcessed, 3);
  assert.equal(cursors.kiro.native.jsonl.lastLine, 1);
  assert.equal(cursors.kiro.wsl.jsonl.lastLine, 2);
});

test("kiroInstallOwnsCursor: id-reach probe with fail-safe defaults", (t) => {
  const dir = tmpdir(t, "kiro-probe-");
  const longDb = resolveKiroDbPath(
    makeKiroInstall(path.join(dir, "long"), [
      { id: 1, prompt: 1, generated: 1, timestamp: "2026-01-09 10:00:00" },
      { id: 2, prompt: 1, generated: 1, timestamp: "2026-01-09 10:01:00" },
      { id: 3, prompt: 1, generated: 1, timestamp: "2026-01-09 10:02:00" },
    ]),
  );
  const shortDb = resolveKiroDbPath(
    makeKiroInstall(path.join(dir, "short"), [
      { id: 1, prompt: 1, generated: 1, timestamp: "2026-01-09 10:00:00" },
    ]),
  );

  // Flat cursor consumed up to id 3: only the long install can be its host.
  assert.equal(kiroInstallOwnsCursor(longDb, { lastDbId: 3 }), true);
  assert.equal(kiroInstallOwnsCursor(shortDb, { lastDbId: 3 }), false);
  // Legacy lastId fallback
  assert.equal(kiroInstallOwnsCursor(longDb, { lastId: 3 }), true);
  // No evidence → false (caller seeds every namespace)
  assert.equal(kiroInstallOwnsCursor(longDb, {}), false);
  assert.equal(kiroInstallOwnsCursor(longDb, { lastDbId: 0 }), false);
  assert.equal(kiroInstallOwnsCursor(longDb, null), false);
  // Missing DB → false
  assert.equal(kiroInstallOwnsCursor(path.join(dir, "nope.sqlite"), { lastDbId: 1 }), false);
});

// NOTE: one mockPlatform call per test — repeated t.mock.property on the same
// property in a single test hangs the process at teardown (Node 24).
test("resolveKiroBasePath: win32 branch", (t) => {
  mockPlatform(t, "win32");
  const p = resolveKiroBasePath({ APPDATA: "C:\\Users\\u\\AppData\\Roaming" });
  assert.ok(p.includes("AppData"));
  assert.ok(p.endsWith(path.join("Kiro", "User", "globalStorage", "kiro.kiroagent")));
});

test("resolveKiroBasePath: linux branch", (t) => {
  mockPlatform(t, "linux");
  const p = resolveKiroBasePath({ XDG_CONFIG_HOME: "/home/u/.config" });
  assert.equal(p, path.join("/home/u/.config", "Kiro", "User", "globalStorage", "kiro.kiroagent"));
  const pDefault = resolveKiroBasePath({});
  assert.ok(pDefault.includes(path.join(".config", "Kiro")));
});

test("resolveKiroBasePath: darwin branch", (t) => {
  mockPlatform(t, "darwin");
  const p = resolveKiroBasePath({});
  assert.ok(p.includes(path.join("Library", "Application Support", "Kiro")));
});
