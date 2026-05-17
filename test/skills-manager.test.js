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

const skills = require("../src/lib/skills-manager");

function writeLocalSkill(targetDir, directory, body = "---\nname: Local Skill\ndescription: Test skill\n---\n") {
  const dir = path.join(sandboxHome, targetDir, directory);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), body);
  return dir;
}

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

    const second = skills.importLocalSkill("sample-skill", ["claude", "codex"]);
    assert.equal(second.managed, true);
    assert.deepEqual(new Set(second.targets), new Set(["claude", "codex"]));
    assert.ok(fs.existsSync(path.join(sandboxHome, ".codex/skills/sample-skill/SKILL.md")));

    const third = skills.importLocalSkill("sample-skill", ["codex"]);
    assert.deepEqual(third.targets, ["codex"]);
    assert.ok(!fs.existsSync(path.join(sandboxHome, ".claude/skills/sample-skill")));
    assert.ok(fs.existsSync(path.join(sandboxHome, ".codex/skills/sample-skill/SKILL.md")));

    // cleanup: uninstall managed skill
    skills.uninstallSkill(third.id);
  });
});
