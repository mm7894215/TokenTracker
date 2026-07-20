"use strict";

// Conservative, metadata-only Git attribution. A commit is attributed only
// when exactly one local AI session overlaps its author timestamp.

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

function resolveAutoOutcomesPath(home = os.homedir()) {
  return path.join(home, ".tokentracker", "tracker", "auto-outcomes.jsonl");
}

function readJsonl(filePath) {
  try { return fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
  catch { return []; }
}

// Async on purpose: this runs inside the local API request path, where a
// synchronous spawn would freeze every other endpoint for the duration of
// each git invocation.
function runGit(cwd, args) {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "utf8", timeout: 15_000, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout) => resolve(error ? "" : String(stdout).trim()),
    );
  });
}

async function repoRoot(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return null;
  return (await runGit(cwd, ["rev-parse", "--show-toplevel"])) || null;
}

async function commitsForWindow(root, from, to) {
  const format = "%H%x1f%aI%x1f%P%x1f%s%x1e";
  const raw = await runGit(root, ["log", "--all", `--since=${from}`, `--until=${to}`, `--format=${format}`]);
  if (!raw) return [];
  return raw.split("\x1e").map((item) => item.trim()).filter(Boolean).map((item) => {
    const [sha, timestamp, parents, subject] = item.split("\x1f");
    return {
      sha,
      timestamp,
      parent_count: String(parents || "").split(/\s+/).filter(Boolean).length,
      reverted: /^revert\b/i.test(subject || ""),
    };
  }).filter((row) => row.sha && Number.isFinite(Date.parse(row.timestamp)));
}

async function writeAtomic(filePath, content) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
  await fsp.rename(temp, filePath);
}

async function buildGitOutcomesInternal(sessions, { home = os.homedir(), force = false, maxAgeDays = 90 } = {}) {
  const groups = new Map();
  const rootCache = new Map();
  const cutoff = Date.now() - Math.max(1, Number(maxAgeDays) || 90) * 86400_000;
  for (const session of sessions || []) {
    if (!session?.project_ref || !session.started_at || !session.ended_at) continue;
    if (Date.parse(session.ended_at) < cutoff) continue;
    let root = rootCache.get(session.project_ref);
    if (root === undefined) {
      root = await repoRoot(session.project_ref);
      rootCache.set(session.project_ref, root);
    }
    if (!root) continue;
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(session);
  }

  const outputPath = resolveAutoOutcomesPath(home);
  const metaPath = `${outputPath}.meta.json`;
  const signatureHash = crypto.createHash("sha256");
  for (const [root, repoSessions] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    signatureHash.update(`${root}\0${await runGit(root, ["for-each-ref", "--format=%(objectname)"])}\n`);
    for (const session of repoSessions) signatureHash.update(`${session.session_hash}\0${session.ended_at}\n`);
  }
  const signature = signatureHash.digest("hex");
  if (!force) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      if (meta.version === 1 && meta.signature === signature) return readJsonl(outputPath);
    } catch { /* first run */ }
  }

  const outcomes = [];
  for (const [root, repoSessions] of groups) {
    const start = repoSessions.reduce((min, row) => !min || row.started_at < min ? row.started_at : min, "");
    const endMs = Math.max(...repoSessions.map((row) => Date.parse(row.ended_at))) + 60 * 60 * 1000;
    const commits = await commitsForWindow(root, start, new Date(endMs).toISOString());
    for (const commit of commits) {
      const commitMs = Date.parse(commit.timestamp);
      const candidates = repoSessions.filter((session) => {
        const sessionStart = Date.parse(session.started_at) - 10 * 60 * 1000;
        const sessionEnd = Date.parse(session.ended_at) + 60 * 60 * 1000;
        return commitMs >= sessionStart && commitMs <= sessionEnd;
      });
      if (candidates.length !== 1) continue;
      const session = candidates[0];
      outcomes.push({
        timestamp: commit.timestamp,
        model: session.model || "unknown",
        tool: session.source || "unknown",
        accepted: !commit.reverted,
        task_type: "git_commit",
        status: commit.reverted ? "reverted" : "committed",
        session_hash: session.session_hash,
        commit_hash: commit.sha.slice(0, 12),
        parent_count: commit.parent_count,
        confidence: "heuristic",
        methodology: "single-overlapping-session",
      });
    }
  }
  outcomes.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  await writeAtomic(outputPath, outcomes.map((row) => JSON.stringify(row)).join("\n") + (outcomes.length ? "\n" : ""));
  await writeAtomic(metaPath, `${JSON.stringify({ version: 1, signature, generated_at: new Date().toISOString(), max_age_days: maxAgeDays })}\n`);
  return outcomes;
}

// Overlapping outcomes/session-insights requests must not spawn duplicate git
// scans nor race the atomic sidecar write; share one build per home.
const gitOutcomesBuilds = new Map();

function buildGitOutcomes(sessions, options = {}) {
  const home = path.resolve(String(options.home || os.homedir()));
  const existing = gitOutcomesBuilds.get(home);
  if (existing) return existing;
  const promise = buildGitOutcomesInternal(sessions, { ...options, home });
  gitOutcomesBuilds.set(home, promise);
  const clear = () => {
    if (gitOutcomesBuilds.get(home) === promise) gitOutcomesBuilds.delete(home);
  };
  promise.then(clear, clear);
  return promise;
}

module.exports = { resolveAutoOutcomesPath, buildGitOutcomes, repoRoot, commitsForWindow };
