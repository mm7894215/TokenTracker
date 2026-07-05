const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const WORKFLOW_PATH = path.join(
  __dirname,
  "..",
  ".github",
  "workflows",
  "release-linux.yml"
);

const SCRIPT_PATH = path.join(
  __dirname,
  "..",
  "scripts",
  "release",
  "bundle-node-linux.sh"
);

function loadWorkflow() {
  return fs.readFileSync(WORKFLOW_PATH, "utf8");
}

function loadScript() {
  return fs.readFileSync(SCRIPT_PATH, "utf8");
}

function parseWorkflow() {
  const script = [
    "import json, sys, yaml",
    `with open(${JSON.stringify(WORKFLOW_PATH)}, 'r', encoding='utf-8') as f:`,
    "    print(json.dumps(yaml.load(f, Loader=yaml.BaseLoader)))",
  ].join("\n");
  return JSON.parse(execFileSync("python3", ["-c", script], { encoding: "utf8" }));
}

test("release-linux workflow file exists", () => {
  assert.ok(fs.existsSync(WORKFLOW_PATH));
});

test("workflow supports manual and reusable invocation", () => {
  const workflow = parseWorkflow();
  assert.ok(workflow.on.workflow_dispatch);
  assert.ok(workflow.on.workflow_call);
  assert.equal(workflow.on.workflow_dispatch.inputs.version.required, "true");
  assert.equal(workflow.on.workflow_call.inputs.version.required, "true");
});

test("workflow uses an Ubuntu runner", () => {
  const workflow = parseWorkflow();
  assert.equal(workflow.jobs.build["runs-on"], "ubuntu-latest");
});

test("workflow verifies the requested version against package.json", () => {
  const workflow = parseWorkflow();
  const content = loadWorkflow();
  assert.equal(workflow.jobs.build["timeout-minutes"], "30");
  assert.ok(content.includes("Verify version"));
  assert.ok(content.includes("package.json version"));
  assert.ok(content.includes("VERSION: ${{ inputs.version }}"));
});

test("workflow builds dashboard before bundling the Linux runtime", () => {
  const content = loadWorkflow();
  const dashBuild = content.indexOf("dashboard:build");
  const bundle = content.indexOf("bundle-node-linux.sh");
  assert.ok(dashBuild > 0, "should build dashboard");
  assert.ok(bundle > 0, "should bundle Linux runtime");
  assert.ok(dashBuild < bundle, "dashboard build must come before Linux bundle");
});

test("workflow verifies the packaged Linux bundle contains the dashboard and launcher", () => {
  const content = loadWorkflow();
  assert.ok(content.includes("build/linux-x64/tokentracker"));
  assert.ok(content.includes("EmbeddedServer/node"));
  assert.ok(content.includes("dashboard/dist/index.html"));
});

test("workflow packages a stable linux-x64 tarball asset", () => {
  const content = loadWorkflow();
  assert.ok(content.includes("TokenTracker-linux-x64.tar.gz"));
  assert.ok(content.includes("tar -C build/linux-x64 -czf"));
});

test("workflow uploads the tarball to the GitHub release", () => {
  const content = loadWorkflow();
  assert.ok(content.includes("gh release upload"));
  assert.ok(content.includes("gh release create"));
  assert.ok(content.includes("--clobber"));
});

test("workflow has a per-version concurrency guard", () => {
  const workflow = parseWorkflow();
  assert.equal(workflow.concurrency.group, "release-linux-${{ inputs.version }}");
  assert.equal(workflow.concurrency["cancel-in-progress"], "false");
});

test("linux bundle script exists", () => {
  assert.ok(fs.existsSync(SCRIPT_PATH));
});

test("linux bundle script pins the Node runtime and downloads the linux-x64 archive", () => {
  const script = loadScript();
  assert.ok(script.includes('EXPECTED_NODE_VERSION="22.22.2"'));
  assert.ok(script.includes('node-v${NODE_VERSION}-linux-x64.tar.xz'));
  assert.ok(script.includes("SHASUMS256.txt"));
  assert.ok(script.includes("sha256sum"));
});

test("linux bundle script installs production dependencies only", () => {
  const script = loadScript();
  assert.ok(script.includes("npm ci --omit=dev --no-optional --ignore-scripts"));
  assert.ok(script.includes('cp "$REPO_ROOT/package-lock.json" "$TT_DIR/"'));
});

test("linux bundle script fails when dashboard/dist is missing", () => {
  const script = loadScript();
  assert.ok(script.includes("dashboard/dist not found"));
  assert.ok(script.includes("exit 1"));
});

test("linux bundle script emits a launcher that execs the bundled tracker", () => {
  const script = loadScript();
  assert.ok(script.includes('cat > "$BUILD_ROOT/tokentracker"'));
  assert.ok(script.includes('EmbeddedServer/node'));
  assert.ok(script.includes('EmbeddedServer/tokentracker/bin/tracker.js'));
});

test("linux bundle script has valid shell syntax", () => {
  assert.doesNotThrow(() => {
    execFileSync("bash", ["-n", SCRIPT_PATH], { stdio: "pipe" });
  });
});
