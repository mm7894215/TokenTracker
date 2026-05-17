const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { parseKiroIncremental } = require("../src/lib/rollout.js");

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kiro-fallback-"));
}

function writeJsonl(filePath, events) {
  const lines = events
    .map((e) => JSON.stringify({ model: "claude-sonnet-4", provider: "kiro", ...e }))
    .join("\n");
  fs.writeFileSync(filePath, lines + "\n");
}

function seedSqlite(dbPath, events) {
  execFileSync("sqlite3", [
    dbPath,
    "CREATE TABLE tokens_generated (id INTEGER PRIMARY KEY AUTOINCREMENT, tokens_prompt INTEGER, tokens_generated INTEGER, model TEXT, provider TEXT, timestamp TEXT);",
  ]);
  for (const e of events) {
    execFileSync("sqlite3", [
      dbPath,
      `INSERT INTO tokens_generated (tokens_prompt, tokens_generated, model, provider, timestamp) VALUES (${e.promptTokens}, ${e.generatedTokens}, 'claude-sonnet-4', 'kiro', '2026-04-19 08:00:00');`,
    ]);
  }
}

test("kiro DB→JSONL fallback does not re-read rows the DB path already consumed", async (t) => {
  try {
    execFileSync("sqlite3", ["-version"], { stdio: "ignore" });
  } catch {
    t.skip("sqlite3 not available");
    return;
  }

  const tmp = makeTmpDir();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const dbPath = path.join(tmp, "kiro.db");
  const jsonlPath = path.join(tmp, "kiro.jsonl");
  const queuePath = path.join(tmp, "queue.jsonl");
  const events = [
    { promptTokens: 100, generatedTokens: 50 },
    { promptTokens: 200, generatedTokens: 60 },
    { promptTokens: 300, generatedTokens: 70 },
  ];
  writeJsonl(jsonlPath, events);
  seedSqlite(dbPath, events);

  const cursors = {};

  // Run 1: DB present. DB consumes all 3 rows AND the JSONL line cursor
  // must be advanced to the JSONL tail so fallback won't re-read them.
  const r1 = await parseKiroIncremental({ dbPath, jsonlPath, cursors, queuePath });
  assert.equal(r1.eventsAggregated, 3);
  assert.equal(cursors.kiro.lastDbId, 3);
  assert.equal(cursors.kiro.jsonl.lastLine, 3);

  // Run 2: DB gone. JSONL fallback must see zero new rows — the 3 rows the
  // DB path already handled must NOT be double-counted.
  fs.unlinkSync(dbPath);
  const r2 = await parseKiroIncremental({ dbPath, jsonlPath, cursors, queuePath });
  assert.equal(r2.eventsAggregated, 0);

  // Run 3: append one genuinely new JSONL row; only that should be counted.
  fs.appendFileSync(
    jsonlPath,
    JSON.stringify({ model: "claude-sonnet-4", provider: "kiro", promptTokens: 400, generatedTokens: 80 }) + "\n",
  );
  const r3 = await parseKiroIncremental({ dbPath, jsonlPath, cursors, queuePath });
  assert.equal(r3.eventsAggregated, 1);
});
