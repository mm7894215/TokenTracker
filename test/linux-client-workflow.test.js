const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
const release = fs.readFileSync(path.join(root, '.github/workflows/release-dmg.yml'), 'utf8');
const validatorPath = path.join(root, 'TokenTrackerLinux/scripts/validate-package.sh');
const pkgbuild = fs.readFileSync(
  path.join(root, 'TokenTrackerLinux/packaging/arch/tokentracker-linux/PKGBUILD'),
  'utf8',
);

test('PR CI checks the Linux client with Rust tooling only', () => {
  assert.match(ci, /linux-client:/);
  assert.match(ci, /cargo test --locked/);
  assert.match(ci, /cargo clippy --locked --all-targets -- -D warnings/);
  assert.match(ci, /cargo fmt --check/);
  // webkit2gtk is needed to compile the tauri crate at all.
  assert.match(ci, /libwebkit2gtk-4\.1-dev/);
  // Cargo builds are slow enough that caching is not optional.
  assert.match(ci, /Swatinem\/rust-cache/);
});

test('PR CI does not run the heavy packaging path', () => {
  // Building an Arch package (or an AppImage) per PR costs a container, a full
  // pacman sync and the ~100MB embedded Node download for no extra signal --
  // packaging belongs to the release workflow.
  assert.doesNotMatch(ci, /^\s*image:\s*archlinux/m);

  // Compare against the executable content only: YAML comments legitimately
  // mention the tools being excluded, so a naive regex over the whole file
  // would match its own rationale.
  const commands = ci
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

  for (const packagingTool of ['makepkg', 'appimagetool', 'tauri build', 'bundle:node']) {
    assert.ok(
      !commands.includes(packagingTool),
      `PR CI should not invoke ${packagingTool}`,
    );
  }
});

test('release workflow builds Linux in parallel with macOS and Windows', () => {
  assert.match(release, /^name: release \(macOS \+ Windows \+ Linux\)$/m);

  // `needs: create-release` (not `needs: build`) is what makes it parallel.
  assert.match(release, /^ {2}linux:\n {4}needs: create-release$/m);

  // Every builder must check out the immutable version tag, not a branch.
  const linuxJob = release.slice(release.indexOf('\n  linux:'), release.indexOf('\n  publish:'));
  assert.match(linuxJob, /ref: refs\/tags\/v\$\{\{ inputs\.version \}\}/);

  // The runtime must be bundled before `tauri build`, because tauri-build
  // hard-fails on the missing EmbeddedServer resource path.
  const bundleIndex = linuxJob.indexOf('run bundle:node');
  const buildIndex = linuxJob.indexOf('run build');
  assert.notEqual(bundleIndex, -1, 'release must bundle the embedded runtime');
  assert.notEqual(buildIndex, -1, 'release must build the AppImage');
  assert.ok(bundleIndex < buildIndex, 'bundle:node must run before the AppImage build');
});

test('release produces exactly one Linux artifact and verifies its payload', () => {
  const linuxJob = release.slice(release.indexOf('\n  linux:'), release.indexOf('\n  publish:'));

  // Guard against a silently empty bundle: an AppImage without the embedded
  // runtime starts and then fails to find tracker.js on every machine.
  assert.match(linuxJob, /--appimage-extract/);
  assert.match(linuxJob, /EmbeddedServer/);
  assert.match(linuxJob, /tokentracker\/bin\/tracker\.js/);
  assert.match(linuxJob, /dashboard\/dist\/index\.html/);
  assert.match(linuxJob, /Expected exactly 1 AppImage/);
  assert.match(linuxJob, /TokenTracker-linux-x86_64\.AppImage --clobber/);
});

test('publish waits for all three platforms and verifies four assets', () => {
  assert.match(release, /^ {4}needs: \[build, windows, linux\]$/m);

  const assetLine = release
    .split('\n')
    .find((line) => line.includes('for asset in'));
  assert.ok(assetLine, 'publish should enumerate the required assets');
  for (const asset of [
    'TokenTrackerBar.dmg',
    'TokenTracker-win-x64.zip',
    'TokenTracker-Setup.exe',
    'TokenTracker-linux-x86_64.AppImage',
  ]) {
    assert.ok(assetLine.includes(asset), `publish must verify ${asset}`);
  }
});

test('release verifies every managed version file via the shared registry', () => {
  // Adding a platform must not require a new hand-written version check.
  assert.match(release, /collectVersionEntries/);
  assert.match(release, /scripts\/version-files\.cjs/);
});

test('no workflow or doc still references the old release workflow name', () => {
  const files = [
    '.github/workflows/release-dmg.yml',
    'CLAUDE.md',
    'docs/opencode-go-limits.md',
  ];
  for (const file of files) {
    const fullPath = path.join(root, file);
    if (!fs.existsSync(fullPath)) continue;
    const contents = fs.readFileSync(fullPath, 'utf8');
    assert.doesNotMatch(
      contents,
      /release \(macOS \+ Windows\)(?! \+ Linux)/,
      `${file} still names the workflow "release (macOS + Windows)"`,
    );
  }
});

test('Arch package build disables the unused split debug package', () => {
  assert.match(pkgbuild, /^options=\(!debug\)$/m);
});

test('Arch package validator checks the shipped runtime contract', () => {
  assert.ok(fs.existsSync(validatorPath), 'package validator should exist');
  const validator = fs.readFileSync(validatorPath, 'utf8');

  for (const required of [
    'usr/bin/tokentracker-linux',
    'usr/lib/tokentracker-linux/node',
    'usr/lib/tokentracker-linux/tokentracker/bin/tracker.js',
    'usr/lib/tokentracker-linux/tokentracker/dashboard/dist/index.html',
    'usr/share/applications/tokentracker-linux.desktop',
    'usr/share/icons/hicolor/512x512/apps/tokentracker-linux.png',
    'usr/share/licenses/tokentracker-linux/LICENSE',
  ]) {
    assert.match(validator, new RegExp(required.replaceAll('/', '\\/')));
  }

  assert.match(validator, /desktop-file-validate/);
  assert.match(validator, /x-scheme-handler\/tokentracker/);
  assert.match(validator, /22\.22\.2/);
  assert.match(validator, /tokentracker-user-status/);
});
