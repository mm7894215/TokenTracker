const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { transform } = require("esbuild");

const repoRoot = path.join(__dirname, "..");

async function parseDashboardFile(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  const source = fs.readFileSync(absolutePath, "utf8");
  await transform(source, {
    loader: "jsx",
    sourcefile: relativePath,
  });
}

test("App.jsx parses without duplicate identifier errors", async () => {
  await assert.doesNotReject(parseDashboardFile("dashboard/src/App.jsx"));
});

test("App.jsx routes to /leaderboard page", () => {
  const appPath = path.join(repoRoot, "dashboard/src/App.jsx");
  const source = fs.readFileSync(appPath, "utf8");
  assert.equal(source.includes('"/rankings"'), false, "Removed /rankings route should not exist");
  assert.equal(source.includes('"/leaderboard"'), true, "/leaderboard route should exist");
  assert.equal(source.includes("LeaderboardPage"), true, "LeaderboardPage should be referenced");
});

test("App.jsx routes to /login page", () => {
  const appPath = path.join(repoRoot, "dashboard/src/App.jsx");
  const source = fs.readFileSync(appPath, "utf8");
  assert.equal(source.includes('"/login"'), true, "/login route should exist");
  assert.equal(source.includes("LoginPage"), true, "LoginPage should be referenced");
});

test("App.jsx keeps menu bar configuration inside /widgets", () => {
  const appPath = path.join(repoRoot, "dashboard/src/App.jsx");
  const source = fs.readFileSync(appPath, "utf8");
  assert.equal(source.includes('"/widgets"'), true, "/widgets route should exist");
  assert.equal(source.includes("WidgetsPage"), true, "WidgetsPage should be referenced");
  assert.equal(source.includes('"/menubar"'), false, "/menubar should not be a separate route");
  assert.equal(source.includes("MenuBarPage"), false, "MenuBarPage should not be referenced");
});
