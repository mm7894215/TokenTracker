const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  cmdSync,
  repairCodexRescanInflation,
  CODEX_RESCAN_DEDUP_REPAIR_KEY,
} = require("../src/commands/sync");

async function makeTempHome() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-codexrepair-"));
}

function tokenCountLine({ ts, last, total }) {
  return JSON.stringify({
    type: "event_msg",
    timestamp: ts,
    payload: { type: "token_count", info: { last_token_usage: last, total_token_usage: total } },
  });
}

function turnContextLine({ cwd, model = "gpt-4" }) {
  return JSON.stringify({
    type: "turn_context",
    payload: { cwd, model },
  });
}

// Two cumulative events in one half-hour: deltas 100 + 150 → true codex total 250.
const U1 = { input_tokens: 60, cached_input_tokens: 0, output_tokens: 40, reasoning_output_tokens: 0, total_tokens: 100 };
const T2 = { input_tokens: 150, cached_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 0, total_tokens: 250 };
const U2 = { input_tokens: 90, cached_input_tokens: 0, output_tokens: 60, reasoning_output_tokens: 0, total_tokens: 150 };
const TRUE_CODEX_TOTAL = 250;

async function writeCodexFile(
  home,
  uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  opts = {},
) {
  const dir = path.join(home, ".codex", "sessions", "2025", "12", "17");
  await fs.mkdir(dir, { recursive: true });
  const fp = path.join(dir, `rollout-2025-12-17T00-00-00-${uuid}.jsonl`);
  const lines = [
    tokenCountLine({ ts: "2025-12-17T00:00:00.000Z", last: U1, total: U1 }),
    tokenCountLine({ ts: "2025-12-17T00:00:01.000Z", last: U2, total: T2 }),
  ];
  if (opts.cwd) lines.unshift(turnContextLine({ cwd: opts.cwd, model: opts.model }));
  await fs.writeFile(
    fp,
    lines.join("\n") + "\n",
    "utf8",
  );
  return fp;
}

const codexBucketTotal = (cursors) =>
  Object.entries(cursors.hourly?.buckets || {})
    .filter(([k]) => k.startsWith("codex|"))
    .reduce((s, [, v]) => s + Number(v.totals?.total_tokens || 0), 0);

const queueRowsBySource = async (queuePath) => {
  const raw = await fs.readFile(queuePath, "utf8");
  const m = {};
  for (const l of raw.split("\n")) {
    if (!l.trim()) continue;
    const r = JSON.parse(l);
    m[r.source] = m[r.source] || { rows: 0, total: 0 };
    m[r.source].rows += 1;
    m[r.source].total += Number(r.total_tokens || 0);
  }
  return m;
};

const projectBucketTotal = (cursors, source = "codex") =>
  Object.entries(cursors.projectHourly?.buckets || {})
    .filter(([, v]) => v?.source === source)
    .reduce((s, [, v]) => s + Number(v.totals?.total_tokens || 0), 0);

async function withTempSyncEnv(fn) {
  const home = await makeTempHome();
  const saved = {
    HOME: process.env.HOME,
    // os.homedir() reads USERPROFILE on Windows, so isolate it too or the test
    // writes into the developer's real ~/.tokentracker.
    USERPROFILE: process.env.USERPROFILE,
    CODEX_HOME: process.env.CODEX_HOME,
    CODE_HOME: process.env.CODE_HOME,
    GEMINI_HOME: process.env.GEMINI_HOME,
    OPENCODE_HOME: process.env.OPENCODE_HOME,
    TOKENTRACKER_DEVICE_TOKEN: process.env.TOKENTRACKER_DEVICE_TOKEN,
    TOKENTRACKER_AUTO_RETRY_NO_SPAWN: process.env.TOKENTRACKER_AUTO_RETRY_NO_SPAWN,
  };
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.CODEX_HOME = path.join(home, ".codex");
    process.env.CODE_HOME = path.join(home, ".code");
    process.env.GEMINI_HOME = path.join(home, ".gemini");
    process.env.OPENCODE_HOME = path.join(home, ".opencode");
    process.env.TOKENTRACKER_DEVICE_TOKEN = "test-device-token";
    process.env.TOKENTRACKER_AUTO_RETRY_NO_SPAWN = "1";
    return await fn(home);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(home, { recursive: true, force: true });
  }
}

describe("repairCodexRescanInflation (#187) — atomic guarded rebuild", () => {
  it("does not treat project.queue.jsonl as cloud upload backlog", async () => {
    await withTempSyncEnv(async (home) => {
      const trackerDir = path.join(home, ".tokentracker", "tracker");
      await fs.mkdir(trackerDir, { recursive: true });
      await fs.writeFile(path.join(trackerDir, "queue.jsonl"), "", "utf8");
      await fs.writeFile(path.join(trackerDir, "queue.state.json"), JSON.stringify({ offset: 0 }), "utf8");
      await fs.writeFile(
        path.join(trackerDir, "cursors.json"),
        JSON.stringify({
          version: 1,
          files: {},
          migrations: {
            cloudConversationsBackfill_2026_06: { appliedAt: "2026-01-01T00:00:00.000Z" },
            claudeGroundTruthRepair_2026_05_v4: { appliedAt: "2026-01-01T00:00:00.000Z" },
          },
        }),
        "utf8",
      );
      await fs.writeFile(
        path.join(trackerDir, "project.queue.jsonl"),
        JSON.stringify({
          project_ref: "https://github.com/acme/alpha",
          project_key: "acme/alpha",
          source: "codex",
          hour_start: "2025-12-17T00:00:00.000Z",
          total_tokens: 250,
        }) + "\n",
        "utf8",
      );
      await fs.writeFile(
        path.join(trackerDir, "project.queue.state.json"),
        JSON.stringify({ offset: 0 }),
        "utf8",
      );

      let stdout = "";
      const write = process.stdout.write;
      process.stdout.write = function capture(chunk, ...args) {
        stdout += String(chunk);
        return true;
      };
      try {
        await cmdSync([]);
      } finally {
        process.stdout.write = write;
      }

      assert.match(stdout, /Sync finished:/);
      assert.doesNotMatch(stdout, /Remaining:/);
      const retryPath = path.join(trackerDir, "auto.retry.json");
      await assert.rejects(fs.stat(retryPath), { code: "ENOENT" });

      await fs.writeFile(
        path.join(trackerDir, "upload.throttle.json"),
        JSON.stringify({ nextAllowedAtMs: Date.now() + 60_000 }),
        "utf8",
      );
      await cmdSync(["--auto"]);
      await assert.rejects(fs.stat(retryPath), { code: "ENOENT" });
    });
  });

  it("rebuilds inflated codex to the true value, preserves other sources, strips+rebuilds the queue, resets the offset", async () => {
    const home = await makeTempHome();
    try {
      const codexFile = await writeCodexFile(home);
      const queuePath = path.join(home, "queue.jsonl");
      const queueStatePath = path.join(home, "queue.state.json");

      // INFLATED state (as if inode re-scans tripled codex): bucket 750, queue carries old-high codex rows.
      await fs.writeFile(
        queuePath,
        [
          JSON.stringify({ source: "codex", model: "unknown", hour_start: "2025-12-17T00:00:00.000Z", total_tokens: 250 }),
          JSON.stringify({ source: "codex", model: "unknown", hour_start: "2025-12-17T00:00:00.000Z", total_tokens: 750 }),
          JSON.stringify({ source: "claude", model: "opus", hour_start: "2025-12-17T00:00:00.000Z", total_tokens: 5000 }),
        ].join("\n") + "\n",
        "utf8",
      );
      await fs.writeFile(queueStatePath, JSON.stringify({ offset: 99999 }), "utf8");

      const cursors = {
        hourly: {
          buckets: {
            "codex|unknown|2025-12-17T00:00:00.000Z": { totals: { total_tokens: 750 } }, // 3x inflated
            "claude|opus|2025-12-17T00:00:00.000Z": { totals: { total_tokens: 5000 } },
          },
          groupQueued: {},
        },
        files: { [codexFile]: { inode: 1, offset: 5, lastTotal: { total_tokens: 750 } } },
        codexHashes: ["stale:key"],
        migrations: {},
      };

      const ran = await repairCodexRescanInflation({
        cursors,
        queuePath,
        queueStatePath,
        rolloutFiles: [{ path: codexFile, source: "codex" }],
      });
      assert.equal(ran, true);

      // codex rebuilt to TRUE value (not the 750 inflation, not 0)
      assert.equal(codexBucketTotal(cursors), TRUE_CODEX_TOTAL);

      // other sources untouched
      assert.equal(cursors.hourly.buckets["claude|opus|2025-12-17T00:00:00.000Z"].totals.total_tokens, 5000);

      // queue: codex rows replaced with clean total, claude row preserved
      const q = await queueRowsBySource(queuePath);
      assert.equal(q.codex.total, TRUE_CODEX_TOTAL, "queue codex rebuilt to true total");
      assert.equal(q.claude.rows, 1);
      assert.equal(q.claude.total, 5000);

      // offset reset, codexHashes rebuilt (2 events), file cursor reinstalled at EOF, key set
      assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).offset, 0);
      assert.equal(cursors.codexHashes.length, 2);
      assert.ok(cursors.files[codexFile] && cursors.files[codexFile].offset > 5);
      assert.ok(cursors.migrations[CODEX_RESCAN_DEDUP_REPAIR_KEY]);

      // idempotent: second call is a no-op
      assert.equal(
        await repairCodexRescanInflation({ cursors, queuePath, queueStatePath, rolloutFiles: [{ path: codexFile, source: "codex" }] }),
        false,
      );
      assert.equal(codexBucketTotal(cursors), TRUE_CODEX_TOTAL);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("rebuilds Codex project usage during rescan repair", async () => {
    const home = await makeTempHome();
    try {
      const repoRoot = path.join(home, "work", "alpha");
      await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
      await fs.writeFile(
        path.join(repoRoot, ".git", "config"),
        `[remote "origin"]\n\turl = https://github.com/acme/alpha.git\n`,
        "utf8",
      );
      const codexFile = await writeCodexFile(home, undefined, { cwd: repoRoot, model: "gpt-4" });
      const hour = "2025-12-17T00:00:00.000Z";
      const projectRef = "https://github.com/acme/alpha";
      const projectKey = "acme/alpha";
      const projectBucketKey = `${projectKey}|codex|${hour}`;
      const claudeProjectBucketKey = `${projectKey}|claude|${hour}`;
      const queuePath = path.join(home, "queue.jsonl");
      const queueStatePath = path.join(home, "queue.state.json");
      const projectQueuePath = path.join(home, "project.queue.jsonl");
      const projectQueueStatePath = path.join(home, "project.queue.state.json");

      await fs.writeFile(
        queuePath,
        [
          JSON.stringify({ source: "codex", model: "gpt-4", hour_start: hour, total_tokens: 750 }),
          JSON.stringify({ source: "claude", model: "opus", hour_start: hour, total_tokens: 5000 }),
        ].join("\n") + "\n",
        "utf8",
      );
      await fs.writeFile(
        projectQueuePath,
        [
          JSON.stringify({
            project_ref: projectRef,
            project_key: projectKey,
            source: "codex",
            hour_start: hour,
            total_tokens: 750,
          }),
          JSON.stringify({
            project_ref: projectRef,
            project_key: projectKey,
            source: "claude",
            hour_start: hour,
            total_tokens: 5000,
          }),
        ].join("\n") + "\n",
        "utf8",
      );
      await fs.writeFile(queueStatePath, JSON.stringify({ offset: 99999 }), "utf8");
      await fs.writeFile(projectQueueStatePath, JSON.stringify({ offset: 88888 }), "utf8");

      const cursors = {
        hourly: {
          buckets: {
            "codex|gpt-4|2025-12-17T00:00:00.000Z": { totals: { total_tokens: 750 } },
            "claude|opus|2025-12-17T00:00:00.000Z": { totals: { total_tokens: 5000 } },
          },
          groupQueued: {},
        },
        projectHourly: {
          version: 2,
          buckets: {
            [projectBucketKey]: {
              project_ref: projectRef,
              project_key: projectKey,
              source: "codex",
              hour_start: hour,
              totals: { total_tokens: 750 },
            },
            [claudeProjectBucketKey]: {
              project_ref: projectRef,
              project_key: projectKey,
              source: "claude",
              hour_start: hour,
              totals: { total_tokens: 5000 },
            },
          },
          projects: {
            [projectKey]: { projectRef, projectKey, status: "public_verified" },
          },
        },
        files: { [codexFile]: { inode: 1, offset: 5, lastTotal: { total_tokens: 750 } } },
        codexHashes: ["stale:key"],
        migrations: {},
      };

      const ran = await repairCodexRescanInflation({
        cursors,
        queuePath,
        queueStatePath,
        projectQueuePath,
        projectQueueStatePath,
        rolloutFiles: [{ path: codexFile, source: "codex" }],
      });
      assert.equal(ran, true);

      assert.equal(codexBucketTotal(cursors), TRUE_CODEX_TOTAL);
      assert.equal(projectBucketTotal(cursors, "codex"), TRUE_CODEX_TOTAL);
      assert.equal(projectBucketTotal(cursors, "claude"), 5000);

      const q = await queueRowsBySource(queuePath);
      const pq = await queueRowsBySource(projectQueuePath);
      assert.equal(q.codex.total, TRUE_CODEX_TOTAL);
      assert.equal(q.claude.total, 5000);
      assert.equal(pq.codex.total, TRUE_CODEX_TOTAL);
      assert.equal(pq.claude.total, 5000);

      assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).offset, 0);
      assert.equal(JSON.parse(await fs.readFile(projectQueueStatePath, "utf8")).offset, 0);
      assert.equal(cursors.files[codexFile].projectOffset, cursors.files[codexFile].offset);
      assert.equal(
        cursors.files[codexFile].projectFileContext.configPath.endsWith(".git/config"),
        true,
      );
      assert.equal(cursors.projectHourly.projects[projectKey].status, "public_verified");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("GUARD: skips without mutation when existing Codex project usage cannot be rebuilt", async () => {
    const home = await makeTempHome();
    try {
      const codexFile = await writeCodexFile(home);
      const hour = "2025-12-17T00:00:00.000Z";
      const queuePath = path.join(home, "queue.jsonl");
      const queueStatePath = path.join(home, "queue.state.json");
      const projectQueuePath = path.join(home, "project.queue.jsonl");
      const projectQueueStatePath = path.join(home, "project.queue.state.json");
      await fs.writeFile(
        queuePath,
        JSON.stringify({ source: "codex", model: "unknown", hour_start: hour, total_tokens: 750 }) +
          "\n",
        "utf8",
      );
      await fs.writeFile(
        projectQueuePath,
        JSON.stringify({
          project_ref: "https://github.com/acme/alpha",
          project_key: "acme/alpha",
          source: "codex",
          hour_start: hour,
          total_tokens: 750,
        }) + "\n",
        "utf8",
      );
      await fs.writeFile(queueStatePath, JSON.stringify({ offset: 123 }), "utf8");
      await fs.writeFile(projectQueueStatePath, JSON.stringify({ offset: 456 }), "utf8");
      const cursors = {
        hourly: {
          buckets: { "codex|unknown|2025-12-17T00:00:00.000Z": { totals: { total_tokens: 750 } } },
          groupQueued: {},
        },
        projectHourly: {
          version: 2,
          buckets: {
            "acme/alpha|codex|2025-12-17T00:00:00.000Z": {
              project_ref: "https://github.com/acme/alpha",
              project_key: "acme/alpha",
              source: "codex",
              hour_start: hour,
              totals: { total_tokens: 750 },
            },
          },
          projects: {},
        },
        files: { [codexFile]: { inode: 1, offset: 5 } },
        codexHashes: ["keep:me"],
        migrations: {},
      };

      const ran = await repairCodexRescanInflation({
        cursors,
        queuePath,
        queueStatePath,
        projectQueuePath,
        projectQueueStatePath,
        rolloutFiles: [{ path: codexFile, source: "codex" }],
      });
      assert.equal(ran, false);
      assert.equal(codexBucketTotal(cursors), 750);
      assert.equal(projectBucketTotal(cursors, "codex"), 750);
      assert.equal((await queueRowsBySource(queuePath)).codex.total, 750);
      assert.equal((await queueRowsBySource(projectQueuePath)).codex.total, 750);
      assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).offset, 123);
      assert.equal(JSON.parse(await fs.readFile(projectQueueStatePath, "utf8")).offset, 456);
      assert.deepEqual(cursors.codexHashes, ["keep:me"]);
      assert.equal(cursors.migrations[CODEX_RESCAN_DEDUP_REPAIR_KEY], undefined);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("GUARD: skips without mutation when Codex project queue rows are malformed", async () => {
    const home = await makeTempHome();
    try {
      const codexFile = await writeCodexFile(home);
      const hour = "2025-12-17T00:00:00.000Z";
      const queuePath = path.join(home, "queue.jsonl");
      const queueStatePath = path.join(home, "queue.state.json");
      const projectQueuePath = path.join(home, "project.queue.jsonl");
      const projectQueueStatePath = path.join(home, "project.queue.state.json");
      const malformedProjectRow =
        JSON.stringify({
          project_ref: "https://github.com/acme/alpha",
          source: "codex",
          hour_start: hour,
          total_tokens: 750,
        }) + "\n";

      await fs.writeFile(
        queuePath,
        JSON.stringify({ source: "codex", model: "unknown", hour_start: hour, total_tokens: 750 }) +
          "\n",
        "utf8",
      );
      await fs.writeFile(projectQueuePath, malformedProjectRow, "utf8");
      await fs.writeFile(queueStatePath, JSON.stringify({ offset: 123 }), "utf8");
      await fs.writeFile(projectQueueStatePath, JSON.stringify({ offset: 456 }), "utf8");
      const cursors = {
        hourly: {
          buckets: { "codex|unknown|2025-12-17T00:00:00.000Z": { totals: { total_tokens: 750 } } },
          groupQueued: {},
        },
        files: { [codexFile]: { inode: 1, offset: 5 } },
        codexHashes: ["keep:me"],
        migrations: {},
      };

      const ran = await repairCodexRescanInflation({
        cursors,
        queuePath,
        queueStatePath,
        projectQueuePath,
        projectQueueStatePath,
        rolloutFiles: [{ path: codexFile, source: "codex" }],
      });
      assert.equal(ran, false);
      assert.equal(codexBucketTotal(cursors), 750);
      assert.equal(await fs.readFile(projectQueuePath, "utf8"), malformedProjectRow);
      assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).offset, 123);
      assert.equal(JSON.parse(await fs.readFile(projectQueueStatePath, "utf8")).offset, 456);
      assert.deepEqual(cursors.codexHashes, ["keep:me"]);
      assert.equal(cursors.migrations[CODEX_RESCAN_DEDUP_REPAIR_KEY], undefined);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("GUARD: skips without mutation when Codex project rebuild is partial", async () => {
    const home = await makeTempHome();
    try {
      const repoRoot = path.join(home, "work", "alpha");
      await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
      await fs.writeFile(
        path.join(repoRoot, ".git", "config"),
        `[remote "origin"]\n\turl = https://github.com/acme/alpha.git\n`,
        "utf8",
      );
      const alphaFile = await writeCodexFile(
        home,
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        { cwd: repoRoot, model: "gpt-4" },
      );
      const betaFile = await writeCodexFile(home, "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee");
      const hour = "2025-12-17T00:00:00.000Z";
      const queuePath = path.join(home, "queue.jsonl");
      const queueStatePath = path.join(home, "queue.state.json");
      const projectQueuePath = path.join(home, "project.queue.jsonl");
      const projectQueueStatePath = path.join(home, "project.queue.state.json");
      await fs.writeFile(
        queuePath,
        JSON.stringify({ source: "codex", model: "gpt-4", hour_start: hour, total_tokens: 1500 }) +
          "\n",
        "utf8",
      );
      await fs.writeFile(
        projectQueuePath,
        [
          JSON.stringify({
            project_ref: "https://github.com/acme/alpha",
            project_key: "acme/alpha",
            source: "codex",
            hour_start: hour,
            total_tokens: 750,
          }),
          JSON.stringify({
            project_ref: "https://github.com/acme/beta",
            project_key: "acme/beta",
            source: "codex",
            hour_start: hour,
            total_tokens: 750,
          }),
        ].join("\n") + "\n",
        "utf8",
      );
      await fs.writeFile(queueStatePath, JSON.stringify({ offset: 123 }), "utf8");
      await fs.writeFile(projectQueueStatePath, JSON.stringify({ offset: 456 }), "utf8");
      const cursors = {
        hourly: {
          buckets: { "codex|gpt-4|2025-12-17T00:00:00.000Z": { totals: { total_tokens: 1500 } } },
          groupQueued: {},
        },
        projectHourly: {
          version: 2,
          buckets: {
            "acme/alpha|codex|2025-12-17T00:00:00.000Z": {
              project_ref: "https://github.com/acme/alpha",
              project_key: "acme/alpha",
              source: "codex",
              hour_start: hour,
              totals: { total_tokens: 750 },
            },
            "acme/beta|codex|2025-12-17T00:00:00.000Z": {
              project_ref: "https://github.com/acme/beta",
              project_key: "acme/beta",
              source: "codex",
              hour_start: hour,
              totals: { total_tokens: 750 },
            },
          },
          projects: {},
        },
        files: {
          [alphaFile]: { inode: 1, offset: 5 },
          [betaFile]: { inode: 2, offset: 5 },
        },
        codexHashes: ["keep:me"],
        migrations: {},
      };

      const ran = await repairCodexRescanInflation({
        cursors,
        queuePath,
        queueStatePath,
        projectQueuePath,
        projectQueueStatePath,
        rolloutFiles: [
          { path: alphaFile, source: "codex" },
          { path: betaFile, source: "codex" },
        ],
      });
      assert.equal(ran, false);
      assert.equal(codexBucketTotal(cursors), 1500);
      assert.equal(projectBucketTotal(cursors, "codex"), 1500);
      assert.equal((await queueRowsBySource(queuePath)).codex.total, 1500);
      assert.equal((await queueRowsBySource(projectQueuePath)).codex.total, 1500);
      assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).offset, 123);
      assert.equal(JSON.parse(await fs.readFile(projectQueueStatePath, "utf8")).offset, 456);
      assert.deepEqual(cursors.codexHashes, ["keep:me"]);
      assert.equal(cursors.migrations[CODEX_RESCAN_DEDUP_REPAIR_KEY], undefined);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("GUARD: skips without mutation when Codex project rebuild lowers an existing key without main repair", async () => {
    const home = await makeTempHome();
    try {
      const repoRoot = path.join(home, "work", "alpha");
      await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
      await fs.writeFile(
        path.join(repoRoot, ".git", "config"),
        `[remote "origin"]\n\turl = https://github.com/acme/alpha.git\n`,
        "utf8",
      );
      const alphaFile = await writeCodexFile(
        home,
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        { cwd: repoRoot, model: "gpt-4" },
      );
      const betaFile = await writeCodexFile(
        home,
        "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee",
        { model: "gpt-4" },
      );
      const hour = "2025-12-17T00:00:00.000Z";
      const projectRef = "https://github.com/acme/alpha";
      const projectKey = "acme/alpha";
      const queuePath = path.join(home, "queue.jsonl");
      const queueStatePath = path.join(home, "queue.state.json");
      const projectQueuePath = path.join(home, "project.queue.jsonl");
      const projectQueueStatePath = path.join(home, "project.queue.state.json");

      await fs.writeFile(
        queuePath,
        JSON.stringify({ source: "codex", model: "gpt-4", hour_start: hour, total_tokens: 500 }) +
          "\n",
        "utf8",
      );
      await fs.writeFile(
        projectQueuePath,
        JSON.stringify({
          project_ref: projectRef,
          project_key: projectKey,
          source: "codex",
          hour_start: hour,
          total_tokens: 500,
        }) + "\n",
        "utf8",
      );
      await fs.writeFile(queueStatePath, JSON.stringify({ offset: 123 }), "utf8");
      await fs.writeFile(projectQueueStatePath, JSON.stringify({ offset: 456 }), "utf8");
      const cursors = {
        hourly: {
          buckets: { "codex|gpt-4|2025-12-17T00:00:00.000Z": { totals: { total_tokens: 500 } } },
          groupQueued: {},
        },
        projectHourly: {
          version: 2,
          buckets: {
            "acme/alpha|codex|2025-12-17T00:00:00.000Z": {
              project_ref: projectRef,
              project_key: projectKey,
              source: "codex",
              hour_start: hour,
              totals: { total_tokens: 500 },
            },
          },
          projects: {},
        },
        files: {
          [alphaFile]: { inode: 1, offset: 5 },
          [betaFile]: { inode: 2, offset: 5 },
        },
        codexHashes: ["keep:me"],
        migrations: {},
      };

      const ran = await repairCodexRescanInflation({
        cursors,
        queuePath,
        queueStatePath,
        projectQueuePath,
        projectQueueStatePath,
        rolloutFiles: [
          { path: alphaFile, source: "codex" },
          { path: betaFile, source: "codex" },
        ],
      });
      assert.equal(ran, false);
      assert.equal(codexBucketTotal(cursors), 500);
      assert.equal(projectBucketTotal(cursors, "codex"), 500);
      assert.equal((await queueRowsBySource(queuePath)).codex.total, 500);
      assert.equal((await queueRowsBySource(projectQueuePath)).codex.total, 500);
      assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).offset, 123);
      assert.equal(JSON.parse(await fs.readFile(projectQueueStatePath, "utf8")).offset, 456);
      assert.deepEqual(cursors.codexHashes, ["keep:me"]);
      assert.equal(cursors.migrations[CODEX_RESCAN_DEDUP_REPAIR_KEY], undefined);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("GUARD: skips with zero mutation when a contributing codex file is missing from disk", async () => {
    const home = await makeTempHome();
    try {
      const codexFile = await writeCodexFile(home);
      const queuePath = path.join(home, "queue.jsonl");
      const queueStatePath = path.join(home, "queue.state.json");
      await fs.writeFile(queuePath, JSON.stringify({ source: "codex", model: "unknown", hour_start: "2025-12-17T00:00:00.000Z", total_tokens: 750 }) + "\n", "utf8");
      await fs.writeFile(queueStatePath, JSON.stringify({ offset: 42 }), "utf8");

      const goneFile = path.join(home, ".codex", "sessions", "2025", "12", "16", "rollout-GONE-uuid.jsonl");
      const cursors = {
        hourly: { buckets: { "codex|unknown|2025-12-17T00:00:00.000Z": { totals: { total_tokens: 750 } } }, groupQueued: {} },
        files: { [codexFile]: { inode: 1, offset: 5 }, [goneFile]: { inode: 2, offset: 5 } }, // goneFile not on disk
        codexHashes: ["keep:me"],
        migrations: {},
      };

      const ran = await repairCodexRescanInflation({
        cursors,
        queuePath,
        queueStatePath,
        rolloutFiles: [{ path: codexFile, source: "codex" }], // goneFile also absent from scan
      });
      assert.equal(ran, false);

      // nothing destroyed
      assert.equal(codexBucketTotal(cursors), 750);
      assert.equal((await queueRowsBySource(queuePath)).codex.total, 750);
      assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).offset, 42);
      assert.deepEqual(cursors.codexHashes, ["keep:me"]);
      assert.equal(cursors.migrations[CODEX_RESCAN_DEDUP_REPAIR_KEY].skipped, true);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("SANITY: skips without setting the key (no clear) when files exist but rebuild yields 0 codex buckets", async () => {
    const home = await makeTempHome();
    try {
      // A codex file with NO token_count events → rebuild produces 0 codex buckets.
      const dir = path.join(home, ".codex", "sessions", "2025", "12", "17");
      await fs.mkdir(dir, { recursive: true });
      const emptyFile = path.join(dir, "rollout-2025-12-17T00-00-00-ffffffff-0000-0000-0000-000000000000.jsonl");
      await fs.writeFile(emptyFile, JSON.stringify({ type: "session_meta", payload: { id: "x" } }) + "\n", "utf8");

      const queuePath = path.join(home, "queue.jsonl");
      const queueStatePath = path.join(home, "queue.state.json");
      await fs.writeFile(queuePath, JSON.stringify({ source: "codex", model: "unknown", hour_start: "2025-12-17T00:00:00.000Z", total_tokens: 750 }) + "\n", "utf8");
      await fs.writeFile(queueStatePath, JSON.stringify({ offset: 7 }), "utf8");

      const cursors = {
        hourly: { buckets: { "codex|unknown|2025-12-17T00:00:00.000Z": { totals: { total_tokens: 750 } } }, groupQueued: {} },
        files: { [emptyFile]: { inode: 1, offset: 5 } },
        codexHashes: [],
        migrations: {},
      };

      const ran = await repairCodexRescanInflation({
        cursors,
        queuePath,
        queueStatePath,
        rolloutFiles: [{ path: emptyFile, source: "codex" }],
      });
      assert.equal(ran, false);

      // live data untouched, key NOT set (so it retries once the file has real data)
      assert.equal(codexBucketTotal(cursors), 750);
      assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).offset, 7);
      assert.equal(cursors.migrations[CODEX_RESCAN_DEDUP_REPAIR_KEY], undefined);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("RETRIES after a prior SKIP: a session moved sessions/ -> archived_sessions/ is reproducible by UUID (#187, easonlee05)", async () => {
    const home = await makeTempHome();
    try {
      const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      // The session now lives FLAT in archived_sessions/ (Codex-Manager moved it).
      const archDir = path.join(home, ".codex", "archived_sessions");
      await fs.mkdir(archDir, { recursive: true });
      const archivedFile = path.join(archDir, `rollout-2025-12-17T00-00-00-${uuid}.jsonl`);
      await fs.writeFile(
        archivedFile,
        [
          tokenCountLine({ ts: "2025-12-17T00:00:00.000Z", last: U1, total: U1 }),
          tokenCountLine({ ts: "2025-12-17T00:00:01.000Z", last: U2, total: T2 }),
        ].join("\n") + "\n",
        "utf8",
      );
      // The OLD sessions/ path the cursor still points at no longer exists.
      const staleSessionsPath = path.join(
        home, ".codex", "sessions", "2025", "12", "17",
        `rollout-2025-12-17T00-00-00-${uuid}.jsonl`,
      );

      const queuePath = path.join(home, "queue.jsonl");
      const queueStatePath = path.join(home, "queue.state.json");
      await fs.writeFile(
        queuePath,
        JSON.stringify({ source: "codex", model: "unknown", hour_start: "2025-12-17T00:00:00.000Z", total_tokens: 750 }) + "\n",
        "utf8",
      );
      await fs.writeFile(queueStatePath, JSON.stringify({ offset: 1234 }), "utf8");

      const cursors = {
        hourly: { buckets: { "codex|unknown|2025-12-17T00:00:00.000Z": { totals: { total_tokens: 750 } } }, groupQueued: {} },
        files: { [staleSessionsPath]: { inode: 1, offset: 5, lastTotal: { total_tokens: 750 } } },
        codexHashes: [],
        // Prior run SKIPPED (v0.53.3 didn't scan archived) — must NOT block retry.
        migrations: {
          [CODEX_RESCAN_DEDUP_REPAIR_KEY]: { skipped: true, reason: "codex_session_file_missing_or_unscanned", at: "2026-06-17T00:00:00.000Z" },
        },
      };

      const ran = await repairCodexRescanInflation({
        cursors,
        queuePath,
        queueStatePath,
        rolloutFiles: [{ path: archivedFile, source: "codex" }],
      });

      assert.equal(ran, true, "prior skip must not block the retry");
      assert.equal(codexBucketTotal(cursors), TRUE_CODEX_TOTAL, "de-inflated to true value");
      assert.equal((await queueRowsBySource(queuePath)).codex.total, TRUE_CODEX_TOTAL);
      assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).offset, 0);
      // Success now records a string timestamp (final), replacing the skip object.
      assert.equal(typeof cursors.migrations[CODEX_RESCAN_DEDUP_REPAIR_KEY], "string");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("GUARD still defers for a genuinely deleted session (no file with that UUID anywhere in scan)", async () => {
    const home = await makeTempHome();
    try {
      const codexFile = await writeCodexFile(home); // a present, scannable session
      const queuePath = path.join(home, "queue.jsonl");
      const queueStatePath = path.join(home, "queue.state.json");
      await fs.writeFile(queuePath, JSON.stringify({ source: "codex", model: "unknown", hour_start: "2025-12-17T00:00:00.000Z", total_tokens: 750 }) + "\n", "utf8");
      await fs.writeFile(queueStatePath, JSON.stringify({ offset: 88 }), "utf8");

      // A DIFFERENT session UUID that exists nowhere on disk / in the scan.
      const deletedPath = path.join(
        home, ".codex", "sessions", "2025", "12", "10",
        "rollout-2025-12-10T00-00-00-99999999-9999-9999-9999-999999999999.jsonl",
      );
      const cursors = {
        hourly: { buckets: { "codex|unknown|2025-12-17T00:00:00.000Z": { totals: { total_tokens: 750 } } }, groupQueued: {} },
        files: { [codexFile]: { inode: 1, offset: 5 }, [deletedPath]: { inode: 2, offset: 5 } },
        codexHashes: ["keep:me"],
        migrations: {},
      };

      const ran = await repairCodexRescanInflation({
        cursors, queuePath, queueStatePath,
        rolloutFiles: [{ path: codexFile, source: "codex" }],
      });

      assert.equal(ran, false, "an unreproducible deleted session must defer the repair");
      assert.equal(codexBucketTotal(cursors), 750, "nothing mutated");
      assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).offset, 88);
      assert.deepEqual(cursors.codexHashes, ["keep:me"]);
      assert.equal(cursors.migrations[CODEX_RESCAN_DEDUP_REPAIR_KEY].skipped, true);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("GUARD recognizes Windows-style stale Codex cursor paths", async () => {
    const home = await makeTempHome();
    try {
      const codexFile = await writeCodexFile(home);
      const queuePath = path.join(home, "queue.jsonl");
      const queueStatePath = path.join(home, "queue.state.json");
      await fs.writeFile(
        queuePath,
        JSON.stringify({
          source: "codex",
          model: "unknown",
          hour_start: "2025-12-17T00:00:00.000Z",
          total_tokens: 750,
        }) + "\n",
        "utf8",
      );
      await fs.writeFile(queueStatePath, JSON.stringify({ offset: 88 }), "utf8");
      const deletedWindowsPath =
        "C:\\Users\\me\\.codex\\sessions\\2025\\12\\10\\rollout-2025-12-10T00-00-00-99999999-9999-9999-9999-999999999999.jsonl";
      const cursors = {
        hourly: {
          buckets: { "codex|unknown|2025-12-17T00:00:00.000Z": { totals: { total_tokens: 750 } } },
          groupQueued: {},
        },
        files: { [codexFile]: { inode: 1, offset: 5 }, [deletedWindowsPath]: { inode: 2, offset: 5 } },
        codexHashes: ["keep:me"],
        migrations: {},
      };

      const ran = await repairCodexRescanInflation({
        cursors,
        queuePath,
        queueStatePath,
        rolloutFiles: [{ path: codexFile, source: "codex" }],
      });
      assert.equal(ran, false);
      assert.equal(codexBucketTotal(cursors), 750);
      assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).offset, 88);
      assert.deepEqual(cursors.codexHashes, ["keep:me"]);
      assert.equal(cursors.migrations[CODEX_RESCAN_DEDUP_REPAIR_KEY].skipped, true);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// #169 follow-up: fork-replay historical repair. Re-runs the guarded rebuild
// under CODEX_FORK_REPLAY_REPAIR_KEY so history parsed before the same-day
// fork burst detector landed gets rebuilt with the fork-aware parser.
// ---------------------------------------------------------------------------

const {
  repairCodexForkReplayInflation,
  CODEX_FORK_REPLAY_REPAIR_KEY,
} = require("../src/commands/sync");

// A same-day forked rollout: 2 replay rows in one flush (1ms apart), then one
// live turn 30s later. Old parser counted all 3 (total 250+150=400 inflated
// ... replay 100+150, live 50 → phantom 150); fork-aware parser counts the
// first-of-run replay row (no lookahead) + the live turn.
const FORK_R1 = { input_tokens: 60, cached_input_tokens: 0, output_tokens: 40, reasoning_output_tokens: 0, total_tokens: 100 };
const FORK_R2 = { input_tokens: 90, cached_input_tokens: 0, output_tokens: 60, reasoning_output_tokens: 0, total_tokens: 150 };
const FORK_LIVE = { input_tokens: 30, cached_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 0, total_tokens: 50 };
const FORK_T2 = { input_tokens: 150, cached_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 0, total_tokens: 250 };
const FORK_T3 = { input_tokens: 180, cached_input_tokens: 0, output_tokens: 120, reasoning_output_tokens: 0, total_tokens: 300 };
// first-of-run replay row (100) + live (50): the bounded residual documented at the skip site
const FORK_TRUE_TOTAL = FORK_R1.total_tokens + FORK_LIVE.total_tokens;
const FORK_INFLATED_TOTAL = FORK_R1.total_tokens + FORK_R2.total_tokens + FORK_LIVE.total_tokens;

async function writeForkedCodexFile(home, uuid = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff") {
  const dir = path.join(home, ".codex", "sessions", "2025", "12", "17");
  await fs.mkdir(dir, { recursive: true });
  const fp = path.join(dir, `rollout-2025-12-17T00-00-00-${uuid}.jsonl`);
  const lines = [
    JSON.stringify({
      type: "session_meta",
      payload: { id: uuid, forked_from_id: "019e095c-c041-7b40-b7cb-43ddb153086c", model: "gpt-4" },
    }),
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-4", current_date: "2025-12-17" } }),
    tokenCountLine({ ts: "2025-12-17T00:00:00.100Z", last: FORK_R1, total: FORK_R1 }),
    tokenCountLine({ ts: "2025-12-17T00:00:00.101Z", last: FORK_R2, total: FORK_T2 }),
    tokenCountLine({ ts: "2025-12-17T00:00:30.101Z", last: FORK_LIVE, total: FORK_T3 }),
  ];
  await fs.writeFile(fp, lines.join("\n") + "\n", "utf8");
  return fp;
}

describe("repairCodexForkReplayInflation (#169 follow-up) — fork replay historical repair", () => {
  it("rebuilds fork-replay-inflated codex history with the fork-aware parser", async () => {
    const home = await makeTempHome();
    try {
      const forkedFile = await writeForkedCodexFile(home);
      const queuePath = path.join(home, "queue.jsonl");
      const queueStatePath = path.join(home, "queue.state.json");

      // INFLATED state: old parser counted the replay rows.
      await fs.writeFile(
        queuePath,
        [
          JSON.stringify({ source: "codex", model: "gpt-4", hour_start: "2025-12-17T00:00:00.000Z", total_tokens: FORK_INFLATED_TOTAL }),
          JSON.stringify({ source: "claude", model: "opus", hour_start: "2025-12-17T00:00:00.000Z", total_tokens: 5000 }),
        ].join("\n") + "\n",
        "utf8",
      );
      await fs.writeFile(queueStatePath, JSON.stringify({ offset: 4321 }), "utf8");

      const cursors = {
        hourly: {
          buckets: {
            "codex|gpt-4|2025-12-17T00:00:00.000Z": { totals: { total_tokens: FORK_INFLATED_TOTAL } },
            "claude|opus|2025-12-17T00:00:00.000Z": { totals: { total_tokens: 5000 } },
          },
          groupQueued: {},
        },
        files: { [forkedFile]: { inode: 1, offset: 5, lastTotal: { total_tokens: FORK_T3.total_tokens } } },
        codexHashes: [],
        // #187 repair long completed — only the fork key triggers this rebuild.
        migrations: { [CODEX_RESCAN_DEDUP_REPAIR_KEY]: "2026-06-15T00:00:00.000Z" },
      };

      const ran = await repairCodexForkReplayInflation({
        cursors,
        queuePath,
        queueStatePath,
        rolloutFiles: [{ path: forkedFile, source: "codex" }],
      });
      assert.equal(ran, true);

      assert.equal(codexBucketTotal(cursors), FORK_TRUE_TOTAL);
      assert.equal(cursors.hourly.buckets["claude|opus|2025-12-17T00:00:00.000Z"].totals.total_tokens, 5000);

      const q = await queueRowsBySource(queuePath);
      assert.equal(q.codex.total, FORK_TRUE_TOTAL, "queue codex rebuilt without replay phantom");
      assert.equal(q.claude.total, 5000);

      assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).offset, 0);
      assert.ok(cursors.migrations[CODEX_FORK_REPLAY_REPAIR_KEY]);
      // #187 key untouched
      assert.equal(cursors.migrations[CODEX_RESCAN_DEDUP_REPAIR_KEY], "2026-06-15T00:00:00.000Z");

      // idempotent
      assert.equal(
        await repairCodexForkReplayInflation({
          cursors,
          queuePath,
          queueStatePath,
          rolloutFiles: [{ path: forkedFile, source: "codex" }],
        }),
        false,
      );
      assert.equal(codexBucketTotal(cursors), FORK_TRUE_TOTAL);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("marks done without a rebuild when no forked rollout exists (pre-gate)", async () => {
    const home = await makeTempHome();
    try {
      const codexFile = await writeCodexFile(home); // NOT forked
      const queuePath = path.join(home, "queue.jsonl");
      const queueStatePath = path.join(home, "queue.state.json");
      await fs.writeFile(
        queuePath,
        JSON.stringify({ source: "codex", model: "unknown", hour_start: "2025-12-17T00:00:00.000Z", total_tokens: 250 }) + "\n",
        "utf8",
      );
      await fs.writeFile(queueStatePath, JSON.stringify({ offset: 777 }), "utf8");
      const cursors = {
        hourly: {
          buckets: { "codex|unknown|2025-12-17T00:00:00.000Z": { totals: { total_tokens: 250 } } },
          groupQueued: {},
        },
        files: { [codexFile]: { inode: 1, offset: 500 } },
        codexHashes: ["keep:me"],
        migrations: {},
      };

      const ran = await repairCodexForkReplayInflation({
        cursors,
        queuePath,
        queueStatePath,
        rolloutFiles: [{ path: codexFile, source: "codex" }],
      });
      assert.equal(ran, false);
      // nothing touched, key finalized
      assert.equal(codexBucketTotal(cursors), 250);
      assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).offset, 777);
      assert.deepEqual(cursors.codexHashes, ["keep:me"]);
      assert.equal(typeof cursors.migrations[CODEX_FORK_REPLAY_REPAIR_KEY], "string");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("marks done without a rebuild when the #187 repair rebuilt in the same sync", async () => {
    const home = await makeTempHome();
    try {
      const forkedFile = await writeForkedCodexFile(home);
      const cursors = { hourly: { buckets: {}, groupQueued: {} }, files: {}, codexHashes: [], migrations: {} };
      const ran = await repairCodexForkReplayInflation({
        cursors,
        queuePath: path.join(home, "queue.jsonl"),
        queueStatePath: path.join(home, "queue.state.json"),
        rolloutFiles: [{ path: forkedFile, source: "codex" }],
        legacyRepairRan: true,
      });
      assert.equal(ran, false);
      assert.equal(typeof cursors.migrations[CODEX_FORK_REPLAY_REPAIR_KEY], "string");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("defers with a retryable sentinel when a candidate head cannot be read (pre-gate indeterminate)", async () => {
    const home = await makeTempHome();
    try {
      // A directory posing as a rollout file: fh.read() fails with EISDIR, so
      // the head scan cannot rule out a fork — the gate must NOT finalize.
      const unreadable = path.join(
        home, ".codex", "sessions", "2025", "12", "17",
        "rollout-2025-12-17T00-00-00-cccccccc-dddd-eeee-ffff-000000000000.jsonl",
      );
      await fs.mkdir(unreadable, { recursive: true });
      const queuePath = path.join(home, "queue.jsonl");
      const queueStatePath = path.join(home, "queue.state.json");
      await fs.writeFile(queuePath, "", "utf8");
      await fs.writeFile(queueStatePath, JSON.stringify({ offset: 12 }), "utf8");
      const cursors = { hourly: { buckets: {}, groupQueued: {} }, files: {}, codexHashes: [], migrations: {} };

      const ran = await repairCodexForkReplayInflation({
        cursors,
        queuePath,
        queueStatePath,
        rolloutFiles: [{ path: unreadable, source: "codex" }],
      });
      assert.equal(ran, false);
      assert.equal(cursors.migrations[CODEX_FORK_REPLAY_REPAIR_KEY].skipped, true);
      assert.equal(cursors.migrations[CODEX_FORK_REPLAY_REPAIR_KEY].reason, "fork_scan_indeterminate");
      assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).offset, 12);

      // Once the readable truth is available, the retryable sentinel lets the
      // gate finalize (here: only a non-forked file remains).
      const codexFile = await writeCodexFile(home);
      const ranAgain = await repairCodexForkReplayInflation({
        cursors,
        queuePath,
        queueStatePath,
        rolloutFiles: [{ path: codexFile, source: "codex" }],
      });
      assert.equal(ranAgain, false);
      assert.equal(typeof cursors.migrations[CODEX_FORK_REPLAY_REPAIR_KEY], "string");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("defers via the reproducibility guard when a previously-counted session is gone", async () => {
    const home = await makeTempHome();
    try {
      const forkedFile = await writeForkedCodexFile(home);
      const deletedPath = path.join(
        home, ".codex", "sessions", "2025", "12", "10",
        "rollout-2025-12-10T00-00-00-99999999-9999-9999-9999-999999999999.jsonl",
      );
      const queuePath = path.join(home, "queue.jsonl");
      const queueStatePath = path.join(home, "queue.state.json");
      await fs.writeFile(queuePath, "", "utf8");
      await fs.writeFile(queueStatePath, JSON.stringify({ offset: 55 }), "utf8");
      const cursors = {
        hourly: { buckets: { "codex|gpt-4|2025-12-17T00:00:00.000Z": { totals: { total_tokens: 300 } } }, groupQueued: {} },
        files: { [forkedFile]: { inode: 1, offset: 5 }, [deletedPath]: { inode: 2, offset: 5 } },
        codexHashes: [],
        migrations: {},
      };

      const ran = await repairCodexForkReplayInflation({
        cursors,
        queuePath,
        queueStatePath,
        rolloutFiles: [{ path: forkedFile, source: "codex" }],
      });
      assert.equal(ran, false);
      assert.equal(codexBucketTotal(cursors), 300);
      assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).offset, 55);
      assert.equal(cursors.migrations[CODEX_FORK_REPLAY_REPAIR_KEY].skipped, true);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
