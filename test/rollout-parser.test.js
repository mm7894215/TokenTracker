const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { test } = require("node:test");

const cp = require("node:child_process");
const {
  parseRolloutIncremental,
  parseClaudeIncremental,
  parseGeminiIncremental,
  parseOpencodeIncremental,
  parseKiroIncremental,
  parseHermesIncremental,
  parseCopilotIncremental,
  parseKimiIncremental,
  parseCodebuddyIncremental,
  parseCursorApiIncremental,
  resolveCodebuddyDefaultModel,
  resolveCodebuddyProjectFiles,
  parseOmpIncremental,
  resolveOmpSessionFiles,
  parsePiIncremental,
  resolvePiSessionFiles,
  parseCraftIncremental,
  resolveCraftSessionFiles,
  resolveCraftWorkspaceRoots,
} = require("../src/lib/rollout");

test("parseRolloutIncremental ignores repeated token_count records with unchanged totals", async () => {
  // Codex can repeat the same token_count record in a rollout. The cumulative
  // total_token_usage value is authoritative for a file; if it did not move,
  // the repeated last_token_usage must not be counted again.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibescore-rollout-"));
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

test("parseRolloutIncremental prefers cumulative total_token_usage delta over larger last_token_usage", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibescore-rollout-"));
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibescore-rollout-"));
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibescore-rollout-"));
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

test("parseRolloutIncremental uses session_meta cwd to resolve project context", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibescore-rollout-"));
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibescore-rollout-"));
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibescore-rollout-"));
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibescore-rollout-"));
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibescore-rollout-"));
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibescore-rollout-"));
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

test("parseRolloutIncremental migrates v1 hourly buckets without resetting totals", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibescore-rollout-"));
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibescore-rollout-"));
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibescore-rollout-"));
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibescore-gemini-"));
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibescore-gemini-total-"));
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

test("parseGeminiIncremental is idempotent with unchanged totals", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibescore-gemini-"));
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

test("parseGeminiIncremental defaults missing model to unknown", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibescore-gemini-"));
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibescore-cursor-reconcile-"));
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

test("parseOpencodeIncremental aggregates message tokens and model", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibescore-opencode-"));
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

test("parseOpencodeIncremental defaults missing model to unknown", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibescore-opencode-"));
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibescore-opencode-"));
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibescore-opencode-"));
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibescore-opencode-"));
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibescore-opencode-"));
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibescore-opencode-"));
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibescore-opencode-"));
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibescore-opencode-"));
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibescore-codex-cached-"));
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibescore-rollout-"));
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibescore-rollout-"));
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibescore-rollout-"));
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibescore-rollout-"));
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibescore-rollout-"));
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibescore-rollout-"));
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibescore-rollout-"));
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibescore-rollout-"));
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibescore-rollout-"));
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibescore-rollout-"));
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibescore-claude-"));
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
    assert.equal(resAgain.bucketsQueued, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseClaudeIncremental counts cache creation as input and cache read separately", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibescore-claude-"));
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibescore-claude-"));
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

test("parseClaudeIncremental defaults missing model to unknown", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibescore-claude-"));
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

function buildTurnContextLine({ model, cwd }) {
  const payload = { model };
  if (typeof cwd === "string" && cwd.length > 0) {
    payload.cwd = cwd;
  }
  return JSON.stringify({
    type: "turn_context",
    payload,
  });
}

function buildSessionMetaLine({ model, cwd }) {
  const payload = { model };
  if (typeof cwd === "string" && cwd.length > 0) {
    payload.cwd = cwd;
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

function buildClaudeUsageLine({ ts, input, output, model, total, cacheCreation, cacheRead }) {
  return JSON.stringify({
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
  });
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibescore-kiro-"));
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibescore-kiro-"));
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

    // Second parse — no new data, should be no-op
    const second = await parseHermesIncremental({ dbPath, cursors, queuePath });
    assert.equal(second.recordsProcessed, 0);
    assert.equal(second.eventsAggregated, 0);
    assert.equal(second.bucketsQueued, 0);

    // Add a third session and parse again — incremental
    cp.execFileSync("sqlite3", [
      dbPath,
      `INSERT INTO sessions (id, source, model, started_at, ended_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, message_count) VALUES ('sess_003', 'cli', 'gpt-5.4-mini', ${epoch2 + 3600}, ${epoch2 + 3700}, 500, 250, 0, 0, 0, 2);`,
    ]);
    const third = await parseHermesIncremental({ dbPath, cursors, queuePath });
    assert.equal(third.recordsProcessed, 1);
    assert.equal(third.eventsAggregated, 1);
    assert.ok(third.bucketsQueued >= 1);
    assert.equal(cursors.hermes.lastStartedAt, epoch2 + 3600);
  } finally {
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
    assert.equal(second.recordsProcessed, 1); // only the active session re-read
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

    // Snapshot should be updated
    assert.equal(cursors.hermes.snapshots["sess_active"].in, 8000);
    assert.equal(cursors.hermes.snapshots["sess_active"].out, 400);

    // Cursor still hasn't advanced past the active session
    assert.equal(cursors.hermes.lastCompletedStartedAt, epoch1);

    // Now end the active session
    cp.execFileSync("sqlite3", [
      dbPath,
      `UPDATE sessions SET ended_at = ${epoch1 + 600}, input_tokens = 10000, output_tokens = 600, cache_read_tokens = 3000 WHERE id = 'sess_active';`,
    ]);

    const third = await parseHermesIncremental({ dbPath, cursors, queuePath });
    assert.equal(third.recordsProcessed, 1);
    assert.equal(third.eventsAggregated, 1);

    // Now cursor should advance past the ended session
    assert.equal(cursors.hermes.lastCompletedStartedAt, epoch1 + 200);
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
    attributes: {
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": model,
      "gen_ai.response.model": model,
      "gen_ai.usage.input_tokens": inputTokens,
      "gen_ai.usage.output_tokens": outputTokens,
      "gen_ai.usage.cache_read.input_tokens": cacheRead,
      "gen_ai.usage.cache_write.input_tokens": cacheWrite,
      "gen_ai.usage.reasoning.output_tokens": reasoning,
    },
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

    // Rotate: delete + recreate at same path with a new larger payload (different inode)
    require("node:fs").unlinkSync(otelPath);
    writeCopilotOtelFile(otelPath, [
      makeCopilotChatSpan({ traceId: "t2", spanId: "s2", inputTokens: 5000 }),
      makeCopilotChatSpan({ traceId: "t3", spanId: "s3", inputTokens: 5000 }),
    ]);

    const second = await parseCopilotIncremental({ otelPaths: [otelPath], cursors, queuePath });
    // Both new spans should be picked up despite the file being the "same" path
    assert.equal(second.eventsAggregated, 2);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseCopilotIncremental returns zero when no OTEL files exist", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-copilot-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1 };

    const result = await parseCopilotIncremental({ otelPaths: [], cursors, queuePath, env: {} });
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
    // prompt/response.
    function convValue(promptLen, responseLen) {
      return {
        model_info: { model_id: "auto" },
        user_turn_metadata: {
          continuation_id: "conv-1",
          requests: [
            {
              request_id: "req-1",
              message_id: "msg-1",
              request_start_timestamp_ms: Date.parse("2026-04-20T10:05:00.000Z"),
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
          row.hour_start === "2026-04-20T10:00:00.000Z",
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
                request_start_timestamp_ms: Date.parse(
                  "2026-04-20T10:05:00.000Z",
                ),
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
                request_start_timestamp_ms: Date.parse(
                  "2026-04-20T10:05:00.000Z",
                ),
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
                request_start_timestamp_ms: Date.parse(
                  "2026-04-20T10:05:00.000Z",
                ),
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
                request_start_timestamp_ms: Date.parse(
                  "2026-04-20T10:05:00.000Z",
                ),
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
    const tsA = Date.parse("2026-04-20T10:05:00.000Z");
    const tsB = Date.parse("2026-04-20T10:35:00.000Z");
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

test("resolvePiSessionFiles returns empty when ~/.pi/agent/sessions missing", async () => {
  const result = resolvePiSessionFiles({ HOME: path.join(os.tmpdir(), "no-such-pi-home") });
  assert.deepEqual(result, []);
});

test("PI_CODING_AGENT_DIR env override redirects discovery", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-pi-"));
  try {
    const sessionsDir = path.join(tmp, "sessions", "--myproject--");
    await fs.mkdir(sessionsDir, { recursive: true });
    const filePath = path.join(sessionsDir, "session.jsonl");
    await fs.writeFile(filePath, buildOmpSessionHeader() + "\n", "utf8");

    const result = resolvePiSessionFiles({ PI_CODING_AGENT_DIR: tmp });
    assert.equal(result.length, 1);
    assert.ok(result[0].endsWith(".jsonl"));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// PI_CODING_AGENT_DIR belongs to pi-coding-agent only; omp must not claim it,
// otherwise a pi user would have their sessions double-counted under both
// sources.
test("PI_CODING_AGENT_DIR does not redirect omp discovery", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-collision-"));
  try {
    const sessionsDir = path.join(tmp, "sessions", "--myproject--");
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(path.join(sessionsDir, "session.jsonl"), buildOmpSessionHeader() + "\n", "utf8");

    const ompResult = resolveOmpSessionFiles({
      PI_CODING_AGENT_DIR: tmp,
      OMP_HOME: path.join(os.tmpdir(), "no-such-omp"),
    });
    assert.deepEqual(ompResult, []);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
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
