const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { PNG } = require("pngjs");

const repoRoot = path.resolve(__dirname, "..");
const linuxDir = path.join(repoRoot, "TokenTrackerLinux");
const bundleScript = path.join(linuxDir, "scripts", "bundle-node-linux.sh");
const canonicalIcon = path.join(repoRoot, "dashboard", "public", "icon-512.png");

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function writeExecutable(file, contents) {
  fs.writeFileSync(file, contents, { mode: 0o755 });
}

test("Linux bundle rebuilds an isolated runtime and synchronizes an isolated Tauri icon", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-linux-bundle-"));
  const toolsDir = path.join(tempDir, "tools");
  const embeddedServer = path.join(tempDir, "EmbeddedServer");
  const dashboardDist = path.join(tempDir, "dashboard-dist");
  const tauriIcon = path.join(tempDir, "icon.png");
  const staleFile = path.join(embeddedServer, "stale.txt");

  try {
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.mkdirSync(embeddedServer, { recursive: true });
    fs.writeFileSync(staleFile, "stale runtime artifact");
    fs.mkdirSync(dashboardDist, { recursive: true });
    fs.writeFileSync(path.join(dashboardDist, "index.html"), "<main>dashboard fixture</main>");

    writeExecutable(path.join(toolsDir, "curl"), `#!/usr/bin/env bash
set -euo pipefail
output=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-o" ]]; then output="$2"; shift 2; else shift; fi
done
if [[ "$output" == *SHASUMS256.txt ]]; then
  printf '%s  node-v22.22.2-linux-x64.tar.gz\n' "$(printf fake-node-tarball | sha256sum | awk '{print $1}')" > "$output"
else
  printf fake-node-tarball > "$output"
fi
`);
    writeExecutable(path.join(toolsDir, "tar"), `#!/usr/bin/env bash
set -euo pipefail
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-C" ]]; then destination="$2"; shift 2; else shift; fi
done
mkdir -p "$destination/node-v22.22.2-linux-x64/bin"
printf '#!/usr/bin/env bash\nprintf 22.22.2\n' > "$destination/node-v22.22.2-linux-x64/bin/node"
chmod +x "$destination/node-v22.22.2-linux-x64/bin/node"
`);
    writeExecutable(path.join(toolsDir, "npm"), "#!/usr/bin/env bash\nexit 0\n");

    const bundleResult = spawnSync("bash", [bundleScript], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${toolsDir}:${process.env.PATH}`,
        TOKENTRACKER_LINUX_EMBED_DIR: embeddedServer,
        TOKENTRACKER_DASHBOARD_DIST: dashboardDist,
        TOKENTRACKER_TAURI_ICON: tauriIcon,
      },
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(
      bundleResult.status,
      0,
      `bundle script failed: ${bundleResult.error?.message || bundleResult.stderr}`
    );

    assert.equal(fs.existsSync(staleFile), false, "rebuild must remove stale output files");
    for (const requiredFile of [
      "node",
      "tokentracker/bin/tracker.js",
      "tokentracker/package.json",
      "tokentracker/dashboard/dist/index.html",
    ]) {
      assert.equal(fs.existsSync(path.join(embeddedServer, requiredFile)), true, `missing ${requiredFile}`);
    }
    const canonicalPixels = PNG.sync.read(fs.readFileSync(canonicalIcon));
    const tauriPixels = PNG.sync.read(fs.readFileSync(tauriIcon));
    assert.equal(tauriPixels.colorType, 6, "Tauri icon must be encoded as RGBA");
    assert.equal(tauriPixels.width, canonicalPixels.width);
    assert.equal(tauriPixels.height, canonicalPixels.height);
    assert.equal(
      sha256(tauriPixels.data),
      sha256(canonicalPixels.data),
      "controlled bundle must preserve the canonical icon pixels"
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
