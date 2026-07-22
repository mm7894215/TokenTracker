import { describe, expect, it } from "vitest";
import { buildSkillInventoryMetadata, mergeSkillInventories } from "./skills-inventory";

describe("Skills inventory cloud metadata", () => {
  it("projects only the privacy-safe metadata allow-list", () => {
    const [metadata] = buildSkillInventoryMetadata([{
      id: "inventory:codex:plugin:browser:control",
      key: "inventory:codex:plugin:browser:control",
      name: "Browser Control",
      directory: "control-in-app-browser",
      description: "private local description",
      prompt: "never upload this",
      targetPaths: { codex: "C:\\Users\\person\\.codex\\secret" },
      readmeUrl: "file:///private/SKILL.md",
      targets: ["codex"],
      readOnly: true,
      scope: "plugin",
      sourceName: "openai-bundled/browser",
    }]);

    expect(metadata).toEqual({
      key: "inventory:codex:plugin:browser:control",
      name: "Browser Control",
      directory: "control-in-app-browser",
      targets: ["codex"],
      managed: false,
      readOnly: true,
      scope: "plugin",
      sourceName: "openai-bundled/browser",
    });
    expect(JSON.stringify(metadata)).not.toContain("private local description");
    expect(JSON.stringify(metadata)).not.toContain("Users");
    expect(JSON.stringify(metadata)).not.toContain("never upload");
  });

  it("drops absolute paths and path-bearing keys before making a cloud request", () => {
    const metadata = buildSkillInventoryMetadata([
      { key: "local:windows", name: "Windows", directory: "C:\\Users\\person\\skill" },
      { key: "local:unix", name: "Unix", directory: "/home/person/.skills/demo" },
      { key: "local:C:/Users/person/skill", name: "Key leak", directory: "safe-skill" },
      {
        key: "inventory:codex:plugin:safe:demo",
        name: "Safe",
        directory: "demo",
        sourceName: "/home/person/private-plugin",
        targets: ["codex"],
      },
    ]);

    expect(metadata).toEqual([{
      key: "inventory:codex:plugin:safe:demo",
      name: "Safe",
      directory: "demo",
      targets: ["codex"],
      managed: false,
      readOnly: false,
      scope: "local",
    }]);
    expect(JSON.stringify(metadata)).not.toMatch(/Users|home\/person/);
  });

  it("does not publish built-in skills", () => {
    const metadata = buildSkillInventoryMetadata([
      {
        key: "inventory:codex:system:skill-creator",
        name: "Skill Creator",
        directory: "skill-creator",
        targets: ["codex"],
        scope: "system",
      },
      {
        key: "inventory:codex:plugin:browser:control",
        name: "Browser Control",
        directory: "control-in-app-browser",
        targets: ["codex"],
        scope: "plugin",
      },
    ]);

    expect(metadata.map((skill) => skill.name)).toEqual(["Browser Control"]);
  });
});

describe("mergeSkillInventories", () => {
  it("keeps a matching local skill manageable and adds its other-device source", () => {
    const local = [{
      id: "local:reviewer",
      key: "local:reviewer",
      name: "Reviewer",
      directory: "reviewer",
      targets: ["claude"],
      managed: true,
    }];
    const merged = mergeSkillInventories(local, {
      devices: [{
        id: "other-device",
        device_name: "Mac mini",
        platform: "darwin",
        scanned_at: "2026-07-21T00:00:00Z",
        skills: [{ key: "local:reviewer", name: "Reviewer", directory: "reviewer", targets: ["codex"] }],
      }],
    }, "this-device");

    expect(merged).toHaveLength(1);
    expect(merged[0].readOnly).not.toBe(true);
    expect(merged[0].remote).not.toBe(true);
    expect(merged[0].targets).toEqual(["claude"]);
    expect(merged[0].deviceSources).toEqual([{
      id: "other-device",
      name: "Mac mini",
      platform: "darwin",
      scannedAt: "2026-07-21T00:00:00Z",
    }]);
  });

  it("creates one read-only row for a skill installed only on other devices", () => {
    const cloudSkill = {
      key: "inventory:zcode:plugin:guide:diagnostics",
      name: "Diagnostics",
      directory: "diagnostics",
      targets: ["zcode"],
      scope: "plugin",
      sourceName: "zcode-official/guide",
    };
    const merged = mergeSkillInventories([], {
      devices: [
        { id: "current", device_name: "This PC", skills: [cloudSkill] },
        { id: "mac", device_name: "MacBook", platform: "darwin", skills: [cloudSkill] },
        { id: "pc", device_name: "Work PC", platform: "win32", skills: [cloudSkill] },
      ],
    }, "current");

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      name: "Diagnostics",
      remote: true,
      readOnly: true,
      inventoryOnly: true,
      targets: ["zcode"],
    });
    expect(merged[0].deviceSources.map((source: { name: string }) => source.name)).toEqual(["MacBook", "Work PC"]);
  });

  it("filters built-in skills from local and stale remote inventories", () => {
    const builtIn = {
      key: "inventory:codex:system:skill-creator",
      name: "Skill Creator",
      directory: "skill-creator",
      targets: ["codex"],
      scope: "system",
    };
    const merged = mergeSkillInventories([builtIn], {
      devices: [{ id: "other", device_name: "Other PC", skills: [builtIn] }],
    }, "current");

    expect(merged).toEqual([]);
  });
});
