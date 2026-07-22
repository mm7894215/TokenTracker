const path = require('path');
const { readCanonicalVersion, findVersionMismatches } = require('./version-files.cjs');

const root = path.resolve(__dirname, '..');
const version = readCanonicalVersion(root);
const mismatches = findVersionMismatches(root, version);

if (mismatches.length === 0) {
  console.log(`All managed versions match v${version}.`);
} else {
  for (const { label, expected, actual } of mismatches) {
    console.error(`${label}: expected v${expected}, found v${actual}`);
  }
  process.exitCode = 1;
}
