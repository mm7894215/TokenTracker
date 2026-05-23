"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.join(__dirname, "..");

function read(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), "utf8");
}

test("Settings account section exposes the signed-in user id for README badges", () => {
  const hookSrc = read("dashboard/src/components/settings/useAccountProfileSettings.js");
  const sectionSrc = read("dashboard/src/components/settings/AccountSection.jsx");
  const copyCsv = read("dashboard/src/content/copy.csv");

  assert.match(hookSrc, /userId: state\.userId/, "expected account settings hook to expose userId");
  assert.match(sectionSrc, /<UserIdRow userId=\{settings\.userId\}/, "expected account section to render user id row");
  assert.ok(
    sectionSrc.indexOf("<UserIdRow userId={settings.userId}") < sectionSrc.indexOf("<CloudSyncRow settings={settings}"),
    "expected user id row above cloud sync",
  );
  assert.match(sectionSrc, /navigator\.clipboard\.writeText\(userId\)/, "expected copy button to copy userId");
  assert.match(copyCsv, /settings\.account\.userId,/, "expected user id label in copy registry");
  assert.match(copyCsv, /settings\.account\.copyUserId,/, "expected copy aria label in copy registry");
});
