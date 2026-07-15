#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DEFAULT_HASH_COUNT = 379_000;
const CONTEXT_HISTORY_FILES = 32;
const SOURCE_FINGERPRINT_FILES = [
  "src/commands/sync.js",
  "src/lib/codex-context-breakdown.js",
  "src/lib/codex-rollout-parser.js",
  "src/lib/rollout.js",
];

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    if (arg.startsWith("--repo-root=")) out.repoRoot = path.resolve(arg.slice(12));
    else if (arg.startsWith("--before-root=")) out.beforeRoot = path.resolve(arg.slice(14));
    else if (arg.startsWith("--hash-count=")) out.hashCount = Number(arg.slice(13));
    else if (arg.startsWith("--worker=")) out.worker = arg.slice(9);
    else if (arg.startsWith("--corpus-root=")) out.corpusRoot = path.resolve(arg.slice(14));
    else throw new Error(`Unknown option: ${arg}`);
  }
  return out;
}

function buildHashes(count) {
  const suffix = "x".repeat(158);
  return Array.from(
    { length: count },
    (_, index) => `${index.toString(36).padStart(6, "0")}:${suffix}`,
  );
}

function tokenCount(timestamp, usage) {
  return {
    timestamp,
    type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: usage } },
  };
}

function writeRollout(root, day, name, events, mtime) {
  const dir = path.join(root, day.slice(0, 4), day.slice(5, 7), day.slice(8, 10));
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  const stamp = new Date(mtime || `${day}T12:00:00.000Z`);
  fs.utimesSync(filePath, stamp, stamp);
  return filePath;
}

function createContextCorpus(root) {
  const sessions = path.join(root, "context", "sessions");
  for (let index = 0; index < CONTEXT_HISTORY_FILES; index += 1) {
    writeRollout(sessions, "2028-01-01", `rollout-history-${String(index).padStart(3, "0")}.jsonl`, [
      tokenCount(`2028-01-01T${String(index % 24).padStart(2, "0")}:00:00.000Z`, {
        input_tokens: 10,
        cached_input_tokens: 2,
        cache_creation_input_tokens: 0,
        output_tokens: 3,
        reasoning_output_tokens: 0,
        total_tokens: 13,
      }),
    ], "2028-01-01T12:00:00.000Z");
  }
  writeRollout(sessions, "2030-06-01", "rollout-target-long.jsonl", [
    tokenCount("2030-06-01T23:50:00.000Z", {
      input_tokens: 100,
      cached_input_tokens: 20,
      cache_creation_input_tokens: 2,
      output_tokens: 10,
      reasoning_output_tokens: 1,
      total_tokens: 112,
    }),
    {
      timestamp: "2030-06-01T23:59:00.000Z",
      type: "response_item",
      payload: { type: "function_call", name: "take_snapshot", call_id: "pending", arguments: "{}" },
    },
    tokenCount("2030-06-02T00:05:00.000Z", {
      input_tokens: 160,
      cached_input_tokens: 35,
      cache_creation_input_tokens: 6,
      output_tokens: 22,
      reasoning_output_tokens: 5,
      total_tokens: 188,
    }),
  ], "2030-06-02T00:06:00.000Z");
  return sessions;
}

function maxRssBytes() {
  const maxRssKiB = Number(process.resourceUsage?.().maxRSS || 0);
  return Number.isFinite(maxRssKiB) ? maxRssKiB * 1024 : null;
}

function startMemorySampler() {
  let peakHeap = process.memoryUsage().heapUsed;
  const timer = setInterval(() => {
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
  }, 5);
  timer.unref();
  return {
    sample() {
      peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
    },
    stop() {
      clearInterval(timer);
      this.sample();
      return {
        peak_rss_bytes: maxRssBytes(),
        sampled_peak_heap_bytes: peakHeap,
      };
    },
  };
}

function installContextObservation() {
  const original = {
    readdirSync: fs.readdirSync,
    statSync: fs.statSync,
    createReadStream: fs.createReadStream,
    jsonParse: JSON.parse,
  };
  const counts = {
    readdir_calls: 0,
    stat_calls: 0,
    opened_files: 0,
    json_parse_calls: 0,
  };
  fs.readdirSync = function observedReaddir(...args) {
    counts.readdir_calls += 1;
    return original.readdirSync.apply(this, args);
  };
  fs.statSync = function observedStat(...args) {
    counts.stat_calls += 1;
    return original.statSync.apply(this, args);
  };
  fs.createReadStream = function observedOpen(...args) {
    counts.opened_files += 1;
    return original.createReadStream.apply(this, args);
  };
  JSON.parse = function observedJsonParse(...args) {
    counts.json_parse_calls += 1;
    return original.jsonParse.apply(this, args);
  };
  return {
    counts,
    restore() {
      fs.readdirSync = original.readdirSync;
      fs.statSync = original.statSync;
      fs.createReadStream = original.createReadStream;
      JSON.parse = original.jsonParse;
    },
  };
}

function installLargeHashObservation(hashCount) {
  const OriginalSet = global.Set;
  const originalArrayFrom = Array.from;
  const counts = { hash_set_constructions: 0, hash_array_materializations: 0 };
  function isLargeHashCollection(value) {
    return value && Number(value.length ?? value.size) >= hashCount;
  }
  global.Set = class ObservedSet extends OriginalSet {
    constructor(iterable) {
      super(iterable);
      if (isLargeHashCollection(iterable)) counts.hash_set_constructions += 1;
    }
  };
  Array.from = function observedArrayFrom(value, ...rest) {
    if ((value instanceof OriginalSet || Array.isArray(value)) && isLargeHashCollection(value)) {
      counts.hash_array_materializations += 1;
    }
    return originalArrayFrom.call(this, value, ...rest);
  };
  return {
    counts,
    restore() {
      global.Set = OriginalSet;
      Array.from = originalArrayFrom;
    },
  };
}

function observeWholeArrayReads(values) {
  const metrics = {
    hash_array_iterator_reads: 0,
    hash_array_index_reads: 0,
    hash_array_copy_method_reads: 0,
  };
  const copyMethods = ["concat", "filter", "flat", "flatMap", "map", "slice", "toSpliced"];
  const proxy = new Proxy(values, {
    get(target, property, receiver) {
      if (property === Symbol.iterator) metrics.hash_array_iterator_reads += 1;
      if (typeof property === "string" && /^\d+$/.test(property)) {
        metrics.hash_array_index_reads += 1;
      }
      if (copyMethods.includes(property)) metrics.hash_array_copy_method_reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  return { proxy, metrics };
}

async function runContextWorker({ repoRoot, corpusRoot, exhaustive }) {
  const observation = installContextObservation();
  const sampler = startMemorySampler();
  const started = process.hrtime.bigint();
  try {
    const { computeCodexContextBreakdown } = require(path.join(repoRoot, "src/lib/codex-context-breakdown"));
    const args = {
      from: "2030-06-02",
      to: "2030-06-02",
      codexDir: path.join(corpusRoot, "context", "sessions"),
      timeZoneContext: { timeZone: "UTC", offsetMinutes: 0 },
      exhaustive,
      includeDiagnostics: true,
    };
    const result = await computeCodexContextBreakdown(args);
    const coldWallMs = Number(process.hrtime.bigint() - started) / 1e6;
    const firstCounts = { ...observation.counts };
    const beforeWarm = { ...observation.counts };
    const warmStarted = process.hrtime.bigint();
    const warm = exhaustive ? null : await computeCodexContextBreakdown(args);
    const warmWallMs = exhaustive ? null : Number(process.hrtime.bigint() - warmStarted) / 1e6;
    const warmCounts = exhaustive ? null : {
      readdir_calls: observation.counts.readdir_calls - beforeWarm.readdir_calls,
      stat_calls: observation.counts.stat_calls - beforeWarm.stat_calls,
      opened_files: observation.counts.opened_files - beforeWarm.opened_files,
      json_parse_calls: observation.counts.json_parse_calls - beforeWarm.json_parse_calls,
    };
    sampler.sample();
    const diagnostics = normalizeContextDiagnostics({
      diagnostics: result.diagnostics,
      observed: firstCounts,
      corpusFiles: CONTEXT_HISTORY_FILES + 1,
    });
    return {
      wall_ms: Number(process.hrtime.bigint() - started) / 1e6,
      cold_wall_ms: coldWallMs,
      warm_wall_ms: warmWallMs,
      memory: sampler.stop(),
      corpus_files: CONTEXT_HISTORY_FILES + 1,
      totals: result.totals,
      diagnostics,
      observed: firstCounts,
      warm: warm ? {
        diagnostics: normalizeContextDiagnostics({
          diagnostics: warm.diagnostics,
          observed: warmCounts,
          corpusFiles: CONTEXT_HISTORY_FILES + 1,
        }),
        observed: warmCounts,
      } : null,
    };
  } finally {
    observation.restore();
  }
}

function normalizeContextDiagnostics({ diagnostics, observed, corpusFiles }) {
  const value = diagnostics && typeof diagnostics === "object" ? diagnostics : {};
  const numberOr = (input, fallback) => Number.isFinite(Number(input)) ? Number(input) : fallback;
  return {
    cache_hit: Boolean(value.cache_hit),
    discovered_files: numberOr(value.discovered_files, corpusFiles),
    candidate_files: numberOr(value.candidate_files, observed.opened_files),
    stat_calls: numberOr(value.stat_calls, observed.stat_calls),
    opened_files: numberOr(value.opened_files, observed.opened_files),
    parsed_files: numberOr(value.parsed_files, observed.opened_files),
    json_parse_calls: numberOr(value.json_parse_calls, observed.json_parse_calls),
  };
}

async function createSyncCorpus(root, hashCount) {
  const sessions = path.join(root, "sync", "sessions");
  const activePath = writeRollout(
    sessions,
    "2030-06-02",
    "rollout-2030-06-02T01-00-00-ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb.jsonl",
    [{
    timestamp: "2030-06-02T01:00:00.000Z",
    type: "session_meta",
    payload: { id: "active", cwd: "/tmp/project", model_provider: "openai" },
    }],
  );
  const activeStat = await fsp.stat(activePath);
  const files = {};
  for (let index = 0; index < 63; index += 1) {
    const sessionSuffix = String(index).padStart(12, "0");
    const filePath = writeRollout(
      sessions,
      "2028-01-01",
      `rollout-2028-01-01T00-00-00-aaaaaaaa-bbbb-cccc-dddd-${sessionSuffix}.jsonl`,
      [{
        timestamp: "2028-01-01T00:00:00.000Z",
        type: "session_meta",
        payload: { id: sessionSuffix, cwd: "/tmp/project", model_provider: "openai" },
      }],
      "2028-01-01T00:01:00.000Z",
    );
    const stat = await fsp.stat(filePath);
    files[filePath] = { inode: stat.ino || index + 1, offset: stat.size };
  }
  files[activePath] = { inode: activeStat.ino || 0, offset: activeStat.size };
  const hashes = buildHashes(hashCount);
  return {
    activePath,
    sessions,
    hashes,
    cursors: { version: 1, files, codexHashes: hashes },
  };
}

async function runSyncParseWorker({ repoRoot, corpusRoot, hashCount }) {
  const hashObservation = installLargeHashObservation(hashCount);
  let sampler = null;
  try {
    const {
      filterColdCodexRolloutFiles,
      listRolloutFiles,
      parseRolloutIncremental,
    } = require(path.join(repoRoot, "src/lib/rollout"));
    const corpus = await createSyncCorpus(corpusRoot, hashCount);
    const cursorJsonBytes = Buffer.byteLength(JSON.stringify(corpus.cursors));
    const observedHashes = observeWholeArrayReads(corpus.cursors.codexHashes);
    corpus.cursors.codexHashes = observedHashes.proxy;
    const discoveredPaths = await listRolloutFiles(corpus.sessions);
    const rolloutFiles = discoveredPaths.map((filePath) => ({ path: filePath, source: "codex" }));
    const diagnostics = {};
    sampler = startMemorySampler();
    const started = process.hrtime.bigint();
    const filtered = await filterColdCodexRolloutFiles({
      rolloutFiles,
      cursors: corpus.cursors,
      diagnostics,
      nowMs: Date.UTC(2030, 5, 2, 12, 0, 0),
      recentDays: 2,
    });
    const beforeHashes = corpus.cursors.codexHashes;
    await parseRolloutIncremental({
      rolloutFiles: filtered.rolloutFiles,
      cursors: corpus.cursors,
      queuePath: path.join(corpusRoot, "sync", "queue.jsonl"),
      source: "codex",
      diagnostics,
    });
    sampler.sample();
    return {
      wall_ms: Number(process.hrtime.bigint() - started) / 1e6,
      memory: sampler.stop(),
      production_equivalent: {
        hash_count: hashCount,
        cursor_json_bytes: cursorJsonBytes,
      },
      discovered_rollouts: rolloutFiles.length,
      corpus_files_on_disk: discoveredPaths.length,
      cursor_keys: Object.keys(corpus.cursors.files).length,
      cold_skipped: filtered.skipped,
      parse_candidates: filtered.rolloutFiles.length,
      codex_hash_array_identity_preserved: corpus.cursors.codexHashes === beforeHashes,
      diagnostics: Object.keys(diagnostics).length > 0 ? diagnostics : null,
      observed: {
        ...hashObservation.counts,
        ...observedHashes.metrics,
      },
    };
  } finally {
    hashObservation.restore();
  }
}

async function runSyncAppendWorker({ repoRoot, corpusRoot, hashCount }) {
  const hashObservation = installLargeHashObservation(hashCount);
  let sampler = null;
  try {
    const { parseRolloutIncremental } = require(path.join(repoRoot, "src/lib/rollout"));
    const sessions = path.join(corpusRoot, "sync-append", "sessions");
    const baselineUsage = {
      input_tokens: 20,
      cached_input_tokens: 5,
      cache_creation_input_tokens: 0,
      output_tokens: 4,
      reasoning_output_tokens: 1,
      total_tokens: 24,
    };
    const targetUsage = {
      input_tokens: 35,
      cached_input_tokens: 10,
      cache_creation_input_tokens: 0,
      output_tokens: 9,
      reasoning_output_tokens: 2,
      total_tokens: 44,
    };
    const baselineLine = `${JSON.stringify(tokenCount("2030-06-02T01:00:00.000Z", baselineUsage))}\n`;
    const filePath = writeRollout(
      sessions,
      "2030-06-02",
      "rollout-2030-06-02T01-00-00-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl",
      [tokenCount("2030-06-02T01:00:00.000Z", baselineUsage)],
    );
    const fileStat = await fsp.stat(filePath);
    await fsp.appendFile(
      filePath,
      `${JSON.stringify(tokenCount("2030-06-02T01:05:00.000Z", targetUsage))}\n`,
    );
    const hashes = buildHashes(hashCount);
    const cursorJsonBytes = Buffer.byteLength(JSON.stringify({ codexHashes: hashes }));
    const observedHashes = observeWholeArrayReads(hashes);
    const cursors = {
      version: 1,
      files: {
        [filePath]: {
          inode: fileStat.ino,
          offset: Buffer.byteLength(baselineLine),
          lastTotal: baselineUsage,
        },
      },
      codexHashes: observedHashes.proxy,
    };
    const beforeHashes = cursors.codexHashes;
    const diagnostics = {};
    sampler = startMemorySampler();
    const started = process.hrtime.bigint();
    const result = await parseRolloutIncremental({
      rolloutFiles: [filePath],
      cursors,
      queuePath: path.join(corpusRoot, "sync-append", "queue.jsonl"),
      source: "codex",
      diagnostics,
    });
    sampler.sample();
    return {
      wall_ms: Number(process.hrtime.bigint() - started) / 1e6,
      memory: sampler.stop(),
      production_equivalent: { hash_count: hashCount, cursor_json_bytes: cursorJsonBytes },
      result,
      codex_hash_array_identity_preserved: cursors.codexHashes === beforeHashes,
      diagnostics: Object.keys(diagnostics).length > 0 ? diagnostics : null,
      observed: {
        ...hashObservation.counts,
        ...observedHashes.metrics,
      },
    };
  } finally {
    hashObservation.restore();
  }
}

function installCursorCommitObservation(expectedPath) {
  const originalWriteFile = fsp.writeFile;
  const originalRename = fsp.rename;
  const pendingBytes = new Map();
  const counts = { cursor_commits: 0, cursor_bytes: 0 };
  fsp.writeFile = async function observedWrite(filePath, content, ...rest) {
    if (String(filePath).startsWith(`${expectedPath}.tmp.`)) {
      pendingBytes.set(String(filePath), Buffer.byteLength(String(content)));
    }
    return originalWriteFile.call(this, filePath, content, ...rest);
  };
  fsp.rename = async function observedRename(from, to, ...rest) {
    const result = await originalRename.call(this, from, to, ...rest);
    if (String(to) === expectedPath && pendingBytes.has(String(from))) {
      counts.cursor_commits += 1;
      counts.cursor_bytes += pendingBytes.get(String(from));
      pendingBytes.delete(String(from));
    }
    return result;
  };
  return {
    counts,
    restore() {
      fsp.writeFile = originalWriteFile;
      fsp.rename = originalRename;
    },
  };
}

async function runCursorCommitWorker({ repoRoot, corpusRoot, hashCount }) {
  const RealDate = Date;
  const benchmarkNowMs = RealDate.UTC(2030, 5, 2, 12, 34, 56, 789);
  global.Date = class FixedBenchmarkDate extends RealDate {
    constructor(...args) {
      super(...(args.length > 0 ? args : [benchmarkNowMs]));
    }

    static now() {
      return benchmarkNowMs;
    }
  };
  const home = path.join(corpusRoot, "commit-home");
  const codexHome = path.join(home, ".codex");
  const trackerDir = path.join(home, ".tokentracker", "tracker");
  const cursorsPath = path.join(trackerDir, "cursors.json");
  await fsp.mkdir(path.join(codexHome, "sessions"), { recursive: true });
  await fsp.mkdir(trackerDir, { recursive: true });
  const hashes = buildHashes(hashCount);
  const auditAtMs = RealDate.UTC(2030, 5, 2, 0, 0, 0);
  const initial = {
    version: 1,
    files: {},
    codexHashes: hashes,
    codexColdScanAudit: {
      version: 1,
      lastFullScanAtMs: auditAtMs,
      lastFullScanAt: new Date(auditAtMs).toISOString(),
      syncsSinceFullScan: 1,
      lastSkippedFiles: 0,
      updatedAt: new Date(auditAtMs).toISOString(),
    },
  };
  const initialBytes = Buffer.byteLength(JSON.stringify(initial));
  await fsp.writeFile(cursorsPath, `${JSON.stringify(initial)}\n`);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.CODEX_HOME = codexHome;

  const commitObservation = installCursorCommitObservation(cursorsPath);
  const hashObservation = installLargeHashObservation(hashCount);
  const sampler = startMemorySampler();
  const started = process.hrtime.bigint();
  try {
    const { cmdSync } = require(path.join(repoRoot, "src/commands/sync"));
    const diagnostics = {};
    await cmdSync(["--auto", "--from-retry", "--source=codex"], { diagnostics });
    const persistedRaw = await fsp.readFile(cursorsPath, "utf8");
    const persistedBytes = Buffer.byteLength(persistedRaw);
    sampler.sample();
    return {
      wall_ms: Number(process.hrtime.bigint() - started) / 1e6,
      memory: sampler.stop(),
      production_equivalent: { hash_count: hashCount, initial_cursor_json_bytes: initialBytes },
      persisted_cursor_bytes: persistedBytes,
      persisted_cursor_sha256: crypto.createHash("sha256").update(persistedRaw).digest("hex"),
      diagnostics: Object.keys(diagnostics).length > 0 ? diagnostics : null,
      observed: {
        ...hashObservation.counts,
        ...commitObservation.counts,
      },
    };
  } finally {
    commitObservation.restore();
    hashObservation.restore();
    global.Date = RealDate;
  }
}

function runWorkerProcess(worker, args) {
  const child = spawnSync(process.execPath, [
    __filename,
    `--worker=${worker}`,
    `--repo-root=${args.repoRoot}`,
    `--corpus-root=${args.corpusRoot}`,
    `--hash-count=${args.hashCount}`,
  ], {
    cwd: args.repoRoot,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    env: {
      ...process.env,
      NODE_PATH: [
        process.env.NODE_PATH,
        path.join(__dirname, "..", "node_modules"),
      ].filter(Boolean).join(path.delimiter),
    },
  });
  if (child.status !== 0) {
    throw new Error(`${worker} failed (${child.status}): ${child.stderr || child.stdout}`);
  }
  return JSON.parse(child.stdout);
}

function runPhase(repoRoot, corpusRoot, hashCount) {
  const workerArgs = { repoRoot, corpusRoot, hashCount };
  return {
    repo_root: repoRoot,
    source_fingerprint: sourceFingerprint(repoRoot),
    context: {
      bounded: runWorkerProcess("context-bounded", workerArgs),
      exhaustive: runWorkerProcess("context-exhaustive", workerArgs),
    },
    sync: {
      idle_large_state: runWorkerProcess("sync-parse", workerArgs),
      active_append: runWorkerProcess("sync-append", workerArgs),
      cursor_commit: runWorkerProcess("cursor-commit", workerArgs),
    },
  };
}

function sourceFingerprint(repoRoot) {
  const hash = crypto.createHash("sha256");
  for (const relativePath of SOURCE_FINGERPRINT_FILES) {
    hash.update(relativePath);
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(repoRoot, relativePath)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function comparisonMetric(before, after) {
  return { before, after, delta: after - before };
}

function buildComparison(before, after) {
  return {
    context: {
      bounded_wall_ms: comparisonMetric(before.context.bounded.wall_ms, after.context.bounded.wall_ms),
      bounded_cold_wall_ms: comparisonMetric(
        before.context.bounded.cold_wall_ms,
        after.context.bounded.cold_wall_ms,
      ),
      bounded_warm_wall_ms: comparisonMetric(
        before.context.bounded.warm_wall_ms,
        after.context.bounded.warm_wall_ms,
      ),
      bounded_opened_files: comparisonMetric(
        before.context.bounded.diagnostics.opened_files,
        after.context.bounded.diagnostics.opened_files,
      ),
      bounded_parsed_files: comparisonMetric(
        before.context.bounded.diagnostics.parsed_files,
        after.context.bounded.diagnostics.parsed_files,
      ),
      bounded_json_parse_calls: comparisonMetric(
        before.context.bounded.diagnostics.json_parse_calls,
        after.context.bounded.diagnostics.json_parse_calls,
      ),
      warm_opened_files: comparisonMetric(
        before.context.bounded.warm?.diagnostics?.opened_files || 0,
        after.context.bounded.warm?.diagnostics?.opened_files || 0,
      ),
      warm_json_parse_calls: comparisonMetric(
        before.context.bounded.warm?.diagnostics?.json_parse_calls || 0,
        after.context.bounded.warm?.diagnostics?.json_parse_calls || 0,
      ),
      warm_readdir_calls: comparisonMetric(
        before.context.bounded.warm?.observed?.readdir_calls || 0,
        after.context.bounded.warm?.observed?.readdir_calls || 0,
      ),
      warm_stat_calls: comparisonMetric(
        before.context.bounded.warm?.observed?.stat_calls || 0,
        after.context.bounded.warm?.observed?.stat_calls || 0,
      ),
    },
    sync: {
      idle_wall_ms: comparisonMetric(
        before.sync.idle_large_state.wall_ms,
        after.sync.idle_large_state.wall_ms,
      ),
      append_wall_ms: comparisonMetric(
        before.sync.active_append.wall_ms,
        after.sync.active_append.wall_ms,
      ),
      append_hash_set_constructions: comparisonMetric(
        before.sync.active_append.observed.hash_set_constructions,
        after.sync.active_append.observed.hash_set_constructions,
      ),
      append_hash_array_materializations: comparisonMetric(
        before.sync.active_append.observed.hash_array_materializations,
        after.sync.active_append.observed.hash_array_materializations,
      ),
      hash_set_constructions: comparisonMetric(
        before.sync.idle_large_state.observed.hash_set_constructions,
        after.sync.idle_large_state.observed.hash_set_constructions,
      ),
      hash_array_materializations: comparisonMetric(
        before.sync.idle_large_state.observed.hash_array_materializations,
        after.sync.idle_large_state.observed.hash_array_materializations,
      ),
      cursor_commits: comparisonMetric(
        before.sync.cursor_commit.observed.cursor_commits,
        after.sync.cursor_commit.observed.cursor_commits,
      ),
      cursor_bytes: comparisonMetric(
        before.sync.cursor_commit.observed.cursor_bytes,
        after.sync.cursor_commit.observed.cursor_bytes,
      ),
      cursor_payload_equal:
        before.sync.cursor_commit.persisted_cursor_sha256 ===
        after.sync.cursor_commit.persisted_cursor_sha256,
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = args.repoRoot || path.resolve(__dirname, "..");
  const hashCount = Number.isFinite(args.hashCount) && args.hashCount > 0
    ? Math.floor(args.hashCount)
    : DEFAULT_HASH_COUNT;

  if (args.worker) {
    const workerArgs = { repoRoot, corpusRoot: args.corpusRoot, hashCount };
    let result;
    if (args.worker === "context-bounded") result = await runContextWorker({ ...workerArgs, exhaustive: false });
    else if (args.worker === "context-exhaustive") result = await runContextWorker({ ...workerArgs, exhaustive: true });
    else if (args.worker === "sync-parse") result = await runSyncParseWorker(workerArgs);
    else if (args.worker === "sync-append") result = await runSyncAppendWorker(workerArgs);
    else if (args.worker === "cursor-commit") result = await runCursorCommitWorker(workerArgs);
    else throw new Error(`Unknown worker: ${args.worker}`);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (!args.beforeRoot) {
    throw new Error("--before-root is required for a real before/after benchmark");
  }
  const beforeRoot = args.beforeRoot;
  if (path.resolve(beforeRoot) === path.resolve(repoRoot)) {
    throw new Error("--before-root and --repo-root must be different directories");
  }
  if (sourceFingerprint(beforeRoot) === sourceFingerprint(repoRoot)) {
    throw new Error("before/after source fingerprints must differ");
  }

  const corpusRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "tt-codex-hot-benchmark-"));
  try {
    createContextCorpus(corpusRoot);
    const before = runPhase(beforeRoot, corpusRoot, hashCount);
    const after = runPhase(repoRoot, corpusRoot, hashCount);
    const report = {
      schema_version: 2,
      deterministic_corpus: true,
      corpus: {
        context_files: CONTEXT_HISTORY_FILES + 1,
        sync_hash_count: hashCount,
      },
      before,
      after,
      comparison: buildComparison(before, after),
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await fsp.rm(corpusRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
