const os = require("node:os");

const { promptHidden } = require("../lib/prompt");
const { resolveTrackerPaths } = require("../lib/tracker-paths");
const {
  getOpenRouterConfigSnapshot,
  saveOpenRouterApiKey,
  clearOpenRouterApiKey,
  probeOpenRouterApiKey,
  readTrackerConfig,
  resolveOpenRouterApiKey,
} = require("../lib/openrouter-config");

async function cmdConfig(argv = []) {
  const [scope, action, ...rest] = argv;
  if (scope === "openrouter") {
    await cmdConfigOpenRouter(action, rest);
    return;
  }
  throw new Error(`Unknown config scope: ${scope || "(missing)"}. Try: config openrouter`);
}

async function cmdConfigOpenRouter(action, argv = []) {
  const opts = parseArgs(argv);
  const home = os.homedir();
  const { trackerDir } = await resolveTrackerPaths({ home });
  const { config } = await readTrackerConfig({ home, trackerDir });

  switch (action) {
    case "status":
      await printOpenRouterStatus({ config, opts });
      return;
    case "set":
      await setOpenRouterKey({ config, trackerDir, home, opts });
      return;
    case "clear":
      await clearOpenRouterKey({ trackerDir, home, opts });
      return;
    case "test": {
      const apiKey = resolveOpenRouterApiKey({ config, env: process.env });
      if (!apiKey) {
        const message = "OpenRouter API key not configured";
        if (opts.json) {
          process.stdout.write(JSON.stringify({ ok: false, error: message }, null, 2) + "\n");
        } else {
          process.stderr.write(`${message}\n`);
        }
        process.exitCode = 1;
        return;
      }
      const probe = await probeOpenRouterApiKey(apiKey);
      if (opts.json) {
        process.stdout.write(JSON.stringify(probe, null, 2) + "\n");
      } else if (probe.ok) {
        process.stdout.write("OpenRouter API key verified\n");
      } else {
        process.stderr.write(`${probe.error || "OpenRouter API key test failed"}\n`);
      }
      if (!probe.ok) process.exitCode = 1;
      return;
    }
    default:
      throw new Error(
        `Unknown config openrouter action: ${action || "(missing)"}. Try: status | set | clear | test`,
      );
  }
}

async function printOpenRouterStatus({ config, opts }) {
  const snapshot = getOpenRouterConfigSnapshot({ config, env: process.env });
  if (opts.json) {
    process.stdout.write(JSON.stringify(snapshot, null, 2) + "\n");
    return;
  }

  if (!snapshot.configured) {
    process.stdout.write("OpenRouter: not configured\n");
    process.stdout.write("Set with: tokentracker config openrouter set\n");
    return;
  }

  process.stdout.write(`OpenRouter: configured (${snapshot.source})\n`);
  if (snapshot.masked_key) {
    process.stdout.write(`Key: ${snapshot.masked_key}\n`);
  }
  if (snapshot.env_overrides_config) {
    process.stdout.write("Note: OPENROUTER_API_KEY env overrides saved config key\n");
  }
  if (snapshot.configured_at) {
    process.stdout.write(`Saved at: ${snapshot.configured_at}\n`);
  }
}

async function setOpenRouterKey({ trackerDir, home, opts }) {
  let apiKey = typeof opts.key === "string" ? opts.key.trim() : "";
  if (!apiKey) {
    apiKey = (await promptHidden("OpenRouter API key: ")).trim();
  }
  if (!apiKey) {
    throw new Error("OpenRouter API key is required");
  }

  const result = await saveOpenRouterApiKey({
    apiKey,
    home,
    trackerDir,
    verify: opts.verify !== false,
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  process.stdout.write(`OpenRouter API key saved (${result.masked_key})\n`);
  if (result.verified) {
    process.stdout.write("OpenRouter API key verified\n");
  } else if (result.verify_error) {
    process.stderr.write(`Warning: verification failed — ${result.verify_error}\n`);
  }
}

async function clearOpenRouterKey({ trackerDir, home, opts }) {
  const result = await clearOpenRouterApiKey({ home, trackerDir });
  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  process.stdout.write(result.cleared ? "OpenRouter API key cleared\n" : "OpenRouter API key already unset\n");
}

function parseArgs(argv) {
  const opts = { json: false, verify: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") opts.json = true;
    else if (arg === "--no-verify") opts.verify = false;
    else if (arg === "--key") opts.key = argv[++i];
    else if (arg === "--verify") opts.verify = true;
    else throw new Error(`Unknown flag: ${arg}`);
  }
  return opts;
}

module.exports = { cmdConfig, cmdConfigOpenRouter };
