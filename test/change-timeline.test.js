const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createLocalApiHandler } = require("../src/lib/local-api");

function createRequest({ method = "GET", headers = {} } = {}) {
  return {
    method,
    headers,
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

test("local timeline endpoint reports source, model, project, and config events", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-timeline-"));
  const prevHome = process.env.HOME;
  try {
    process.env.HOME = tmp;
    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    await fs.mkdir(trackerDir, { recursive: true });
    const queuePath = path.join(trackerDir, "queue.jsonl");
    const projectQueuePath = path.join(trackerDir, "project.queue.jsonl");
    const configPath = path.join(trackerDir, "config.json");

    await fs.writeFile(
      queuePath,
      [
        JSON.stringify({ source: "codex", model: "gpt-5.4", hour_start: "2026-04-18T00:00:00.000Z" }),
        JSON.stringify({ source: "gemini", model: "gemini-2.5-pro", hour_start: "2026-04-20T00:00:00.000Z" }),
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      projectQueuePath,
      JSON.stringify({ project_key: "octo/api", source: "codex", hour_start: "2026-04-21T00:00:00.000Z" }),
      "utf8",
    );
    await fs.writeFile(configPath, JSON.stringify({ baseUrl: "https://example.invalid", deviceToken: "token" }), "utf8");

    const handler = createLocalApiHandler({ queuePath });
    const req = createRequest();
    const res = createResponse();

    const handled = await handler(req, res, new URL("http://127.0.0.1/functions/tokentracker-change-timeline"));

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body.toString("utf8"));
    for (const event of payload.events) {
      assert.ok(typeof event.event_type === "string", "event_type is a string");
      assert.ok(event.params !== null && typeof event.params === "object", "params is an object");
      assert.equal(event.title, undefined, "API must not embed pre-rendered titles");
      assert.equal(event.detail, undefined, "API must not embed pre-rendered details");
    }
    const sourceEvents = payload.events.filter((e) => e.event_type === "source_first_seen");
    assert.deepEqual(
      sourceEvents.map((e) => e.params.source).sort(),
      ["codex", "gemini"],
    );
    const modelEvents = payload.events.filter((e) => e.event_type === "model_first_seen");
    assert.ok(modelEvents.some((e) => e.params.model === "gpt-5.4"));
    assert.ok(payload.events.some((e) => e.event_type === "project_attribution_started"));
    assert.ok(payload.events.some((e) => e.event_type === "cloud_sync_configured"));
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("dashboard wires the change timeline card", () => {
  const dashboardSrc = require("node:fs").readFileSync(
    path.join(process.cwd(), "dashboard/src/ui/matrix-a/views/DashboardView.jsx"),
    "utf8",
  );
  assert.match(dashboardSrc, /ChangeTimelineCard/);
  assert.match(dashboardSrc, /changeTimelineEvents/);
});
