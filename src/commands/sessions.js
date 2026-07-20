"use strict";

const fs = require("node:fs");
const { buildSessionAnalytics, summarizeSessions, sessionsToCsv } = require("../lib/session-analytics");
const { buildGitOutcomes } = require("../lib/git-outcomes");

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || "" : "";
}

async function cmdSessions(args = []) {
  const format = option(args, "--format") || (args.includes("--csv") ? "csv" : "json");
  const out = option(args, "--out");
  const sessions = await buildSessionAnalytics({ force: args.includes("--refresh") });
  if (!args.includes("--no-git")) await buildGitOutcomes(sessions);
  const summary = summarizeSessions(sessions, { from: option(args, "--from"), to: option(args, "--to") });
  const content = format === "csv"
    ? sessionsToCsv(summary.sessions)
    : `${JSON.stringify(summary, null, 2)}\n`;
  if (out) {
    fs.writeFileSync(out, content, { encoding: "utf8", mode: 0o600 });
    process.stdout.write(`${out}\n`);
  } else {
    process.stdout.write(content);
  }
}

module.exports = { cmdSessions };
