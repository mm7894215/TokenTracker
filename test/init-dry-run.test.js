const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { test } = require("node:test");

const { cmdInit } = require("../src/commands/init");
const { resolveOpencodePluginDir, DEFAULT_PLUGIN_NAME } = require("../src/lib/opencode-config");

function stripAnsi(text) {
  return String(text || "").replace(/\x1b\[[0-9;]*m/g, "");
}

test("dry-run preview reports opencode install when config is missing", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-init-dry-"));
  const prevHome = process.env.HOME;
  const prevOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  const prevToken = process.env.TOKENTRACKER_DEVICE_TOKEN;
  const prevWrite = process.stdout.write;

  let output = "";

  try {
    process.env.HOME = tmp;
    process.env.OPENCODE_CONFIG_DIR = path.join(tmp, ".config", "opencode");
    delete process.env.TOKENTRACKER_DEVICE_TOKEN;

    process.stdout.write = (chunk) => {
      output += String(chunk || "");
      return true;
    };

    await cmdInit([
      "--yes",
      "--dry-run",
      "--no-auth",
      "--no-open",
      "--base-url",
      "https://example.invalid",
    ]);

    const clean = stripAnsi(output);
    assert.match(clean, /Opencode Plugin/);
    assert.match(clean, /Will create config and install plugin/);

    const pluginPath = path.join(
      resolveOpencodePluginDir({ configDir: process.env.OPENCODE_CONFIG_DIR }),
      DEFAULT_PLUGIN_NAME,
    );
    await assert.rejects(fs.stat(pluginPath), /ENOENT/);
  } finally {
    process.stdout.write = prevWrite;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = prevOpencodeConfigDir;
    if (prevToken === undefined) delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    else process.env.TOKENTRACKER_DEVICE_TOKEN = prevToken;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
