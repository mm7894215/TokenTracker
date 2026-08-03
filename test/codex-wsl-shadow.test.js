const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { test } = require("node:test");

const { cmdSync } = require("../src/commands/sync");
const wsl = require("../src/lib/wsl-probe");
const { mockPlatform, mockMethod } = require("./helpers/mock");

// Hermetic Windows-mode matrix for the codex WSL-shadowing scenario.
//
// The bug: resolveInstallPaths in wsl-first mode picked a WSL ~/.codex path
// that exists but has NO sessions/ subdir (codex is installed on Windows, not
// in WSL), silently scanning 0 files while the real Windows install went
// missing. The first fix attempt then regressed into scanning BOTH installs
// (union) regardless of mode, double-counting and leaking native usage into
// wsl-only mode.
//
// Hermeticity design (passes identically on any host OS, with any real home):
// - process.platform is mocked to "win32" so the win32 resolver branches run
//   everywhere (Object.defineProperty, restored in teardown).
// - wsl.discoverWslHome is mocked on the shared wsl-probe module object (the
//   seam sync.js calls through), so no real wsl.exe exec and no real
//   \\wsl$\... filesystem probes. Only ".codex" may resolve to the fake WSL
//   fixture; every other provider dir must get null. No src injection point
//   is needed — mockMethod intercepts the late-bound property call.
// - HOME/USERPROFILE plus every host-touching env knob (APPDATA,
//   LOCALAPPDATA, provider *_HOME overrides) point at a fresh temp dir, so
//   the mocked-win32 provider branches cannot read host data.
// - Env restore DELETES originally-absent vars instead of assigning
//   undefined (which would materialize the string "undefined").

// Upload endpoints and provider overrides that would otherwise leak host
// installs into the mocked-win32 branches are deleted outright.
const DELETE_KEYS = [
  "TOKENTRACKER_DEVICE_TOKEN",
  "TOKENTRACKER_INSFORGE_BASE_URL",
  "TOKENTRACKER_INSFORGE_ANON_KEY",
  "TOKENTRACKER_OPENCLAW_AGENT_ID",
  "TOKENTRACKER_OPENCLAW_PREV_SESSION_ID",
  "TOKENTRACKER_OPENCLAW_SESSION_KEY",
  "KILO_HOME",
  "MIMO_HOME",
  "ZCODE_HOME",
  "KIRO_CLI_DB_PATH",
  "KIRO_HOME",
  "TOKENTRACKER_HERMES_HOME",
  "TOKENTRACKER_COPILOT_SESSION_STORE_DB",
];

const ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "CODEX_HOME",
  "CODE_HOME",
  "GEMINI_HOME",
  "OPENCODE_HOME",
  "XDG_DATA_HOME",
  "TOKENTRACKER_OPENCLAW_HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "TOKENTRACKER_WSL_MODE",
  ...DELETE_KEYS,
];

async function withIsolatedEnv(fn) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-wsl-shadow-"));
  const saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.CODEX_HOME = path.join(home, ".codex");
    process.env.CODE_HOME = path.join(home, ".code");
    process.env.GEMINI_HOME = path.join(home, ".gemini");
    process.env.OPENCODE_HOME = path.join(home, ".opencode");
    process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
    process.env.TOKENTRACKER_OPENCLAW_HOME = path.join(home, ".openclaw");
    process.env.APPDATA = path.join(home, "AppData", "Roaming");
    process.env.LOCALAPPDATA = path.join(home, "AppData", "Local");
    for (const key of DELETE_KEYS) delete process.env[key];
    // TOKENTRACKER_WSL_MODE is set or deleted per matrix case.
    return await fn(home);
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  }
}

const NATIVE_TOKENS = 120;
const WSL_TOKENS = 240;

async function writeCodexRollout(codexHome, date, uuid, totalTokens) {
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

async function readQueue(queuePath) {
  const raw = await fs.readFile(queuePath, "utf8").catch((err) => {
    if (err && err.code === "ENOENT") return "";
    throw err;
  });
  const records = raw.trim() ? raw.trim().split("\n").map((l) => JSON.parse(l)) : [];
  const codex = records.filter((r) => r && r.source === "codex");
  return {
    raw,
    codexCount: codex.length,
    codexTokens: codex.reduce((sum, r) => sum + (r.total_tokens || 0), 0),
  };
}

// Distinct native (120) vs WSL (240) totals make "which install was scanned"
// directly assertable from the queue sum: a union scan yields 360, a native
// leak into wsl-only yields 120 where 0 is expected.
const CASES = [
  { name: "wsl-first falls back to the native install when no WSL home exists", mode: "wsl-first", wsl: "missing", expected: NATIVE_TOKENS },
  { name: "wsl-first falls back past an empty WSL ~/.codex shell (the reported bug)", mode: "wsl-first", wsl: "empty", expected: NATIVE_TOKENS, runTwice: true },
  { name: "wsl-first prefers a populated WSL install without union-scanning native", mode: "wsl-first", wsl: "populated", expected: WSL_TOKENS },
  { name: "auto (unset) falls back past an empty WSL ~/.codex shell", mode: null, wsl: "empty", expected: NATIVE_TOKENS },
  { name: "auto (unset) prefers a populated WSL install without union-scanning native", mode: null, wsl: "populated", expected: WSL_TOKENS },
  { name: "wsl-only scans nothing when no WSL home exists (no native leak)", mode: "wsl-only", wsl: "missing", expected: 0 },
  { name: "wsl-only scans nothing when the WSL ~/.codex shell is empty (no native leak)", mode: "wsl-only", wsl: "empty", expected: 0 },
  { name: "wsl-only scans only the populated WSL install", mode: "wsl-only", wsl: "populated", expected: WSL_TOKENS, runTwice: true },
  { name: "both scans native and WSL installs", mode: "both", wsl: "populated", expected: NATIVE_TOKENS + WSL_TOKENS },
];

for (const kase of CASES) {
  test(`codex WSL shadow matrix: ${kase.name}`, async (t) => {
    wsl.resetWslProbeCache();
    t.after(() => wsl.resetWslProbeCache());
    mockPlatform(t, "win32");

    await withIsolatedEnv(async (home) => {
      if (kase.mode == null) delete process.env.TOKENTRACKER_WSL_MODE;
      else process.env.TOKENTRACKER_WSL_MODE = kase.mode;

      // Native (Windows) codex install, always populated.
      const nativeCodex = path.join(home, ".codex");
      await writeCodexRollout(nativeCodex, "2026-07-31", "test-uuid-native", NATIVE_TOKENS);

      // Fake WSL distro home in one of three states: missing (no dir, mock
      // returns null), empty shell (dir exists, no sessions/), or populated.
      const wslCodex = path.join(home, "wsl-home", ".codex");
      if (kase.wsl === "empty") {
        await fs.mkdir(wslCodex, { recursive: true });
      } else if (kase.wsl === "populated") {
        await writeCodexRollout(wslCodex, "2026-07-31", "test-uuid-wsl", WSL_TOKENS);
      }

      mockMethod(t, wsl, "discoverWslHome", (providerDir) =>
        providerDir === ".codex" && kase.wsl !== "missing" ? wslCodex : null,
      );

      const queuePath = path.join(home, ".tokentracker", "tracker", "queue.jsonl");

      await cmdSync([], {});
      const first = await readQueue(queuePath);

      const label = `mode=${kase.mode ?? "auto"} wsl=${kase.wsl}`;
      if (kase.expected === 0) {
        assert.equal(first.codexCount, 0, `${label}: expected zero codex records, got ${first.codexCount}`);
        assert.equal(first.codexTokens, 0, `${label}: expected zero codex tokens, got ${first.codexTokens}`);
      } else {
        assert.ok(first.codexCount > 0, `${label}: expected codex records, got none`);
        assert.equal(
          first.codexTokens,
          kase.expected,
          `${label}: expected ${kase.expected} codex tokens, got ${first.codexTokens}`,
        );
      }

      if (kase.runTwice) {
        // CodeRabbit #3: a second sync over the same fixture must be a
        // no-op — zero new codex records, zero new codex tokens.
        await cmdSync([], {});
        const second = await readQueue(queuePath);
        assert.equal(second.codexCount, first.codexCount, `${label}: second sync added codex records`);
        assert.equal(second.codexTokens, first.codexTokens, `${label}: second sync added codex tokens`);
        assert.equal(second.raw, first.raw, `${label}: second sync changed queue.jsonl`);
      }
    });
  });
}
