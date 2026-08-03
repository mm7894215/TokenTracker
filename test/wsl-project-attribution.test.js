/**
 * WSL project attribution (#374).
 *
 * A WSL session records its cwd as a POSIX path (`/home/u/dev/app`) while the
 * transcript is read over the distro's UNC bridge. Probing that raw POSIX path
 * from Windows resolves it against the current drive, so project attribution
 * found no `.git` and every WSL session landed with a null projectKey — its
 * tokens still counted, but the project never appeared.
 *
 * Two layers are covered:
 *   - mapWslCwdToUnc / wslUncRoot: the pure POSIX -> UNC transform, including
 *     the shapes reported in #374 and every case that must stay untouched.
 *   - every parser call site that resolves a project from a recorded cwd:
 *     Claude, both Codex scans, oh-my-pi, the opencode-family DB parser
 *     (opencode / kilo-cli / mimo / zcode) and qoder. The mapped path is what
 *     actually reaches project resolution, so a WSL session ends up with a
 *     real projectRef/projectKey. The UNC string itself is unresolvable off
 *     Windows, so these stub the transform onto a real temp repo — what is
 *     under test here is the plumbing, not the string math.
 *
 * Two further tests pin the fix's blast radius: in-flight sessions self-heal,
 * finished ones are not retro-attributed.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const wsl = require("../src/lib/wsl-probe");
const {
  parseClaudeIncremental,
  parseRolloutIncremental,
  parseOpencodeDbIncremental,
  parseQoderDbIncremental,
  parseOmpIncremental,
} = require("../src/lib/rollout");

const WSL_TRANSCRIPT =
  "\\\\wsl$\\Ubuntu-24.04\\home\\alice\\.claude\\projects\\-home-alice-dev-app\\s.jsonl";

test("wslUncRoot extracts the distro prefix from a WSL transcript path", () => {
  assert.equal(wsl.wslUncRoot(WSL_TRANSCRIPT), "\\\\wsl$\\Ubuntu-24.04\\");
  assert.equal(
    wsl.wslUncRoot("\\\\wsl.localhost\\Debian\\home\\bob\\.codex\\sessions\\r.jsonl"),
    "\\\\wsl.localhost\\Debian\\",
  );
  // Forward-slash spelling of the same bridge.
  assert.equal(wsl.wslUncRoot("//wsl$/Ubuntu-24.04/home/alice/x.jsonl"), "\\\\wsl$\\Ubuntu-24.04\\");
  // Not a WSL bridge.
  assert.equal(wsl.wslUncRoot("\\\\fileserver\\share\\repo\\x.jsonl"), null);
  assert.equal(wsl.wslUncRoot("C:\\Users\\alice\\.claude\\projects\\x.jsonl"), null);
  assert.equal(wsl.wslUncRoot("/home/alice/.claude/projects/x.jsonl"), null);
  assert.equal(wsl.wslUncRoot(null), null);
  assert.equal(wsl.wslUncRoot(undefined), null);
});

test("mapWslCwdToUnc re-anchors a POSIX cwd onto the transcript's distro", () => {
  assert.equal(
    wsl.mapWslCwdToUnc("/home/alice/dev/app", WSL_TRANSCRIPT),
    "\\\\wsl$\\Ubuntu-24.04\\home\\alice\\dev\\app",
  );
  // The prefix comes from the transcript, so whichever spelling resolves on
  // this machine is the one used — \\wsl$ and \\wsl.localhost are not
  // interchangeable everywhere (#374).
  assert.equal(
    wsl.mapWslCwdToUnc("/home/bob/src/api", "\\\\wsl.localhost\\Debian\\home\\bob\\.codex\\r.jsonl"),
    "\\\\wsl.localhost\\Debian\\home\\bob\\src\\api",
  );
  // Distro names carrying dots and dashes survive intact, and a cwd outside
  // $HOME anchors at the distro root rather than under it.
  assert.equal(
    wsl.mapWslCwdToUnc("/srv/x", "\\\\wsl$\\docker-desktop\\home\\u\\.claude\\projects\\a\\s.jsonl"),
    "\\\\wsl$\\docker-desktop\\srv\\x",
  );
});

test("mapWslCwdToUnc leaves every non-WSL combination untouched", () => {
  // Native Windows transcript: nothing to re-anchor.
  assert.equal(
    wsl.mapWslCwdToUnc("/home/alice/dev/app", "C:\\Users\\alice\\.claude\\projects\\a\\s.jsonl"),
    "/home/alice/dev/app",
  );
  // Non-WSL UNC share.
  assert.equal(
    wsl.mapWslCwdToUnc("/home/alice/dev/app", "\\\\fileserver\\share\\s.jsonl"),
    "/home/alice/dev/app",
  );
  // Genuine POSIX host (macOS/Linux): the cwd is already probeable as-is.
  assert.equal(
    wsl.mapWslCwdToUnc("/Users/alice/dev/app", "/Users/alice/.claude/projects/a/s.jsonl"),
    "/Users/alice/dev/app",
  );
  // A Windows cwd inside a WSL-hosted transcript is not a POSIX path.
  assert.equal(wsl.mapWslCwdToUnc("C:\\dev\\app", WSL_TRANSCRIPT), "C:\\dev\\app");
  // Qoder's project_uri decodes a Windows path to "/C:/dev/app" — leading
  // slash, but re-anchoring it would invent \\wsl$\Distro\C:\dev\app.
  const fromFileUri = decodeURIComponent(new URL("file:///C:/dev/app").pathname);
  assert.equal(fromFileUri, "/C:/dev/app");
  assert.equal(wsl.mapWslCwdToUnc(fromFileUri, WSL_TRANSCRIPT), "/C:/dev/app");
  assert.equal(wsl.mapWslCwdToUnc("/c:/dev/app", WSL_TRANSCRIPT), "/c:/dev/app");
  // A real POSIX directory that merely starts with a single letter still maps.
  assert.equal(
    wsl.mapWslCwdToUnc("/c/dev/app", WSL_TRANSCRIPT),
    "\\\\wsl$\\Ubuntu-24.04\\c\\dev\\app",
  );
  // Already-mapped values are idempotent.
  const mapped = "\\\\wsl$\\Ubuntu-24.04\\home\\alice\\dev\\app";
  assert.equal(wsl.mapWslCwdToUnc(mapped, WSL_TRANSCRIPT), mapped);
  assert.equal(wsl.mapWslCwdToUnc(null, WSL_TRANSCRIPT), null);
  assert.equal(wsl.mapWslCwdToUnc(undefined, WSL_TRANSCRIPT), undefined);
});

// rollout.js calls through the shared wsl-probe module object, so swapping the
// export in place is the seam that lets the UNC leg run on any platform.
function stubCwdMapping(t, translate) {
  const original = wsl.mapWslCwdToUnc;
  const seen = [];
  wsl.mapWslCwdToUnc = (cwd, transcriptPath) => {
    seen.push({ cwd, transcriptPath });
    return translate(cwd, transcriptPath);
  };
  t.after(() => {
    wsl.mapWslCwdToUnc = original;
  });
  return seen;
}

async function makeRepo(tmp, name, remote) {
  const repoRoot = path.join(tmp, name);
  await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
  await fs.writeFile(
    path.join(repoRoot, ".git", "config"),
    `[remote "origin"]\n\turl = ${remote}\n`,
    "utf8",
  );
  return repoRoot;
}

async function readJsonLines(filePath) {
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

test("parseClaudeIncremental attributes a WSL session through the mapped cwd", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-wsl-attr-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));

  const repoRoot = await makeRepo(tmp, "widgets", "https://github.com/acme/widgets.git");
  const posixCwd = "/home/alice/dev/widgets";
  const seen = stubCwdMapping(t, (cwd) => (cwd === posixCwd ? repoRoot : cwd));

  // Mirrors ~/.claude/projects/<dash-encoded-cwd>/: the storage dir is not the
  // checkout, so only the logged cwd can point at the repo.
  const storageDir = path.join(tmp, "-home-alice-dev-widgets");
  await fs.mkdir(storageDir, { recursive: true });
  const claudePath = path.join(storageDir, "session.jsonl");
  await fs.writeFile(
    claudePath,
    [
      JSON.stringify({ type: "attachment", cwd: posixCwd, timestamp: "2026-07-27T01:00:00.000Z" }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-27T01:10:00.000Z",
        requestId: "req-1",
        message: {
          id: "msg-1",
          model: "claude-sonnet-4",
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      }),
    ].join("\n") + "\n",
    "utf8",
  );

  const queuePath = path.join(tmp, "queue.jsonl");
  const projectQueuePath = path.join(tmp, "project.queue.jsonl");
  const cursors = { version: 1, files: {}, updatedAt: null };

  const res = await parseClaudeIncremental({
    projectFiles: [{ path: claudePath, source: "claude" }],
    cursors,
    queuePath,
    projectQueuePath,
  });
  assert.equal(res.filesProcessed, 1);

  // The transform is fed the raw POSIX cwd plus the transcript it came from.
  assert.deepEqual(seen, [{ cwd: posixCwd, transcriptPath: claudePath }]);

  const cursor = cursors.files[claudePath];
  assert.equal(cursor.projectKey, "acme/widgets");
  assert.equal(cursor.projectRef, "https://github.com/acme/widgets");
  assert.notEqual(cursor.projectFileContext?.absent, true);
  // The cursor keeps the session's real cwd; mapping is re-derived per sync.
  assert.equal(cursor.claudeCwd, posixCwd);

  const projectRows = await readJsonLines(projectQueuePath);
  assert.equal(projectRows.length, 1);
  assert.equal(projectRows[0].project_key, "acme/widgets");
});

test("parseClaudeIncremental still records absent context when the mapped cwd has no repo", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-wsl-attr-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));

  // Stands in for a WSL cwd that does not resolve at all — the pre-fix
  // behaviour must survive rather than throw.
  stubCwdMapping(t, () => path.join(tmp, "does", "not", "exist"));

  const storageDir = path.join(tmp, "-home-alice-tmp");
  await fs.mkdir(storageDir, { recursive: true });
  const claudePath = path.join(storageDir, "session.jsonl");
  await fs.writeFile(
    claudePath,
    [
      JSON.stringify({ type: "attachment", cwd: "/home/alice/tmp", timestamp: "2026-07-27T01:00:00.000Z" }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-27T01:10:00.000Z",
        requestId: "req-1",
        message: {
          id: "msg-1",
          model: "claude-sonnet-4",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }),
    ].join("\n") + "\n",
    "utf8",
  );

  const cursors = { version: 1, files: {}, updatedAt: null };
  await parseClaudeIncremental({
    projectFiles: [{ path: claudePath, source: "claude" }],
    cursors,
    queuePath: path.join(tmp, "queue.jsonl"),
    projectQueuePath: path.join(tmp, "project.queue.jsonl"),
  });

  const cursor = cursors.files[claudePath];
  assert.equal(cursor.projectKey, null);
  assert.equal(cursor.projectFileContext?.absent, true);
});

test("parseRolloutIncremental attributes a WSL Codex session through the mapped cwd", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-wsl-attr-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));

  const repoRoot = await makeRepo(tmp, "alpha", "https://github.com/acme/alpha.git");
  const posixCwd = "/home/alice/dev/alpha";
  const seen = stubCwdMapping(t, (cwd) => (cwd === posixCwd ? repoRoot : cwd));

  const sessionsDir = path.join(tmp, "sessions", "2026", "07", "27");
  await fs.mkdir(sessionsDir, { recursive: true });
  const rolloutPath = path.join(sessionsDir, "rollout-wsl.jsonl");
  const usage = {
    input_tokens: 2,
    cached_input_tokens: 1,
    output_tokens: 3,
    reasoning_output_tokens: 0,
    total_tokens: 6,
  };
  await fs.writeFile(
    rolloutPath,
    [
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.4", cwd: posixCwd } }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-07-27T00:10:00.000Z",
        payload: { type: "token_count", info: { last_token_usage: usage, total_token_usage: usage } },
      }),
    ].join("\n") + "\n",
    "utf8",
  );

  const projectQueuePath = path.join(tmp, "project.queue.jsonl");
  const cursors = { version: 1, files: {}, updatedAt: null };

  await parseRolloutIncremental({
    rolloutFiles: [rolloutPath],
    cursors,
    queuePath: path.join(tmp, "queue.jsonl"),
    projectQueuePath,
    publicRepoResolver: async ({ projectRef }) => ({
      status: "public_verified",
      projectKey: "acme/alpha",
      projectRef,
    }),
  });

  assert.deepEqual(seen, [{ cwd: posixCwd, transcriptPath: rolloutPath }]);

  const projectRows = await readJsonLines(projectQueuePath);
  assert.equal(projectRows.length, 1);
  assert.equal(projectRows[0].project_key, "acme/alpha");
  assert.equal(projectRows[0].project_ref, "https://github.com/acme/alpha");
});

// The two tests below pin the fix's blast radius, which is not obvious and
// decides what a user actually sees after upgrading.
//
// A session still being written self-heals: a growing file is never "settled",
// so it re-resolves its project on the next sync and its remaining turns land
// under the right key. A session that already finished does not — Claude's
// token offset and its project attribution share one cursor, so once the file
// is read to EOF there is no second pass that could re-bucket earlier turns
// into the project queue. Attribution is written as tokens are parsed; nothing
// backfills it.
test("an in-flight WSL session picks up its project once the cwd resolves", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-wsl-attr-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));

  const repoRoot = await makeRepo(tmp, "widgets", "https://github.com/acme/widgets.git");
  const posixCwd = "/home/alice/dev/widgets";

  // Starts unresolvable (pre-fix build), then resolves (post-upgrade).
  let resolves = false;
  stubCwdMapping(t, (cwd) =>
    cwd === posixCwd && resolves ? repoRoot : path.join(tmp, "unresolvable"),
  );

  const storageDir = path.join(tmp, "-home-alice-dev-widgets");
  await fs.mkdir(storageDir, { recursive: true });
  const claudePath = path.join(storageDir, "session.jsonl");
  const turn = (msgId, ts) =>
    JSON.stringify({
      type: "assistant",
      timestamp: ts,
      requestId: `req-${msgId}`,
      message: {
        id: msgId,
        model: "claude-sonnet-4",
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    });
  await fs.writeFile(
    claudePath,
    [
      JSON.stringify({ type: "attachment", cwd: posixCwd, timestamp: "2026-07-27T01:00:00.000Z" }),
      turn("msg-1", "2026-07-27T01:10:00.000Z"),
    ].join("\n") + "\n",
    "utf8",
  );

  const projectQueuePath = path.join(tmp, "project.queue.jsonl");
  const cursors = { version: 1, files: {}, updatedAt: null };
  const run = () =>
    parseClaudeIncremental({
      projectFiles: [{ path: claudePath, source: "claude" }],
      cursors,
      queuePath: path.join(tmp, "queue.jsonl"),
      projectQueuePath,
    });

  await run();
  assert.equal(cursors.files[claudePath].projectKey, null);

  // Upgrade lands, then the user keeps talking in the same session.
  resolves = true;
  await fs.appendFile(claudePath, turn("msg-2", "2026-07-27T02:10:00.000Z") + "\n", "utf8");

  await run();
  assert.equal(cursors.files[claudePath].projectKey, "acme/widgets");
  const rows = await readJsonLines(projectQueuePath);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].project_key, "acme/widgets");
});

test("a finished session is NOT retro-attributed (documented limitation)", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-wsl-attr-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));

  const repoRoot = await makeRepo(tmp, "widgets", "https://github.com/acme/widgets.git");
  const posixCwd = "/home/alice/dev/widgets";
  let resolves = false;
  stubCwdMapping(t, (cwd) =>
    cwd === posixCwd && resolves ? repoRoot : path.join(tmp, "unresolvable"),
  );

  const storageDir = path.join(tmp, "-home-alice-dev-widgets");
  await fs.mkdir(storageDir, { recursive: true });
  const claudePath = path.join(storageDir, "session.jsonl");
  await fs.writeFile(
    claudePath,
    [
      JSON.stringify({ type: "attachment", cwd: posixCwd, timestamp: "2026-07-27T01:00:00.000Z" }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-27T01:10:00.000Z",
        requestId: "req-1",
        message: {
          id: "msg-1",
          model: "claude-sonnet-4",
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      }),
    ].join("\n") + "\n",
    "utf8",
  );

  const projectQueuePath = path.join(tmp, "project.queue.jsonl");
  const cursors = { version: 1, files: {}, updatedAt: null };
  const run = () =>
    parseClaudeIncremental({
      projectFiles: [{ path: claudePath, source: "claude" }],
      cursors,
      queuePath: path.join(tmp, "queue.jsonl"),
      projectQueuePath,
    });

  await run();
  assert.equal(cursors.files[claudePath].projectKey, null);

  // Upgrade lands, but this session is over — the file never grows again.
  resolves = true;
  await run();

  // Change this assertion only alongside a real backfill path; today the
  // tokens stay in the usage totals and the project view stays empty.
  assert.deepEqual(await readJsonLines(projectQueuePath), []);
});

// Before the fix, WSL cursors were stuck at `{ absent: true }`, which short
// -circuits the freshness check entirely — zero stats. Attributing them for
// real puts a `.git/config` fingerprint on every cursor, so each sync now
// stats that config once per FILE. Sessions cluster into few repos, and on a
// WSL install every one of those stats crosses the \\wsl$ bridge, so they must
// collapse to one stat per config per run.
test("repeat freshness checks share one stat per .git/config", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-wsl-attr-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));

  const repoRoot = await makeRepo(tmp, "widgets", "https://github.com/acme/widgets.git");
  const configPath = path.join(repoRoot, ".git", "config");
  const posixCwd = "/home/alice/dev/widgets";
  stubCwdMapping(t, (cwd) => (cwd === posixCwd ? repoRoot : cwd));

  // Six sessions in one repo — the shape a real WSL checkout produces.
  const files = [];
  for (let i = 0; i < 6; i++) {
    const dir = path.join(tmp, `-home-alice-dev-widgets-${i}`);
    await fs.mkdir(dir, { recursive: true });
    const p = path.join(dir, "session.jsonl");
    await fs.writeFile(
      p,
      [
        JSON.stringify({ type: "attachment", cwd: posixCwd, timestamp: "2026-07-27T01:00:00.000Z" }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-07-27T01:10:00.000Z",
          requestId: `req-${i}`,
          message: {
            id: `msg-${i}`,
            model: "claude-sonnet-4",
            usage: { input_tokens: 100, output_tokens: 50 },
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    files.push({ path: p, source: "claude" });
  }

  const cursors = { version: 1, files: {}, updatedAt: null };
  const run = () =>
    parseClaudeIncremental({
      projectFiles: files,
      cursors,
      queuePath: path.join(tmp, "queue.jsonl"),
      projectQueuePath: path.join(tmp, "project.queue.jsonl"),
    });

  await run();
  assert.equal(cursors.files[files[0].path].projectKey, "acme/widgets");

  // Second run: all six are idle with a fresh fingerprint, so each one asks
  // whether the same config still matches.
  const realStat = fs.stat;
  let configStats = 0;
  fs.stat = (p, ...rest) => {
    if (p === configPath) configStats += 1;
    return realStat.call(fs, p, ...rest);
  };
  t.after(() => {
    fs.stat = realStat;
  });

  await run();
  assert.equal(configStats, 1, `expected one shared stat, got ${configStats}`);
});

// The DB parsers can only re-anchor a cwd if sync.js hands them the DB path.
// Drop that argument and attribution silently reverts to broken on WSL with
// every existing test still green — the parsers accept `dbPath: undefined` and
// fall through to the unmapped cwd. Pin the call sites in source.
test("sync.js passes dbPath to every DB parser that resolves projects", async () => {
  const source = await fs.readFile(
    path.join(__dirname, "..", "src", "commands", "sync.js"),
    "utf8",
  );
  const calls = [...source.matchAll(/parse(?:OpencodeDb|QoderDb)Incremental\(\{([\s\S]*?)\}\)/g)];
  assert.ok(calls.length >= 3, `expected the known call sites, found ${calls.length}`);
  for (const [, args] of calls) {
    assert.match(args, /\bdbPath\b/, `a DB parser call site lost dbPath:\n${args}`);
  }
});

// oh-my-pi ("pi") records its cwd in a session header line, structurally
// identical to Claude's — and #374's reporter runs it inside WSL too.
test("parseOmpIncremental maps a WSL cwd from the session header", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-wsl-attr-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));

  const repoRoot = await makeRepo(tmp, "pi", "https://github.com/acme/pi.git");
  const posixCwd = "/home/alice/dev/pi";
  const seen = stubCwdMapping(t, (cwd) => (cwd === posixCwd ? repoRoot : cwd));

  const sessionsDir = path.join(tmp, "sessions", "--wsl--");
  await fs.mkdir(sessionsDir, { recursive: true });
  const filePath = path.join(sessionsDir, "session.jsonl");
  await fs.writeFile(
    filePath,
    [
      JSON.stringify({
        type: "session",
        id: "session-1",
        timestamp: "2026-07-27T01:00:00.000Z",
        cwd: posixCwd,
      }),
      JSON.stringify({
        type: "message",
        id: "msg-1",
        parentId: "parent-1",
        timestamp: "2026-07-27T01:10:00.000Z",
        message: {
          role: "assistant",
          model: "claude-sonnet-4-5",
          provider: "anthropic",
          usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
        },
      }),
    ].join("\n") + "\n",
    "utf8",
  );

  const projectQueuePath = path.join(tmp, "project.queue.jsonl");
  await parseOmpIncremental({
    sessionFiles: [filePath],
    cursors: { version: 1, files: {}, updatedAt: null },
    queuePath: path.join(tmp, "queue.jsonl"),
    projectQueuePath,
  });

  assert.deepEqual(seen, [{ cwd: posixCwd, transcriptPath: filePath }]);
  const rows = await readJsonLines(projectQueuePath);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].project_key, "acme/pi");
});

// The SQLite-backed providers (opencode / kilo-cli / mimo / zcode via one
// parser, plus qoder) record the cwd inside DB rows rather than a transcript,
// so their UNC prefix has to come from the DB path. `sync.js` reads those DBs
// over the same \\wsl$ bridge, and the snapshot-to-tmp workaround happens
// inside the read function — so the parser still receives the original UNC
// path, which is what the mapping needs.
test("the opencode-family DB parser maps a WSL cwd using the DB path", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-wsl-attr-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));

  const repoRoot = await makeRepo(tmp, "oc", "https://github.com/acme/oc.git");
  const posixCwd = "/home/alice/dev/oc";
  const dbPath = "\\\\wsl$\\Ubuntu-24.04\\home\\alice\\.local\\share\\opencode\\opencode.db";
  const seen = stubCwdMapping(t, (cwd) => (cwd === posixCwd ? repoRoot : cwd));

  const projectQueuePath = path.join(tmp, "project.queue.jsonl");
  await parseOpencodeDbIncremental({
    // Rows arrive as { id, sessionID, data } — the message body lives in `data`.
    dbMessages: [
      {
        id: "msg-1",
        sessionID: "ses-1",
        data: {
          id: "msg-1",
          sessionID: "ses-1",
          modelID: "claude-sonnet-4",
          time: { created: Date.parse("2026-07-27T01:00:00.000Z") },
          path: { cwd: posixCwd },
          tokens: { input: 100, output: 50, cache: { read: 0, write: 0 } },
        },
      },
    ],
    dbPath,
    cursors: { version: 1 },
    queuePath: path.join(tmp, "queue.jsonl"),
    projectQueuePath,
    source: "opencode",
    cursorKey: "opencode",
  });

  // The DB path is what carries the distro prefix here.
  assert.deepEqual(seen, [{ cwd: posixCwd, transcriptPath: dbPath }]);
  const rows = await readJsonLines(projectQueuePath);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].project_key, "acme/oc");
});

test("the qoder DB parser maps a WSL project_uri using the DB path", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-wsl-attr-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));

  const repoRoot = await makeRepo(tmp, "qd", "https://github.com/acme/qd.git");
  const posixCwd = "/home/alice/dev/qd";
  const dbPath = "\\\\wsl$\\Ubuntu-24.04\\home\\alice\\.config\\Qoder\\qoder.db";
  const seen = stubCwdMapping(t, (cwd) => (cwd === posixCwd ? repoRoot : cwd));

  const projectQueuePath = path.join(tmp, "project.queue.jsonl");
  await parseQoderDbIncremental({
    dbMessages: [
      {
        row_id: 1,
        id: "assistant-1",
        session_id: "session-1",
        request_id: "request-1",
        gmt_create: Date.parse("2026-07-27T01:00:00.000Z"),
        // Qoder stores it as a file:// URI, decoded to a POSIX path before use.
        project_uri: `file://${posixCwd}`,
        token_info: JSON.stringify({ prompt_tokens: 100, cached_tokens: 0, completion_tokens: 50 }),
        model_info: JSON.stringify({ model_key: "quest-ultimate" }),
      },
    ],
    dbPath,
    cursors: { version: 1 },
    queuePath: path.join(tmp, "queue.jsonl"),
    projectQueuePath,
  });

  assert.deepEqual(seen, [{ cwd: posixCwd, transcriptPath: dbPath }]);
  const rows = await readJsonLines(projectQueuePath);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].project_key, "acme/qd");
});

test("the Codex context-only rescan maps a WSL cwd too", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-wsl-attr-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));

  const repoRoot = await makeRepo(tmp, "beta", "https://github.com/acme/beta.git");
  const posixCwd = "/home/alice/dev/beta";
  stubCwdMapping(t, (cwd) => (cwd === posixCwd ? repoRoot : cwd));

  const sessionsDir = path.join(tmp, ".codex", "sessions", "2026", "07", "27");
  await fs.mkdir(sessionsDir, { recursive: true });
  const rolloutPath = path.join(
    sessionsDir,
    "rollout-2026-07-27T00-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl",
  );
  const usage = {
    input_tokens: 2,
    cached_input_tokens: 0,
    output_tokens: 3,
    reasoning_output_tokens: 0,
    total_tokens: 5,
  };
  await fs.writeFile(
    rolloutPath,
    [
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.4", cwd: posixCwd } }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-07-27T00:10:00.000Z",
        payload: { type: "token_count", info: { last_token_usage: usage, total_token_usage: usage } },
      }),
    ].join("\n") + "\n",
    "utf8",
  );

  const cursors = { version: 1, files: {}, updatedAt: null };
  const queuePath = path.join(tmp, "queue.jsonl");

  // First pass with project tracking off leaves the cursor at EOF, so the
  // second pass can only recover project context via the content-only rescan
  // (scanRolloutProjectFileContexts) — the third mapping call site.
  await parseRolloutIncremental({ rolloutFiles: [rolloutPath], cursors, queuePath });
  assert.equal(cursors.files[rolloutPath].projectFileContext, undefined);

  await parseRolloutIncremental({
    rolloutFiles: [rolloutPath],
    cursors,
    queuePath,
    projectQueuePath: path.join(tmp, "project.queue.jsonl"),
  });

  const context = cursors.files[rolloutPath].projectFileContext;
  assert.equal(context.absent, undefined);
  assert.equal(context.configPath, path.join(repoRoot, ".git", "config"));
});
