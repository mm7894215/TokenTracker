#!/usr/bin/env node

const { spawnSync } = require("child_process");

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, {
    stdio: "pipe",
    encoding: "utf8",
    ...options,
  });
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const pack = run("npm", ["pack", "--dry-run", "--json"]);
if (pack.status !== 0) {
  fail(`npm pack --dry-run failed:\n${pack.stderr || pack.stdout}`);
}

let payload = pack.stdout.trim();
if (!payload) {
  fail("npm pack --dry-run returned empty output.");
}

let data;
try {
  data = JSON.parse(payload);
} catch (err) {
  fail(`Unable to parse npm pack --dry-run JSON output: ${err.message}`);
}

const files = new Set((data[0]?.files || []).map((file) => file.path));
const required = [
  "package.json",
  "bin/tracker.js",
  "src/cli.js",
  "dashboard/dist/index.html",
];
const missing = required.filter((file) => !files.has(file));

if (missing.length > 0) {
  fail(`Missing required files in npm pack output: ${missing.join(", ")}`);
}

process.stdout.write("npm pack --dry-run ok: required files present.\n");

if (process.env.TOKENTRACKER_RUN_NPX === "1") {
  const npx = run("npx", ["--yes", "tokentracker-cli", "--help"], { stdio: "inherit" });
  if (npx.status !== 0) {
    fail("npx tokentracker-cli --help failed. Ensure the package is published publicly.");
  }
} else {
  process.stdout.write(
    "To verify after publish: TOKENTRACKER_RUN_NPX=1 node scripts/acceptance/npm-install-smoke.cjs\n",
  );
}
