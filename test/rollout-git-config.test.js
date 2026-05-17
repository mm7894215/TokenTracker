const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  parseRolloutIncremental,
  canonicalizeProjectRef,
  deriveProjectKeyFromRef,
} = require("../src/lib/rollout");

test("parseRolloutIncremental ignores non-remote url sections in git config", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibeusage-gitcfg-"));
  const repoRoot = path.join(tmp, "repo");
  const gitDir = path.join(repoRoot, ".git");
  await fs.mkdir(gitDir, { recursive: true });
  const configPath = path.join(gitDir, "config");

  const config = [
    '[remote "origin"]',
    "\turl = https://github.com/acme/repo.git",
    '[branch "main"]',
    "\tremote = origin",
    '[url "https://example.com/"]',
    "\tinsteadOf = https://github.com/",
    "\turl = https://example.com/override",
    "",
  ].join("\n");
  await fs.writeFile(configPath, config, "utf8");

  const rolloutPath = path.join(repoRoot, "rollout-2026-01-01.jsonl");
  await fs.writeFile(rolloutPath, "{}\n", "utf8");

  const queuePath = path.join(tmp, "queue.jsonl");
  const projectQueuePath = path.join(tmp, "project.queue.jsonl");

  const cursors = {};
  let captured = null;
  const resolver = async ({ projectRef, repoRoot }) => {
    captured = { projectRef, repoRoot };
    return { status: "public_verified", projectKey: "pkey", projectRef };
  };

  await parseRolloutIncremental({
    rolloutFiles: [rolloutPath],
    cursors,
    queuePath,
    projectQueuePath,
    source: "codex",
    publicRepoResolver: resolver,
  });

  assert.ok(captured, "resolver should be called");
  assert.equal(captured.projectRef, "https://github.com/acme/repo");
});

test("parseRolloutIncremental resolves worktree gitdir via commondir config", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibeusage-gitcfg-"));
  const repoRoot = path.join(tmp, "repo");
  await fs.mkdir(repoRoot, { recursive: true });

  const gitDir = path.join(tmp, "gitdir");
  const commonDir = path.join(tmp, "common");
  await fs.mkdir(gitDir, { recursive: true });
  await fs.mkdir(commonDir, { recursive: true });

  await fs.writeFile(path.join(repoRoot, ".git"), `gitdir: ${gitDir}\n`, "utf8");
  await fs.writeFile(
    path.join(gitDir, "commondir"),
    path.relative(gitDir, commonDir) + "\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(commonDir, "config"),
    `[remote "origin"]\n\turl = https://github.com/acme/repo.git\n`,
    "utf8",
  );

  const rolloutPath = path.join(repoRoot, "rollout-2026-01-02.jsonl");
  await fs.writeFile(rolloutPath, "{}\n", "utf8");

  const queuePath = path.join(tmp, "queue.jsonl");
  const projectQueuePath = path.join(tmp, "project.queue.jsonl");

  const cursors = {};
  let captured = null;
  const resolver = async ({ projectRef, repoRoot: resolvedRoot }) => {
    captured = { projectRef, repoRoot: resolvedRoot };
    return { status: "public_verified", projectKey: "pkey", projectRef };
  };

  await parseRolloutIncremental({
    rolloutFiles: [rolloutPath],
    cursors,
    queuePath,
    projectQueuePath,
    source: "codex",
    publicRepoResolver: resolver,
  });

  assert.ok(captured, "resolver should be called");
  assert.equal(captured.projectRef, "https://github.com/acme/repo");
});

test("deriveProjectKeyFromRef preserves full path for GitLab nested groups", () => {
  // GitHub: classic owner/repo, unchanged
  assert.equal(
    deriveProjectKeyFromRef("https://github.com/acme/repo"),
    "acme/repo",
  );

  // GitLab single-level group: behaves like GitHub
  assert.equal(
    deriveProjectKeyFromRef("https://gitlab.com/acme/repo"),
    "acme/repo",
  );

  // GitLab nested group — bug from issue #69
  assert.equal(
    deriveProjectKeyFromRef("https://gitlab.com/acme/team/repo"),
    "acme/team/repo",
  );

  // Deeper nesting (3+ subgroups)
  assert.equal(
    deriveProjectKeyFromRef("https://gitlab.example.com/org/dept/team/svc"),
    "org/dept/team/svc",
  );

  // Single segment is rejected (need at least owner/repo)
  assert.equal(deriveProjectKeyFromRef("https://gitlab.com/orphan"), null);
  assert.equal(deriveProjectKeyFromRef(null), null);
  assert.equal(deriveProjectKeyFromRef("not-a-url"), null);
});

test("canonicalizeProjectRef + deriveProjectKeyFromRef round-trip for SSH-style GitLab nested groups", () => {
  const ref = canonicalizeProjectRef("git@gitlab.com:acme/team/repo.git");
  assert.equal(ref, "https://gitlab.com/acme/team/repo");
  assert.equal(deriveProjectKeyFromRef(ref), "acme/team/repo");
});
