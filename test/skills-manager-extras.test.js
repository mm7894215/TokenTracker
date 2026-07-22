const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it } = require("node:test");

// Sandbox HOME before requiring the module so every os.homedir() callback
// resolves inside the temp dir (mirrors skills-manager.test.js).
const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "tt-skills-extras-"));
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;
process.env.TOKENTRACKER_GROK_HOME = path.join(sandboxHome, ".grok");
delete process.env.GROK_HOME;
delete process.env.TOKENTRACKER_ANTIGRAVITY_HOME;
delete process.env.CODEX_HOME;
delete process.env.ZCODE_HOME;
delete process.env.TOKENTRACKER_OPENCLAW_HOME;
delete process.env.TOKENTRACKER_OPENCLAW_WORKSPACE;

const skills = require("../src/lib/skills-manager");

const CLAUDE_SKILLS = path.join(sandboxHome, ".claude", "skills");

function writeSkillDir(dir, marker = "SKILL.md", body = "---\nname: Demo\ndescription: A demo skill\n---\n") {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, marker), body);
  return dir;
}

function resetRegistry() {
  const file = path.join(sandboxHome, ".tokentracker", "skills", "registry.json");
  try {
    fs.rmSync(file, { force: true });
  } catch (_e) {
    /* ignore */
  }
}

describe("findSkillMarker (case-insensitive SKILL.md|skill.md)", () => {
  it("accepts both spellings and rejects non-markers", () => {
    const upper = writeSkillDir(path.join(sandboxHome, "m-upper"), "SKILL.md");
    const lower = writeSkillDir(path.join(sandboxHome, "m-lower"), "skill.md");
    const readme = path.join(sandboxHome, "m-readme");
    fs.mkdirSync(readme, { recursive: true });
    fs.writeFileSync(path.join(readme, "README.md"), "# not a skill");

    assert.ok(skills.findSkillMarker(upper));
    assert.ok(skills.findSkillMarker(lower), "lowercase skill.md must be detected");
    assert.equal(skills.findSkillMarker(readme), null, "README.md is never a marker");
  });
});

describe("listInstalledSkills lowercase skill.md regression", () => {
  it("surfaces a lowercase skill.md skill as unmanaged (was invisible before fix)", () => {
    resetRegistry();
    writeSkillDir(path.join(CLAUDE_SKILLS, "lowercase-skill"), "skill.md");
    const installed = skills.listInstalledSkills();
    const found = installed.find((s) => s.directory === "lowercase-skill");
    assert.ok(found, "lowercase skill.md skill should appear in installed list");
    assert.equal(found.managed, false);
    // targetStates is a complete map (single source of truth): synced where the
    // skill exists, "off" elsewhere.
    assert.equal(found.targetStates.claude, "synced");
    assert.equal(found.targetStates.codex, "off");
  });
});

describe("read-only plugin skill inventory", () => {
  it("excludes Codex built-in skills from the inventory", () => {
    resetRegistry();
    writeSkillDir(
      path.join(sandboxHome, ".codex", "skills", ".system", "skill-creator"),
      "SKILL.md",
      "---\nname: Skill Creator\ndescription: Built in\n---\n",
    );

    const entry = skills.listInstalledSkills().find((s) => s.name === "Skill Creator");
    assert.equal(entry, undefined, "built-in skills should not clutter the user inventory");
  });

  it("counts Codex, Claude, and ZCode plugin-cache skills without exposing them as manageable", () => {
    resetRegistry();
    const fixtures = [
      [".codex/plugins/cache/openai-bundled/browser/1.2.3/skills/browser-control", "Codex Browser"],
      [".claude/plugins/cache/acme/tools/2.0.0/skills/reviewer", "Claude Reviewer"],
      [".zcode/cli/plugins/cache/zcode-official/guide/0.1.0/skills/diagnostics", "ZCode Diagnostics"],
    ];
    for (const [relative, name] of fixtures) {
      writeSkillDir(path.join(sandboxHome, relative), "SKILL.md", `---\nname: ${name}\n---\n`);
    }

    const installed = skills.listInstalledSkills();
    for (const [name, target] of [
      ["Codex Browser", "codex"],
      ["Claude Reviewer", "claude"],
      ["ZCode Diagnostics", "zcode"],
    ]) {
      const entry = installed.find((s) => s.name === name);
      assert.ok(entry, `${name} should be counted`);
      assert.equal(entry.readOnly, true);
      assert.equal(entry.scope, "plugin");
      assert.deepEqual(entry.targets, [target]);
    }

    const zcode = skills.targetList().find((target) => target.id === "zcode");
    assert.ok(zcode, "ZCode should be available as an inventory filter");
    assert.equal(zcode.manageable, false);
    assert.equal(zcode.path, null);
  });

  it("scans only the active OpenClaw workspace skills directory", () => {
    resetRegistry();
    const openclawHome = path.join(sandboxHome, ".openclaw");
    const activeWorkspace = path.join(openclawHome, "active-workspace");
    fs.mkdirSync(openclawHome, { recursive: true });
    fs.writeFileSync(
      path.join(openclawHome, "openclaw.json"),
      JSON.stringify({ agents: { defaults: { workspace: activeWorkspace } } }),
    );
    writeSkillDir(path.join(activeWorkspace, "skills", "active-skill"), "SKILL.md", "---\nname: Active Skill\n---\n");
    writeSkillDir(
      path.join(openclawHome, "workspace", "backup", "Other-Mac", "skills", "remote-snapshot"),
      "SKILL.md",
      "---\nname: Remote Snapshot\n---\n",
    );

    const installed = skills.listInstalledSkills();
    const active = installed.find((s) => s.name === "Active Skill");
    assert.ok(active);
    assert.deepEqual(active.targets, ["openclaw"]);
    assert.equal(installed.some((s) => s.name === "Remote Snapshot"), false);
  });
});

describe("readSkillMetadata YAML block scalars", () => {
  it("parses `description: |` / `>` block scalars instead of showing the bare indicator", () => {
    resetRegistry();
    const body = "---\nname: Block Skill\ndescription: |\n  First line of the description.\n  Second line continues here.\n---\n# Body\n";
    writeSkillDir(path.join(CLAUDE_SKILLS, "block-desc"), "SKILL.md", body);
    const entry = skills.listInstalledSkills().find((s) => s.directory === "block-desc");
    assert.ok(entry, "block-scalar skill should be listed");
    assert.equal(entry.name, "Block Skill");
    assert.equal(
      entry.description,
      "First line of the description. Second line continues here.",
      "block scalar body must be joined, not rendered as '|'",
    );
  });
});

describe("hashDirectory", () => {
  it("is deterministic, content-sensitive, and ignores OS/VCS noise", () => {
    const a = path.join(sandboxHome, "hash-a");
    writeSkillDir(a, "SKILL.md", "hello");
    const h1 = skills.hashDirectory(a);
    const h2 = skills.hashDirectory(a);
    assert.equal(h1, h2, "same content → same hash");

    // OS noise must not change the hash.
    fs.writeFileSync(path.join(a, ".DS_Store"), "junk");
    assert.equal(skills.hashDirectory(a), h1, ".DS_Store is ignored");

    // Real content change must change the hash.
    fs.writeFileSync(path.join(a, "SKILL.md"), "hello world");
    assert.notEqual(skills.hashDirectory(a), h1, "content change → new hash");
  });
});

describe("assertNotNested path guard", () => {
  it("throws when dest is inside source (or vice versa) and allows siblings", () => {
    const src = path.join(sandboxHome, "guard-src");
    fs.mkdirSync(src, { recursive: true });
    const nested = path.join(src, "child");
    assert.throws(() => skills.assertNotNested(src, nested), /own directory tree/);
    assert.throws(() => skills.assertNotNested(nested, src), /own directory tree/);
    assert.doesNotThrow(() => skills.assertNotNested(src, path.join(sandboxHome, "guard-dst")));
  });
});

describe("sourceSignatureFromTree", () => {
  it("hashes only blobs under sourceDir and tracks blob sha changes", () => {
    const tree = [
      { type: "blob", path: "foo/SKILL.md", sha: "aaa" },
      { type: "blob", path: "foo/scripts/run.sh", sha: "bbb" },
      { type: "blob", path: "other/SKILL.md", sha: "zzz" },
    ];
    const sig = skills.sourceSignatureFromTree(tree, "foo");
    assert.ok(sig);
    assert.equal(skills.sourceSignatureFromTree(tree, "foo"), sig, "stable");
    assert.equal(skills.sourceSignatureFromTree(tree, "missing"), null);

    const changed = tree.map((e) => (e.path === "foo/SKILL.md" ? { ...e, sha: "ccc" } : e));
    assert.notEqual(skills.sourceSignatureFromTree(changed, "foo"), sig, "blob sha change → new signature");
  });
});

describe("activity log", () => {
  it("records mutations and returns them newest-first", () => {
    resetRegistry();
    writeSkillDir(path.join(CLAUDE_SKILLS, "act-skill"), "SKILL.md");
    skills.importLocalSkill("act-skill", ["claude"]);
    skills.setSkillTargets("local:act-skill", ["claude", "codex"]);

    const activity = skills.readActivity(10);
    assert.ok(activity.length >= 2);
    assert.equal(activity[0].action, "set_targets", "newest first");
    assert.equal(activity[activity.length - 1].action, "import");
    // Privacy: only verbs/names/targets — no bodies.
    for (const event of activity) {
      assert.ok(!("content" in event) && !("body" in event));
    }
  });
});

describe("orphan target detection", () => {
  it("flags a managed skill whose synced agent dir was deleted", () => {
    resetRegistry();
    writeSkillDir(path.join(CLAUDE_SKILLS, "orphan-skill"), "SKILL.md");
    skills.importLocalSkill("orphan-skill", ["claude"]);

    let entry = skills.listInstalledSkills().find((s) => s.directory === "orphan-skill");
    assert.equal(entry.targetStates.claude, "synced");

    // Simulate the user manually deleting the synced copy.
    fs.rmSync(path.join(CLAUDE_SKILLS, "orphan-skill"), { recursive: true, force: true });
    entry = skills.listInstalledSkills().find((s) => s.directory === "orphan-skill");
    assert.equal(entry.targetStates.claude, "orphan", "intended-but-missing → orphan");
  });
});

describe("checkUpdates", () => {
  it("returns false when signature matches and true when upstream drifts", async () => {
    resetRegistry();
    const realFetch = global.fetch;
    const tree = [{ type: "blob", path: "foo/SKILL.md", sha: "v1" }];
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ tree }) });
    try {
      const currentSig = skills.sourceSignatureFromTree(tree, "foo");
      const registryDir = path.join(sandboxHome, ".tokentracker", "skills");
      fs.mkdirSync(registryDir, { recursive: true });
      const writeRegistry = (sig) =>
        fs.writeFileSync(
          path.join(registryDir, "registry.json"),
          JSON.stringify({
            repos: [],
            skills: [
              {
                id: "o/r:foo",
                key: "o/r:foo",
                directory: "foo",
                sourceDirectory: "foo",
                repoOwner: "o",
                repoName: "r",
                repoBranch: "main",
                sourceSignature: sig,
                installedAt: 1,
                targets: [],
              },
            ],
          }),
        );

      writeRegistry(currentSig);
      let res = await skills.checkUpdates({ force: true });
      assert.equal(res.updates["o/r:foo"], false, "matching signature → no update");

      writeRegistry("STALE_SIGNATURE");
      res = await skills.checkUpdates({ force: true });
      assert.equal(res.updates["o/r:foo"], true, "drifted signature → update available");
    } finally {
      global.fetch = realFetch;
      resetRegistry();
    }
  });
});

describe("fetchPopularSkillsSh", () => {
  it("dedupes by key and sorts by installs desc", async () => {
    const realFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        query: "x",
        count: 2,
        skills: [
          { id: "o/r:low", name: "Low", skillId: "low", source: "o/r", installs: 5 },
          { id: "o/r:high", name: "High", skillId: "high", source: "o/r", installs: 999 },
        ],
      }),
    });
    try {
      const res = await skills.fetchPopularSkillsSh({ force: true, limit: 10 });
      assert.equal(res.skills.length, 2, "deduped across seed queries");
      assert.equal(res.skills[0].name, "High", "highest installs first");
      assert.equal(res.skills[1].name, "Low");
    } finally {
      global.fetch = realFetch;
    }
  });
});
