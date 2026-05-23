"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { afterEach, beforeEach, describe, it } = require("node:test");

const { resolveAntigravitySkillDirs } = require("../src/lib/antigravity-paths");

function makeSandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tt-antigravity-paths-"));
}

function clean(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_e) {}
}

describe("resolveAntigravitySkillDirs", () => {
  let sandbox;

  beforeEach(() => {
    sandbox = makeSandbox();
  });

  afterEach(() => {
    clean(sandbox);
  });

  it("returns override-only path when TOKENTRACKER_ANTIGRAVITY_HOME is set", () => {
    const override = path.join(sandbox, "custom-home");
    const dirs = resolveAntigravitySkillDirs({
      HOME: sandbox,
      TOKENTRACKER_ANTIGRAVITY_HOME: override,
    });
    assert.deepEqual(dirs, [path.join(override, "skills")]);
  });

  it("ignores override when value is empty/whitespace", () => {
    fs.mkdirSync(path.join(sandbox, ".gemini", "antigravity"), { recursive: true });
    const dirs = resolveAntigravitySkillDirs({
      HOME: sandbox,
      TOKENTRACKER_ANTIGRAVITY_HOME: "   ",
    });
    assert.deepEqual(dirs, [path.join(sandbox, ".gemini", "antigravity", "skills")]);
  });

  it("returns only main app dir when only ~/.gemini/antigravity exists", () => {
    fs.mkdirSync(path.join(sandbox, ".gemini", "antigravity"), { recursive: true });
    const dirs = resolveAntigravitySkillDirs({ HOME: sandbox });
    assert.deepEqual(dirs, [path.join(sandbox, ".gemini", "antigravity", "skills")]);
  });

  it("returns only IDE dir when only ~/.gemini/antigravity-ide exists", () => {
    fs.mkdirSync(path.join(sandbox, ".gemini", "antigravity-ide"), { recursive: true });
    const dirs = resolveAntigravitySkillDirs({ HOME: sandbox });
    assert.deepEqual(dirs, [path.join(sandbox, ".gemini", "antigravity-ide", "skills")]);
  });

  it("returns both dirs when both main app and IDE are present", () => {
    fs.mkdirSync(path.join(sandbox, ".gemini", "antigravity"), { recursive: true });
    fs.mkdirSync(path.join(sandbox, ".gemini", "antigravity-ide"), { recursive: true });
    const dirs = resolveAntigravitySkillDirs({ HOME: sandbox });
    assert.deepEqual(dirs, [
      path.join(sandbox, ".gemini", "antigravity", "skills"),
      path.join(sandbox, ".gemini", "antigravity-ide", "skills"),
    ]);
  });

  it("falls back to main app dir when neither parent exists", () => {
    const dirs = resolveAntigravitySkillDirs({ HOME: sandbox });
    assert.deepEqual(dirs, [path.join(sandbox, ".gemini", "antigravity", "skills")]);
  });

  it("uses USERPROFILE when HOME is missing (Windows-style env)", () => {
    fs.mkdirSync(path.join(sandbox, ".gemini", "antigravity"), { recursive: true });
    const dirs = resolveAntigravitySkillDirs({ USERPROFILE: sandbox });
    assert.deepEqual(dirs, [path.join(sandbox, ".gemini", "antigravity", "skills")]);
  });
});
