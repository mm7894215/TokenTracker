const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { before, describe, it } = require("node:test");

// Isolate ~/.tokentracker/skills + target skill dirs into a temp HOME. Must run
// before requiring the module so that every `os.homedir()` callback resolves
// within the sandbox.
const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "tt-skills-mgr-"));
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;
process.env.TOKENTRACKER_GROK_HOME = path.join(sandboxHome, ".grok");
delete process.env.GROK_HOME;

const skills = require("../src/lib/skills-manager");

function writeLocalSkill(targetDir, directory, body = "---\nname: Local Skill\ndescription: Test skill\n---\n") {
  const dir = path.join(sandboxHome, targetDir, directory);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), body);
  return dir;
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("skills-manager targetList", () => {
  it("includes Grok and resolves Grok home overrides", () => {
    const prevTokenTrackerGrokHome = process.env.TOKENTRACKER_GROK_HOME;
    const prevGrokHome = process.env.GROK_HOME;
    try {
      process.env.TOKENTRACKER_GROK_HOME = path.join(sandboxHome, ".grok-prefixed");
      process.env.GROK_HOME = path.join(sandboxHome, ".grok-legacy");
      let grok = skills.targetList().find((target) => target.id === "grok");
      assert.ok(grok);
      assert.equal(grok.label, "Grok");
      assert.equal(grok.path, path.join(sandboxHome, ".grok-prefixed", "skills"));

      delete process.env.TOKENTRACKER_GROK_HOME;
      grok = skills.targetList().find((target) => target.id === "grok");
      assert.equal(grok.path, path.join(sandboxHome, ".grok-legacy", "skills"));
    } finally {
      restoreEnv("TOKENTRACKER_GROK_HOME", prevTokenTrackerGrokHome);
      restoreEnv("GROK_HOME", prevGrokHome);
    }
  });
});

describe("skills-manager addRepo validation", () => {
  it("rejects path-traversal-like owner/name", () => {
    assert.throws(() => skills.addRepo({ owner: "..", name: "repo" }), /owner and name/);
    assert.throws(() => skills.addRepo({ owner: "foo/../bar", name: "repo" }), /owner and name/);
    assert.throws(() => skills.addRepo({ owner: "foo", name: "bar/baz" }), /owner and name/);
    assert.throws(() => skills.addRepo({ owner: "foo", name: "repo", branch: "../main" }), /branch/);
  });

  it("accepts well-formed owner/name", () => {
    const repo = skills.addRepo({ owner: "anthropics", name: "skills" });
    assert.equal(repo.owner, "anthropics");
    assert.equal(repo.name, "skills");
    assert.equal(repo.branch, "main");
    // clean up to avoid leaking into other tests
    skills.removeRepo("anthropics", "skills");
  });
});

describe("skills-manager importLocalSkill sanitization", () => {
  it("rejects invalid directory names", () => {
    assert.throws(() => skills.importLocalSkill("..", []), /Invalid skill directory/);
    assert.throws(() => skills.importLocalSkill("foo/bar", []), /Invalid skill directory/);
    assert.throws(() => skills.importLocalSkill("", []), /Invalid skill directory/);
  });

  it("throws when skill is not present in any target folder", () => {
    assert.throws(() => skills.importLocalSkill("not-there", ["claude"]), /Local skill not found/);
  });
});

describe("skills-manager setSkillTargets", () => {
  it("throws when skill id is unknown", () => {
    assert.throws(() => skills.setSkillTargets("missing", ["claude"]), /Managed skill not found/);
  });
});

describe("skills-manager importLocalSkill re-sync", () => {
  before(() => {
    writeLocalSkill(".claude/skills", "sample-skill");
  });

  it("re-applies targets when called again with new target set", () => {
    const first = skills.importLocalSkill("sample-skill", ["claude"]);
    assert.equal(first.managed, true);
    assert.deepEqual(first.targets, ["claude"]);
    assert.ok(fs.existsSync(path.join(sandboxHome, ".claude/skills/sample-skill/SKILL.md")));
    assert.ok(!fs.existsSync(path.join(sandboxHome, ".codex/skills/sample-skill")));
    assert.ok(!fs.existsSync(path.join(sandboxHome, ".grok/skills/sample-skill")));

    const second = skills.importLocalSkill("sample-skill", ["claude", "codex", "grok"]);
    assert.equal(second.managed, true);
    assert.deepEqual(new Set(second.targets), new Set(["claude", "codex", "grok"]));
    assert.ok(fs.existsSync(path.join(sandboxHome, ".codex/skills/sample-skill/SKILL.md")));
    assert.ok(fs.existsSync(path.join(sandboxHome, ".grok/skills/sample-skill/SKILL.md")));

    const third = skills.importLocalSkill("sample-skill", ["claude"]);
    assert.deepEqual(third.targets, ["claude"]);
    assert.ok(fs.existsSync(path.join(sandboxHome, ".claude/skills/sample-skill/SKILL.md")));
    assert.ok(!fs.existsSync(path.join(sandboxHome, ".codex/skills/sample-skill")));
    assert.ok(!fs.existsSync(path.join(sandboxHome, ".grok/skills/sample-skill")));

    // cleanup: uninstall managed skill
    skills.uninstallSkill(third.id);
  });
});
