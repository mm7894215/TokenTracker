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
delete process.env.TOKENTRACKER_ANTIGRAVITY_HOME;

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

describe("skills-manager antigravity target", () => {
  const mainSkillsDir = path.join(sandboxHome, ".gemini", "antigravity", "skills");
  const ideSkillsDir = path.join(sandboxHome, ".gemini", "antigravity-ide", "skills");
  const skillName = "ag-skill";

  before(() => {
    // Create both Antigravity main-app and IDE parent dirs so dirs() returns both
    fs.mkdirSync(path.join(sandboxHome, ".gemini", "antigravity"), { recursive: true });
    fs.mkdirSync(path.join(sandboxHome, ".gemini", "antigravity-ide"), { recursive: true });
    // Seed source skill under the main-app dir so findLocalSkillSource picks it up
    writeLocalSkill(".gemini/antigravity/skills", skillName);
  });

  it("targetList includes antigravity with the main-app dir as primary path", () => {
    const target = skills.targetList().find((t) => t.id === "antigravity");
    assert.ok(target);
    assert.equal(target.label, "Antigravity");
    assert.equal(target.path, mainSkillsDir);
  });

  it("writes to both main-app and IDE dirs in parallel on install + removes both on uninstall", () => {
    const installed = skills.importLocalSkill(skillName, ["antigravity"]);
    assert.equal(installed.managed, true);
    assert.deepEqual(installed.targets, ["antigravity"]);
    // Both directories should be populated (re-sync writes through dirs() array)
    assert.ok(fs.existsSync(path.join(mainSkillsDir, skillName, "SKILL.md")));
    assert.ok(fs.existsSync(path.join(ideSkillsDir, skillName, "SKILL.md")));

    // Drop antigravity from target set — both dirs should be cleaned
    const cleared = skills.setSkillTargets(installed.id, []);
    assert.deepEqual(cleared.targets, []);
    assert.ok(!fs.existsSync(path.join(mainSkillsDir, skillName)));
    assert.ok(!fs.existsSync(path.join(ideSkillsDir, skillName)));

    skills.uninstallSkill(installed.id);
  });

  it("TOKENTRACKER_ANTIGRAVITY_HOME forces a single override path", () => {
    const overrideHome = path.join(sandboxHome, "custom-ag");
    const overrideSkill = "ag-skill-override";
    const prev = process.env.TOKENTRACKER_ANTIGRAVITY_HOME;
    process.env.TOKENTRACKER_ANTIGRAVITY_HOME = overrideHome;
    try {
      // targetList sees the override
      const target = skills.targetList().find((t) => t.id === "antigravity");
      assert.equal(target.path, path.join(overrideHome, "skills"));

      // Seed source under the override path so findLocalSkillSource locates it
      const seedDir = path.join(overrideHome, "skills", overrideSkill);
      fs.mkdirSync(seedDir, { recursive: true });
      fs.writeFileSync(
        path.join(seedDir, "SKILL.md"),
        "---\nname: Override Skill\ndescription: forced override\n---\n",
      );

      const installed = skills.importLocalSkill(overrideSkill, ["antigravity"]);
      assert.deepEqual(installed.targets, ["antigravity"]);
      // override path written
      assert.ok(fs.existsSync(path.join(overrideHome, "skills", overrideSkill, "SKILL.md")));
      // default-discovery paths must NOT receive a copy when override is set
      assert.ok(!fs.existsSync(path.join(mainSkillsDir, overrideSkill)));
      assert.ok(!fs.existsSync(path.join(ideSkillsDir, overrideSkill)));
      skills.uninstallSkill(installed.id);
    } finally {
      if (prev === undefined) delete process.env.TOKENTRACKER_ANTIGRAVITY_HOME;
      else process.env.TOKENTRACKER_ANTIGRAVITY_HOME = prev;
    }
  });
});
