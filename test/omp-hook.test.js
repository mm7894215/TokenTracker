const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const fssync = require("node:fs");
const { test } = require("node:test");

const {
  EXTENSION_FILENAME,
  MARKER,
  buildOmpNotifyExtensionSource,
  isManagedOmpExtension,
  probeOmpHookState,
  upsertOmpHook,
  removeOmpHook,
  resolveOmpAgentDir,
  resolveOmpExtensionsDir,
} = require("../src/lib/omp-hook");

test("resolveOmpAgentDir prefers TokenTracker override", () => {
  assert.equal(
    resolveOmpAgentDir({
      TOKENTRACKER_OMP_AGENT_DIR: "/tmp/tt-omp-agent",
      OMP_HOME: "/tmp/omp-home",
    }),
    "/tmp/tt-omp-agent",
  );
  assert.equal(
    resolveOmpExtensionsDir({ TOKENTRACKER_OMP_AGENT_DIR: "/tmp/tt-omp-agent" }),
    path.join("/tmp/tt-omp-agent", "extensions"),
  );
});

test("buildOmpNotifyExtensionSource embeds notify path and marker", () => {
  const source = buildOmpNotifyExtensionSource({
    notifyPath: "/Users/me/.tokentracker/bin/notify.cjs",
  });
  assert.ok(source.includes(MARKER));
  assert.ok(source.includes("--source="));
  assert.ok(source.includes("turn_end"));
  assert.ok(source.includes("agent_end"));
  assert.ok(source.includes("session_shutdown"));
  assert.ok(source.includes("/Users/me/.tokentracker/bin/notify.cjs"));
  assert.ok(isManagedOmpExtension(source));
});

test("upsertOmpHook writes managed extension and remove cleans it", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-omp-hook-"));
  try {
    const home = tmp;
    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    const ompAgentDir = path.join(tmp, ".omp", "agent");
    await fs.mkdir(path.join(trackerDir), { recursive: true });
    await fs.mkdir(path.join(trackerDir, "..", "bin"), { recursive: true });
    await fs.mkdir(path.join(ompAgentDir, "sessions"), { recursive: true });
    await fs.writeFile(
      path.join(trackerDir, "..", "bin", "notify.cjs"),
      "#!/usr/bin/env node\nconsole.log('notify');\n",
      "utf8",
    );

    const env = {
      ...process.env,
      HOME: home,
      TOKENTRACKER_OMP_AGENT_DIR: ompAgentDir,
    };

    const written = await upsertOmpHook({ home, trackerDir, env });
    assert.equal(written.written, true);
    assert.ok(fssync.existsSync(written.extensionPath));
    const content = await fs.readFile(written.extensionPath, "utf8");
    assert.ok(isManagedOmpExtension(content));
    assert.equal(path.basename(written.extensionPath), EXTENSION_FILENAME);

    const state = await probeOmpHookState({ home, trackerDir, env });
    assert.equal(state.configured, true);
    assert.equal(state.managed, true);
    assert.equal(state.ompPresent, true);

    const removed = await removeOmpHook({ home, trackerDir, env });
    assert.equal(removed.removed, true);
    assert.equal(fssync.existsSync(written.extensionPath), false);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("upsertOmpHook does not clobber unmanaged extension", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-omp-hook-unmanaged-"));
  try {
    const home = tmp;
    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    const ompAgentDir = path.join(tmp, ".omp", "agent");
    const extDir = path.join(ompAgentDir, "extensions");
    await fs.mkdir(extDir, { recursive: true });
    await fs.mkdir(path.join(trackerDir, "..", "bin"), { recursive: true });
    const extensionPath = path.join(extDir, EXTENSION_FILENAME);
    await fs.writeFile(extensionPath, "export default function () {}\n", "utf8");

    const env = {
      ...process.env,
      HOME: home,
      TOKENTRACKER_OMP_AGENT_DIR: ompAgentDir,
    };
    const result = await upsertOmpHook({ home, trackerDir, env });
    assert.equal(result.written, false);
    assert.equal(result.skippedReason, "unmanaged-extension-present");
    const content = await fs.readFile(extensionPath, "utf8");
    assert.equal(content, "export default function () {}\n");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
