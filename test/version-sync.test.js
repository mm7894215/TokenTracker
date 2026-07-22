const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  readCanonicalVersion,
  collectVersionEntries,
  syncVersions,
  findVersionMismatches,
} = require('../scripts/version-files.cjs');

function writeFixture(root, canonical = '2.3.4', stale = '0.0.1') {
  const files = {
    'package.json': JSON.stringify({ name: 'tokentracker-cli', version: canonical }, null, 2),
    'TokenTrackerBar/project.yml': [
      'MARKETING_VERSION: "' + stale + '"',
      'MARKETING_VERSION: "' + stale + '"',
    ].join('\n'),
    'TokenTrackerWin/TokenTrackerWin.csproj': `<Project><PropertyGroup><Version>${stale}</Version></PropertyGroup></Project>`,
    'TokenTrackerLinux/package.json': JSON.stringify({ name: 'tokentracker-linux', version: stale }, null, 2),
    'TokenTrackerLinux/package-lock.json': JSON.stringify({ name: 'tokentracker-linux', version: stale, lockfileVersion: 3, packages: { '': { name: 'tokentracker-linux', version: stale }, 'node_modules/example': { version: stale } } }, null, 2),
    'TokenTrackerLinux/src-tauri/Cargo.toml': `[package]\nname = "tokentracker-linux"\nversion = "${stale}"\n`,
    'TokenTrackerLinux/src-tauri/Cargo.lock': `version = 4\n\n[[package]]\nname = "other"\nversion = "${stale}"\n\n[[package]]\nname = "tokentracker-linux"\nversion = "${stale}"\n`,
    'TokenTrackerLinux/src-tauri/tauri.conf.json': JSON.stringify({ productName: 'TokenTracker', version: stale }, null, 2),
    'TokenTrackerLinux/packaging/arch/tokentracker-linux/PKGBUILD': `pkgname=tokentracker-linux\npkgver=${stale}\npkgrel=1\n`,
  };
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokentracker-version-sync-'));
  writeFixture(root);
  return root;
}

test('syncVersions updates every managed platform version from the root package version', (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const version = readCanonicalVersion(root);
  const changed = syncVersions(root, version);

  assert.equal(version, '2.3.4');
  assert.deepEqual(findVersionMismatches(root, version), []);
  assert.equal(collectVersionEntries(root).length, 9);
  assert.equal(changed.length, 8);
  assert.match(fs.readFileSync(path.join(root, 'TokenTrackerLinux/src-tauri/Cargo.lock'), 'utf8'), /name = "other"\nversion = "0\.0\.1"/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'TokenTrackerLinux/package-lock.json'), 'utf8')).version, version);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'TokenTrackerLinux/package-lock.json'), 'utf8')).packages['node_modules/example'].version, '0.0.1');
});

test('collectVersionEntries rejects duplicate PKGBUILD pkgver entries', (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'TokenTrackerLinux/packaging/arch/tokentracker-linux/PKGBUILD');
  fs.appendFileSync(file, 'pkgver=9.9.9\n');

  assert.throws(
    () => collectVersionEntries(root),
    /Expected exactly one pkgver entry/,
  );
});

test('collectVersionEntries rejects duplicate target Cargo.lock versions', (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'TokenTrackerLinux/src-tauri/Cargo.lock');
  fs.appendFileSync(file, 'version = "9.9.9"\n');

  assert.throws(
    () => collectVersionEntries(root),
    /Expected exactly one tokentracker-linux Cargo.lock version entry/,
  );
});

test('findVersionMismatches reports all stale values without modifying any fixture file', (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const before = new Map(collectVersionEntries(root).map(({ label }) => [label, fs.readFileSync(path.join(root, label), 'utf8')]));

  const mismatches = findVersionMismatches(root, '2.3.4');

  assert.equal(mismatches.length, 8);
  assert.deepEqual(mismatches.map(({ label }) => label), [
    'TokenTrackerBar/project.yml',
    'TokenTrackerWin/TokenTrackerWin.csproj',
    'TokenTrackerLinux/package.json',
    'TokenTrackerLinux/package-lock.json',
    'TokenTrackerLinux/src-tauri/Cargo.toml',
    'TokenTrackerLinux/src-tauri/Cargo.lock',
    'TokenTrackerLinux/src-tauri/tauri.conf.json',
    'TokenTrackerLinux/packaging/arch/tokentracker-linux/PKGBUILD',
  ]);
  for (const [label, content] of before) {
    assert.equal(fs.readFileSync(path.join(root, label), 'utf8'), content, `${label} was modified by validation`);
  }
});
