"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { buildGitOutcomes } = require("../src/lib/git-outcomes");

test("Git outcomes attributes only the single overlapping metadata-only session", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-git-home-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tt-git-repo-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_DATE: "2026-07-18T01:30:00Z", GIT_COMMITTER_DATE: "2026-07-18T01:30:00Z" } });
  git("init");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "TokenTracker Test");
  fs.writeFileSync(path.join(repo, "file.txt"), "safe");
  git("add", "file.txt");
  git("commit", "-m", "implement metadata feature");
  const sessions = [{
    session_hash: "session-hash",
    project_ref: repo,
    started_at: "2026-07-18T01:00:00Z",
    ended_at: "2026-07-18T01:20:00Z",
    source: "codex",
    model: "gpt-test",
  }];
  const outcomes = await buildGitOutcomes(sessions, { home, force: true, maxAgeDays: 100_000 });
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].session_hash, "session-hash");
  assert.equal(outcomes[0].accepted, true);
  assert.equal(Object.hasOwn(outcomes[0], "subject"), false);
  assert.equal(Object.hasOwn(outcomes[0], "diff"), false);
  const cached = await buildGitOutcomes(sessions, { home, maxAgeDays: 100_000 });
  assert.deepEqual(cached, outcomes);
});
