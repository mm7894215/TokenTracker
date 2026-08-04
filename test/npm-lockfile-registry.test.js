const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const managedLockfiles = [
  'package-lock.json',
  'dashboard/package-lock.json',
  'TokenTrackerLinux/package-lock.json',
];

test('managed npm lockfiles use the official npm registry', () => {
  for (const relativePath of managedLockfiles) {
    const contents = fs.readFileSync(path.join(root, relativePath), 'utf8');
    assert.doesNotMatch(
      contents,
      /registry\.npmmirror\.com/,
      `${relativePath} must not pin packages to registry.npmmirror.com`,
    );
  }
});
