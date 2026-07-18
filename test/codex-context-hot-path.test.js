const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { computeCodexContextBreakdown: computeRawCodexContextBreakdown } = require(
  "../src/lib/codex-context-breakdown",
);

function computeCodexContextBreakdown(options = {}) {
  return computeRawCodexContextBreakdown({ ...options, includeDiagnostics: true });
}

async function writeRollout(rootDir, day, name, events, mtime = `${day}T12:00:00.000Z`) {
  const dir = path.join(rootDir, day.slice(0, 4), day.slice(5, 7), day.slice(8, 10));
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  const stamp = new Date(mtime);
  await fs.utimes(filePath, stamp, stamp);
  return filePath;
}

function tokenCount(timestamp, usage) {
  return {
    timestamp,
    type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: usage } },
  };
}

const BASELINE_USAGE = {
  input_tokens: 100,
  cached_input_tokens: 20,
  cache_creation_input_tokens: 2,
  output_tokens: 10,
  reasoning_output_tokens: 1,
  total_tokens: 112,
};

const TARGET_USAGE = {
  input_tokens: 160,
  cached_input_tokens: 35,
  cache_creation_input_tokens: 6,
  output_tokens: 22,
  reasoning_output_tokens: 5,
  total_tokens: 188,
};

function assertExactTargetDelta(result) {
  assert.deepEqual(result.totals, {
    input_tokens: 45,
    cached_input_tokens: 15,
    cache_creation_input_tokens: 4,
    output_tokens: 12,
    reasoning_output_tokens: 4,
    total_tokens: 76,
  });
  assert.equal(result.session_count, 1);
  assert.equal(result.message_count, 1);
}

function assertExactPendingBrowserAttribution(result) {
  const browser = result.tool_calls_breakdown.categories.find((row) => row.name === "Browser");
  assert.ok(browser, "the pending pre-range tool must be attributed to the first in-range delta");
  assert.equal(browser.calls, 1);
  assert.deepEqual(browser.totals, {
    input_tokens: 45,
    cached_input_tokens: 15,
    cache_creation_input_tokens: 4,
    output_tokens: 12,
    reasoning_output_tokens: 4,
    total_tokens: 76,
  });
  assert.deepEqual(browser.tools, [{
    name: "take_snapshot",
    calls: 1,
    totals: {
      input_tokens: 45,
      cached_input_tokens: 15,
      cache_creation_input_tokens: 4,
      output_tokens: 12,
      reasoning_output_tokens: 4,
      total_tokens: 76,
    },
  }]);
  assert.equal(result.tool_calls_breakdown.total_calls, 1);
  assert.equal(result.tool_calls_breakdown.tools_total, 76);
  assert.deepEqual(
    Object.fromEntries(result.message_breakdown.categories.map((row) => [row.key, row.totals])),
    {
      user_input: {
        input_tokens: 0,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: 0,
      },
      conversation_history: {
        input_tokens: 0,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: 0,
      },
      assistant_response: {
        input_tokens: 0,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: 0,
      },
    },
  );
}

function assertExactTextResponseBreakdown(result) {
  const text = result.tool_calls_breakdown.categories.find((row) => row.name === "Text Response");
  assert.ok(text);
  assert.equal(text.calls, 1);
  assert.deepEqual(text.totals, result.totals);
  assert.deepEqual(text.tools, [{ name: "text_response", calls: 1, totals: result.totals }]);
  assert.equal(result.tool_calls_breakdown.total_calls, 1);
  assert.equal(result.tool_calls_breakdown.tools_total, 76);
  assert.deepEqual(
    Object.fromEntries(result.message_breakdown.categories.map((row) => [row.key, row.totals])),
    {
      user_input: {
        input_tokens: 45,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: 45,
      },
      conversation_history: {
        input_tokens: 0,
        cached_input_tokens: 15,
        cache_creation_input_tokens: 4,
        output_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: 19,
      },
      assistant_response: {
        input_tokens: 0,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 8,
        reasoning_output_tokens: 0,
        total_tokens: 8,
      },
    },
  );
}

test("bounded Context prunes an unrelated historical rollout and reports per-call diagnostics", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-context-hot-"));
  try {
    await writeRollout(root, "2029-01-01", "rollout-old.jsonl", [
      tokenCount("2029-01-01T12:00:00.000Z", {
        input_tokens: 10,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 2,
        reasoning_output_tokens: 0,
        total_tokens: 12,
      }),
    ]);
    await writeRollout(root, "2030-01-02", "rollout-target.jsonl", [
      {
        timestamp: "2030-01-02T00:00:00.000Z",
        type: "session_meta",
        payload: { id: "target", cwd: "/tmp/project", model_provider: "openai" },
      },
      tokenCount("2030-01-02T01:00:00.000Z", {
        input_tokens: 60,
        cached_input_tokens: 15,
        cache_creation_input_tokens: 4,
        output_tokens: 12,
        reasoning_output_tokens: 4,
        total_tokens: 76,
      }),
    ]);

    const args = {
      from: "2030-01-02",
      to: "2030-01-02",
      codexDir: root,
      timeZoneContext: { timeZone: "UTC", offsetMinutes: 0 },
      nowMs: Date.now(),
    };
    const result = await computeCodexContextBreakdown(args);

    assert.deepEqual(result.totals, {
      input_tokens: 45,
      cached_input_tokens: 15,
      cache_creation_input_tokens: 4,
      output_tokens: 12,
      reasoning_output_tokens: 4,
      total_tokens: 76,
    });
    assert.equal(result.session_count, 1);
    assert.equal(result.message_count, 1);
    assertExactTextResponseBreakdown(result);
    const { bytes_read: bytesRead, ...diagnostics } = result.diagnostics;
    assert.ok(bytesRead > 0);
    assert.deepEqual(diagnostics, {
      cache_hit: false,
      full_metadata_audit: true,
      discovered_files: 2,
      candidate_files: 1,
      stat_calls: 2,
      metadata_cache_hits: 0,
      opened_files: 1,
      parsed_files: 1,
      parse_cache_hits: 0,
      incremental_parse_hits: 0,
      incremental_parse_fallbacks: 0,
      json_parse_calls: 2,
    });
    const exhaustive = await computeCodexContextBreakdown({ ...args, exhaustive: true });
    assert.deepEqual(result.totals, exhaustive.totals);
    assert.equal(exhaustive.diagnostics.opened_files, 2);
    assert.equal(exhaustive.diagnostics.parsed_files, 2);

    const warm = await computeCodexContextBreakdown({
      from: "2030-01-02",
      to: "2030-01-02",
      codexDir: root,
      timeZoneContext: { timeZone: "UTC", offsetMinutes: 0 },
    });
    assert.equal(warm.diagnostics.cache_hit, true);
    assert.equal(warm.diagnostics.opened_files, 0);
    assert.equal(warm.diagnostics.parsed_files, 0);
    assert.equal(warm.diagnostics.json_parse_calls, 0);
    assert.equal(warm.diagnostics.discovered_files, 2);
    assert.equal(warm.diagnostics.candidate_files, 1);
    assert.equal(warm.diagnostics.stat_calls, 1);
    assert.equal(warm.diagnostics.metadata_cache_hits, 1);

    const audited = await computeCodexContextBreakdown({
      ...args,
      nowMs: args.nowMs + 61_000,
    });
    assert.equal(audited.diagnostics.full_metadata_audit, true);
    assert.equal(audited.diagnostics.stat_calls, 2);
    assert.equal(audited.diagnostics.metadata_cache_hits, 0);
    assert.equal(audited.diagnostics.opened_files, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("bounded Context detects an old rollout rewritten with its historical mtime preserved", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-context-rewrite-"));
  try {
    const targetDay = new Date().toISOString().slice(0, 10);
    const targetAt = `${targetDay}T12:00:00.000Z`;
    const oldMtime = "2020-01-01T12:00:00.000Z";
    const filePath = await writeRollout(root, "2020-01-01", "rollout-rewrite.jsonl", [
      tokenCount("2020-01-01T12:00:00.000Z", BASELINE_USAGE),
    ], oldMtime);

    const before = await computeCodexContextBreakdown({
      from: targetDay,
      to: targetDay,
      codexDir: root,
      timeZoneContext: { timeZone: "UTC", offsetMinutes: 0 },
    });
    assert.equal(before.totals.total_tokens, 0);
    assert.equal(before.diagnostics.candidate_files, 1);

    await fs.writeFile(filePath, [
      tokenCount("2020-01-01T12:00:00.000Z", BASELINE_USAGE),
      tokenCount(targetAt, TARGET_USAGE),
    ].map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
    const stamp = new Date(oldMtime);
    await fs.utimes(filePath, stamp, stamp);

    const bounded = await computeCodexContextBreakdown({
      from: targetDay,
      to: targetDay,
      codexDir: root,
      timeZoneContext: { timeZone: "UTC", offsetMinutes: 0 },
    });
    assertExactTargetDelta(bounded);
    assert.equal(bounded.diagnostics.candidate_files, 1);
    assert.equal(bounded.diagnostics.opened_files, 1);

    const exhaustive = await computeCodexContextBreakdown({
      from: targetDay,
      to: targetDay,
      codexDir: root,
      timeZoneContext: { timeZone: "UTC", offsetMinutes: 0 },
      exhaustive: true,
    });
    assert.deepEqual(bounded.totals, exhaustive.totals);

    // A changed file must remain a conservative candidate across cache misses.
    // Changing `top` forces a cache miss without changing the corpus.
    const cacheMiss = await computeCodexContextBreakdown({
      from: targetDay,
      to: targetDay,
      codexDir: root,
      timeZoneContext: { timeZone: "UTC", offsetMinutes: 0 },
      top: 19,
    });
    assertExactTargetDelta(cacheMiss);
    assert.equal(cacheMiss.diagnostics.cache_hit, false);
    assert.equal(cacheMiss.diagnostics.candidate_files, 1);
    assert.equal(cacheMiss.diagnostics.opened_files, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("cold bounded Context includes an old-path rewrite with preserved mtime", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-context-cold-rewrite-"));
  try {
    const targetDay = new Date().toISOString().slice(0, 10);
    const targetAt = `${targetDay}T12:00:00.000Z`;
    await writeRollout(root, "2020-01-01", "rollout-cold-rewrite.jsonl", [
      tokenCount("2020-01-01T12:00:00.000Z", BASELINE_USAGE),
      tokenCount(targetAt, TARGET_USAGE),
    ], "2020-01-01T12:00:00.000Z");

    const args = {
      from: targetDay,
      to: targetDay,
      codexDir: root,
      timeZoneContext: { timeZone: "UTC", offsetMinutes: 0 },
    };
    const bounded = await computeCodexContextBreakdown(args);
    const exhaustive = await computeCodexContextBreakdown({ ...args, exhaustive: true });

    assertExactTargetDelta(bounded);
    assert.deepEqual(bounded.totals, exhaustive.totals);
    assert.equal(bounded.diagnostics.candidate_files, 1);
    assert.equal(bounded.diagnostics.opened_files, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("cross-midnight Context keeps cumulative baseline and pending tool state before the range", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-context-midnight-"));
  try {
    await writeRollout(root, "2030-06-01", "rollout-long.jsonl", [
      {
        timestamp: "2030-06-01T23:40:00.000Z",
        type: "session_meta",
        payload: { id: "long-session", cwd: "/tmp/project", model_provider: "openai" },
      },
      tokenCount("2030-06-01T23:50:00.000Z", BASELINE_USAGE),
      {
        timestamp: "2030-06-01T23:59:00.000Z",
        type: "response_item",
        payload: { type: "function_call", name: "take_snapshot", call_id: "pending", arguments: "{}" },
      },
      tokenCount("2030-06-02T00:05:00.000Z", TARGET_USAGE),
    ], "2030-06-02T00:06:00.000Z");

    const args = {
      from: "2030-06-02",
      to: "2030-06-02",
      codexDir: root,
      timeZoneContext: { timeZone: "UTC", offsetMinutes: 0 },
    };
    const bounded = await computeCodexContextBreakdown(args);
    assertExactTargetDelta(bounded);
    assertExactPendingBrowserAttribution(bounded);
    assert.equal(bounded.diagnostics.opened_files, 1);
    assert.equal(bounded.diagnostics.json_parse_calls, 4);

    const exhaustive = await computeCodexContextBreakdown({ ...args, exhaustive: true });
    assertExactTargetDelta(exhaustive);
    assert.deepEqual(bounded.totals, exhaustive.totals);
    assert.deepEqual(bounded.tool_calls_breakdown, exhaustive.tool_calls_breakdown);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Context local-day boundaries are exact in Asia/Shanghai and America/Los_Angeles", async (t) => {
  const scenarios = [
    {
      name: "Asia/Shanghai",
      pathDay: "2030-06-01",
      targetDay: "2030-06-02",
      baselineAt: "2030-06-01T15:30:00.000Z",
      pendingAt: "2030-06-01T15:45:00.000Z",
      targetAt: "2030-06-01T16:30:00.000Z",
      timeZoneContext: { timeZone: "Asia/Shanghai", offsetMinutes: -480 },
    },
    {
      name: "America/Los_Angeles",
      pathDay: "2030-05-31",
      targetDay: "2030-06-01",
      baselineAt: "2030-06-01T06:30:00.000Z",
      pendingAt: "2030-06-01T06:45:00.000Z",
      targetAt: "2030-06-01T07:30:00.000Z",
      timeZoneContext: { timeZone: "America/Los_Angeles", offsetMinutes: 420 },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-context-zone-"));
      try {
        await writeRollout(root, scenario.pathDay, `rollout-${scenario.name.replaceAll("/", "-")}.jsonl`, [
          tokenCount(scenario.baselineAt, BASELINE_USAGE),
          {
            timestamp: scenario.pendingAt,
            type: "response_item",
            payload: { type: "function_call", name: "take_snapshot", call_id: "pending", arguments: "{}" },
          },
          tokenCount(scenario.targetAt, TARGET_USAGE),
        ], scenario.targetAt);
        const args = {
          from: scenario.targetDay,
          to: scenario.targetDay,
          codexDir: root,
          timeZoneContext: scenario.timeZoneContext,
        };
        const bounded = await computeCodexContextBreakdown(args);
        const exhaustive = await computeCodexContextBreakdown({ ...args, exhaustive: true });
        assertExactTargetDelta(bounded);
        assertExactPendingBrowserAttribution(bounded);
        assert.deepEqual(bounded.totals, exhaustive.totals);
        assert.deepEqual(bounded.tool_calls_breakdown, exhaustive.tool_calls_breakdown);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("Context honors custom CODEX_HOME archives and unbounded total scans every rollout", async () => {
  const customHome = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-custom-home-"));
  const previous = process.env.CODEX_HOME;
  try {
    const sessions = path.join(customHome, "sessions");
    const archives = path.join(customHome, "archived_sessions");
    await writeRollout(sessions, "2030-05-31", "rollout-session.jsonl", [
      tokenCount("2030-05-31T10:00:00.000Z", {
        input_tokens: 10,
        cached_input_tokens: 2,
        cache_creation_input_tokens: 1,
        output_tokens: 3,
        reasoning_output_tokens: 1,
        total_tokens: 14,
      }),
    ]);
    await fs.mkdir(archives, { recursive: true });
    await fs.writeFile(path.join(archives, "rollout-2030-06-02-archive.jsonl"), `${JSON.stringify(
      tokenCount("2030-06-02T10:00:00.000Z", {
        input_tokens: 8,
        cached_input_tokens: 1,
        cache_creation_input_tokens: 0,
        output_tokens: 2,
        reasoning_output_tokens: 1,
        total_tokens: 10,
      }),
    )}\n`, "utf8");
    process.env.CODEX_HOME = customHome;

    const total = await computeCodexContextBreakdown();
    assert.deepEqual(total.totals, {
      input_tokens: 15,
      cached_input_tokens: 3,
      cache_creation_input_tokens: 1,
      output_tokens: 5,
      reasoning_output_tokens: 2,
      total_tokens: 24,
    });
    assert.equal(total.session_count, 2);
    assert.equal(total.message_count, 2);
    assert.equal(total.diagnostics.discovered_files, 2);
    assert.equal(total.diagnostics.candidate_files, 2);
    assert.equal(total.diagnostics.opened_files, 2);
    assert.equal(total.diagnostics.parsed_files, 2);

    const boundedArchive = await computeCodexContextBreakdown({
      from: "2030-06-02",
      to: "2030-06-02",
      timeZoneContext: { timeZone: "UTC", offsetMinutes: 0 },
    });
    assert.deepEqual(boundedArchive.totals, {
      input_tokens: 7,
      cached_input_tokens: 1,
      cache_creation_input_tokens: 0,
      output_tokens: 2,
      reasoning_output_tokens: 1,
      total_tokens: 10,
    });
    assert.equal(boundedArchive.session_count, 1);
    assert.equal(boundedArchive.message_count, 1);
    assert.equal(boundedArchive.diagnostics.discovered_files, 2);
    assert.equal(boundedArchive.diagnostics.candidate_files, 1);
    assert.equal(boundedArchive.diagnostics.opened_files, 1);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    await fs.rm(customHome, { recursive: true, force: true });
  }
});

test("bounded Context conservatively detects old-session append, inode replacement, and truncation", async (t) => {
  const mutations = ["append", "inode replacement", "truncation"];
  for (const mutation of mutations) {
    await t.test(mutation, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-context-mutation-"));
      try {
        const targetDay = new Date().toISOString().slice(0, 10);
        const targetAt = `${targetDay}T12:00:00.000Z`;
        const oldMtime = new Date("2020-01-01T12:00:00.000Z");
        const filePath = await writeRollout(root, "2020-01-01", `rollout-${mutation.replaceAll(" ", "-")}.jsonl`, [
          tokenCount("2020-01-01T12:00:00.000Z", BASELINE_USAGE),
        ], oldMtime.toISOString());
        const args = {
          from: targetDay,
          to: targetDay,
          codexDir: root,
          timeZoneContext: { timeZone: "UTC", offsetMinutes: 0 },
        };
        const primed = await computeCodexContextBreakdown(args);
        assert.equal(primed.diagnostics.candidate_files, 1);

        const targetLine = `${JSON.stringify(tokenCount(targetAt, TARGET_USAGE))}\n`;
        if (mutation === "append") {
          await fs.appendFile(filePath, targetLine, "utf8");
          const active = new Date(`${targetDay}T12:01:00.000Z`);
          await fs.utimes(filePath, active, active);
        } else {
          const content = [
            tokenCount("2020-01-01T12:00:00.000Z", BASELINE_USAGE),
            tokenCount(targetAt, TARGET_USAGE),
          ].map((event) => JSON.stringify(event)).join("\n") + "\n";
          if (mutation === "inode replacement") {
            const replacement = `${filePath}.replacement`;
            await fs.writeFile(replacement, content, "utf8");
            await fs.utimes(replacement, oldMtime, oldMtime);
            await fs.rename(replacement, filePath);
          } else {
            await fs.truncate(filePath, 0);
            await fs.writeFile(filePath, content, "utf8");
            await fs.utimes(filePath, oldMtime, oldMtime);
          }
        }

        const bounded = await computeCodexContextBreakdown(args);
        const exhaustive = await computeCodexContextBreakdown({ ...args, exhaustive: true });
        assertExactTargetDelta(bounded);
        assert.deepEqual(bounded.totals, exhaustive.totals);
        assert.equal(bounded.diagnostics.candidate_files, 1);
        assert.equal(bounded.diagnostics.opened_files, 1);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("a future-mtime decoy is conservatively opened without contaminating the bounded result", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-context-decoy-"));
  try {
    await writeRollout(root, "2029-01-01", "rollout-decoy.jsonl", [
      tokenCount("2029-01-01T12:00:00.000Z", BASELINE_USAGE),
    ], "2035-01-01T00:00:00.000Z");
    await writeRollout(root, "2030-06-02", "rollout-target.jsonl", [
      tokenCount("2030-06-02T01:00:00.000Z", {
        input_tokens: 60,
        cached_input_tokens: 15,
        cache_creation_input_tokens: 4,
        output_tokens: 12,
        reasoning_output_tokens: 4,
        total_tokens: 76,
      }),
    ], "2030-06-02T01:01:00.000Z");
    const args = {
      from: "2030-06-02",
      to: "2030-06-02",
      codexDir: root,
      timeZoneContext: { timeZone: "UTC", offsetMinutes: 0 },
    };
    const bounded = await computeCodexContextBreakdown(args);
    const exhaustive = await computeCodexContextBreakdown({ ...args, exhaustive: true });
    assertExactTargetDelta(bounded);
    assert.deepEqual(bounded.totals, exhaustive.totals);
    assert.equal(bounded.diagnostics.discovered_files, 2);
    assert.equal(bounded.diagnostics.candidate_files, 2);
    assert.equal(bounded.diagnostics.opened_files, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("bounded Context excludes sessions whose path and metadata are after the requested range", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-context-future-path-"));
  try {
    await writeRollout(root, "2030-06-05", "rollout-future.jsonl", [
      tokenCount("2030-06-05T01:00:00.000Z", {
        input_tokens: 50,
        cached_input_tokens: 10,
        cache_creation_input_tokens: 0,
        output_tokens: 5,
        reasoning_output_tokens: 1,
        total_tokens: 55,
      }),
    ]);

    const result = await computeCodexContextBreakdown({
      from: "2030-06-02",
      to: "2030-06-02",
      codexDir: root,
      timeZoneContext: { timeZone: "UTC", offsetMinutes: 0 },
    });

    assert.equal(result.totals.total_tokens, 0);
    assert.equal(result.diagnostics.candidate_files, 0);
    assert.equal(result.diagnostics.opened_files, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("bounded Context keeps an adjacent-day session after it was appended beyond the range", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-context-adjacent-day-"));
  try {
    await writeRollout(root, "2030-06-03", "rollout-adjacent.jsonl", [
      tokenCount("2030-06-02T23:30:00.000Z", {
        input_tokens: 60,
        cached_input_tokens: 15,
        cache_creation_input_tokens: 4,
        output_tokens: 12,
        reasoning_output_tokens: 4,
        total_tokens: 76,
      }),
      tokenCount("2030-06-03T12:00:00.000Z", {
        input_tokens: 90,
        cached_input_tokens: 20,
        cache_creation_input_tokens: 5,
        output_tokens: 18,
        reasoning_output_tokens: 6,
        total_tokens: 113,
      }),
    ], "2030-06-03T12:01:00.000Z");
    const args = {
      from: "2030-06-02",
      to: "2030-06-02",
      codexDir: root,
      timeZoneContext: { timeZone: "UTC", offsetMinutes: 0 },
    };

    const bounded = await computeCodexContextBreakdown(args);
    const exhaustive = await computeCodexContextBreakdown({ ...args, exhaustive: true });

    assertExactTargetDelta(bounded);
    assert.deepEqual(bounded.totals, exhaustive.totals);
    assert.equal(bounded.diagnostics.candidate_files, 1);
    assert.equal(bounded.diagnostics.opened_files, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("bounded Context uses conservative timezone bounds when only an IANA zone is provided", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-context-iana-zone-"));
  try {
    await writeRollout(root, "2030-06-01", "rollout-shanghai.jsonl", [
      tokenCount("2030-06-01T16:30:00.000Z", {
        input_tokens: 60,
        cached_input_tokens: 15,
        cache_creation_input_tokens: 4,
        output_tokens: 12,
        reasoning_output_tokens: 4,
        total_tokens: 76,
      }),
    ], "2030-06-01T16:31:00.000Z");

    const result = await computeCodexContextBreakdown({
      from: "2030-06-02",
      to: "2030-06-02",
      codexDir: root,
      timeZoneContext: { timeZone: "Asia/Shanghai", offsetMinutes: null },
    });

    assertExactTargetDelta(result);
    assert.equal(result.diagnostics.candidate_files, 1);
    assert.equal(result.diagnostics.opened_files, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Context reuses frozen parsed sessions when one active session changes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-context-parse-cache-"));
  try {
    const stablePath = await writeRollout(
      root,
      "2030-06-02",
      "rollout-2030-06-02T01-00-00-11111111-1111-4111-8111-111111111111.jsonl",
      [
      tokenCount("2030-06-02T01:00:00.000Z", {
        input_tokens: 20,
        cached_input_tokens: 5,
        cache_creation_input_tokens: 0,
        output_tokens: 4,
        reasoning_output_tokens: 1,
        total_tokens: 24,
      }),
      ],
    );
    const activePath = await writeRollout(
      root,
      "2030-06-02",
      "rollout-2030-06-02T02-00-00-22222222-2222-4222-8222-222222222222.jsonl",
      [
      tokenCount("2030-06-02T02:00:00.000Z", {
        input_tokens: 30,
        cached_input_tokens: 5,
        cache_creation_input_tokens: 0,
        output_tokens: 5,
        reasoning_output_tokens: 1,
        total_tokens: 35,
      }),
      ],
    );
    const args = {
      from: "2030-06-02",
      to: "2030-06-02",
      codexDir: root,
      timeZoneContext: { timeZone: "UTC", offsetMinutes: 0 },
    };
    const first = await computeCodexContextBreakdown(args);
    assert.equal(first.diagnostics.opened_files, 2);

    await new Promise((resolve) => setTimeout(resolve, 10));
    await fs.writeFile(activePath, [
      tokenCount("2030-06-02T02:00:00.000Z", {
        input_tokens: 30,
        cached_input_tokens: 5,
        cache_creation_input_tokens: 0,
        output_tokens: 5,
        reasoning_output_tokens: 1,
        total_tokens: 35,
      }),
      tokenCount("2030-06-02T03:00:00.000Z", {
        input_tokens: 45,
        cached_input_tokens: 10,
        cache_creation_input_tokens: 0,
        output_tokens: 9,
        reasoning_output_tokens: 2,
        total_tokens: 54,
      }),
    ].map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");

    const second = await computeCodexContextBreakdown(args);
    assert.equal(second.diagnostics.opened_files, 1);
    assert.equal(second.diagnostics.parsed_files, 1);
    assert.equal(second.diagnostics.parse_cache_hits, 1);
    assert.equal(second.diagnostics.incremental_parse_hits, 1);
    assert.equal(second.diagnostics.incremental_parse_fallbacks, 0);
    assert.equal(second.diagnostics.json_parse_calls, 1);
    assert.ok(second.diagnostics.bytes_read < first.diagnostics.bytes_read);
    assert.ok(stablePath);
    assert.equal(second.totals.total_tokens, 78);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Context incrementally parses append-only sessions with pending tools and duplicate boundaries", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-context-incremental-"));
  const freshRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-context-incremental-fresh-"));
  try {
    const fileName =
      "rollout-2030-06-01T23-40-00-33333333-3333-4333-8333-333333333333.jsonl";
    const filePath = await writeRollout(
      root,
      "2030-06-01",
      fileName,
      [
        {
          timestamp: "2030-06-01T23:40:00.000Z",
          type: "session_meta",
          payload: {
            id: "33333333-3333-4333-8333-333333333333",
            cwd: "/tmp/project",
            model_provider: "openai",
          },
        },
        tokenCount("2030-06-01T23:50:00.000Z", BASELINE_USAGE),
        {
          timestamp: "2030-06-01T23:59:00.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "take_snapshot",
            call_id: "pending",
            arguments: "{}",
          },
        },
        {
          timestamp: "2030-06-01T23:59:10.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            call_id: "pending-exec",
            arguments: JSON.stringify({
              cmd: "sed -n '1,120p' /tmp/.codex/skills/frontend-design/SKILL.md",
            }),
          },
        },
        {
          timestamp: "2030-06-01T23:59:20.000Z",
          type: "event_msg",
          payload: {
            type: "exec_command_end",
            command: ["bash", "-lc", "sed -n '1,120p' /tmp/.codex/skills/frontend-design/SKILL.md"],
            status: "completed",
            exit_code: 0,
            duration: { secs: 0, nanos: 10_000_000 },
            aggregated_output: "skill body\n",
          },
        },
      ],
      "2030-06-02T00:00:00.000Z",
    );
    const args = {
      from: "2030-06-02",
      to: "2030-06-02",
      codexDir: root,
      timeZoneContext: { timeZone: "UTC", offsetMinutes: 0 },
    };
    const primed = await computeCodexContextBreakdown(args);
    assert.equal(primed.totals.total_tokens, 0);

    const appendedLine = `${JSON.stringify(
      tokenCount("2030-06-02T00:05:00.000Z", TARGET_USAGE),
    )}\n`;
    await fs.appendFile(filePath, appendedLine, "utf8");
    await fs.utimes(
      filePath,
      new Date("2030-06-02T00:06:00.000Z"),
      new Date("2030-06-02T00:06:00.000Z"),
    );
    const appended = await computeCodexContextBreakdown(args);
    const freshPath = await writeRollout(freshRoot, "2030-06-01", fileName, []);
    await fs.copyFile(filePath, freshPath);
    const active = new Date("2030-06-02T00:06:00.000Z");
    await fs.utimes(freshPath, active, active);
    const fresh = await computeCodexContextBreakdown({ ...args, codexDir: freshRoot });
    assertExactTargetDelta(appended);
    assert.deepEqual(appended.tool_calls_breakdown, fresh.tool_calls_breakdown);
    assert.deepEqual(appended.skills_breakdown, fresh.skills_breakdown);
    assert.deepEqual(appended.exec_command_breakdown, fresh.exec_command_breakdown);
    assert.equal(appended.skills_breakdown.skills[0]?.name, "frontend-design");
    assert.ok(appended.exec_command_breakdown.by_command.length > 0);
    assert.equal(appended.diagnostics.incremental_parse_hits, 1);
    assert.equal(appended.diagnostics.incremental_parse_fallbacks, 0);
    assert.equal(appended.diagnostics.json_parse_calls, 1);
    assert.equal(appended.diagnostics.bytes_read, Buffer.byteLength(appendedLine));

    await fs.appendFile(filePath, appendedLine, "utf8");
    await fs.utimes(
      filePath,
      new Date("2030-06-02T00:07:00.000Z"),
      new Date("2030-06-02T00:07:00.000Z"),
    );
    const duplicate = await computeCodexContextBreakdown(args);
    assert.deepEqual(duplicate.totals, appended.totals);
    assert.equal(duplicate.message_count, appended.message_count);
    assert.equal(duplicate.diagnostics.incremental_parse_hits, 1);
    assert.equal(duplicate.diagnostics.incremental_parse_fallbacks, 0);
    assert.equal(duplicate.diagnostics.json_parse_calls, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(freshRoot, { recursive: true, force: true });
  }
});

test("Context requires an unchanged newline-terminated prefix before resuming", async (t) => {
  const scenarios = ["prefix rewrite", "incomplete record"];
  for (const scenario of scenarios) {
    await t.test(scenario, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-context-resume-guard-"));
      const freshRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-context-resume-guard-fresh-"));
      try {
        const fileName =
          "rollout-2030-06-01T23-50-00-55555555-5555-4555-8555-555555555555.jsonl";
        const filePath = await writeRollout(root, "2030-06-01", fileName, [
          tokenCount("2030-06-01T23:50:00.000Z", BASELINE_USAGE),
        ], "2030-06-02T00:00:00.000Z");
        if (scenario === "incomplete record") {
          const stat = await fs.stat(filePath);
          await fs.truncate(filePath, stat.size - 1);
          const primedAt = new Date("2030-06-02T00:00:00.000Z");
          await fs.utimes(filePath, primedAt, primedAt);
        }

        const args = {
          from: "2030-06-02",
          to: "2030-06-02",
          codexDir: root,
          timeZoneContext: { timeZone: "UTC", offsetMinutes: 0 },
        };
        const primed = await computeCodexContextBreakdown(args);
        assert.equal(primed.totals.total_tokens, 0);

        const targetLine = `${JSON.stringify(
          tokenCount("2030-06-02T00:05:00.000Z", TARGET_USAGE),
        )}\n`;
        if (scenario === "prefix rewrite") {
          const content = await fs.readFile(filePath, "utf8");
          assert.match(content, /"input_tokens":100/);
          await fs.writeFile(
            filePath,
            `${content.replace('"input_tokens":100', '"input_tokens":101')}${targetLine}`,
            "utf8",
          );
        } else {
          await fs.appendFile(filePath, `\n${targetLine}`, "utf8");
        }
        const active = new Date("2030-06-02T00:06:00.000Z");
        await fs.utimes(filePath, active, active);

        const guarded = await computeCodexContextBreakdown(args);
        const freshPath = await writeRollout(freshRoot, "2030-06-01", fileName, []);
        await fs.copyFile(filePath, freshPath);
        await fs.utimes(freshPath, active, active);
        const fresh = await computeCodexContextBreakdown({ ...args, codexDir: freshRoot });

        assert.deepEqual(guarded.totals, fresh.totals);
        assert.deepEqual(guarded.tool_calls_breakdown, fresh.tool_calls_breakdown);
        assert.equal(guarded.message_count, fresh.message_count);
        assert.equal(guarded.diagnostics.incremental_parse_hits, 0);
        assert.equal(guarded.diagnostics.incremental_parse_fallbacks, 0);
        assert.equal(guarded.diagnostics.opened_files, 1);
        assert.equal(guarded.diagnostics.bytes_read, (await fs.stat(filePath)).size);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
        await fs.rm(freshRoot, { recursive: true, force: true });
      }
    });
  }
});

test("Context abandons an incremental parse when appended token timestamps move backwards", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-context-resume-fallback-"));
  const freshRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-context-resume-fresh-"));
  try {
    const fileName =
      "rollout-2030-06-02T00-00-00-44444444-4444-4444-8444-444444444444.jsonl";
    const filePath = await writeRollout(root, "2030-06-02", fileName, [
      tokenCount("2030-06-02T00:05:00.000Z", BASELINE_USAGE),
      tokenCount("2030-06-02T01:00:00.000Z", TARGET_USAGE),
    ]);
    const args = {
      from: "2030-06-02",
      to: "2030-06-02",
      codexDir: root,
      timeZoneContext: { timeZone: "UTC", offsetMinutes: 0 },
    };
    await computeCodexContextBreakdown(args);

    await fs.appendFile(filePath, `${JSON.stringify(tokenCount(
      "2030-06-02T00:30:00.000Z",
      {
        input_tokens: 200,
        cached_input_tokens: 40,
        cache_creation_input_tokens: 8,
        output_tokens: 30,
        reasoning_output_tokens: 7,
        total_tokens: 238,
      },
    ))}\n`, "utf8");

    const resumed = await computeCodexContextBreakdown(args);
    const freshPath = await writeRollout(
      freshRoot,
      "2030-06-02",
      fileName,
      [],
    );
    await fs.copyFile(filePath, freshPath);
    const fresh = await computeCodexContextBreakdown({ ...args, codexDir: freshRoot });

    assert.deepEqual(resumed.totals, fresh.totals);
    assert.deepEqual(resumed.tool_calls_breakdown, fresh.tool_calls_breakdown);
    assert.equal(resumed.diagnostics.incremental_parse_hits, 0);
    assert.equal(resumed.diagnostics.incremental_parse_fallbacks, 1);
    assert.equal(resumed.diagnostics.opened_files, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(freshRoot, { recursive: true, force: true });
  }
});

test("Context de-duplicates one session while it overlaps live and archived roots", async () => {
  const customHome = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-context-overlap-"));
  const previous = process.env.CODEX_HOME;
  try {
    const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const fileName = `rollout-2030-06-02T00-00-00-${sessionId}.jsonl`;
    const baseline = tokenCount("2030-06-02T00:05:00.000Z", {
      input_tokens: 10,
      cached_input_tokens: 2,
      cache_creation_input_tokens: 0,
      output_tokens: 3,
      reasoning_output_tokens: 1,
      total_tokens: 13,
    });
    const target = tokenCount("2030-06-02T00:10:00.000Z", {
      input_tokens: 20,
      cached_input_tokens: 4,
      cache_creation_input_tokens: 1,
      output_tokens: 5,
      reasoning_output_tokens: 2,
      total_tokens: 26,
    });
    const meta = {
      timestamp: "2030-06-02T00:00:00.000Z",
      type: "session_meta",
      payload: { id: sessionId, cwd: "/tmp/project", model_provider: "openai" },
    };
    await writeRollout(path.join(customHome, "archived_sessions"), "2030-06-02", fileName, [meta, baseline]);
    await writeRollout(path.join(customHome, "sessions"), "2030-06-02", fileName, [meta, baseline, target]);
    process.env.CODEX_HOME = customHome;

    const result = await computeCodexContextBreakdown();
    assert.deepEqual(result.totals, {
      input_tokens: 16,
      cached_input_tokens: 4,
      cache_creation_input_tokens: 1,
      output_tokens: 5,
      reasoning_output_tokens: 2,
      total_tokens: 26,
    });
    assert.equal(result.session_count, 1);
    assert.equal(result.message_count, 2);
    assert.equal(result.diagnostics.discovered_files, 2);
    assert.equal(result.diagnostics.opened_files, 2);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    await fs.rm(customHome, { recursive: true, force: true });
  }
});

test("Context merges split and suffix-only live/archive fragments by event time", async (t) => {
  const scenarios = [
    { name: "split prefix and suffix", archiveEvents: ["baseline"], liveEvents: ["target"] },
    { name: "suffix archive and full live", archiveEvents: ["target"], liveEvents: ["baseline", "target"] },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const customHome = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-context-fragments-"));
      const previous = process.env.CODEX_HOME;
      try {
        const sessionId = "11111111-2222-3333-4444-555555555555";
        const fileName = `rollout-2030-06-02T00-00-00-${sessionId}.jsonl`;
        const meta = {
          timestamp: "2030-06-02T00:00:00.000Z",
          type: "session_meta",
          payload: { id: sessionId, cwd: "/tmp/project", model_provider: "openai" },
        };
        const events = {
          baseline: tokenCount("2030-06-02T00:05:00.000Z", {
            input_tokens: 10,
            cached_input_tokens: 2,
            cache_creation_input_tokens: 0,
            output_tokens: 3,
            reasoning_output_tokens: 1,
            total_tokens: 13,
          }),
          target: tokenCount("2030-06-02T00:10:00.000Z", {
            input_tokens: 20,
            cached_input_tokens: 4,
            cache_creation_input_tokens: 1,
            output_tokens: 5,
            reasoning_output_tokens: 2,
            total_tokens: 26,
          }),
        };
        const materialize = (names) => [meta, ...names.map((name) => events[name])];
        await writeRollout(
          path.join(customHome, "archived_sessions"),
          "2030-06-02",
          fileName,
          materialize(scenario.archiveEvents),
        );
        await writeRollout(
          path.join(customHome, "sessions"),
          "2030-06-02",
          fileName,
          materialize(scenario.liveEvents),
        );
        process.env.CODEX_HOME = customHome;

        const result = await computeCodexContextBreakdown();
        assert.deepEqual(result.totals, {
          input_tokens: 16,
          cached_input_tokens: 4,
          cache_creation_input_tokens: 1,
          output_tokens: 5,
          reasoning_output_tokens: 2,
          total_tokens: 26,
        });
        assert.equal(result.session_count, 1);
        assert.equal(result.message_count, 2);
        assert.equal(result.diagnostics.opened_files, 2);
        assert.equal(result.diagnostics.parsed_files, 2);
      } finally {
        if (previous === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = previous;
        await fs.rm(customHome, { recursive: true, force: true });
      }
    });
  }
});

test("a to-only Context range stays conservative for a later path containing an older event", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-context-to-only-"));
  try {
    await writeRollout(root, "2031-06-05", "rollout-later-path.jsonl", [
      tokenCount("2030-06-02T01:00:00.000Z", {
        input_tokens: 60,
        cached_input_tokens: 15,
        cache_creation_input_tokens: 4,
        output_tokens: 12,
        reasoning_output_tokens: 4,
        total_tokens: 76,
      }),
    ]);
    const args = {
      to: "2030-06-02",
      codexDir: root,
      timeZoneContext: { timeZone: "UTC", offsetMinutes: 0 },
    };
    const bounded = await computeCodexContextBreakdown(args);
    const exhaustive = await computeCodexContextBreakdown({ ...args, exhaustive: true });
    assertExactTargetDelta(bounded);
    assert.deepEqual(bounded.totals, exhaustive.totals);
    assert.equal(bounded.diagnostics.candidate_files, 1);
    assert.equal(bounded.diagnostics.opened_files, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Context diagnostics count both rollout-line and exec argument JSON.parse calls", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-context-json-parse-"));
  try {
    await writeRollout(root, "2030-06-02", "rollout-exec.jsonl", [
      {
        timestamp: "2030-06-02T00:01:00.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "exec-1",
          arguments: JSON.stringify({ cmd: "npm test" }),
        },
      },
      tokenCount("2030-06-02T00:02:00.000Z", {
        input_tokens: 60,
        cached_input_tokens: 15,
        cache_creation_input_tokens: 4,
        output_tokens: 12,
        reasoning_output_tokens: 4,
        total_tokens: 76,
      }),
    ]);
    const result = await computeCodexContextBreakdown({
      from: "2030-06-02",
      to: "2030-06-02",
      codexDir: root,
      timeZoneContext: { timeZone: "UTC", offsetMinutes: 0 },
    });
    assertExactTargetDelta(result);
    assert.equal(result.diagnostics.opened_files, 1);
    assert.equal(result.diagnostics.parsed_files, 1);
    assert.equal(result.diagnostics.json_parse_calls, 3, "two JSONL lines plus one exec arguments parse");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
