const os = require("node:os");
const path = require("node:path");

async function resolveTrackerPaths({ home = os.homedir() } = {}) {
  const rootDir = path.join(home, ".tokentracker");
  return {
    rootDir,
    trackerDir: path.join(rootDir, "tracker"),
    binDir: path.join(rootDir, "bin"),
    cacheDir: path.join(rootDir, "cache"),
  };
}

module.exports = {
  resolveTrackerPaths,
};
