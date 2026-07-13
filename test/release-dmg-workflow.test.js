const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const WORKFLOW_PATH = path.join(
  __dirname,
  "..",
  ".github",
  "workflows",
  "release-dmg.yml"
);

function loadWorkflow() {
  return fs.readFileSync(WORKFLOW_PATH, "utf8");
}

test("release-dmg workflow file exists", () => {
  assert.ok(fs.existsSync(WORKFLOW_PATH));
});

test("workflow triggers on workflow_dispatch with version input", () => {
  const content = loadWorkflow();
  assert.ok(content.includes("workflow_dispatch:"));
  assert.ok(content.includes("version:"));
});

test("workflow uses macOS runner", () => {
  const content = loadWorkflow();
  assert.ok(
    /runs-on:\s*macos-/.test(content),
    "should use macOS runner for xcodebuild"
  );
});

test("workflow verifies version matches package.json", () => {
  const content = loadWorkflow();
  assert.ok(
    content.includes("Verify version"),
    "should have a version verification step"
  );
});

test("workflow builds dashboard before bundling", () => {
  const content = loadWorkflow();
  const dashBuild = content.indexOf("dashboard:build");
  const bundle = content.indexOf("bundle-node.sh");
  assert.ok(dashBuild > 0, "should build dashboard");
  assert.ok(bundle > 0, "should bundle EmbeddedServer");
  assert.ok(
    dashBuild < bundle,
    "dashboard build must come before EmbeddedServer bundle"
  );
});

test("workflow bundles EmbeddedServer via bundle-node.sh", () => {
  const content = loadWorkflow();
  assert.ok(content.includes("bundle-node.sh"));
});

test("workflow installs xcodegen", () => {
  const content = loadWorkflow();
  assert.ok(content.includes("brew install xcodegen"));
});

test("workflow generates Xcode project and patches icon", () => {
  const content = loadWorkflow();
  assert.ok(content.includes("xcodegen generate"));
  assert.ok(content.includes("patch-pbxproj-icon.rb"));
});

test("workflow builds with xcodebuild Release config", () => {
  const content = loadWorkflow();
  assert.ok(content.includes("xcodebuild"));
  assert.ok(content.includes("-configuration Release"));
  assert.ok(content.includes("-scheme TokenTrackerBar"));
});

test("workflow creates DMG via create-dmg.sh", () => {
  const content = loadWorkflow();
  assert.ok(content.includes("create-dmg.sh"));
});

test("workflow creates the release up front and uploads the DMG asset", () => {
  const content = loadWorkflow();
  // A dedicated create-release job makes the release first (so macOS + Windows
  // can attach in parallel); the build job then uploads the DMG with --clobber.
  assert.ok(content.includes("gh release create"));
  assert.ok(content.includes("gh release upload"));
  assert.ok(content.includes("TokenTrackerBar.dmg"));
});

test("workflow has correct step order: dashboard → bundle → xcode → dmg → upload", () => {
  const content = loadWorkflow();
  // `gh release create` now lives in the create-release job (before these
  // steps), so the ordered milestone is the DMG upload, which must come last.
  const steps = [
    "dashboard:build",
    "bundle-node.sh",
    "xcodegen generate",
    "patch-pbxproj-icon.rb",
    "xcodebuild",
    "create-dmg.sh",
    "gh release upload",
  ];
  let lastIndex = -1;
  for (const step of steps) {
    const idx = content.indexOf(step);
    assert.ok(idx > lastIndex, `"${step}" should come after previous step`);
    lastIndex = idx;
  }
});

test("release is created as a draft and only published after both builds", () => {
  const content = loadWorkflow();
  // create-release makes a DRAFT so releases/latest never shows a partial
  // release while assets upload in parallel.
  assert.ok(
    /gh release create[^\n]*--draft/.test(content),
    "create-release must create a --draft release"
  );
  // A publish job flips it live, gated on BOTH platform builds.
  assert.ok(/^\s{2}publish:/m.test(content), "must have a publish job");
  assert.ok(
    /publish:\s*\n\s*needs:\s*\[build,\s*windows\]/.test(content),
    "publish must need both build and windows"
  );
  assert.ok(
    /gh release edit[^\n]*--draft=false/.test(content),
    "publish must un-draft the release"
  );
});

test("published releases are immutable and builds use the version tag", () => {
  const content = loadWorkflow();
  assert.ok(
    content.includes("ref: refs/tags/v${{ inputs.version }}"),
    "macOS must build from the immutable version tag"
  );
  assert.ok(
    content.includes("--json isDraft"),
    "release state must be checked before draft reuse or asset upload"
  );
  assert.ok(
    content.includes("Published assets are immutable"),
    "an existing public release must fail instead of being reused"
  );
  assert.ok(
    content.includes('tag_sha=$(git rev-list -n 1 "$tag")'),
    "an existing draft tag must match the workflow commit"
  );
  assert.ok(
    content.includes('repos/$GITHUB_REPOSITORY/git/refs'),
    "the tag ref must be created explicitly before draft builders check it out"
  );
  assert.ok(
    content.indexOf('tag_sha=$(git rev-list -n 1 "$tag")') <
      content.indexOf('draft_sha=$(jq -r \'.targetCommitish\''),
    "an existing tag SHA must be authoritative before falling back to draft targetCommitish"
  );
  assert.ok(
    /gh release create[^\n]*--verify-tag[^\n]*--draft/.test(content),
    "the draft must be created only after the immutable tag exists"
  );
});

test("homebrew tap is notified only after publish (not mid-build)", () => {
  const content = loadWorkflow();
  // The dispatch must come AFTER the un-draft, so the tap fetches a public,
  // fully-populated release — never a draft or an asset-less one.
  const undraft = content.indexOf("--draft=false");
  const dispatch = content.indexOf("homebrew-tokentracker/dispatches");
  assert.ok(undraft > 0 && dispatch > 0, "both un-draft and dispatch must exist");
  assert.ok(dispatch > undraft, "homebrew dispatch must come after un-drafting");
});

test("workflow has concurrency guard", () => {
  const content = loadWorkflow();
  assert.ok(content.includes("concurrency:"));
});

test("workflow has write permissions for release creation", () => {
  const content = loadWorkflow();
  assert.ok(content.includes("contents: write"));
});

test("create-dmg.sh supports CI headless mode", () => {
  const dmgScript = fs.readFileSync(
    path.join(__dirname, "..", "TokenTrackerBar", "scripts", "create-dmg.sh"),
    "utf8"
  );
  assert.ok(
    dmgScript.includes('CI:-}'),
    "create-dmg.sh should check CI env var for headless mode"
  );
});
