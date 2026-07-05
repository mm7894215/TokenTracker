const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { cmdConfigOpenRouter } = require("../src/commands/config");

const VALID_KEY = "sk-or-v1-abcdefghijklmnopqrst";

test("config openrouter status --json reports unset by default", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-config-cli-"));
  const trackerDir = path.join(tmp, ".tokentracker", "tracker");
  await fs.mkdir(trackerDir, { recursive: true });

  const originalHome = process.env.HOME;
  process.env.HOME = tmp;
  delete process.env.OPENROUTER_API_KEY;

  const chunks = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };

  try {
    await cmdConfigOpenRouter("status", ["--json"]);
    const payload = JSON.parse(chunks.join("").trim());
    assert.equal(payload.configured, false);
    assert.equal(payload.source, "none");
  } finally {
    process.stdout.write = originalWrite;
    process.env.HOME = originalHome;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("config openrouter set --key persists key", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-config-set-"));
  const trackerDir = path.join(tmp, ".tokentracker", "tracker");
  await fs.mkdir(trackerDir, { recursive: true });

  const originalHome = process.env.HOME;
  process.env.HOME = tmp;
  delete process.env.OPENROUTER_API_KEY;

  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => "",
  });

  try {
    await cmdConfigOpenRouter("set", ["--key", VALID_KEY, "--json"]);
    const config = JSON.parse(
      await fs.readFile(path.join(trackerDir, "config.json"), "utf8"),
    );
    assert.equal(config.openrouter.apiKey, VALID_KEY);
  } finally {
    global.fetch = originalFetch;
    process.env.HOME = originalHome;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("config openrouter clear removes saved key", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-config-clear-"));
  const trackerDir = path.join(tmp, ".tokentracker", "tracker");
  await fs.mkdir(trackerDir, { recursive: true });
  const configPath = path.join(trackerDir, "config.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({ openrouter: { apiKey: VALID_KEY } }, null, 2),
    "utf8",
  );

  const originalHome = process.env.HOME;
  process.env.HOME = tmp;
  delete process.env.OPENROUTER_API_KEY;

  try {
    await cmdConfigOpenRouter("clear", ["--json"]);
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    assert.equal(config.openrouter, undefined);
  } finally {
    process.env.HOME = originalHome;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
