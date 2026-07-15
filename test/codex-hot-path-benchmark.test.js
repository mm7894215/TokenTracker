const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

test("Codex hot-path benchmark reports comparable before/after metrics from one corpus", () => {
  const repoRoot = path.resolve(__dirname, "..");
  const script = path.join(repoRoot, "scripts", "benchmark-codex-hot-paths.js");
  const invalid = spawnSync(process.execPath, [
    script,
    `--repo-root=${repoRoot}`,
    `--before-root=${repoRoot}`,
    "--hash-count=10",
  ], { cwd: repoRoot, encoding: "utf8" });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /must be different directories/);

  const beforeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tt-codex-benchmark-before-"));
  fs.cpSync(path.join(repoRoot, "src"), path.join(beforeRoot, "src"), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "package.json"), path.join(beforeRoot, "package.json"));
  try {
  const sameSource = spawnSync(process.execPath, [
    script,
    `--repo-root=${repoRoot}`,
    `--before-root=${beforeRoot}`,
    "--hash-count=10",
  ], { cwd: repoRoot, encoding: "utf8" });
  assert.notEqual(sameSource.status, 0);
  assert.match(sameSource.stderr, /source fingerprints must differ/);
  fs.appendFileSync(
    path.join(beforeRoot, "src", "lib", "codex-rollout-parser.js"),
    "\n// Distinct benchmark baseline marker.\n",
  );

  const child = spawnSync(process.execPath, [
    script,
    `--repo-root=${repoRoot}`,
    `--before-root=${beforeRoot}`,
    "--hash-count=1000",
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });

  assert.equal(child.status, 0, child.stderr || child.stdout);
  const report = JSON.parse(child.stdout);
  assert.equal(report.schema_version, 2);
  assert.equal(report.deterministic_corpus, true);
  for (const phase of ["before", "after"]) {
    assert.ok(report[phase], `${phase} metrics are required`);
    assert.match(report[phase].source_fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(report[phase].context.bounded.corpus_files, 33);
    assert.equal(typeof report[phase].context.bounded.wall_ms, "number");
    assert.equal(typeof report[phase].context.bounded.cold_wall_ms, "number");
    assert.equal(typeof report[phase].context.bounded.warm_wall_ms, "number");
    assert.equal(typeof report[phase].context.bounded.diagnostics.opened_files, "number");
    assert.equal(typeof report[phase].context.bounded.diagnostics.parsed_files, "number");
    assert.equal(typeof report[phase].context.bounded.diagnostics.json_parse_calls, "number");
    assert.equal(typeof report[phase].context.bounded.warm.observed.readdir_calls, "number");
    assert.equal(typeof report[phase].context.bounded.warm.observed.stat_calls, "number");
    assert.equal(report[phase].sync.idle_large_state.production_equivalent.hash_count, 1000);
    assert.equal(report[phase].sync.idle_large_state.discovered_rollouts, 64);
    assert.equal(report[phase].sync.idle_large_state.corpus_files_on_disk, 64);
    assert.equal(report[phase].sync.idle_large_state.cursor_keys, 64);
    assert.equal(report[phase].sync.idle_large_state.cold_skipped, 63);
    assert.equal(report[phase].sync.idle_large_state.parse_candidates, 1);
    assert.ok(
      report[phase].sync.idle_large_state.cold_skipped <=
        report[phase].sync.idle_large_state.discovered_rollouts,
    );
    assert.equal(typeof report[phase].sync.idle_large_state.observed.hash_set_constructions, "number");
    assert.equal(typeof report[phase].sync.idle_large_state.observed.hash_array_materializations, "number");
    assert.equal(typeof report[phase].sync.idle_large_state.observed.hash_array_iterator_reads, "number");
    assert.equal(typeof report[phase].sync.idle_large_state.observed.hash_array_index_reads, "number");
    assert.equal(typeof report[phase].sync.idle_large_state.observed.hash_array_copy_method_reads, "number");
    assert.equal(report[phase].sync.active_append.production_equivalent.hash_count, 1000);
    assert.equal(report[phase].sync.active_append.result.eventsAggregated, 1);
    assert.equal(typeof report[phase].sync.active_append.observed.hash_set_constructions, "number");
    assert.equal(typeof report[phase].sync.active_append.observed.hash_array_materializations, "number");
    assert.equal(typeof report[phase].sync.cursor_commit.observed.cursor_commits, "number");
    assert.equal(typeof report[phase].sync.cursor_commit.observed.cursor_bytes, "number");
  }
  assert.deepEqual(report.comparison.context.bounded_opened_files, {
    before: report.before.context.bounded.diagnostics.opened_files,
    after: report.after.context.bounded.diagnostics.opened_files,
    delta: 0,
  });
  assert.equal(typeof report.comparison.context.warm_readdir_calls.delta, "number");
  assert.equal(typeof report.comparison.context.warm_stat_calls.delta, "number");
  assert.equal(typeof report.comparison.context.bounded_cold_wall_ms.delta, "number");
  assert.equal(typeof report.comparison.context.bounded_warm_wall_ms.delta, "number");
  assert.equal(typeof report.comparison.sync.append_wall_ms.delta, "number");
  assert.equal(typeof report.comparison.sync.append_hash_set_constructions.delta, "number");
  assert.equal(typeof report.comparison.sync.append_hash_array_materializations.delta, "number");
  assert.equal(report.comparison.sync.cursor_payload_equal, true);
  assert.notEqual(report.before.source_fingerprint, report.after.source_fingerprint);
  assert.equal(
    report.before.sync.cursor_commit.persisted_cursor_sha256,
    report.after.sync.cursor_commit.persisted_cursor_sha256,
  );
  } finally {
    fs.rmSync(beforeRoot, { recursive: true, force: true });
  }
});
