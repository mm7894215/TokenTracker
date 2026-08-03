"use strict";

const path = require("node:path");

const pkg = require("../../package.json");
const { readJson, writeJson } = require("./fs");

const STAR_CTA_URL = "https://github.com/xiufengsun/TokenTracker";
const STAR_CTA_STATE_FILE = "star-cta.json";

function isTruthyFlag(value) {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function isInteractiveCli({ stdout = process.stdout, env = process.env } = {}) {
  if (!stdout?.isTTY) return false;
  if (env?.NODE_TEST_CONTEXT !== undefined) return false;
  if (isTruthyFlag(env?.CI)) return false;
  if (isTruthyFlag(env?.TOKENTRACKER_NO_STAR_PROMPT)) return false;

  const shell = String(env?.TOKENTRACKER_APP_SHELL || "").trim().toLowerCase();
  if (shell && shell !== "cli") return false;
  return true;
}

async function maybeShowStarCta({
  trackerDir,
  stdout = process.stdout,
  env = process.env,
  nowMs = Date.now(),
  version = pkg.version,
  readJsonFn = readJson,
  writeJsonFn = writeJson,
} = {}) {
  if (!trackerDir) return { shown: false, reason: "no-tracker-dir" };
  if (!isInteractiveCli({ stdout, env })) {
    return { shown: false, reason: "non-interactive" };
  }

  const statePath = path.join(trackerDir, STAR_CTA_STATE_FILE);
  const state = await readJsonFn(statePath);
  if (state?.shown_at) return { shown: false, reason: "already-shown" };

  try {
    await writeJsonFn(statePath, {
      shown_at: new Date(nowMs).toISOString(),
      version: String(version || "").slice(0, 32),
    });
  } catch (_error) {
    // Do not print a prompt that we cannot remember; otherwise a read-only
    // install would show it on every launch.
    return { shown: false, reason: "state-write-failed" };
  }

  stdout.write(
    [
      "  ⭐ If TokenTracker helps you understand where your tokens go,",
      "     a GitHub Star helps more developers find it:",
      `     ${STAR_CTA_URL}`,
      "",
    ].join("\n"),
  );
  return { shown: true, reason: "shown" };
}

module.exports = {
  STAR_CTA_URL,
  STAR_CTA_STATE_FILE,
  isInteractiveCli,
  maybeShowStarCta,
};
