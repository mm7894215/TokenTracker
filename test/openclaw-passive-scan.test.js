"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  resolveOpenclawSessionFiles,
  resolveOpenclawHome,
  resolveOpenclawHomes,
  parseOpenclawIncremental,
  openclawCursorKey,
} = require("../src/lib/rollout");

function tmpdir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function usageLine({ id, timestamp, model = "claude-opus-4.7" }) {
  return JSON.stringify({
    type: "message",
    id,
    timestamp,
    message: {
      role: "assistant",
      model,
      usage: { input: 1200, cacheRead: 1000, cacheWrite: 800, output: 50, totalTokens: 3050 },
    },
  });
}

function queueRows(queuePath) {
  if (!fs.existsSync(queuePath)) return [];
  return fs
    .readFileSync(queuePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("resolveOpenclawSessionFiles discovers transcripts across every agent", async (t) => {
  const dir = tmpdir(t, "tokentracker-openclaw-scan-");
  const home = path.join(dir, "openclaw");
  const mainSessions = path.join(home, "agents", "main", "sessions");
  const wechatSessions = path.join(home, "agents", "wechat-bot", "sessions");
  fs.mkdirSync(mainSessions, { recursive: true });
  fs.mkdirSync(wechatSessions, { recursive: true });
  fs.writeFileSync(path.join(mainSessions, "s1.jsonl"), "");
  // A channel-style session that the plugin's sessions.json mapping never sees.
  fs.writeFileSync(path.join(wechatSessions, "s2.jsonl"), "");
  // Non-transcript files must be ignored.
  fs.writeFileSync(path.join(mainSessions, "sessions.json"), "{}");

  const files = await resolveOpenclawSessionFiles({ TOKENTRACKER_OPENCLAW_HOME: home });
  assert.deepEqual(files, [
    path.join(mainSessions, "s1.jsonl"),
    path.join(wechatSessions, "s2.jsonl"),
  ]);
});

test("resolveOpenclawSessionFiles returns empty when no OpenClaw home exists", async (t) => {
  const dir = tmpdir(t, "tokentracker-openclaw-none-");
  const files = await resolveOpenclawSessionFiles({
    TOKENTRACKER_OPENCLAW_HOME: path.join(dir, "does-not-exist"),
  });
  assert.deepEqual(files, []);
});

test("passively scanned channel session usage is counted without a plugin trigger", async (t) => {
  const dir = tmpdir(t, "tokentracker-openclaw-passive-");
  const home = path.join(dir, "openclaw");
  const sessions = path.join(home, "agents", "wechat-bot", "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  const sessionFile = path.join(sessions, "channel-1.jsonl");
  fs.writeFileSync(
    sessionFile,
    usageLine({ id: "evt-1", timestamp: "2026-07-07T13:31:00.000Z" }) + "\n",
  );
  const queuePath = path.join(dir, "queue.jsonl");

  const discovered = await resolveOpenclawSessionFiles({ TOKENTRACKER_OPENCLAW_HOME: home });
  assert.equal(discovered.length, 1);

  const cursors = { version: 1, files: {}, updatedAt: null };
  const res = await parseOpenclawIncremental({
    sessionFiles: discovered.map((p) => ({ path: p, source: "openclaw" })),
    cursors,
    queuePath,
  });
  assert.equal(res.eventsAggregated, 1);

  const rows = queueRows(queuePath);
  const total = rows.reduce((s, r) => s + (r.total_tokens || 0), 0);
  assert.ok(total > 0, "channel usage aggregated to a nonzero total");

  // Re-running (e.g. a later plugin trigger for the same file) must not
  // double-count, thanks to event-identity dedup.
  const again = await parseOpenclawIncremental({
    sessionFiles: discovered.map((p) => ({ path: p, source: "openclaw" })),
    cursors,
    queuePath,
  });
  assert.equal(again.eventsAggregated, 0, "passive re-scan is idempotent");
});

test("resolveOpenclawSessionFiles picks up reset/deleted archives and the SQLite import archive", async (t) => {
  const dir = tmpdir(t, "tokentracker-openclaw-archive-");
  const home = path.join(dir, "openclaw");
  const sessions = path.join(home, "agents", "main", "sessions");
  // The SQLite migration moves still-hot transcripts to a SIBLING directory.
  const importArchive = path.join(home, "agents", "main", "session-sqlite-import-archive");
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(importArchive, { recursive: true });
  fs.writeFileSync(path.join(sessions, "s1.jsonl"), "");
  fs.writeFileSync(path.join(sessions, "s1.jsonl.reset.2026-03-20T06-34-44.520Z"), "");
  fs.writeFileSync(path.join(sessions, "s2.jsonl.deleted.1774000000000"), "");
  // Telegram topic sessions carry a suffix before the extension.
  fs.writeFileSync(path.join(sessions, "s3-topic-42.jsonl"), "");
  // Neither the store index nor arbitrary json may be treated as a transcript.
  fs.writeFileSync(path.join(sessions, "sessions.json"), "{}");
  fs.writeFileSync(path.join(importArchive, "migrated.jsonl"), "");

  const files = await resolveOpenclawSessionFiles({ TOKENTRACKER_OPENCLAW_HOME: home });
  assert.deepEqual(files.map((f) => path.basename(f)).sort(), [
    "migrated.jsonl",
    "s1.jsonl",
    "s1.jsonl.reset.2026-03-20T06-34-44.520Z",
    "s2.jsonl.deleted.1774000000000",
    "s3-topic-42.jsonl",
  ]);
});

test("resolveOpenclawHome keeps os.homedir() as its base so existing cursors keep matching", () => {
  // Git Bash / MSYS set a POSIX-style HOME that differs from os.homedir(). If
  // that leaked into the path we build, every existing cursor key would miss
  // and the whole transcript history would be re-counted.
  const gitBash = { HOME: "/c/Users/rocky", USERPROFILE: "C:\\Users\\rocky" };
  assert.equal(resolveOpenclawHome(gitBash), path.join(os.homedir(), ".openclaw"));
  assert.equal(resolveOpenclawHome({}), path.join(os.homedir(), ".openclaw"));
  // OpenClaw's own overrides are still honoured, in its precedence order.
  assert.equal(resolveOpenclawHome({ OPENCLAW_HOME: "/srv/oc" }), "/srv/oc");
  assert.equal(resolveOpenclawHome({ OPENCLAW_STATE_DIR: "/srv/state" }), "/srv/state");
  assert.equal(
    resolveOpenclawHome({ OPENCLAW_HOME: "/srv/oc", OPENCLAW_STATE_DIR: "/srv/state" }),
    "/srv/oc",
    "OPENCLAW_HOME outranks OPENCLAW_STATE_DIR",
  );
});

test("on Windows the WSL distro home is scanned too", () => {
  // The recommended Windows install runs the gateway inside an app-owned WSL
  // distro, leaving %USERPROFILE%\\.openclaw empty (issue #264).
  const wslRoot = "\\\\wsl.localhost\\OpenClawGateway\\home\\rocky\\.openclaw";
  const homes = resolveOpenclawHomes(
    { USERPROFILE: "C:\\Users\\rocky" },
    { platform: "win32", discoverWslHome: () => wslRoot },
  );
  assert.ok(homes.includes(wslRoot), "WSL state dir must be scanned on win32");

  // An explicit override means the user told us where to look — don't probe.
  const overridden = resolveOpenclawHomes(
    { TOKENTRACKER_OPENCLAW_HOME: "D:\\oc" },
    { platform: "win32", discoverWslHome: () => wslRoot },
  );
  assert.deepEqual(overridden, ["D:\\oc"]);

  // Non-Windows never probes WSL.
  assert.deepEqual(
    resolveOpenclawHomes({}, { platform: "darwin", discoverWslHome: () => wslRoot }),
    [path.join(os.homedir(), ".openclaw")],
  );
});

test("a transcript with real usage flags its cursor as hasRealUsage", async (t) => {
  const dir = tmpdir(t, "tokentracker-openclaw-hasrealusage-");
  const sessionFile = path.join(dir, "s.jsonl");
  fs.writeFileSync(
    sessionFile,
    usageLine({ id: "evt-1", timestamp: "2026-07-07T13:31:00.000Z" }) + "\n",
  );
  const queuePath = path.join(dir, "queue.jsonl");
  const cursors = { version: 1, files: {}, updatedAt: null };
  await parseOpenclawIncremental({
    sessionFiles: [{ path: sessionFile, source: "openclaw" }],
    cursors,
    queuePath,
  });
  const cursor = cursors.files[openclawCursorKey(sessionFile)];
  assert.ok(cursor, "expected a cursor for the parsed transcript");
  assert.equal(cursor.hasRealUsage, true, "real usage marks the cursor so the totals fallback defers");
});

test("a cursor written before hasRealUsage existed recovers the flag on the next sync", async (t) => {
  // Upgrade path: users who already had OpenClaw history carry cursors with no
  // hasRealUsage field. Their transcripts are unchanged, so a steady-state sync
  // aggregates 0 new events — if the flag only tracked eventsAggregated it
  // would stay false forever and applyOpenclawTotalsFallback would keep
  // double counting for exactly the users most likely to have real usage.
  const dir = tmpdir(t, "tokentracker-openclaw-upgrade-");
  const sessionFile = path.join(dir, "s.jsonl");
  fs.writeFileSync(
    sessionFile,
    usageLine({ id: "evt-1", timestamp: "2026-07-07T13:31:00.000Z" }) + "\n",
  );
  const queuePath = path.join(dir, "queue.jsonl");
  const cursors = { version: 1, files: {}, updatedAt: null };

  await parseOpenclawIncremental({
    sessionFiles: [{ path: sessionFile, source: "openclaw" }],
    cursors,
    queuePath,
  });
  const key = openclawCursorKey(sessionFile);
  // Downgrade the cursor to its pre-flag shape.
  delete cursors.files[key].hasRealUsage;

  const steadyState = await parseOpenclawIncremental({
    sessionFiles: [{ path: sessionFile, source: "openclaw" }],
    cursors,
    queuePath,
  });
  assert.equal(steadyState.eventsAggregated, 0, "nothing new on disk");
  assert.equal(
    cursors.files[key].hasRealUsage,
    true,
    "flag recovered from the recorded usage events, not from this run's event count",
  );
});

