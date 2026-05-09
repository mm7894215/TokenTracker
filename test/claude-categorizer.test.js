const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const fssync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  computeClaudeCategoryBreakdown,
  splitOutputByContent,
  classifyOneMessage,
  emptyCategoryMap,
  CATEGORY_KEYS,
} = require("../src/lib/claude-categorizer");

function makeTmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

function isoDaysAgo(days) {
  const d = new Date(Date.now() - days * 86400 * 1000);
  return d.toISOString();
}

async function writeJsonl(file, lines) {
  await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
}

test("splitOutputByContent: thinking + tool_use(Agent) + tool_use(Read) + text split by char ratio", () => {
  const breakdown = emptyCategoryMap();
  // Pick char counts so the relative ordering after the splitter is
  // unambiguous: reasoning > subagents > tool_calls > assistant_response.
  const content = [
    { type: "thinking", thinking: "x".repeat(500) },
    { type: "tool_use", name: "Agent", input: { p: "y".repeat(200) } },
    { type: "tool_use", name: "Read", input: { p: "z".repeat(80) } },
    { type: "text", text: "w".repeat(20) },
  ];
  splitOutputByContent({ output_tokens: 1000 }, content, breakdown);

  // Sum of all four buckets must equal total exactly (largest-remainder rounding).
  const sum =
    breakdown.reasoning.output_tokens +
    breakdown.tool_calls.output_tokens +
    breakdown.subagents.output_tokens +
    breakdown.assistant_response.output_tokens;
  assert.equal(sum, 1000);

  assert.ok(
    breakdown.reasoning.output_tokens > breakdown.subagents.output_tokens,
    `reasoning(${breakdown.reasoning.output_tokens}) > subagents(${breakdown.subagents.output_tokens})`,
  );
  assert.ok(
    breakdown.subagents.output_tokens > breakdown.tool_calls.output_tokens,
    `subagents(${breakdown.subagents.output_tokens}) > tool_calls(${breakdown.tool_calls.output_tokens})`,
  );
  assert.ok(
    breakdown.tool_calls.output_tokens > breakdown.assistant_response.output_tokens,
    `tool_calls(${breakdown.tool_calls.output_tokens}) > assistant_response(${breakdown.assistant_response.output_tokens})`,
  );

  // total_tokens mirrors output_tokens for each non-input category here
  // (we assigned no input/cache).
  assert.equal(breakdown.reasoning.total_tokens, breakdown.reasoning.output_tokens);
});

test("splitOutputByContent: explicit reasoning_output_tokens are peeled off first", () => {
  const breakdown = emptyCategoryMap();
  const content = [
    { type: "thinking", thinking: "x".repeat(50) },
    { type: "text", text: "w".repeat(50) },
  ];
  splitOutputByContent(
    { output_tokens: 500, reasoning_output_tokens: 200 },
    content,
    breakdown,
  );
  assert.equal(breakdown.reasoning.output_tokens, 200);
  assert.equal(breakdown.reasoning.reasoning_output_tokens, 200);
  // Remaining 300 goes entirely to assistant_response (only non-thinking block left).
  assert.equal(breakdown.assistant_response.output_tokens, 300);
});

test("splitOutputByContent: empty content falls back to assistant_response", () => {
  const breakdown = emptyCategoryMap();
  splitOutputByContent({ output_tokens: 100 }, [], breakdown);
  assert.equal(breakdown.assistant_response.output_tokens, 100);
});

test("classifyOneMessage: first cache_creation lands in system_prefix; subsequent in conversation_history", () => {
  const breakdown = emptyCategoryMap();
  const sessionState = { systemPrefixSeen: false };

  // Turn 1: big cache_creation = system + tools schema being established.
  classifyOneMessage(
    {
      message: {
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 50_000,
          cache_read_input_tokens: 0,
          output_tokens: 100,
        },
        content: [{ type: "text", text: "hello" }],
      },
    },
    sessionState,
    breakdown,
  );
  assert.equal(breakdown.system_prefix.cache_creation_input_tokens, 50_000);
  assert.equal(breakdown.conversation_history.cache_creation_input_tokens, 0);
  assert.equal(breakdown.user_input.input_tokens, 10);

  // Turn 2: another cache_creation chunk = incremental conversation prefix.
  classifyOneMessage(
    {
      message: {
        usage: {
          input_tokens: 5,
          cache_creation_input_tokens: 1_500,
          cache_read_input_tokens: 50_000,
          output_tokens: 50,
        },
        content: [{ type: "text", text: "ok" }],
      },
    },
    sessionState,
    breakdown,
  );
  assert.equal(breakdown.system_prefix.cache_creation_input_tokens, 50_000); // unchanged
  assert.equal(breakdown.conversation_history.cache_creation_input_tokens, 1_500);
  assert.equal(breakdown.conversation_history.cached_input_tokens, 50_000);
});

test("computeClaudeCategoryBreakdown: end-to-end on synthetic project dir, totals & percents", async () => {
  const dir = await makeTmpDir("ttcat");
  try {
    const sessionA = path.join(dir, "session-a.jsonl");
    const sessionB = path.join(dir, "session-b.jsonl");

    const ts = isoDaysAgo(1);
    await writeJsonl(sessionA, [
      // Session A turn 1: prefix
      {
        type: "assistant",
        timestamp: ts,
        requestId: "rA1",
        message: {
          id: "mA1",
          usage: { input_tokens: 0, cache_creation_input_tokens: 60_000, cache_read_input_tokens: 0, output_tokens: 200 },
          content: [{ type: "thinking", thinking: "z".repeat(100) }],
        },
      },
      // Session A turn 2: tool_use(Agent) — subagent invocation
      {
        type: "assistant",
        timestamp: ts,
        requestId: "rA2",
        message: {
          id: "mA2",
          usage: { input_tokens: 50, cache_creation_input_tokens: 800, cache_read_input_tokens: 60_000, output_tokens: 400 },
          content: [{ type: "tool_use", name: "Agent", input: { description: "do stuff" } }],
        },
      },
    ]);

    await writeJsonl(sessionB, [
      // Session B turn 1: tool_use(Read) — regular tool
      {
        type: "assistant",
        timestamp: ts,
        requestId: "rB1",
        message: {
          id: "mB1",
          usage: { input_tokens: 0, cache_creation_input_tokens: 30_000, cache_read_input_tokens: 0, output_tokens: 100 },
          content: [{ type: "tool_use", name: "Read", input: { file_path: "/tmp/x" } }],
        },
      },
    ]);

    const result = await computeClaudeCategoryBreakdown({ rootDir: dir });

    assert.equal(result.scope, "supported");
    assert.equal(result.session_count, 2);
    assert.equal(result.message_count, 3);

    // System prefix = first big cache_creation per session = 60_000 + 30_000.
    const sys = result.categories.find((c) => c.key === "system_prefix").totals;
    assert.equal(sys.cache_creation_input_tokens, 90_000);

    // Conversation history = subsequent cache_creation + all cache_read.
    const conv = result.categories.find((c) => c.key === "conversation_history").totals;
    assert.equal(conv.cache_creation_input_tokens, 800);
    assert.equal(conv.cached_input_tokens, 60_000);

    // user_input
    const usr = result.categories.find((c) => c.key === "user_input").totals;
    assert.equal(usr.input_tokens, 50);

    // Output split: turn1 (200) → reasoning, turn2 (400) → subagents, turnB1 (100) → tool_calls.
    const reasoning = result.categories.find((c) => c.key === "reasoning").totals;
    const subagents = result.categories.find((c) => c.key === "subagents").totals;
    const tools = result.categories.find((c) => c.key === "tool_calls").totals;
    const resp = result.categories.find((c) => c.key === "assistant_response").totals;
    assert.equal(reasoning.output_tokens, 200);
    assert.equal(subagents.output_tokens, 400);
    assert.equal(tools.output_tokens, 100);
    assert.equal(resp.output_tokens, 0);

    // Percents sum to ~100 (rounding tolerance).
    const sumPercent = result.categories.reduce((a, c) => a + c.percent, 0);
    assert.ok(Math.abs(sumPercent - 100) < 0.5, `sum percent = ${sumPercent}`);

    // Total equals expected sum.
    const expectedTotal = 90_000 + 800 + 60_000 + 50 + 200 + 400 + 100;
    assert.equal(result.totals.total_tokens, expectedTotal);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("computeClaudeCategoryBreakdown: deduplicates by msgId+requestId", async () => {
  const dir = await makeTmpDir("ttcat-dedup");
  try {
    const file = path.join(dir, "s.jsonl");
    const ts = isoDaysAgo(1);
    const dup = {
      type: "assistant",
      timestamp: ts,
      requestId: "r1",
      message: {
        id: "m1",
        usage: { input_tokens: 0, cache_creation_input_tokens: 1000, cache_read_input_tokens: 0, output_tokens: 50 },
        content: [{ type: "text", text: "hi" }],
      },
    };
    await writeJsonl(file, [dup, dup, dup]);

    const result = await computeClaudeCategoryBreakdown({ rootDir: dir });
    assert.equal(result.message_count, 1);
    const sys = result.categories.find((c) => c.key === "system_prefix").totals;
    assert.equal(sys.cache_creation_input_tokens, 1000);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("CATEGORY_KEYS order is stable (UI relies on it)", () => {
  assert.deepEqual(CATEGORY_KEYS, [
    "system_prefix",
    "conversation_history",
    "user_input",
    "tool_calls",
    "subagents",
    "reasoning",
    "assistant_response",
  ]);
});
