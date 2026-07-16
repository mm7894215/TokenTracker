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

test("readNotify unescapes JSON/TOML basic string escapes", async () => {
  const dir = tmpDir("tokentracker-codex-config-");
  const configPath = path.join(dir, "config.toml");

  fs.writeFileSync(
    configPath,
    'notify = ["/usr/bin/env", "node", "C:\\\\Users\\\\alice\\\\.tokentracker\\\\bin\\\\notify.cjs"]\n',
    "utf8",
  );

  const notify = await readNotify(configPath);
  assert.deepEqual(notify, [
    "/usr/bin/env",
    "node",
    "C:\\Users\\alice\\.tokentracker\\bin\\notify.cjs",
  ]);
});

test("upsertNotify round-trips escaped quotes in notify strings", async () => {
  const dir = tmpDir("tokentracker-codex-config-");
  const configPath = path.join(dir, "config.toml");
  const notifyOriginalPath = path.join(dir, "codex_notify_original.json");
  const notify = ["/usr/bin/env", "node", path.join(dir, 'we"ird', "notify.cjs")];
  fs.writeFileSync(configPath, 'model = "gpt-5"\n', "utf8");

  await upsertNotify({
    configPath,
    notifyCmd: notify,
    notifyOriginalPath,
    configLabel: "Codex config",
  });

  assert.deepEqual(await readNotify(configPath), notify);
});

test("readNotify rejects malformed notify arrays", async () => {
  const cases = [
    'notify = ["a" "b"]\n',
    'notify = ["/usr/bin/env", 1]\n',
    'notify = ["a"] trailing\n',
    'notify = ["a" "b"]\nnotify = ["valid"]\n',
    "notify = [\"unterminated\\" + "\n\"]\n",
    'notify = ["unterminated\\\\\n"]\n',
  ];

  for (const source of cases) {
    const dir = tmpDir("tokentracker-codex-config-");
    const configPath = path.join(dir, "config.toml");
    fs.writeFileSync(configPath, source, "utf8");

    assert.equal(await readNotify(configPath), null, source);
  }
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

test("upsertNotify removes unterminated multi-line notify blocks before replacing", async () => {
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
  assert.equal(updated.includes("confirmo-codex-hook.js"), false);
  assert.equal(updated.includes('personality = "pragmatic"'), true);
  assert.equal(updated.match(/^\s*notify\s*=/gm)?.length, 1);
  assert.equal(fs.existsSync(notifyOriginalPath), false);
});

test("upsertNotify preserves valid single-line notify boundaries", async () => {
  const cases = [
    ["dotted", 'notify = ["old"]\nprofile.name = "alice"\nmodel = "gpt-5"\n'],
    ["quoted", 'notify = ["old"]\n"profile.name" = "alice"\nmodel = "gpt-5"\n'],
    ["comment-eof", 'notify = ["old"]\n# keep this comment\n'],
  ];

  for (const [name, source] of cases) {
    const dir = tmpDir(`tokentracker-codex-${name}-`);
    const configPath = path.join(dir, "config.toml");
    const notifyOriginalPath = path.join(dir, "codex_notify_original.json");
    const managedNotify = ["/usr/bin/env", "node", "/Users/tokentracker/.tokentracker/bin/notify.cjs"];
    fs.writeFileSync(configPath, source, "utf8");

    await upsertNotify({
      configPath,
      notifyCmd: managedNotify,
      notifyOriginalPath,
      configLabel: "Codex config",
      captureOriginal: false,
    });

    const updated = fs.readFileSync(configPath, "utf8");
    assert.equal(updated.includes("profile.name"), source.includes("profile.name"), name);
    assert.equal(updated.includes("# keep this comment"), source.includes("# keep this comment"), name);
    assert.equal(updated.match(/^\s*notify\s*=/gm)?.length, 1, name);
  }
});

test("top-level notify operations do not rewrite table-scoped notify", async () => {
  const dir = tmpDir("tokentracker-codex-table-scope-");
  const configPath = path.join(dir, "config.toml");
  const notifyOriginalPath = path.join(dir, "codex_notify_original.json");
  const managedNotify = ["/usr/bin/env", "node", "/Users/tokentracker/.tokentracker/bin/notify.cjs"];

  fs.writeFileSync(
    configPath,
    [
      'model = "gpt-5"',
      "[profile.work]",
      'notify = ["table-notify", "turn-ended"]',
      'model = "profile-model"',
      "",
    ].join("\n"),
    "utf8",
  );

  await upsertNotify({
    configPath,
    notifyCmd: managedNotify,
    notifyOriginalPath,
    configLabel: "Codex config",
    captureOriginal: false,
  });

  const updated = fs.readFileSync(configPath, "utf8");
  assert.match(updated, /^model = "gpt-5"\nnotify = \["\/usr\/bin\/env", "node", "\/Users\/tokentracker\/\.tokentracker\/bin\/notify\.cjs"\]\n\[profile\.work\]/);
  assert.match(updated, /\[profile\.work\]\nnotify = \["table-notify", "turn-ended"\]/);
  assert.deepEqual(await readNotify(configPath), managedNotify);
});

test("readNotify ignores table-scoped notify when no top-level notify exists", async () => {
  const dir = tmpDir("tokentracker-codex-table-only-");
  const configPath = path.join(dir, "config.toml");
  fs.writeFileSync(
    configPath,
    [
      "[profile.work]",
      'notify = ["table-notify", "turn-ended"]',
      'model = "profile-model"',
      "",
    ].join("\n"),
    "utf8",
  );

  assert.equal(await readNotify(configPath), null);
});

test("restoreNotify removal preserves top-level boundaries and table-scoped notify", async () => {
  const cases = [
    ["dotted", 'notify = ["managed"]\nprofile.name = "alice"\nmodel = "gpt-5"\n'],
    ["quoted", 'notify = ["managed"]\n"profile.name" = "alice"\nmodel = "gpt-5"\n'],
    ["comment-eof", 'notify = ["managed"]\n# keep this comment\n'],
    [
      "table-scoped",
      [
        'notify = ["managed"]',
        "[profile.work]",
        'notify = ["table-notify", "turn-ended"]',
        'model = "profile-model"',
        "",
      ].join("\n"),
    ],
  ];

  for (const [name, source] of cases) {
    const dir = tmpDir(`tokentracker-codex-restore-remove-${name}-`);
    const configPath = path.join(dir, "config.toml");
    const notifyOriginalPath = path.join(dir, "codex_notify_original.json");
    fs.writeFileSync(configPath, source, "utf8");
    fs.writeFileSync(notifyOriginalPath, JSON.stringify({ notify: null, capturedAt: new Date().toISOString() }), "utf8");

    const result = await restoreNotify({
      configPath,
      notifyOriginalPath,
      expectedNotify: ["managed"],
    });

    assert.equal(result.restored, true, name);
    const updated = fs.readFileSync(configPath, "utf8");
    assert.equal(updated.includes('notify = ["managed"]'), false, name);
    assert.equal(updated.includes("profile.name"), source.includes("profile.name"), name);
    assert.equal(updated.includes("# keep this comment"), source.includes("# keep this comment"), name);
    assert.equal(updated.includes('notify = ["table-notify", "turn-ended"]'), source.includes("table-notify"), name);
  }
});

test("upsertNotify does not capture a later duplicate notify after malformed notify", async () => {
  const dir = tmpDir("tokentracker-codex-upsert-");
  const configPath = path.join(dir, "config.toml");
  const notifyOriginalPath = path.join(dir, "codex_notify_original.json");

  fs.writeFileSync(
    configPath,
    [
      'model = "gpt-5"',
      'notify = ["broken" "missing-comma"]',
      'notify = ["third-party-valid", "turn-ended"]',
      'personality = "pragmatic"',
    ].join("\n"),
    "utf8",
  );

  const managedNotify = ["/usr/bin/env", "node", "/Users/tokentracker/.tokentracker/bin/notify.cjs"];
  const result = await upsertNotify({
    configPath,
    notifyCmd: managedNotify,
    notifyOriginalPath,
    configLabel: "Codex config",
  });
  assert.equal(result.changed, true);
  assert.equal(fs.existsSync(notifyOriginalPath), false);
  assert.deepEqual(await readNotify(configPath), managedNotify);

  const updated = fs.readFileSync(configPath, "utf8");
  assert.equal(updated.includes("third-party-valid"), false);
  assert.equal(updated.match(/^\s*notify\s*=/gm)?.length, 1);
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

test("restoreNotify skips stale backup when current notify is not managed", async () => {
  const dir = tmpDir("tokentracker-codex-restore-");
  const configPath = path.join(dir, "config.toml");
  const notifyOriginalPath = path.join(dir, "codex_notify_original.json");

  fs.writeFileSync(
    notifyOriginalPath,
    JSON.stringify({ notify: ["old-notify"], capturedAt: new Date().toISOString() }),
    "utf8",
  );
  fs.writeFileSync(configPath, 'notify = ["third-party-notify", "new"]\n', "utf8");

  const expectedNotify = ["/usr/bin/env", "node", "/Users/alice/.tokentracker/bin/notify.cjs"];
  const result = await restoreNotify({ configPath, notifyOriginalPath, expectedNotify });
  assert.equal(result.restored, false);
  assert.equal(result.skippedReason, "current-not-managed");
  assert.equal(fs.readFileSync(configPath, "utf8"), 'notify = ["third-party-notify", "new"]\n');
});

test("restoreNotify reports no backup when notify is not installed", async () => {
  const dir = tmpDir("tokentracker-codex-restore-");
  const configPath = path.join(dir, "config.toml");
  const notifyOriginalPath = path.join(dir, "codex_notify_original.json");

  fs.writeFileSync(configPath, 'model = "gpt-5"\n', "utf8");

  const expectedNotify = ["/usr/bin/env", "node", "/Users/alice/.tokentracker/bin/notify.cjs"];
  const result = await restoreNotify({ configPath, notifyOriginalPath, expectedNotify });
  assert.equal(result.restored, false);
  assert.equal(result.skippedReason, "no-backup-not-installed");
  assert.equal(fs.readFileSync(configPath, "utf8"), 'model = "gpt-5"\n');
});
