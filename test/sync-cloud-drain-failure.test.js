const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { cmdSync } = require("../src/commands/sync");

const SAMPLE_ROW = {
  hour_start: "2026-06-20T10:00:00.000Z",
  source: "gemini",
  model: "gemini-2.5-pro",
  input_tokens: 100,
  cached_input_tokens: 0,
  cache_creation_input_tokens: 0,
  output_tokens: 20,
  reasoning_output_tokens: 0,
  total_tokens: 120,
  billable_total_tokens: 120,
  conversation_count: 1,
};

test("sync --drain exits non-zero when cloud upload fails", async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "tt-sync-drain-fail-"));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevDeviceToken = process.env.TOKENTRACKER_DEVICE_TOKEN;
  const prevBaseUrl = process.env.TOKENTRACKER_INSFORGE_BASE_URL;
  const prevExitCode = process.exitCode;
  const prevFetch = global.fetch;

  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.TOKENTRACKER_DEVICE_TOKEN = "device-token";
  process.env.TOKENTRACKER_INSFORGE_BASE_URL = "https://cloud.example";
  process.exitCode = undefined;

  const trackerDir = path.join(tmp, ".tokentracker", "tracker");
  await fsp.mkdir(trackerDir, { recursive: true });
  await fsp.writeFile(
    path.join(trackerDir, "config.json"),
    JSON.stringify({ baseUrl: "https://example.invalid", deviceToken: "stale-config-token" }),
    "utf8",
  );
  await fsp.writeFile(path.join(trackerDir, "cursors.json"), JSON.stringify({ version: 1, files: {} }), "utf8");
  await fsp.writeFile(path.join(trackerDir, "queue.state.json"), JSON.stringify({ offset: 0 }), "utf8");
  await fsp.writeFile(path.join(trackerDir, "queue.jsonl"), [JSON.stringify(SAMPLE_ROW), ""].join(os.EOL), "utf8");

  let fetchCalls = 0;
  global.fetch = async (url, init) => {
    fetchCalls += 1;
    assert.equal(String(url), "https://cloud.example/functions/tokentracker-ingest");
    assert.equal(init?.headers?.Authorization, "Bearer device-token");
    return new Response("upstream unavailable", { status: 500 });
  };

  try {
    await cmdSync(["--drain"]);
    assert.equal(process.exitCode, 1);
    assert.equal(fetchCalls, 1);
    const state = JSON.parse(fs.readFileSync(path.join(trackerDir, "queue.state.json"), "utf8"));
    assert.equal(state.offset, 0, "failed upload must not advance cloud offset");
  } finally {
    global.fetch = prevFetch;
    process.exitCode = prevExitCode;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (prevDeviceToken === undefined) delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    else process.env.TOKENTRACKER_DEVICE_TOKEN = prevDeviceToken;
    if (prevBaseUrl === undefined) delete process.env.TOKENTRACKER_INSFORGE_BASE_URL;
    else process.env.TOKENTRACKER_INSFORGE_BASE_URL = prevBaseUrl;
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});
