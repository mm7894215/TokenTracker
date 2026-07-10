const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const fssync = require("node:fs");
const { test } = require("node:test");

const cp = require("node:child_process");
const {
  parseRolloutIncremental,
  parseClaudeIncremental,
  parseGeminiIncremental,
  parseOpencodeIncremental,
  parseOpencodeDbIncremental,
  readOpencodeDbMessages,
  readZcodeDbMessages,
  parseKiroIncremental,
  parseHermesIncremental,
  resolveHermesPath,
  resolveHermesDbPath,
  parseWslListVerbose,
  probeWslDistros,
  discoverWslHermesHome,
  parseCopilotIncremental,
  parseKimiIncremental,
  parseCodebuddyIncremental,
  parseCursorApiIncremental,
  resolveCodebuddyDefaultModel,
  resolveCodebuddyProjectFiles,
  parseWorkbuddyIncremental,
  resolveWorkbuddyDefaultModel,
  resolveWorkbuddyProjectFiles,
  parseOmpIncremental,
  resolveOmpSessionFiles,
  resolveOmpSubagentFiles,
  parsePiIncremental,
  resolvePiSessionFiles,
  resolvePiAgentDir,
  piAgentDirCollidesWithOmp,
  parseCraftIncremental,
  resolveCraftSessionFiles,
  resolveCraftWorkspaceRoots,
  parseGrokBuildIncremental,
  resolveGrokBuildSessions,
  parseAntigravityIncremental,
  listAntigravitySessionFiles,
  estimateAntigravityTokens,
  parseKimiCodeIncremental,
  resolveKimiCodeHome,
  resolveKimiCodeWireFiles,
  resolveKimiCodeDefaultModel,
  resolveKilocodeRoots,
  resolveZedDbPath,
  resolveGooseDbPath,
  listRolloutFilesDeep,
  filterColdCodexRolloutFiles,
} = require("../src/lib/rollout");
const { purgeProjectUsage } = require("../src/lib/project-usage-purge");

const { mockPlatform, mockMethod } = require("./helpers/mock");
const { resetWslProbeCache } = require("../src/lib/wsl-probe");

const antigravityTestTokens = (text) => estimateAntigravityTokens(text || "");

function mockWsl(t, { distro = "Ubuntu", user = "dev" } = {}) {
  mockMethod(t, cp, "execFileSync", (_cmd, args) => {
    if (args[0] === "-l" && args[1] === "-v") {
      return Buffer.from(`  NAME    STATE    VERSION\n* ${distro}  Running  2\n`, "utf16le");
    }
    if (args[0] === "-d" && args[1] === distro && args.includes("whoami")) {
      return Buffer.from(`${user}\n`, "utf8");
    }
    throw new Error(`unexpected wsl args: ${args.join(" ")}`);
  });
}

test("parseRolloutIncremental ignores repeated token_count records with unchanged totals", async () => {
  // Codex can repeat the same token_count record in a rollout. The cumulative
  // total_token_usage value is authoritative for a file; if it did not move,
  // the repeated last_token_usage must not be counted again.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-rollout-"));
  try {
    const rolloutPath = path.join(tmp, "rollout-test.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const usage1 = {
      input_tokens: 1,
      cached_input_tokens: 0,
      output_tokens: 2,
      reasoning_output_tokens: 0,
      total_tokens: 3,
    };
    const usage2 = {
      input_tokens: 1,
      cached_input_tokens: 0,
      output_tokens: 1,
      reasoning_output_tokens: 0,
      total_tokens: 2,
    };

    const totals1 = usage1;
    const totals2 = {
      input_tokens: usage1.input_tokens + usage2.input_tokens,
      cached_input_tokens: 0,
      output_tokens: usage1.output_tokens + usage2.output_tokens,
      reasoning_output_tokens: 0,
      total_tokens: usage1.total_tokens + usage2.total_tokens,
    };

    const lines = [
      buildTokenCountLine({ ts: "2025-12-17T00:00:00.000Z", last: usage1, total: totals1 }),
      buildTokenCountLine({ ts: "2025-12-17T00:00:01.000Z", last: usage1, total: totals1 }), // duplicate — counted again
      buildTokenCountLine({ ts: "2025-12-17T00:00:02.000Z", last: usage2, total: totals2 }),
      buildTokenCountLine({ ts: "2025-12-17T00:00:03.000Z", last: usage2, total: totals2 }), // duplicate — counted again
    ];

    await fs.writeFile(rolloutPath, lines.join("\n") + "\n", "utf8");

    const res = await parseRolloutIncremental({ rolloutFiles: [rolloutPath], cursors, queuePath });
    assert.equal(res.filesProcessed, 1);
    assert.equal(res.eventsAggregated, 2);
    assert.equal(res.bucketsQueued, 1);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].model, "unknown");
    assert.equal(
      queued.reduce((sum, ev) => sum + Number(ev.total_tokens || 0), 0),
      usage1.total_tokens + usage2.total_tokens,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseRolloutIncremental does not re-count a session file rewritten with a new inode (issue #187)", async () => {
  // Codex-Manager atomically rewrites session rollout files (new inode, same
  // token data) when switching account/channel. The parser keys incremental
  // reads on inode, so a new inode forces a full from-zero re-scan. Without
  // event-level dedup that re-adds the whole file to the persistent hourly
  // buckets on every switch (issue #187). Event dedup keyed on
  // sessionUUID:eventTimestamp must make the re-scan idempotent.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-rollout-"));
  try {
    const rolloutPath = path.join(
      tmp,
      "rollout-2025-12-17T00-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl",
    );
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const usage1 = { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0, total_tokens: 15 };
    const usage2 = { input_tokens: 15, cached_input_tokens: 0, output_tokens: 7, reasoning_output_tokens: 0, total_tokens: 22 };
    const totals2 = { input_tokens: 25, cached_input_tokens: 0, output_tokens: 12, reasoning_output_tokens: 0, total_tokens: 37 };
    const lines = [
      buildTokenCountLine({ ts: "2025-12-17T00:00:00.000Z", last: usage1, total: usage1 }),
      buildTokenCountLine({ ts: "2025-12-17T00:00:01.000Z", last: usage2, total: totals2 }),
    ];
    await fs.writeFile(rolloutPath, lines.join("\n") + "\n", "utf8");

    const sumCodex = () =>
      Object.entries(cursors.hourly?.buckets || {})
        .filter(([k]) => k.startsWith("codex|"))
        .reduce((s, [, v]) => s + Number(v.totals?.total_tokens || 0), 0);

    await parseRolloutIncremental({ rolloutFiles: [rolloutPath], cursors, queuePath, source: "codex" });
    const afterFirst = sumCodex();
    assert.equal(afterFirst, totals2.total_tokens);
    assert.equal(cursors.codexHashes.length, 2);

    // Simulate Codex-Manager's atomic rewrite: identical content & path, NEW inode.
    cursors.files[rolloutPath].inode = (cursors.files[rolloutPath].inode || 0) + 1_000_000;
    await parseRolloutIncremental({ rolloutFiles: [rolloutPath], cursors, queuePath, source: "codex" });

    assert.equal(sumCodex(), afterFirst, "re-scan after inode change must not double-count");
    assert.equal(cursors.codexHashes.length, 2, "no new event keys on a pure re-scan");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("listRolloutFilesDeep finds flat archived_sessions files the strict scanner misses (issue #187)", async () => {
  // Codex-Manager archives sessions FLAT into ~/.codex/archived_sessions/ (no
  // YYYY/MM/DD nesting), which listRolloutFiles requires and therefore skips.
  // listRolloutFilesDeep must find rollout-*.jsonl at any depth.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-archived-"));
  try {
    const flat = path.join(tmp, "rollout-2026-02-04T11-55-57-019c26ca-e6bb-7e00-b33a-2ac67a11ddb9.jsonl");
    const nestedDir = path.join(tmp, "2025", "12", "24");
    await fs.mkdir(nestedDir, { recursive: true });
    const nested = path.join(nestedDir, "rollout-2025-12-24T09-40-54-019b4e04-2bd1-7661-b050-066f82a96566.jsonl");
    await fs.writeFile(flat, "{}\n", "utf8");
    await fs.writeFile(nested, "{}\n", "utf8");
    // a non-rollout file must be ignored
    await fs.writeFile(path.join(tmp, "notes.txt"), "x", "utf8");

    const found = await listRolloutFilesDeep(tmp);
    assert.deepEqual(found.sort(), [flat, nested].sort());
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseRolloutIncremental does not double-count a session moved sessions/ -> archived_sessions/ (issue #187)", async () => {
  // When Codex-Manager archives a session, the same rollout file (same session
  // UUID + event timestamps) reappears at a different path. Now that sync scans
  // archived_sessions/ too, re-reading the archived copy must be a no-op — the
  // event dedup keys on sessionUUID:eventTimestamp, both stable across the move.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-rollout-"));
  try {
    const uuid = "019b4e04-2bd1-7661-b050-066f82a96566";
    const livePath = path.join(tmp, "sessions", "2025", "12", "24");
    await fs.mkdir(livePath, { recursive: true });
    const liveFile = path.join(livePath, `rollout-2025-12-24T09-40-54-${uuid}.jsonl`);
    const archivedDir = path.join(tmp, "archived_sessions");
    await fs.mkdir(archivedDir, { recursive: true });
    const archivedFile = path.join(archivedDir, `rollout-2025-12-24T09-40-54-${uuid}.jsonl`);
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const usage1 = { input_tokens: 100, cached_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 0, total_tokens: 150 };
    const totals2 = { input_tokens: 250, cached_input_tokens: 0, output_tokens: 120, reasoning_output_tokens: 0, total_tokens: 370 };
    const usage2 = { input_tokens: 150, cached_input_tokens: 0, output_tokens: 70, reasoning_output_tokens: 0, total_tokens: 220 };
    const lines = [
      buildTokenCountLine({ ts: "2025-12-24T09:40:54.000Z", last: usage1, total: usage1 }),
      buildTokenCountLine({ ts: "2025-12-24T09:40:55.000Z", last: usage2, total: totals2 }),
    ];
    const body = lines.join("\n") + "\n";
    await fs.writeFile(liveFile, body, "utf8");

    const sumCodex = () =>
      Object.entries(cursors.hourly?.buckets || {})
        .filter(([k]) => k.startsWith("codex|"))
        .reduce((s, [, v]) => s + Number(v.totals?.total_tokens || 0), 0);

    // Live: count once.
    await parseRolloutIncremental({ rolloutFiles: [liveFile], cursors, queuePath, source: "codex" });
    const afterLive = sumCodex();
    assert.equal(afterLive, totals2.total_tokens);

    // Archived (different path, same UUID + timestamps): must NOT re-count.
    await fs.writeFile(archivedFile, body, "utf8");
    await parseRolloutIncremental({ rolloutFiles: [archivedFile], cursors, queuePath, source: "codex" });
    assert.equal(sumCodex(), afterLive, "archived copy of a counted session must not double-count");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseRolloutIncremental prefers cumulative total_token_usage delta over larger last_token_usage", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-rollout-"));
  try {
    const rolloutPath = path.join(tmp, "rollout-test.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const usage1 = {
      input_tokens: 10,
      cached_input_tokens: 0,
      output_tokens: 5,
      reasoning_output_tokens: 0,
      total_tokens: 15,
    };
    const inflatedLast = {
      input_tokens: 100,
      cached_input_tokens: 0,
      output_tokens: 50,
      reasoning_output_tokens: 0,
      total_tokens: 150,
    };
    const totals2 = {
      input_tokens: 14,
      cached_input_tokens: 0,
      output_tokens: 8,
      reasoning_output_tokens: 0,
      total_tokens: 22,
    };

    const lines = [
      buildTokenCountLine({ ts: "2025-12-17T00:00:00.000Z", last: usage1, total: usage1 }),
      buildTokenCountLine({ ts: "2025-12-17T00:00:01.000Z", last: inflatedLast, total: totals2 }),
    ];

    await fs.writeFile(rolloutPath, lines.join("\n") + "\n", "utf8");

    const res = await parseRolloutIncremental({ rolloutFiles: [rolloutPath], cursors, queuePath });
    assert.equal(res.filesProcessed, 1);
    assert.equal(res.eventsAggregated, 2);
    assert.equal(res.bucketsQueued, 1);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].input_tokens, 14);
    assert.equal(queued[0].output_tokens, 8);
    assert.equal(queued[0].total_tokens, 22);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseRolloutIncremental emits project usage buckets with canonicalized project_ref", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-rollout-"));
  try {
    const repoRoot = path.join(tmp, "repo");
    await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, ".git", "config"),
      `[remote "origin"]\n\turl = git@github.com:acme/alpha.git\n`,
      "utf8",
    );

    const rolloutPath = path.join(repoRoot, "sessions", "2025", "12", "17", "rollout-test.jsonl");
    await fs.mkdir(path.dirname(rolloutPath), { recursive: true });

    const queuePath = path.join(tmp, "queue.jsonl");
    const projectQueuePath = path.join(tmp, "project.queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const usage = {
      input_tokens: 2,
      cached_input_tokens: 1,
      output_tokens: 3,
      reasoning_output_tokens: 0,
      total_tokens: 6,
    };

    const lines = [
      buildTokenCountLine({ ts: "2025-12-17T00:10:00.000Z", last: usage, total: usage }),
    ];
    await fs.writeFile(rolloutPath, lines.join("\n") + "\n", "utf8");

    const publicRepoResolver = async ({ projectRef }) => {
      if (!projectRef) return { status: "blocked", projectKey: null, projectRef: null };
      return {
        status: "public_verified",
        projectKey: "acme/alpha",
        projectRef: "https://github.com/acme/alpha",
      };
    };

    await parseRolloutIncremental({
      rolloutFiles: [rolloutPath],
      cursors,
      queuePath,
      projectQueuePath,
      publicRepoResolver,
    });

    const projectQueued = await readJsonLines(projectQueuePath);
    assert.equal(projectQueued.length, 1);
    assert.equal(projectQueued[0].project_ref, "https://github.com/acme/alpha");
    assert.equal(projectQueued[0].project_key, "acme/alpha");
    assert.equal(projectQueued[0].source, "codex");
    assert.equal(projectQueued[0].hour_start, "2025-12-17T00:00:00.000Z");
    // Codex reports input_tokens inclusive of cached; the parser subtracts
    // cached so the stored value is pure non-cached input.
    assert.equal(
      projectQueued[0].input_tokens,
      usage.input_tokens - usage.cached_input_tokens,
    );
    assert.equal(projectQueued[0].cached_input_tokens, usage.cached_input_tokens);
    assert.equal(projectQueued[0].output_tokens, usage.output_tokens);
    assert.equal(projectQueued[0].reasoning_output_tokens, usage.reasoning_output_tokens);
    assert.equal(projectQueued[0].total_tokens, usage.total_tokens);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseRolloutIncremental uses turn_context cwd to resolve project context", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-rollout-"));
  try {
    const repoRoot = path.join(tmp, "repo");
    await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, ".git", "config"),
      `[remote "origin"]\n\turl = https://github.com/acme/alpha.git\n`,
      "utf8",
    );

    const sessionsDir = path.join(tmp, "sessions", "2026", "01", "26");
    await fs.mkdir(sessionsDir, { recursive: true });
    const rolloutPath = path.join(sessionsDir, "rollout-test.jsonl");

    const usage = {
      input_tokens: 2,
      cached_input_tokens: 1,
      output_tokens: 3,
      reasoning_output_tokens: 0,
      total_tokens: 6,
    };

    const lines = [
      buildTurnContextLine({ model: "gpt-4", cwd: repoRoot }),
      buildTokenCountLine({ ts: "2026-01-26T00:10:00.000Z", last: usage, total: usage }),
    ];
    await fs.writeFile(rolloutPath, lines.join("\n") + "\n", "utf8");

    const queuePath = path.join(tmp, "queue.jsonl");
    const projectQueuePath = path.join(tmp, "project.queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const publicRepoResolver = async ({ projectRef }) => ({
      status: "public_verified",
      projectKey: "acme/alpha",
      projectRef,
    });

    await parseRolloutIncremental({
      rolloutFiles: [rolloutPath],
      cursors,
      queuePath,
      projectQueuePath,
      publicRepoResolver,
    });

    const projectQueued = await readJsonLines(projectQueuePath);
    assert.equal(projectQueued.length, 1);
    assert.equal(projectQueued[0].project_key, "acme/alpha");
    assert.equal(projectQueued[0].project_ref, "https://github.com/acme/alpha");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseRolloutIncremental skips unchanged files when project state is disabled", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-rollout-"));
  try {
    const sessionsDir = path.join(tmp, "sessions", "2026", "01", "26");
    await fs.mkdir(sessionsDir, { recursive: true });
    const rolloutPath = path.join(sessionsDir, "rollout-test.jsonl");
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
        buildTurnContextLine({ model: "gpt-4" }),
        buildTokenCountLine({ ts: "2026-01-26T00:10:00.000Z", last: usage, total: usage }),
      ].join("\n") + "\n",
      "utf8",
    );

    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const first = await parseRolloutIncremental({
      rolloutFiles: [rolloutPath],
      cursors,
      queuePath,
    });
    assert.equal(first.filesProcessed, 1);

    const second = await parseRolloutIncremental({
      rolloutFiles: [rolloutPath],
      cursors,
      queuePath,
    });
    assert.equal(second.filesProcessed, 0);
    assert.equal(second.eventsAggregated, 0);
    assert.equal(second.bucketsQueued, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseRolloutIncremental skips unchanged project-enabled files after project EOF is recorded", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-rollout-"));
  try {
    const repoRoot = path.join(tmp, "repo");
    await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, ".git", "config"),
      `[remote "origin"]\n\turl = https://github.com/acme/alpha.git\n`,
      "utf8",
    );
    const rolloutPath = path.join(repoRoot, "rollout-test.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const projectQueuePath = path.join(tmp, "project.queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };
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
        buildTurnContextLine({ model: "gpt-4" }),
        buildTokenCountLine({ ts: "2026-01-26T00:10:00.000Z", last: usage, total: usage }),
      ].join("\n") + "\n",
      "utf8",
    );

    const first = await parseRolloutIncremental({
      rolloutFiles: [rolloutPath],
      cursors,
      queuePath,
      projectQueuePath,
    });
    assert.equal(first.filesProcessed, 1);
    assert.equal(first.projectBucketsQueued, 1);
    assert.equal(cursors.files[rolloutPath].projectOffset, cursors.files[rolloutPath].offset);
    assert.equal(cursors.files[rolloutPath].projectFileContext.configPath.endsWith("config"), true);

    const second = await parseRolloutIncremental({
      rolloutFiles: [rolloutPath],
      cursors,
      queuePath,
      projectQueuePath,
    });
    assert.equal(second.filesProcessed, 0);
    assert.equal(second.eventsAggregated, 0);
    assert.equal(second.bucketsQueued, 0);
    assert.equal(second.projectBucketsQueued, 0);

    await fs.writeFile(path.join(repoRoot, ".git", "config"), "", "utf8");
    const third = await parseRolloutIncremental({
      rolloutFiles: [rolloutPath],
      cursors,
      queuePath,
      projectQueuePath,
    });
    assert.equal(third.filesProcessed, 1);
    assert.equal(third.eventsAggregated, 0);
    assert.equal(third.bucketsQueued, 0);
    assert.equal(cursors.projectHourly.projects["acme/alpha"].status, "blocked");
    assert.equal(cursors.projectHourly.projects["acme/alpha"].purge_pending, true);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseRolloutIncremental skips unchanged codex sessions using turn_context cwd project freshness", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-rollout-"));
  try {
    const repoRoot = path.join(tmp, "repo");
    await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, ".git", "config"),
      `[remote "origin"]\n\turl = https://github.com/acme/alpha.git\n`,
      "utf8",
    );
    const sessionsDir = path.join(tmp, ".codex", "sessions", "2026", "01", "26");
    await fs.mkdir(sessionsDir, { recursive: true });
    const rolloutPath = path.join(sessionsDir, "rollout-test.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const projectQueuePath = path.join(tmp, "project.queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };
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
        buildTurnContextLine({ model: "gpt-4", cwd: repoRoot }),
        buildTokenCountLine({ ts: "2026-01-26T00:10:00.000Z", last: usage, total: usage }),
      ].join("\n") + "\n",
      "utf8",
    );

    const first = await parseRolloutIncremental({
      rolloutFiles: [rolloutPath],
      cursors,
      queuePath,
      projectQueuePath,
    });
    assert.equal(first.filesProcessed, 1);
    assert.equal(first.projectBucketsQueued, 1);
    assert.equal(cursors.files[rolloutPath].projectFileContext.configPath.endsWith("config"), true);

    const second = await parseRolloutIncremental({
      rolloutFiles: [rolloutPath],
      cursors,
      queuePath,
      projectQueuePath,
    });
    assert.equal(second.filesProcessed, 0);
    assert.equal(second.eventsAggregated, 0);
    assert.equal(second.projectBucketsQueued, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseRolloutIncremental recovers legacy Codex EOF cursor project freshness from turn_context cwd", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-rollout-"));
  try {
    const repoRoot = path.join(tmp, "repo");
    await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, ".git", "config"),
      `[remote "origin"]\n\turl = https://github.com/acme/alpha.git\n`,
      "utf8",
    );
    const sessionsDir = path.join(tmp, ".codex", "sessions", "2026", "01", "26");
    await fs.mkdir(sessionsDir, { recursive: true });
    const rolloutPath = path.join(
      sessionsDir,
      "rollout-2026-01-26T00-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl",
    );
    const queuePath = path.join(tmp, "queue.jsonl");
    const projectQueuePath = path.join(tmp, "project.queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };
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
        buildTurnContextLine({ model: "gpt-4", cwd: repoRoot }),
        buildTokenCountLine({ ts: "2026-01-26T00:10:00.000Z", last: usage, total: usage }),
      ].join("\n") + "\n",
      "utf8",
    );

    const first = await parseRolloutIncremental({
      rolloutFiles: [rolloutPath],
      cursors,
      queuePath,
    });
    assert.equal(first.filesProcessed, 1);
    assert.equal(cursors.files[rolloutPath].projectOffset, undefined);

    const second = await parseRolloutIncremental({
      rolloutFiles: [rolloutPath],
      cursors,
      queuePath,
      projectQueuePath,
    });
    assert.equal(second.filesProcessed, 1);
    assert.equal(second.eventsAggregated, 0);
    assert.equal(second.bucketsQueued, 0);
    assert.equal(second.projectBucketsQueued, 0);
    assert.equal(cursors.files[rolloutPath].projectOffset, cursors.files[rolloutPath].offset);
    assert.equal(cursors.files[rolloutPath].projectFileContext.configPath.endsWith("config"), true);

    const third = await parseRolloutIncremental({
      rolloutFiles: [rolloutPath],
      cursors,
      queuePath,
      projectQueuePath,
    });
    assert.equal(third.filesProcessed, 0);
    assert.equal(third.eventsAggregated, 0);
    assert.equal(third.projectBucketsQueued, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseRolloutIncremental gives legacy project cursors one EOF pass before skipping", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-rollout-"));
  try {
    const repoRoot = path.join(tmp, "repo");
    await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, ".git", "config"),
      `[remote "origin"]\n\turl = https://github.com/acme/alpha.git\n`,
      "utf8",
    );
    const rolloutPath = path.join(repoRoot, "rollout-test.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const projectQueuePath = path.join(tmp, "project.queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };
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
        buildTurnContextLine({ model: "gpt-4" }),
        buildTokenCountLine({ ts: "2026-01-26T00:10:00.000Z", last: usage, total: usage }),
      ].join("\n") + "\n",
      "utf8",
    );

    const first = await parseRolloutIncremental({
      rolloutFiles: [rolloutPath],
      cursors,
      queuePath,
    });
    assert.equal(first.filesProcessed, 1);
    assert.equal(cursors.files[rolloutPath].projectOffset, undefined);

    const second = await parseRolloutIncremental({
      rolloutFiles: [rolloutPath],
      cursors,
      queuePath,
      projectQueuePath,
    });
    assert.equal(second.filesProcessed, 1);
    assert.equal(second.eventsAggregated, 0);
    assert.equal(second.bucketsQueued, 0);
    assert.equal(cursors.files[rolloutPath].projectOffset, cursors.files[rolloutPath].offset);

    const third = await parseRolloutIncremental({
      rolloutFiles: [rolloutPath],
      cursors,
      queuePath,
      projectQueuePath,
    });
    assert.equal(third.filesProcessed, 0);
    assert.equal(third.eventsAggregated, 0);
    assert.equal(third.bucketsQueued, 0);
    assert.equal(third.projectBucketsQueued, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseRolloutIncremental does not skip unchanged project files with a custom resolver", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-rollout-"));
  try {
    const repoRoot = path.join(tmp, "repo");
    await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, ".git", "config"),
      `[remote "origin"]\n\turl = https://github.com/acme/alpha.git\n`,
      "utf8",
    );
    const rolloutPath = path.join(repoRoot, "rollout-test.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const projectQueuePath = path.join(tmp, "project.queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };
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
        buildTurnContextLine({ model: "gpt-4" }),
        buildTokenCountLine({ ts: "2026-01-26T00:10:00.000Z", last: usage, total: usage }),
      ].join("\n") + "\n",
      "utf8",
    );

    let resolverCalls = 0;
    const publicRepoResolver = async ({ projectRef }) => {
      resolverCalls += 1;
      return { status: "public_verified", projectKey: "acme/alpha", projectRef };
    };

    const first = await parseRolloutIncremental({
      rolloutFiles: [rolloutPath],
      cursors,
      queuePath,
      projectQueuePath,
      publicRepoResolver,
    });
    assert.equal(first.filesProcessed, 1);

    const second = await parseRolloutIncremental({
      rolloutFiles: [rolloutPath],
      cursors,
      queuePath,
      projectQueuePath,
      publicRepoResolver,
    });
    assert.equal(second.filesProcessed, 1);
    assert.equal(second.eventsAggregated, 0);
    assert.equal(resolverCalls, 2);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseRolloutIncremental throttles unchanged files after missing project context", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-rollout-"));
  try {
    const repoRoot = path.join(tmp, "repo");
    await fs.mkdir(repoRoot, { recursive: true });
    const rolloutPath = path.join(repoRoot, "rollout-test.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const projectQueuePath = path.join(tmp, "project.queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };
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
        buildTurnContextLine({ model: "gpt-4" }),
        buildTokenCountLine({ ts: "2026-01-26T00:10:00.000Z", last: usage, total: usage }),
      ].join("\n") + "\n",
      "utf8",
    );

    const first = await parseRolloutIncremental({
      rolloutFiles: [rolloutPath],
      cursors,
      queuePath,
      projectQueuePath,
    });
    assert.equal(first.filesProcessed, 1);
    assert.equal(cursors.files[rolloutPath].projectFileContext.absent, true);
    assert.equal(typeof cursors.files[rolloutPath].projectFileContext.checkedAtMs, "number");

    await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, ".git", "config"),
      `[remote "origin"]\n\turl = https://github.com/acme/alpha.git\n`,
      "utf8",
    );

    const second = await parseRolloutIncremental({
      rolloutFiles: [rolloutPath],
      cursors,
      queuePath,
      projectQueuePath,
    });
    assert.equal(second.filesProcessed, 0);
    assert.equal(second.eventsAggregated, 0);
    assert.equal(cursors.files[rolloutPath].projectFileContext.absent, true);

    cursors.files[rolloutPath].projectFileContext.checkedAtMs = 1;
    const third = await parseRolloutIncremental({
      rolloutFiles: [rolloutPath],
      cursors,
      queuePath,
      projectQueuePath,
    });
    assert.equal(third.filesProcessed, 1);
    assert.equal(third.eventsAggregated, 0);
    assert.equal(cursors.files[rolloutPath].projectFileContext.configPath.endsWith("config"), true);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseRolloutIncremental memoizes project config freshness during idle scans", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-rollout-"));
  const realStat = fs.stat;
  try {
    const repoRoot = path.join(tmp, "repo");
    const configPath = path.join(repoRoot, ".git", "config");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `[remote "origin"]\n\turl = https://github.com/acme/alpha.git\n`,
      "utf8",
    );
    const sessionsDir = path.join(tmp, ".codex", "sessions", "2026", "01", "26");
    await fs.mkdir(sessionsDir, { recursive: true });
    const queuePath = path.join(tmp, "queue.jsonl");
    const projectQueuePath = path.join(tmp, "project.queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };
    const usage = {
      input_tokens: 2,
      cached_input_tokens: 0,
      output_tokens: 3,
      reasoning_output_tokens: 0,
      total_tokens: 5,
    };
    const rolloutFiles = [];
    for (let i = 0; i < 3; i += 1) {
      const rolloutPath = path.join(sessionsDir, `rollout-test-${i}.jsonl`);
      rolloutFiles.push(rolloutPath);
      await fs.writeFile(
        rolloutPath,
        [
          buildTurnContextLine({ model: "gpt-4", cwd: repoRoot }),
          buildTokenCountLine({ ts: "2026-01-26T00:10:00.000Z", last: usage, total: usage }),
        ].join("\n") + "\n",
        "utf8",
      );
    }

    await parseRolloutIncremental({
      rolloutFiles,
      cursors,
      queuePath,
      projectQueuePath,
    });

    let configStats = 0;
    fs.stat = async function countedStat(target, ...args) {
      if (String(target) === configPath) configStats += 1;
      return realStat.call(this, target, ...args);
    };
    const second = await parseRolloutIncremental({
      rolloutFiles,
      cursors,
      queuePath,
      projectQueuePath,
    });
    assert.equal(second.filesProcessed, 0);
    assert.equal(configStats, 1);
  } finally {
    fs.stat = realStat;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseRolloutIncremental keeps project EOF fast path scoped to codex source", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-rollout-"));
  try {
    const repoRoot = path.join(tmp, "repo");
    await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, ".git", "config"),
      `[remote "origin"]\n\turl = https://github.com/acme/alpha.git\n`,
      "utf8",
    );
    const rolloutPath = path.join(repoRoot, "rollout-test.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const projectQueuePath = path.join(tmp, "project.queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };
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
        buildTurnContextLine({ model: "gpt-4" }),
        buildTokenCountLine({ ts: "2026-01-26T00:10:00.000Z", last: usage, total: usage }),
      ].join("\n") + "\n",
      "utf8",
    );

    const first = await parseRolloutIncremental({
      rolloutFiles: [{ path: rolloutPath, source: "every-code" }],
      cursors,
      queuePath,
      projectQueuePath,
    });
    assert.equal(first.filesProcessed, 1);
    assert.equal(cursors.files[rolloutPath].projectOffset, undefined);

    const second = await parseRolloutIncremental({
      rolloutFiles: [{ path: rolloutPath, source: "every-code" }],
      cursors,
      queuePath,
      projectQueuePath,
    });
    assert.equal(second.filesProcessed, 1);
    assert.equal(second.eventsAggregated, 0);
    assert.equal(cursors.files[rolloutPath].projectOffset, undefined);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("filterColdCodexRolloutFiles skips historical EOF Codex files without statting them", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-rollout-"));
  const realStat = fs.stat;
  try {
    const oldPath = path.join(
      tmp,
      ".codex",
      "sessions",
      "2026",
      "01",
      "01",
      "rollout-2026-01-01T00-00-00-019f16bd-1111-7222-8333-444444444444.jsonl",
    );
    const recentPath = path.join(
      tmp,
      ".codex",
      "sessions",
      "2026",
      "07",
      "02",
      "rollout-2026-07-02T00-00-00-019f16bd-2222-7333-8444-555555555555.jsonl",
    );
    const otherSourcePath = path.join(
      tmp,
      ".code",
      "sessions",
      "rollout-2026-01-01T00-00-00-019f16bd-3333-7444-8555-666666666666.jsonl",
    );
    let rolloutStats = 0;
    fs.stat = async function countedStat(target, ...args) {
      if (String(target).endsWith(".jsonl")) rolloutStats += 1;
      return realStat.call(this, target, ...args);
    };

    const filtered = await filterColdCodexRolloutFiles({
      rolloutFiles: [
        { path: oldPath, source: "codex" },
        { path: recentPath, source: "codex" },
        { path: otherSourcePath, source: "every-code" },
      ],
      cursors: {
        files: {
          [oldPath]: { offset: 123, projectOffset: 123 },
          [recentPath]: { offset: 123, projectOffset: 123 },
          [otherSourcePath]: { offset: 123 },
        },
      },
      projectEnabled: false,
      nowMs: Date.UTC(2026, 6, 2),
    });

    assert.equal(filtered.skipped, 1);
    assert.deepEqual(
      filtered.rolloutFiles.map((entry) => entry.path),
      [recentPath, otherSourcePath],
    );
    assert.equal(rolloutStats, 0);
  } finally {
    fs.stat = realStat;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("filterColdCodexRolloutFiles keeps project-stale historical files parseable", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-rollout-"));
  try {
    const repoRoot = path.join(tmp, "repo");
    const configPath = path.join(repoRoot, ".git", "config");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `[remote "origin"]\n\turl = https://github.com/acme/changed.git\n`,
      "utf8",
    );
    const configStat = await fs.stat(configPath);
    const rolloutPath = path.join(
      tmp,
      ".codex",
      "sessions",
      "2026",
      "01",
      "01",
      "rollout-2026-01-01T00-00-00-019f16bd-4444-7555-8666-777777777777.jsonl",
    );

    const filtered = await filterColdCodexRolloutFiles({
      rolloutFiles: [{ path: rolloutPath, source: "codex" }],
      cursors: {
        files: {
          [rolloutPath]: {
            offset: 123,
            projectOffset: 123,
            projectFileContext: {
              configPath,
              configMtimeMs: configStat.mtimeMs - 1,
              configSize: configStat.size,
            },
          },
        },
      },
      projectEnabled: true,
      nowMs: Date.UTC(2026, 6, 2),
    });

    assert.equal(filtered.skipped, 0);
    assert.deepEqual(filtered.rolloutFiles, [{ path: rolloutPath, source: "codex" }]);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseRolloutIncremental re-reads same-inode truncation when project state is disabled", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-rollout-"));
  try {
    const rolloutPath = path.join(tmp, "rollout-test.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };
    const firstUsage = {
      input_tokens: 20,
      cached_input_tokens: 0,
      output_tokens: 5,
      reasoning_output_tokens: 0,
      total_tokens: 25,
    };
    await fs.writeFile(
      rolloutPath,
      [
        buildTurnContextLine({ model: "gpt-4" }),
        buildTokenCountLine({
          ts: "2026-01-26T00:10:00.000Z",
          last: firstUsage,
          total: firstUsage,
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    await parseRolloutIncremental({ rolloutFiles: [rolloutPath], cursors, queuePath });
    const beforeOffset = cursors.files[rolloutPath].offset;

    const secondUsage = {
      input_tokens: 3,
      cached_input_tokens: 0,
      output_tokens: 4,
      reasoning_output_tokens: 0,
      total_tokens: 7,
    };
    const truncatedBody =
      buildTokenCountLine({
        ts: "2026-01-26T00:20:00.000Z",
        last: secondUsage,
        total: secondUsage,
      }) + "\n";
    const rewriteHandle = await fs.open(rolloutPath, "r+");
    let beforeStat;
    let afterStat;
    let second;
    try {
      beforeStat = await rewriteHandle.stat();
      await rewriteHandle.truncate(0);
      await rewriteHandle.write(truncatedBody, 0, "utf8");
      afterStat = await rewriteHandle.stat();

      assert.equal(afterStat.ino, beforeStat.ino);
      assert.ok(afterStat.size < beforeOffset);

      second = await parseRolloutIncremental({ rolloutFiles: [rolloutPath], cursors, queuePath });
      assert.equal(second.filesProcessed, 1);
      assert.equal(second.eventsAggregated, 1);
      assert.equal(cursors.files[rolloutPath].offset, afterStat.size);

      const thirdUsage = {
        input_tokens: 5,
        cached_input_tokens: 0,
        output_tokens: 5,
        reasoning_output_tokens: 0,
        total_tokens: 10,
      };
      const appendedBody =
        buildTokenCountLine({
          ts: "2026-01-26T00:30:00.000Z",
          last: thirdUsage,
          total: thirdUsage,
        }) + "\n";
      await rewriteHandle.write(appendedBody, afterStat.size, "utf8");
    } finally {
      await rewriteHandle.close();
    }
    const third = await parseRolloutIncremental({ rolloutFiles: [rolloutPath], cursors, queuePath });
    assert.equal(third.filesProcessed, 1);
    assert.equal(third.eventsAggregated, 1);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseRolloutIncremental uses session_meta cwd to resolve project context", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-rollout-"));
  try {
    const repoRoot = path.join(tmp, "repo");
    await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, ".git", "config"),
      `[remote "origin"]\n\turl = https://github.com/acme/alpha.git\n`,
      "utf8",
    );

    const sessionsDir = path.join(tmp, "sessions", "2026", "01", "26");
    await fs.mkdir(sessionsDir, { recursive: true });
    const rolloutPath = path.join(sessionsDir, "rollout-test.jsonl");

    const usage = {
      input_tokens: 2,
      cached_input_tokens: 1,
      output_tokens: 3,
      reasoning_output_tokens: 0,
      total_tokens: 6,
    };

    const lines = [
      buildSessionMetaLine({ model: "gpt-4", cwd: repoRoot }),
      buildTokenCountLine({ ts: "2026-01-26T00:10:00.000Z", last: usage, total: usage }),
    ];
    await fs.writeFile(rolloutPath, lines.join("\n") + "\n", "utf8");

    const queuePath = path.join(tmp, "queue.jsonl");
    const projectQueuePath = path.join(tmp, "project.queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const publicRepoResolver = async ({ projectRef }) => ({
      status: "public_verified",
      projectKey: "acme/alpha",
      projectRef,
    });

    await parseRolloutIncremental({
      rolloutFiles: [rolloutPath],
      cursors,
      queuePath,
      projectQueuePath,
      publicRepoResolver,
    });

    const projectQueued = await readJsonLines(projectQueuePath);
    assert.equal(projectQueued.length, 1);
    assert.equal(projectQueued[0].project_key, "acme/alpha");
    assert.equal(projectQueued[0].project_ref, "https://github.com/acme/alpha");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseRolloutIncremental marks blocked when remote is missing but repo_root_hash matches", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-rollout-"));
  try {
    const repoRoot = path.join(tmp, "repo");
    await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
    const configPath = path.join(repoRoot, ".git", "config");
    await fs.writeFile(
      configPath,
      `[remote "origin"]\n\turl = https://github.com/acme/alpha.git\n`,
      "utf8",
    );

    const rolloutPath = path.join(repoRoot, "rollout-test.jsonl");
    const usage = {
      input_tokens: 1,
      cached_input_tokens: 0,
      output_tokens: 2,
      reasoning_output_tokens: 0,
      total_tokens: 3,
    };
    const lines = [
      buildTokenCountLine({ ts: "2026-01-26T00:10:00.000Z", last: usage, total: usage }),
    ];
    await fs.writeFile(rolloutPath, lines.join("\n") + "\n", "utf8");

    const queuePath = path.join(tmp, "queue.jsonl");
    const projectQueuePath = path.join(tmp, "project.queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const publicRepoResolver = async ({ projectRef }) => {
      if (!projectRef) return { status: "blocked", projectKey: null, projectRef: null };
      return { status: "public_verified", projectKey: "acme/alpha", projectRef };
    };

    await parseRolloutIncremental({
      rolloutFiles: [rolloutPath],
      cursors,
      queuePath,
      projectQueuePath,
      publicRepoResolver,
    });

    assert.equal(cursors.projectHourly.projects["acme/alpha"].status, "public_verified");
    assert.ok(cursors.projectHourly.projects["acme/alpha"].repo_root_hash);

    await fs.writeFile(configPath, "", "utf8");

    await parseRolloutIncremental({
      rolloutFiles: [rolloutPath],
      cursors,
      queuePath,
      projectQueuePath,
      publicRepoResolver,
    });

    assert.equal(cursors.projectHourly.projects["acme/alpha"].status, "blocked");
    assert.equal(cursors.projectHourly.projects["acme/alpha"].purge_pending, true);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseRolloutIncremental strips credentials from project_ref", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-rollout-"));
  try {
    const repoRoot = path.join(tmp, "repo");
    await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, ".git", "config"),
      `[remote "origin"]\n\turl = https://token@github.com/acme/alpha.git\n`,
      "utf8",
    );

    const rolloutPath = path.join(repoRoot, "sessions", "2025", "12", "17", "rollout-test.jsonl");
    await fs.mkdir(path.dirname(rolloutPath), { recursive: true });

    const queuePath = path.join(tmp, "queue.jsonl");
    const projectQueuePath = path.join(tmp, "project.queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const usage = {
      input_tokens: 2,
      cached_input_tokens: 1,
      output_tokens: 3,
      reasoning_output_tokens: 0,
      total_tokens: 6,
    };

    const lines = [
      buildTokenCountLine({ ts: "2025-12-17T00:10:00.000Z", last: usage, total: usage }),
    ];
    await fs.writeFile(rolloutPath, lines.join("\n") + "\n", "utf8");

    const publicRepoResolver = async ({ projectRef }) => {
      if (!projectRef) return { status: "blocked", projectKey: null, projectRef: null };
      return {
        status: "public_verified",
        projectKey: "acme/alpha",
        projectRef: "https://github.com/acme/alpha",
      };
    };

    await parseRolloutIncremental({
      rolloutFiles: [rolloutPath],
      cursors,
      queuePath,
      projectQueuePath,
      publicRepoResolver,
    });

    const projectQueued = await readJsonLines(projectQueuePath);
    assert.equal(projectQueued.length, 1);
    assert.equal(projectQueued[0].project_ref, "https://github.com/acme/alpha");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseRolloutIncremental ignores local path project_ref", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-rollout-"));
  try {
    const repoRoot = path.join(tmp, "repo");
    await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, ".git", "config"),
      `[remote "origin"]\n\turl = /Users/alice/projects/alpha\n`,
      "utf8",
    );

    const rolloutPath = path.join(repoRoot, "sessions", "2025", "12", "17", "rollout-test.jsonl");
    await fs.mkdir(path.dirname(rolloutPath), { recursive: true });

    const queuePath = path.join(tmp, "queue.jsonl");
    const projectQueuePath = path.join(tmp, "project.queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const usage = {
      input_tokens: 2,
      cached_input_tokens: 1,
      output_tokens: 3,
      reasoning_output_tokens: 0,
      total_tokens: 6,
    };

    const lines = [
      buildTokenCountLine({ ts: "2025-12-17T00:10:00.000Z", last: usage, total: usage }),
    ];
    await fs.writeFile(rolloutPath, lines.join("\n") + "\n", "utf8");

    const publicRepoResolver = async ({ projectRef }) => {
      if (!projectRef) return { status: "blocked", projectKey: null, projectRef: null };
      return {
        status: "public_verified",
        projectKey: "acme/alpha",
        projectRef: "https://github.com/acme/alpha",
      };
    };

    await parseRolloutIncremental({
      rolloutFiles: [rolloutPath],
      cursors,
      queuePath,
      projectQueuePath,
      publicRepoResolver,
    });

    const projectQueued = await readJsonLines(projectQueuePath);
    assert.equal(projectQueued.length, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseRolloutIncremental skips project usage when repo is blocked", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-rollout-"));
  try {
    const repoRoot = path.join(tmp, "repo");
    await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, ".git", "config"),
      `[remote "origin"]\n\turl = git@github.com:acme/alpha.git\n`,
      "utf8",
    );

    const rolloutPath = path.join(repoRoot, "sessions", "2025", "12", "17", "rollout-test.jsonl");
    await fs.mkdir(path.dirname(rolloutPath), { recursive: true });

    const queuePath = path.join(tmp, "queue.jsonl");
    const projectQueuePath = path.join(tmp, "project.queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const usage = {
      input_tokens: 2,
      cached_input_tokens: 1,
      output_tokens: 3,
      reasoning_output_tokens: 0,
      total_tokens: 6,
    };

    const lines = [
      buildTokenCountLine({ ts: "2025-12-17T00:10:00.000Z", last: usage, total: usage }),
    ];
    await fs.writeFile(rolloutPath, lines.join("\n") + "\n", "utf8");

    const publicRepoResolver = async () => ({
      status: "blocked",
      projectKey: "acme/alpha",
      projectRef: "https://github.com/acme/alpha",
    });

    await parseRolloutIncremental({
      rolloutFiles: [rolloutPath],
      cursors,
      queuePath,
      projectQueuePath,
      publicRepoResolver,
    });

    const projectQueued = await readJsonLines(projectQueuePath);
    assert.equal(projectQueued.length, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseRolloutIncremental splits usage into half-hour buckets", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-rollout-"));
  try {
    const rolloutPath = path.join(tmp, "rollout-test.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const usage1 = {
      input_tokens: 1,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 1,
    };
    const usage2 = {
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 2,
      reasoning_output_tokens: 0,
      total_tokens: 2,
    };

    const lines = [
      buildTokenCountLine({ ts: "2025-12-17T00:10:00.000Z", last: usage1, total: usage1 }),
      buildTokenCountLine({
        ts: "2025-12-17T00:40:00.000Z",
        last: usage2,
        total: {
          input_tokens: usage1.input_tokens + usage2.input_tokens,
          cached_input_tokens: 0,
          output_tokens: usage1.output_tokens + usage2.output_tokens,
          reasoning_output_tokens: 0,
          total_tokens: usage1.total_tokens + usage2.total_tokens,
        },
      }),
    ];

    await fs.writeFile(rolloutPath, lines.join("\n") + "\n", "utf8");

    const res = await parseRolloutIncremental({ rolloutFiles: [rolloutPath], cursors, queuePath });
    assert.equal(res.filesProcessed, 1);
    assert.equal(res.eventsAggregated, 2);
    assert.equal(res.bucketsQueued, 2);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 2);
    const byBucket = new Map(queued.map((row) => [row.hour_start, row]));
    assert.equal(byBucket.size, 2);
    assert.equal(byBucket.get("2025-12-17T00:00:00.000Z")?.total_tokens, usage1.total_tokens);
    assert.equal(byBucket.get("2025-12-17T00:00:00.000Z")?.conversation_count, 1);
    assert.equal(byBucket.get("2025-12-17T00:30:00.000Z")?.total_tokens, usage2.total_tokens);
    assert.equal(byBucket.get("2025-12-17T00:30:00.000Z")?.conversation_count, 1);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseRolloutIncremental skips historical replay tokens in forked Codex rollouts", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-rollout-"));
  try {
    const rolloutPath = path.join(
      tmp,
      "2026",
      "06",
      "09",
      "rollout-2026-06-09T20-46-23-fork.jsonl",
    );
    await fs.mkdir(path.dirname(rolloutPath), { recursive: true });
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const replayUsage = {
      input_tokens: 100,
      cached_input_tokens: 0,
      output_tokens: 10,
      reasoning_output_tokens: 0,
      total_tokens: 110,
    };
    const liveUsage = {
      input_tokens: 7,
      cached_input_tokens: 0,
      output_tokens: 3,
      reasoning_output_tokens: 0,
      total_tokens: 10,
    };
    const liveTotals = {
      input_tokens: replayUsage.input_tokens + liveUsage.input_tokens,
      cached_input_tokens: 0,
      output_tokens: replayUsage.output_tokens + liveUsage.output_tokens,
      reasoning_output_tokens: 0,
      total_tokens: replayUsage.total_tokens + liveUsage.total_tokens,
    };

    const lines = [
      buildSessionMetaLine({
        model: "gpt-5.5",
        cwd: tmp,
        forkedFromId: "019e095c-c041-7b40-b7cb-43ddb153086c",
      }),
      buildTurnContextLine({ model: "gpt-5.5", cwd: tmp, currentDate: "2026-05-08" }),
      buildTokenCountLine({
        ts: "2026-06-09T20:46:26.530Z",
        last: replayUsage,
        total: replayUsage,
      }),
      buildTurnContextLine({ model: "gpt-5.5", cwd: tmp, currentDate: "2026-06-09" }),
      buildTokenCountLine({
        ts: "2026-06-09T20:47:00.000Z",
        last: liveUsage,
        total: liveTotals,
      }),
    ];
    await fs.writeFile(rolloutPath, lines.join("\n") + "\n", "utf8");

    const res = await parseRolloutIncremental({ rolloutFiles: [rolloutPath], cursors, queuePath });
    assert.equal(res.filesProcessed, 1);
    assert.equal(res.eventsAggregated, 1);
    assert.equal(res.bucketsQueued, 1);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].input_tokens, liveUsage.input_tokens);
    assert.equal(queued[0].output_tokens, liveUsage.output_tokens);
    assert.equal(queued[0].total_tokens, liveUsage.total_tokens);
    assert.deepEqual(cursors.files[rolloutPath].lastTotal, liveTotals);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseRolloutIncremental migrates v1 hourly buckets without resetting totals", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-rollout-"));
  try {
    const rolloutPath = path.join(tmp, "rollout-test.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = {
      version: 1,
      files: {},
      updatedAt: null,
      hourly: {
        version: 1,
        buckets: {
          "codex|2025-12-17T00:00:00.000Z": {
            totals: {
              input_tokens: 4,
              cached_input_tokens: 0,
              output_tokens: 3,
              reasoning_output_tokens: 0,
              total_tokens: 7,
            },
            queuedKey: null,
          },
        },
        updatedAt: null,
      },
    };

    const usage = {
      input_tokens: 2,
      cached_input_tokens: 0,
      output_tokens: 1,
      reasoning_output_tokens: 0,
      total_tokens: 3,
    };

    const lines = [
      buildTokenCountLine({ ts: "2025-12-17T00:10:00.000Z", last: usage, total: usage }),
    ];
    await fs.writeFile(rolloutPath, lines.join("\n") + "\n", "utf8");

    const res = await parseRolloutIncremental({ rolloutFiles: [rolloutPath], cursors, queuePath });
    assert.equal(res.filesProcessed, 1);
    assert.equal(res.eventsAggregated, 1);
    assert.equal(res.bucketsQueued, 1);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].total_tokens, 10);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseRolloutIncremental handles total_token_usage reset by counting last_token_usage", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-rollout-"));
  try {
    const rolloutPath = path.join(tmp, "rollout-test.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const usageA = {
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 10,
    };
    const usageB = {
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 5,
    };
    const usageReset = {
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 7,
    };

    const totalsA = usageA;
    const totalsB = { ...usageA, total_tokens: usageA.total_tokens + usageB.total_tokens };
    const totalsReset = usageReset; // reset: totals decreased from totalsB.total_tokens

    const lines = [
      buildTokenCountLine({ ts: "2025-12-17T00:00:00.000Z", last: usageA, total: totalsA }),
      buildTokenCountLine({ ts: "2025-12-17T00:00:01.000Z", last: usageB, total: totalsB }),
      buildTokenCountLine({ ts: "2025-12-17T00:00:02.000Z", last: usageReset, total: totalsReset }),
      buildTokenCountLine({ ts: "2025-12-17T00:00:03.000Z", last: usageReset, total: totalsReset }), // duplicate after reset
    ];

    await fs.writeFile(rolloutPath, lines.join("\n") + "\n", "utf8");

    const res = await parseRolloutIncremental({ rolloutFiles: [rolloutPath], cursors, queuePath });
    assert.equal(res.filesProcessed, 1);
    assert.equal(res.eventsAggregated, 3);
    assert.equal(res.bucketsQueued, 1);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    // A + B + Reset; the repeated reset event has unchanged cumulative totals.
    assert.equal(
      queued.reduce((sum, ev) => sum + Number(ev.total_tokens || 0), 0),
      usageA.total_tokens + usageB.total_tokens + usageReset.total_tokens,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseRolloutIncremental handles total_token_usage reset when last_token_usage is missing", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-rollout-"));
  try {
    const rolloutPath = path.join(tmp, "rollout-test.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const usageA = {
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 4,
    };
    const usageB = {
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 6,
    };

    const totalsA = usageA;
    const totalsB = { ...usageA, total_tokens: usageA.total_tokens + usageB.total_tokens };
    const totalsReset = { ...usageA, total_tokens: 5 };

    const lines = [
      buildTokenCountLine({ ts: "2025-12-17T00:00:00.000Z", last: usageA, total: totalsA }),
      buildTokenCountLine({ ts: "2025-12-17T00:00:01.000Z", last: usageB, total: totalsB }),
      buildTokenCountLine({ ts: "2025-12-17T00:00:02.000Z", last: null, total: totalsReset }),
      buildTokenCountLine({ ts: "2025-12-17T00:00:03.000Z", last: null, total: totalsReset }), // duplicate after reset
    ];

    await fs.writeFile(rolloutPath, lines.join("\n") + "\n", "utf8");

    const res = await parseRolloutIncremental({ rolloutFiles: [rolloutPath], cursors, queuePath });
    assert.equal(res.filesProcessed, 1);
    assert.equal(res.eventsAggregated, 3);
    assert.equal(res.bucketsQueued, 1);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(
      queued.reduce((sum, ev) => sum + Number(ev.total_tokens || 0), 0),
      usageA.total_tokens + usageB.total_tokens + totalsReset.total_tokens,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseGeminiIncremental aggregates gemini tokens and model", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-gemini-"));
  try {
    const sessionPath = path.join(tmp, "session.json");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const session = buildGeminiSession({
      messages: [
        {
          id: "m1",
          type: "assistant",
          timestamp: "2025-12-26T08:05:00.000Z",
          model: "gemini-3-flash-preview",
          content: { text: "ignore me" },
          tokens: { input: 10, output: 1, cached: 2, thoughts: 0, tool: 1, total: 14 },
        },
      ],
    });

    await fs.writeFile(sessionPath, JSON.stringify(session), "utf8");

    const res = await parseGeminiIncremental({ sessionFiles: [sessionPath], cursors, queuePath });
    assert.equal(res.filesProcessed, 1);
    assert.equal(res.eventsAggregated, 1);
    assert.equal(res.bucketsQueued, 1);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].source, "gemini");
    assert.equal(queued[0].model, "gemini-3-flash-preview");
    assert.equal(queued[0].hour_start, "2025-12-26T08:00:00.000Z");
    assert.equal(queued[0].input_tokens, 10);
    assert.equal(queued[0].cached_input_tokens, 2);
    assert.equal(queued[0].output_tokens, 2);
    assert.equal(queued[0].reasoning_output_tokens, 0);
    assert.equal(queued[0].total_tokens, 14);
    assert.equal(queued[0].conversation_count, 1);
    assert.equal(typeof queued[0].content, "undefined");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseGeminiIncremental recomputes total when Gemini reported total excludes cache", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-gemini-total-"));
  try {
    const sessionPath = path.join(tmp, "session.json");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const session = buildGeminiSession({
      messages: [
        {
          id: "m1",
          type: "assistant",
          timestamp: "2025-12-26T08:05:00.000Z",
          model: "gemini-3-flash-preview",
          tokens: { input: 10, output: 5, cached: 20, thoughts: 3, tool: 2, total: 17 },
        },
      ],
    });

    await fs.writeFile(sessionPath, JSON.stringify(session), "utf8");

    const res = await parseGeminiIncremental({ sessionFiles: [sessionPath], cursors, queuePath });
    assert.equal(res.bucketsQueued, 1);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].input_tokens, 10);
    assert.equal(queued[0].cached_input_tokens, 20);
    assert.equal(queued[0].output_tokens, 7);
    assert.equal(queued[0].reasoning_output_tokens, 3);
    assert.equal(queued[0].total_tokens, 40);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseGeminiIncremental keeps cumulative totals across messages without tokens", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-gemini-missing-tokens-"));
  try {
    const sessionPath = path.join(tmp, "session.json");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const session = buildGeminiSession({
      messages: [
        {
          id: "m1",
          type: "assistant",
          timestamp: "2025-12-26T08:05:00.000Z",
          model: "gemini-3-flash-preview",
          tokens: { input: 5, output: 1, cached: 0, thoughts: 0, tool: 0, total: 6 },
        },
        {
          id: "m2",
          type: "assistant",
          timestamp: "2025-12-26T08:10:00.000Z",
          model: "gemini-3-flash-preview",
        },
        {
          id: "m3",
          type: "assistant",
          timestamp: "2025-12-26T08:15:00.000Z",
          model: "gemini-3-flash-preview",
          tokens: { input: 8, output: 2, cached: 0, thoughts: 0, tool: 0, total: 10 },
        },
      ],
    });

    await fs.writeFile(sessionPath, JSON.stringify(session), "utf8");

    const res = await parseGeminiIncremental({ sessionFiles: [sessionPath], cursors, queuePath });
    assert.equal(res.filesProcessed, 1);
    assert.equal(res.eventsAggregated, 2);
    assert.equal(res.bucketsQueued, 1);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].input_tokens, 8);
    assert.equal(queued[0].output_tokens, 2);
    assert.equal(queued[0].total_tokens, 10);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseGeminiIncremental skips duplicate cumulative snapshots in one file", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-gemini-duplicate-"));
  try {
    const sessionPath = path.join(tmp, "session.json");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const snapshot = { input: 5, output: 1, cached: 0, thoughts: 0, tool: 0, total: 6 };
    const session = buildGeminiSession({
      messages: [
        {
          id: "m1",
          type: "assistant",
          timestamp: "2025-12-26T08:05:00.000Z",
          model: "gemini-3-flash-preview",
          tokens: snapshot,
        },
        {
          id: "m2",
          type: "assistant",
          timestamp: "2025-12-26T08:10:00.000Z",
          model: "gemini-3-flash-preview",
          tokens: snapshot,
        },
      ],
    });

    await fs.writeFile(sessionPath, JSON.stringify(session), "utf8");

    const res = await parseGeminiIncremental({ sessionFiles: [sessionPath], cursors, queuePath });
    assert.equal(res.eventsAggregated, 1);
    assert.equal(res.bucketsQueued, 1);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].input_tokens, 5);
    assert.equal(queued[0].output_tokens, 1);
    assert.equal(queued[0].total_tokens, 6);
    assert.equal(queued[0].conversation_count, 1);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseGeminiIncremental advances baseline for messages with tokens but no timestamp", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-gemini-missing-timestamp-"));
  try {
    const sessionPath = path.join(tmp, "session.json");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const session = buildGeminiSession({
      messages: [
        {
          id: "m1",
          type: "assistant",
          timestamp: "2025-12-26T08:05:00.000Z",
          model: "gemini-3-flash-preview",
          tokens: { input: 5, output: 1, cached: 0, thoughts: 0, tool: 0, total: 6 },
        },
        {
          id: "m2",
          type: "assistant",
          model: "gemini-3-flash-preview",
          tokens: { input: 8, output: 2, cached: 0, thoughts: 0, tool: 0, total: 10 },
        },
        {
          id: "m3",
          type: "assistant",
          timestamp: "2025-12-26T08:15:00.000Z",
          model: "gemini-3-flash-preview",
          tokens: { input: 9, output: 3, cached: 0, thoughts: 0, tool: 0, total: 12 },
        },
      ],
    });

    await fs.writeFile(sessionPath, JSON.stringify(session), "utf8");

    const res = await parseGeminiIncremental({ sessionFiles: [sessionPath], cursors, queuePath });
    assert.equal(res.eventsAggregated, 2);
    assert.equal(res.bucketsQueued, 1);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].input_tokens, 6);
    assert.equal(queued[0].output_tokens, 2);
    assert.equal(queued[0].total_tokens, 8);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseGeminiIncremental is idempotent with unchanged totals", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-gemini-"));
  try {
    const sessionPath = path.join(tmp, "session.json");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const session = buildGeminiSession({
      messages: [
        {
          id: "m1",
          type: "assistant",
          timestamp: "2025-12-26T08:05:00.000Z",
          model: "gemini-3-flash-preview",
          tokens: { input: 5, output: 1, cached: 0, thoughts: 0, tool: 0, total: 6 },
        },
      ],
    });

    await fs.writeFile(sessionPath, JSON.stringify(session), "utf8");

    await parseGeminiIncremental({ sessionFiles: [sessionPath], cursors, queuePath });
    const afterFirst = await readJsonLines(queuePath);

    const res = await parseGeminiIncremental({ sessionFiles: [sessionPath], cursors, queuePath });
    assert.equal(res.bucketsQueued, 0);

    const afterSecond = await readJsonLines(queuePath);
    assert.equal(afterSecond.length, afterFirst.length);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseGeminiIncremental skips unchanged files when project state is disabled", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-gemini-"));
  try {
    const sessionPath = path.join(tmp, "session.json");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const session = buildGeminiSession({
      messages: [
        {
          id: "m1",
          type: "assistant",
          timestamp: "2025-12-26T08:05:00.000Z",
          model: "gemini-3-flash-preview",
          tokens: { input: 5, output: 1, cached: 0, thoughts: 0, tool: 0, total: 6 },
        },
      ],
    });

    await fs.writeFile(sessionPath, JSON.stringify(session), "utf8");

    const first = await parseGeminiIncremental({ sessionFiles: [sessionPath], cursors, queuePath });
    assert.equal(first.filesProcessed, 1);
    assert.equal(first.eventsAggregated, 1);
    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].source, "gemini");
    assert.equal(queued[0].model, "gemini-3-flash-preview");
    assert.equal(queued[0].hour_start, "2025-12-26T08:00:00.000Z");
    assert.equal(queued[0].input_tokens, 5);
    assert.equal(queued[0].output_tokens, 1);
    assert.equal(queued[0].total_tokens, 6);

    const cursor = structuredClone(cursors.files[sessionPath]);
    assert.equal(typeof cursor.size, "number");
    assert.equal(typeof cursor.mtimeMs, "number");

    const second = await parseGeminiIncremental({ sessionFiles: [sessionPath], cursors, queuePath });
    assert.equal(second.filesProcessed, 0);
    assert.equal(second.eventsAggregated, 0);
    assert.equal(second.bucketsQueued, 0);
    assert.deepEqual(cursors.files[sessionPath].lastIndex, cursor.lastIndex);
    assert.deepEqual(cursors.files[sessionPath].lastTotals, cursor.lastTotals);
    assert.deepEqual(cursors.files[sessionPath].lastModel, cursor.lastModel);

    const afterSecond = await readJsonLines(queuePath);
    assert.deepEqual(afterSecond, queued);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseGeminiIncremental reprocesses old cursors without unchanged metadata", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-gemini-"));
  try {
    const sessionPath = path.join(tmp, "session.json");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const session = buildGeminiSession({
      messages: [
        {
          id: "m1",
          type: "assistant",
          timestamp: "2025-12-26T08:05:00.000Z",
          model: "gemini-3-flash-preview",
          tokens: { input: 5, output: 1, cached: 0, thoughts: 0, tool: 0, total: 6 },
        },
      ],
    });

    await fs.writeFile(sessionPath, JSON.stringify(session), "utf8");
    await parseGeminiIncremental({ sessionFiles: [sessionPath], cursors, queuePath });
    delete cursors.files[sessionPath].size;
    delete cursors.files[sessionPath].mtimeMs;

    const second = await parseGeminiIncremental({ sessionFiles: [sessionPath], cursors, queuePath });
    assert.equal(second.filesProcessed, 1);
    assert.equal(second.eventsAggregated, 0);
    assert.equal(second.bucketsQueued, 0);
    assert.equal(typeof cursors.files[sessionPath].size, "number");
    assert.equal(typeof cursors.files[sessionPath].mtimeMs, "number");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseGeminiIncremental still processes unchanged files when project state is enabled", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-gemini-"));
  try {
    const projectRoot = path.join(tmp, "repo");
    await fs.mkdir(path.join(projectRoot, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, ".git", "config"),
      `[remote "origin"]\n\turl = https://github.com/acme/alpha.git\n`,
      "utf8",
    );
    const sessionPath = path.join(projectRoot, "session.json");
    const queuePath = path.join(tmp, "queue.jsonl");
    const projectQueuePath = path.join(tmp, "project.queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const session = buildGeminiSession({
      messages: [
        {
          id: "m1",
          type: "assistant",
          timestamp: "2025-12-26T08:05:00.000Z",
          model: "gemini-3-flash-preview",
          tokens: { input: 5, output: 1, cached: 0, thoughts: 0, tool: 0, total: 6 },
        },
      ],
    });

    await fs.writeFile(sessionPath, JSON.stringify(session), "utf8");
    await parseGeminiIncremental({ sessionFiles: [sessionPath], cursors, queuePath });
    const queueAfterFirst = await readJsonLines(queuePath);
    assert.equal(queueAfterFirst.length, 1);

    const second = await parseGeminiIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
      projectQueuePath,
      publicRepoResolver: async ({ projectRef }) => ({
        status: "public_verified",
        projectKey: "acme/alpha",
        projectRef,
      }),
    });
    assert.equal(second.filesProcessed, 1);
    assert.equal(second.eventsAggregated, 0);
    assert.equal(second.bucketsQueued, 0);
    assert.equal(second.projectBucketsQueued, 1);

    const queueAfterSecond = await readJsonLines(queuePath);
    assert.deepEqual(queueAfterSecond, queueAfterFirst);

    const projectQueued = await readJsonLines(projectQueuePath);
    assert.equal(projectQueued.length, 1);
    assert.equal(projectQueued[0].project_key, "acme/alpha");
    assert.equal(projectQueued[0].project_ref, "https://github.com/acme/alpha");
    assert.equal(projectQueued[0].source, "gemini");
    assert.equal(projectQueued[0].hour_start, "2025-12-26T08:00:00.000Z");
    assert.equal(projectQueued[0].input_tokens, 5);
    assert.equal(projectQueued[0].output_tokens, 1);
    assert.equal(projectQueued[0].total_tokens, 6);

    const third = await parseGeminiIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
      projectQueuePath,
      publicRepoResolver: async ({ projectRef }) => ({
        status: "public_verified",
        projectKey: "acme/alpha",
        projectRef,
      }),
    });
    assert.equal(third.filesProcessed, 0);
    assert.equal(third.eventsAggregated, 0);
    assert.equal(third.bucketsQueued, 0);
    assert.equal(third.projectBucketsQueued, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseGeminiIncremental rebuilds project buckets after purge clears file project cursor", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-gemini-purge-"));
  try {
    const projectRoot = path.join(tmp, "repo");
    await fs.mkdir(path.join(projectRoot, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, ".git", "config"),
      `[remote "origin"]\n\turl = https://github.com/acme/alpha.git\n`,
      "utf8",
    );
    const sessionPath = path.join(projectRoot, "session.json");
    const queuePath = path.join(tmp, "queue.jsonl");
    const projectQueuePath = path.join(tmp, "project.queue.jsonl");
    const projectQueueStatePath = path.join(tmp, "project.queue.state.json");
    const cursors = { version: 1, files: {}, updatedAt: null };
    const publicRepoResolver = async ({ projectRef }) => ({
      status: "public_verified",
      projectKey: "acme/alpha",
      projectRef,
    });

    const session = buildGeminiSession({
      messages: [
        {
          id: "m1",
          type: "assistant",
          timestamp: "2025-12-26T08:05:00.000Z",
          model: "gemini-3-flash-preview",
          tokens: { input: 5, output: 1, cached: 0, thoughts: 0, tool: 0, total: 6 },
        },
      ],
    });

    await fs.writeFile(sessionPath, JSON.stringify(session), "utf8");
    const first = await parseGeminiIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
      projectQueuePath,
      publicRepoResolver,
    });
    assert.equal(first.projectBucketsQueued, 1);
    assert.equal(cursors.files[sessionPath].project.projectKey, "acme/alpha");

    const purge = await purgeProjectUsage({
      projectKey: "acme/alpha",
      projectQueuePath,
      projectQueueStatePath,
      projectState: cursors.projectHourly,
      cursors,
    });
    assert.equal(purge.removed, 1);
    assert.equal(purge.removedBuckets, 1);
    assert.equal(purge.removedProjectCursors, 1);
    assert.equal(cursors.files[sessionPath].project, undefined);

    const second = await parseGeminiIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
      projectQueuePath,
      publicRepoResolver,
    });
    assert.equal(second.filesProcessed, 1);
    assert.equal(second.eventsAggregated, 0);
    assert.equal(second.bucketsQueued, 0);
    assert.equal(second.projectBucketsQueued, 1);

    const mainQueued = await readJsonLines(queuePath);
    assert.equal(mainQueued.length, 1);

    const projectQueued = await readJsonLines(projectQueuePath);
    assert.equal(projectQueued.length, 1);
    assert.equal(projectQueued[0].project_key, "acme/alpha");
    assert.equal(projectQueued[0].source, "gemini");
    assert.equal(projectQueued[0].total_tokens, 6);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseGeminiIncremental defaults missing model to unknown", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-gemini-"));
  try {
    const sessionPath = path.join(tmp, "session.json");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const session = buildGeminiSession({
      messages: [
        {
          id: "m1",
          type: "assistant",
          timestamp: "2025-12-26T08:05:00.000Z",
          tokens: { input: 1, output: 0, cached: 0, thoughts: 0, tool: 0, total: 1 },
        },
      ],
    });

    await fs.writeFile(sessionPath, JSON.stringify(session), "utf8");

    const res = await parseGeminiIncremental({ sessionFiles: [sessionPath], cursors, queuePath });
    assert.equal(res.bucketsQueued, 1);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].model, "unknown");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseCursorApiIncremental treats Cursor CSV as authoritative and replaces prior cursor buckets", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-cursor-reconcile-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const first = await parseCursorApiIncremental({
      records: [
        {
          date: "2026-04-01T10:00:00.000Z",
          model: "auto",
          kind: "Included",
          inputTokens: 100,
          cacheReadTokens: 10,
          cacheWriteTokens: 0,
          outputTokens: 20,
          totalTokens: 130,
        },
      ],
      cursors,
      queuePath,
      source: "cursor",
    });
    assert.equal(first.eventsAggregated, 1);

    const second = await parseCursorApiIncremental({
      records: [
        {
          date: "2026-04-01T10:00:00.000Z",
          model: "auto",
          kind: "Included",
          inputTokens: 40,
          cacheReadTokens: 4,
          cacheWriteTokens: 0,
          outputTokens: 6,
          totalTokens: 50,
        },
      ],
      cursors,
      queuePath,
      source: "cursor",
    });
    assert.equal(second.eventsAggregated, 1);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 2);
    assert.equal(queued.at(-1).total_tokens, 50);
    assert.equal(queued.at(-1).input_tokens, 40);
    assert.equal(queued.at(-1).cached_input_tokens, 4);
    assert.equal(cursors.hourly.buckets["cursor|auto|2026-04-01T10:00:00.000Z"].totals.total_tokens, 50);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseCursorApiIncremental preserves history older than a windowed/truncated export", async () => {
  // Guard (2026-06 audit): the wipe-then-refill design assumes the Cursor
  // export is full-history. If the endpoint ever returns a windowed export
  // (e.g. current billing period only), buckets older than the response
  // must NOT be zeroed — zeroed buckets get re-emitted and uploaded,
  // overwriting the cloud copy with zeros.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-cursor-window-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };
    const mkRecord = (date, inputTokens) => ({
      date,
      model: "auto",
      kind: "Included",
      inputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      totalTokens: inputTokens,
    });

    // Full export: old + recent rows.
    await parseCursorApiIncremental({
      records: [
        mkRecord("2026-01-05T09:00:00.000Z", 1000),
        mkRecord("2026-04-01T10:00:00.000Z", 100),
      ],
      cursors,
      queuePath,
      source: "cursor",
    });
    const oldKey = "cursor|auto|2026-01-05T09:00:00.000Z";
    assert.equal(cursors.hourly.buckets[oldKey].totals.total_tokens, 1000);

    // Windowed export: only the recent row comes back (correction to 80).
    await parseCursorApiIncremental({
      records: [mkRecord("2026-04-01T10:00:00.000Z", 80)],
      cursors,
      queuePath,
      source: "cursor",
    });
    assert.equal(
      cursors.hourly.buckets[oldKey].totals.total_tokens,
      1000,
      "history older than the export window must survive",
    );
    assert.equal(
      cursors.hourly.buckets["cursor|auto|2026-04-01T10:00:00.000Z"].totals.total_tokens,
      80,
      "rows inside the window are still authoritatively replaced",
    );

    // Malformed export (records without parseable dates): wipe nothing.
    await parseCursorApiIncremental({
      records: [{ model: "auto", kind: "Included", inputTokens: 5 }],
      cursors,
      queuePath,
      source: "cursor",
    });
    assert.equal(cursors.hourly.buckets[oldKey].totals.total_tokens, 1000);
    assert.equal(
      cursors.hourly.buckets["cursor|auto|2026-04-01T10:00:00.000Z"].totals.total_tokens,
      80,
      "a dateless export must not zero anything",
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseOpencodeIncremental aggregates message tokens and model", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-opencode-"));
  try {
    const messageDir = path.join(tmp, "message", "ses_test");
    await fs.mkdir(messageDir, { recursive: true });
    const messagePath = path.join(messageDir, "msg_test.json");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const message = buildOpencodeMessage({
      modelID: "gpt-4o",
      created: "2025-12-29T10:14:00.000Z",
      completed: "2025-12-29T10:15:00.000Z",
      tokens: { input: 10, output: 2, reasoning: 1, cached: 3, cacheWrite: 5 },
    });

    await fs.writeFile(messagePath, JSON.stringify(message), "utf8");

    const res = await parseOpencodeIncremental({ messageFiles: [messagePath], cursors, queuePath });
    assert.equal(res.filesProcessed, 1);
    assert.equal(res.eventsAggregated, 1);
    assert.equal(res.bucketsQueued, 1);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].source, "opencode");
    assert.equal(queued[0].model, "gpt-4o");
    assert.equal(queued[0].hour_start, "2025-12-29T10:00:00.000Z");
    assert.equal(queued[0].input_tokens, 10);
    assert.equal(queued[0].cached_input_tokens, 3);
    assert.equal(queued[0].cache_creation_input_tokens, 5);
    assert.equal(queued[0].output_tokens, 2);
    assert.equal(queued[0].reasoning_output_tokens, 1);
    assert.equal(queued[0].total_tokens, 21); // 10 + 2 + 1 + 3 + 5
    assert.equal(queued[0].conversation_count, 1);
    assert.equal(typeof queued[0].content, "undefined");

    const resAgain = await parseOpencodeIncremental({
      messageFiles: [messagePath],
      cursors,
      queuePath,
    });
    assert.equal(resAgain.bucketsQueued, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("readOpencodeDbMessages falls back to node:sqlite when sqlite3 CLI is unavailable", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-opencode-db-"));
  try {
    const dbPath = path.join(tmp, "opencode.db");
    await fs.writeFile(dbPath, "", "utf8");
    const message = buildOpencodeMessage({
      modelID: "deepseek-v4-flash-free",
      created: "2025-12-29T10:14:00.000Z",
      completed: "2025-12-29T10:15:00.000Z",
      tokens: { input: 34, output: 10, reasoning: 2, cached: 0, cacheWrite: 0 },
    });
    const rows = readOpencodeDbMessages(dbPath, {
      execFileSync() {
        throw new Error("spawn sqlite3 ENOENT");
      },
      requireFn(name) {
        assert.equal(name, "node:sqlite");
        return {
          DatabaseSync: class FakeDatabaseSync {
            constructor(actualDbPath, options) {
              assert.equal(actualDbPath, dbPath);
              assert.deepEqual(options, { readOnly: true });
            }

            prepare(sql) {
              assert.match(sql, /FROM message/);
              return {
                all() {
                  return [
                    {
                      id: "msg_db_1",
                      session_id: "ses_db_1",
                      time_updated: Date.parse("2025-12-29T10:15:00.000Z"),
                      data: JSON.stringify(message),
                    },
                  ];
                },
              };
            }

            close() {}
          },
        };
      },
      stderr: { write() {} },
    });

    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "msg_db_1");
    assert.equal(rows[0].sessionID, "ses_db_1");
    assert.equal(rows[0].data.modelID, "deepseek-v4-flash-free");
    assert.equal(rows[0].data.tokens.input, 34);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// Build a fake node:sqlite injection that returns the given OpenCode-shaped
// message objects as `message` table rows (id/session_id/time_updated/data).
function fakeZcodeSqliteOptions(dbPath, messages) {
  return {
    execFileSync() {
      throw new Error("spawn sqlite3 ENOENT");
    },
    requireFn(name) {
      assert.equal(name, "node:sqlite");
      return {
        DatabaseSync: class FakeDatabaseSync {
          constructor(actualDbPath, options) {
            assert.equal(actualDbPath, dbPath);
            assert.deepEqual(options, { readOnly: true });
          }
          prepare(sql) {
            assert.match(sql, /FROM message/);
            return {
              all() {
                return messages.map((m, i) => ({
                  id: m.id || `msg_${i}`,
                  session_id: m.sessionID || `ses_${i}`,
                  time_updated: m.time?.completed || 0,
                  data: JSON.stringify(m),
                }));
              },
            };
          }
          close() {}
        },
      };
    },
    stderr: { write() {} },
  };
}

test("readZcodeDbMessages keeps Z.ai/BigModel + third-party rows, drops bundled sub-agent turns", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-zcode-db-"));
  try {
    const dbPath = path.join(tmp, "db.sqlite");
    await fs.writeFile(dbPath, "", "utf8");

    const base = {
      created: "2026-06-15T09:00:00.000Z",
      completed: "2026-06-15T09:00:12.000Z",
      tokens: { input: 100, output: 20, reasoning: 0, cached: 50, cacheWrite: 0 },
    };
    const messages = [
      // ZCode-native (its own GLM agent via Z.ai / BigModel) — KEEP
      { ...buildOpencodeMessage({ ...base, modelID: "GLM-5.2" }), id: "z1", sessionID: "s1", providerID: "builtin:zai-start-plan" },
      { ...buildOpencodeMessage({ ...base, modelID: "GLM-5-Turbo" }), id: "z2", sessionID: "s1", providerID: "builtin:bigmodel-coding-plan" },
      // Custom providers the user adds to ZCode (a built-in feature beyond the
      // Z.ai plan subscription) get a random UUID as providerID — NOT a vendor
      // name. Observed on a real box: mimo-v2.5-pro under UUID "265956bf-…". An
      // allowlist of vendor keywords can never match a UUID, so these turns must
      // be KEEP-by-default or they go uncounted entirely (issue #216).
      { ...buildOpencodeMessage({ ...base, modelID: "mimo-v2.5-pro" }), id: "m1", sessionID: "s5", providerID: "265956bf-e1b9-491d-879a-28a7944ff1b9" },
      { ...buildOpencodeMessage({ ...base, modelID: "fugu-ultra" }), id: "f1", sessionID: "s4", providerID: "a1b2c3d4-0000-4000-8000-000000000000" },
      // Bundled sub-agents ZCode can orchestrate — already counted by the
      // standalone Claude/Codex/Gemini parsers, so DROP
      // (anthropic/openai/google providerID).
      { ...buildOpencodeMessage({ ...base, modelID: "claude-opus-4-8" }), id: "a1", sessionID: "s2", providerID: "anthropic" },
      { ...buildOpencodeMessage({ ...base, modelID: "gpt-5.2-codex" }), id: "o1", sessionID: "s3", providerID: "openai" },
      { ...buildOpencodeMessage({ ...base, modelID: "gemini-3-pro" }), id: "g1", sessionID: "s6", providerID: "google" },
    ];

    const rows = readZcodeDbMessages(dbPath, fakeZcodeSqliteOptions(dbPath, messages));
    assert.equal(rows.length, 4);
    // GLM-native + both UUID-keyed custom-provider third-party models survive.
    const models = rows.map((r) => r.data.modelID).sort();
    assert.deepEqual(models, ["GLM-5-Turbo", "GLM-5.2", "fugu-ultra", "mimo-v2.5-pro"]);
    // No bundled anthropic/openai/google sub-agent turn survives the filter.
    assert.ok(!rows.some((r) => /anthropic|openai|google/.test(r.data.providerID)));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseOpencodeDbIncremental aggregates ZCode GLM rows into source=zcode buckets (idempotent)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-zcode-parse-"));
  try {
    const dbPath = path.join(tmp, "db.sqlite");
    await fs.writeFile(dbPath, "", "utf8");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const messages = [
      {
        ...buildOpencodeMessage({
          modelID: "GLM-5.2",
          created: "2026-06-15T09:00:00.000Z",
          completed: "2026-06-15T09:00:12.000Z",
          tokens: { input: 10478, output: 203, reasoning: 0, cached: 7040, cacheWrite: 0 },
        }),
        id: "z1",
        sessionID: "s1",
        providerID: "builtin:zai-start-plan",
      },
    ];

    const dbMessages = readZcodeDbMessages(dbPath, fakeZcodeSqliteOptions(dbPath, messages));
    const res = await parseOpencodeDbIncremental({
      dbMessages,
      cursors,
      queuePath,
      source: "zcode",
      cursorKey: "zcode",
    });
    assert.equal(res.bucketsQueued, 1);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].source, "zcode");
    // Model is stored with the DB's original case ("GLM-5.2"); the pricing
    // matcher is case-insensitive so cost still resolves to the curated key.
    assert.equal(queued[0].model, "GLM-5.2");
    assert.equal(queued[0].input_tokens, 10478);
    assert.equal(queued[0].output_tokens, 203);
    assert.equal(queued[0].cached_input_tokens, 7040);

    // Second run over the same DB must be a no-op (cursor dedup).
    const dbMessages2 = readZcodeDbMessages(dbPath, fakeZcodeSqliteOptions(dbPath, messages));
    const resAgain = await parseOpencodeDbIncremental({
      dbMessages: dbMessages2,
      cursors,
      queuePath,
      source: "zcode",
      cursorKey: "zcode",
    });
    assert.equal(resAgain.bucketsQueued, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseOpencodeIncremental defaults missing model to unknown", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-opencode-"));
  try {
    const messageDir = path.join(tmp, "message", "ses_test");
    await fs.mkdir(messageDir, { recursive: true });
    const messagePath = path.join(messageDir, "msg_test.json");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const message = buildOpencodeMessage({
      created: "2025-12-29T10:20:00.000Z",
      tokens: { input: 1, output: 0, reasoning: 0, cached: 0 },
    });

    await fs.writeFile(messagePath, JSON.stringify(message), "utf8");

    const res = await parseOpencodeIncremental({ messageFiles: [messagePath], cursors, queuePath });
    assert.equal(res.bucketsQueued, 1);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].model, "unknown");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseOpencodeIncremental falls back to model field when modelID missing", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-opencode-"));
  try {
    const messageDir = path.join(tmp, "message", "ses_test");
    await fs.mkdir(messageDir, { recursive: true });
    const messagePath = path.join(messageDir, "msg_test.json");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const message = buildOpencodeMessage({
      model: "glm-4.7-free",
      created: "2025-12-29T10:30:00.000Z",
      tokens: { input: 2, output: 1, reasoning: 0, cached: 0 },
    });

    await fs.writeFile(messagePath, JSON.stringify(message), "utf8");

    const res = await parseOpencodeIncremental({ messageFiles: [messagePath], cursors, queuePath });
    assert.equal(res.bucketsQueued, 1);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].model, "glm-4.7-free");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseOpencodeIncremental does not double count after message rewrite", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-opencode-"));
  try {
    const messageDir = path.join(tmp, "message", "ses_test");
    await fs.mkdir(messageDir, { recursive: true });
    const messagePath = path.join(messageDir, "msg_test.json");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const message = buildOpencodeMessage({
      modelID: "gpt-4o",
      created: "2025-12-29T10:14:00.000Z",
      completed: "2025-12-29T10:15:00.000Z",
      tokens: { input: 4, output: 1, reasoning: 0, cached: 0 },
    });

    await fs.writeFile(messagePath, JSON.stringify(message), "utf8");

    const res = await parseOpencodeIncremental({ messageFiles: [messagePath], cursors, queuePath });
    assert.equal(res.bucketsQueued, 1);

    await fs.rm(messagePath);
    await fs.writeFile(messagePath, JSON.stringify(message), "utf8");

    const resAgain = await parseOpencodeIncremental({
      messageFiles: [messagePath],
      cursors,
      queuePath,
    });
    assert.equal(resAgain.bucketsQueued, 0);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].total_tokens, 5);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseOpencodeIncremental falls back to legacy cursors when opencode state missing", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-opencode-"));
  try {
    const messageDir = path.join(tmp, "message", "ses_test");
    await fs.mkdir(messageDir, { recursive: true });
    const messagePath = path.join(messageDir, "msg_test.json");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const message = buildOpencodeMessage({
      modelID: "gpt-4o",
      created: "2025-12-29T10:14:00.000Z",
      completed: "2025-12-29T10:15:00.000Z",
      tokens: { input: 4, output: 1, reasoning: 0, cached: 0 },
    });

    await fs.writeFile(messagePath, JSON.stringify(message), "utf8");
    const res = await parseOpencodeIncremental({ messageFiles: [messagePath], cursors, queuePath });
    assert.equal(res.bucketsQueued, 1);

    delete cursors.opencode;

    await fs.rm(messagePath);
    await fs.writeFile(messagePath, JSON.stringify(message), "utf8");

    const resAgain = await parseOpencodeIncremental({
      messageFiles: [messagePath],
      cursors,
      queuePath,
    });
    assert.equal(resAgain.bucketsQueued, 0);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].total_tokens, 5);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseOpencodeIncremental counts usage once timestamp appears", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-opencode-"));
  try {
    const messageDir = path.join(tmp, "message", "ses_test");
    await fs.mkdir(messageDir, { recursive: true });
    const messagePath = path.join(messageDir, "msg_test.json");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const messageNoTime = buildOpencodeMessage({
      modelID: "gpt-4o",
      tokens: { input: 4, output: 1, reasoning: 0, cached: 0 },
    });

    await fs.writeFile(messagePath, JSON.stringify(messageNoTime), "utf8");
    const res = await parseOpencodeIncremental({ messageFiles: [messagePath], cursors, queuePath });
    assert.equal(res.bucketsQueued, 0);

    await fs.rm(messagePath);
    const messageWithTime = buildOpencodeMessage({
      modelID: "gpt-4o",
      created: "2025-12-29T10:14:00.000Z",
      completed: "2025-12-29T10:15:00.000Z",
      tokens: { input: 4, output: 1, reasoning: 0, cached: 0 },
    });
    await fs.writeFile(messagePath, JSON.stringify(messageWithTime), "utf8");

    const resAgain = await parseOpencodeIncremental({
      messageFiles: [messagePath],
      cursors,
      queuePath,
    });
    assert.equal(resAgain.bucketsQueued, 1);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].total_tokens, 5);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseOpencodeIncremental preserves totals after empty rewrite", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-opencode-"));
  try {
    const messageDir = path.join(tmp, "message", "ses_test");
    await fs.mkdir(messageDir, { recursive: true });
    const messagePath = path.join(messageDir, "msg_test.json");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const message = buildOpencodeMessage({
      modelID: "gpt-4o",
      created: "2025-12-29T10:14:00.000Z",
      completed: "2025-12-29T10:15:00.000Z",
      tokens: { input: 4, output: 1, reasoning: 0, cached: 0 },
    });

    await fs.writeFile(messagePath, JSON.stringify(message), "utf8");
    const res = await parseOpencodeIncremental({ messageFiles: [messagePath], cursors, queuePath });
    assert.equal(res.bucketsQueued, 1);

    delete cursors.opencode;

    await fs.rm(messagePath);
    await fs.writeFile(messagePath, "", "utf8");
    const resEmpty = await parseOpencodeIncremental({
      messageFiles: [messagePath],
      cursors,
      queuePath,
    });
    assert.equal(resEmpty.bucketsQueued, 0);

    await fs.rm(messagePath);
    await fs.writeFile(messagePath, JSON.stringify(message), "utf8");
    const resAgain = await parseOpencodeIncremental({
      messageFiles: [messagePath],
      cursors,
      queuePath,
    });
    assert.equal(resAgain.bucketsQueued, 0);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].total_tokens, 5);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
test("parseOpencodeIncremental updates totals after message rewrite with new tokens", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-opencode-"));
  try {
    const messageDir = path.join(tmp, "message", "ses_test");
    await fs.mkdir(messageDir, { recursive: true });
    const messagePath = path.join(messageDir, "msg_test.json");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const baseMessage = {
      modelID: "gpt-4o",
      created: "2025-12-29T10:14:00.000Z",
      completed: "2025-12-29T10:15:00.000Z",
    };

    const messageV1 = buildOpencodeMessage({
      ...baseMessage,
      tokens: { input: 5, output: 0, reasoning: 0, cached: 0 },
    });

    await fs.writeFile(messagePath, JSON.stringify(messageV1), "utf8");
    const res = await parseOpencodeIncremental({ messageFiles: [messagePath], cursors, queuePath });
    assert.equal(res.bucketsQueued, 1);

    await fs.rm(messagePath);
    const messageV2 = buildOpencodeMessage({
      ...baseMessage,
      tokens: { input: 8, output: 0, reasoning: 0, cached: 0 },
    });
    await fs.writeFile(messagePath, JSON.stringify(messageV2), "utf8");

    const resAgain = await parseOpencodeIncremental({
      messageFiles: [messagePath],
      cursors,
      queuePath,
    });
    assert.equal(resAgain.bucketsQueued, 1);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 2);
    assert.equal(queued[1].total_tokens, 8);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseOpencodeIncremental preserves legacy file totals when opencode index missing", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-opencode-"));
  try {
    const messageDir = path.join(tmp, "message", "ses_test");
    await fs.mkdir(messageDir, { recursive: true });
    const messagePath = path.join(messageDir, "msg_test.json");
    const queuePath = path.join(tmp, "queue.jsonl");

    const message = buildOpencodeMessage({
      modelID: "gpt-4o",
      created: "2025-12-29T10:14:00.000Z",
      completed: "2025-12-29T10:15:00.000Z",
      tokens: { input: 4, output: 1, reasoning: 0, cached: 0 },
    });

    await fs.writeFile(messagePath, JSON.stringify(message), "utf8");
    const st = await fs.stat(messagePath);

    const legacyTotals = {
      input_tokens: 4,
      cached_input_tokens: 0,
      output_tokens: 1,
      reasoning_output_tokens: 0,
      total_tokens: 5,
    };

    const cursors = {
      version: 1,
      files: {
        [messagePath]: {
          inode: st.ino,
          size: st.size,
          mtimeMs: st.mtimeMs,
          lastTotals: legacyTotals,
          updatedAt: "2025-12-29T10:20:00.000Z",
        },
      },
      updatedAt: null,
    };

    await fs.writeFile(messagePath, JSON.stringify(message), "utf8");

    const res = await parseOpencodeIncremental({ messageFiles: [messagePath], cursors, queuePath });
    assert.equal(res.eventsAggregated, 0);
    assert.equal(res.bucketsQueued, 0);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseRolloutIncremental subtracts cached_input_tokens from Codex input_tokens to match our schema", async () => {
  // Regression guard for the ~6-7x leaderboard cost inflation caused by
  // treating Codex's inclusive-of-cached `input_tokens` as pure non-cached
  // input. Anchors the numbers against a realistic cache-heavy session
  // (95% cache hit) like the ones flagged in production.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-codex-cached-"));
  try {
    const rolloutPath = path.join(tmp, "rollout-codex.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    // Shape mirrors a real codex rollout `token_count` event: input_tokens
    // is the TOTAL prompt (1_000_000), of which 950_000 is cache-read. The
    // Codex-native total_tokens invariant is input + output (= 1_010_000),
    // which also happens to equal our schema's non_cached + cached + output.
    const usage = {
      input_tokens: 1_000_000,
      cached_input_tokens: 950_000,
      output_tokens: 10_000,
      reasoning_output_tokens: 4_000,
      total_tokens: 1_010_000,
    };

    await fs.writeFile(
      rolloutPath,
      buildTokenCountLine({ ts: "2026-04-20T00:10:00.000Z", last: usage, total: usage }) + "\n",
      "utf8",
    );

    await parseRolloutIncremental({
      rolloutFiles: [{ path: rolloutPath, source: "codex" }],
      cursors,
      queuePath,
    });

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    // Pure non-cached input = 1_000_000 - 950_000 = 50_000.
    assert.equal(queued[0].input_tokens, 50_000);
    assert.equal(queued[0].cached_input_tokens, 950_000);
    assert.equal(queued[0].output_tokens, 10_000);
    assert.equal(queued[0].reasoning_output_tokens, 4_000);
    // total_tokens left as reported: still equals non_cached + cached + output
    // numerically, so downstream aggregation stays stable.
    assert.equal(queued[0].total_tokens, 1_010_000);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseRolloutIncremental handles Every Code token_count envelope", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-rollout-"));
  try {
    const rolloutPath = path.join(tmp, "rollout-test.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const usage = {
      input_tokens: 2,
      cached_input_tokens: 1,
      output_tokens: 3,
      reasoning_output_tokens: 0,
      total_tokens: 6,
    };

    const lines = [
      buildEveryCodeTokenCountLine({ ts: "2025-12-17T00:05:00.000Z", last: usage, total: usage }),
    ];

    await fs.writeFile(rolloutPath, lines.join("\n") + "\n", "utf8");

    const res = await parseRolloutIncremental({
      rolloutFiles: [{ path: rolloutPath, source: "every-code" }],
      cursors,
      queuePath,
    });
    assert.equal(res.filesProcessed, 1);
    assert.equal(res.eventsAggregated, 1);
    assert.equal(res.bucketsQueued, 1);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].source, "every-code");
    assert.equal(queued[0].total_tokens, usage.total_tokens);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseRolloutIncremental keeps buckets separate per source", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-rollout-"));
  try {
    const codexPath = path.join(tmp, "rollout-codex.jsonl");
    const everyPath = path.join(tmp, "rollout-every.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const usage = {
      input_tokens: 1,
      cached_input_tokens: 0,
      output_tokens: 1,
      reasoning_output_tokens: 0,
      total_tokens: 2,
    };

    const line = buildTokenCountLine({ ts: "2025-12-17T00:00:00.000Z", last: usage, total: usage });
    await fs.writeFile(codexPath, line + "\n", "utf8");
    await fs.writeFile(
      everyPath,
      buildEveryCodeTokenCountLine({ ts: "2025-12-17T00:00:00.000Z", last: usage, total: usage }) +
        "\n",
      "utf8",
    );

    const res = await parseRolloutIncremental({
      rolloutFiles: [
        { path: codexPath, source: "codex" },
        { path: everyPath, source: "every-code" },
      ],
      cursors,
      queuePath,
    });
    assert.equal(res.filesProcessed, 2);
    assert.equal(res.eventsAggregated, 2);
    assert.equal(res.bucketsQueued, 2);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 2);
    const sources = queued.map((row) => row.source).sort();
    assert.deepEqual(sources, ["codex", "every-code"]);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseRolloutIncremental keeps buckets separate per model within the same hour", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-rollout-"));
  try {
    const rolloutPath = path.join(tmp, "rollout-test.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const usage1 = {
      input_tokens: 1,
      cached_input_tokens: 0,
      output_tokens: 1,
      reasoning_output_tokens: 0,
      total_tokens: 2,
    };
    const usage2 = {
      input_tokens: 2,
      cached_input_tokens: 0,
      output_tokens: 1,
      reasoning_output_tokens: 0,
      total_tokens: 3,
    };

    const totals2 = {
      input_tokens: usage1.input_tokens + usage2.input_tokens,
      cached_input_tokens: 0,
      output_tokens: usage1.output_tokens + usage2.output_tokens,
      reasoning_output_tokens: 0,
      total_tokens: usage1.total_tokens + usage2.total_tokens,
    };

    const lines = [
      buildTurnContextLine({ model: "gpt-4o" }),
      buildTokenCountLine({ ts: "2025-12-17T00:05:00.000Z", last: usage1, total: usage1 }),
      buildTurnContextLine({ model: "gpt-4o-mini" }),
      buildTokenCountLine({ ts: "2025-12-17T00:10:00.000Z", last: usage2, total: totals2 }),
    ];

    await fs.writeFile(rolloutPath, lines.join("\n") + "\n", "utf8");

    const res = await parseRolloutIncremental({ rolloutFiles: [rolloutPath], cursors, queuePath });
    assert.equal(res.filesProcessed, 1);
    assert.equal(res.eventsAggregated, 2);
    assert.equal(res.bucketsQueued, 2);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 2);
    const byModel = new Map(queued.map((row) => [row.model, row]));
    assert.ok(byModel.has("gpt-4o"));
    assert.ok(byModel.has("gpt-4o-mini"));
    assert.equal(byModel.get("gpt-4o").total_tokens, usage1.total_tokens);
    assert.equal(byModel.get("gpt-4o-mini").total_tokens, usage2.total_tokens);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseRolloutIncremental backfills unknown into dominant known model", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-rollout-"));
  try {
    const rolloutPath = path.join(tmp, "rollout-test.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const usageUnknown = {
      input_tokens: 1,
      cached_input_tokens: 0,
      output_tokens: 1,
      reasoning_output_tokens: 0,
      total_tokens: 2,
    };
    const usageA = {
      input_tokens: 2,
      cached_input_tokens: 0,
      output_tokens: 1,
      reasoning_output_tokens: 0,
      total_tokens: 3,
    };
    const usageB = {
      input_tokens: 3,
      cached_input_tokens: 0,
      output_tokens: 1,
      reasoning_output_tokens: 0,
      total_tokens: 4,
    };

    const lines = [
      buildTokenCountLine({
        ts: "2025-12-17T00:05:00.000Z",
        last: usageUnknown,
        total: usageUnknown,
      }),
      buildTurnContextLine({ model: "gpt-4o" }),
      buildTokenCountLine({
        ts: "2025-12-17T00:10:00.000Z",
        last: usageA,
        total: {
          input_tokens: usageUnknown.input_tokens + usageA.input_tokens,
          cached_input_tokens: 0,
          output_tokens: usageUnknown.output_tokens + usageA.output_tokens,
          reasoning_output_tokens: 0,
          total_tokens: usageUnknown.total_tokens + usageA.total_tokens,
        },
      }),
      buildTurnContextLine({ model: "gpt-4o-mini" }),
      buildTokenCountLine({
        ts: "2025-12-17T00:15:00.000Z",
        last: usageB,
        total: {
          input_tokens: usageUnknown.input_tokens + usageA.input_tokens + usageB.input_tokens,
          cached_input_tokens: 0,
          output_tokens: usageUnknown.output_tokens + usageA.output_tokens + usageB.output_tokens,
          reasoning_output_tokens: 0,
          total_tokens: usageUnknown.total_tokens + usageA.total_tokens + usageB.total_tokens,
        },
      }),
    ];

    await fs.writeFile(rolloutPath, lines.join("\n") + "\n", "utf8");

    const res = await parseRolloutIncremental({ rolloutFiles: [rolloutPath], cursors, queuePath });
    assert.equal(res.bucketsQueued, 2);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 2);
    const byModel = new Map(queued.map((row) => [row.model, row]));
    assert.ok(byModel.has("gpt-4o"));
    assert.ok(byModel.has("gpt-4o-mini"));
    assert.equal(byModel.get("gpt-4o").total_tokens, usageA.total_tokens);
    assert.equal(
      byModel.get("gpt-4o-mini").total_tokens,
      usageB.total_tokens + usageUnknown.total_tokens,
    );
    assert.ok(!byModel.has("unknown"));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseRolloutIncremental chooses dominant model deterministically on tie", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-rollout-"));
  try {
    const rolloutPath = path.join(tmp, "rollout-test.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const usageUnknown = {
      input_tokens: 1,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 1,
    };
    const usageA = {
      input_tokens: 2,
      cached_input_tokens: 0,
      output_tokens: 1,
      reasoning_output_tokens: 0,
      total_tokens: 3,
    };
    const usageB = {
      input_tokens: 2,
      cached_input_tokens: 0,
      output_tokens: 1,
      reasoning_output_tokens: 0,
      total_tokens: 3,
    };
    const totalsB = {
      input_tokens: usageUnknown.input_tokens + usageB.input_tokens,
      cached_input_tokens: 0,
      output_tokens: usageUnknown.output_tokens + usageB.output_tokens,
      reasoning_output_tokens: 0,
      total_tokens: usageUnknown.total_tokens + usageB.total_tokens,
    };
    const totalsA = {
      input_tokens: totalsB.input_tokens + usageA.input_tokens,
      cached_input_tokens: 0,
      output_tokens: totalsB.output_tokens + usageA.output_tokens,
      reasoning_output_tokens: 0,
      total_tokens: totalsB.total_tokens + usageA.total_tokens,
    };

    const lines = [
      buildTokenCountLine({
        ts: "2025-12-17T00:05:00.000Z",
        last: usageUnknown,
        total: usageUnknown,
      }),
      buildTurnContextLine({ model: "gpt-4o-mini" }),
      buildTokenCountLine({ ts: "2025-12-17T00:10:00.000Z", last: usageB, total: totalsB }),
      buildTurnContextLine({ model: "gpt-4o" }),
      buildTokenCountLine({ ts: "2025-12-17T00:15:00.000Z", last: usageA, total: totalsA }),
    ];

    await fs.writeFile(rolloutPath, lines.join("\n") + "\n", "utf8");

    const res = await parseRolloutIncremental({ rolloutFiles: [rolloutPath], cursors, queuePath });
    assert.equal(res.bucketsQueued, 2);

    const queued = await readJsonLines(queuePath);
    const byModel = new Map(queued.map((row) => [row.model, row]));
    assert.ok(byModel.has("gpt-4o"));
    assert.ok(byModel.has("gpt-4o-mini"));
    assert.equal(
      byModel.get("gpt-4o").total_tokens,
      usageA.total_tokens + usageUnknown.total_tokens,
    );
    assert.equal(byModel.get("gpt-4o-mini").total_tokens, usageB.total_tokens);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseRolloutIncremental aligns every-code unknown to nearest codex model", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-rollout-"));
  try {
    const codexPath = path.join(tmp, "rollout-codex.jsonl");
    const everyPath = path.join(tmp, "rollout-every.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const codexUsage = {
      input_tokens: 4,
      cached_input_tokens: 0,
      output_tokens: 1,
      reasoning_output_tokens: 0,
      total_tokens: 5,
    };
    const everyUsage = {
      input_tokens: 1,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 1,
    };

    const codexLines = [
      buildTurnContextLine({ model: "gpt-4o" }),
      buildTokenCountLine({ ts: "2025-12-17T00:30:00.000Z", last: codexUsage, total: codexUsage }),
    ];
    const everyLines = [
      buildTokenCountLine({ ts: "2025-12-17T00:10:00.000Z", last: everyUsage, total: everyUsage }),
    ];

    await fs.writeFile(codexPath, codexLines.join("\n") + "\n", "utf8");
    await fs.writeFile(everyPath, everyLines.join("\n") + "\n", "utf8");

    const res = await parseRolloutIncremental({
      rolloutFiles: [
        { path: codexPath, source: "codex" },
        { path: everyPath, source: "every-code" },
      ],
      cursors,
      queuePath,
    });
    assert.equal(res.bucketsQueued, 2);

    const queued = await readJsonLines(queuePath);
    const bySource = new Map(queued.map((row) => [row.source, row]));
    assert.equal(bySource.get("every-code").model, "gpt-4o");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseRolloutIncremental breaks ties by earlier codex bucket", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-rollout-"));
  try {
    const codexPath = path.join(tmp, "rollout-codex.jsonl");
    const everyPath = path.join(tmp, "rollout-every.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const usage = {
      input_tokens: 2,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 2,
    };

    const codexLines = [
      buildTurnContextLine({ model: "gpt-4o" }),
      buildTokenCountLine({ ts: "2025-12-17T00:00:00.000Z", last: usage, total: usage }),
      buildTurnContextLine({ model: "gpt-4o-mini" }),
      buildTokenCountLine({
        ts: "2025-12-17T01:00:00.000Z",
        last: usage,
        total: {
          input_tokens: usage.input_tokens * 2,
          cached_input_tokens: 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
          total_tokens: usage.total_tokens * 2,
        },
      }),
    ];
    const everyLines = [
      buildTokenCountLine({ ts: "2025-12-17T00:30:00.000Z", last: usage, total: usage }),
    ];

    await fs.writeFile(codexPath, codexLines.join("\n") + "\n", "utf8");
    await fs.writeFile(everyPath, everyLines.join("\n") + "\n", "utf8");

    const res = await parseRolloutIncremental({
      rolloutFiles: [
        { path: codexPath, source: "codex" },
        { path: everyPath, source: "every-code" },
      ],
      cursors,
      queuePath,
    });
    // Two codex buckets (gpt-4o @00:00, gpt-4o-mini @01:00) + one every-code
    // bucket that aligns to the earlier gpt-4o tie. Under the old sameUsage
    // guard the second codex event was de-duped, yielding 2.
    assert.equal(res.bucketsQueued, 3);

    const queued = await readJsonLines(queuePath);
    const bySource = new Map(queued.map((row) => [row.source, row]));
    assert.equal(bySource.get("every-code").model, "gpt-4o");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseRolloutIncremental retracts prior every-code alignment when target changes", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-rollout-"));
  try {
    const codexPath = path.join(tmp, "rollout-codex.jsonl");
    const everyPath = path.join(tmp, "rollout-every.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const codexUsage1 = {
      input_tokens: 1,
      cached_input_tokens: 0,
      output_tokens: 1,
      reasoning_output_tokens: 0,
      total_tokens: 2,
    };
    const codexUsage2 = {
      input_tokens: 2,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 2,
    };
    const codexTotals2 = {
      input_tokens: codexUsage1.input_tokens + codexUsage2.input_tokens,
      cached_input_tokens: 0,
      output_tokens: codexUsage1.output_tokens + codexUsage2.output_tokens,
      reasoning_output_tokens: 0,
      total_tokens: codexUsage1.total_tokens + codexUsage2.total_tokens,
    };

    const everyUsage1 = {
      input_tokens: 1,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 1,
    };
    const everyUsage2 = {
      input_tokens: 1,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 1,
    };
    const everyTotals2 = {
      input_tokens: everyUsage1.input_tokens + everyUsage2.input_tokens,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: everyUsage1.total_tokens + everyUsage2.total_tokens,
    };

    const codexLines = [
      buildTurnContextLine({ model: "gpt-4o-mini" }),
      buildTokenCountLine({
        ts: "2025-12-17T01:00:00.000Z",
        last: codexUsage1,
        total: codexUsage1,
      }),
    ];
    const everyLines = [
      buildTokenCountLine({
        ts: "2025-12-17T00:30:00.000Z",
        last: everyUsage1,
        total: everyUsage1,
      }),
    ];

    await fs.writeFile(codexPath, codexLines.join("\n") + "\n", "utf8");
    await fs.writeFile(everyPath, everyLines.join("\n") + "\n", "utf8");

    let res = await parseRolloutIncremental({
      rolloutFiles: [
        { path: codexPath, source: "codex" },
        { path: everyPath, source: "every-code" },
      ],
      cursors,
      queuePath,
    });
    assert.equal(res.bucketsQueued, 2);

    let queued = await readJsonLines(queuePath);
    let everyRows = queued.filter((row) => row.source === "every-code");
    assert.equal(everyRows.length, 1);
    assert.equal(everyRows[0].model, "gpt-4o-mini");

    const codexAppend = [
      buildTurnContextLine({ model: "gpt-4o" }),
      buildTokenCountLine({
        ts: "2025-12-17T00:00:00.000Z",
        last: codexUsage2,
        total: codexTotals2,
      }),
    ];
    const everyAppend = [
      buildTokenCountLine({
        ts: "2025-12-17T00:30:00.000Z",
        last: everyUsage2,
        total: everyTotals2,
      }),
    ];

    await fs.appendFile(codexPath, codexAppend.join("\n") + "\n", "utf8");
    await fs.appendFile(everyPath, everyAppend.join("\n") + "\n", "utf8");

    res = await parseRolloutIncremental({
      rolloutFiles: [
        { path: codexPath, source: "codex" },
        { path: everyPath, source: "every-code" },
      ],
      cursors,
      queuePath,
    });
    assert.equal(res.bucketsQueued, 3);

    queued = await readJsonLines(queuePath);
    everyRows = queued.filter(
      (row) => row.source === "every-code" && row.hour_start === "2025-12-17T00:30:00.000Z",
    );
    const byModel = new Map();
    for (const row of everyRows) {
      byModel.set(row.model, row);
    }
    assert.equal(byModel.get("gpt-4o-mini")?.total_tokens, 0);
    assert.equal(byModel.get("gpt-4o")?.total_tokens, everyTotals2.total_tokens);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseRolloutIncremental retracts unknown when known model appears later", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-rollout-"));
  try {
    const rolloutPath = path.join(tmp, "rollout-test.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const usageUnknown = {
      input_tokens: 1,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 1,
    };
    const usageKnown = {
      input_tokens: 2,
      cached_input_tokens: 0,
      output_tokens: 1,
      reasoning_output_tokens: 0,
      total_tokens: 3,
    };
    const totalsKnown = {
      input_tokens: usageUnknown.input_tokens + usageKnown.input_tokens,
      cached_input_tokens: 0,
      output_tokens: usageUnknown.output_tokens + usageKnown.output_tokens,
      reasoning_output_tokens: 0,
      total_tokens: usageUnknown.total_tokens + usageKnown.total_tokens,
    };

    const lines = [
      buildTokenCountLine({
        ts: "2025-12-17T00:05:00.000Z",
        last: usageUnknown,
        total: usageUnknown,
      }),
    ];
    await fs.writeFile(rolloutPath, lines.join("\n") + "\n", "utf8");

    let res = await parseRolloutIncremental({ rolloutFiles: [rolloutPath], cursors, queuePath });
    assert.equal(res.bucketsQueued, 1);

    let queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].model, "unknown");
    assert.equal(queued[0].total_tokens, usageUnknown.total_tokens);

    const append = [
      buildTurnContextLine({ model: "gpt-4o" }),
      buildTokenCountLine({ ts: "2025-12-17T00:10:00.000Z", last: usageKnown, total: totalsKnown }),
    ];
    await fs.appendFile(rolloutPath, append.join("\n") + "\n", "utf8");

    res = await parseRolloutIncremental({ rolloutFiles: [rolloutPath], cursors, queuePath });
    assert.equal(res.bucketsQueued, 2);

    queued = await readJsonLines(queuePath);
    const sameHour = queued.filter((row) => row.hour_start === "2025-12-17T00:00:00.000Z");
    const unknownRows = sameHour.filter((row) => row.model === "unknown");
    assert.equal(unknownRows.length, 2);
    const unknownTotals = unknownRows.map((row) => row.total_tokens).sort((a, b) => a - b);
    assert.deepEqual(unknownTotals, [0, usageUnknown.total_tokens]);

    const knownRow = sameHour.find((row) => row.model === "gpt-4o");
    assert.equal(knownRow?.total_tokens, usageKnown.total_tokens + usageUnknown.total_tokens);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseRolloutIncremental recomputes every-code alignment on codex-only updates", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-rollout-"));
  try {
    const codexPath = path.join(tmp, "rollout-codex.jsonl");
    const everyPath = path.join(tmp, "rollout-every.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const codexUsage1 = {
      input_tokens: 1,
      cached_input_tokens: 0,
      output_tokens: 1,
      reasoning_output_tokens: 0,
      total_tokens: 2,
    };
    const codexUsage2 = {
      input_tokens: 2,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 2,
    };
    const codexTotals2 = {
      input_tokens: codexUsage1.input_tokens + codexUsage2.input_tokens,
      cached_input_tokens: 0,
      output_tokens: codexUsage1.output_tokens + codexUsage2.output_tokens,
      reasoning_output_tokens: 0,
      total_tokens: codexUsage1.total_tokens + codexUsage2.total_tokens,
    };
    const everyUsage = {
      input_tokens: 1,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 1,
    };

    const codexLines = [
      buildTurnContextLine({ model: "gpt-4o" }),
      buildTokenCountLine({
        ts: "2025-12-17T02:00:00.000Z",
        last: codexUsage1,
        total: codexUsage1,
      }),
    ];
    const everyLines = [
      buildTokenCountLine({ ts: "2025-12-17T00:00:00.000Z", last: everyUsage, total: everyUsage }),
    ];

    await fs.writeFile(codexPath, codexLines.join("\n") + "\n", "utf8");
    await fs.writeFile(everyPath, everyLines.join("\n") + "\n", "utf8");

    let res = await parseRolloutIncremental({
      rolloutFiles: [
        { path: codexPath, source: "codex" },
        { path: everyPath, source: "every-code" },
      ],
      cursors,
      queuePath,
    });
    assert.equal(res.bucketsQueued, 2);

    const afterFirst = await readJsonLines(queuePath);
    const firstEvery = afterFirst.find((row) => row.source === "every-code");
    assert.equal(firstEvery?.model, "gpt-4o");

    const codexAppend = [
      buildTurnContextLine({ model: "gpt-4o-mini" }),
      buildTokenCountLine({
        ts: "2025-12-17T00:30:00.000Z",
        last: codexUsage2,
        total: codexTotals2,
      }),
    ];
    await fs.appendFile(codexPath, codexAppend.join("\n") + "\n", "utf8");

    res = await parseRolloutIncremental({
      rolloutFiles: [
        { path: codexPath, source: "codex" },
        { path: everyPath, source: "every-code" },
      ],
      cursors,
      queuePath,
    });
    assert.equal(res.bucketsQueued, 3);

    const afterSecond = await readJsonLines(queuePath);
    const delta = afterSecond.slice(afterFirst.length);
    const everyDelta = delta.filter(
      (row) => row.source === "every-code" && row.hour_start === "2025-12-17T00:00:00.000Z",
    );
    assert.equal(everyDelta.length, 2);
    const byModel = new Map(everyDelta.map((row) => [row.model, row]));
    assert.equal(byModel.get("gpt-4o")?.total_tokens, 0);
    assert.equal(byModel.get("gpt-4o-mini")?.total_tokens, everyUsage.total_tokens);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseClaudeIncremental aggregates usage into half-hour buckets", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-claude-"));
  try {
    const claudePath = path.join(tmp, "agent-claude.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const model = "moonshotai/Kimi-K2-Thinking";
    const lines = [
      buildClaudeUsageLine({ ts: "2025-12-25T01:05:00.000Z", input: 100, output: 50, model }),
      buildClaudeUsageLine({ ts: "2025-12-25T01:40:00.000Z", input: 200, model }),
      JSON.stringify({
        timestamp: "2025-12-25T01:41:00.000Z",
        message: { content: [{ type: "text", text: "skip" }] },
      }),
    ];

    await fs.writeFile(claudePath, lines.join("\n") + "\n", "utf8");

    const res = await parseClaudeIncremental({
      projectFiles: [{ path: claudePath, source: "claude" }],
      cursors,
      queuePath,
    });
    assert.equal(res.filesProcessed, 1);
    assert.equal(res.eventsAggregated, 2);
    assert.equal(res.bucketsQueued, 2);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 2);
    assert.ok(queued.every((row) => row.source === "claude"));
    assert.ok(queued.every((row) => row.model === model));
    const byBucket = new Map(queued.map((row) => [row.hour_start, row]));
    assert.equal(byBucket.get("2025-12-25T01:00:00.000Z")?.input_tokens, 100);
    assert.equal(byBucket.get("2025-12-25T01:00:00.000Z")?.output_tokens, 50);
    assert.equal(byBucket.get("2025-12-25T01:00:00.000Z")?.total_tokens, 150);
    assert.equal(byBucket.get("2025-12-25T01:00:00.000Z")?.conversation_count, 0);
    assert.equal(byBucket.get("2025-12-25T01:30:00.000Z")?.input_tokens, 200);
    assert.equal(byBucket.get("2025-12-25T01:30:00.000Z")?.output_tokens, 0);
    assert.equal(byBucket.get("2025-12-25T01:30:00.000Z")?.total_tokens, 200);
    assert.equal(byBucket.get("2025-12-25T01:30:00.000Z")?.conversation_count, 0);

    const resAgain = await parseClaudeIncremental({
      projectFiles: [{ path: claudePath, source: "claude" }],
      cursors,
      queuePath,
    });
    assert.equal(resAgain.filesProcessed, 0);
    assert.equal(resAgain.eventsAggregated, 0);
    assert.equal(resAgain.bucketsQueued, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseClaudeIncremental skips unchanged files once project context is settled", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-claude-"));
  try {
    const claudePath = path.join(tmp, "agent-claude.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const projectQueuePath = path.join(tmp, "project.queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };
    const model = "claude-sonnet-4";
    await fs.writeFile(
      claudePath,
      buildClaudeUsageLine({
        ts: "2025-12-25T01:10:00.000Z",
        input: 100,
        output: 50,
        model,
      }) + "\n",
      "utf8",
    );

    const first = await parseClaudeIncremental({
      projectFiles: [{ path: claudePath, source: "claude" }],
      cursors,
      queuePath,
      projectQueuePath,
    });
    assert.equal(first.filesProcessed, 1);

    // No cwd on the fixture line, so project context is confirmed absent —
    // an idle re-run should now skip the file entirely instead of re-doing
    // a doomed-to-fail project resolution on every sync.
    const second = await parseClaudeIncremental({
      projectFiles: [{ path: claudePath, source: "claude" }],
      cursors,
      queuePath,
      projectQueuePath,
    });
    assert.equal(second.filesProcessed, 0);
    assert.equal(second.eventsAggregated, 0);
    assert.equal(second.bucketsQueued, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseClaudeIncremental resolves project from content-embedded cwd, not the ~/.claude/projects storage path", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-claude-"));
  try {
    // Simulate the real ~/.claude/projects/<dash-encoded-cwd>/ storage layout:
    // the file's own directory is NOT inside the real git checkout, so a
    // directory-walk from the file path can never find a project. Only the
    // "cwd" field logged inside the file's content points at the real repo.
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-repo-"));
    await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, ".git", "config"),
      '[remote "origin"]\n\turl = https://github.com/acme/widgets.git\n',
      "utf8",
    );

    const storageDir = path.join(tmp, "-some-unrelated-claude-storage-dir");
    await fs.mkdir(storageDir, { recursive: true });
    const claudePath = path.join(storageDir, "session.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const projectQueuePath = path.join(tmp, "project.queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };
    const model = "claude-sonnet-4";

    const lines = [
      JSON.stringify({ type: "attachment", cwd: repoRoot, timestamp: "2025-12-25T01:00:00.000Z" }),
      buildClaudeUsageLine({ ts: "2025-12-25T01:10:00.000Z", input: 100, output: 50, model }),
    ];
    await fs.writeFile(claudePath, lines.join("\n") + "\n", "utf8");

    const res = await parseClaudeIncremental({
      projectFiles: [{ path: claudePath, source: "claude" }],
      cursors,
      queuePath,
      projectQueuePath,
    });
    assert.equal(res.filesProcessed, 1);

    const projectRows = await readJsonLines(projectQueuePath);
    assert.equal(projectRows.length, 1);
    assert.equal(projectRows[0].project_key, "acme/widgets");

    assert.equal(cursors.files[claudePath].claudeCwd, repoRoot);
    assert.equal(cursors.files[claudePath].projectKey, "acme/widgets");

    // A second, idle run must not re-walk the filesystem for project
    // context — the cached git-config fingerprint is still fresh.
    const again = await parseClaudeIncremental({
      projectFiles: [{ path: claudePath, source: "claude" }],
      cursors,
      queuePath,
      projectQueuePath,
    });
    assert.equal(again.filesProcessed, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseClaudeIncremental retries cwd resolution when a growing file's cwd line lands after an earlier sync", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-claude-"));
  try {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-repo-"));
    await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, ".git", "config"),
      '[remote "origin"]\n\turl = https://github.com/acme/late-cwd.git\n',
      "utf8",
    );

    const storageDir = path.join(tmp, "-some-unrelated-claude-storage-dir");
    await fs.mkdir(storageDir, { recursive: true });
    const claudePath = path.join(storageDir, "session.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const projectQueuePath = path.join(tmp, "project.queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };
    const model = "claude-sonnet-4";

    // First sync catches the file before its cwd-bearing line lands — only a
    // bare summary line exists so far, so cwd resolution comes up empty.
    await fs.writeFile(
      claudePath,
      JSON.stringify({ type: "summary", sessionId: "s1" }) + "\n",
      "utf8",
    );
    await parseClaudeIncremental({
      projectFiles: [{ path: claudePath, source: "claude" }],
      cursors,
      queuePath,
      projectQueuePath,
    });
    assert.equal(cursors.files[claudePath].claudeCwd, null);

    // File grows: the cwd line lands, along with a usage line.
    const lines = [
      JSON.stringify({ type: "attachment", cwd: repoRoot, timestamp: "2025-12-25T01:00:00.000Z" }),
      buildClaudeUsageLine({ ts: "2025-12-25T01:10:00.000Z", input: 100, output: 50, model }),
    ];
    await fs.appendFile(claudePath, lines.join("\n") + "\n", "utf8");

    const second = await parseClaudeIncremental({
      projectFiles: [{ path: claudePath, source: "claude" }],
      cursors,
      queuePath,
      projectQueuePath,
    });
    assert.equal(second.filesProcessed, 1);

    const projectRows = await readJsonLines(projectQueuePath);
    assert.equal(projectRows.length, 1);
    assert.equal(projectRows[0].project_key, "acme/late-cwd");
    assert.equal(cursors.files[claudePath].claudeCwd, repoRoot);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseClaudeIncremental skips re-walking git for an idle file whose cwd has no git checkout", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-claude-"));
  try {
    const nonRepoDir = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-norepo-"));
    const storageDir = path.join(tmp, "-some-unrelated-claude-storage-dir");
    await fs.mkdir(storageDir, { recursive: true });
    const claudePath = path.join(storageDir, "session.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const projectQueuePath = path.join(tmp, "project.queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };
    const model = "claude-sonnet-4";

    const lines = [
      JSON.stringify({ type: "attachment", cwd: nonRepoDir, timestamp: "2025-12-25T01:00:00.000Z" }),
      buildClaudeUsageLine({ ts: "2025-12-25T01:10:00.000Z", input: 100, output: 50, model }),
    ];
    await fs.writeFile(claudePath, lines.join("\n") + "\n", "utf8");

    const first = await parseClaudeIncremental({
      projectFiles: [{ path: claudePath, source: "claude" }],
      cursors,
      queuePath,
      projectQueuePath,
    });
    assert.equal(first.filesProcessed, 1);
    assert.equal(cursors.files[claudePath].claudeCwd, nonRepoDir);
    assert.equal(cursors.files[claudePath].projectFileContext.absent, true);

    // Idle + already-confirmed-no-git-checkout must fully skip, not re-walk.
    const second = await parseClaudeIncremental({
      projectFiles: [{ path: claudePath, source: "claude" }],
      cursors,
      queuePath,
      projectQueuePath,
    });
    assert.equal(second.filesProcessed, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseClaudeIncremental counts cache creation as input and cache read separately", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-claude-"));
  try {
    const claudePath = path.join(tmp, "agent-claude.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const lines = [
      buildClaudeUsageLine({
        ts: "2025-12-25T03:10:00.000Z",
        input: 5,
        output: 2,
        cacheCreation: 3,
        cacheRead: 4,
      }),
    ];

    await fs.writeFile(claudePath, lines.join("\n") + "\n", "utf8");

    const res = await parseClaudeIncremental({
      projectFiles: [{ path: claudePath, source: "claude" }],
      cursors,
      queuePath,
    });
    assert.equal(res.filesProcessed, 1);
    assert.equal(res.bucketsQueued, 1);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].input_tokens, 5);
    assert.equal(queued[0].cached_input_tokens, 4);
    assert.equal(queued[0].cache_creation_input_tokens, 3);
    assert.equal(queued[0].output_tokens, 2);
    assert.equal(queued[0].total_tokens, 14); // 5 + 2 + 3 + 4
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseClaudeIncremental computes total from all components ignoring JSONL total", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-claude-"));
  try {
    const claudePath = path.join(tmp, "agent-claude.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const lines = [
      buildClaudeUsageLine({ ts: "2025-12-25T01:10:00.000Z", input: 5, output: 1, cacheCreation: 2, cacheRead: 3, total: 20 }),
    ];
    await fs.writeFile(claudePath, lines.join("\n") + "\n", "utf8");

    const res = await parseClaudeIncremental({
      projectFiles: [{ path: claudePath, source: "claude" }],
      cursors,
      queuePath,
    });
    assert.equal(res.filesProcessed, 1);
    assert.equal(res.bucketsQueued, 1);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    // total = input(5) + output(1) + cacheCreation(2) + cacheRead(3) = 11, not JSONL's 20
    assert.equal(queued[0].total_tokens, 11);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// Regression: issue #64 — DeepSeek / Kimi / Mimo / Claude thinking sub-agent
// jsonl entries omit the top-level `requestId` field. Prior dedup used
// `if (msgId && reqId)` which short-circuited dedup entirely, multiplying
// every (msgId-repeated) entry into the bucket. msgId alone is globally
// unique per the Anthropic message protocol and must be sufficient as a
// dedup key.
test("parseClaudeIncremental dedups by msgId alone when requestId is missing", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-claude-"));
  try {
    const claudePath = path.join(tmp, "agent-deepseek.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    // DeepSeek-style: same msgId written 4 times within seconds (no requestId).
    // Current bug summed all 4; fix should dedup to 1.
    const model = "deepseek-v4-flash";
    const msgId = "4cc7ba29-8399-4791-b928-c334122ceaff";
    const lines = [
      buildClaudeUsageLine({
        ts: "2026-05-12T01:00:00.000Z",
        msgId,
        model,
        input: 465,
        cacheRead: 78592,
        output: 371,
      }),
      buildClaudeUsageLine({
        ts: "2026-05-12T01:00:00.300Z",
        msgId,
        model,
        input: 465,
        cacheRead: 78592,
        output: 371,
      }),
      buildClaudeUsageLine({
        ts: "2026-05-12T01:00:00.700Z",
        msgId,
        model,
        input: 465,
        cacheRead: 78592,
        output: 371,
      }),
      buildClaudeUsageLine({
        ts: "2026-05-12T01:00:01.500Z",
        msgId,
        model,
        input: 465,
        cacheRead: 78592,
        output: 371,
      }),
    ];
    await fs.writeFile(claudePath, lines.join("\n") + "\n", "utf8");

    const res = await parseClaudeIncremental({
      projectFiles: [{ path: claudePath, source: "claude" }],
      cursors,
      queuePath,
    });
    assert.equal(res.eventsAggregated, 1, "should aggregate only 1 of the 4 duplicates");

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].input_tokens, 465);
    assert.equal(queued[0].cached_input_tokens, 78592);
    assert.equal(queued[0].output_tokens, 371);
    assert.equal(queued[0].total_tokens, 465 + 78592 + 371);
    assert.equal(queued[0].model, model);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// Claude-native invariant: with requestId present, the prior
// `<msgId>:<requestId>` dedup key behavior must remain unchanged so
// already-persisted cursors.claudeHashes entries continue to match.
test("parseClaudeIncremental keeps msgId:requestId dedup when requestId is present", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-claude-"));
  try {
    const claudePath = path.join(tmp, "agent-claude.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const model = "claude-opus-4-7";
    const msgId = "msg_01Fzdy6WXwLZKsymfH1w5dJd";
    const requestId = "req_011Ca92vRUJe";
    const lines = [
      buildClaudeUsageLine({
        ts: "2026-04-17T08:33:05.681Z",
        msgId,
        requestId,
        model,
        input: 6,
        cacheCreation: 18771,
        output: 126,
      }),
      buildClaudeUsageLine({
        ts: "2026-04-17T08:33:05.682Z",
        msgId,
        requestId,
        model,
        input: 6,
        cacheCreation: 18771,
        output: 126,
      }),
    ];
    await fs.writeFile(claudePath, lines.join("\n") + "\n", "utf8");

    const res = await parseClaudeIncremental({
      projectFiles: [{ path: claudePath, source: "claude" }],
      cursors,
      queuePath,
    });
    assert.equal(res.eventsAggregated, 1, "duplicate (msgId, requestId) collapses to 1");

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].input_tokens, 6);
    assert.equal(queued[0].cache_creation_input_tokens, 18771);
    assert.equal(queued[0].output_tokens, 126);
    // Hash list persists in legacy <msgId>:<requestId> form for back-compat.
    assert.ok(Array.isArray(cursors.claudeHashes));
    assert.ok(cursors.claudeHashes.includes(`${msgId}:${requestId}`));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// Cross-file dedup invariant: two jsonl files referencing the same msgId
// (one with reqId, one without) must each contribute only once. This
// covers the case where Claude Code restarts mid-stream and emits the
// final chunk into a different session file under a third-party endpoint.
test("parseClaudeIncremental dedups same msgId across files in mixed reqId scenarios", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-claude-"));
  try {
    const fileA = path.join(tmp, "session-a.jsonl");
    const fileB = path.join(tmp, "session-b.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const model = "kimi-for-coding";
    // A: msgId-only entry from third-party endpoint.
    await fs.writeFile(
      fileA,
      buildClaudeUsageLine({
        ts: "2026-05-12T02:00:00.000Z",
        msgId: "msg_kimi_abc",
        model,
        input: 100,
        cacheRead: 200,
        output: 10,
      }) + "\n",
      "utf8",
    );
    // B: same msgId again, simulating duplicate write into a different file.
    await fs.writeFile(
      fileB,
      buildClaudeUsageLine({
        ts: "2026-05-12T02:00:01.000Z",
        msgId: "msg_kimi_abc",
        model,
        input: 100,
        cacheRead: 200,
        output: 10,
      }) + "\n",
      "utf8",
    );

    const res = await parseClaudeIncremental({
      projectFiles: [
        { path: fileA, source: "claude" },
        { path: fileB, source: "claude" },
      ],
      cursors,
      queuePath,
    });
    assert.equal(res.eventsAggregated, 1, "cross-file duplicate by msgId must dedup");

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].total_tokens, 100 + 200 + 10);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseClaudeIncremental defaults missing model to unknown", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-claude-"));
  try {
    const claudePath = path.join(tmp, "agent-claude.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const lines = [buildClaudeUsageLine({ ts: "2025-12-25T02:05:00.000Z", input: 10, output: 5 })];
    await fs.writeFile(claudePath, lines.join("\n") + "\n", "utf8");

    const res = await parseClaudeIncremental({
      projectFiles: [{ path: claudePath, source: "claude" }],
      cursors,
      queuePath,
    });
    assert.equal(res.filesProcessed, 1);
    assert.equal(res.bucketsQueued, 1);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].model, "unknown");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

function buildTurnContextLine({ model, cwd, currentDate }) {
  const payload = { model };
  if (typeof cwd === "string" && cwd.length > 0) {
    payload.cwd = cwd;
  }
  if (typeof currentDate === "string" && currentDate.length > 0) {
    payload.current_date = currentDate;
  }
  return JSON.stringify({
    type: "turn_context",
    payload,
  });
}

function buildSessionMetaLine({ model, cwd, forkedFromId }) {
  const payload = { model };
  if (typeof cwd === "string" && cwd.length > 0) {
    payload.cwd = cwd;
  }
  if (typeof forkedFromId === "string" && forkedFromId.length > 0) {
    payload.forked_from_id = forkedFromId;
  }
  return JSON.stringify({
    type: "session_meta",
    payload,
  });
}

function buildTokenCountLine({ ts, last, total }) {
  return JSON.stringify({
    type: "event_msg",
    timestamp: ts,
    payload: {
      type: "token_count",
      info: {
        last_token_usage: last,
        total_token_usage: total,
      },
    },
  });
}

function buildEveryCodeTokenCountLine({ ts, last, total }) {
  return JSON.stringify({
    type: "event_msg",
    timestamp: ts,
    payload: {
      id: "msg-id",
      event_seq: 1,
      msg: {
        type: "token_count",
        info: {
          last_token_usage: last,
          total_token_usage: total,
        },
      },
    },
  });
}

function buildClaudeUsageLine({
  ts,
  input,
  output,
  model,
  total,
  cacheCreation,
  cacheRead,
  msgId,
  requestId,
}) {
  const obj = {
    timestamp: ts,
    message: {
      model,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: typeof cacheCreation === "number" ? cacheCreation : undefined,
        cache_read_input_tokens: typeof cacheRead === "number" ? cacheRead : undefined,
        total_tokens: typeof total === "number" ? total : undefined,
      },
    },
  };
  if (typeof msgId === "string") obj.message.id = msgId;
  if (typeof requestId === "string") obj.requestId = requestId;
  return JSON.stringify(obj);
}

function buildGeminiSession({ messages }) {
  return {
    sessionId: "session-id",
    projectHash: "project-hash",
    startTime: "2025-12-26T08:00:00.000Z",
    lastUpdated: "2025-12-26T08:10:00.000Z",
    messages,
  };
}

function buildOpencodeMessage({ modelID, model, modelId, created, completed, tokens }) {
  const createdMs = created ? Date.parse(created) : null;
  const completedMs = completed ? Date.parse(completed) : null;
  return {
    id: "msg_test",
    sessionID: "ses_test",
    modelID,
    model,
    modelId,
    time: {
      created: Number.isFinite(createdMs) ? createdMs : undefined,
      completed: Number.isFinite(completedMs) ? completedMs : undefined,
    },
    tokens: tokens
      ? {
          input: tokens.input,
          output: tokens.output,
          reasoning: tokens.reasoning,
          cache: {
            read: tokens.cached,
            write: tokens.cacheWrite,
          },
        }
      : undefined,
  };
}

test("parseKiroIncremental tracks JSONL fallback with a separate cursor", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-kiro-"));
  try {
    const jsonlPath = path.join(tmp, "tokens_generated.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    await fs.writeFile(
      jsonlPath,
      [
        JSON.stringify({ model: "agent", provider: "kiro", promptTokens: 10, generatedTokens: 5 }),
        JSON.stringify({ model: "agent", provider: "kiro", promptTokens: 4, generatedTokens: 1 }),
      ].join("\n") + "\n",
      "utf8",
    );

    const noDbPath = path.join(tmp, "nonexistent.sqlite");
    const first = await parseKiroIncremental({ dbPath: noDbPath, jsonlPath, cursors, queuePath });
    assert.equal(first.recordsProcessed, 2);
    assert.equal(first.eventsAggregated, 2);
    assert.equal(first.bucketsQueued, 1);
    assert.equal(cursors.kiro.lastDbId, 0);
    assert.equal(cursors.kiro.jsonl.lastLine, 2);

    const afterFirst = await readJsonLines(queuePath);
    assert.equal(afterFirst.length, 1);
    assert.equal(afterFirst[0].source, "kiro");
    assert.equal(afterFirst[0].total_tokens, 20);

    await fs.appendFile(
      jsonlPath,
      JSON.stringify({ model: "agent", provider: "kiro", promptTokens: 3, generatedTokens: 2 }) + "\n",
      "utf8",
    );

    const second = await parseKiroIncremental({ dbPath: noDbPath, jsonlPath, cursors, queuePath });
    assert.equal(second.recordsProcessed, 1);
    assert.equal(second.eventsAggregated, 1);
    assert.equal(cursors.kiro.jsonl.lastLine, 3);

    const afterSecond = await readJsonLines(queuePath);
    assert.equal(afterSecond.length, 2);
    assert.equal(afterSecond[1].total_tokens, 25);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseKiroIncremental ignores JSONL fallback after file truncation until new baseline is established", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-kiro-"));
  try {
    const jsonlPath = path.join(tmp, "tokens_generated.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const noDbPath = path.join(tmp, "nonexistent.sqlite");
    const cursors = { version: 1, files: {}, updatedAt: null };

    await fs.writeFile(
      jsonlPath,
      [
        JSON.stringify({ model: "agent", provider: "kiro", promptTokens: 8, generatedTokens: 2 }),
        JSON.stringify({ model: "agent", provider: "kiro", promptTokens: 1, generatedTokens: 1 }),
      ].join("\n") + "\n",
      "utf8",
    );

    await parseKiroIncremental({ dbPath: noDbPath, jsonlPath, cursors, queuePath });

    await fs.writeFile(
      jsonlPath,
      JSON.stringify({ model: "agent", provider: "kiro", promptTokens: 99, generatedTokens: 99 }) + "\n",
      "utf8",
    );

    const truncated = await parseKiroIncremental({ dbPath: noDbPath, jsonlPath, cursors, queuePath });
    assert.equal(truncated.recordsProcessed, 0);
    assert.equal(truncated.eventsAggregated, 0);
    assert.equal(cursors.kiro.jsonl.lastLine, 1);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].total_tokens, 12);

    await fs.appendFile(
      jsonlPath,
      JSON.stringify({ model: "agent", provider: "kiro", promptTokens: 5, generatedTokens: 5 }) + "\n",
      "utf8",
    );

    const resumed = await parseKiroIncremental({ dbPath: noDbPath, jsonlPath, cursors, queuePath });
    assert.equal(resumed.recordsProcessed, 1);
    assert.equal(resumed.eventsAggregated, 1);

    const afterResume = await readJsonLines(queuePath);
    assert.equal(afterResume.length, 2);
    assert.equal(afterResume[1].total_tokens, 22);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

async function readJsonLines(filePath) {
  const text = await fs.readFile(filePath, "utf8").catch(() => "");
  if (!text.trim()) return [];
  const lines = text.split("\n").filter(Boolean);
  return lines.map((l) => JSON.parse(l));
}

// ── Hermes Agent integration tests ──

function createHermesDb(dbPath, sessions) {
  require("node:fs").mkdirSync(path.dirname(dbPath), { recursive: true });
  cp.execFileSync("sqlite3", [
    dbPath,
    `CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      user_id TEXT,
      model TEXT,
      model_config TEXT,
      system_prompt TEXT,
      parent_session_id TEXT,
      started_at REAL NOT NULL,
      ended_at REAL,
      end_reason TEXT,
      message_count INTEGER DEFAULT 0,
      tool_call_count INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0,
      billing_provider TEXT,
      billing_base_url TEXT,
      billing_mode TEXT,
      estimated_cost_usd REAL,
      actual_cost_usd REAL,
      cost_status TEXT,
      cost_source TEXT,
      pricing_version TEXT,
      title TEXT
    );`,
  ]);
  for (const s of sessions) {
    const vals = [
      `'${s.id}'`, `'${s.source || "cli"}'`, s.model ? `'${s.model}'` : "NULL",
      s.started_at, s.ended_at || "NULL",
      s.input_tokens || 0, s.output_tokens || 0,
      s.cache_read_tokens || 0, s.cache_write_tokens || 0,
      s.reasoning_tokens || 0, s.message_count || 0,
    ].join(",");
    cp.execFileSync("sqlite3", [
      dbPath,
      `INSERT INTO sessions (id, source, model, started_at, ended_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, message_count) VALUES (${vals});`,
    ]);
  }
}

test("parseHermesIncremental reads default and named profile databases with isolated cursors", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-hermes-profiles-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1 };
    const defaultDbPath = path.join(tmp, "state.db");
    const workDbPath = path.join(tmp, "profiles", "work", "state.db");
    const personalDbPath = path.join(tmp, "profiles", "personal", "state.db");
    const defaultEpoch = 1775993779.0;
    const workEpoch = 1775997400.0;
    const personalEpoch = 1776001000.0;

    createHermesDb(defaultDbPath, [
      { id: "shared_session", model: "gpt-5.4-mini", started_at: defaultEpoch, ended_at: defaultEpoch + 120, input_tokens: 1000, output_tokens: 500, message_count: 4 },
    ]);
    createHermesDb(workDbPath, [
      { id: "shared_session", model: "claude-sonnet-4-6", started_at: workEpoch, ended_at: workEpoch + 120, input_tokens: 2000, output_tokens: 700, cache_read_tokens: 300, message_count: 5 },
    ]);
    createHermesDb(personalDbPath, [
      { id: "personal_session", model: "gpt-5.4", started_at: personalEpoch, ended_at: personalEpoch + 120, input_tokens: 3000, output_tokens: 900, cache_write_tokens: 400, reasoning_tokens: 100, message_count: 6 },
    ]);

    const first = await parseHermesIncremental({ hermesPath: tmp, cursors, queuePath });
    assert.equal(first.recordsProcessed, 3);
    assert.equal(first.eventsAggregated, 3);
    assert.ok(first.bucketsQueued >= 3);

    assert.equal(cursors.hermes.lastStartedAt, defaultEpoch);
    assert.equal(cursors.hermes.lastCompletedStartedAt, defaultEpoch);
    assert.equal(cursors.hermes.snapshots["shared_session"].in, 1000);
    assert.equal(cursors.hermes.profiles.work.lastCompletedStartedAt, workEpoch);
    assert.equal(cursors.hermes.profiles.work.snapshots["shared_session"].in, 2000);
    assert.equal(cursors.hermes.profiles.personal.lastCompletedStartedAt, personalEpoch);
    assert.equal(cursors.hermes.profiles.personal.snapshots["personal_session"].cacheWrite, 400);

    const queued = await readJsonLines(queuePath);
    assert.ok(queued.some((b) => b.source === "hermes" && b.model === "gpt-5.4-mini" && b.input_tokens === 1000));
    assert.ok(queued.some((b) => b.source === "hermes" && b.model === "claude-sonnet-4-6" && b.cached_input_tokens === 300));
    assert.ok(queued.some((b) => b.source === "hermes" && b.model === "gpt-5.4" && b.cache_creation_input_tokens === 400 && b.reasoning_output_tokens === 100));

    const second = await parseHermesIncremental({ hermesPath: tmp, cursors, queuePath });
    assert.equal(second.recordsProcessed, 3);
    assert.equal(second.eventsAggregated, 0);
    assert.equal(second.bucketsQueued, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseHermesIncremental processes profiles when default database is absent", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-hermes-profile-only-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1 };
    const workDbPath = path.join(tmp, "profiles", "work", "state.db");
    const epoch = 1775993779.0;

    createHermesDb(workDbPath, [
      { id: "work_session", model: "claude-sonnet-4-6", started_at: epoch, ended_at: epoch + 120, input_tokens: 1234, output_tokens: 567, message_count: 3 },
    ]);

    const result = await parseHermesIncremental({ hermesPath: tmp, cursors, queuePath });
    assert.equal(result.recordsProcessed, 1);
    assert.equal(result.eventsAggregated, 1);
    assert.equal(cursors.hermes.profiles.work.lastCompletedStartedAt, epoch);
    assert.equal(cursors.hermes.profiles.work.snapshots["work_session"].out, 567);
    assert.equal(cursors.hermes.lastCompletedStartedAt, undefined);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].source, "hermes");
    assert.equal(queued[0].model, "claude-sonnet-4-6");
    assert.equal(queued[0].input_tokens, 1234);
    assert.equal(queued[0].output_tokens, 567);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseHermesIncremental processes sessions incrementally", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-hermes-"));
  try {
    const dbPath = path.join(tmp, "state.db");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    // Two sessions at different times
    const epoch1 = 1775993779.0; // 2026-04-12T11:36:19Z
    const epoch2 = 1775997400.0; // 2026-04-12T12:36:40Z
    createHermesDb(dbPath, [
      { id: "sess_001", model: "gpt-5.4-mini", started_at: epoch1, ended_at: epoch1 + 120, input_tokens: 1000, output_tokens: 500, cache_read_tokens: 200, message_count: 4 },
      { id: "sess_002", model: "claude-sonnet-4-6", started_at: epoch2, ended_at: epoch2 + 300, input_tokens: 2000, output_tokens: 1000, cache_read_tokens: 500, reasoning_tokens: 100, message_count: 8 },
    ]);

    // First parse — should process both sessions
    const first = await parseHermesIncremental({ dbPath, cursors, queuePath });
    assert.equal(first.recordsProcessed, 2);
    assert.equal(first.eventsAggregated, 2);
    assert.ok(first.bucketsQueued >= 1);
    assert.equal(cursors.hermes.lastStartedAt, epoch2);

    const queued = await readJsonLines(queuePath);
    assert.ok(queued.length >= 1);
    const hermesBuckets = queued.filter((b) => b.source === "hermes");
    assert.ok(hermesBuckets.length >= 1);
    // Verify token fields on first bucket
    const b1 = hermesBuckets.find((b) => b.model === "gpt-5.4-mini");
    assert.ok(b1);
    assert.equal(b1.input_tokens, 1000);
    assert.equal(b1.output_tokens, 500);
    assert.equal(b1.cached_input_tokens, 200);

    // Second parse — cursor-boundary row is re-read, but duplicate suppression makes it a no-op
    const second = await parseHermesIncremental({ dbPath, cursors, queuePath });
    assert.equal(second.recordsProcessed, 1);
    assert.equal(second.eventsAggregated, 0);
    assert.equal(second.bucketsQueued, 0);

    // Add a third session and parse again — incremental
    cp.execFileSync("sqlite3", [
      dbPath,
      `INSERT INTO sessions (id, source, model, started_at, ended_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, message_count) VALUES ('sess_003', 'cli', 'gpt-5.4-mini', ${epoch2 + 3600}, ${epoch2 + 3700}, 500, 250, 0, 0, 0, 2);`,
    ]);
    const third = await parseHermesIncremental({ dbPath, cursors, queuePath });
    assert.equal(third.recordsProcessed, 2);
    assert.equal(third.eventsAggregated, 1);
    assert.ok(third.bucketsQueued >= 1);
    assert.equal(cursors.hermes.lastStartedAt, epoch2 + 3600);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseHermesIncremental re-reads cursor timestamp sessions so same-second inserts are not dropped", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-hermes-same-second-"));
  try {
    const dbPath = path.join(tmp, "state.db");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1 };
    const epoch = 1775993779.0;

    createHermesDb(dbPath, [
      { id: "sess_original", model: "gpt-5.4-mini", started_at: epoch, ended_at: epoch + 120, input_tokens: 1000, output_tokens: 500, message_count: 4 },
    ]);

    const first = await parseHermesIncremental({ dbPath, cursors, queuePath });
    assert.equal(first.recordsProcessed, 1);
    assert.equal(first.eventsAggregated, 1);
    assert.equal(cursors.hermes.lastCompletedStartedAt, epoch);

    cp.execFileSync("sqlite3", [
      dbPath,
      `INSERT INTO sessions (id, source, model, started_at, ended_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, message_count) VALUES ('sess_same_second', 'cli', 'gpt-5.4-mini', ${epoch}, ${epoch + 240}, 300, 150, 0, 0, 0, 2);`,
    ]);

    const second = await parseHermesIncremental({ dbPath, cursors, queuePath });
    assert.equal(second.recordsProcessed, 2);
    assert.equal(second.eventsAggregated, 1);
    assert.ok(second.bucketsQueued >= 1);

    const queued = await readJsonLines(queuePath);
    assert.ok(queued.some((b) => b.source === "hermes" && b.model === "gpt-5.4-mini" && b.input_tokens === 1300 && b.output_tokens === 650));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("resolveHermesPath honors TOKENTRACKER_HERMES_HOME override", () => {
  const override = "/tmp/tokentracker-hermes-override";
  assert.equal(resolveHermesPath({ TOKENTRACKER_HERMES_HOME: override }), override);
  assert.equal(
    resolveHermesDbPath({ TOKENTRACKER_HERMES_HOME: override }),
    path.join(override, "state.db"),
  );
  // Falls back to ~/.hermes when override is empty or absent.
  // Suppress the WSL probe so this assertion is deterministic on Windows (#87).
  const noWsl = { runWsl: () => { throw new Error("no WSL"); } };
  const fallback = resolveHermesPath({ TOKENTRACKER_HERMES_HOME: "  " }, noWsl);
  assert.equal(fallback, path.join(os.homedir(), ".hermes"));
  assert.equal(resolveHermesPath({}, noWsl), path.join(os.homedir(), ".hermes"));
});

test("resolveHermesPath prefers %LOCALAPPDATA%\\hermes on Windows when present", async (t) => {
  // The auto-detect branch only triggers on win32. Stub process.platform so
  // the same assertion runs on mac/Linux CI.
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-hermes-localappdata-"));
  t.after(async () => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    await fs.rm(tmp, { recursive: true, force: true });
  });

  // LOCALAPPDATA points at a dir that does NOT contain `hermes` → fall back.
  // Suppress WSL probe so fallback is deterministic on Windows (#87).
  const noWsl = { runWsl: () => { throw new Error("no WSL"); } };
  assert.equal(
    resolveHermesPath({ LOCALAPPDATA: tmp }, noWsl),
    path.join(os.homedir(), ".hermes"),
  );

  // After we create LOCALAPPDATA\hermes the resolver should prefer it over ~/.hermes.
  const winNative = path.join(tmp, "hermes");
  await fs.mkdir(winNative, { recursive: true });
  assert.equal(resolveHermesPath({ LOCALAPPDATA: tmp }, noWsl), winNative);

  // Explicit TOKENTRACKER_HERMES_HOME still wins over LOCALAPPDATA auto-detect.
  assert.equal(
    resolveHermesPath({ LOCALAPPDATA: tmp, TOKENTRACKER_HERMES_HOME: "/custom/hermes" }),
    "/custom/hermes",
  );
});

test("Zed wsl-only does not return or stat native Windows DB", (t) => {
  mockPlatform(t, "win32");
  mockMethod(t, cp, "execFileSync", () => { throw new Error("wsl unavailable"); });
  mockMethod(t, fssync, "existsSync", (candidate) => {
    assert.ok(!String(candidate).includes("AppData"), `native path was probed: ${candidate}`);
    return false;
  });

  const dbPath = resolveZedDbPath({
    HOME: "C:\\Users\\me",
    LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
    TOKENTRACKER_WSL_MODE: "wsl-only",
  });

  assert.equal(dbPath, null);
});

test("Goose wsl-only does not return or stat native Windows candidates", (t) => {
  resetWslProbeCache();
  mockPlatform(t, "win32");
  mockMethod(t, cp, "execFileSync", () => { throw new Error("wsl unavailable"); });
  mockMethod(t, fssync, "existsSync", (candidate) => {
    assert.ok(!String(candidate).includes("AppData"), `native path was probed: ${candidate}`);
    return false;
  });

  const dbPath = resolveGooseDbPath({
    HOME: "C:\\Users\\me",
    APPDATA: "C:\\Users\\me\\AppData\\Roaming",
    XDG_DATA_HOME: "C:\\Users\\me\\AppData\\Roaming",
    TOKENTRACKER_WSL_MODE: "wsl-only",
  });

  assert.equal(dbPath, null);
});

test("Kimi Code native-first prefers native home when WSL also exists", (t) => {
  resetWslProbeCache();
  mockPlatform(t, "win32");
  mockWsl(t);
  mockMethod(t, fssync, "existsSync", (candidate) => (
    candidate === "\\\\wsl$\\Ubuntu\\home\\dev\\.kimi-code" ||
    candidate === path.join(os.homedir(), ".kimi-code")
  ));

  const home = resolveKimiCodeHome({
    HOME: "C:\\Users\\me",
    TOKENTRACKER_WSL_MODE: "native-first",
  });

  assert.equal(home, path.join(os.homedir(), ".kimi-code"));
});

test("Kimi Code wsl-first prefers WSL home when both sides exist", (t) => {
  resetWslProbeCache();
  mockPlatform(t, "win32");
  mockWsl(t);
  mockMethod(t, fssync, "existsSync", (candidate) => (
    candidate === "\\\\wsl$\\Ubuntu\\home\\dev\\.kimi-code" ||
    candidate === path.join("C:\\Users\\me", ".kimi-code")
  ));

  const home = resolveKimiCodeHome({
    HOME: "C:\\Users\\me",
    TOKENTRACKER_WSL_MODE: "wsl-first",
  });

  assert.equal(home, "\\\\wsl$\\Ubuntu\\home\\dev\\.kimi-code");
});

test("Kilocode roots pass resolver env to WSL discovery", (t) => {
  mockPlatform(t, "win32");
  mockMethod(t, cp, "execFileSync", () => { throw new Error("WSL discovery should not be called"); });

  const roots = resolveKilocodeRoots({
    HOME: "C:\\Users\\me",
    APPDATA: "C:\\Users\\me\\AppData\\Roaming",
    TOKENTRACKER_WSL_MODE: "native-only",
  });

  assert.ok(roots.some((root) => root.includes("AppData")));
});

test("parseWslListVerbose parses distros, default marker and version column", () => {
  const raw = "  NAME            STATE           VERSION\n" +
    "* Ubuntu          Running         2\n" +
    "  Debian-22.04    Stopped         1\n";
  assert.deepEqual(parseWslListVerbose(raw), [
    { name: "Ubuntu", version: 2, isDefault: true },
    { name: "Debian-22.04", version: 1, isDefault: false },
  ]);
});

test("parseWslListVerbose tolerates UTF-16 NUL/BOM noise and skips the header", () => {
  // wsl.exe -l -v emits UTF-16LE; a mis-decode leaves a leading BOM and NUL
  // bytes between characters. The parser strips both defensively.
  const raw = "\uFEFF  NAME   STATE   VERSION\n* Ub\u0000untu Running 2\n";
  assert.deepEqual(parseWslListVerbose(raw), [
    { name: "Ubuntu", version: 2, isDefault: true },
  ]);
  assert.deepEqual(parseWslListVerbose(""), []);
  assert.deepEqual(parseWslListVerbose(undefined), []);
});

test("probeWslDistros sorts the default distro first and is fail-safe", () => {
  const raw = "  NAME    STATE    VERSION\n  Debian  Stopped  1\n* Ubuntu  Running  2\n";
  assert.deepEqual(probeWslDistros({ runWsl: () => raw }), [
    { name: "Ubuntu", version: 2, isDefault: true },
    { name: "Debian", version: 1, isDefault: false },
  ]);
  // A throwing wsl.exe (not installed / no distros) yields an empty list.
  assert.deepEqual(
    probeWslDistros({ runWsl: () => { throw new Error("wsl not found"); } }),
    [],
  );
});

test("discoverWslHermesHome resolves ~/.hermes via the right UNC alias per distro", () => {
  const list = "  NAME    STATE    VERSION\n* Ubuntu  Running  2\n  Legacy  Running  1\n";
  // Linux usernames differ from %USERNAME% — whoami is asked per distro (#87).
  const users = { Ubuntu: "alice\n", Legacy: "bob\n" };
  const runWsl = (args) => (args[0] === "-l" ? list : users[args[1]]);

  // WSL2 distro found via the legacy \\wsl$\ alias (tried first for v2).
  const tried = [];
  const hit = discoverWslHermesHome({
    runWsl,
    existsSync: (p) => {
      tried.push(p);
      return p === "\\\\wsl$\\Ubuntu\\home\\alice\\.hermes";
    },
  });
  assert.equal(hit, "\\\\wsl$\\Ubuntu\\home\\alice\\.hermes");
  assert.equal(tried[0], "\\\\wsl$\\Ubuntu\\home\\alice\\.hermes");

  // WSL1 distro: \\wsl.localhost\ is tried before \\wsl$\.
  const tried1 = [];
  const hit1 = discoverWslHermesHome({
    runWsl,
    existsSync: (p) => {
      tried1.push(p);
      return p === "\\\\wsl.localhost\\Legacy\\home\\bob\\.hermes";
    },
  });
  assert.equal(hit1, "\\\\wsl.localhost\\Legacy\\home\\bob\\.hermes");
  // Ubuntu (default) probed first, both its roots miss, then Legacy via localhost.
  assert.equal(tried1[tried1.length - 1], "\\\\wsl.localhost\\Legacy\\home\\bob\\.hermes");
  assert.ok(tried1.indexOf("\\\\wsl.localhost\\Legacy\\home\\bob\\.hermes") <
    tried1.indexOf("\\\\wsl$\\Legacy\\home\\bob\\.hermes") || !tried1.includes("\\\\wsl$\\Legacy\\home\\bob\\.hermes"));

  // No .hermes anywhere → null (caller falls back to ~/.hermes).
  assert.equal(discoverWslHermesHome({ runWsl, existsSync: () => false }), null);
  // A distro whose whoami fails is skipped, not crashed on.
  assert.equal(
    discoverWslHermesHome({
      runWsl: (args) => { if (args[0] === "-l") return list; throw new Error("whoami failed"); },
      existsSync: () => true,
    }),
    null,
  );
});

test("parseHermesIncremental snapshots the DB locally for UNC paths", async () => {
  // Simulate the \\wsl$\Ubuntu\... case: we can't actually create a UNC path
  // in CI, but the codepath is gated on isUncPath() and the rest of the
  // pipeline is identical. We point a junction-style "\\?\..." path at a real
  // file so the snapshot helper copies it, then read the snapshot.
  if (process.platform !== "win32") {
    // On non-Windows the // prefix is treated as POSIX-absolute by node, so we
    // can use it to exercise the snapshot branch without a UNC mount.
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-hermes-unc-"));
  try {
    const realDbPath = path.join(tmp, "state.db");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1 };
    const epoch = 1775993779.0;
    createHermesDb(realDbPath, [
      { id: "unc_session", model: "gpt-5.4-mini", started_at: epoch, ended_at: epoch + 60, input_tokens: 700, output_tokens: 100, message_count: 2 },
    ]);
    // Prefix so isUncPath() returns true while node's path layer still
    // resolves it to the same inode.
    const uncStyle = process.platform === "win32"
      ? "\\\\?\\" + realDbPath
      : "/" + realDbPath;
    const result = await parseHermesIncremental({ dbPath: uncStyle, cursors, queuePath });
    assert.equal(result.recordsProcessed, 1);
    assert.equal(result.eventsAggregated, 1);
    const queued = await readJsonLines(queuePath);
    assert.ok(queued.some((b) => b.source === "hermes" && b.input_tokens === 700 && b.output_tokens === 100));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseHermesIncremental reads a database under TOKENTRACKER_HERMES_HOME override", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-hermes-env-override-"));
  const prev = process.env.TOKENTRACKER_HERMES_HOME;
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1 };
    const dbPath = path.join(tmp, "state.db");
    const epoch = 1775993779.0;
    createHermesDb(dbPath, [
      { id: "envoverride_session", model: "gpt-5.4-mini", started_at: epoch, ended_at: epoch + 120, input_tokens: 800, output_tokens: 200, message_count: 2 },
    ]);

    process.env.TOKENTRACKER_HERMES_HOME = tmp;
    const hermesPath = resolveHermesPath();
    assert.equal(hermesPath, tmp);

    const result = await parseHermesIncremental({ hermesPath, cursors, queuePath });
    assert.equal(result.recordsProcessed, 1);
    assert.equal(result.eventsAggregated, 1);

    const queued = await readJsonLines(queuePath);
    assert.ok(queued.some((b) => b.source === "hermes" && b.input_tokens === 800 && b.output_tokens === 200));
  } finally {
    if (prev === undefined) delete process.env.TOKENTRACKER_HERMES_HOME;
    else process.env.TOKENTRACKER_HERMES_HOME = prev;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseHermesIncremental returns zero for nonexistent database", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-hermes-"));
  try {
    const dbPath = path.join(tmp, "nonexistent.db");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1 };

    const result = await parseHermesIncremental({ dbPath, cursors, queuePath });
    assert.equal(result.recordsProcessed, 0);
    assert.equal(result.eventsAggregated, 0);
    assert.equal(result.bucketsQueued, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseHermesIncremental skips sessions with zero tokens", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-hermes-"));
  try {
    const dbPath = path.join(tmp, "state.db");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1 };

    createHermesDb(dbPath, [
      { id: "sess_empty", model: "gpt-5.4-mini", started_at: 1775993779.0, input_tokens: 0, output_tokens: 0, message_count: 1 },
    ]);

    const result = await parseHermesIncremental({ dbPath, cursors, queuePath });
    // The SQL WHERE clause already filters zero-token sessions, so 0 records returned
    assert.equal(result.recordsProcessed, 0);
    assert.equal(result.eventsAggregated, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseHermesIncremental tracks real-time token growth for active sessions (ended_at IS NULL)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-hermes-"));
  try {
    const dbPath = path.join(tmp, "state.db");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1 };

    const epoch1 = 1775993779.0; // 2026-04-12T11:36:19Z

    // Start with one completed session and one active (no ended_at)
    createHermesDb(dbPath, [
      { id: "sess_done", model: "gpt-5.4-mini", started_at: epoch1, ended_at: epoch1 + 120, input_tokens: 1000, output_tokens: 500, cache_read_tokens: 200, message_count: 4 },
      { id: "sess_active", model: "claude-sonnet-4-6", started_at: epoch1 + 200, ended_at: null, input_tokens: 5000, output_tokens: 200, cache_read_tokens: 1000, message_count: 5 },
    ]);

    // First parse — both sessions processed
    const first = await parseHermesIncremental({ dbPath, cursors, queuePath });
    assert.equal(first.recordsProcessed, 2);
    assert.equal(first.eventsAggregated, 2);

    // Cursor should have snapshots for both sessions
    assert.ok(cursors.hermes.snapshots);
    assert.equal(cursors.hermes.snapshots["sess_active"].in, 5000);
    assert.equal(cursors.hermes.snapshots["sess_done"].in, 1000);

    // Cursor only advances past completed sessions
    assert.equal(cursors.hermes.lastCompletedStartedAt, epoch1);

    // Simulate Hermes updating the active session in real-time
    cp.execFileSync("sqlite3", [
      dbPath,
      `UPDATE sessions SET input_tokens = 8000, output_tokens = 400, cache_read_tokens = 2000, message_count = 10 WHERE id = 'sess_active';`,
    ]);

    // Second parse — should pick up the delta for the active session
    const second = await parseHermesIncremental({ dbPath, cursors, queuePath });
    assert.equal(second.recordsProcessed, 2); // cursor-boundary completed session plus active session are re-read
    assert.equal(second.eventsAggregated, 1);

    // Verify the delta was computed correctly
    // queue.jsonl accumulates lines per sync; the last line for this model
    // holds the running total (first full + subsequent deltas).
    const queued2 = await readJsonLines(queuePath);
    const activeBuckets = queued2.filter((b) => b.source === "hermes" && b.model === "claude-sonnet-4-6");
    const activeBucket = activeBuckets[activeBuckets.length - 1];
    assert.ok(activeBucket);
    assert.equal(activeBucket.input_tokens, 8000);
    assert.equal(activeBucket.output_tokens, 400);
    assert.equal(activeBucket.cached_input_tokens, 2000);
    assert.equal(activeBucket.conversation_count, 10);

    // Snapshot should be updated
    assert.equal(cursors.hermes.snapshots["sess_active"].in, 8000);
    assert.equal(cursors.hermes.snapshots["sess_active"].out, 400);
    assert.equal(cursors.hermes.snapshots["sess_active"].message_count, 10);

    // Cursor still hasn't advanced past the active session
    assert.equal(cursors.hermes.lastCompletedStartedAt, epoch1);

    // Now end the active session
    cp.execFileSync("sqlite3", [
      dbPath,
      `UPDATE sessions SET ended_at = ${epoch1 + 600}, input_tokens = 10000, output_tokens = 600, cache_read_tokens = 3000 WHERE id = 'sess_active';`,
    ]);

    const third = await parseHermesIncremental({ dbPath, cursors, queuePath });
    assert.equal(third.recordsProcessed, 2);
    assert.equal(third.eventsAggregated, 1);

    // Now cursor should advance past the ended session
    assert.equal(cursors.hermes.lastCompletedStartedAt, epoch1 + 200);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseHermesIncremental ingests final deltas for active sessions older than newer completed sessions", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-hermes-old-active-"));
  try {
    const dbPath = path.join(tmp, "state.db");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1 };

    const activeEpoch = 1775990000.0;
    const completedEpoch = activeEpoch + 7200;

    createHermesDb(dbPath, [
      { id: "sess_active_old", model: "gpt-5.4-mini", started_at: activeEpoch, ended_at: null, input_tokens: 100, output_tokens: 10, message_count: 2 },
      { id: "sess_done_newer", model: "claude-sonnet-4-6", started_at: completedEpoch, ended_at: completedEpoch + 120, input_tokens: 1000, output_tokens: 50, message_count: 4 },
    ]);

    const first = await parseHermesIncremental({ dbPath, cursors, queuePath });
    assert.equal(first.recordsProcessed, 2);
    assert.equal(first.eventsAggregated, 2);
    assert.equal(cursors.hermes.lastCompletedStartedAt, activeEpoch);
    assert.equal(cursors.hermes.snapshots["sess_active_old"].in, 100);

    cp.execFileSync("sqlite3", [
      dbPath,
      `UPDATE sessions SET ended_at = ${activeEpoch + 3600}, input_tokens = 150, output_tokens = 25, message_count = 3 WHERE id = 'sess_active_old';`,
    ]);

    const second = await parseHermesIncremental({ dbPath, cursors, queuePath });
    assert.equal(second.eventsAggregated, 1);
    assert.equal(cursors.hermes.lastCompletedStartedAt, completedEpoch);

    const queued = await readJsonLines(queuePath);
    assert.ok(queued.some((b) => b.source === "hermes" && b.model === "gpt-5.4-mini" && b.input_tokens === 50 && b.output_tokens === 15));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseHermesIncremental skips active session when delta is zero (unchanged)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-hermes-"));
  try {
    const dbPath = path.join(tmp, "state.db");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1 };

    const epoch1 = 1775993779.0;
    createHermesDb(dbPath, [
      { id: "sess_active", model: "gpt-5.4-mini", started_at: epoch1, ended_at: null, input_tokens: 5000, output_tokens: 200, message_count: 5 },
    ]);

    // First parse
    const first = await parseHermesIncremental({ dbPath, cursors, queuePath });
    assert.equal(first.eventsAggregated, 1);

    // Second parse without any changes — should be no-op
    const second = await parseHermesIncremental({ dbPath, cursors, queuePath });
    assert.equal(second.eventsAggregated, 0);
    assert.equal(second.bucketsQueued, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseHermesIncremental backward compat: old cursor without snapshots", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-hermes-"));
  try {
    const dbPath = path.join(tmp, "state.db");
    const queuePath = path.join(tmp, "queue.jsonl");
    // Old-style cursor with lastStartedAt but no snapshots
    const cursors = { version: 1, hermes: { lastStartedAt: 0, updatedAt: "2026-04-12T00:00:00Z" } };

    const epoch1 = 1775993779.0;
    createHermesDb(dbPath, [
      { id: "sess_001", model: "gpt-5.4-mini", started_at: epoch1, ended_at: epoch1 + 120, input_tokens: 1000, output_tokens: 500, message_count: 4 },
    ]);

    const result = await parseHermesIncremental({ dbPath, cursors, queuePath });
    assert.equal(result.eventsAggregated, 1);
    // Should have created snapshots
    assert.ok(cursors.hermes.snapshots);
    assert.equal(cursors.hermes.snapshots["sess_001"].in, 1000);
    // New cursor field
    assert.equal(cursors.hermes.lastCompletedStartedAt, epoch1);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// ── GitHub Copilot OTEL parser tests ──

function writeCopilotOtelFile(filePath, spans) {
  const lines = spans.map((s) => JSON.stringify(s));
  require("node:fs").writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
}

// Shared chat usage attributes. CLI Span and Chat-extension LogRecord differ on
// envelope shape and on two key spellings (cache_write vs cache_creation,
// reasoning.output_tokens vs reasoning_tokens) — `useShortKeys` toggles those.
function makeCopilotChatAttrs({
  inputTokens,
  outputTokens,
  cacheRead,
  cacheCreation,
  reasoning,
  model,
  responseId,
  useShortKeys,
}) {
  const attrs = {
    "gen_ai.operation.name": "chat",
    "gen_ai.request.model": model,
    "gen_ai.response.model": model,
    "gen_ai.usage.input_tokens": inputTokens,
    "gen_ai.usage.output_tokens": outputTokens,
    "gen_ai.usage.cache_read.input_tokens": cacheRead,
  };
  if (responseId) attrs["gen_ai.response.id"] = responseId;
  if (useShortKeys) {
    attrs["gen_ai.usage.cache_creation.input_tokens"] = cacheCreation;
    attrs["gen_ai.usage.reasoning_tokens"] = reasoning;
  } else {
    attrs["gen_ai.usage.cache_write.input_tokens"] = cacheCreation;
    attrs["gen_ai.usage.reasoning.output_tokens"] = reasoning;
  }
  return attrs;
}

function makeCopilotChatSpan({
  traceId = "trace-a",
  spanId = "span-1",
  endSeconds = 1775934260,
  inputTokens = 1000,
  outputTokens = 200,
  cacheRead = 100,
  cacheWrite = 0,
  reasoning = 0,
  model = "claude-sonnet-4",
} = {}) {
  return {
    type: "span",
    traceId,
    spanId,
    name: `chat ${model}`,
    startTime: [endSeconds - 4, 0],
    endTime: [endSeconds, 0],
    attributes: makeCopilotChatAttrs({
      inputTokens,
      outputTokens,
      cacheRead,
      cacheCreation: cacheWrite,
      reasoning,
      model,
      useShortKeys: false,
    }),
  };
}

test("parseCopilotIncremental aggregates chat spans and subtracts cache from input", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-copilot-"));
  try {
    const otelPath = path.join(tmp, "copilot-otel-1.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1 };

    writeCopilotOtelFile(otelPath, [
      makeCopilotChatSpan({ traceId: "t1", spanId: "s1", inputTokens: 1000, outputTokens: 200, cacheRead: 100 }),
      // Non-chat span — should be ignored
      { type: "span", traceId: "t2", spanId: "s2", name: "tool execute", attributes: { "gen_ai.operation.name": "tool" } },
    ]);

    const result = await parseCopilotIncremental({ otelPaths: [otelPath], cursors, queuePath });
    assert.equal(result.eventsAggregated, 1);
    assert.ok(result.bucketsQueued >= 1);

    const queued = await readJsonLines(queuePath);
    const copilotBuckets = queued.filter((b) => b.source === "copilot");
    assert.equal(copilotBuckets.length, 1);
    const b = copilotBuckets[0];
    // OTEL input = 1000 includes cache_read 100 → input 900 + cached 100
    assert.equal(b.input_tokens, 900);
    assert.equal(b.output_tokens, 200);
    assert.equal(b.cached_input_tokens, 100);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseCopilotIncremental dedups by traceId:spanId across runs", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-copilot-"));
  try {
    const otelPath = path.join(tmp, "copilot-otel.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1 };

    writeCopilotOtelFile(otelPath, [
      makeCopilotChatSpan({ traceId: "t1", spanId: "s1" }),
    ]);

    await parseCopilotIncremental({ otelPaths: [otelPath], cursors, queuePath });
    // Re-parse same file — offset should skip already-seen content
    const second = await parseCopilotIncremental({ otelPaths: [otelPath], cursors, queuePath });
    assert.equal(second.eventsAggregated, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseCopilotIncremental re-reads from start when file is rotated (inode change)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-copilot-"));
  try {
    const otelPath = path.join(tmp, "copilot-otel.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1 };

    writeCopilotOtelFile(otelPath, [makeCopilotChatSpan({ traceId: "t1", spanId: "s1" })]);
    const first = await parseCopilotIncremental({ otelPaths: [otelPath], cursors, queuePath });
    assert.equal(first.eventsAggregated, 1);

    // Rotate by writing a fresh file and renaming it over the original. A plain
    // unlink+recreate can reuse the freed inode on Linux tmpfs, which wouldn't
    // exercise rotation at all; rename guarantees a new inode on every filesystem.
    const rotatedPath = otelPath + ".rotated";
    writeCopilotOtelFile(rotatedPath, [
      makeCopilotChatSpan({ traceId: "t2", spanId: "s2", inputTokens: 5000 }),
      makeCopilotChatSpan({ traceId: "t3", spanId: "s3", inputTokens: 5000 }),
    ]);
    require("node:fs").renameSync(rotatedPath, otelPath);

    const second = await parseCopilotIncremental({ otelPaths: [otelPath], cursors, queuePath });
    // Both new spans should be picked up despite the file being the "same" path
    assert.equal(second.eventsAggregated, 2);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// Chat extension `file` exporter writes OTEL JS SDK LogRecord-shaped entries
// (no top-level `type:"span"`, no traceId/spanId, uses `hrTime`).
function makeCopilotChatLogRecord({
  responseId = "resp-1",
  hrSeconds = 1778641563,
  inputTokens = 1000,
  outputTokens = 200,
  cacheRead = 100,
  cacheCreation = 0,
  reasoning = 0,
  model = "gpt-4o-mini-2024-07-18",
} = {}) {
  return {
    hrTime: [hrSeconds, 0],
    hrTimeObserved: [hrSeconds, 0],
    resource: { _rawAttributes: [["service.name", "copilot-chat"]] },
    instrumentationScope: { name: "copilot-chat", version: "0.47.1" },
    attributes: {
      "event.name": "gen_ai.client.inference.operation.details",
      ...makeCopilotChatAttrs({
        inputTokens,
        outputTokens,
        cacheRead,
        cacheCreation,
        reasoning,
        model,
        responseId,
        useShortKeys: true,
      }),
    },
    _body: `GenAI inference: ${model}`,
  };
}

test("parseCopilotIncremental handles Chat extension LogRecord shape (hrTime + response.id dedup)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-copilot-"));
  try {
    const otelPath = path.join(tmp, "vscode-chat.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1 };

    writeCopilotOtelFile(otelPath, [
      makeCopilotChatLogRecord({
        responseId: "r1",
        inputTokens: 1617,
        outputTokens: 6,
        cacheRead: 0,
      }),
      // Tool-call span (has spanContext, no gen_ai.operation.name=chat) — must be skipped
      {
        hrTime: [1778641572, 0],
        spanContext: { traceId: "t-tool", spanId: "s-tool" },
        attributes: { "event.name": "copilot_chat.tool.call", "gen_ai.tool.name": "manage_todo_list" },
      },
      // Metric record — must be skipped
      { resource: {}, scopeMetrics: [] },
    ]);

    const result = await parseCopilotIncremental({ otelPaths: [otelPath], cursors, queuePath });
    assert.equal(result.eventsAggregated, 1, "only the chat log record should aggregate");

    const queued = await readJsonLines(queuePath);
    const buckets = queued.filter((b) => b.source === "copilot");
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0].input_tokens, 1617);
    assert.equal(buckets[0].output_tokens, 6);
    assert.equal(buckets[0].total_tokens, 1623);
    assert.equal(buckets[0].model, "gpt-4o-mini-2024-07-18");

    // Idempotent re-read: same file → 0 new events
    const second = await parseCopilotIncremental({ otelPaths: [otelPath], cursors, queuePath });
    assert.equal(second.eventsAggregated, 0, "re-parse should not re-count");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseCopilotIncremental reads short cache_creation + reasoning_tokens keys (Chat extension)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-copilot-"));
  try {
    const otelPath = path.join(tmp, "vscode-chat.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1 };

    writeCopilotOtelFile(otelPath, [
      makeCopilotChatLogRecord({
        responseId: "r-cache",
        inputTokens: 5000,
        outputTokens: 300,
        cacheRead: 1500,
        cacheCreation: 800,
        reasoning: 250,
        model: "claude-sonnet-4-6",
      }),
    ]);

    await parseCopilotIncremental({ otelPaths: [otelPath], cursors, queuePath });
    const queued = await readJsonLines(queuePath);
    const b = queued.find((r) => r.source === "copilot");
    assert.ok(b, "copilot bucket present");
    // input(5000) - cache_read(1500) = 3500
    assert.equal(b.input_tokens, 3500);
    assert.equal(b.cached_input_tokens, 1500);
    assert.equal(b.cache_creation_input_tokens, 800);
    assert.equal(b.output_tokens, 300);
    assert.equal(b.reasoning_output_tokens, 250);
    assert.equal(b.total_tokens, 3500 + 1500 + 800 + 300 + 250);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseCopilotIncremental reads flat cached/reasoning usage keys from Copilot OTEL", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-copilot-"));
  try {
    const otelPath = path.join(tmp, "vscode-chat.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1 };

    const record = makeCopilotChatLogRecord({
      responseId: "r-flat-usage",
      inputTokens: 1_588_603,
      outputTokens: 15_768,
      cacheRead: 0,
      reasoning: 0,
      model: "claude-sonnet-4-6",
    });
    delete record.attributes["gen_ai.usage.cache_read.input_tokens"];
    delete record.attributes["gen_ai.usage.cache_creation.input_tokens"];
    delete record.attributes["gen_ai.usage.reasoning_tokens"];
    record.attributes["gen_ai.usage.cache_read_input_tokens"] = 1_517_440;
    record.attributes["gen_ai.usage.reasoning_output_tokens"] = 9_301;

    writeCopilotOtelFile(otelPath, [record]);

    await parseCopilotIncremental({ otelPaths: [otelPath], cursors, queuePath });
    const queued = await readJsonLines(queuePath);
    const b = queued.find((r) => r.source === "copilot");
    assert.ok(b, "copilot bucket present");
    assert.equal(b.input_tokens, 71_163);
    assert.equal(b.cached_input_tokens, 1_517_440);
    assert.equal(b.output_tokens, 15_768);
    assert.equal(b.reasoning_output_tokens, 9_301);
    assert.equal(b.total_tokens, 1_613_672);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseCopilotIncremental migration: v1 cursor with empty seenIds + non-empty fileOffsets re-reads file", async () => {
  // Repro of the real bug: a user on v0.13.0 enabled Chat-extension OTEL output,
  // pre-v2 parser silently rejected the LogRecord shape and pushed the cursor
  // offset to EOF without recording any seenIds. Without migration, the
  // post-upgrade parser would skip the file forever.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-copilot-mig-"));
  try {
    const otelPath = path.join(tmp, "vscode-chat.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    writeCopilotOtelFile(otelPath, [
      makeCopilotChatLogRecord({ responseId: "r-1", inputTokens: 500, outputTokens: 50, cacheRead: 0 }),
      makeCopilotChatLogRecord({ responseId: "r-2", inputTokens: 800, outputTokens: 90, cacheRead: 0 }),
    ]);
    const fileSize = require("node:fs").statSync(otelPath).size;
    const fileIno = require("node:fs").statSync(otelPath).ino;
    // Simulated v1 cursor state — offset already at EOF, seenIds empty
    const cursors = {
      copilot: {
        // no `version` field → treated as v1
        seenIds: [],
        fileOffsets: { [otelPath]: { size: fileSize, mtimeMs: Date.now(), ino: fileIno } },
        updatedAt: new Date().toISOString(),
      },
    };

    const result = await parseCopilotIncremental({ otelPaths: [otelPath], cursors, queuePath });
    assert.equal(result.eventsAggregated, 2, "migration should re-read both records");
    assert.equal(cursors.copilot.version, 2, "version should be bumped");

    const queued = await readJsonLines(queuePath);
    const b = queued.find((r) => r.source === "copilot");
    assert.equal(b.input_tokens, 1300);
    assert.equal(b.output_tokens, 140);
    assert.equal(b.conversation_count, 2);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseCopilotIncremental migration: preserves CLI fileOffsets (no re-read of CLI files)", async () => {
  // Type-B upgrade path: existing CLI OTEL user. v1 already counted their spans
  // and pushed offset to EOF. v2 migration must NOT re-read this file — even
  // with non-empty seenIds the parser would correctly dedupe, but a heavy user
  // with >10k spans had earlier dedup keys evicted by the seenIds cap, so a
  // re-read would re-count those evicted spans. Skip re-reading entirely.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-copilot-mig-b-"));
  try {
    const otelPath = path.join(tmp, "copilot-otel.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    writeCopilotOtelFile(otelPath, [
      makeCopilotChatSpan({ traceId: "t-cli", spanId: "s-cli", inputTokens: 2000, outputTokens: 100 }),
    ]);
    const fileSize = require("node:fs").statSync(otelPath).size;
    const fileIno = require("node:fs").statSync(otelPath).ino;
    const cursors = {
      copilot: {
        seenIds: ["t-cli:s-cli"],
        fileOffsets: { [otelPath]: { size: fileSize, mtimeMs: Date.now(), ino: fileIno } },
        updatedAt: new Date().toISOString(),
      },
    };

    const result = await parseCopilotIncremental({ otelPaths: [otelPath], cursors, queuePath });
    assert.equal(result.eventsAggregated, 0, "must not re-read CLI file with intact offset");
    assert.equal(
      result.recordsProcessed,
      0,
      "CLI file should be skipped entirely (offset === size after migration)",
    );
    assert.equal(cursors.copilot.version, 2);
    // Offset preserved (within tolerance for fresh stat) — confirms no full re-read happened
    assert.equal(
      cursors.copilot.fileOffsets[otelPath].size,
      fileSize,
      "CLI fileOffset size must remain at EOF",
    );
    const queued = await readJsonLines(queuePath);
    assert.equal(queued.filter((r) => r.source === "copilot").length, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseCopilotIncremental migration: CLI file with metric record at head is NOT mistaken for v1-skipped", async () => {
  // Codex review reproduced: real OTEL files can lead with a metric blob (no
  // `type:"span"`) followed by CLI spans. The migration must scan past the
  // metric header to find the spans, otherwise it resets the offset and
  // re-counts every span beyond the seenIds cap.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-copilot-mix-head-"));
  try {
    const otelPath = path.join(tmp, "copilot-otel.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const fsNode = require("node:fs");
    const lines = [
      // OTEL metric record — v1 rejects but doesn't stop reading
      JSON.stringify({ resource: {}, scopeMetrics: [] }),
    ];
    for (let i = 0; i < 50; i++) {
      lines.push(
        JSON.stringify(
          makeCopilotChatSpan({
            traceId: `t-${i}`,
            spanId: `s-${i}`,
            inputTokens: 100,
            outputTokens: 10,
          }),
        ),
      );
    }
    fsNode.writeFileSync(otelPath, lines.join("\n") + "\n", "utf8");
    const stat = fsNode.statSync(otelPath);
    // Heavy user: only the last two dedup keys survive the seenIds cap
    const cursors = {
      copilot: {
        seenIds: ["t-48:s-48", "t-49:s-49"],
        fileOffsets: {
          [otelPath]: { size: stat.size, mtimeMs: Date.now(), ino: stat.ino },
        },
        updatedAt: new Date().toISOString(),
      },
    };

    const result = await parseCopilotIncremental({ otelPaths: [otelPath], cursors, queuePath });
    assert.equal(
      result.eventsAggregated,
      0,
      "metric-headed CLI file must keep its offset; otherwise 48 evicted spans double-count",
    );
    const queued = await readJsonLines(queuePath);
    assert.equal(queued.filter((r) => r.source === "copilot").length, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseCopilotIncremental migration: CLI file with name-only chat spans (no gen_ai.operation.name) preserves offset", async () => {
  // Codex review: v1's isCopilotChatSpan recognized CLI spans via EITHER
  // attributes["gen_ai.operation.name"] === "chat" OR name.startsWith("chat ").
  // The migration helper must mirror both; otherwise older CLI traces that
  // only carry the legacy name-prefix shape look like "v1 skipped" -> reset ->
  // re-read → double-count for users beyond the seenIds cap.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-copilot-name-only-"));
  try {
    const otelPath = path.join(tmp, "copilot-otel.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const fsNode = require("node:fs");
    const lines = [];
    for (let i = 0; i < 50; i++) {
      // Span shape with `name:"chat ..."` but NO gen_ai.operation.name attribute
      lines.push(
        JSON.stringify({
          type: "span",
          traceId: `t-${i}`,
          spanId: `s-${i}`,
          name: "chat gpt-4o",
          startTime: [1700000000 + i, 0],
          endTime: [1700000000 + i, 100000000],
          attributes: {
            "gen_ai.response.model": "gpt-4o",
            "gen_ai.usage.input_tokens": 100,
            "gen_ai.usage.output_tokens": 10,
          },
        }),
      );
    }
    fsNode.writeFileSync(otelPath, lines.join("\n") + "\n", "utf8");
    const stat = fsNode.statSync(otelPath);
    const cursors = {
      copilot: {
        seenIds: ["t-48:s-48", "t-49:s-49"],
        fileOffsets: {
          [otelPath]: { size: stat.size, mtimeMs: Date.now(), ino: stat.ino },
        },
        updatedAt: new Date().toISOString(),
      },
    };

    const result = await parseCopilotIncremental({ otelPaths: [otelPath], cursors, queuePath });
    assert.equal(
      result.eventsAggregated,
      0,
      "v1 recognized name-prefix chat spans — migration must too, otherwise 48 spans double-count",
    );
    const queued = await readJsonLines(queuePath);
    assert.equal(queued.filter((r) => r.source === "copilot").length, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseCopilotIncremental migration: heavy CLI user (>10k spans, seenIds capped) is NOT re-read", async () => {
  // Regression for the data-accuracy risk flagged in review: when a CLI user has
  // historical spans beyond the 10k seenIds cap, naive offset reset would
  // re-read records whose dedup keys were already evicted, double-counting them.
  // The peek-based migration must keep the CLI file offset intact.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-copilot-heavy-"));
  try {
    const otelPath = path.join(tmp, "copilot-otel.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const records = [];
    for (let i = 0; i < 50; i++) {
      records.push(
        makeCopilotChatSpan({ traceId: `t-${i}`, spanId: `s-${i}`, inputTokens: 100, outputTokens: 10 }),
      );
    }
    writeCopilotOtelFile(otelPath, records);
    const fileSize = require("node:fs").statSync(otelPath).size;
    const fileIno = require("node:fs").statSync(otelPath).ino;
    // Simulate the capped state: seenIds only retains the LAST few (evicted earlier ones)
    const cursors = {
      copilot: {
        seenIds: ["t-48:s-48", "t-49:s-49"],
        fileOffsets: { [otelPath]: { size: fileSize, mtimeMs: Date.now(), ino: fileIno } },
        updatedAt: new Date().toISOString(),
      },
    };

    const result = await parseCopilotIncremental({ otelPaths: [otelPath], cursors, queuePath });
    assert.equal(result.eventsAggregated, 0, "evicted-but-uncounted spans must not resurrect on migration");
    const queued = await readJsonLines(queuePath);
    assert.equal(queued.filter((r) => r.source === "copilot").length, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseCopilotIncremental migration: mixed CLI + Chat-extension files resets only the Chat-extension one", async () => {
  // The migration must distinguish per-file: CLI keeps offset, Chat-extension resets.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-copilot-mig-mix-"));
  try {
    const cliPath = path.join(tmp, "copilot-otel.jsonl");
    const idePath = path.join(tmp, "vscode-chat.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    writeCopilotOtelFile(cliPath, [
      makeCopilotChatSpan({ traceId: "t-old", spanId: "s-old", inputTokens: 1000, outputTokens: 50 }),
    ]);
    writeCopilotOtelFile(idePath, [
      makeCopilotChatLogRecord({
        responseId: "r-skipped",
        inputTokens: 700,
        outputTokens: 30,
        cacheRead: 0,
      }),
    ]);
    const cliSize = require("node:fs").statSync(cliPath).size;
    const cliIno = require("node:fs").statSync(cliPath).ino;
    const ideSize = require("node:fs").statSync(idePath).size;
    const ideIno = require("node:fs").statSync(idePath).ino;
    // v1 state: CLI was counted (seenIds non-empty), Chat-extension was rejected
    // but offset still advanced to EOF
    const cursors = {
      copilot: {
        seenIds: ["t-old:s-old"],
        fileOffsets: {
          [cliPath]: { size: cliSize, mtimeMs: Date.now(), ino: cliIno },
          [idePath]: { size: ideSize, mtimeMs: Date.now(), ino: ideIno },
        },
        updatedAt: new Date().toISOString(),
      },
    };

    const result = await parseCopilotIncremental({
      otelPaths: [cliPath, idePath],
      cursors,
      queuePath,
    });
    // Only the Chat-extension record should surface; the CLI offset is preserved.
    assert.equal(result.eventsAggregated, 1);
    const queued = await readJsonLines(queuePath);
    const buckets = queued.filter((b) => b.source === "copilot");
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0].input_tokens, 700);
    assert.equal(buckets[0].output_tokens, 30);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseCopilotIncremental migration: same file mixed CLI + Chat-extension replays only skipped Chat records", async () => {
  // Some OTEL exporters can append different record envelopes to one file. If a
  // file contains both v1-counted CLI spans and v1-skipped Chat LogRecords, the
  // migration must re-read the file but skip the old CLI lines, even if those
  // CLI spans have no usable dedup key.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-copilot-mig-same-file-"));
  try {
    const otelPath = path.join(tmp, "copilot-otel.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    writeCopilotOtelFile(otelPath, [
      makeCopilotChatSpan({
        traceId: undefined,
        spanId: undefined,
        inputTokens: 1000,
        outputTokens: 50,
      }),
      makeCopilotChatLogRecord({
        responseId: "r-same-file-skipped",
        inputTokens: 700,
        outputTokens: 30,
        cacheRead: 0,
      }),
    ]);
    const stat = require("node:fs").statSync(otelPath);
    const cursors = {
      copilot: {
        seenIds: [],
        fileOffsets: {
          [otelPath]: { size: stat.size, mtimeMs: Date.now(), ino: stat.ino },
        },
        updatedAt: new Date().toISOString(),
      },
    };

    const result = await parseCopilotIncremental({ otelPaths: [otelPath], cursors, queuePath });
    assert.equal(result.eventsAggregated, 1, "only the v1-skipped Chat LogRecord should be replayed");

    const queued = await readJsonLines(queuePath);
    const buckets = queued.filter((b) => b.source === "copilot");
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0].input_tokens, 700);
    assert.equal(buckets[0].output_tokens, 30);
    assert.equal(buckets[0].conversation_count, 1);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseCopilotIncremental aggregates mixed CLI Span + Chat extension LogRecord", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-copilot-"));
  try {
    const cliPath = path.join(tmp, "copilot-otel.jsonl");
    const idePath = path.join(tmp, "vscode-chat.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1 };

    writeCopilotOtelFile(cliPath, [
      makeCopilotChatSpan({
        traceId: "t-cli",
        spanId: "s-cli",
        endSeconds: 1778641000,
        inputTokens: 2000,
        outputTokens: 100,
        cacheRead: 200,
        model: "gpt-4o-mini-2024-07-18",
      }),
    ]);
    writeCopilotOtelFile(idePath, [
      makeCopilotChatLogRecord({
        responseId: "r-ide",
        hrSeconds: 1778641100,
        inputTokens: 3000,
        outputTokens: 150,
        cacheRead: 0,
        model: "gpt-4o-mini-2024-07-18",
      }),
    ]);

    const result = await parseCopilotIncremental({
      otelPaths: [cliPath, idePath],
      cursors,
      queuePath,
    });
    assert.equal(result.eventsAggregated, 2);

    const queued = await readJsonLines(queuePath);
    const buckets = queued.filter((b) => b.source === "copilot");
    // Both records fall in the same 30-min UTC bucket and share the same model
    const merged = buckets.reduce(
      (acc, b) => ({
        input: acc.input + b.input_tokens,
        output: acc.output + b.output_tokens,
        cached: acc.cached + b.cached_input_tokens,
        total: acc.total + b.total_tokens,
      }),
      { input: 0, output: 0, cached: 0, total: 0 },
    );
    // CLI: 2000-200=1800 input, 100 output, 200 cached. IDE: 3000 input, 150 output, 0 cached.
    assert.equal(merged.input, 1800 + 3000);
    assert.equal(merged.output, 100 + 150);
    assert.equal(merged.cached, 200);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseCopilotIncremental returns zero when no OTEL files exist", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-copilot-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1 };

    // env.HOME → tmp so resolver doesn't pick up the real user's ~/.copilot/otel
    const result = await parseCopilotIncremental({
      otelPaths: [],
      cursors,
      queuePath,
      env: { HOME: tmp },
    });
    assert.equal(result.recordsProcessed, 0);
    assert.equal(result.eventsAggregated, 0);
    assert.equal(result.bucketsQueued, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseKimiIncremental reads StatusUpdate events from wire.jsonl", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-kimi-"));
  try {
    const sessionDir = path.join(tmp, "sessions", "ws1", "sess1");
    await fs.mkdir(sessionDir, { recursive: true });

    const lines = [
      JSON.stringify({ type: "metadata", protocol_version: "1.5" }),
      JSON.stringify({
        timestamp: 1775833108.22,
        message: {
          type: "StatusUpdate",
          payload: {
            message_id: "chatcmpl-TEST1",
            token_usage: { input_other: 14218, output: 123, input_cache_read: 6144, input_cache_creation: 0 },
          },
        },
      }),
      // duplicate message_id — must be ignored
      JSON.stringify({
        timestamp: 1775833109.0,
        message: {
          type: "StatusUpdate",
          payload: {
            message_id: "chatcmpl-TEST1",
            token_usage: { input_other: 14218, output: 123, input_cache_read: 6144, input_cache_creation: 0 },
          },
        },
      }),
      JSON.stringify({
        timestamp: 1775833119.41,
        message: {
          type: "StatusUpdate",
          payload: {
            message_id: "chatcmpl-TEST2",
            token_usage: { input_other: 553, output: 357, input_cache_read: 20224, input_cache_creation: 0 },
          },
        },
      }),
    ].join("\n");

    const wireFile = path.join(sessionDir, "wire.jsonl");
    await fs.writeFile(wireFile, lines);

    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1 };
    const result = await parseKimiIncremental({ wireFiles: [wireFile], cursors, queuePath });

    assert.equal(result.eventsAggregated, 2);        // dedup removed the duplicate TEST1
    assert.equal(result.recordsProcessed, 2);        // duplicate is skipped before counting
    assert.ok(result.bucketsQueued > 0);

    // Cursor state persisted
    assert.ok(Array.isArray(cursors.kimi?.seenIds));
    assert.equal(cursors.kimi.seenIds.length, 2);
    assert.ok(cursors.kimi.seenIds.includes("chatcmpl-TEST1"));
    assert.ok(cursors.kimi.seenIds.includes("chatcmpl-TEST2"));

    // Second run — no new data
    const result2 = await parseKimiIncremental({ wireFiles: [wireFile], cursors, queuePath });
    assert.equal(result2.eventsAggregated, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseKimiIncremental returns zero when no wire files exist", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-kimi-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1 };
    const result = await parseKimiIncremental({ wireFiles: [], cursors, queuePath });
    assert.equal(result.recordsProcessed, 0);
    assert.equal(result.eventsAggregated, 0);
    assert.equal(result.bucketsQueued, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CodeBuddy — passive ~/.codebuddy/projects/<cwd>/<sessionId>.jsonl reader.
// Tencent's CodeBuddy CLI is structurally cloned from Claude Code; assistant
// messages carry token usage in providerData.rawUsage.
// ─────────────────────────────────────────────────────────────────────────────

function buildCodebuddyAssistantLine({
  uuid,
  timestamp,
  model = "hy3-preview-agent",
  prompt_tokens,
  completion_tokens,
  cached_tokens = 0,
  cache_creation_input_tokens = 0,
  reasoning_tokens = 0,
}) {
  return JSON.stringify({
    type: "message",
    role: "assistant",
    uuid,
    timestamp,
    sessionId: "sess-test",
    providerData: {
      model,
      rawUsage: {
        prompt_tokens,
        completion_tokens,
        total_tokens: prompt_tokens + completion_tokens,
        prompt_tokens_details: { cached_tokens, reasoning_tokens },
        cache_read_input_tokens: 0,
        cache_creation_input_tokens,
        credit: 0.42,
      },
      usage: {
        requests: 1,
        inputTokens: prompt_tokens,
        outputTokens: completion_tokens,
        totalTokens: prompt_tokens + completion_tokens,
      },
    },
    message: {
      usage: {
        input_tokens: prompt_tokens,
        output_tokens: completion_tokens,
        total_tokens: prompt_tokens + completion_tokens,
      },
    },
  });
}

test("parseCodebuddyIncremental subtracts cached_tokens from prompt_tokens (avoid double-count)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codebuddy-"));
  try {
    const projectDir = path.join(tmp, "projects", "encoded-cwd");
    await fs.mkdir(projectDir, { recursive: true });

    // The user-provided sample: prompt_tokens=22223, cached=512, completion=250
    // Expected split: input=22223-512=21711, cached=512, output=250.
    const lines = [
      JSON.stringify({ type: "topic", topic: "Hello" }),
      buildCodebuddyAssistantLine({
        uuid: "msg-1",
        timestamp: 1777427166667,
        prompt_tokens: 22223,
        completion_tokens: 250,
        cached_tokens: 512,
      }),
      // file-history-snapshot must be ignored
      JSON.stringify({ type: "file-history-snapshot", path: "x.txt" }),
      // reasoning event (no token usage) must be ignored
      JSON.stringify({ type: "reasoning", text: "thinking..." }),
    ].join("\n");

    const sessionFile = path.join(projectDir, "abc.jsonl");
    await fs.writeFile(sessionFile, lines);

    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1 };
    const result = await parseCodebuddyIncremental({
      projectFiles: [sessionFile],
      cursors,
      queuePath,
    });

    assert.equal(result.recordsProcessed, 1);
    assert.equal(result.eventsAggregated, 1);
    assert.ok(result.bucketsQueued > 0);

    const queueRaw = await fs.readFile(queuePath, "utf8");
    const queueLines = queueRaw.trim().split("\n").filter(Boolean);
    assert.equal(queueLines.length, 1);
    const entry = JSON.parse(queueLines[0]);

    assert.equal(entry.source, "codebuddy");
    assert.equal(entry.model, "hy3-preview-agent");
    // CRITICAL split: prompt_tokens INCLUDES cached, so input must subtract.
    assert.equal(entry.input_tokens, 21711);
    assert.equal(entry.cached_input_tokens, 512);
    assert.equal(entry.cache_creation_input_tokens, 0);
    assert.equal(entry.output_tokens, 250);
    assert.equal(entry.reasoning_output_tokens, 0);
    // total = 21711 + 250 + 512 + 0 + 0 = 22473
    assert.equal(entry.total_tokens, 22473);
    assert.equal(entry.conversation_count, 1);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseCodebuddyIncremental dedupes by uuid across runs and aggregates 30-min buckets", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codebuddy-"));
  try {
    const projectDir = path.join(tmp, "projects", "encoded-cwd");
    await fs.mkdir(projectDir, { recursive: true });

    // Two messages 35 minutes apart at 14:00 and 14:35 UTC must land in
    // distinct half-hour buckets (14:00 + 14:30).
    const ts1 = Date.UTC(2026, 3, 5, 14, 0, 0);
    const ts2 = Date.UTC(2026, 3, 5, 14, 35, 0);
    const lines = [
      buildCodebuddyAssistantLine({
        uuid: "msg-A",
        timestamp: ts1,
        prompt_tokens: 1000,
        completion_tokens: 100,
        cached_tokens: 0,
      }),
      buildCodebuddyAssistantLine({
        uuid: "msg-B",
        timestamp: ts2,
        prompt_tokens: 2000,
        completion_tokens: 200,
        cached_tokens: 100,
      }),
      // Duplicate of msg-A (same uuid) — must be ignored.
      buildCodebuddyAssistantLine({
        uuid: "msg-A",
        timestamp: ts1,
        prompt_tokens: 1000,
        completion_tokens: 100,
        cached_tokens: 0,
      }),
    ].join("\n");

    const sessionFile = path.join(projectDir, "session.jsonl");
    await fs.writeFile(sessionFile, lines);

    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1 };
    const result = await parseCodebuddyIncremental({
      projectFiles: [sessionFile],
      cursors,
      queuePath,
    });

    assert.equal(result.eventsAggregated, 2);
    assert.equal(result.recordsProcessed, 2); // duplicate dropped before counting

    const queueRaw = await fs.readFile(queuePath, "utf8");
    const queueLines = queueRaw.trim().split("\n").filter(Boolean);
    assert.equal(queueLines.length, 2, "two distinct half-hour buckets expected");
    const buckets = queueLines.map((l) => JSON.parse(l));
    const hours = buckets.map((b) => b.hour_start).sort();
    assert.deepEqual(hours, [
      "2026-04-05T14:00:00.000Z",
      "2026-04-05T14:30:00.000Z",
    ]);

    // Cursor state persisted with both message uuids.
    assert.ok(Array.isArray(cursors.codebuddy?.seenIds));
    assert.equal(cursors.codebuddy.seenIds.length, 2);
    assert.ok(cursors.codebuddy.seenIds.includes("msg-A"));
    assert.ok(cursors.codebuddy.seenIds.includes("msg-B"));

    // Second run on the same file — no new events.
    const result2 = await parseCodebuddyIncremental({
      projectFiles: [sessionFile],
      cursors,
      queuePath,
    });
    assert.equal(result2.eventsAggregated, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseCodebuddyIncremental falls back to settings.json model when providerData.model missing", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codebuddy-"));
  try {
    // Lay out the canonical ~/.codebuddy/{settings.json,projects/...} so the
    // resolver picks up the settings.json fallback.
    await fs.writeFile(
      path.join(tmp, "settings.json"),
      JSON.stringify({ model: "hy3-preview" }),
    );
    const projectDir = path.join(tmp, "projects", "encoded-cwd");
    await fs.mkdir(projectDir, { recursive: true });

    // Assistant entry with NO providerData.model and NO entry.model — must
    // fall back to the resolved settings model.
    const entryWithoutModel = JSON.stringify({
      type: "message",
      role: "assistant",
      uuid: "msg-no-model",
      timestamp: Date.UTC(2026, 3, 5, 12, 0, 0),
      providerData: {
        rawUsage: {
          prompt_tokens: 500,
          completion_tokens: 50,
          prompt_tokens_details: { cached_tokens: 0 },
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    });
    await fs.writeFile(path.join(projectDir, "s.jsonl"), entryWithoutModel);

    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1 };
    const result = await parseCodebuddyIncremental({
      projectFiles: [path.join(projectDir, "s.jsonl")],
      cursors,
      queuePath,
      env: { CODEBUDDY_HOME: tmp },
    });

    assert.equal(result.eventsAggregated, 1);
    const entry = JSON.parse((await fs.readFile(queuePath, "utf8")).trim());
    assert.equal(entry.model, "hy3-preview");
    assert.equal(entry.source, "codebuddy");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseCodebuddyIncremental uses 'codebuddy-unknown' fallback when settings.json is absent", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codebuddy-"));
  try {
    const fallback = resolveCodebuddyDefaultModel({ CODEBUDDY_HOME: tmp });
    assert.equal(fallback, "codebuddy-unknown");

    const projectDir = path.join(tmp, "projects", "encoded-cwd");
    await fs.mkdir(projectDir, { recursive: true });
    const entryWithoutModel = JSON.stringify({
      type: "message",
      role: "assistant",
      uuid: "msg-bare",
      timestamp: Date.UTC(2026, 3, 5, 12, 0, 0),
      providerData: {
        rawUsage: {
          prompt_tokens: 100,
          completion_tokens: 10,
          prompt_tokens_details: { cached_tokens: 0 },
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    });
    await fs.writeFile(path.join(projectDir, "x.jsonl"), entryWithoutModel);

    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1 };
    const result = await parseCodebuddyIncremental({
      projectFiles: [path.join(projectDir, "x.jsonl")],
      cursors,
      queuePath,
      env: { CODEBUDDY_HOME: tmp },
    });

    assert.equal(result.eventsAggregated, 1);
    const entry = JSON.parse((await fs.readFile(queuePath, "utf8")).trim());
    assert.equal(entry.model, "codebuddy-unknown");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseCodebuddyIncremental returns zero when no project files exist", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codebuddy-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1 };
    const result = await parseCodebuddyIncremental({
      projectFiles: [],
      cursors,
      queuePath,
    });
    assert.equal(result.recordsProcessed, 0);
    assert.equal(result.eventsAggregated, 0);
    assert.equal(result.bucketsQueued, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseCodebuddyIncremental parses extension log cache split like TokScale", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codebuddy-log-"));
  try {
    const logPath = path.join(tmp, "extension.log");
    await fs.writeFile(
      logPath,
      [
        "[2026/7/1 16:56:01.100] [info] [CraftInvokableAgent] [agent-1] Model prepared: Kimi-K2.7-Code (kimi-k2.7)",
        '[2026/7/1 16:56:02.200] [info] [AgentReporter] [agent-1] Agent execution successful with usage: {"inputTokens":140732,"outputTokens":635,"totalTokens":141367,"cacheTokens":76032,"cachedWriteTokens":0,"cachedMissTokens":64700,"lastTokens":71051,"credit":10.38}',
      ].join("\n") + "\n",
      "utf8",
    );

    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1 };
    const result = await parseCodebuddyIncremental({
      projectFiles: [logPath],
      cursors,
      queuePath,
      defaultModel: "codebuddy-unknown",
    });

    assert.equal(result.eventsAggregated, 1);
    const entry = JSON.parse((await fs.readFile(queuePath, "utf8")).trim());
    assert.equal(entry.source, "codebuddy");
    assert.equal(entry.model, "kimi-k2.7");
    assert.equal(entry.input_tokens, 64700);
    assert.equal(entry.cached_input_tokens, 76032);
    assert.equal(entry.cache_creation_input_tokens, 0);
    assert.equal(entry.output_tokens, 635);
    assert.equal(entry.total_tokens, 141367);
    // Test case 2: No cachedMissTokens/cacheMissTokens, falling back to inputTokens.
    // In this case, prompt_tokens/inputTokens contains cacheTokens, so it must be subtracted.
    const logPath2 = path.join(tmp, "extension2.log");
    await fs.writeFile(
      logPath2,
      [
        "[2026/7/1 16:56:01.100] [info] [CraftInvokableAgent] [agent-2] Model prepared: Kimi-K2.7-Code (kimi-k2.7)",
        '[2026/7/1 16:56:02.200] [info] [AgentReporter] [agent-2] Agent execution successful with usage: {"inputTokens":140732,"outputTokens":635,"totalTokens":141367,"cacheTokens":76032,"cachedWriteTokens":0}',
      ].join("\n") + "\n",
      "utf8",
    );
    const queuePath2 = path.join(tmp, "queue2.jsonl");
    const cursors2 = { version: 1 };
    await parseCodebuddyIncremental({
      projectFiles: [logPath2],
      cursors: cursors2,
      queuePath: queuePath2,
      defaultModel: "codebuddy-unknown",
    });
    const entry2 = JSON.parse((await fs.readFile(queuePath2, "utf8")).trim());
    assert.equal(entry2.input_tokens, 64700); // 140732 - 76032 = 64700
    assert.equal(entry2.cached_input_tokens, 76032);
    assert.equal(entry2.total_tokens, 141367);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseCodebuddyIncremental keeps extension log model across incremental tail reads", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codebuddy-log-tail-"));
  try {
    const logPath = path.join(tmp, "extension.log");
    await fs.writeFile(
      logPath,
      "[2026/7/1 16:56:01.100] [info] [CraftInvokableAgent] [agent-1] Model prepared: GLM-5.2 (glm-5.2)\n",
      "utf8",
    );

    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1 };
    await parseCodebuddyIncremental({
      projectFiles: [logPath],
      cursors,
      queuePath,
      defaultModel: "codebuddy-unknown",
    });

    await fs.appendFile(
      logPath,
      '[2026/7/1 16:56:02.200] [info] [AgentReporter] [agent-1] Agent execution successful with usage: {"inputTokens":10,"outputTokens":2,"totalTokens":12}\n',
      "utf8",
    );
    const result = await parseCodebuddyIncremental({
      projectFiles: [logPath],
      cursors,
      queuePath,
      defaultModel: "codebuddy-unknown",
    });

    assert.equal(result.eventsAggregated, 1);
    const entry = JSON.parse((await fs.readFile(queuePath, "utf8")).trim());
    assert.equal(entry.model, "glm-5.2");
    assert.equal(entry.input_tokens, 10);
    assert.equal(entry.total_tokens, 12);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("resolveCodebuddyProjectFiles walks ~/.codebuddy/projects/<cwd>/*.jsonl and skips others", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codebuddy-"));
  try {
    const projectsDir = path.join(tmp, "projects");
    const cwdA = path.join(projectsDir, "cwd-a");
    const cwdB = path.join(projectsDir, "cwd-b");
    await fs.mkdir(cwdA, { recursive: true });
    await fs.mkdir(cwdB, { recursive: true });
    await fs.writeFile(path.join(cwdA, "s1.jsonl"), "");
    await fs.writeFile(path.join(cwdA, "ignored.txt"), "");
    await fs.writeFile(path.join(cwdB, "s2.jsonl"), "");

    const files = resolveCodebuddyProjectFiles({ CODEBUDDY_HOME: tmp });
    assert.equal(files.length, 2);
    assert.ok(files.every((f) => f.endsWith(".jsonl")));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// WorkBuddy — passive ~/.workbuddy/projects/<cwd>/**/*.jsonl reader.
// Tencent's WorkBuddy is a Claude-Code fork in the same family as CodeBuddy,
// but usage rides on function_call records too (not just assistant messages),
// sub-agent logs nest one level deeper, and prompt_tokens is the FULL prompt so
// BOTH cache reads AND cache writes must be subtracted to get pure input. Each
// rawUsage below is shaped from real ~/.workbuddy logs.
// ─────────────────────────────────────────────────────────────────────────────

function buildWorkbuddyLine({
  id,
  type = "message",
  role,
  timestamp,
  model = "auto",
  rawUsage,
  isSubAgent = false,
}) {
  const providerData = { model, requestModelId: model, requestModelName: model, messageId: `m-${id}` };
  if (rawUsage) providerData.rawUsage = rawUsage;
  if (isSubAgent) providerData.isSubAgent = true;
  const record = { id, type, timestamp, sessionId: "wb-sess", providerData };
  if (role) record.role = role;
  return JSON.stringify(record);
}

test("parseWorkbuddyIncremental subtracts BOTH cache reads and writes from prompt_tokens (no ~2x inflation)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-workbuddy-"));
  try {
    const projectDir = path.join(tmp, "projects", "encoded-cwd");
    await fs.mkdir(projectDir, { recursive: true });

    // Anthropic-style mirror (real record): cache_read + cache_creation set.
    //   prompt=34869, read=33554, creation=1312 → input = 34869-33554-1312 = 3
    const lines = [
      buildWorkbuddyLine({
        id: "wb-1",
        type: "function_call", // usage rides on function_call, NOT an assistant message
        timestamp: Date.UTC(2026, 3, 5, 14, 0, 0),
        rawUsage: {
          prompt_tokens: 34869,
          completion_tokens: 63,
          total_tokens: 34932,
          prompt_tokens_details: { cached_tokens: 33554, reasoning_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: 0 },
          cache_read_input_tokens: 33554,
          cache_creation_input_tokens: 1312,
        },
      }),
    ].join("\n");

    const sessionFile = path.join(projectDir, "abc.jsonl");
    await fs.writeFile(sessionFile, lines);

    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1 };
    const result = await parseWorkbuddyIncremental({
      projectFiles: [sessionFile],
      cursors,
      queuePath,
      env: { WORKBUDDY_HOME: path.join(tmp, "missing-workbuddy-home"), HOME: tmp },
    });

    assert.equal(result.eventsAggregated, 1, "function_call usage must be aggregated");
    const entry = JSON.parse((await fs.readFile(queuePath, "utf8")).trim());
    assert.equal(entry.source, "workbuddy");
    assert.equal(entry.model, "auto");
    // CRITICAL: input subtracts cache_read AND cache_creation. The naive
    // CodeBuddy formula (prompt - cache_read = 1315) would double-count the
    // 1312 cache-creation tokens that already sit in their own column.
    assert.equal(entry.input_tokens, 3);
    assert.equal(entry.cached_input_tokens, 33554);
    assert.equal(entry.cache_creation_input_tokens, 1312);
    assert.equal(entry.output_tokens, 63);
    assert.equal(entry.reasoning_output_tokens, 0);
    // total == prompt_tokens + completion_tokens (the provider's own total)
    assert.equal(entry.total_tokens, 34932);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseWorkbuddyIncremental reads DeepSeek-style cache mirror and subtracts reasoning from completion", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-workbuddy-"));
  try {
    const projectDir = path.join(tmp, "projects", "encoded-cwd");
    await fs.mkdir(projectDir, { recursive: true });

    // DeepSeek/OpenAI mirror (real record): cache read lives in
    // prompt_tokens_details.cached_tokens / prompt_cache_hit_tokens, NOT in
    // cache_read_input_tokens (which is 0). Reasoning sits inside completion.
    //   prompt=31013, read=704, creation=0 → input = 30309
    //   completion=206, reasoning=130 → output = 76
    const line = buildWorkbuddyLine({
      id: "wb-ds",
      type: "function_call",
      timestamp: Date.UTC(2026, 3, 5, 14, 0, 0),
      rawUsage: {
        prompt_tokens: 31013,
        completion_tokens: 206,
        total_tokens: 31219,
        completion_tokens_details: { reasoning_tokens: 130 },
        prompt_tokens_details: { cached_tokens: 704, reasoning_tokens: 0 },
        prompt_cache_hit_tokens: 704,
        prompt_cache_miss_tokens: 30309,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });
    const sessionFile = path.join(projectDir, "ds.jsonl");
    await fs.writeFile(sessionFile, line);

    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1 };
    await parseWorkbuddyIncremental({
      projectFiles: [sessionFile],
      cursors,
      queuePath,
      env: { WORKBUDDY_HOME: path.join(tmp, "missing-workbuddy-home"), HOME: tmp },
    });

    const entry = JSON.parse((await fs.readFile(queuePath, "utf8")).trim());
    assert.equal(entry.input_tokens, 30309);
    assert.equal(entry.cached_input_tokens, 704);
    assert.equal(entry.cache_creation_input_tokens, 0);
    assert.equal(entry.output_tokens, 76);
    assert.equal(entry.reasoning_output_tokens, 130);
    assert.equal(entry.total_tokens, 31219);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("resolveWorkbuddyProjectFiles recurses into nested subagent logs and skips non-jsonl", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-workbuddy-"));
  try {
    const cwd = path.join(tmp, "projects", "encoded-cwd");
    const subagents = path.join(cwd, "sess-1", "subagents");
    const toolResults = path.join(cwd, "sess-1", "tool-results");
    await fs.mkdir(subagents, { recursive: true });
    await fs.mkdir(toolResults, { recursive: true });
    await fs.writeFile(path.join(cwd, "sess-1.jsonl"), ""); // main session log
    await fs.writeFile(path.join(subagents, "agent-aaa.jsonl"), ""); // nested sub-agent
    await fs.writeFile(path.join(subagents, "agent-bbb.jsonl"), "");
    await fs.writeFile(path.join(toolResults, "chatcmpl-tool-x.txt"), ""); // must be ignored

    const files = resolveWorkbuddyProjectFiles({ WORKBUDDY_HOME: tmp });
    assert.equal(files.length, 3, "main log + 2 nested subagent logs");
    assert.ok(files.every((f) => f.endsWith(".jsonl")));
    assert.ok(files.some((f) => f.includes(path.join("subagents", "agent-aaa.jsonl"))));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseWorkbuddyIncremental dedupes by response id across runs and buckets by half-hour", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-workbuddy-"));
  try {
    const projectDir = path.join(tmp, "projects", "encoded-cwd");
    await fs.mkdir(projectDir, { recursive: true });

    const ts1 = Date.UTC(2026, 3, 5, 14, 0, 0);
    const ts2 = Date.UTC(2026, 3, 5, 14, 35, 0);
    const mk = (id, ts) =>
      buildWorkbuddyLine({
        id,
        type: "function_call",
        timestamp: ts,
        rawUsage: {
          prompt_tokens: 1000,
          completion_tokens: 100,
          total_tokens: 1100,
          prompt_tokens_details: { cached_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: 0 },
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      });
    const lines = [mk("r-A", ts1), mk("r-B", ts2), mk("r-A", ts1)].join("\n"); // r-A dup
    const sessionFile = path.join(projectDir, "session.jsonl");
    await fs.writeFile(sessionFile, lines);

    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1 };
    const result = await parseWorkbuddyIncremental({
      projectFiles: [sessionFile],
      cursors,
      queuePath,
      env: { WORKBUDDY_HOME: path.join(tmp, "missing-workbuddy-home"), HOME: tmp },
    });
    assert.equal(result.eventsAggregated, 2, "duplicate response id dropped");

    const buckets = (await fs.readFile(queuePath, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.equal(buckets.length, 2);
    assert.deepEqual(
      buckets.map((b) => b.hour_start).sort(),
      ["2026-04-05T14:00:00.000Z", "2026-04-05T14:30:00.000Z"],
    );
    assert.ok(cursors.workbuddy?.seenIds?.includes("r-A"));

    // Second run on the same file — no new events.
    const result2 = await parseWorkbuddyIncremental({
      projectFiles: [sessionFile],
      cursors,
      queuePath,
      env: { WORKBUDDY_HOME: path.join(tmp, "missing-workbuddy-home"), HOME: tmp },
    });
    assert.equal(result2.eventsAggregated, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseWorkbuddyIncremental emits provider.model verbatim (auto vs hy3) and falls back to 'auto'", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-workbuddy-"));
  try {
    assert.equal(resolveWorkbuddyDefaultModel({ WORKBUDDY_HOME: tmp }), "auto");

    const projectDir = path.join(tmp, "projects", "encoded-cwd");
    await fs.mkdir(projectDir, { recursive: true });
    const usage = {
      prompt_tokens: 500,
      completion_tokens: 50,
      total_tokens: 550,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    const lines = [
      buildWorkbuddyLine({ id: "m-auto", type: "function_call", timestamp: Date.UTC(2026, 3, 5, 9, 0, 0), model: "auto", rawUsage: usage }),
      buildWorkbuddyLine({ id: "m-hy3", type: "function_call", timestamp: Date.UTC(2026, 3, 5, 9, 5, 0), model: "hy3-preview-agent", rawUsage: usage }),
    ].join("\n");
    await fs.writeFile(path.join(projectDir, "s.jsonl"), lines);

    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1 };
    await parseWorkbuddyIncremental({
      projectFiles: [path.join(projectDir, "s.jsonl")],
      cursors,
      queuePath,
      env: { WORKBUDDY_HOME: tmp },
    });

    const models = (await fs.readFile(queuePath, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).model)
      .sort();
    assert.deepEqual(models, ["auto", "hy3-preview-agent"]);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseWorkbuddyIncremental SQLite fallback emits cumulative deltas, not full snapshots", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-workbuddy-sqlite-"));
  try {
    const dbPath = path.join(tmp, "workbuddy.db");
    cp.execFileSync("sqlite3", [
      dbPath,
      [
        "CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, model TEXT);",
        "CREATE TABLE session_usage (session_id TEXT PRIMARY KEY, used INTEGER, size INTEGER, updated_at INTEGER, credit_json TEXT);",
        "INSERT INTO sessions VALUES ('s1','/tmp/project','auto');",
        "INSERT INTO session_usage VALUES ('s1',100,0,1780000000000,'{}');",
      ].join(" "),
    ]);

    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1 };
    const first = await parseWorkbuddyIncremental({
      projectFiles: [],
      cursors,
      queuePath,
      env: { WORKBUDDY_HOME: tmp, HOME: tmp },
    });
    assert.equal(first.eventsAggregated, 1);

    cp.execFileSync("sqlite3", [
      dbPath,
      "UPDATE session_usage SET used=150, updated_at=1780000010000 WHERE session_id='s1';",
    ]);
    const second = await parseWorkbuddyIncremental({
      projectFiles: [],
      cursors,
      queuePath,
      env: { WORKBUDDY_HOME: tmp, HOME: tmp },
    });
    assert.equal(second.eventsAggregated, 1);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 2);
    assert.equal(queued[0].input_tokens, 100);
    assert.equal(queued[1].input_tokens, 150);
    assert.equal(queued[1].total_tokens, 150);
    assert.equal(queued[1].conversation_count, 1);
    assert.equal(cursors.workbuddy.sqliteSessions.s1.used, 150);

    cp.execFileSync("sqlite3", [
      dbPath,
      "UPDATE session_usage SET updated_at=1780000020000 WHERE session_id='s1';",
    ]);
    const third = await parseWorkbuddyIncremental({
      projectFiles: [],
      cursors,
      queuePath,
      env: { WORKBUDDY_HOME: tmp, HOME: tmp },
    });
    assert.equal(third.eventsAggregated, 0);
    assert.equal((await readJsonLines(queuePath)).length, 2);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseWorkbuddyIncremental uses SQLite fallback when JSONL files are empty", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-workbuddy-sqlite-empty-jsonl-"));
  try {
    const dbPath = path.join(tmp, "workbuddy.db");
    cp.execFileSync("sqlite3", [
      dbPath,
      [
        "CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, model TEXT);",
        "CREATE TABLE session_usage (session_id TEXT PRIMARY KEY, used INTEGER, size INTEGER, updated_at INTEGER, credit_json TEXT);",
        "INSERT INTO sessions VALUES ('s-empty','/tmp/project','auto');",
        "INSERT INTO session_usage VALUES ('s-empty',100,0,1780000000000,'{}');",
      ].join(" "),
    ]);

    const projectDir = path.join(tmp, "projects", "encoded-cwd");
    await fs.mkdir(projectDir, { recursive: true });
    const emptySessionFile = path.join(projectDir, "s-empty.jsonl");
    await fs.writeFile(emptySessionFile, "");

    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1 };
    const result = await parseWorkbuddyIncremental({
      projectFiles: [emptySessionFile],
      cursors,
      queuePath,
      env: { WORKBUDDY_HOME: tmp, HOME: tmp },
    });

    assert.equal(result.eventsAggregated, 1);
    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].source, "workbuddy");
    assert.equal(queued[0].input_tokens, 100);
    assert.equal(queued[0].total_tokens, 100);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseWorkbuddyIncremental keeps detailed JSONL authoritative over SQLite fallback", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-workbuddy-sqlite-detailed-"));
  try {
    const dbPath = path.join(tmp, "workbuddy.db");
    cp.execFileSync("sqlite3", [
      dbPath,
      [
        "CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, model TEXT);",
        "CREATE TABLE session_usage (session_id TEXT PRIMARY KEY, used INTEGER, size INTEGER, updated_at INTEGER, credit_json TEXT);",
        "INSERT INTO sessions VALUES ('wb-sess','/tmp/project','auto');",
        "INSERT INTO session_usage VALUES ('wb-sess',500,0,1780000000000,'{}');",
      ].join(" "),
    ]);

    const projectDir = path.join(tmp, "projects", "encoded-cwd");
    await fs.mkdir(projectDir, { recursive: true });
    const sessionFile = path.join(projectDir, "wb-sess.jsonl");
    await fs.writeFile(
      sessionFile,
      buildWorkbuddyLine({
        id: "wb-detailed",
        type: "function_call",
        timestamp: 1780000000000,
        rawUsage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          prompt_tokens_details: { cached_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: 0 },
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      }),
    );

    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1 };
    const result = await parseWorkbuddyIncremental({
      projectFiles: [sessionFile],
      cursors,
      queuePath,
      env: { WORKBUDDY_HOME: tmp, HOME: tmp },
    });

    assert.equal(result.eventsAggregated, 1);
    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].input_tokens, 100);
    assert.equal(queued[0].output_tokens, 20);
    assert.equal(queued[0].total_tokens, 120);
    assert.equal(cursors.workbuddy.detailedSessions["wb-sess"], true);
    assert.equal(cursors.workbuddy.sqliteSessions?.["wb-sess"], undefined);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Kiro CLI — ~/.kiro/sessions/cli/{uuid}.json session-state files (TASK-001)
// Fixture provenance is PENDING LIVE VALIDATION — see
// test/fixtures/kiro-cli/active-source.json header for the spec-derivation note.
// ─────────────────────────────────────────────────────────────────────────────

const rolloutModule = require("../src/lib/rollout");

test("parseKiroCliIncremental aggregates user_turn_metadatas into half-hour kiro buckets (currently fails until TASK-003)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-kirocli-"));
  try {
    const sessionsDir = path.join(tmp, "sessions", "cli");
    await fs.mkdir(sessionsDir, { recursive: true });
    // TASK-003: resolver filters to canonical UUID-shaped filenames.
    const sessionId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1";
    const activeFixture = await fs.readFile(
      path.join(__dirname, "fixtures", "kiro-cli", "active-source.json"),
      "utf8",
    );
    await fs.writeFile(path.join(sessionsDir, `${sessionId}.json`), activeFixture);
    await fs.writeFile(path.join(sessionsDir, `${sessionId}.jsonl`), "");

    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1 };

    // Fail LOUDLY if the parser hasn't been implemented yet. This is the
    // red state the plan's TASK-001 requires; it flips to green in TASK-003.
    assert.ok(
      typeof rolloutModule.parseKiroCliIncremental === "function",
      "parseKiroCliIncremental must be exported from src/lib/rollout (TASK-003)",
    );
    assert.ok(
      typeof rolloutModule.resolveKiroCliSessionFiles === "function",
      "resolveKiroCliSessionFiles must be exported from src/lib/rollout (TASK-002)",
    );

    const files = rolloutModule.resolveKiroCliSessionFiles({ KIRO_HOME: tmp });
    assert.equal(files.length, 1, "resolver should discover exactly one session file");

    const result = await rolloutModule.parseKiroCliIncremental({
      sessionFiles: files,
      cursors,
      queuePath,
      env: { KIRO_HOME: tmp },
    });

    assert.equal(result.recordsProcessed, 2);
    assert.ok(result.bucketsQueued >= 2, "two turns span two half-hour buckets");

    const queueContent = await fs.readFile(queuePath, "utf8");
    const rows = queueContent
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    assert.ok(rows.length >= 2, "queue must have at least two bucket rows");
    for (const row of rows) {
      assert.equal(row.source, "kiro", "CLI MUST emit source='kiro' for merge with IDE");
    }
    const totalInput = rows.reduce((s, r) => s + (r.input_tokens || 0), 0);
    assert.equal(totalInput, 1500, "1200 + 300 from fixture turns");

    // Cursor state isolated in kiroCli slot
    assert.ok(cursors.kiroCli, "cursors.kiroCli must be set after parse");
    assert.equal(
      cursors.kiro,
      undefined,
      "CLI parser must NOT touch cursors.kiro (IDE cursor)",
    );

    // Idempotent re-run
    const result2 = await rolloutModule.parseKiroCliIncremental({
      sessionFiles: files,
      cursors,
      queuePath,
      env: { KIRO_HOME: tmp },
    });
    assert.equal(result2.eventsAggregated, 0, "second run must not double-count");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseKiroCliIncremental produces zero buckets for empty user_turn_metadatas", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-kirocli-"));
  try {
    const sessionsDir = path.join(tmp, "sessions", "cli");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionId = "fixture-empty-0000-0000-0000-000000000002";
    const emptyFixture = await fs.readFile(
      path.join(__dirname, "fixtures", "kiro-cli", "empty-source.json"),
      "utf8",
    );
    await fs.writeFile(path.join(sessionsDir, `${sessionId}.json`), emptyFixture);

    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1 };

    assert.ok(
      typeof rolloutModule.parseKiroCliIncremental === "function",
      "parseKiroCliIncremental must be exported from src/lib/rollout (TASK-003)",
    );

    const files = rolloutModule.resolveKiroCliSessionFiles({ KIRO_HOME: tmp });
    const queueSizeBefore = await safeFileSize(queuePath);

    const result = await rolloutModule.parseKiroCliIncremental({
      sessionFiles: files,
      cursors,
      queuePath,
      env: { KIRO_HOME: tmp },
    });

    assert.equal(result.recordsProcessed, 0);
    assert.equal(result.eventsAggregated, 0);
    assert.equal(result.bucketsQueued, 0);
    const queueSizeAfter = await safeFileSize(queuePath);
    assert.equal(queueSizeAfter, queueSizeBefore, "empty session must not grow the queue");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("resolveKiroCliSessionFiles includes both completed and live (.lock) sessions", async () => {
  // Live tracking is the design intent: we want the user's current
  // session to appear in sync output without waiting for kiro-cli to
  // exit. Kiro CLI rewrites .json atomically per turn flush, and
  // parseKiroCliIncremental's fingerprint-based subtract-old/add-new
  // logic handles subsequent mutations safely.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-kirocli-"));
  try {
    const sessionsDir = path.join(tmp, "sessions", "cli");
    await fs.mkdir(sessionsDir, { recursive: true });
    // TASK-003: filenames must be canonical UUIDs to be picked up.
    const doneUuid = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const liveUuid = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    // Completed session: .json only, no .lock
    await fs.writeFile(path.join(sessionsDir, `${doneUuid}.json`), "{}");
    // Live session: .json + .lock
    await fs.writeFile(path.join(sessionsDir, `${liveUuid}.json`), "{}");
    await fs.writeFile(path.join(sessionsDir, `${liveUuid}.lock`), '{"pid":1}');
    // Non-UUID files that must be skipped by the resolver
    await fs.writeFile(path.join(sessionsDir, "notes.json"), "{}");
    await fs.writeFile(path.join(sessionsDir, "foo.bak.json"), "{}");

    assert.ok(
      typeof rolloutModule.resolveKiroCliSessionFiles === "function",
      "resolveKiroCliSessionFiles must be exported from src/lib/rollout (TASK-002)",
    );

    const files = rolloutModule.resolveKiroCliSessionFiles({
      HOME: tmp,
      KIRO_HOME: tmp,
    });
    assert.equal(files.length, 2, "both completed and live sessions must be returned");
    const names = files.map((f) => path.basename(f)).sort();
    assert.deepEqual(
      names,
      [`${doneUuid}.json`, `${liveUuid}.json`],
      "non-UUID files (notes.json, foo.bak.json) must be skipped",
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

async function safeFileSize(p) {
  try {
    const st = await fs.stat(p);
    return st.size;
  } catch {
    return 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Kiro CLI — mutable-request delta + Bedrock-ID canonicalization.
// Exercises the SQLite-backed path via a synthetic DB written in-process.
// ─────────────────────────────────────────────────────────────────────────────

test("parseKiroCliIncremental canonicalizes Bedrock model IDs and re-buckets on fingerprint change", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-kirocli-mutable-"));
  try {
    const dbPath = path.join(tmp, "data.sqlite3");
    const queuePath = path.join(tmp, "queue.jsonl");
    // KIRO_HOME must point at an empty tmp root so resolveKiroCliSessionFiles
    // does not pick up the developer's real ~/.kiro/sessions/cli/ contents
    // and contaminate this test.
    const env = { KIRO_CLI_DB_PATH: dbPath, KIRO_HOME: tmp };

    // One conversation with one request: Bedrock ARN-style model id, small
    // prompt/response. Timestamps are dynamic (a couple hours ago) — a fixed
    // calendar date would age past the 90-day cursor window and trip the
    // prune watermark, silently breaking the multi-run assertions below.
    const bucketMs = 30 * 60 * 1000;
    const bucketStartMs = Math.floor((Date.now() - 2 * 3600 * 1000) / bucketMs) * bucketMs;
    const reqTsMs = bucketStartMs + 5 * 60 * 1000;
    const expectedHourStart = new Date(bucketStartMs).toISOString();
    function convValue(promptLen, responseLen) {
      return {
        model_info: { model_id: "auto" },
        user_turn_metadata: {
          continuation_id: "conv-1",
          requests: [
            {
              request_id: "req-1",
              message_id: "msg-1",
              request_start_timestamp_ms: reqTsMs,
              user_prompt_length: promptLen,
              response_size: responseLen,
              model_id: "anthropic.claude-sonnet-4-20250514-v1:0",
            },
          ],
        },
      };
    }

    cp.execFileSync("sqlite3", [
      dbPath,
      "CREATE TABLE conversations_v2 (key TEXT, conversation_id TEXT, value TEXT, created_at INTEGER, updated_at INTEGER, PRIMARY KEY (key, conversation_id));",
    ]);
    cp.execFileSync("sqlite3", [
      dbPath,
      `INSERT INTO conversations_v2 VALUES ('project-a', 'conv-1', '${JSON.stringify(convValue(400, 80)).replace(/'/g, "''")}', 1771667600000, 1771667700000);`,
    ]);

    const cursors = { version: 1 };

    // First run: 400 chars prompt -> 100 input tokens; 80 chars response -> 20 output tokens
    const r1 = await rolloutModule.parseKiroCliIncremental({ cursors, queuePath, env });
    assert.equal(r1.recordsProcessed, 1);
    assert.equal(r1.eventsAggregated, 1);

    const rowsA = (await fs.readFile(queuePath, "utf8"))
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    assert.equal(rowsA.length, 1);
    assert.equal(rowsA[0].source, "kiro", "source must merge under 'kiro'");
    assert.equal(
      rowsA[0].model,
      "claude-sonnet-4",
      "Bedrock ARN 'anthropic.claude-sonnet-4-20250514-v1:0' must canonicalize to 'claude-sonnet-4'",
    );
    assert.equal(rowsA[0].input_tokens, 100);
    assert.equal(rowsA[0].output_tokens, 20);

    // Second run with the SAME request data: idempotent — no new queue row.
    const r2 = await rolloutModule.parseKiroCliIncremental({ cursors, queuePath, env });
    assert.equal(r2.eventsAggregated, 0, "idempotent re-run must not re-add");
    const rowsB = (await fs.readFile(queuePath, "utf8"))
      .split("\n")
      .filter((l) => l.trim());
    assert.equal(rowsB.length, 1, "queue must not grow on idempotent re-run");

    // Mutate the request: Kiro rewrites the same request_id with larger
    // prompt/response. The parser must subtract the prior contribution and
    // add the new one — not skip forever.
    cp.execFileSync("sqlite3", [
      dbPath,
      `UPDATE conversations_v2 SET value = '${JSON.stringify(convValue(800, 160)).replace(/'/g, "''")}' WHERE conversation_id = 'conv-1';`,
    ]);
    const r3 = await rolloutModule.parseKiroCliIncremental({ cursors, queuePath, env });
    assert.equal(r3.eventsAggregated, 1, "fingerprint-changed request must be re-bucketed");

    const rowsC = (await fs.readFile(queuePath, "utf8"))
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    // The queue appends cumulative snapshots; consumers (readQueueData in
    // src/lib/local-api.js) dedupe by (source, model, hour_start) and keep
    // the LATEST row. So the mutation is correctly reflected iff the last
    // row for this bucket shows the new 200 / 40 approx counts.
    const lastForBucket = rowsC
      .filter(
        (row) =>
          row.source === "kiro" &&
          row.model === "claude-sonnet-4" &&
          row.hour_start === expectedHourStart,
      )
      .pop();
    assert.ok(lastForBucket, "mutated bucket must have at least one queue row");
    assert.equal(
      lastForBucket.input_tokens,
      200,
      "latest row for the bucket must reflect the post-mutation prompt tokens (800 chars / 4)",
    );
    assert.equal(
      lastForBucket.output_tokens,
      40,
      "latest row for the bucket must reflect the post-mutation response tokens (160 chars / 4)",
    );

    // Cursor state records the per-request fingerprint + contribution so a
    // third identical run is again idempotent.
    const r4 = await rolloutModule.parseKiroCliIncremental({ cursors, queuePath, env });
    assert.equal(r4.eventsAggregated, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseKiroCliIncremental retracts orphan session-file contribution when a conversation migrates into SQLite (TASK-007 + D-1)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-kiro-migrate-"));
  try {
    const dbPath = path.join(tmp, "data.sqlite3");
    const queuePath = path.join(tmp, "queue.jsonl");
    const sessionsDir = path.join(tmp, ".kiro", "sessions", "cli");
    await fs.mkdir(sessionsDir, { recursive: true });
    const convId = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    const env = { KIRO_CLI_DB_PATH: dbPath, HOME: tmp };

    // Run 1: session-file only, stores cursor under `${convId}:42`.
    await fs.writeFile(
      path.join(sessionsDir, `${convId}.json`),
      JSON.stringify({
        session_id: convId,
        session_state: {
          rts_model_state: { model_info: { model_id: "claude-sonnet-4.5" } },
          conversation_metadata: {
            user_turn_metadatas: [
              {
                loop_id: { rand: 42 },
                message_ids: ["m1"],
                // Dynamic ts: a fixed date would age past the 90-day cursor
                // window and the prune watermark would skip run 2.
                request_start_timestamp_ms: Date.now() - 2 * 3600 * 1000,
                input_token_count: 100,
                output_token_count: 200,
              },
            ],
          },
        },
      }),
    );
    await fs.writeFile(path.join(sessionsDir, `${convId}.jsonl`), "");
    cp.execFileSync("sqlite3", [
      dbPath,
      "CREATE TABLE conversations_v2 (key TEXT, conversation_id TEXT, value TEXT, created_at INTEGER, updated_at INTEGER, PRIMARY KEY (key, conversation_id));",
    ]);

    const cursors = { version: 1 };
    const r1 = await rolloutModule.parseKiroCliIncremental({
      cursors,
      queuePath,
      env,
    });
    assert.equal(r1.eventsAggregated, 1);

    // Run 2: SQLite now contains the conversation under conv_id=convId AND
    // continuation_id=convId. The retraction pass must subtract the old
    // session-file contribution before the SQLite row adds 100/200.
    cp.execFileSync("sqlite3", [
      dbPath,
      `INSERT INTO conversations_v2 VALUES ('proj', '${convId}', '${JSON.stringify(
        {
          model_info: { model_id: "claude-sonnet-4.5" },
          user_turn_metadata: {
            continuation_id: convId,
            requests: [
              {
                request_id: "sqlite-req-0001",
                message_id: "m1",
                request_start_timestamp_ms: Date.now() - 2 * 3600 * 1000,
                user_prompt_length: 400,
                response_size: 800,
                model_id: "claude-sonnet-4.5",
              },
            ],
          },
        },
      ).replace(/'/g, "''")}', 1, 2);`,
    ]);

    await rolloutModule.parseKiroCliIncremental({
      cursors,
      queuePath,
      env,
    });
    const keys = Object.keys(cursors.kiroCli.requests);
    assert.ok(!keys.includes(`${convId}:42`), "session-file cursor retracted");
    assert.ok(keys.includes("sqlite-req-0001"), "SQLite cursor present");

    const rows = (await fs.readFile(queuePath, "utf8"))
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    const latest = new Map();
    for (const row of rows)
      latest.set(`${row.source}|${row.model}|${row.hour_start}`, row);
    let totIn = 0;
    let totOut = 0;
    for (const row of latest.values()) {
      if (row.source !== "kiro") continue;
      totIn += row.input_tokens || 0;
      totOut += row.output_tokens || 0;
    }
    assert.equal(totIn, 100, "one contribution survives, not two");
    assert.equal(totOut, 200);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseKiroCliIncremental retracts no-loop_id session-file entries via session_id tag (Bug-2)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-kiro-noloop-"));
  try {
    const dbPath = path.join(tmp, "data.sqlite3");
    const queuePath = path.join(tmp, "queue.jsonl");
    const sessionsDir = path.join(tmp, ".kiro", "sessions", "cli");
    await fs.mkdir(sessionsDir, { recursive: true });
    const convId = "11111111-1111-1111-1111-111111111111";
    const msgId = "22222222-2222-2222-2222-222222222222";
    const env = { KIRO_CLI_DB_PATH: dbPath, HOME: tmp };

    // No loop_id → cursor key falls back to the bare message_id UUID.
    await fs.writeFile(
      path.join(sessionsDir, `${convId}.json`),
      JSON.stringify({
        session_id: convId,
        session_state: {
          rts_model_state: { model_info: { model_id: "claude-sonnet-4.5" } },
          conversation_metadata: {
            user_turn_metadatas: [
              {
                message_ids: [msgId],
                // Dynamic ts — see the migrate test above for why.
                request_start_timestamp_ms: Date.now() - 2 * 3600 * 1000,
                input_token_count: 100,
                output_token_count: 200,
              },
            ],
          },
        },
      }),
    );
    await fs.writeFile(path.join(sessionsDir, `${convId}.jsonl`), "");
    cp.execFileSync("sqlite3", [
      dbPath,
      "CREATE TABLE conversations_v2 (key TEXT, conversation_id TEXT, value TEXT, created_at INTEGER, updated_at INTEGER, PRIMARY KEY (key, conversation_id));",
    ]);

    const cursors = { version: 1 };
    await rolloutModule.parseKiroCliIncremental({ cursors, queuePath, env });
    const firstCursor = cursors.kiroCli.requests;
    assert.equal(Object.keys(firstCursor).length, 1);
    const reqKey = Object.keys(firstCursor)[0];
    assert.equal(reqKey.indexOf(":"), -1, "bare UUID has no colon");
    assert.equal(firstCursor[reqKey].session_id, convId);

    // Migration into SQLite
    cp.execFileSync("sqlite3", [
      dbPath,
      `INSERT INTO conversations_v2 VALUES ('proj', '${convId}', '${JSON.stringify(
        {
          model_info: { model_id: "claude-sonnet-4.5" },
          user_turn_metadata: {
            continuation_id: convId,
            requests: [
              {
                request_id: "new-sqlite-req",
                message_id: msgId,
                request_start_timestamp_ms: Date.now() - 2 * 3600 * 1000,
                user_prompt_length: 400,
                response_size: 800,
                model_id: "claude-sonnet-4.5",
              },
            ],
          },
        },
      ).replace(/'/g, "''")}', 1, 2);`,
    ]);
    await rolloutModule.parseKiroCliIncremental({ cursors, queuePath, env });
    const ks = Object.keys(cursors.kiroCli.requests);
    assert.ok(!ks.includes(msgId), "no-colon cursor entry retracted via session_id tag");
    assert.ok(ks.includes("new-sqlite-req"));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseKiroCliIncremental keeps newer session-file turns when older ones have migrated to SQLite (mixed-state, turn-granular)", async () => {
  // Regression: previously, cross-source retraction filtered flatSessions
  // at session_id granularity — so an active session with turn A in SQLite
  // AND turns A + B in the session file would drop B entirely, producing
  // Kiro CLI under-count for the currently-active conversation.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-kiro-mixed-"));
  try {
    const dbPath = path.join(tmp, "data.sqlite3");
    const queuePath = path.join(tmp, "queue.jsonl");
    const sessionsDir = path.join(tmp, ".kiro", "sessions", "cli");
    await fs.mkdir(sessionsDir, { recursive: true });
    const convId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const msgA = "msg-A-migrated";
    const msgB = "msg-B-session-only";
    // Dynamic timestamps in two adjacent half-hour buckets — fixed dates
    // would age past the 90-day cursor window (prune watermark skip).
    const mixedBucketMs = 30 * 60 * 1000;
    const mixedBase = Math.floor((Date.now() - 2 * 3600 * 1000) / mixedBucketMs) * mixedBucketMs;
    const tsA = mixedBase + 5 * 60 * 1000;
    const tsB = mixedBase + 35 * 60 * 1000;
    const env = { KIRO_CLI_DB_PATH: dbPath, HOME: tmp };

    // Session file: turn A (older, also in SQLite) + turn B (newer, not
    // yet flushed). kiro-cli keeps flushed turns in the session file
    // until the whole session ends, so the overlap is normal.
    await fs.writeFile(
      path.join(sessionsDir, `${convId}.json`),
      JSON.stringify({
        session_id: convId,
        session_state: {
          rts_model_state: { model_info: { model_id: "claude-sonnet-4.5" } },
          conversation_metadata: {
            user_turn_metadatas: [
              {
                loop_id: { rand: 10 },
                message_ids: [msgA],
                request_start_timestamp_ms: tsA,
                input_token_count: 100,
                output_token_count: 200,
              },
              {
                loop_id: { rand: 11 },
                message_ids: [msgB],
                request_start_timestamp_ms: tsB,
                input_token_count: 60,
                output_token_count: 30,
              },
            ],
          },
        },
      }),
    );
    await fs.writeFile(path.join(sessionsDir, `${convId}.jsonl`), "");
    cp.execFileSync("sqlite3", [
      dbPath,
      "CREATE TABLE conversations_v2 (key TEXT, conversation_id TEXT, value TEXT, created_at INTEGER, updated_at INTEGER, PRIMARY KEY (key, conversation_id));",
    ]);

    // Run 1: only the session file has data (B doesn't exist yet — simulate
    // by only inserting turn A into the session file for the first pass).
    // For simplicity we run once with the full file but empty SQLite; both
    // turns land via session-file parse.
    const cursors = { version: 1 };
    const r1 = await rolloutModule.parseKiroCliIncremental({
      cursors,
      queuePath,
      env,
    });
    assert.equal(r1.eventsAggregated, 2, "run 1 parses both turns from session file");

    // Run 2: turn A has flushed to SQLite (conv_id=convId, message_id=msgA).
    // Turn B is still session-only.
    cp.execFileSync("sqlite3", [
      dbPath,
      `INSERT INTO conversations_v2 VALUES ('proj', '${convId}', '${JSON.stringify(
        {
          model_info: { model_id: "claude-sonnet-4.5" },
          user_turn_metadata: {
            continuation_id: convId,
            requests: [
              {
                request_id: "sqlite-req-A",
                message_id: msgA,
                request_start_timestamp_ms: tsA,
                user_prompt_length: 400,
                response_size: 800,
                model_id: "claude-sonnet-4.5",
              },
            ],
          },
        },
      ).replace(/'/g, "''")}', 1, 2);`,
    ]);

    await rolloutModule.parseKiroCliIncremental({
      cursors,
      queuePath,
      env,
    });

    // Cursor: A's session-file key retracted, SQLite key added. B's
    // session-file key remains (it has NOT migrated).
    const keys = Object.keys(cursors.kiroCli.requests);
    assert.ok(!keys.includes(`${convId}:10`), "turn A session-file cursor retracted");
    assert.ok(keys.includes("sqlite-req-A"), "turn A SQLite cursor added");
    assert.ok(
      keys.includes(`${convId}:11`),
      "turn B session-file cursor preserved (un-migrated, must survive)",
    );

    // Bucket totals: A (from SQLite) + B (from session file) = 100+60 in, 200+30 out.
    const rows = (await fs.readFile(queuePath, "utf8"))
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    const latest = new Map();
    for (const row of rows)
      latest.set(`${row.source}|${row.model}|${row.hour_start}`, row);
    let totIn = 0;
    let totOut = 0;
    for (const row of latest.values()) {
      if (row.source !== "kiro") continue;
      totIn += row.input_tokens || 0;
      totOut += row.output_tokens || 0;
    }
    assert.equal(totIn, 160, "A (SQLite) + B (session-only) survive");
    assert.equal(totOut, 230);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseKiroCliIncremental early-return path still runs cap + clamp (Bug-1)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-kiro-early-"));
  try {
    const dbPath = path.join(tmp, "data.sqlite3");
    const queuePath = path.join(tmp, "queue.jsonl");
    const env = { KIRO_CLI_DB_PATH: dbPath, HOME: tmp };
    const staleIso = new Date(Date.now() - 200 * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 19) + ".000Z";
    const freshIso = new Date(Date.now() - 5 * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 19) + ".000Z";
    const cursors = {
      version: 1,
      kiroCli: {
        requests: {
          fresh: { fingerprint: "f", bucketStart: freshIso, model: "m", input_tokens: 1, output_tokens: 1 },
          stale1: { fingerprint: "f", bucketStart: staleIso, model: "m", input_tokens: 1, output_tokens: 1 },
          stale2: { fingerprint: "f", bucketStart: staleIso, model: "m", input_tokens: 1, output_tokens: 1 },
        },
      },
    };
    cp.execFileSync("sqlite3", [
      dbPath,
      "CREATE TABLE conversations_v2 (key TEXT, conversation_id TEXT, value TEXT, created_at INTEGER, updated_at INTEGER, PRIMARY KEY (key, conversation_id));",
    ]);
    const r = await rolloutModule.parseKiroCliIncremental({
      cursors,
      queuePath,
      env,
    });
    assert.equal(r.recordsProcessed, 0);
    assert.deepEqual(
      Object.keys(cursors.kiroCli.requests).sort(),
      ["fresh"],
      "cap must drop stale entries on the zero-flat early-return path",
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseKiroCliIncremental never re-adds requests whose cursor entry was age-pruned (inflation loop)", async () => {
  // Regression (2026-06 audit): clampAndCapKiroCliState dropped cursor
  // entries older than 90 days, but readKiroCliRequests re-reads the FULL
  // conversations_v2 table every sync. A pruned request came back with
  // `prev === undefined` and was re-ADDED to its old bucket on every sync —
  // the bucket's absolute totals grew without bound. The persisted prune
  // watermark must freeze anything older than the prune horizon after the
  // first ingest.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-kiro-inflate-"));
  try {
    const dbPath = path.join(tmp, "data.sqlite3");
    const queuePath = path.join(tmp, "queue.jsonl");
    const env = { KIRO_CLI_DB_PATH: dbPath, HOME: tmp };
    const oldTs = Date.now() - 200 * 24 * 3600 * 1000; // far past the 90d window
    const freshTs = Date.now() - 2 * 3600 * 1000;
    const conv = {
      model_info: { model_id: "claude-sonnet-4.5" },
      user_turn_metadata: {
        continuation_id: "conv-old",
        requests: [
          {
            request_id: "req-ancient",
            message_id: "msg-ancient",
            request_start_timestamp_ms: oldTs,
            user_prompt_length: 4000,
            response_size: 4000,
            model_id: "claude-sonnet-4.5",
          },
          {
            request_id: "req-fresh",
            message_id: "msg-fresh",
            request_start_timestamp_ms: freshTs,
            user_prompt_length: 400,
            response_size: 400,
            model_id: "claude-sonnet-4.5",
          },
        ],
      },
    };
    cp.execFileSync("sqlite3", [
      dbPath,
      "CREATE TABLE conversations_v2 (key TEXT, conversation_id TEXT, value TEXT, created_at INTEGER, updated_at INTEGER, PRIMARY KEY (key, conversation_id));",
    ]);
    cp.execFileSync("sqlite3", [
      dbPath,
      `INSERT INTO conversations_v2 VALUES ('proj', 'conv-old', '${JSON.stringify(conv).replace(/'/g, "''")}', 1, 2);`,
    ]);

    const cursors = { version: 1 };
    // First-ever parse: watermark starts at 0, so the full history (incl. the
    // 200-day-old request) is ingested exactly once.
    const r1 = await rolloutModule.parseKiroCliIncremental({ cursors, queuePath, env });
    assert.equal(r1.eventsAggregated, 2, "first parse ingests full history");
    assert.ok(
      !cursors.kiroCli.requests["req-ancient"],
      "ancient entry is age-pruned from cursor state",
    );
    assert.ok(cursors.kiroCli.requests["req-fresh"], "fresh entry retained");
    assert.ok(
      Number(cursors.kiroCli.watermarkMs) > oldTs,
      "prune watermark must clear the pruned request's ts",
    );

    const tokensInOldBucket = async () => {
      const rows = (await fs.readFile(queuePath, "utf8"))
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
      const latest = new Map();
      for (const row of rows) latest.set(`${row.source}|${row.model}|${row.hour_start}`, row);
      let total = 0;
      for (const row of latest.values()) {
        if (row.source === "kiro" && Date.parse(row.hour_start) < Date.now() - 100 * 24 * 3600 * 1000) {
          total += row.total_tokens || 0;
        }
      }
      return total;
    };
    const afterFirst = await tokensInOldBucket();
    assert.equal(afterFirst, 2000, "old bucket counted once (4000+4000 chars / 4)");

    // Re-run twice against the unchanged DB: the pruned ancient request must
    // NOT be re-added (pre-fix it re-added 2000 tokens per run, forever).
    const r2 = await rolloutModule.parseKiroCliIncremental({ cursors, queuePath, env });
    assert.equal(r2.eventsAggregated, 0, "second run must not re-add the pruned request");
    const r3 = await rolloutModule.parseKiroCliIncremental({ cursors, queuePath, env });
    assert.equal(r3.eventsAggregated, 0, "third run must not re-add either");
    assert.equal(await tokensInOldBucket(), 2000, "old bucket total is stable across syncs");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});


// ─── oh-my-pi (omp) helpers ───

function buildOmpSessionHeader() {
  return JSON.stringify({ type: "session", id: "session-1", timestamp: new Date().toISOString() });
}

function buildOmpAssistantLine({ id, model, input, output, cacheRead = 0, cacheWrite = 0, timestamp, reasoningTokens = 0, totalTokens }) {
  const usage = {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoningTokens,
  };
  if (typeof totalTokens === "number") {
    usage.totalTokens = totalTokens;
  }
  return JSON.stringify({
    type: "message",
    id,
    parentId: "parent-1",
    timestamp: new Date(timestamp).toISOString(),
    message: {
      role: "assistant",
      provider: "anthropic",
      model,
      usage,
      timestamp: Date.parse(new Date(timestamp).toISOString()),
    },
  });
}

// ─── oh-my-pi (omp) tests ───

test("parseOmpIncremental parses a single session and queues correct 30-min bucket", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-omp-"));
  try {
    const sessionsDir = path.join(tmp, "sessions", "--test--");
    await fs.mkdir(sessionsDir, { recursive: true });
    const filePath = path.join(sessionsDir, "session.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const ts = Date.UTC(2026, 3, 5, 14, 10, 0);
    const lines = [
      buildOmpSessionHeader(),
      buildOmpAssistantLine({ id: "msg-1", model: "claude-sonnet-4-5", input: 100, output: 20, cacheRead: 0, cacheWrite: 0, timestamp: ts, totalTokens: 120 }),
    ];
    await fs.writeFile(filePath, lines.join("\n") + "\n", "utf8");

    const res = await parseOmpIncremental({ sessionFiles: [filePath], cursors, queuePath });
    assert.equal(res.eventsAggregated, 1);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].source, "omp");
    assert.equal(queued[0].model, "claude-sonnet-4-5");
    assert.equal(queued[0].input_tokens, 100);
    assert.equal(queued[0].output_tokens, 20);
    assert.equal(queued[0].total_tokens, 120);
    assert.equal(queued[0].hour_start, "2026-04-05T14:00:00.000Z");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseOmpIncremental dedupes by entry id across two runs", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-omp-"));
  try {
    const sessionsDir = path.join(tmp, "sessions", "--test--");
    await fs.mkdir(sessionsDir, { recursive: true });
    const filePath = path.join(sessionsDir, "session.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const ts1 = Date.UTC(2026, 3, 5, 14, 0, 0);
    const ts2 = Date.UTC(2026, 3, 5, 14, 35, 0);
    const lines = [
      buildOmpSessionHeader(),
      buildOmpAssistantLine({ id: "aaaaaaaa", model: "claude-sonnet-4-5", input: 10, output: 10, timestamp: ts1, totalTokens: 20 }),
      buildOmpAssistantLine({ id: "bbbbbbbb", model: "claude-sonnet-4-5", input: 20, output: 20, timestamp: ts2, totalTokens: 40 }),
      buildOmpAssistantLine({ id: "aaaaaaaa", model: "claude-sonnet-4-5", input: 10, output: 10, timestamp: ts1, totalTokens: 20 }),
    ];
    await fs.writeFile(filePath, lines.join("\n") + "\n", "utf8");

    const res1 = await parseOmpIncremental({ sessionFiles: [filePath], cursors, queuePath });
    assert.equal(res1.eventsAggregated, 2);
    assert.ok(cursors.omp.seenIds.includes("aaaaaaaa"));
    assert.ok(cursors.omp.seenIds.includes("bbbbbbbb"));

    const queued1 = await readJsonLines(queuePath);
    assert.equal(queued1.length, 2);

    const res2 = await parseOmpIncremental({ sessionFiles: [filePath], cursors, queuePath });
    assert.equal(res2.eventsAggregated, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseOmpIncremental skips entries without usage field", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-omp-"));
  try {
    const sessionsDir = path.join(tmp, "sessions", "--test--");
    await fs.mkdir(sessionsDir, { recursive: true });
    const filePath = path.join(sessionsDir, "session.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const lines = [
      buildOmpSessionHeader(),
      JSON.stringify({
        type: "message",
        id: "msg-1",
        timestamp: new Date().toISOString(),
        message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-4-5" },
      }),
    ];
    await fs.writeFile(filePath, lines.join("\n") + "\n", "utf8");

    const res = await parseOmpIncremental({ sessionFiles: [filePath], cursors, queuePath });
    assert.equal(res.eventsAggregated, 0);
    assert.equal(res.bucketsQueued, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseOmpIncremental skips entries where message.role !== 'assistant'", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-omp-"));
  try {
    const sessionsDir = path.join(tmp, "sessions", "--test--");
    await fs.mkdir(sessionsDir, { recursive: true });
    const filePath = path.join(sessionsDir, "session.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const lines = [
      buildOmpSessionHeader(),
      JSON.stringify({
        type: "message",
        id: "msg-1",
        timestamp: new Date().toISOString(),
        message: { role: "user", provider: "anthropic", model: "claude-sonnet-4-5", usage: { input: 10, output: 5, totalTokens: 15 } },
      }),
    ];
    await fs.writeFile(filePath, lines.join("\n") + "\n", "utf8");

    const res = await parseOmpIncremental({ sessionFiles: [filePath], cursors, queuePath });
    assert.equal(res.eventsAggregated, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseOmpIncremental handles file with no assistant messages (zero queued)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-omp-"));
  try {
    const sessionsDir = path.join(tmp, "sessions", "--test--");
    await fs.mkdir(sessionsDir, { recursive: true });
    const filePath = path.join(sessionsDir, "session.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    await fs.writeFile(filePath, buildOmpSessionHeader() + "\n", "utf8");

    const res = await parseOmpIncremental({ sessionFiles: [filePath], cursors, queuePath });
    assert.equal(res.recordsProcessed, 0);
    assert.equal(res.eventsAggregated, 0);
    assert.equal(res.bucketsQueued, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("resolveOmpSessionFiles returns empty when ~/.omp/agent/sessions missing", async () => {
  const result = resolveOmpSessionFiles({ OMP_HOME: path.join(os.tmpdir(), "no-such-omp-dir") });
  assert.deepEqual(result, []);
});

test("OMP_HOME env override redirects discovery", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-omp-"));
  try {
    const sessionsDir = path.join(tmp, "agent", "sessions", "--myproject--");
    await fs.mkdir(sessionsDir, { recursive: true });
    const filePath = path.join(sessionsDir, "session.jsonl");
    await fs.writeFile(filePath, buildOmpSessionHeader() + "\n", "utf8");

    const result = resolveOmpSessionFiles({ OMP_HOME: tmp });
    assert.equal(result.length, 1);
    assert.ok(result[0].endsWith(".jsonl"));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseOmpIncremental computes totalTokens fallback when usage.totalTokens missing", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-omp-"));
  try {
    const sessionsDir = path.join(tmp, "sessions", "--test--");
    await fs.mkdir(sessionsDir, { recursive: true });
    const filePath = path.join(sessionsDir, "session.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const ts = Date.UTC(2026, 3, 5, 14, 10, 0);
    const lines = [
      buildOmpSessionHeader(),
      buildOmpAssistantLine({ id: "msg-1", model: "claude-sonnet-4-5", input: 50, output: 30, cacheRead: 10, cacheWrite: 5, reasoningTokens: 3, timestamp: ts }),
    ];
    await fs.writeFile(filePath, lines.join("\n") + "\n", "utf8");

    const res = await parseOmpIncremental({ sessionFiles: [filePath], cursors, queuePath });
    assert.equal(res.eventsAggregated, 1);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].total_tokens, 98);
    assert.equal(queued[0].cached_input_tokens, 10);
    assert.equal(queued[0].cache_creation_input_tokens, 5);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseOmpIncremental counts pure-reasoning rows (only reasoningTokens > 0)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-omp-"));
  try {
    const sessionsDir = path.join(tmp, "sessions", "--test--");
    await fs.mkdir(sessionsDir, { recursive: true });
    const filePath = path.join(sessionsDir, "session.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const ts = Date.UTC(2026, 3, 5, 14, 10, 0);
    const lines = [
      buildOmpSessionHeader(),
      buildOmpAssistantLine({ id: "msg-1", model: "claude-sonnet-4-5", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 42, timestamp: ts }),
    ];
    await fs.writeFile(filePath, lines.join("\n") + "\n", "utf8");

    const res = await parseOmpIncremental({ sessionFiles: [filePath], cursors, queuePath });
    assert.equal(res.eventsAggregated, 1);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].source, "omp");
    assert.equal(queued[0].reasoning_output_tokens, 42);
    assert.equal(queued[0].total_tokens, 42);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("resolveOmpSubagentFiles discovers nested subagent jsonl and skips main files and non-jsonl artefacts", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-omp-"));
  try {
    const cwdDir = path.join(tmp, "agent", "sessions", "--myproject--");
    const sessionDir = path.join(cwdDir, "2026-04-05T14-00-00-000Z_session-1");
    const deepDir = path.join(sessionDir, "smol-review");
    await fs.mkdir(deepDir, { recursive: true });

    // Main session file — must NOT be returned by the subagent resolver.
    await fs.writeFile(path.join(cwdDir, "2026-04-05T14-00-00-000Z_session-1.jsonl"), buildOmpSessionHeader() + "\n", "utf8");
    // Subagent transcript + non-JSONL session artefacts.
    await fs.writeFile(path.join(sessionDir, "AgentA.jsonl"), buildOmpSessionHeader() + "\n", "utf8");
    await fs.writeFile(path.join(sessionDir, "12.bash-original.log"), "log\n", "utf8");
    await fs.writeFile(path.join(sessionDir, "notes.md"), "notes\n", "utf8");
    // Advisor transcript nested one level deeper inside the session dir.
    await fs.writeFile(path.join(deepDir, "smol-review.AdvisorReview.jsonl"), buildOmpSessionHeader() + "\n", "utf8");

    const result = resolveOmpSubagentFiles({ OMP_HOME: tmp });
    assert.deepEqual(result, [
      path.join(sessionDir, "AgentA.jsonl"),
      path.join(deepDir, "smol-review.AdvisorReview.jsonl"),
    ]);

    // Main resolver stays main-only: exactly the one top-level session file.
    const mainResult = resolveOmpSessionFiles({ OMP_HOME: tmp });
    assert.equal(mainResult.length, 1);
    assert.ok(mainResult[0].endsWith("session-1.jsonl"));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseOmpIncremental counts subagent files toward the same omp bucket", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-omp-"));
  try {
    const cwdDir = path.join(tmp, "sessions", "--test--");
    const sessionDir = path.join(cwdDir, "session-1");
    await fs.mkdir(sessionDir, { recursive: true });
    const mainPath = path.join(cwdDir, "session-1.jsonl");
    const subPath = path.join(sessionDir, "AgentA.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const ts = Date.UTC(2026, 3, 5, 14, 10, 0);
    await fs.writeFile(mainPath, [
      buildOmpSessionHeader(),
      buildOmpAssistantLine({ id: "msg-1", model: "claude-sonnet-4-5", input: 100, output: 20, timestamp: ts, totalTokens: 120 }),
    ].join("\n") + "\n", "utf8");
    await fs.writeFile(subPath, [
      buildOmpSessionHeader(),
      buildOmpAssistantLine({ id: "msg-2", model: "claude-sonnet-4-5", input: 200, output: 40, timestamp: ts, totalTokens: 240 }),
    ].join("\n") + "\n", "utf8");

    const res = await parseOmpIncremental({ sessionFiles: [mainPath], subagentFiles: [subPath], cursors, queuePath });
    assert.equal(res.eventsAggregated, 2);

    // Same source + model + half-hour → one merged bucket (main + subagent).
    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].source, "omp");
    assert.equal(queued[0].model, "claude-sonnet-4-5");
    assert.equal(queued[0].input_tokens, 300);
    assert.equal(queued[0].output_tokens, 60);
    assert.equal(queued[0].total_tokens, 360);
    assert.equal(queued[0].hour_start, "2026-04-05T14:00:00.000Z");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseOmpIncremental dedupes subagent entries across two runs", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-omp-"));
  try {
    const cwdDir = path.join(tmp, "sessions", "--test--");
    const sessionDir = path.join(cwdDir, "session-1");
    await fs.mkdir(sessionDir, { recursive: true });
    const subPath = path.join(sessionDir, "AgentA.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const ts = Date.UTC(2026, 3, 5, 14, 10, 0);
    await fs.writeFile(subPath, [
      buildOmpSessionHeader(),
      buildOmpAssistantLine({ id: "msg-1", model: "claude-sonnet-4-5", input: 10, output: 5, timestamp: ts, totalTokens: 15 }),
    ].join("\n") + "\n", "utf8");

    const res1 = await parseOmpIncremental({ sessionFiles: [], subagentFiles: [subPath], cursors, queuePath });
    assert.equal(res1.eventsAggregated, 1);

    const res2 = await parseOmpIncremental({ sessionFiles: [], subagentFiles: [subPath], cursors, queuePath });
    assert.equal(res2.eventsAggregated, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// ─── pi (@mariozechner/pi-coding-agent) tests — same on-disk format as omp ───

test("parsePiIncremental parses a single session and queues with source 'pi'", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-pi-"));
  try {
    const sessionsDir = path.join(tmp, "sessions", "--test--");
    await fs.mkdir(sessionsDir, { recursive: true });
    const filePath = path.join(sessionsDir, "session.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const ts = Date.UTC(2026, 3, 5, 14, 10, 0);
    const lines = [
      buildOmpSessionHeader(),
      buildOmpAssistantLine({ id: "msg-1", model: "mimo-v2.5-pro", input: 100, output: 20, cacheRead: 0, cacheWrite: 0, timestamp: ts, totalTokens: 120 }),
    ];
    await fs.writeFile(filePath, lines.join("\n") + "\n", "utf8");

    const res = await parsePiIncremental({ sessionFiles: [filePath], cursors, queuePath });
    assert.equal(res.eventsAggregated, 1);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].source, "pi");
    assert.equal(queued[0].model, "mimo-v2.5-pro");
    assert.equal(queued[0].input_tokens, 100);
    assert.equal(queued[0].output_tokens, 20);
    assert.equal(queued[0].total_tokens, 120);
    assert.equal(queued[0].hour_start, "2026-04-05T14:00:00.000Z");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parsePiIncremental dedupes by entry id across two runs (state under cursors.pi)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-pi-"));
  try {
    const sessionsDir = path.join(tmp, "sessions", "--test--");
    await fs.mkdir(sessionsDir, { recursive: true });
    const filePath = path.join(sessionsDir, "session.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const ts1 = Date.UTC(2026, 3, 5, 14, 0, 0);
    const ts2 = Date.UTC(2026, 3, 5, 14, 35, 0);
    const lines = [
      buildOmpSessionHeader(),
      buildOmpAssistantLine({ id: "aaaaaaaa", model: "mimo-v2.5-pro", input: 10, output: 10, timestamp: ts1, totalTokens: 20 }),
      buildOmpAssistantLine({ id: "bbbbbbbb", model: "mimo-v2.5-pro", input: 20, output: 20, timestamp: ts2, totalTokens: 40 }),
      buildOmpAssistantLine({ id: "aaaaaaaa", model: "mimo-v2.5-pro", input: 10, output: 10, timestamp: ts1, totalTokens: 20 }),
    ];
    await fs.writeFile(filePath, lines.join("\n") + "\n", "utf8");

    const res1 = await parsePiIncremental({ sessionFiles: [filePath], cursors, queuePath });
    assert.equal(res1.eventsAggregated, 2);
    assert.ok(cursors.pi.seenIds.includes("aaaaaaaa"));
    assert.ok(cursors.pi.seenIds.includes("bbbbbbbb"));

    const res2 = await parsePiIncremental({ sessionFiles: [filePath], cursors, queuePath });
    assert.equal(res2.eventsAggregated, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parsePiIncremental counts pure-reasoning rows (only reasoningTokens > 0)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-pi-"));
  try {
    const sessionsDir = path.join(tmp, "sessions", "--test--");
    await fs.mkdir(sessionsDir, { recursive: true });
    const filePath = path.join(sessionsDir, "session.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const ts = Date.UTC(2026, 3, 5, 14, 10, 0);
    const lines = [
      buildOmpSessionHeader(),
      buildOmpAssistantLine({ id: "msg-1", model: "mimo-v2.5-pro", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 7, timestamp: ts }),
    ];
    await fs.writeFile(filePath, lines.join("\n") + "\n", "utf8");

    const res = await parsePiIncremental({ sessionFiles: [filePath], cursors, queuePath });
    assert.equal(res.eventsAggregated, 1);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].source, "pi");
    assert.equal(queued[0].reasoning_output_tokens, 7);
    assert.equal(queued[0].total_tokens, 7);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("resolvePiSessionFiles returns empty when ~/.pi/agent/sessions missing", async () => {
  const result = resolvePiSessionFiles({ HOME: path.join(os.tmpdir(), "no-such-pi-home") });
  assert.deepEqual(result, []);
});

// PI_CODING_AGENT_DIR is documented by both pi-coding-agent and oh-my-pi.
// Routing is decided by the install-signal disambiguator: ~/.pi present → pi,
// otherwise omp (back-compat).

test("PI_CODING_AGENT_DIR redirects pi discovery when ~/.pi install signal exists", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tt-pi-home-"));
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-pi-"));
  try {
    await fs.mkdir(path.join(home, ".pi"), { recursive: true });
    const sessionsDir = path.join(tmp, "sessions", "--myproject--");
    await fs.mkdir(sessionsDir, { recursive: true });
    const filePath = path.join(sessionsDir, "session.jsonl");
    await fs.writeFile(filePath, buildOmpSessionHeader() + "\n", "utf8");

    const result = resolvePiSessionFiles({ HOME: home, PI_CODING_AGENT_DIR: tmp });
    assert.equal(result.length, 1);
    assert.ok(result[0].endsWith(".jsonl"));
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("PI_CODING_AGENT_DIR redirects omp discovery when no ~/.pi install signal exists", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tt-omp-home-"));
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-omp-"));
  try {
    const sessionsDir = path.join(tmp, "sessions", "--myproject--");
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(path.join(sessionsDir, "session.jsonl"), buildOmpSessionHeader() + "\n", "utf8");

    const ompResult = resolveOmpSessionFiles({ HOME: home, PI_CODING_AGENT_DIR: tmp });
    assert.equal(ompResult.length, 1);
    assert.ok(ompResult[0].endsWith(".jsonl"));
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("PI_CODING_AGENT_DIR is owned by pi when ~/.pi exists; omp falls back to default", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tt-both-home-"));
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-shared-"));
  try {
    await fs.mkdir(path.join(home, ".pi"), { recursive: true });
    const sessionsDir = path.join(tmp, "sessions", "--proj--");
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(path.join(sessionsDir, "session.jsonl"), buildOmpSessionHeader() + "\n", "utf8");

    const piResult = resolvePiSessionFiles({ HOME: home, PI_CODING_AGENT_DIR: tmp });
    const ompResult = resolveOmpSessionFiles({ HOME: home, PI_CODING_AGENT_DIR: tmp });
    assert.equal(piResult.length, 1);
    assert.deepEqual(ompResult, []);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("TOKENTRACKER_PI_AGENT_DIR overrides PI_CODING_AGENT_DIR and the default for pi", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tt-pi-tt-home-"));
  const ttPiTmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-pi-explicit-"));
  const sharedTmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-pi-shared-"));
  try {
    const sessionsDir = path.join(ttPiTmp, "sessions", "--proj--");
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(path.join(sessionsDir, "session.jsonl"), buildOmpSessionHeader() + "\n", "utf8");

    const result = resolvePiSessionFiles({
      HOME: home,
      PI_CODING_AGENT_DIR: sharedTmp,
      TOKENTRACKER_PI_AGENT_DIR: ttPiTmp,
    });
    assert.equal(result.length, 1);
    assert.ok(result[0].startsWith(ttPiTmp));
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(ttPiTmp, { recursive: true, force: true });
    await fs.rm(sharedTmp, { recursive: true, force: true });
  }
});

test("TOKENTRACKER_PI_AGENT_DIR expands a bare '~' to HOME", () => {
  const home = "/tmp/tt-tilde-home";
  const dir = resolvePiAgentDir({ HOME: home, TOKENTRACKER_PI_AGENT_DIR: "~" });
  assert.equal(dir, home);
  const sub = resolvePiAgentDir({ HOME: home, TOKENTRACKER_PI_AGENT_DIR: "~/relocated" });
  assert.equal(sub, path.join(home, "relocated"));
});

test("decidePiCodingAgentDirOwner ignores a stray FILE at ~/.pi", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tt-stray-home-"));
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-stray-omp-"));
  try {
    await fs.writeFile(path.join(home, ".pi"), "not a dir", "utf8");
    const ompSessions = path.join(tmp, "sessions", "--proj--");
    await fs.mkdir(ompSessions, { recursive: true });
    await fs.writeFile(path.join(ompSessions, "session.jsonl"), buildOmpSessionHeader() + "\n", "utf8");

    const ompResult = resolveOmpSessionFiles({ HOME: home, PI_CODING_AGENT_DIR: tmp });
    assert.equal(ompResult.length, 1, "stray file at ~/.pi must not steal PI_CODING_AGENT_DIR from omp");
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("piAgentDirCollidesWithOmp detects shared explicit overrides", () => {
  const home = "/tmp/tt-collision-home";
  const shared = "/tmp/tt-shared";
  assert.equal(
    piAgentDirCollidesWithOmp({
      HOME: home,
      TOKENTRACKER_OMP_AGENT_DIR: shared,
      TOKENTRACKER_PI_AGENT_DIR: shared,
    }),
    true,
  );
  assert.equal(
    piAgentDirCollidesWithOmp({ HOME: home }),
    false,
  );
});

test("TOKENTRACKER_OMP_AGENT_DIR forces omp ownership even when ~/.pi exists", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tt-force-home-"));
  const ompTmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-omp-explicit-"));
  const sharedTmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-shared-explicit-"));
  try {
    await fs.mkdir(path.join(home, ".pi"), { recursive: true });
    const ompSessions = path.join(ompTmp, "sessions", "--proj--");
    await fs.mkdir(ompSessions, { recursive: true });
    await fs.writeFile(path.join(ompSessions, "session.jsonl"), buildOmpSessionHeader() + "\n", "utf8");
    const sharedSessions = path.join(sharedTmp, "sessions", "--proj--");
    await fs.mkdir(sharedSessions, { recursive: true });
    await fs.writeFile(path.join(sharedSessions, "session.jsonl"), buildOmpSessionHeader() + "\n", "utf8");

    const ompResult = resolveOmpSessionFiles({
      HOME: home,
      PI_CODING_AGENT_DIR: sharedTmp,
      TOKENTRACKER_OMP_AGENT_DIR: ompTmp,
    });
    const piResult = resolvePiSessionFiles({
      HOME: home,
      PI_CODING_AGENT_DIR: sharedTmp,
      TOKENTRACKER_OMP_AGENT_DIR: ompTmp,
    });
    assert.equal(ompResult.length, 1);
    assert.ok(ompResult[0].startsWith(ompTmp));
    assert.equal(piResult.length, 1);
    assert.ok(piResult[0].startsWith(sharedTmp));
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(ompTmp, { recursive: true, force: true });
    await fs.rm(sharedTmp, { recursive: true, force: true });
  }
});

// ─── Craft Agents helpers ───

function buildCraftSessionHeader({
  id = "260430-swift-river",
  model = "claude-sonnet-4-6",
  llmConnection = "anthropic-default",
  inputTokens,
  outputTokens,
  cacheReadTokens = 0,
  cacheCreationTokens = 0,
  totalTokens,
  lastMessageAt,
} = {}) {
  return JSON.stringify({
    id,
    sdkSessionId: `sdk-${id}`,
    workspaceRootPath: "/tmp/ws",
    createdAt: lastMessageAt - 60_000,
    lastUsedAt: lastMessageAt,
    lastMessageAt,
    model,
    llmConnection,
    messageCount: 4,
    tokenUsage: {
      inputTokens,
      outputTokens,
      totalTokens:
        typeof totalTokens === "number"
          ? totalTokens
          : inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens,
      contextTokens: 8400,
      costUsd: 0.04,
      cacheReadTokens,
      cacheCreationTokens,
      contextWindow: 200000,
    },
  });
}

async function writeCraftSession({ rootPath, sessionId, headerOpts, extraLines = [] }) {
  const dir = path.join(rootPath, "sessions", sessionId);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, "session.jsonl");
  const lines = [buildCraftSessionHeader({ id: sessionId, ...headerOpts }), ...extraLines];
  await fs.writeFile(filePath, lines.join("\n") + "\n", "utf8");
  return filePath;
}

// ─── Craft Agents tests ───

test("parseCraftIncremental parses a single session header into a 30-min bucket", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-craft-"));
  try {
    const rootPath = path.join(tmp, "ws");
    const ts = Date.UTC(2026, 3, 5, 14, 10, 0);
    const filePath = await writeCraftSession({
      rootPath,
      sessionId: "260405-swift-river",
      headerOpts: {
        model: "claude-sonnet-4-6",
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 5500,
        cacheCreationTokens: 1100,
        lastMessageAt: ts,
      },
    });
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const res = await parseCraftIncremental({ sessionFiles: [filePath], cursors, queuePath });
    assert.equal(res.eventsAggregated, 1);
    assert.equal(res.bucketsQueued, 1);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].source, "craft");
    assert.equal(queued[0].model, "claude-sonnet-4-6");
    assert.equal(queued[0].input_tokens, 1000);
    assert.equal(queued[0].output_tokens, 200);
    assert.equal(queued[0].cached_input_tokens, 5500);
    assert.equal(queued[0].cache_creation_input_tokens, 1100);
    assert.equal(queued[0].total_tokens, 7800);
    assert.equal(queued[0].hour_start, "2026-04-05T14:00:00.000Z");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseCraftIncremental aggregates growing snapshots into the same bucket without double-counting", async () => {
  // Validates the delta path: each sync only contributes the *new* tokens
  // since the prior snapshot, but the bucket retains a cumulative running
  // total via enqueueTouchedBuckets' replace semantics.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-craft-"));
  try {
    const rootPath = path.join(tmp, "ws");
    const sessionId = "260405-grow-delta";
    const ts = Date.UTC(2026, 3, 5, 14, 10, 0);
    const dir = path.join(rootPath, "sessions", sessionId);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "session.jsonl");

    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    // First snapshot: 100/20 input/output
    await fs.writeFile(
      filePath,
      buildCraftSessionHeader({
        id: sessionId,
        inputTokens: 100,
        outputTokens: 20,
        lastMessageAt: ts,
      }) + "\n",
      "utf8",
    );
    let res = await parseCraftIncremental({ sessionFiles: [filePath], cursors, queuePath });
    assert.equal(res.eventsAggregated, 1);
    // After first sync: cursor remembers 100/20 as previous totals.
    assert.equal(cursors.craft.sessionTotals[sessionId].input, 100);
    assert.equal(cursors.craft.sessionTotals[sessionId].output, 20);

    // Second snapshot — header rewritten with growing totals (300/60)
    await fs.writeFile(
      filePath,
      buildCraftSessionHeader({
        id: sessionId,
        inputTokens: 300,
        outputTokens: 60,
        lastMessageAt: ts,
      }) + "\n",
      "utf8",
    );
    res = await parseCraftIncremental({ sessionFiles: [filePath], cursors, queuePath });
    assert.equal(res.eventsAggregated, 1);
    // After second sync: cursor advanced to the new cumulative total.
    assert.equal(cursors.craft.sessionTotals[sessionId].input, 300);
    assert.equal(cursors.craft.sessionTotals[sessionId].output, 60);

    const queued = await readJsonLines(queuePath);
    // Bucket cumulative total reflects the running sum (300/60), proving the
    // delta-of-200/40 added to the prior 100/20 in-memory bucket — not a
    // re-emission of the full cumulative (which would have double-counted to 400/80).
    const bucket = queued[queued.length - 1];
    assert.equal(bucket.input_tokens, 300);
    assert.equal(bucket.output_tokens, 60);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseCraftIncremental routes growth into a new hour bucket when lastMessageAt advances", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-craft-"));
  try {
    const rootPath = path.join(tmp, "ws");
    const sessionId = "260405-cross-hour";
    const tsBucket1 = Date.UTC(2026, 3, 5, 14, 10, 0);
    const tsBucket2 = Date.UTC(2026, 3, 5, 15, 5, 0); // next 30-min slot
    const dir = path.join(rootPath, "sessions", sessionId);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "session.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    // Bucket 1 sync: 100/20
    await fs.writeFile(
      filePath,
      buildCraftSessionHeader({
        id: sessionId,
        inputTokens: 100,
        outputTokens: 20,
        lastMessageAt: tsBucket1,
      }) + "\n",
      "utf8",
    );
    await parseCraftIncremental({ sessionFiles: [filePath], cursors, queuePath });

    // Bucket 2 sync: header now reports cumulative 250/45 (delta 150/25 in new hour)
    await fs.writeFile(
      filePath,
      buildCraftSessionHeader({
        id: sessionId,
        inputTokens: 250,
        outputTokens: 45,
        lastMessageAt: tsBucket2,
      }) + "\n",
      "utf8",
    );
    await parseCraftIncremental({ sessionFiles: [filePath], cursors, queuePath });

    const queued = await readJsonLines(queuePath);
    const byHour = new Map();
    for (const row of queued) byHour.set(row.hour_start, row);
    const h1 = "2026-04-05T14:00:00.000Z";
    const h2 = "2026-04-05T15:00:00.000Z";
    assert.ok(byHour.has(h1), "first hour bucket queued");
    assert.ok(byHour.has(h2), "second hour bucket queued");
    // Bucket 1 keeps its original 100/20, bucket 2 carries only the delta 150/25.
    assert.equal(byHour.get(h1).input_tokens, 100);
    assert.equal(byHour.get(h1).output_tokens, 20);
    assert.equal(byHour.get(h2).input_tokens, 150);
    assert.equal(byHour.get(h2).output_tokens, 25);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseCraftIncremental cap evicts least-recently-seen sessions, not insertion order", async () => {
  // Pre-populate cursors with 5001 entries: one ancient long-lived session
  // (#0) with a high lastSeenAt set BELOW the rest, and 5000 newer one-shots
  // with later lastSeenAt. When we re-sync the ancient session, eviction
  // must drop the oldest of the newer one-shots, not the ancient session.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-craft-"));
  try {
    const rootPath = path.join(tmp, "ws");
    const ancientId = "session-ancient";
    const dir = path.join(rootPath, "sessions", ancientId);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "session.jsonl");
    const ts = Date.UTC(2026, 3, 5, 14, 10, 0);
    await fs.writeFile(
      filePath,
      buildCraftSessionHeader({
        id: ancientId,
        inputTokens: 1000,
        outputTokens: 200,
        lastMessageAt: ts,
      }) + "\n",
      "utf8",
    );
    const queuePath = path.join(tmp, "queue.jsonl");

    // Seed cursor: ancient at lastSeenAt=1000, plus 5000 newer entries
    // each with lastSeenAt 2000 + i. Ancient must NOT be evicted because
    // the new sync will refresh its lastSeenAt to a much larger value.
    const sessionTotals = {
      [ancientId]: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0, total: 600, lastSeenAt: 1000 },
    };
    for (let i = 0; i < 5000; i++) {
      sessionTotals[`other-${i}`] = {
        input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2,
        lastSeenAt: 2000 + i,
      };
    }
    const cursors = {
      version: 1, files: {}, updatedAt: null,
      craft: { sessionTotals, updatedAt: null },
    };

    await parseCraftIncremental({ sessionFiles: [filePath], cursors, queuePath });

    // After sync: ancient must still be in sessionTotals with the new total.
    const surviving = cursors.craft.sessionTotals;
    assert.ok(
      surviving[ancientId],
      "ancient long-lived session should not be evicted",
    );
    assert.equal(surviving[ancientId].input, 1000);
    assert.equal(Object.keys(surviving).length, 5000);
    // Concretely: the OLDEST of the 5000 one-shots (lastSeenAt=2000) is gone.
    assert.ok(!surviving["other-0"], "least-recently-seen one-shot should have been evicted");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseCraftIncremental dedups when the header has not changed across runs", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-craft-"));
  try {
    const rootPath = path.join(tmp, "ws");
    const ts = Date.UTC(2026, 3, 5, 14, 10, 0);
    const filePath = await writeCraftSession({
      rootPath,
      sessionId: "260405-stable",
      headerOpts: { inputTokens: 50, outputTokens: 10, lastMessageAt: ts },
    });
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const res1 = await parseCraftIncremental({ sessionFiles: [filePath], cursors, queuePath });
    assert.equal(res1.eventsAggregated, 1);

    const res2 = await parseCraftIncremental({ sessionFiles: [filePath], cursors, queuePath });
    assert.equal(res2.eventsAggregated, 0);
    assert.equal(res2.bucketsQueued, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseCraftIncremental skips entries with zero usage", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-craft-"));
  try {
    const rootPath = path.join(tmp, "ws");
    const filePath = await writeCraftSession({
      rootPath,
      sessionId: "260405-empty",
      headerOpts: { inputTokens: 0, outputTokens: 0, lastMessageAt: Date.now() },
    });
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const res = await parseCraftIncremental({ sessionFiles: [filePath], cursors, queuePath });
    assert.equal(res.eventsAggregated, 0);
    assert.equal(res.bucketsQueued, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("resolveCraftSessionFiles returns empty when ~/.craft-agent missing", async () => {
  const result = resolveCraftSessionFiles({
    HOME: path.join(os.tmpdir(), "no-such-craft-home"),
    CRAFT_CONFIG_DIR: path.join(os.tmpdir(), "no-such-craft-dir"),
  });
  assert.deepEqual(result, []);
});

test("CRAFT_CONFIG_DIR redirects discovery to default workspaces folder", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-craft-"));
  try {
    const wsDir = path.join(tmp, "workspaces", "ws-1");
    await fs.mkdir(path.join(wsDir, "sessions", "260405-foo"), { recursive: true });
    await fs.writeFile(
      path.join(wsDir, "sessions", "260405-foo", "session.jsonl"),
      buildCraftSessionHeader({ id: "260405-foo", inputTokens: 1, outputTokens: 1, lastMessageAt: Date.now() }) + "\n",
      "utf8",
    );

    const files = resolveCraftSessionFiles({ CRAFT_CONFIG_DIR: tmp });
    assert.equal(files.length, 1);
    assert.ok(files[0].endsWith("session.jsonl"));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("resolveCraftWorkspaceRoots layers user-relocated workspaces from config.json", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-craft-"));
  try {
    const externalRoot = path.join(tmp, "external", "ws");
    await fs.mkdir(externalRoot, { recursive: true });
    const configPath = path.join(tmp, "config.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({ workspaces: [{ rootPath: externalRoot }] }),
      "utf8",
    );
    const roots = resolveCraftWorkspaceRoots({ CRAFT_CONFIG_DIR: tmp });
    assert.ok(roots.includes(externalRoot));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseCraftIncremental falls back to craft-unknown model when header.model missing", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-craft-"));
  try {
    const rootPath = path.join(tmp, "ws");
    const dir = path.join(rootPath, "sessions", "260405-nomodel");
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "session.jsonl");
    await fs.writeFile(
      filePath,
      JSON.stringify({
        id: "260405-nomodel",
        lastMessageAt: Date.UTC(2026, 3, 5, 14, 10, 0),
        tokenUsage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
      }) + "\n",
      "utf8",
    );
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const res = await parseCraftIncremental({ sessionFiles: [filePath], cursors, queuePath });
    assert.equal(res.eventsAggregated, 1);
    const queued = await readJsonLines(queuePath);
    assert.equal(queued[0].model, "craft-unknown");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseGrokBuildIncremental appends cumulative buckets across sessions", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-grok-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const writeSession = async ({ sessionId, totalTokens, assistantMessageCount }) => {
      const sessionDir = path.join(tmp, "sessions", "encoded-cwd", sessionId);
      await fs.mkdir(sessionDir, { recursive: true });
      const signalsPath = path.join(sessionDir, "signals.json");
      await fs.writeFile(
        signalsPath,
        JSON.stringify({
          contextTokensUsed: totalTokens,
          assistantMessageCount,
          primaryModelId: "grok-build",
          lastActiveAt: "2026-04-05T14:10:00.000Z",
        }),
        "utf8",
      );
      return {
        sessionDir,
        signalsPath,
        summaryPath: path.join(sessionDir, "summary.json"),
        sessionId,
      };
    };

    const first = await writeSession({
      sessionId: "grok-session-a",
      totalTokens: 10,
      assistantMessageCount: 2,
    });
    const second = await writeSession({
      sessionId: "grok-session-b",
      totalTokens: 20,
      assistantMessageCount: 3,
    });

    const firstRun = await parseGrokBuildIncremental({
      sessions: [first],
      cursors,
      queuePath,
    });
    assert.equal(firstRun.eventsAggregated, 1);
    assert.equal(firstRun.bucketsQueued, 1);

    const secondRun = await parseGrokBuildIncremental({
      sessions: [first, second],
      cursors,
      queuePath,
    });
    assert.equal(secondRun.eventsAggregated, 1);
    assert.equal(secondRun.bucketsQueued, 1);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 2);
    assert.equal(queued[1].source, "grok");
    assert.equal(queued[1].model, "grok-build");
    assert.equal(queued[1].hour_start, "2026-04-05T14:00:00.000Z");
    assert.equal(queued[1].total_tokens, 30);
    assert.equal(queued[1].input_tokens, 24);
    assert.equal(queued[1].output_tokens, 6);
    assert.equal(queued[1].conversation_count, 5);

    const thirdRun = await parseGrokBuildIncremental({
      sessions: [first, second],
      cursors,
      queuePath,
    });
    assert.equal(thirdRun.eventsAggregated, 0);
    assert.equal(thirdRun.bucketsQueued, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseGrokBuildIncremental queues deltas for later snapshots of the same session", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-grok-delta-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };
    const sessionDir = path.join(tmp, "sessions", "encoded-cwd", "grok-session-long");
    await fs.mkdir(sessionDir, { recursive: true });
    const signalsPath = path.join(sessionDir, "signals.json");
    const session = {
      sessionDir,
      signalsPath,
      summaryPath: path.join(sessionDir, "summary.json"),
      sessionId: "grok-session-long",
    };

    await fs.writeFile(
      signalsPath,
      JSON.stringify({
        contextTokensUsed: 10_000,
        assistantMessageCount: 3,
        primaryModelId: "grok-build",
        lastActiveAt: "2026-04-05T14:10:00.000Z",
      }),
      "utf8",
    );
    const firstRun = await parseGrokBuildIncremental({ sessions: [session], cursors, queuePath });
    assert.equal(firstRun.eventsAggregated, 1);

    await fs.writeFile(
      signalsPath,
      JSON.stringify({
        contextTokensUsed: 50_000,
        assistantMessageCount: 8,
        primaryModelId: "grok-build",
        lastActiveAt: "2026-04-05T14:20:00.000Z",
      }),
      "utf8",
    );
    const secondRun = await parseGrokBuildIncremental({ sessions: [session], cursors, queuePath });
    assert.equal(secondRun.eventsAggregated, 1);
    assert.equal(secondRun.bucketsQueued, 1);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 2);
    assert.equal(queued[0].total_tokens, 10_000);
    assert.equal(queued[1].total_tokens, 50_000);
    assert.equal(queued[1].input_tokens, 40_000);
    assert.equal(queued[1].output_tokens, 10_000);
    assert.equal(queued[1].conversation_count, 8);
    assert.equal(cursors.grok.sessionSnapshots["grok-session-long"].totalTokens, 50_000);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseGrokBuildIncremental buckets Grok sessions by UTC half hour", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-grok-halfhour-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const writeSession = async ({ sessionId, totalTokens, lastActiveAt }) => {
      const sessionDir = path.join(tmp, "sessions", "encoded-cwd", sessionId);
      await fs.mkdir(sessionDir, { recursive: true });
      const signalsPath = path.join(sessionDir, "signals.json");
      await fs.writeFile(
        signalsPath,
        JSON.stringify({
          contextTokensUsed: totalTokens,
          assistantMessageCount: 1,
          primaryModelId: "grok-build",
          lastActiveAt,
        }),
        "utf8",
      );
      return {
        sessionDir,
        signalsPath,
        summaryPath: path.join(sessionDir, "summary.json"),
        sessionId,
      };
    };

    const early = await writeSession({
      sessionId: "grok-session-early",
      totalTokens: 10,
      lastActiveAt: "2026-04-05T14:10:00.000Z",
    });
    const late = await writeSession({
      sessionId: "grok-session-late",
      totalTokens: 20,
      lastActiveAt: "2026-04-05T14:45:00.000Z",
    });

    const result = await parseGrokBuildIncremental({
      sessions: [early, late],
      cursors,
      queuePath,
    });
    assert.equal(result.eventsAggregated, 2);
    assert.equal(result.bucketsQueued, 2);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 2);
    assert.equal(queued[0].hour_start, "2026-04-05T14:00:00.000Z");
    assert.equal(queued[1].hour_start, "2026-04-05T14:30:00.000Z");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseGrokBuildIncremental reads Grok updates metadata by event timestamp", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-grok-updates-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };
    const sessionDir = path.join(tmp, "sessions", "encoded-cwd", "grok-session-updates");
    await fs.mkdir(sessionDir, { recursive: true });
    const signalsPath = path.join(sessionDir, "signals.json");
    const updatesPath = path.join(sessionDir, "updates.jsonl");
    await fs.writeFile(
      signalsPath,
      JSON.stringify({
        contextTokensUsed: 90,
        assistantMessageCount: 2,
        primaryModelId: "grok-build",
        lastActiveAt: "2026-04-05T14:50:00.000Z",
      }),
      "utf8",
    );
    await fs.writeFile(
      updatesPath,
      [
        JSON.stringify({
          method: "session/update",
          timestamp: 1775397900,
          params: { _meta: { totalTokens: 100, agentTimestampMs: Date.parse("2026-04-05T14:05:00.000Z"), eventId: "evt-1" } },
        }),
        JSON.stringify({
          method: "session/update",
          params: { _meta: { totalTokens: 100, agentTimestampMs: Date.parse("2026-04-05T14:06:00.000Z"), eventId: "evt-repeat" } },
        }),
        JSON.stringify({
          method: "session/update",
          params: { _meta: { totalTokens: 80, agentTimestampMs: Date.parse("2026-04-05T14:07:00.000Z"), eventId: "evt-drop" } },
        }),
        JSON.stringify({
          method: "session/update",
          params: { _meta: { totalTokens: 250, agentTimestampMs: Date.parse("2026-04-05T14:35:00.000Z"), eventId: "evt-2" } },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const result = await parseGrokBuildIncremental({
      sessions: [{ sessionDir, updatesPath, signalsPath, summaryPath: path.join(sessionDir, "summary.json"), sessionId: "grok-session-updates" }],
      cursors,
      queuePath,
    });
    assert.equal(result.eventsAggregated, 2);
    assert.equal(result.bucketsQueued, 2);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 2);
    assert.equal(queued[0].hour_start, "2026-04-05T14:00:00.000Z");
    assert.equal(queued[0].total_tokens, 100);
    assert.equal(queued[0].conversation_count, 0);
    assert.equal(queued[1].hour_start, "2026-04-05T14:30:00.000Z");
    assert.equal(queued[1].total_tokens, 150);
    assert.equal(queued[1].input_tokens, 120);
    assert.equal(queued[1].output_tokens, 30);
    assert.equal(queued[1].conversation_count, 2);
    assert.equal(cursors.grok.version, 3);
    assert.equal(cursors.grok.sessionSnapshots["grok-session-updates"].totalTokens, 250);
    assert.equal(cursors.grok.sessionSnapshots["grok-session-updates"].source, "updates");
    assert.equal(cursors.grok.sessionSnapshots["grok-session-updates"].lastEventId, "evt-2");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseGrokBuildIncremental resumes Grok updates from the stored byte offset", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-grok-offset-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };
    const sessionDir = path.join(tmp, "sessions", "encoded-cwd", "grok-session-offset");
    await fs.mkdir(sessionDir, { recursive: true });
    const signalsPath = path.join(sessionDir, "signals.json");
    const updatesPath = path.join(sessionDir, "updates.jsonl");
    await fs.writeFile(
      signalsPath,
      JSON.stringify({
        primaryModelId: "grok-build",
        lastActiveAt: "2026-04-05T14:50:00.000Z",
      }),
      "utf8",
    );
    const firstLine = JSON.stringify({
      method: "session/update",
      params: { _meta: { totalTokens: 100, agentTimestampMs: Date.parse("2026-04-05T14:05:00.000Z"), eventId: "evt-1" } },
    });
    await fs.writeFile(updatesPath, firstLine + "\n", "utf8");

    const session = { sessionDir, updatesPath, signalsPath, summaryPath: path.join(sessionDir, "summary.json"), sessionId: "grok-session-offset" };
    const firstRun = await parseGrokBuildIncremental({ sessions: [session], cursors, queuePath });
    assert.equal(firstRun.eventsAggregated, 1);
    assert.equal(cursors.grok.updateOffsets[updatesPath].size, Buffer.byteLength(firstLine + "\n"));

    // Replace the consumed head with a same-length decoy event (totalTokens
    // 999). If the parser re-read from byte 0 it would aggregate the decoy;
    // resuming from the stored offset must only see the appended event.
    const decoy = JSON.stringify({
      method: "session/update",
      params: { _meta: { totalTokens: 999, agentTimestampMs: Date.parse("2026-04-05T14:06:00.000Z"), eventId: "evt-x" } },
    });
    assert.equal(decoy.length, firstLine.length);
    const appended = JSON.stringify({
      method: "session/update",
      params: { _meta: { totalTokens: 250, agentTimestampMs: Date.parse("2026-04-05T14:35:00.000Z"), eventId: "evt-2" } },
    });
    await fs.writeFile(updatesPath, decoy + "\n" + appended + "\n", "utf8");

    const secondRun = await parseGrokBuildIncremental({ sessions: [session], cursors, queuePath });
    assert.equal(secondRun.eventsAggregated, 1);
    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 2);
    assert.equal(queued[1].hour_start, "2026-04-05T14:30:00.000Z");
    assert.equal(queued[1].total_tokens, 150);
    assert.equal(cursors.grok.sessionSnapshots["grok-session-offset"].totalTokens, 250);
    assert.equal(
      cursors.grok.updateOffsets[updatesPath].size,
      Buffer.byteLength(decoy + "\n" + appended + "\n"),
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseGrokBuildIncremental re-reads a partial Grok updates line once it completes", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-grok-partial-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };
    const sessionDir = path.join(tmp, "sessions", "encoded-cwd", "grok-session-partial");
    await fs.mkdir(sessionDir, { recursive: true });
    const signalsPath = path.join(sessionDir, "signals.json");
    const updatesPath = path.join(sessionDir, "updates.jsonl");
    await fs.writeFile(
      signalsPath,
      JSON.stringify({
        primaryModelId: "grok-build",
        lastActiveAt: "2026-04-05T14:50:00.000Z",
      }),
      "utf8",
    );

    const fullLine = JSON.stringify({
      method: "session/update",
      params: { _meta: { totalTokens: 100, agentTimestampMs: Date.parse("2026-04-05T14:05:00.000Z"), eventId: "evt-1" } },
    });
    // Simulate Grok still writing: only the first half of the JSON line, no "\n".
    const splitAt = Math.floor(fullLine.length / 2);
    await fs.writeFile(updatesPath, fullLine.slice(0, splitAt), "utf8");

    const session = { sessionDir, updatesPath, signalsPath, summaryPath: path.join(sessionDir, "summary.json"), sessionId: "grok-session-partial" };

    // First scan: partial line is unparseable, so nothing is aggregated AND the
    // stored offset must NOT advance past the partial tail (regression guard).
    const firstRun = await parseGrokBuildIncremental({ sessions: [session], cursors, queuePath });
    assert.equal(firstRun.eventsAggregated, 0);
    assert.equal(cursors.grok.updateOffsets[updatesPath].size, 0);

    // Grok finishes writing the same line.
    await fs.writeFile(updatesPath, fullLine + "\n", "utf8");

    // Second scan: the now-complete line is parsed and queued (not skipped).
    const secondRun = await parseGrokBuildIncremental({ sessions: [session], cursors, queuePath });
    assert.equal(secondRun.eventsAggregated, 1);
    assert.equal(cursors.grok.updateOffsets[updatesPath].size, Buffer.byteLength(fullLine + "\n"));
    assert.equal(cursors.grok.sessionSnapshots["grok-session-partial"].totalTokens, 100);
    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].total_tokens, 100);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseGrokBuildIncremental re-reads truncated Grok updates without double counting", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-grok-truncate-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };
    const sessionDir = path.join(tmp, "sessions", "encoded-cwd", "grok-session-truncate");
    await fs.mkdir(sessionDir, { recursive: true });
    const signalsPath = path.join(sessionDir, "signals.json");
    const updatesPath = path.join(sessionDir, "updates.jsonl");
    await fs.writeFile(
      signalsPath,
      JSON.stringify({
        primaryModelId: "grok-build",
        lastActiveAt: "2026-04-05T15:20:00.000Z",
      }),
      "utf8",
    );
    await fs.writeFile(
      updatesPath,
      [
        JSON.stringify({
          method: "session/update",
          params: { _meta: { totalTokens: 100, agentTimestampMs: Date.parse("2026-04-05T14:05:00.000Z"), eventId: "evt-1" } },
        }),
        JSON.stringify({
          method: "session/update",
          params: { _meta: { totalTokens: 250, agentTimestampMs: Date.parse("2026-04-05T14:35:00.000Z"), eventId: "evt-2" } },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const session = { sessionDir, updatesPath, signalsPath, summaryPath: path.join(sessionDir, "summary.json"), sessionId: "grok-session-truncate" };
    const firstRun = await parseGrokBuildIncremental({ sessions: [session], cursors, queuePath });
    assert.equal(firstRun.eventsAggregated, 2);
    assert.equal(cursors.grok.sessionSnapshots["grok-session-truncate"].totalTokens, 250);

    // Shrink the file (rotation/truncate): the parser must fall back to a
    // full re-read, and the session high-watermark must keep the replayed
    // cumulative totals from double counting.
    await fs.writeFile(
      updatesPath,
      JSON.stringify({
        method: "session/update",
        params: { _meta: { totalTokens: 300, agentTimestampMs: Date.parse("2026-04-05T15:05:00.000Z"), eventId: "evt-3" } },
      }) + "\n",
      "utf8",
    );

    const secondRun = await parseGrokBuildIncremental({ sessions: [session], cursors, queuePath });
    assert.equal(secondRun.eventsAggregated, 1);
    const queued = await readJsonLines(queuePath);
    const last = queued[queued.length - 1];
    assert.equal(last.hour_start, "2026-04-05T15:00:00.000Z");
    assert.equal(last.total_tokens, 50);
    assert.equal(cursors.grok.sessionSnapshots["grok-session-truncate"].totalTokens, 300);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseGrokBuildIncremental applies Grok compaction residual once", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-grok-compaction-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };
    const sessionDir = path.join(tmp, "sessions", "encoded-cwd", "grok-session-compact");
    await fs.mkdir(sessionDir, { recursive: true });
    const signalsPath = path.join(sessionDir, "signals.json");
    const updatesPath = path.join(sessionDir, "updates.jsonl");
    await fs.writeFile(
      signalsPath,
      JSON.stringify({
        contextTokensUsed: 50,
        totalTokensBeforeCompaction: 500,
        assistantMessageCount: 4,
        primaryModelId: "grok-build",
        lastActiveAt: "2026-04-05T15:20:00.000Z",
      }),
      "utf8",
    );
    await fs.writeFile(
      updatesPath,
      JSON.stringify({
        method: "session/update",
        params: { _meta: { totalTokens: 100, agentTimestampMs: Date.parse("2026-04-05T14:05:00.000Z"), eventId: "evt-before-compact" } },
      }) + "\n",
      "utf8",
    );

    const session = { sessionDir, updatesPath, signalsPath, summaryPath: path.join(sessionDir, "summary.json"), sessionId: "grok-session-compact" };
    const firstRun = await parseGrokBuildIncremental({ sessions: [session], cursors, queuePath });
    assert.equal(firstRun.eventsAggregated, 2);
    assert.equal(firstRun.bucketsQueued, 2);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 2);
    assert.equal(queued[0].hour_start, "2026-04-05T14:00:00.000Z");
    assert.equal(queued[0].total_tokens, 100);
    assert.equal(queued[1].hour_start, "2026-04-05T15:00:00.000Z");
    assert.equal(queued[1].total_tokens, 450);
    assert.equal(queued[1].conversation_count, 4);
    assert.equal(cursors.grok.sessionSnapshots["grok-session-compact"].totalTokens, 550);

    const secondRun = await parseGrokBuildIncremental({ sessions: [session], cursors, queuePath });
    assert.equal(secondRun.eventsAggregated, 0);
    assert.equal(secondRun.bucketsQueued, 0);
    assert.equal((await readJsonLines(queuePath)).length, 2);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseGrokBuildIncremental preserves zero current context after compaction", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-grok-zero-context-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };
    const sessionDir = path.join(tmp, "sessions", "encoded-cwd", "grok-session-zero-context");
    await fs.mkdir(sessionDir, { recursive: true });
    const signalsPath = path.join(sessionDir, "signals.json");
    await fs.writeFile(
      signalsPath,
      JSON.stringify({
        contextTokensUsed: 0,
        totalTokensBeforeCompaction: 500,
        totalTokens: 500,
        assistantMessageCount: 3,
        primaryModelId: "grok-build",
        lastActiveAt: "2026-04-05T15:20:00.000Z",
      }),
      "utf8",
    );

    const result = await parseGrokBuildIncremental({
      sessions: [
        {
          sessionDir,
          signalsPath,
          summaryPath: path.join(sessionDir, "summary.json"),
          sessionId: "grok-session-zero-context",
        },
      ],
      cursors,
      queuePath,
    });
    assert.equal(result.eventsAggregated, 1);
    assert.equal(result.bucketsQueued, 1);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].hour_start, "2026-04-05T15:00:00.000Z");
    assert.equal(queued[0].total_tokens, 500);
    assert.equal(cursors.grok.sessionSnapshots["grok-session-zero-context"].totalTokens, 500);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseGrokBuildIncremental upgrades v2 Grok cursor without replaying updates", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-grok-v2-cursor-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = {
      version: 1,
      files: {},
      updatedAt: null,
      grok: {
        version: 2,
        sessionSnapshots: {
          "grok-session-v2": {
            totalTokens: 250,
            messageCount: 2,
            model: "grok-build",
          },
        },
      },
    };
    const sessionDir = path.join(tmp, "sessions", "encoded-cwd", "grok-session-v2");
    await fs.mkdir(sessionDir, { recursive: true });
    const signalsPath = path.join(sessionDir, "signals.json");
    const updatesPath = path.join(sessionDir, "updates.jsonl");
    await fs.writeFile(
      signalsPath,
      JSON.stringify({
        contextTokensUsed: 200,
        assistantMessageCount: 2,
        primaryModelId: "grok-build",
        lastActiveAt: "2026-04-05T14:50:00.000Z",
      }),
      "utf8",
    );
    await fs.writeFile(
      updatesPath,
      [
        JSON.stringify({ params: { _meta: { totalTokens: 100, agentTimestampMs: Date.parse("2026-04-05T14:05:00.000Z") } } }),
        JSON.stringify({ params: { _meta: { totalTokens: 250, agentTimestampMs: Date.parse("2026-04-05T14:35:00.000Z") } } }),
      ].join("\n") + "\n",
      "utf8",
    );

    const result = await parseGrokBuildIncremental({
      sessions: [{ sessionDir, updatesPath, signalsPath, summaryPath: path.join(sessionDir, "summary.json"), sessionId: "grok-session-v2" }],
      cursors,
      queuePath,
    });
    assert.equal(result.eventsAggregated, 0);
    assert.equal(result.bucketsQueued, 0);
    assert.deepEqual(await readJsonLines(queuePath), []);
    assert.equal(cursors.grok.version, 3);
    assert.equal(cursors.grok.sessionSnapshots["grok-session-v2"].totalTokens, 250);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseGrokBuildIncremental baselines legacy Grok seenSessions before counting new growth", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-grok-legacy-seen-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = {
      version: 1,
      files: {},
      updatedAt: null,
      grok: {
        seenSessions: ["grok-session-legacy"],
        updatedAt: "2026-04-05T14:00:00.000Z",
      },
    };
    const sessionDir = path.join(tmp, "sessions", "encoded-cwd", "grok-session-legacy");
    await fs.mkdir(sessionDir, { recursive: true });
    const signalsPath = path.join(sessionDir, "signals.json");
    await fs.writeFile(
      signalsPath,
      JSON.stringify({
        contextTokensUsed: 500,
        assistantMessageCount: 5,
        primaryModelId: "grok-build",
        lastActiveAt: "2026-04-05T14:10:00.000Z",
      }),
      "utf8",
    );

    const firstRun = await parseGrokBuildIncremental({
      sessions: [{ sessionDir, signalsPath, summaryPath: path.join(sessionDir, "summary.json"), sessionId: "grok-session-legacy" }],
      cursors,
      queuePath,
    });

    assert.equal(firstRun.eventsAggregated, 0);
    assert.equal(firstRun.bucketsQueued, 0);
    assert.deepEqual(await readJsonLines(queuePath), []);
    assert.equal(cursors.grok.sessionSnapshots["grok-session-legacy"].totalTokens, 500);

    await fs.writeFile(
      signalsPath,
      JSON.stringify({
        contextTokensUsed: 750,
        assistantMessageCount: 7,
        primaryModelId: "grok-build",
        lastActiveAt: "2026-04-05T14:40:00.000Z",
      }),
      "utf8",
    );

    const secondRun = await parseGrokBuildIncremental({
      sessions: [{ sessionDir, signalsPath, summaryPath: path.join(sessionDir, "summary.json"), sessionId: "grok-session-legacy" }],
      cursors,
      queuePath,
    });

    assert.equal(secondRun.eventsAggregated, 1);
    assert.equal(secondRun.bucketsQueued, 1);
    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].hour_start, "2026-04-05T14:30:00.000Z");
    assert.equal(queued[0].total_tokens, 250);
    assert.equal(queued[0].input_tokens, 200);
    assert.equal(queued[0].output_tokens, 50);
    assert.equal(queued[0].conversation_count, 2);
    assert.equal(cursors.grok.sessionSnapshots["grok-session-legacy"].totalTokens, 750);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseGrokBuildIncremental preserves legacy baseline marker across zero-token sync", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-grok-legacy-zero-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = {
      version: 1,
      files: {},
      updatedAt: null,
      grok: {
        seenSessions: ["grok-session-delayed"],
        updatedAt: "2026-04-05T14:00:00.000Z",
      },
    };
    const sessionDir = path.join(tmp, "sessions", "encoded-cwd", "grok-session-delayed");
    await fs.mkdir(sessionDir, { recursive: true });
    const signalsPath = path.join(sessionDir, "signals.json");
    const session = {
      sessionDir,
      signalsPath,
      summaryPath: path.join(sessionDir, "summary.json"),
      sessionId: "grok-session-delayed",
    };

    await fs.writeFile(
      signalsPath,
      JSON.stringify({
        contextTokensUsed: 0,
        assistantMessageCount: 0,
        primaryModelId: "grok-build",
        lastActiveAt: "2026-04-05T14:10:00.000Z",
      }),
      "utf8",
    );

    const zeroRun = await parseGrokBuildIncremental({ sessions: [session], cursors, queuePath });
    assert.equal(zeroRun.eventsAggregated, 0);
    assert.equal(zeroRun.bucketsQueued, 0);
    assert.equal(cursors.grok.sessionSnapshots["grok-session-delayed"].legacySeen, true);

    await fs.writeFile(
      signalsPath,
      JSON.stringify({
        contextTokensUsed: 420,
        assistantMessageCount: 4,
        primaryModelId: "grok-build",
        lastActiveAt: "2026-04-05T14:20:00.000Z",
      }),
      "utf8",
    );

    const baselineRun = await parseGrokBuildIncremental({ sessions: [session], cursors, queuePath });
    assert.equal(baselineRun.eventsAggregated, 0);
    assert.equal(baselineRun.bucketsQueued, 0);
    assert.deepEqual(await readJsonLines(queuePath), []);
    assert.equal(cursors.grok.sessionSnapshots["grok-session-delayed"].totalTokens, 420);

    await fs.writeFile(
      signalsPath,
      JSON.stringify({
        contextTokensUsed: 750,
        assistantMessageCount: 7,
        primaryModelId: "grok-build",
        lastActiveAt: "2026-04-05T14:40:00.000Z",
      }),
      "utf8",
    );

    const growthRun = await parseGrokBuildIncremental({ sessions: [session], cursors, queuePath });
    assert.ok(growthRun.eventsAggregated > 0);
    assert.equal(growthRun.bucketsQueued, 1);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].hour_start, "2026-04-05T14:30:00.000Z");
    assert.equal(queued[0].total_tokens, 330);
    assert.equal(queued[0].input_tokens, 264);
    assert.equal(queued[0].output_tokens, 66);
    assert.equal(cursors.grok.sessionSnapshots["grok-session-delayed"].totalTokens, 750);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("resolveGrokBuildSessions includes sessions with updates only", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-grok-resolve-"));
  try {
    const grokHome = path.join(tmp, ".grok");
    const sessionDir = path.join(grokHome, "sessions", "encoded-cwd", "grok-session-updates-only");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(path.join(sessionDir, "updates.jsonl"), "\n", "utf8");

    const sessions = resolveGrokBuildSessions({ GROK_HOME: grokHome });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].sessionId, "grok-session-updates-only");
    assert.equal(sessions[0].updatesPath, path.join(sessionDir, "updates.jsonl"));
    assert.equal(sessions[0].signalsPath, path.join(sessionDir, "signals.json"));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseGrokBuildIncremental does not mark zero-token sessions as seen", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-grok-zero-"));
  try {
    const sessionDir = path.join(tmp, "sessions", "encoded-cwd", "grok-session-zero");
    await fs.mkdir(sessionDir, { recursive: true });
    const signalsPath = path.join(sessionDir, "signals.json");
    await fs.writeFile(
      signalsPath,
      JSON.stringify({
        contextTokensUsed: 0,
        assistantMessageCount: 0,
        primaryModelId: "grok-build",
        lastActiveAt: "2026-04-05T14:10:00.000Z",
      }),
      "utf8",
    );

    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };
    const session = { sessionDir, signalsPath, summaryPath: path.join(sessionDir, "summary.json"), sessionId: "grok-session-zero" };

    const firstRun = await parseGrokBuildIncremental({
      sessions: [session],
      cursors,
      queuePath,
    });
    assert.equal(firstRun.eventsAggregated, 0);
    assert.deepEqual(cursors.grok.seenSessions, []);

    await fs.writeFile(
      signalsPath,
      JSON.stringify({
        contextTokensUsed: 42,
        assistantMessageCount: 2,
        primaryModelId: "grok-build",
        lastActiveAt: "2026-04-05T14:20:00.000Z",
      }),
      "utf8",
    );

    const secondRun = await parseGrokBuildIncremental({
      sessions: [session],
      cursors,
      queuePath,
    });
    assert.equal(secondRun.eventsAggregated, 1);
    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].total_tokens, 42);
    assert.deepEqual(cursors.grok.seenSessions, ["grok-session-zero"]);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseAntigravityIncremental bills only newly added context per planner call", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-antigravity-"));
  try {
    const transcriptPath = path.join(tmp, "transcript.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const modelSelection = "changed setting `Model Selection` from Auto to Gemini 3.5 Flash.\n";
    const userA = "u".repeat(40);
    const modelContentA = modelSelection + userA;
    const toolResult = "r".repeat(80);
    const answerA = "a".repeat(20);
    const thinkingA = "t".repeat(12);
    const userB = "b".repeat(40);
    const answerB = "c".repeat(20);
    const thinkingB = "d".repeat(12);

    const lines = [
      { type: "USER_INPUT", created_at: "2026-04-05T14:00:00.000Z", content: modelContentA },
      { type: "TOOL_RESULT", created_at: "2026-04-05T14:01:00.000Z", content: toolResult },
      {
        type: "PLANNER_RESPONSE",
        created_at: "2026-04-05T14:02:00.000Z",
        content: answerA,
        thinking: thinkingA,
      },
      { type: "USER_INPUT", created_at: "2026-04-05T14:03:00.000Z", content: userB },
      {
        type: "PLANNER_RESPONSE",
        created_at: "2026-04-05T14:04:00.000Z",
        content: answerB,
        thinking: thinkingB,
      },
    ];
    await fs.writeFile(transcriptPath, lines.map((line) => JSON.stringify(line)).join("\n"));

    const result = await parseAntigravityIncremental({
      sessionFiles: [transcriptPath],
      cursors,
      queuePath,
    });
    assert.equal(result.eventsAggregated, 2);
    assert.equal(result.bucketsQueued, 1);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].source, "antigravity");
    assert.equal(queued[0].model, "gemini-3.5-flash");
    // Planner 1 input = USER_INPUT + TOOL_RESULT (all context up to it).
    // Planner 2 input = previous assistant content (answerA) + new USER_INPUT (userB),
    // NOT the full history again — this is the O(N) vs prior O(N^2) fix.
    const firstInput = antigravityTestTokens(modelContentA) + antigravityTestTokens(toolResult);
    const secondInput = antigravityTestTokens(answerA) + antigravityTestTokens(userB);
    assert.equal(queued[0].input_tokens, firstInput + secondInput);
    assert.equal(queued[0].output_tokens, 10);
    assert.equal(queued[0].reasoning_output_tokens, 6);
    assert.equal(queued[0].conversation_count, 2);
    // total_tokens = sum of every column (matches Codebuddy / Kilocode / OMP / Hermes).
    assert.equal(
      queued[0].total_tokens,
      queued[0].input_tokens + queued[0].output_tokens + queued[0].reasoning_output_tokens,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseAntigravityIncremental delta billing is O(N), not O(N^2)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-antigravity-on2-"));
  try {
    const transcriptPath = path.join(tmp, "transcript.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    // 10 turns of (USER_INPUT, PLANNER_RESPONSE) with identical token cost per event.
    // Old behavior: input_tokens ≈ sum(1..N) * unit  (quadratic)
    // New behavior: input_tokens ≈ N * unit          (linear)
    const turns = 10;
    const userUnit = "u".repeat(40); // 10 tokens
    const plannerUnit = "a".repeat(40); // 10 tokens (output AND becomes next-turn input)
    const userUnitTokens = antigravityTestTokens(userUnit);
    const plannerUnitTokens = antigravityTestTokens(plannerUnit);
    assert.equal(userUnitTokens, 10);
    assert.equal(plannerUnitTokens, 10);

    const lines = [];
    let t = Date.parse("2026-04-05T14:00:00.000Z");
    const modelLead =
      "changed setting `Model Selection` from Auto to Gemini 3.5 Flash.\n" + userUnit;
    for (let i = 0; i < turns; i++) {
      lines.push({
        type: "USER_INPUT",
        created_at: new Date(t).toISOString(),
        content: i === 0 ? modelLead : userUnit,
      });
      t += 60_000;
      lines.push({
        type: "PLANNER_RESPONSE",
        created_at: new Date(t).toISOString(),
        content: plannerUnit,
      });
      t += 60_000;
    }
    await fs.writeFile(transcriptPath, lines.map((l) => JSON.stringify(l)).join("\n"));

    await parseAntigravityIncremental({ sessionFiles: [transcriptPath], cursors, queuePath });
    const queued = await readJsonLines(queuePath);
    const totalInput = queued.reduce((sum, row) => sum + (row.input_tokens || 0), 0);

    // Linear upper bound: first-turn input (modelLead tokens) + (N-1) turns of
    // (planner_unit + user_unit). Far below the quadratic ~N^2/2 * unit blow-up.
    const firstTurnInput = antigravityTestTokens(modelLead);
    const expected = firstTurnInput + (turns - 1) * (plannerUnitTokens + userUnitTokens);
    assert.equal(totalInput, expected);
    // Sanity: assert it really is linear, not quadratic.
    const quadraticLowerBound = userUnitTokens * (turns * (turns + 1)) / 2;
    assert.ok(
      totalInput < quadraticLowerBound,
      `expected linear billing (${totalInput}) < quadratic floor (${quadraticLowerBound})`,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseAntigravityIncremental counts old context for newly appended planner response", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-antigravity-incremental-"));
  try {
    const transcriptPath = path.join(tmp, "transcript.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const firstLines = [
      {
        type: "USER_INPUT",
        created_at: "2026-04-05T14:00:00.000Z",
        content:
          "changed setting `Model Selection` from Auto to Gemini 3.5 Flash.\n" +
          "u".repeat(40),
      },
    ];
    await fs.writeFile(
      transcriptPath,
      firstLines.map((line) => JSON.stringify(line)).join("\n"),
    );

    const first = await parseAntigravityIncremental({
      sessionFiles: [transcriptPath],
      cursors,
      queuePath,
    });
    assert.equal(first.eventsAggregated, 0);

    const nextLines = [
      ...firstLines,
      {
        type: "PLANNER_RESPONSE",
        created_at: "2026-04-05T14:02:00.000Z",
        content: "a".repeat(20),
      },
    ];
    await fs.writeFile(
      transcriptPath,
      nextLines.map((line) => JSON.stringify(line)).join("\n"),
    );

    const second = await parseAntigravityIncremental({
      sessionFiles: [transcriptPath],
      cursors,
      queuePath,
    });
    assert.equal(second.eventsAggregated, 1);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].model, "gemini-3.5-flash");
    assert.equal(queued[0].input_tokens, antigravityTestTokens(firstLines[0].content));
    assert.equal(queued[0].output_tokens, 5);
    assert.equal(queued[0].total_tokens, queued[0].input_tokens + queued[0].output_tokens);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("listAntigravitySessionFiles discovers transcripts across sibling 2.0 brain dirs", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-antigravity-brain-dirs-"));
  try {
    const legacyTranscript = path.join(
      tmp,
      "antigravity",
      "brain",
      "session-legacy",
      ".system_generated",
      "logs",
      "transcript.jsonl",
    );
    const ideTranscript = path.join(
      tmp,
      "antigravity-ide",
      "brain",
      "session-ide",
      ".system_generated",
      "logs",
      "transcript.jsonl",
    );
    const cliTranscript = path.join(
      tmp,
      "antigravity-cli",
      "brain",
      "session-cli",
      ".system_generated",
      "logs",
      "transcript.jsonl",
    );
    for (const p of [legacyTranscript, ideTranscript, cliTranscript]) {
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, "");
    }

    const dirs = [
      path.join(tmp, "antigravity", "brain"),
      path.join(tmp, "antigravity-ide", "brain"),
      path.join(tmp, "antigravity-cli", "brain"),
      path.join(tmp, "antigravity-missing", "brain"),
    ];
    const results = await Promise.all(dirs.map((d) => listAntigravitySessionFiles(d)));
    const all = results.flat();

    assert.deepEqual(all.sort(), [cliTranscript, ideTranscript, legacyTranscript].sort());
    assert.deepEqual(results[3], []);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseAntigravityIncremental does not skip append after trailing newline", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-antigravity-trailing-newline-"));
  try {
    const transcriptPath = path.join(tmp, "transcript.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const firstLine = {
      type: "USER_INPUT",
      created_at: "2026-04-05T14:00:00.000Z",
      content:
        "changed setting `Model Selection` from Auto to Gemini 3.5 Flash.\n" +
        "u".repeat(40),
    };
    await fs.writeFile(transcriptPath, `${JSON.stringify(firstLine)}\n`);

    const first = await parseAntigravityIncremental({
      sessionFiles: [transcriptPath],
      cursors,
      queuePath,
    });
    assert.equal(first.eventsAggregated, 0);
    assert.equal(cursors.files[transcriptPath].lastLine, 1);

    const plannerLine = {
      type: "PLANNER_RESPONSE",
      created_at: "2026-04-05T14:02:00.000Z",
      content: "a".repeat(20),
    };
    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify(firstLine)}\n${JSON.stringify(plannerLine)}\n`,
    );

    const second = await parseAntigravityIncremental({
      sessionFiles: [transcriptPath],
      cursors,
      queuePath,
    });
    assert.equal(second.eventsAggregated, 1);
    assert.equal(cursors.files[transcriptPath].lastLine, 2);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].model, "gemini-3.5-flash");
    assert.equal(queued[0].input_tokens, antigravityTestTokens(firstLine.content));
    assert.equal(queued[0].output_tokens, 5);
    assert.equal(queued[0].total_tokens, queued[0].input_tokens + queued[0].output_tokens);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseAntigravityIncremental does not advance cursor over partial JSON line", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-antigravity-partial-json-"));
  try {
    const transcriptPath = path.join(tmp, "transcript.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };
    const firstLine = {
      type: "USER_INPUT",
      created_at: "2026-04-05T14:00:00.000Z",
      content: "changed setting `Model Selection` from Auto to Gemini 3.5 Flash.",
    };
    const plannerLine = {
      type: "PLANNER_RESPONSE",
      created_at: "2026-04-05T14:02:00.000Z",
      content: "a".repeat(20),
    };

    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify(firstLine)}\n${JSON.stringify(plannerLine).slice(0, -4)}`,
    );
    const first = await parseAntigravityIncremental({
      sessionFiles: [transcriptPath],
      cursors,
      queuePath,
    });
    assert.equal(first.eventsAggregated, 0);
    assert.equal(cursors.files[transcriptPath].lastLine, 1);

    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify(firstLine)}\n${JSON.stringify(plannerLine)}\n`,
    );
    const second = await parseAntigravityIncremental({
      sessionFiles: [transcriptPath],
      cursors,
      queuePath,
    });
    assert.equal(second.eventsAggregated, 1);
    assert.equal(cursors.files[transcriptPath].lastLine, 2);

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].model, "gemini-3.5-flash");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseAntigravityIncremental uses CJK-aware token estimates", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-antigravity-cjk-"));
  try {
    const transcriptPath = path.join(tmp, "transcript.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };
    const prompt =
      "changed setting `Model Selection` from Auto to Gemini 3.5 Flash.\n检查本项目对 antigravity 的用量";
    const answer = "完成检查";
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "USER_INPUT",
          created_at: "2026-04-05T14:00:00.000Z",
          content: prompt,
        }),
        JSON.stringify({
          type: "PLANNER_RESPONSE",
          created_at: "2026-04-05T14:02:00.000Z",
          content: answer,
        }),
      ].join("\n"),
    );

    await parseAntigravityIncremental({
      sessionFiles: [transcriptPath],
      cursors,
      queuePath,
    });

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].input_tokens, antigravityTestTokens(prompt));
    assert.equal(queued[0].output_tokens, antigravityTestTokens(answer));
    assert.ok(queued[0].input_tokens > Math.ceil(prompt.length / 4));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseAntigravityIncremental preserves unknown model as visible usage", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-antigravity-unknown-model-"));
  try {
    const transcriptPath = path.join(tmp, "transcript.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "USER_INPUT",
          created_at: "2026-04-05T14:00:00.000Z",
          content: "regular prompt without model settings",
        }),
        JSON.stringify({
          type: "PLANNER_RESPONSE",
          created_at: "2026-04-05T14:02:00.000Z",
          content: "answer",
        }),
      ].join("\n"),
    );

    await parseAntigravityIncremental({
      sessionFiles: [transcriptPath],
      cursors,
      queuePath,
    });

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].model, "antigravity-unknown");
    assert.ok(queued[0].total_tokens > 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseAntigravityIncremental normalizes non-Flash model settings without defaulting", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-antigravity-model-settings-"));
  try {
    const transcriptPath = path.join(tmp, "transcript.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "USER_INPUT",
          created_at: "2026-04-05T14:00:00.000Z",
          content: "changed setting `Model Selection` from Auto to Claude Haiku 4.6 (Thinking).",
        }),
        JSON.stringify({
          type: "PLANNER_RESPONSE",
          created_at: "2026-04-05T14:02:00.000Z",
          content: "answer",
        }),
      ].join("\n"),
    );

    await parseAntigravityIncremental({
      sessionFiles: [transcriptPath],
      cursors,
      queuePath,
    });

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].model, "claude-haiku-4.6");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseAntigravityIncremental falls back to settings.json model", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-antigravity-settings-"));
  try {
    // Path: …/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript.jsonl
    // readAntigravityDefaultModel walks 5 levels up to antigravity-cli/ for settings.json
    const traceDir = path.join(tmp, "antigravity-cli", "brain", "session-id", ".system_generated", "logs");
    await fs.mkdir(traceDir, { recursive: true });
    const transcriptPath = path.join(traceDir, "transcript.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");

    // Write settings.json at the variant root (5 levels up from transcript)
    await fs.writeFile(
      path.join(tmp, "antigravity-cli", "settings.json"),
      JSON.stringify({ model: "Claude Sonnet 4" }),
    );

    // Transcript with no model-selection event — must fall back to settings.json
    const cursors = { version: 1, files: {}, updatedAt: null };
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "USER_INPUT",
          created_at: "2026-04-05T14:00:00.000Z",
          content: "a regular prompt",
        }),
        JSON.stringify({
          type: "PLANNER_RESPONSE",
          created_at: "2026-04-05T14:02:00.000Z",
          content: "the answer",
        }),
      ].join("\n"),
    );

    await parseAntigravityIncremental({
      sessionFiles: [transcriptPath],
      cursors,
      queuePath,
    });

    const queued = await readJsonLines(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].model, "claude-sonnet-4");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

for (const eventType of ["USER_INPUT", "USER_SETTINGS_CHANGE"]) {
  test(`parseAntigravityIncremental transcript model change overrides settings.json fallback (${eventType})`, async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-antigravity-settings-ovr-"));
    try {
      const traceDir = path.join(tmp, "antigravity-cli", "brain", "session-id", ".system_generated", "logs");
      await fs.mkdir(traceDir, { recursive: true });
      const transcriptPath = path.join(traceDir, "transcript.jsonl");
      const queuePath = path.join(tmp, "queue.jsonl");

      await fs.writeFile(
        path.join(tmp, "antigravity-cli", "settings.json"),
        JSON.stringify({ model: "Claude Sonnet 4" }),
      );

      const cursors = { version: 1, files: {}, updatedAt: null };
      await fs.writeFile(
        transcriptPath,
        [
          JSON.stringify({
            type: eventType,
            created_at: "2026-04-05T14:00:00.000Z",
            content: "changed setting `Model Selection` from Auto to Claude Haiku 4.6 (Thinking).",
          }),
          JSON.stringify({
            type: "PLANNER_RESPONSE",
            created_at: "2026-04-05T14:02:00.000Z",
            content: "answer",
          }),
        ].join("\n"),
      );

      await parseAntigravityIncremental({
        sessionFiles: [transcriptPath],
        cursors,
        queuePath,
      });

      const queued = await readJsonLines(queuePath);
      assert.equal(queued.length, 1);
      assert.equal(queued[0].model, "claude-haiku-4.6");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
}

// ── Kimi Code official (@moonshot-ai/kimi-code) ──────────────────────────────

test("parseKimiCodeIncremental reads step.end events with Anthropic-style usage", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-kimi-code-"));
  try {
    const sessDir = path.join(tmp, "sessions", "wd_proj_abc123", "session_001", "agents", "main");
    await fs.mkdir(sessDir, { recursive: true });
    const wireFile = path.join(sessDir, "wire.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const now = 1780000000000;
    const lines = [
      JSON.stringify({ type: "metadata", protocol_version: "1.0", created_at: now }),
      JSON.stringify({ type: "config.update", modelAlias: "kimi-code/kimi-k2.6", time: now }),
      JSON.stringify({ type: "context.append_loop_event", event: { type: "step.begin", uuid: "sb1", turnId: "0", step: 1 }, time: now }),
      JSON.stringify({ type: "context.append_loop_event", event: { type: "step.end", uuid: "se1", turnId: "0", step: 1, usage: { input_tokens: 9000, output_tokens: 250, cache_read_input_tokens: 8000, cache_creation_input_tokens: 100 } }, time: now + 1000 }),
      JSON.stringify({ type: "context.append_loop_event", event: { type: "step.end", uuid: "se2", turnId: "0", step: 2, usage: { input_tokens: 2000, output_tokens: 80, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }, time: now + 2000 }),
    ];
    await fs.writeFile(wireFile, lines.join("\n") + "\n");

    const cursors = {};
    const result = await parseKimiCodeIncremental({ wireFiles: [wireFile], cursors, queuePath });
    assert.equal(result.recordsProcessed, 2);
    assert.equal(result.eventsAggregated, 2);
    assert.equal(result.bucketsQueued, 1);

    assert.ok(Array.isArray(cursors.kimiCode?.seenIds));
    assert.equal(cursors.kimiCode.seenIds.length, 2);
    assert.ok(cursors.kimiCode.seenIds.includes("se1"));
    assert.ok(cursors.kimiCode.seenIds.includes("se2"));

    const queued = (await fs.readFile(queuePath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].source, "kimi");
    assert.equal(queued[0].model, "kimi-k2.6");
    assert.equal(queued[0].input_tokens, 11000);
    assert.equal(queued[0].output_tokens, 330);
    assert.equal(queued[0].cached_input_tokens, 8000);
    assert.equal(queued[0].cache_creation_input_tokens, 100);
    assert.equal(queued[0].total_tokens, 11000 + 330 + 8000 + 100);

    // idempotent re-parse
    const result2 = await parseKimiCodeIncremental({ wireFiles: [wireFile], cursors, queuePath });
    assert.equal(result2.eventsAggregated, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseKimiCodeIncremental handles OpenAI-compat usage (cached folded into input_tokens)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-kimi-code-oai-"));
  try {
    const sessDir = path.join(tmp, "sessions", "wd_proj_abc", "session_002", "agents", "main");
    await fs.mkdir(sessDir, { recursive: true });
    const wireFile = path.join(sessDir, "wire.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const now = 1780000000000;
    const lines = [
      JSON.stringify({ type: "metadata", protocol_version: "1.3", created_at: now }),
      JSON.stringify({ type: "config.update", modelAlias: "kimi-code/kimi-k2.6", time: now }),
      JSON.stringify({ type: "context.append_loop_event", event: { type: "step.end", uuid: "oai1", turnId: "0", step: 1, usage: { input_tokens: 5000, output_tokens: 120, input_tokens_details: { cached_tokens: 4000 } } }, time: now + 1000 }),
    ];
    await fs.writeFile(wireFile, lines.join("\n") + "\n");

    const cursors = {};
    const result = await parseKimiCodeIncremental({ wireFiles: [wireFile], cursors, queuePath });
    assert.equal(result.eventsAggregated, 1);

    const queued = (await fs.readFile(queuePath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(queued[0].input_tokens, 1000); // 5000 - 4000 cached
    assert.equal(queued[0].cached_input_tokens, 4000);
    assert.equal(queued[0].output_tokens, 120);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseKimiCodeIncremental reads step.end events with camelCase usage (kimi-code 0.6.0+)", async () => {
  // Real wire shape on @moonshot-ai/kimi-code 0.6.0/0.7.0/0.9.0: response.usage
  // is { inputOther, inputCacheRead, inputCacheCreation, output } where
  // inputOther is fresh (non-cached) input. Issue #135 — the old parser only
  // recognized Anthropic-style keys, so every camelCase step.end read as $0/0t.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-kimi-code-camel-"));
  try {
    const sessDir = path.join(tmp, "sessions", "wd_proj_xyz", "session_003", "agents", "main");
    await fs.mkdir(sessDir, { recursive: true });
    const wireFile = path.join(sessDir, "wire.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const now = 1780000000000;
    const lines = [
      JSON.stringify({ type: "metadata", protocol_version: "1.0", created_at: now }),
      JSON.stringify({ type: "config.update", modelAlias: "kimi-code/kimi-k2.6", time: now }),
      JSON.stringify({ type: "context.append_loop_event", event: { type: "step.begin", uuid: "sb1", turnId: "0", step: 1 }, time: now }),
      JSON.stringify({ type: "context.append_loop_event", event: { type: "step.end", uuid: "ce1", turnId: "0", step: 1, usage: { inputOther: 1500, inputCacheRead: 8000, inputCacheCreation: 100, output: 250 } }, time: now + 1000 }),
      // usage.record carries the SAME per-step usage — must NOT be double-counted.
      JSON.stringify({ type: "usage.record", model: "kimi-code/kimi-k2.6", usage: { inputOther: 1500, inputCacheRead: 8000, inputCacheCreation: 100, output: 250 }, usageScope: "session", time: now + 1000 }),
      JSON.stringify({ type: "context.append_loop_event", event: { type: "step.end", uuid: "ce2", turnId: "0", step: 2, usage: { inputOther: 2000, inputCacheRead: 0, inputCacheCreation: 0, output: 80 } }, time: now + 2000 }),
    ];
    await fs.writeFile(wireFile, lines.join("\n") + "\n");

    const cursors = {};
    const result = await parseKimiCodeIncremental({ wireFiles: [wireFile], cursors, queuePath });
    assert.equal(result.recordsProcessed, 2);
    assert.equal(result.eventsAggregated, 2);

    const queued = (await fs.readFile(queuePath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].source, "kimi");
    assert.equal(queued[0].model, "kimi-k2.6");
    assert.equal(queued[0].input_tokens, 3500); // 1500 + 2000, no cache subtraction
    assert.equal(queued[0].output_tokens, 330);
    assert.equal(queued[0].cached_input_tokens, 8000);
    assert.equal(queued[0].cache_creation_input_tokens, 100);
    assert.equal(queued[0].total_tokens, 3500 + 330 + 8000 + 100);

    // idempotent re-parse
    const result2 = await parseKimiCodeIncremental({ wireFiles: [wireFile], cursors, queuePath });
    assert.equal(result2.eventsAggregated, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseKimiCodeIncremental returns zero when no wire files exist", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-kimi-code-empty-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = {};
    const result = await parseKimiCodeIncremental({ wireFiles: [], cursors, queuePath });
    assert.equal(result.recordsProcessed, 0);
    assert.equal(result.eventsAggregated, 0);
    assert.equal(result.bucketsQueued, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("resolveKimiCodeWireFiles walks agents/<name>/wire.jsonl inside sessions", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-kimi-code-resolve-"));
  try {
    const d1 = path.join(tmp, ".kimi-code", "sessions", "wd_a_123", "session_x", "agents", "main");
    const d2 = path.join(tmp, ".kimi-code", "sessions", "wd_b_456", "session_y", "agents", "sub");
    await fs.mkdir(d1, { recursive: true });
    await fs.mkdir(d2, { recursive: true });
    await fs.writeFile(path.join(d1, "wire.jsonl"), "");
    await fs.writeFile(path.join(d2, "wire.jsonl"), "");

    const files = resolveKimiCodeWireFiles({ KIMI_CODE_HOME: path.join(tmp, ".kimi-code") });
    assert.equal(files.length, 2);
    assert.ok(files.every((f) => f.endsWith("wire.jsonl")));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("resolveKimiCodeDefaultModel extracts model from config.toml", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-kimi-code-model-"));
  try {
    await fs.writeFile(path.join(tmp, "config.toml"), 'default_model = "kimi-code/kimi-k2.6"\n');
    const model = resolveKimiCodeDefaultModel({ KIMI_CODE_HOME: tmp });
    assert.equal(model, "kimi-k2.6");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseKimiCodeIncremental persists model from config.update on cursor for incremental resumes", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-kimi-code-resume-"));
  try {
    const sessDir = path.join(tmp, "sessions", "wd_z_999", "session_r", "agents", "main");
    await fs.mkdir(sessDir, { recursive: true });
    const wireFile = path.join(sessDir, "wire.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const now = 1780000000000;

    // First write: config.update + one step.end
    await fs.writeFile(wireFile, [
      JSON.stringify({ type: "metadata", protocol_version: "1.0", created_at: now }),
      JSON.stringify({ type: "config.update", modelAlias: "kimi-code/kimi-k2.6", time: now }),
      JSON.stringify({ type: "context.append_loop_event", event: { type: "step.end", uuid: "r1", turnId: "0", step: 1, usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }, time: now + 500 }),
    ].join("\n") + "\n");

    const cursors = {};
    await parseKimiCodeIncremental({ wireFiles: [wireFile], cursors, queuePath });
    assert.equal(cursors.kimiCode.fileOffsets[wireFile].model, "kimi-k2.6");

    // Second write: append step.end without config.update (incremental resume)
    await fs.appendFile(wireFile, JSON.stringify({ type: "context.append_loop_event", event: { type: "step.end", uuid: "r2", turnId: "0", step: 2, usage: { input_tokens: 200, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }, time: now + 2000 }) + "\n");

    const result2 = await parseKimiCodeIncremental({ wireFiles: [wireFile], cursors, queuePath });
    assert.equal(result2.eventsAggregated, 1);

    const queued = (await fs.readFile(queuePath, "utf8")).trim().split("\n").map(JSON.parse);
    const lastEntry = queued[queued.length - 1];
    assert.equal(lastEntry.model, "kimi-k2.6");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
