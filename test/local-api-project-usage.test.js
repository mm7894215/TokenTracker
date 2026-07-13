const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createLocalApiHandler } = require("../src/lib/local-api");

async function writeJsonl(filePath, rows) {
  await fs.promises.writeFile(
    filePath,
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
}

async function callEndpoint(queuePath, endpoint, { expectStatus = 200 } = {}) {
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
    writeHead(code) {
      this.statusCode = code;
    },
    write(chunk) {
      chunks.push(chunk);
    },
    end(body) {
      if (body) chunks.push(body);
    },
  };
  const handled = await handler(req, res, url);
  assert.ok(handled, `endpoint must be handled: ${endpoint}`);
  assert.equal(res.statusCode, expectStatus, `unexpected status for ${endpoint}`);
  return JSON.parse(chunks.join(""));
}

function projectRow(overrides = {}) {
  return {
    project_ref: "https://github.com/acme/alpha",
    project_key: "acme/alpha",
    source: "claude",
    hour_start: "2026-04-20T10:00:00.000Z",
    input_tokens: 100,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 20,
    reasoning_output_tokens: 0,
    total_tokens: 120,
    billable_total_tokens: 120,
    conversation_count: 1,
    ...overrides,
  };
}

async function setupTmp(projectRows, queueRows = []) {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tt-localapi-project-usage-"));
  const queuePath = path.join(tmp, "queue.jsonl");
  await writeJsonl(queuePath, queueRows.length ? queueRows : [projectRow()]);
  if (queueRows.length === 0 && projectRows.length === 0) {
    // caller wants the fallback scenario — leave project queue absent
  } else if (projectRows.length > 0) {
    await writeJsonl(path.join(tmp, "project.queue.jsonl"), projectRows);
  }
  return { tmp, queuePath };
}

test("project-usage-summary filters rows by from/to in the requested timezone", async () => {
  const { tmp, queuePath } = await setupTmp([
    projectRow({ hour_start: "2026-04-19T10:00:00.000Z", total_tokens: 100, billable_total_tokens: 100 }),
    projectRow({ hour_start: "2026-04-20T10:00:00.000Z", total_tokens: 200, billable_total_tokens: 200 }),
    // 23:30 UTC on Apr 20 is already Apr 21 in UTC+8 — must fall out of the range.
    projectRow({ hour_start: "2026-04-20T23:30:00.000Z", total_tokens: 400, billable_total_tokens: 400 }),
  ]);
  try {
    const res = await callEndpoint(
      queuePath,
      "/functions/tokentracker-project-usage-summary?from=2026-04-20&to=2026-04-20&tz_offset_minutes=480",
    );
    assert.equal(res.entries.length, 1);
    assert.equal(res.entries[0].total_tokens, "200");

    const all = await callEndpoint(queuePath, "/functions/tokentracker-project-usage-summary");
    assert.equal(all.entries[0].total_tokens, "700");
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});

test("project-usage-summary excludes the claude-mem observer pseudo project", async () => {
  const { tmp, queuePath } = await setupTmp([
    projectRow(),
    projectRow({
      project_key: "claude-mem/observer-sessions",
      project_ref: "https://github.com/claude-mem/observer-sessions",
      total_tokens: 999999,
      billable_total_tokens: 999999,
    }),
  ]);
  try {
    const res = await callEndpoint(queuePath, "/functions/tokentracker-project-usage-summary");
    assert.equal(res.entries.length, 1);
    assert.equal(res.entries[0].project_key, "acme/alpha");
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});

test("project-usage-summary preserves row billable totals instead of copying total_tokens", async () => {
  const { tmp, queuePath } = await setupTmp([
    projectRow({ source: "kilo", total_tokens: 1000, billable_total_tokens: 600 }),
  ]);
  try {
    const res = await callEndpoint(queuePath, "/functions/tokentracker-project-usage-summary");
    assert.equal(res.entries[0].total_tokens, "1000");
    assert.equal(res.entries[0].billable_total_tokens, "600");
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});

test("project-usage-summary dedups append-only rows by (project, source, hour)", async () => {
  const { tmp, queuePath } = await setupTmp([
    projectRow({ total_tokens: 100, billable_total_tokens: 100 }),
    // Later emission for the same bucket must win, not accumulate.
    projectRow({ total_tokens: 150, billable_total_tokens: 150 }),
  ]);
  try {
    const res = await callEndpoint(queuePath, "/functions/tokentracker-project-usage-summary");
    assert.equal(res.entries.length, 1);
    assert.equal(res.entries[0].total_tokens, "150");
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});

test("project-usage-summary reports a per-source breakdown", async () => {
  const { tmp, queuePath } = await setupTmp([
    projectRow({ source: "claude", hour_start: "2026-04-19T10:00:00.000Z", total_tokens: 300, billable_total_tokens: 300 }),
    projectRow({ source: "codex", hour_start: "2026-04-20T10:00:00.000Z", total_tokens: 100, billable_total_tokens: 100 }),
  ]);
  try {
    const res = await callEndpoint(queuePath, "/functions/tokentracker-project-usage-summary");
    const entry = res.entries[0];
    assert.deepEqual(
      entry.sources.map((s) => s.source),
      ["claude", "codex"],
    );
    assert.equal(entry.sources[0].total_tokens, 300);
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});

test("project-usage-summary falls back to per-source aggregation without project rows", async () => {
  const { tmp, queuePath } = await setupTmp(
    [],
    [
      {
        source: "claude",
        model: "claude-sonnet-4-6",
        hour_start: "2026-04-20T10:00:00.000Z",
        input_tokens: 100,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 20,
        reasoning_output_tokens: 0,
        total_tokens: 120,
        conversation_count: 1,
      },
    ],
  );
  try {
    const res = await callEndpoint(queuePath, "/functions/tokentracker-project-usage-summary");
    assert.equal(res.entries.length, 1);
    assert.equal(res.entries[0].project_key, "claude");
    // Synthetic source rows must not carry a fabricated clickable ref.
    assert.equal(res.entries[0].project_ref, "");
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});

test("project-usage-detail returns totals, daily series and per-source breakdown", async () => {
  const { tmp, queuePath } = await setupTmp([
    projectRow({ source: "claude", hour_start: "2026-04-19T10:00:00.000Z", input_tokens: 100, cached_input_tokens: 400, output_tokens: 50, total_tokens: 550, billable_total_tokens: 550, conversation_count: 3 }),
    projectRow({ source: "codex", hour_start: "2026-04-20T10:00:00.000Z", input_tokens: 30, cached_input_tokens: 0, output_tokens: 20, total_tokens: 50, billable_total_tokens: 50, conversation_count: 1 }),
    projectRow({ project_key: "acme/other", project_ref: "https://github.com/acme/other", total_tokens: 1000, billable_total_tokens: 1000 }),
  ]);
  try {
    const res = await callEndpoint(
      queuePath,
      "/functions/tokentracker-project-usage-detail?project_key=acme/alpha",
    );
    assert.equal(res.project_key, "acme/alpha");
    assert.equal(res.project_ref, "https://github.com/acme/alpha");
    assert.equal(res.totals.total_tokens, 600);
    assert.equal(res.totals.cached_input_tokens, 400);
    assert.equal(res.totals.conversation_count, 4);
    assert.equal(res.days_active, 2);
    // Share denominator spans every project in range, not just this one.
    assert.equal(res.range_total_tokens, 1600);
    assert.deepEqual(res.daily.map((d) => d.day), ["2026-04-19", "2026-04-20"]);
    assert.equal(res.daily[0].total_tokens, 550);
    assert.deepEqual(res.sources.map((s) => s.source), ["claude", "codex"]);
    assert.equal(res.sources[0].days_active, 1);
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});

test("project-usage-detail honors from/to and rejects a missing project_key", async () => {
  const { tmp, queuePath } = await setupTmp([
    projectRow({ hour_start: "2026-04-19T10:00:00.000Z", total_tokens: 100, billable_total_tokens: 100 }),
    projectRow({ hour_start: "2026-04-20T10:00:00.000Z", total_tokens: 200, billable_total_tokens: 200 }),
  ]);
  try {
    const ranged = await callEndpoint(
      queuePath,
      "/functions/tokentracker-project-usage-detail?project_key=acme/alpha&from=2026-04-20&to=2026-04-20",
    );
    assert.equal(ranged.totals.total_tokens, 200);
    assert.equal(ranged.daily.length, 1);

    const missing = await callEndpoint(
      queuePath,
      "/functions/tokentracker-project-usage-detail",
      { expectStatus: 400 },
    );
    assert.equal(missing.error, "missing_project_key");
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});

test("project-usage-detail excludes claude-mem rows from data and share denominator", async () => {
  const { tmp, queuePath } = await setupTmp([
    projectRow({ total_tokens: 100, billable_total_tokens: 100 }),
    projectRow({
      project_key: "claude-mem/observer-sessions",
      project_ref: "https://github.com/claude-mem/observer-sessions",
      source: "claude",
      hour_start: "2026-04-20T11:00:00.000Z",
      total_tokens: 999999,
      billable_total_tokens: 999999,
    }),
  ]);
  try {
    const res = await callEndpoint(
      queuePath,
      "/functions/tokentracker-project-usage-detail?project_key=acme/alpha",
    );
    assert.equal(res.range_total_tokens, 100);

    const pseudo = await callEndpoint(
      queuePath,
      "/functions/tokentracker-project-usage-detail?project_key=claude-mem/observer-sessions",
    );
    assert.equal(pseudo.totals.total_tokens, 0);
    assert.equal(pseudo.daily.length, 0);
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});
