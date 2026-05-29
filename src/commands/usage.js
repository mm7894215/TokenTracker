"use strict";

const path = require("node:path");
const os = require("node:os");

const { resolveTrackerPaths } = require("../lib/tracker-paths");
const { ensurePricingLoaded } = require("../lib/pricing");
const { readQueueData } = require("../lib/local-api");
const {
  assertDayFlag,
  buildUsageSummary,
  renderUsageSummary,
} = require("../lib/usage-summary");

function parseArgs(argv = []) {
  const out = { from: null, to: null, json: false, localOnly: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      out.json = true;
    } else if (arg === "--local-only") {
      out.localOnly = true;
    } else if (arg === "--from") {
      const value = argv[++i];
      assertDayFlag(value, "--from");
      out.from = value;
    } else if (arg === "--to") {
      const value = argv[++i];
      assertDayFlag(value, "--to");
      out.to = value;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (out.from && out.to && out.from > out.to) {
    throw new Error(`--from must be earlier than or equal to --to`);
  }

  return out;
}

async function cmdUsage(argv = []) {
  const opts = parseArgs(argv);
  const home = os.homedir();
  const { trackerDir, cacheDir } = await resolveTrackerPaths({ home });
  const queuePath = path.join(trackerDir, "queue.jsonl");

  await ensurePricingLoaded({ cachePath: path.join(cacheDir, "pricing.json") }).catch(() => null);

  const rows = readQueueData(queuePath);
  const summary = buildUsageSummary(rows, { from: opts.from, to: opts.to });

  if (opts.json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return;
  }

  process.stdout.write(renderUsageSummary(summary));
}

module.exports = { cmdUsage, parseArgs };
