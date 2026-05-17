const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const repoRoot = path.join(__dirname, "..");
const tsconfigPath = path.join(repoRoot, "dashboard/tsconfig.json");
const pkgPath = path.join(repoRoot, "dashboard/package.json");
const lockPath = path.join(repoRoot, "dashboard/package-lock.json");
const eslintPath = path.join(repoRoot, "dashboard/.eslintrc.cjs");

async function read(pathname) {
  return fs.readFile(pathname, "utf8");
}

function getTypescriptSpecifier() {
  try {
    const lock = JSON.parse(fsSync.readFileSync(lockPath, "utf8"));
    const lockedVersion = lock.packages?.["node_modules/typescript"]?.version;
    if (lockedVersion) {
      return `typescript@${lockedVersion}`;
    }
  } catch (error) {
    // Fall back to package.json spec if lockfile is unavailable.
  }

  try {
    const pkg = JSON.parse(fsSync.readFileSync(pkgPath, "utf8"));
    const version = pkg.devDependencies?.typescript ?? pkg.dependencies?.typescript;
    if (version) {
      return `typescript@${version}`;
    }
  } catch (error) {
    // Fall back to bare package spec if package.json can't be read.
  }

  return "typescript";
}

function getTscCommand() {
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const typescriptSpecifier = getTypescriptSpecifier();
  return {
    cmd: npmCmd,
    args: [
      "exec",
      "--package",
      typescriptSpecifier,
      "tsc",
      "--",
      "--noEmit",
      "--pretty",
      "false",
      "-p",
      "dashboard/tsconfig.json",
    ],
  };
}

test("dashboard has tsconfig", async () => {
  await read(tsconfigPath);
});

test("vite env types are declared", async () => {
  const viteEnv = await read(path.join(repoRoot, "dashboard/src/vite-env.d.ts"));
  assert.ok(viteEnv.includes("interface ImportMetaEnv"), "expected ImportMetaEnv declaration");
});

test("dashboard package defines typecheck", async () => {
  const pkg = JSON.parse(await read(pkgPath));
  assert.ok(pkg.scripts?.typecheck, "expected typecheck script");
});

test("eslint uses typescript parser", async () => {
  const eslint = await read(eslintPath);
  assert.ok(eslint.includes("@typescript-eslint/parser"));
});

test("hooks and core lib files are migrated to TS", async () => {
  for (const file of [
    "dashboard/src/hooks/use-activity-heatmap.ts",
    "dashboard/src/hooks/use-usage-data.ts",
    "dashboard/src/hooks/use-trend-data.ts",
    "dashboard/src/hooks/use-usage-model-breakdown.ts",
    "dashboard/src/lib/api.ts",
  ]) {
    await fs.readFile(path.join(repoRoot, file));
  }
});

test("lib layer is fully migrated to TS", async () => {
  const libFiles = [
    "details",
    "activity-heatmap",
    "daily",
    "api",
    "timezone",
    "config",
    "mock-data",
    "date-range",
    "copy",
    "safe-browser",
    "format",
    "model-breakdown",
    "detail-sort",
  ];

  for (const name of libFiles) {
    await fs.readFile(path.join(repoRoot, `dashboard/src/lib/${name}.ts`));
  }
});

test("tsc command uses npm exec", async () => {
  const { cmd, args } = getTscCommand();
  let lockedVersion;
  try {
    const lock = JSON.parse(await read(lockPath));
    lockedVersion = lock.packages?.["node_modules/typescript"]?.version;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    lockedVersion = undefined;
  }
  assert.ok(cmd.includes("npm"), "expected npm command");
  assert.ok(args.includes("exec"), "expected npm exec usage");
  assert.ok(args.includes("--package"), "expected npm exec package usage");
  assert.ok(
    args.some((arg) => arg.startsWith("typescript")),
    "expected typescript package specifier",
  );
  if (lockedVersion) {
    assert.ok(args.includes(`typescript@${lockedVersion}`), "expected locked typescript version");
  }
  assert.ok(args.includes("tsc"), "expected tsc in args");
});

test("tsc validates migrated TS files", async () => {
  const { cmd, args } = getTscCommand();
  await execFileAsync(cmd, args, { cwd: repoRoot });
});
