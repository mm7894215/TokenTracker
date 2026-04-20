const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createLocalApiHandler } = require("../src/lib/local-api");

function createRequest({ method = "GET" } = {}) {
  return {
    method,
    headers: {},
    async *[Symbol.asyncIterator]() {},
  };
}

function createResponse() {
  return {
    statusCode: null,
    headers: null,
    body: Buffer.alloc(0),
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(chunk) {
      this.body = chunk ? Buffer.from(chunk) : Buffer.alloc(0);
    },
  };
}

test("project usage detail returns current and previous period breakdowns", async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "tokentracker-project-detail-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const projectQueuePath = path.join(tmp, "project.queue.jsonl");
    await fsp.writeFile(queuePath, "", "utf8");
    await fsp.writeFile(
      projectQueuePath,
      [
        JSON.stringify({ project_key: "octo/api", project_ref: "https://github.com/octo/api", source: "codex", hour_start: "2026-04-10T00:00:00.000Z", total_tokens: 100 }),
        JSON.stringify({ project_key: "octo/api", project_ref: "https://github.com/octo/api", source: "gemini", hour_start: "2026-04-11T00:00:00.000Z", total_tokens: 200 }),
        JSON.stringify({ project_key: "octo/api", project_ref: "https://github.com/octo/api", source: "codex", hour_start: "2026-04-08T00:00:00.000Z", total_tokens: 50 }),
      ].join("\n"),
      "utf8",
    );

    const handler = createLocalApiHandler({ queuePath });
    const req = createRequest();
    const res = createResponse();
    const url = new URL("http://127.0.0.1/functions/tokentracker-project-usage-detail");
    url.searchParams.set("project_key", "octo/api");
    url.searchParams.set("from", "2026-04-10");
    url.searchParams.set("to", "2026-04-11");
    url.searchParams.set("compare_from", "2026-04-08");
    url.searchParams.set("compare_to", "2026-04-09");

    const handled = await handler(req, res, url);
    assert.equal(handled, true);
    const payload = JSON.parse(res.body.toString("utf8"));
    assert.equal(payload.current.totals.billable_total_tokens, "300");
    assert.equal(payload.previous.totals.billable_total_tokens, "50");
    assert.equal(payload.current.sources.length, 2);
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});

test("dashboard wires project drilldown modal flow", () => {
  const dashboardSrc = fs.readFileSync(
    path.join(process.cwd(), "dashboard/src/pages/DashboardPage.jsx"),
    "utf8",
  );
  assert.match(dashboardSrc, /selectedProjectEntry/);
  const viewSrc = fs.readFileSync(
    path.join(process.cwd(), "dashboard/src/ui/matrix-a/views/DashboardView.jsx"),
    "utf8",
  );
  assert.match(viewSrc, /ProjectUsageDrilldownModal/);
});
