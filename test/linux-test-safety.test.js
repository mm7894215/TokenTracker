const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const bundleTestPath = path.resolve(__dirname, 'linux-bundle.test.js');

test('Linux bundle test compares icon pixels without formatting a full Buffer diff', () => {
  const source = fs.readFileSync(bundleTestPath, 'utf8');

  assert.doesNotMatch(
    source,
    /assert\.deepEqual\(\s*tauriPixels\.data,\s*canonicalPixels\.data/s,
    'large pixel buffers must not use assert.deepEqual because a mismatch can exhaust memory while formatting the diff',
  );
  assert.match(source, /createHash\(['"]sha256['"]\)/);
  assert.match(source, /timeout:\s*30_000/);
  assert.match(source, /maxBuffer:\s*1024 \* 1024/);
});
