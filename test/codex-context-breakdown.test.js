const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { computeCodexContextBreakdown } = require("../src/lib/codex-context-breakdown");

async function makeTmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

async function writeRollout(rootDir, day, fileName, events) {
  const targetDir = path.join(rootDir, day.slice(0, 4), day.slice(5, 7), day.slice(8, 10));
  await fs.mkdir(targetDir, { recursive: true });
  const filePath = path.join(targetDir, fileName);
  await fs.writeFile(filePath, events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
  return filePath;
}

test("computeCodexContextBreakdown returns non-overlapping totals plus exec drill-downs", async () => {
  const dir = await makeTmpDir("tt-codex-breakdown");
  try {
    const day = "2026-05-08";
    await writeRollout(dir, day, "rollout-a.jsonl", [
      {
        timestamp: "2026-05-08T10:00:00.000Z",
        type: "session_meta",
        payload: { id: "s1", cwd: "/tmp/project", model_provider: "openai", cli_version: "1.0.0" },
      },
      {
        timestamp: "2026-05-08T10:00:01.000Z",
        type: "turn_context",
        payload: { cwd: "/tmp/project", model: "gpt-5.5" },
      },
      {
        timestamp: "2026-05-08T10:00:02.000Z",
        type: "response_item",
        payload: { type: "function_call", name: "exec_command", call_id: "call-1", arguments: "{\"cmd\":\"npm test\"}" },
      },
      {
        timestamp: "2026-05-08T10:00:03.000Z",
        type: "event_msg",
        payload: {
          type: "exec_command_end",
          command: ["bash", "-lc", "npm test"],
          status: "completed",
          exit_code: 0,
          duration: { secs: 2, nanos: 0 },
          aggregated_output: "ok\npass\n",
        },
      },
      {
        timestamp: "2026-05-08T10:00:04.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 300,
              cached_input_tokens: 100,
              cache_creation_input_tokens: 50,
              output_tokens: 200,
              reasoning_output_tokens: 30,
              total_tokens: 650,
            },
          },
        },
      },
      {
        timestamp: "2026-05-08T10:01:00.000Z",
        type: "response_item",
        payload: { type: "function_call", name: "take_snapshot", call_id: "call-2", arguments: "{}" },
      },
      {
        timestamp: "2026-05-08T10:01:01.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 420,
              cached_input_tokens: 130,
              cache_creation_input_tokens: 60,
              output_tokens: 280,
              reasoning_output_tokens: 50,
              total_tokens: 890,
            },
          },
        },
      },
      {
        timestamp: "2026-05-08T10:02:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 500,
              cached_input_tokens: 150,
              cache_creation_input_tokens: 70,
              output_tokens: 320,
              reasoning_output_tokens: 60,
              total_tokens: 1040,
            },
          },
        },
      },
    ]);

    const result = await computeCodexContextBreakdown({
      from: day,
      to: day,
      codexDir: dir,
      top: 20,
    });

    assert.equal(result.scope, "supported");
    assert.equal(result.source, "codex");
    assert.equal(result.session_count, 1);
    assert.equal(result.message_count, 3);

    assert.equal(result.totals.input_tokens, 350);
    assert.equal(result.totals.cached_input_tokens, 150);
    assert.equal(result.totals.cache_creation_input_tokens, 70);
    assert.equal(result.totals.output_tokens, 320);
    assert.equal(result.totals.reasoning_output_tokens, 60);
    assert.equal(result.totals.total_tokens, 890);

    const executionCategory = result.tool_calls_breakdown.categories.find((row) => row.name === "Execution");
    assert.ok(executionCategory, "Execution category should be present");
    assert.ok(executionCategory.tools.some((row) => row.name === "exec_command"));

    const browserCategory = result.tool_calls_breakdown.categories.find((row) => row.name === "Browser");
    assert.ok(browserCategory, "Browser category should be present");
    assert.ok(browserCategory.tools.some((row) => row.name === "take_snapshot"));

    const execByType = result.exec_command_breakdown.by_type.find((row) => row.name === "test");
    assert.ok(execByType, "exec breakdown should include grouped command types");
    assert.equal(execByType.calls, 1);
    assert.equal(execByType.failures, 0);

    const execByExecutable = result.exec_command_breakdown.by_executable.find((row) => row.name === "npm");
    assert.ok(execByExecutable, "exec breakdown should include executable grouping");
    assert.equal(execByExecutable.calls, 1);

    const execByCommand = result.exec_command_breakdown.by_command.find((row) => row.name === "npm test");
    assert.ok(execByCommand, "exec breakdown should include sanitized command grouping");
    assert.equal(execByCommand.calls, 1);

    const execByDuration = result.exec_command_breakdown.by_duration.find((row) => row.name === "1-10s");
    assert.ok(execByDuration, "exec breakdown should include duration buckets");
    assert.equal(execByDuration.calls, 1);

    const execByOutput = result.exec_command_breakdown.by_output.find((row) => row.name === "small");
    assert.ok(execByOutput, "exec breakdown should include output size buckets");
    assert.equal(execByOutput.calls, 1);

    const execByExit = result.exec_command_breakdown.by_exit.find((row) => row.name === "completed:0");
    assert.ok(execByExit, "exec breakdown should include grouped exits");
    assert.equal(execByExit.calls, 1);
    assert.equal(execByExit.failures, 0);

    const toolTotal = result.tool_calls_breakdown.categories.reduce(
      (sum, row) => sum + Number(row.totals.total_tokens || 0),
      0,
    );
    assert.ok(toolTotal <= result.totals.total_tokens, "tool attribution should not exceed session total");

    const messageRows = result.message_breakdown.categories;
    const nonTextToolTotal = result.tool_calls_breakdown.categories.reduce((sum, row) => {
      if (row.name === "Text Response") return sum;
      return sum + Number(row.totals.total_tokens || 0);
    }, 0);
    const messageTotal = messageRows.reduce((sum, row) => sum + Number(row.totals.total_tokens || 0), 0);
    assert.equal(messageTotal, result.totals.total_tokens - result.totals.reasoning_output_tokens - nonTextToolTotal);
    assert.ok(messageRows.find((row) => row.key === "user_input").totals.total_tokens > 0);
    assert.ok(messageRows.find((row) => row.key === "conversation_history").totals.total_tokens > 0);
    assert.ok(messageRows.find((row) => row.key === "assistant_response").totals.total_tokens > 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("computeCodexContextBreakdown supports nested payload.msg token_count events", async () => {
  const dir = await makeTmpDir("tt-codex-breakdown-msg-token-count");
  try {
    const day = "2026-05-08";
    await writeRollout(dir, day, "rollout-msg-token-count.jsonl", [
      {
        timestamp: "2026-05-08T11:30:00.000Z",
        type: "session_meta",
        payload: { id: "s-msg", cwd: "/tmp/project", model_provider: "openai", cli_version: "1.0.0" },
      },
      {
        timestamp: "2026-05-08T11:30:01.000Z",
        type: "response_item",
        payload: { type: "function_call", name: "take_snapshot", call_id: "call-msg-1", arguments: "{}" },
      },
      {
        timestamp: "2026-05-08T11:30:02.000Z",
        type: "event_msg",
        payload: {
          msg: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 50,
                cached_input_tokens: 10,
                cache_creation_input_tokens: 0,
                output_tokens: 25,
                reasoning_output_tokens: 5,
                total_tokens: 90,
              },
            },
          },
        },
      },
    ]);

    const result = await computeCodexContextBreakdown({
      from: day,
      to: day,
      codexDir: dir,
      top: 20,
    });

    assert.equal(result.totals.total_tokens, 75);
    const browserCategory = result.tool_calls_breakdown.categories.find((row) => row.name === "Browser");
    assert.ok(browserCategory, "Browser category should be present for nested token_count payloads");
    assert.ok(browserCategory.tools.some((row) => row.name === "take_snapshot"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("computeCodexContextBreakdown filters by requested local day", async () => {
  const dir = await makeTmpDir("tt-codex-breakdown-local-day");
  try {
    await writeRollout(dir, "2026-05-08", "rollout-local-day.jsonl", [
      {
        timestamp: "2026-05-08T15:30:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 20,
              cache_creation_input_tokens: 0,
              output_tokens: 10,
              reasoning_output_tokens: 0,
              total_tokens: 110,
            },
          },
        },
      },
      {
        timestamp: "2026-05-08T16:30:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 200,
              cached_input_tokens: 40,
              cache_creation_input_tokens: 0,
              output_tokens: 30,
              reasoning_output_tokens: 0,
              total_tokens: 230,
            },
          },
        },
      },
    ]);

    const result = await computeCodexContextBreakdown({
      from: "2026-05-09",
      to: "2026-05-09",
      codexDir: dir,
      timeZoneContext: { timeZone: "Asia/Shanghai", offsetMinutes: -480 },
    });

    assert.equal(result.totals.input_tokens, 160);
    assert.equal(result.totals.cached_input_tokens, 40);
    assert.equal(result.totals.output_tokens, 30);
    assert.equal(result.totals.total_tokens, 230);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("computeCodexContextBreakdown sanitizes command grouping without arguments", async () => {
  const dir = await makeTmpDir("tt-codex-breakdown-sanitize");
  try {
    const day = "2026-05-08";
    await writeRollout(dir, day, "rollout-sanitize.jsonl", [
      {
        timestamp: "2026-05-08T12:00:00.000Z",
        type: "session_meta",
        payload: { id: "s-sanitize", cwd: "/tmp/project", model_provider: "openai", cli_version: "1.0.0" },
      },
      {
        timestamp: "2026-05-08T12:00:01.000Z",
        type: "response_item",
        payload: { type: "function_call", name: "exec_command", call_id: "call-sanitize", arguments: "{\"cmd\":\"npm test -- --watch secret-value\"}" },
      },
      {
        timestamp: "2026-05-08T12:00:02.000Z",
        type: "event_msg",
        payload: {
          type: "exec_command_end",
          command: ["bash", "-lc", "npm test -- --watch secret-value"],
          status: "completed",
          exit_code: 0,
          duration: { secs: 0, nanos: 500_000_000 },
          aggregated_output: "",
        },
      },
      {
        timestamp: "2026-05-08T12:00:03.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 50,
              cached_input_tokens: 10,
              cache_creation_input_tokens: 0,
              output_tokens: 20,
              reasoning_output_tokens: 0,
              total_tokens: 80,
            },
          },
        },
      },
    ]);

    const result = await computeCodexContextBreakdown({
      from: day,
      to: day,
      codexDir: dir,
      top: 20,
    });

    assert.ok(result.exec_command_breakdown.by_command.some((row) => row.name === "npm test"));
    assert.ok(!result.exec_command_breakdown.by_command.some((row) => row.name.includes("secret-value")));
    assert.ok(result.exec_command_breakdown.by_duration.some((row) => row.name === "<1s"));
    assert.ok(result.exec_command_breakdown.by_output.some((row) => row.name === "quiet"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("computeCodexContextBreakdown keeps MCP server context in displayed tool names", async () => {
  const dir = await makeTmpDir("tt-codex-breakdown-mcp");
  try {
    const day = "2026-05-08";
    await writeRollout(dir, day, "rollout-mcp.jsonl", [
      {
        timestamp: "2026-05-08T11:00:00.000Z",
        type: "session_meta",
        payload: { id: "s2", cwd: "/tmp/project", model_provider: "openai", cli_version: "1.0.0" },
      },
      {
        timestamp: "2026-05-08T11:00:01.000Z",
        type: "turn_context",
        payload: { cwd: "/tmp/project", model: "gpt-5.5" },
      },
      {
        timestamp: "2026-05-08T11:00:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "get_console_message",
          namespace: "mcp__chrome-devtools__",
          call_id: "call-mcp-1",
          arguments: "{}",
        },
      },
      {
        timestamp: "2026-05-08T11:00:03.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 120,
              cached_input_tokens: 20,
              cache_creation_input_tokens: 10,
              output_tokens: 80,
              reasoning_output_tokens: 0,
              total_tokens: 230,
            },
          },
        },
      },
    ]);

    const result = await computeCodexContextBreakdown({
      from: day,
      to: day,
      codexDir: dir,
      top: 20,
    });

    const browserCategory = result.tool_calls_breakdown.categories.find((row) => row.name === "MCP: chrome-devtools");
    assert.ok(browserCategory, "MCP category should be present");
    assert.ok(browserCategory.tools.some((row) => row.name === "chrome-devtools/get_console_message"));
    assert.ok(!browserCategory.tools.some((row) => row.name === "mcp__chrome-devtools__get_console_message"));
    assert.ok(result.tool_calls_breakdown.tools.some((row) => row.name === "chrome-devtools/get_console_message"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("computeCodexContextBreakdown infers skills from SKILL.md exec reads", async () => {
  const dir = await makeTmpDir("tt-codex-breakdown-skills");
  try {
    const day = "2026-05-08";
    await writeRollout(dir, day, "rollout-skill.jsonl", [
      {
        timestamp: "2026-05-08T12:00:00.000Z",
        type: "session_meta",
        payload: { id: "s3", cwd: "/tmp/project", model_provider: "openai", cli_version: "1.0.0" },
      },
      {
        timestamp: "2026-05-08T12:00:01.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call-skill-1",
          arguments: JSON.stringify({
            cmd: "sed -n '1,120p' /Users/me/.codex/skills/.system/frontend-design/SKILL.md",
          }),
        },
      },
      {
        timestamp: "2026-05-08T12:00:02.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 120,
              cached_input_tokens: 20,
              cache_creation_input_tokens: 10,
              output_tokens: 80,
              reasoning_output_tokens: 0,
              total_tokens: 230,
            },
          },
        },
      },
    ]);

    const result = await computeCodexContextBreakdown({
      from: day,
      to: day,
      codexDir: dir,
      top: 20,
    });

    assert.equal(result.skills_breakdown.total_calls, 1);
    assert.equal(result.skills_breakdown.skills[0].name, "frontend-design");
    assert.equal(result.skills_breakdown.skills[0].totals.total_tokens, 210);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
