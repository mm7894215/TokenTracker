const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MAIN_APP_SUBDIR = "antigravity";
const IDE_SUBDIR = "antigravity-ide";

function geminiHome(env) {
  return path.join(env.HOME || env.USERPROFILE || os.homedir(), ".gemini");
}

function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

function existsDir(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch (_e) {
    return false;
  }
}

function resolveAntigravitySkillDirs(env = process.env) {
  const override = trimmed(env.TOKENTRACKER_ANTIGRAVITY_HOME);
  if (override) return [path.join(override, "skills")];

  const home = geminiHome(env);
  const mainSkills = path.join(home, MAIN_APP_SUBDIR, "skills");
  const ideSkills = path.join(home, IDE_SUBDIR, "skills");
  const mainParent = path.join(home, MAIN_APP_SUBDIR);
  const ideParent = path.join(home, IDE_SUBDIR);

  const dirs = [];
  if (existsDir(mainParent)) dirs.push(mainSkills);
  if (existsDir(ideParent)) dirs.push(ideSkills);

  // Neither Antigravity install present: fall back to the main-app path so
  // targetList still surfaces a stable path string and the user can install
  // skills now and run Antigravity later. The empty parent will be created on
  // demand by ensureDir; cleanup happens naturally via uninstallSkill.
  if (dirs.length > 0) return dirs;
  return [mainSkills];
}

module.exports = {
  resolveAntigravitySkillDirs,
};
