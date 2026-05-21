const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { readJsonStrict } = require("../src/lib/fs");

test("readJsonStrict reports missing files", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-fs-"));
  const target = path.join(tmp, "missing.json");

  const res = await readJsonStrict(target);

  assert.equal(res.status, "missing");
  assert.equal(res.value, null);
});

test("readJsonStrict reports invalid JSON", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-fs-"));
  const target = path.join(tmp, "invalid.json");
  await fs.writeFile(target, "{bad", "utf8");

  const res = await readJsonStrict(target);

  assert.equal(res.status, "invalid");
  assert.equal(res.value, null);
});
