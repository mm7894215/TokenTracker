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
  resolveOmpHome,
} = require("../src/lib/omp-hook");
const rollout = require("../src/lib/rollout");
const { applyIntegrationSetup } = require("../src/commands/init");

test("resolveOmpAgentDir prefers TokenTracker override and expands ~", () => {
  const home = "/tmp/tt-home-omp";
  assert.equal(
    resolveOmpAgentDir({
      HOME: home,
      TOKENTRACKER_OMP_AGENT_DIR: "/tmp/tt-omp-agent",
      OMP_HOME: "/tmp/omp-home",
    }),
    "/tmp/tt-omp-agent",
  );
  assert.equal(
    resolveOmpAgentDir({
      HOME: home,
      TOKENTRACKER_OMP_AGENT_DIR: "~/.omp/agent",
    }),
    path.join(home, ".omp", "agent"),
  );
  assert.equal(
    resolveOmpExtensionsDir({ HOME: home, TOKENTRACKER_OMP_AGENT_DIR: "/tmp/tt-omp-agent" }),
    path.join("/tmp/tt-omp-agent", "extensions"),
  );
});

test("omp-hook path resolvers stay in parity with rollout passive scanner", () => {
  const cases = [
    { HOME: "/Users/alice" },
    { HOME: "/Users/alice", OMP_HOME: "/custom/omp" },
    { HOME: "/Users/alice", PI_CONFIG_DIR: ".config/omp" },
    { HOME: "/Users/alice", TOKENTRACKER_OMP_AGENT_DIR: "~/.omp/agent" },
    {
      HOME: "/Users/alice",
      PI_CODING_AGENT_DIR: "~/shared/agent",
      // no ~/.pi dir signal in env alone; owner defaults to omp
    },
    {
      HOME: "/Users/alice",
      TOKENTRACKER_OMP_AGENT_DIR: "/abs/omp/agent",
      PI_CODING_AGENT_DIR: "/abs/pi/agent",
    },
  ];

  for (const env of cases) {
    assert.equal(
      resolveOmpHome(env),
      rollout.resolveOmpHome(env),
      `resolveOmpHome parity failed for ${JSON.stringify(env)}`,
    );
    assert.equal(
      resolveOmpAgentDir(env),
      rollout.resolveOmpAgentDir(env),
      `resolveOmpAgentDir parity failed for ${JSON.stringify(env)}`,
    );
  }

  // Windows-style env: both resolvers must agree (and expand HOME).
  if (process.platform === "win32") {
    const winEnv = {
      HOME: "C:\\Users\\alice",
      USERPROFILE: "C:\\Users\\alice",
    };
    assert.equal(resolveOmpHome(winEnv), rollout.resolveOmpHome(winEnv));
    assert.equal(resolveOmpAgentDir(winEnv), rollout.resolveOmpAgentDir(winEnv));
  }
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

test("upsertOmpHook does not clobber unmanaged extension without marker", async () => {
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

test("upsertOmpHook rewrites an existing managed extension from byte zero", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-omp-hook-repeat-"));
  try {
    const home = tmp;
    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    const ompAgentDir = path.join(tmp, ".omp", "agent");
    await fs.mkdir(path.join(ompAgentDir, "sessions"), { recursive: true });
    const env = {
      ...process.env,
      HOME: home,
      TOKENTRACKER_OMP_AGENT_DIR: ompAgentDir,
    };

    const first = await upsertOmpHook({ home, trackerDir, env });
    assert.equal(first.written, true);
    const firstBytes = await fs.readFile(first.extensionPath);

    const second = await upsertOmpHook({ home, trackerDir, env });
    assert.equal(second.written, true);
    const secondBytes = await fs.readFile(second.extensionPath);

    assert.deepEqual(secondBytes, firstBytes);
    assert.equal(secondBytes.includes(0), false);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("upsertOmpHook returns a structured identity-check failure", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-omp-hook-stat-failure-"));
  const { _testHooks } = require("../src/lib/omp-hook");
  const realStat = fs.stat;
  try {
    const home = tmp;
    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    const ompAgentDir = path.join(tmp, ".omp", "agent");
    await fs.mkdir(path.join(ompAgentDir, "sessions"), { recursive: true });
    const env = {
      ...process.env,
      HOME: home,
      TOKENTRACKER_OMP_AGENT_DIR: ompAgentDir,
    };

    const first = await upsertOmpHook({ home, trackerDir, env });
    assert.equal(first.written, true);

    let failIdentityCheck = false;
    _testHooks.beforeManagedWrite = async () => {
      failIdentityCheck = true;
    };
    fs.stat = async (...args) => {
      if (failIdentityCheck && args[0] === first.extensionPath) {
        const err = new Error("identity stat denied");
        err.code = "EACCES";
        throw err;
      }
      return realStat(...args);
    };

    const result = await upsertOmpHook({ home, trackerDir, env });
    assert.equal(result.written, false);
    assert.equal(result.skippedReason, "identity-check-failed");
    assert.match(result.error, /identity stat denied/);
  } finally {
    fs.stat = realStat;
    _testHooks.beforeManagedWrite = null;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("upsert and remove leave unmanaged tokentracker-mentioning extension untouched", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-omp-hook-user-bridge-"));
  try {
    const home = tmp;
    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    const ompAgentDir = path.join(tmp, ".omp", "agent");
    const extDir = path.join(ompAgentDir, "extensions");
    await fs.mkdir(extDir, { recursive: true });
    await fs.mkdir(path.join(trackerDir, "..", "bin"), { recursive: true });
    const extensionPath = path.join(extDir, EXTENSION_FILENAME);
    // User-authored bridge that mentions tokentracker but has no managed marker.
    const userSource = [
      "// custom tokentracker notify bridge",
      'import { spawn } from "node:child_process";',
      "export default function (pi) {",
      '  pi.on("turn_end", () => spawn("node", ["notify.cjs", "--source=omp"]));',
      "}",
      "",
    ].join("\n");
    await fs.writeFile(extensionPath, userSource, "utf8");

    const env = {
      ...process.env,
      HOME: home,
      TOKENTRACKER_OMP_AGENT_DIR: ompAgentDir,
    };

    const upsert = await upsertOmpHook({ home, trackerDir, env });
    assert.equal(upsert.written, false);
    assert.equal(upsert.skippedReason, "unmanaged-extension-present");
    assert.equal(await fs.readFile(extensionPath, "utf8"), userSource);

    const removed = await removeOmpHook({ home, trackerDir, env });
    assert.equal(removed.removed, false);
    assert.equal(removed.skippedReason, "unmanaged");
    assert.equal(await fs.readFile(extensionPath, "utf8"), userSource);

    const state = await probeOmpHookState({ home, trackerDir, env });
    assert.equal(state.exists, true);
    assert.equal(state.managed, false);
    // Status UX may still report configured=true because content mentions tokentracker.
    assert.equal(state.configured, true);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("removeOmpHook reports unlink-failed when deletion is blocked", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-omp-hook-unlink-"));
  const realUnlink = fs.unlink;
  try {
    const home = tmp;
    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    const ompAgentDir = path.join(tmp, ".omp", "agent");
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

    fs.unlink = async () => {
      const err = new Error("permission denied");
      err.code = "EPERM";
      throw err;
    };

    const removed = await removeOmpHook({ home, trackerDir, env });
    assert.equal(removed.removed, false);
    assert.equal(removed.skippedReason, "unlink-failed");
    assert.equal(removed.staleStaging, true);
    assert.match(removed.stagingError, /permission denied/);
    assert.ok(removed.stagedPath);
    assert.ok(fssync.existsSync(removed.stagedPath));
    assert.ok(fssync.existsSync(written.extensionPath));
    const restoredContent = await fs.readFile(written.extensionPath, "utf8");
    assert.ok(isManagedOmpExtension(restoredContent));
  } finally {
    fs.unlink = realUnlink;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("applyIntegrationSetup installs omp notify extension without opts ReferenceError", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-omp-init-integration-"));
  const prevHome = process.env.HOME;
  const prevOmpAgent = process.env.TOKENTRACKER_OMP_AGENT_DIR;
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

    process.env.HOME = home;
    process.env.TOKENTRACKER_OMP_AGENT_DIR = ompAgentDir;

    const notifyPath = path.join(trackerDir, "..", "bin", "notify.cjs");
    const summary = await applyIntegrationSetup({
      home,
      trackerDir,
      notifyPath,
      notifyOriginalPath: null,
      dryRun: false,
    });

    const ompRow = summary.find((row) => row.label === "oh-my-pi");
    assert.ok(ompRow, "expected oh-my-pi summary row");
    assert.equal(ompRow.status, "installed");

    const extensionPath = path.join(ompAgentDir, "extensions", EXTENSION_FILENAME);
    assert.ok(fssync.existsSync(extensionPath));
    const content = await fs.readFile(extensionPath, "utf8");
    assert.ok(isManagedOmpExtension(content));
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevOmpAgent === undefined) delete process.env.TOKENTRACKER_OMP_AGENT_DIR;
    else process.env.TOKENTRACKER_OMP_AGENT_DIR = prevOmpAgent;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("applyIntegrationSetup dryRun probes omp without writing extension", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-omp-init-dry-"));
  const prevHome = process.env.HOME;
  const prevOmpAgent = process.env.TOKENTRACKER_OMP_AGENT_DIR;
  try {
    const home = tmp;
    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    const ompAgentDir = path.join(tmp, ".omp", "agent");
    await fs.mkdir(path.join(trackerDir), { recursive: true });
    await fs.mkdir(path.join(ompAgentDir, "sessions"), { recursive: true });

    process.env.HOME = home;
    process.env.TOKENTRACKER_OMP_AGENT_DIR = ompAgentDir;

    const summary = await applyIntegrationSetup({
      home,
      trackerDir,
      notifyPath: path.join(trackerDir, "..", "bin", "notify.cjs"),
      notifyOriginalPath: null,
      dryRun: true,
    });

    const ompRow = summary.find((row) => row.label === "oh-my-pi");
    assert.ok(ompRow);
    assert.equal(ompRow.status, "detected");
    assert.match(ompRow.detail, /Will install notify extension/);
    assert.equal(
      fssync.existsSync(path.join(ompAgentDir, "extensions", EXTENSION_FILENAME)),
      false,
    );
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevOmpAgent === undefined) delete process.env.TOKENTRACKER_OMP_AGENT_DIR;
    else process.env.TOKENTRACKER_OMP_AGENT_DIR = prevOmpAgent;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("upsertOmpHook does not overwrite a user file created between check and create", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-omp-hook-create-race-"));
  const { _testHooks } = require("../src/lib/omp-hook");
  try {
    const home = tmp;
    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    const ompAgentDir = path.join(tmp, ".omp", "agent");
    const extDir = path.join(ompAgentDir, "extensions");
    await fs.mkdir(extDir, { recursive: true });
    await fs.mkdir(path.join(trackerDir, "..", "bin"), { recursive: true });
    await fs.writeFile(
      path.join(trackerDir, "..", "bin", "notify.cjs"),
      "#!/usr/bin/env node\nconsole.log('notify');\n",
      "utf8",
    );

    const extensionPath = path.join(extDir, EXTENSION_FILENAME);
    const userSource = "// user tokentracker bridge created during race\nexport default function () {}\n";

    _testHooks.beforeExclusiveCreate = async (targetPath) => {
      await fs.writeFile(targetPath, userSource, "utf8");
    };

    const env = {
      ...process.env,
      HOME: home,
      TOKENTRACKER_OMP_AGENT_DIR: ompAgentDir,
    };
    const result = await upsertOmpHook({ home, trackerDir, env });
    assert.equal(result.written, false);
    assert.equal(result.skippedReason, "unmanaged-extension-present");
    assert.equal(await fs.readFile(extensionPath, "utf8"), userSource);
  } finally {
    _testHooks.beforeExclusiveCreate = null;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("removeOmpHook does not delete a user replacement created between check and unlink", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-omp-hook-remove-race-"));
  const { _testHooks } = require("../src/lib/omp-hook");
  try {
    const home = tmp;
    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    const ompAgentDir = path.join(tmp, ".omp", "agent");
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
    const extensionPath = written.extensionPath;
    const userReplacement =
      "// user replacement during uninstall race\nexport default function (pi) { pi.on('turn_end', () => {}); }\n";

    _testHooks.beforeUnlink = async (targetPath) => {
      // Replace managed file with user-authored content under the same path.
      await fs.unlink(targetPath);
      await fs.writeFile(targetPath, userReplacement, "utf8");
    };

    const removed = await removeOmpHook({ home, trackerDir, env });
    assert.equal(removed.removed, false);
    assert.equal(removed.skippedReason, "identity-changed");
    assert.equal(fssync.existsSync(extensionPath), true);
    assert.equal(await fs.readFile(extensionPath, "utf8"), userReplacement);
    assert.equal(isManagedOmpExtension(await fs.readFile(extensionPath, "utf8")), false);
  } finally {
    _testHooks.beforeUnlink = null;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("removeOmpHook preserves a user replacement during staging restore", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-omp-hook-staging-race-"));
  const { _testHooks } = require("../src/lib/omp-hook");
  try {
    const home = tmp;
    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    const ompAgentDir = path.join(tmp, ".omp", "agent");
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
    const extensionPath = written.extensionPath;
    const userSourceA = "// user file A\nexport default function () { return 'A'; }\n";
    const userSourceB = "// user file B\nexport default function () { return 'B'; }\n";

    _testHooks.beforeUnlink = async (targetPath) => {
      await fs.unlink(targetPath);
      await fs.writeFile(targetPath, userSourceA, "utf8");
    };
    _testHooks.afterStagingRename = async (targetPath, stagingPath) => {
      assert.equal(await fs.readFile(stagingPath, "utf8"), userSourceA);
      await fs.writeFile(targetPath, userSourceB, "utf8");
    };

    const removed = await removeOmpHook({ home, trackerDir, env });
    assert.equal(removed.removed, false);
    assert.equal(removed.skippedReason, "identity-changed");
    assert.ok(fssync.existsSync(extensionPath));
    assert.equal(await fs.readFile(extensionPath, "utf8"), userSourceB);
    assert.ok(removed.stagedPath);
    assert.ok(fssync.existsSync(removed.stagedPath));
    assert.equal(await fs.readFile(removed.stagedPath, "utf8"), userSourceA);
  } finally {
    _testHooks.beforeUnlink = null;
    _testHooks.afterStagingRename = null;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("formatOmpHookRemoveLine surfaces unlink/read failures with residual path", () => {
  const { formatOmpHookRemoveLine } = require("../src/commands/uninstall");
  assert.match(
    formatOmpHookRemoveLine({
      removed: false,
      skippedReason: "unlink-failed",
      error: "EPERM",
      extensionPath: "/tmp/ext/tokentracker-notify.ts",
    }),
    /failed to remove.*EPERM.*left in place: \/tmp\/ext\/tokentracker-notify\.ts/,
  );
  assert.match(
    formatOmpHookRemoveLine({
      removed: false,
      skippedReason: "extension-read-failed",
      error: "EACCES",
      extensionPath: "/tmp/ext/tokentracker-notify.ts",
    }),
    /failed to read.*EACCES.*left in place/,
  );
  assert.match(
    formatOmpHookRemoveLine({
      removed: false,
      skippedReason: "identity-changed",
      extensionPath: "/tmp/ext/tokentracker-notify.ts",
      stagedPath: "/tmp/ext/.tokentracker-notify.ts.removing",
    }),
    /file changed during uninstall.*left in place: \/tmp\/ext\/\.tokentracker-notify\.ts\.removing/,
  );
  assert.match(
    formatOmpHookRemoveLine({
      removed: false,
      skippedReason: "unmanaged",
      extensionPath: "/tmp/ext/tokentracker-notify.ts",
    }),
    /unmanaged file.*left in place/,
  );
  assert.match(
    formatOmpHookRemoveLine({
      removed: true,
      extensionPath: "/tmp/ext/tokentracker-notify.ts",
    }),
    /notify extension removed/,
  );
});
