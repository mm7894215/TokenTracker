// Regression tests for GitHub issue #106 — Cursor usage not being counted in
// the dashboard headline once another source is also in play.
//
// Two layers:
//   1. parseCursorApiIncremental / normalizeCursorUsage must NOT zero
//      billable_total_tokens for "Included in Pro" / "Enterprise" /
//      "no charge" records. Usage tracking and billing are orthogonal —
//      cost is computed independently from per-column tokens × pricing.
//   2. createLocalApiHandler / normalizeQueueRow must rescue legacy
//      queue.jsonl rows written by versions ≤ 0.26.5 that already wrote
//      billable_total_tokens = 0. Bumping billable up to total_tokens at
//      read time fixes existing on-disk data without a migration.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { normalizeCursorUsage } = require("../src/lib/cursor-config");
const { createLocalApiHandler } = require("../src/lib/local-api");

// ── parser layer ──────────────────────────────────────────────────────────

test("normalizeCursorUsage: billable usage emits billable_total_tokens = total", () => {
  const norm = normalizeCursorUsage({
    inputTokens: 1000,
    cacheWriteTokens: 200,
    cacheReadTokens: 300,
    outputTokens: 500,
    kind: "Premium",
  });
  assert.equal(norm.total_tokens, 2000);
  assert.equal(norm.billable_total_tokens, 2000);
});

test("normalizeCursorUsage: 'Included in Pro' still emits non-zero billable_total_tokens", () => {
  const norm = normalizeCursorUsage({
    inputTokens: 1000,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 500,
    kind: "Included in Pro",
  });
  assert.equal(norm.total_tokens, 1500);
  // Pre-fix this returned 0 for Enterprise / Included users, which made the
  // dashboard headline silently drop their entire Cursor consumption once a
  // billable source like Claude Code was added on top.
  assert.equal(norm.billable_total_tokens, 1500);
});

test("normalizeCursorUsage: 'no charge' / 'free' kinds still report usage", () => {
  for (const kind of ["No Charge", "no charge - errored", "Free", "FREE"]) {
    const norm = normalizeCursorUsage({
      inputTokens: 800,
      cacheWriteTokens: 100,
      cacheReadTokens: 100,
      outputTokens: 200,
      kind,
    });
    assert.equal(norm.total_tokens, 1200, `total for kind=${kind}`);
    assert.equal(norm.billable_total_tokens, 1200, `billable for kind=${kind}`);
  }
});

// ── read-time fallback in local-api ───────────────────────────────────────

async function writeQueue(queuePath, rows) {
  await fs.promises.writeFile(
    queuePath,
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
}

async function callEndpoint(queuePath, endpoint) {
  const handler = createLocalApiHandler({ queuePath });
  const url = new URL(`http://localhost${endpoint}`);
  const req = {
    method: "GET",
    url: url.pathname + url.search,
    headers: { host: "localhost" },
  };
  const chunks = [];
  const res = {
    statusCode: 200,
    setHeader() {},
    writeHead() {},
    write(chunk) {
      chunks.push(chunk);
    },
    end(body) {
      if (body) chunks.push(body);
    },
  };
  const handled = await handler(req, res, url);
  assert.ok(handled, `endpoint must be handled: ${endpoint}`);
  return JSON.parse(chunks.join(""));
}

test("usage-summary rescues legacy Cursor rows with billable_total_tokens = 0", async () => {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tt-cursor-billable-"));
  const queuePath = path.join(tmp, "queue.jsonl");
  try {
    // Mix: legacy Cursor row (Enterprise / Included, billable=0, total>0)
    // plus a normal Claude row that contributes non-zero billable. Before
    // the fix the headline would sum only Claude's billable, hiding the
    // 3,000,000 Cursor tokens.
    await writeQueue(queuePath, [
      {
        hour_start: "2026-05-28T03:00:00Z",
        source: "cursor",
        model: "composer-2.5",
        input_tokens: 500_000,
        output_tokens: 500_000,
        cached_input_tokens: 1_000_000,
        cache_creation_input_tokens: 1_000_000,
        reasoning_output_tokens: 0,
        total_tokens: 3_000_000,
        billable_total_tokens: 0,
        conversation_count: 1,
      },
      {
        hour_start: "2026-05-28T03:00:00Z",
        source: "claude",
        model: "claude-opus-4-7",
        input_tokens: 200_000,
        output_tokens: 100_000,
        cached_input_tokens: 700_000,
        cache_creation_input_tokens: 50_000,
        reasoning_output_tokens: 0,
        total_tokens: 1_050_000,
        billable_total_tokens: 1_050_000,
        conversation_count: 1,
      },
    ]);

    const summary = await callEndpoint(
      queuePath,
      "/functions/tokentracker-usage-summary?from=2026-05-28&to=2026-05-28",
    );
    // Headline should equal the sum of total_tokens — Cursor's 3M is no
    // longer silently dropped.
    assert.equal(summary.totals.total_tokens, 4_050_000);
    assert.equal(summary.totals.billable_total_tokens, 4_050_000);
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});

test("usage-summary does not double-count when Cursor billable already equals total", async () => {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tt-cursor-billable-"));
  const queuePath = path.join(tmp, "queue.jsonl");
  try {
    // Post-fix row (or any normal Cursor billable row): billable already
    // matches total. The read-time fallback must be a no-op here.
    await writeQueue(queuePath, [
      {
        hour_start: "2026-05-28T03:00:00Z",
        source: "cursor",
        model: "composer-2.5",
        input_tokens: 100_000,
        output_tokens: 50_000,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: 150_000,
        billable_total_tokens: 150_000,
        conversation_count: 1,
      },
    ]);

    const summary = await callEndpoint(
      queuePath,
      "/functions/tokentracker-usage-summary?from=2026-05-28&to=2026-05-28",
    );
    assert.equal(summary.totals.total_tokens, 150_000);
    assert.equal(summary.totals.billable_total_tokens, 150_000);
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});

test("usage-summary leaves non-Cursor sources untouched", async () => {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tt-cursor-billable-"));
  const queuePath = path.join(tmp, "queue.jsonl");
  try {
    // A hypothetical row from another source with billable < total — should
    // NOT be rescued (that semantic only applies to Cursor's legacy 0-write).
    await writeQueue(queuePath, [
      {
        hour_start: "2026-05-28T03:00:00Z",
        source: "claude",
        model: "claude-opus-4-7",
        input_tokens: 100_000,
        output_tokens: 50_000,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: 150_000,
        billable_total_tokens: 0,
        conversation_count: 1,
      },
    ]);

    const summary = await callEndpoint(
      queuePath,
      "/functions/tokentracker-usage-summary?from=2026-05-28&to=2026-05-28",
    );
    assert.equal(summary.totals.total_tokens, 150_000);
    assert.equal(summary.totals.billable_total_tokens, 0);
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});
