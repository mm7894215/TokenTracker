const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('Linux health monitor releases the server mutex before readiness polling', () => {
  const main = read('TokenTrackerLinux/src-tauri/src/main.rs');
  const restart = main.indexOf('server.restart_process()');
  const release = main.indexOf('drop(guard)', restart);
  const wait = main.indexOf('server::wait_for_server_ready(', restart);

  assert.notEqual(restart, -1, 'health monitor should restart the child process');
  assert.notEqual(release, -1, 'health monitor should explicitly release the SERVER mutex');
  assert.notEqual(wait, -1, 'health monitor should poll readiness after restarting');
  assert.ok(restart < release, 'restart should begin while the server state is protected');
  assert.ok(release < wait, 'readiness polling must happen after releasing the SERVER mutex');
});

test('GitHub CI validates synchronized platform versions', () => {
  const workflow = read('.github/workflows/ci.yml');
  assert.match(workflow, /npm run validate:versions/);
});
