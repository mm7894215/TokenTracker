const assert = require("node:assert/strict");
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

test("release-linux workflow file exists", () => {
  assert.ok(fs.existsSync(WORKFLOW_PATH));
});

test("workflow supports manual and reusable invocation", () => {
  const content = loadWorkflow();
  assert.ok(content.includes("workflow_dispatch:"));
  assert.ok(content.includes("workflow_call:"));
  assert.ok(content.includes("version:"));
});

test("workflow uses an Ubuntu runner", () => {
  const content = loadWorkflow();
  assert.ok(/runs-on:\s*ubuntu-latest/.test(content));
});

test("workflow verifies the requested version against package.json", () => {
  const content = loadWorkflow();
  assert.ok(content.includes("Verify version"));
  assert.ok(content.includes("package.json version"));
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
  const content = loadWorkflow();
  assert.ok(content.includes("concurrency:"));
  assert.ok(content.includes("release-linux-${{ inputs.version }}"));
});

test("linux bundle script exists", () => {
  assert.ok(fs.existsSync(SCRIPT_PATH));
});

test("linux bundle script pins the Node runtime and downloads the linux-x64 archive", () => {
  const script = loadScript();
  assert.ok(script.includes('EXPECTED_NODE_VERSION="22.22.2"'));
  assert.ok(script.includes('node-v${NODE_VERSION}-linux-x64.tar.xz'));
});

test("linux bundle script installs production dependencies only", () => {
  const script = loadScript();
  assert.ok(script.includes("npm install --omit=dev --no-optional --ignore-scripts"));
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
