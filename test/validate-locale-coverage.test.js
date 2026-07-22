const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  findTerminologyViolations,
  hasUnlocalizedUiTerm,
  isAllowedSourceIdentical,
  readCopyRegistry,
} = require("../scripts/validate-locale-coverage.cjs");

const HEADER = "key,module,page,component,slot,text\n";

test("locale coverage rejects a copy registry without records", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "locale-coverage-"));
  const copyPath = path.join(root, "copy.csv");
  fs.writeFileSync(copyPath, HEADER, "utf8");

  assert.throws(
    () => readCopyRegistry(copyPath),
    /Copy registry has no entries/,
  );
});

test("product glossary preserves developer-facing English terms by copy key", () => {
  assert.deepEqual(
    findTerminologyViolations({ key: "nav.skills" }, "\u6280\u80fd"),
    ["Skill"],
  );
  assert.deepEqual(
    findTerminologyViolations({ key: "nav.skills" }, "Skills"),
    [],
  );
  assert.deepEqual(
    findTerminologyViolations({ key: "unrelated.label" }, "\u6280\u80fd"),
    [],
  );
  assert.deepEqual(
    findTerminologyViolations({ key: "widgets.cta.download" }, "\u4e0b\u8f7d Mac \u5e94\u7528"),
    ["App"],
  );
});

test("source-identical glossary labels are allowed without allowing full English sentences", () => {
  assert.equal(isAllowedSourceIdentical({ key: "nav.skills", text: "Skills" }), true);
  assert.equal(
    isAllowedSourceIdentical({ key: "skills.action.search_aria", text: "Search skills" }),
    false,
  );
});

test("Dashboard remains localized while glossary terms may stay in English", () => {
  assert.equal(hasUnlocalizedUiTerm({ key: "example" }, "\u6253开 Dashboard"), true);
  assert.equal(hasUnlocalizedUiTerm({ key: "example" }, "\u6253开 Skills"), false);
});
