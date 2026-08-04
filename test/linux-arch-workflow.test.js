const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
const validatorPath = path.join(root, 'TokenTrackerLinux/scripts/validate-package.sh');
const pkgbuild = fs.readFileSync(
  path.join(root, 'TokenTrackerLinux/packaging/arch/tokentracker-linux/PKGBUILD'),
  'utf8',
);

test('CI builds and validates the Arch package as a non-root user', () => {
  assert.match(workflow, /arch-package:/);
  assert.match(workflow, /image:\s*archlinux:base-devel/);
  assert.match(workflow, /useradd[^\n]*builder/);
  assert.match(workflow, /runuser -u builder/);
  assert.match(workflow, /cargo test[^\n]*--locked/);
  assert.equal((workflow.match(/makepkg --cleanbuild --force --noconfirm/g) || []).length, 1);
  assert.match(workflow, /TokenTrackerLinux\/scripts\/validate-package\.sh/);
  assert.doesNotMatch(workflow, /sudo\s+makepkg|makepkg\s+-si/);
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
