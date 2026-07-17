const path = require('path');
const { readCanonicalVersion, syncVersions } = require('./version-files.cjs');

const root = path.resolve(__dirname, '..');
const version = readCanonicalVersion(root);
const changed = syncVersions(root, version);

for (const label of changed) console.log(`Synchronized ${label} to v${version}`);
console.log(changed.length === 0 ? `All managed versions already match v${version}.` : `Synchronized ${changed.length} managed version file(s) to v${version}.`);
