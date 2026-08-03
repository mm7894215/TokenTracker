const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const fssync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
// child_process is used only for sqlite3 write fixtures; route them through
// in-process node:sqlite (see helpers/sqlite-write) to avoid per-statement spawns.
const { sqliteOnlyCp: cp } = require("./helpers/sqlite-write");

const { cmdSync } = require("../src/commands/sync");
const { withHome } = require("./helpers/with-home");

async function readJsonLines(filePath) {
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  return raw
    .split(/\n+/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("cmdSync ignores WorkBuddy context-only SQLite snapshots instead of billing them", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-sync-workbuddy-"));
  const prevEnv = {
    CODEX_HOME: process.env.CODEX_HOME,
    CODE_HOME: process.env.CODE_HOME,
    GEMINI_HOME: process.env.GEMINI_HOME,
    OPENCODE_HOME: process.env.OPENCODE_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    WORKBUDDY_HOME: process.env.WORKBUDDY_HOME,
  };
  const restoreHome = withHome(tmp);
  try {
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    process.env.CODE_HOME = path.join(tmp, ".code");
    process.env.GEMINI_HOME = path.join(tmp, ".gemini");
    process.env.OPENCODE_HOME = path.join(tmp, ".opencode");
    process.env.XDG_DATA_HOME = path.join(tmp, ".local", "share");
    process.env.WORKBUDDY_HOME = path.join(tmp, ".workbuddy");

    await fs.mkdir(process.env.WORKBUDDY_HOME, { recursive: true });
    const dbPath = path.join(process.env.WORKBUDDY_HOME, "workbuddy.db");
    cp.execFileSync("sqlite3", [
      dbPath,
      [
        "CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, model TEXT);",
        "CREATE TABLE session_usage (session_id TEXT PRIMARY KEY, used INTEGER, size INTEGER, updated_at INTEGER, credit_json TEXT);",
        "INSERT INTO sessions VALUES ('sync-s1','/tmp/project','auto');",
        "INSERT INTO session_usage VALUES ('sync-s1',100,0,1780000000000,'{}');",
      ].join(" "),
    ]);

    await cmdSync(["--auto", "--from-notify", "--source=workbuddy"]);
    const queuePath = path.join(tmp, ".tokentracker", "tracker", "queue.jsonl");
    let rows = await readJsonLines(queuePath);
    assert.equal(rows.length, 0);

    await cmdSync(["--auto", "--from-notify", "--source=workbuddy"]);
    rows = await readJsonLines(queuePath);
    assert.equal(rows.length, 0, "unchanged context snapshot must remain non-billable");

    cp.execFileSync("sqlite3", [
      dbPath,
      "UPDATE session_usage SET used=150, updated_at=1780000010000 WHERE session_id='sync-s1';",
    ]);
    await cmdSync(["--auto", "--from-notify", "--source=workbuddy"]);
    rows = await readJsonLines(queuePath);
    assert.equal(rows.length, 0, "context-window growth is not token usage");
  } finally {
    restoreHome();
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (fssync.existsSync(tmp)) {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }
});
