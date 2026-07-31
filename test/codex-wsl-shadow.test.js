const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { test } = require("node:test");

const { cmdSync } = require("../src/commands/sync");

// Reproduces the WSL-shadowing bug: resolveInstallPaths in wsl-first mode
// picks a WSL ~/.codex path that exists but has NO sessions/ subdir (codex is
// installed on Windows, not in WSL). Before the fix, listRolloutFiles scanned
// the non-existent WSL sessions/ dir, silently returned 0 files, and all
// Windows codex usage went missing. After the fix, sync.js verifies sessions/
// exists before trusting a path, so the Windows install is still scanned.

async function withTempHome(fn) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-wsl-shadow-"));
  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    CODEX_HOME: process.env.CODEX_HOME,
    TOKENTRACKER_WSL_MODE: process.env.TOKENTRACKER_WSL_MODE,
  };
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    return await fn(home);
  } finally {
    process.env.HOME = saved.HOME;
    process.env.USERPROFILE = saved.USERPROFILE;
    process.env.CODEX_HOME = saved.CODEX_HOME;
    process.env.TOKENTRACKER_WSL_MODE = saved.TOKENTRACKER_WSL_MODE;
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  }
}

async function writeCodexRollout(codexHome, date, uuid, totalTokens = 120) {
  const [year, month, day] = date.split("-");
  const dir = path.join(codexHome, "sessions", year, month, day);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `rollout-${date}T00-00-00-${uuid}.jsonl`);
  const usage = {
    input_tokens: totalTokens,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: totalTokens,
  };
  await fs.writeFile(
    filePath,
    JSON.stringify({
      type: "event_msg",
      timestamp: `${date}T00:00:00.000Z`,
      payload: {
        type: "token_count",
        info: { last_token_usage: usage, total_token_usage: usage },
      },
    }) + "\n",
    "utf8",
  );
  return filePath;
}

test("codex WSL shadow: Windows install is scanned when WSL ~/.codex shell exists without sessions/", async () => {
  await withTempHome(async (home) => {
    // Windows-style codex install under the mocked HOME, WITH sessions/.
    const winCodex = path.join(home, ".codex");
    await writeCodexRollout(winCodex, "2026-07-31", "test-uuid-1", 120);

    // Force wsl-first mode (the default that triggered the bug).
    process.env.TOKENTRACKER_WSL_MODE = "wsl-first";

    await cmdSync([], {});

    const queuePath = path.join(home, ".tokentracker", "tracker", "queue.jsonl");
    const queueContent = await fs.readFile(queuePath, "utf8").catch(() => "");
    const lines = queueContent.trim() ? queueContent.trim().split("\n") : [];
    const codexRecords = lines
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((r) => r && r.source === "codex");

    assert.ok(
      codexRecords.length > 0,
      "Windows codex usage must be queued even when a WSL ~/.codex shell exists without sessions/",
    );
    const totalTokens = codexRecords.reduce((s, r) => s + (r.total_tokens || 0), 0);
    assert.ok(
      totalTokens > 0,
      `codex token count must be > 0, got ${totalTokens}`,
    );
  });
});
