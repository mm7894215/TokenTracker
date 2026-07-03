// Self-contained dual-install test. Run from repo root:
//   node test/windows-dual-install-test.cjs
// Creates temp dirs, SQLite DBs, runs resolver + parser pipeline.
// No real data touched. Cleanup on exit.

const path = require("path");
const fs = require("fs");
const os = require("os");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-dual-test-"));
const nativeDir = path.join(tmpDir, "native", "hermes");
const wslDir = path.join(tmpDir, "wsl", "hermes");
const queuePath = path.join(tmpDir, "queue.jsonl");
let exitCode = 0;

function cleanup() {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { }
}

try {
  console.log("=== WSL Dual-Install Test ===\n");

  // ── 1. Create SQLite databases ──
  fs.mkdirSync(nativeDir, { recursive: true });
  fs.mkdirSync(wslDir, { recursive: true });
  const nativeDb = path.join(nativeDir, "state.db");
  const wslDb = path.join(wslDir, "state.db");

  const { DatabaseSync } = require("node:sqlite");
  const t = Math.floor(new Date("2026-01-01T10:30:00.000Z").getTime() / 1000);

  function createHermesDb(dbPath, sessions) {
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, source TEXT, model TEXT,
      started_at REAL, ended_at REAL,
      input_tokens INTEGER, output_tokens INTEGER,
      cache_read_tokens INTEGER, cache_write_tokens INTEGER,
      reasoning_tokens INTEGER, message_count INTEGER
    )`);
    const stmt = db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?)");
    for (const s of sessions) stmt.run(...s);
    db.close();
  }

  createHermesDb(nativeDb, [
    ["nat-s1", "native", "gpt-4", t, t + 3600, 200, 100, 0, 0, 0, 5],
    ["nat-s2", "native", "gpt-4", t + 7200, t + 10800, 300, 150, 0, 0, 0, 8],
  ]);

  createHermesDb(wslDb, [
    ["wsl-s1", "wsl", "gpt-4", t, t + 1800, 100, 50, 0, 0, 0, 3],
  ]);

  console.log("SQLite databases created");
  console.log("  Native:", nativeDb);
  console.log("  WSL:", wslDb);

  // ── 2. Test resolver ──
  console.log("\n--- Resolver test ---");
  const { resolveInstallPaths } = require("./src/lib/install-resolver");
  const paths = resolveInstallPaths("hermes", {
    nativeValue: nativeDir,
    wslValue: wslDir,
  }, { ...process.env, TOKENTRACKER_WSL_MODE: "both" });

  console.log("  Native:", paths.native);
  console.log("  WSL:", paths.wsl);
  if (!paths.native || !paths.wsl) {
    throw new Error(`Resolver returned null paths: native=${paths.native} wsl=${paths.wsl}`);
  }
  console.log("  PASS");

  // ── 3. Test parser through multiInstallParse ──
  console.log("\n--- Parser test ---");
  const { multiInstallParse } = require("./src/lib/multi-install-parser");
  const { parseHermesIncremental } = require("./src/lib/rollout");
  const cursors = { hourly: { buckets: {} } };

  const result = await multiInstallParse({
    paths,
    parserFn: parseHermesIncremental,
    providerName: "hermes",
    cursors,
    getParams: (installPath) => ({ hermesPath: installPath }),
    queuePath,
    env: { ...process.env, TOKENTRACKER_WSL_MODE: "both" },
  });

  console.log("  Records:", result.recordsProcessed);
  console.log("  Events:", result.eventsAggregated);
  console.log("  Buckets:", result.bucketsQueued);

  if (result.recordsProcessed < 3) {
    throw new Error(`Expected >=3 records from 3 sessions, got ${result.recordsProcessed}`);
  }

  // ── 4. Validate queue output ──
  console.log("\n--- Queue validation ---");
  const queueRows = fs.readFileSync(queuePath, "utf8").trim().split("\n").filter(Boolean);
  console.log("  Queue rows:", queueRows.length);
  for (const row of queueRows) {
    const parsed = JSON.parse(row);
    console.log(`  source=${parsed.source} model=${parsed.model} hour=${parsed.hour_start} in=${parsed.input_tokens} out=${parsed.output_tokens}`);
  }

  const totalInput = queueRows.reduce((sum, r) => sum + (JSON.parse(r).input_tokens || 0), 0);
  const totalOutput = queueRows.reduce((sum, r) => sum + (JSON.parse(r).output_tokens || 0), 0);
  console.log(`\n  Total input: ${totalInput} (expected >=600)`);
  console.log(`  Total output: ${totalOutput} (expected >=300)`);

  if (totalInput < 600 || totalOutput < 300) {
    throw new Error(`Aggregated totals too low: in=${totalInput} out=${totalOutput}`);
  }
  console.log("\n  ALL PASS");

} catch (err) {
  console.error("\n  FAIL:", err.message);
  exitCode = 1;
} finally {
  cleanup();
  console.log("\nCleaned up:", tmpDir);
  process.exit(exitCode);
}
