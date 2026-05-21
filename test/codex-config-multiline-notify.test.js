const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { readNotify, upsertNotify, restoreNotify } = require("../src/lib/codex-config");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("readNotify parses multi-line notify arrays", async () => {
  const dir = tmpDir("tokentracker-codex-config-");
  const configPath = path.join(dir, "config.toml");

  fs.writeFileSync(
    configPath,
    [
      'model = "gpt-5.3-codex"',
      "notify = [",
      '  "/Users/tokentracker/.bun/bin/bun",',
      '  "/Users/tokentracker/.confirmo/hooks/confirmo-codex-hook.js"',
      "]",
      'personality = "pragmatic"',
    ].join("\n"),
    "utf8",
  );

  const notify = await readNotify(configPath);
  assert.deepEqual(notify, [
    "/Users/tokentracker/.bun/bin/bun",
    "/Users/tokentracker/.confirmo/hooks/confirmo-codex-hook.js",
  ]);
});

test("upsertNotify replaces multi-line notify blocks without leaving trailing lines", async () => {
  const dir = tmpDir("tokentracker-codex-upsert-");
  const configPath = path.join(dir, "config.toml");
  const notifyOriginalPath = path.join(dir, "codex_notify_original.json");

  fs.writeFileSync(
    configPath,
    [
      'model = "gpt-5.3-codex"',
      "notify = [",
      '  "/Users/tokentracker/.bun/bin/bun",',
      '  "/Users/tokentracker/.confirmo/hooks/confirmo-codex-hook.js"',
      "]",
      'personality = "pragmatic"',
    ].join("\n"),
    "utf8",
  );

  const newNotify = ["/usr/bin/env", "node", "/Users/tokentracker/.tokentracker/bin/notify.cjs"];

  const result = await upsertNotify({
    configPath,
    notifyCmd: newNotify,
    notifyOriginalPath,
    configLabel: "Codex config",
  });
  assert.equal(result.changed, true);

  const updated = fs.readFileSync(configPath, "utf8");
  assert.equal(
    updated.includes(
      'notify = [\"/usr/bin/env\", \"node\", \"/Users/tokentracker/.tokentracker/bin/notify.cjs\"]',
    ),
    true,
  );
  assert.equal(
    updated.includes("confirmo-codex-hook.js"),
    false,
    "expected old notify block to be removed",
  );

  const original = JSON.parse(fs.readFileSync(notifyOriginalPath, "utf8"));
  assert.deepEqual(original.notify, [
    "/Users/tokentracker/.bun/bin/bun",
    "/Users/tokentracker/.confirmo/hooks/confirmo-codex-hook.js",
  ]);
});

test("restoreNotify restores from notifyOriginalPath even if config was updated", async () => {
  const dir = tmpDir("tokentracker-codex-restore-");
  const configPath = path.join(dir, "config.toml");
  const notifyOriginalPath = path.join(dir, "codex_notify_original.json");

  const originalNotify = [
    "/Users/tokentracker/.bun/bin/bun",
    "/Users/tokentracker/.confirmo/hooks/confirmo-codex-hook.js",
  ];
  fs.writeFileSync(
    notifyOriginalPath,
    JSON.stringify({ notify: originalNotify, capturedAt: new Date().toISOString() }),
    "utf8",
  );

  fs.writeFileSync(
    configPath,
    [
      'model = "gpt-5.3-codex"',
      'notify = [\"/usr/bin/env\", \"node\", \"/Users/tokentracker/.tokentracker/bin/notify.cjs\"]',
      'personality = "pragmatic"',
    ].join("\n"),
    "utf8",
  );

  const expectedNotify = ["/usr/bin/env", "node", "/Users/tokentracker/.tokentracker/bin/notify.cjs"];
  const result = await restoreNotify({ configPath, notifyOriginalPath, expectedNotify });
  assert.equal(result.restored, true);

  const updated = fs.readFileSync(configPath, "utf8");
  assert.equal(
    updated.includes(
      'notify = [\"/Users/tokentracker/.bun/bin/bun\", \"/Users/tokentracker/.confirmo/hooks/confirmo-codex-hook.js\"]',
    ),
    true,
  );
});
