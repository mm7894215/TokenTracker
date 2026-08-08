const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('Linux health monitor never probes HTTP while holding the server mutex', () => {
  const main = read('TokenTrackerLinux/src-tauri/src/main.rs');

  // Liveness is read under the lock; the socket probe happens after the guard
  // has dropped. Holding the mutex across a second-scale connect/read delays
  // stop_server() on app exit by the same amount.
  const liveness = main.indexOf('server.is_process_alive()');
  const probe = main.indexOf('server::probe_server_http(port)');

  assert.notEqual(liveness, -1, 'monitor should check whether the child is alive');
  assert.notEqual(probe, -1, 'monitor should probe the HTTP endpoint');
  assert.ok(liveness < probe, 'liveness is read under the lock, then the guard drops');

  // The probe must sit at the loop body's top level, not nested inside the
  // scoped block that holds the guard.
  assert.match(
    main,
    /\n {12}if process_alive && server::probe_server_http\(port\)\.is_ok\(\) \{/,
    'the probe should run outside the guard scope',
  );
});

test('Linux server exposes liveness and readiness as separate operations', () => {
  const server = read('TokenTrackerLinux/src-tauri/src/server.rs');

  assert.match(server, /pub fn is_process_alive/);
  assert.match(server, /pub fn probe_server_http/);
  // The old combined helper held the lock across the network probe.
  assert.doesNotMatch(server, /fn check_health/);
});

test('Linux health monitor releases the server mutex before readiness polling', () => {
  const main = read('TokenTrackerLinux/src-tauri/src/main.rs');
  const restart = main.indexOf('server.restart_process()');
  const wait = main.indexOf('server::wait_for_server_ready(', restart);

  assert.notEqual(restart, -1, 'health monitor should restart the child process');
  assert.notEqual(wait, -1, 'health monitor should poll readiness after restarting');
  assert.ok(restart < wait, 'readiness polling must happen after the restart');

  // restart_process() is the last expression of the guarded block, so the
  // MutexGuard drops before wait_for_server_ready runs.
  assert.match(
    main,
    /server\.restart_process\(\)\n {12}\};/,
    'restart_process should end the guarded scope so the guard drops',
  );
});

test('Linux health monitor does not restart a port it no longer owns', () => {
  const main = read('TokenTrackerLinux/src-tauri/src/main.rs');
  // The port is read without the lock held during the probe, so it can go
  // stale before the restart re-acquires the lock.
  assert.match(main, /if server\.port\(\) != port \{/);
});

test('Linux health monitor comment matches its actual back-off behaviour', () => {
  const main = read('TokenTrackerLinux/src-tauri/src/main.rs');

  // The counter is reset after backing off, so restarts continue indefinitely.
  // The doc comment must not claim the loop is capped.
  assert.doesNotMatch(
    main,
    /avoid an infinite crash loop/,
    'the monitor retries forever with back-off; the comment must not claim otherwise',
  );
  assert.match(main, /retried slowly and indefinitely/);
});

test('Linux client starts the server off the setup thread', () => {
  const main = read('TokenTrackerLinux/src-tauri/src/main.rs');

  const windowBuild = main.indexOf('WebviewWindowBuilder::new');
  const spawn = main.indexOf('std::thread::spawn(move || start_dashboard');

  assert.notEqual(windowBuild, -1, 'setup should create the main window');
  assert.notEqual(spawn, -1, 'the server should start on a worker thread');
  // The window must exist before the (slow) server start, or the tray menu's
  // "Open Dashboard" has no "main" window to raise for up to 20 seconds.
  assert.ok(windowBuild < spawn, 'the window is created before the server starts');
  assert.doesNotMatch(
    main,
    /TokenTrackerServer::start\(runtime_paths\)\?/,
    'the server must not be started synchronously inside setup()',
  );
});

test('Linux startup failures surface in the loading page', () => {
  const main = read('TokenTrackerLinux/src-tauri/src/main.rs');
  const html = read('TokenTrackerLinux/src/index.html');

  assert.match(main, /tokentracker:startup-error/);
  assert.match(html, /tokentracker:startup-error/);
  // The detail carries filesystem paths; it must never be interpolated as HTML.
  assert.match(html, /\.textContent\s*=/);
  assert.doesNotMatch(html, /\.innerHTML\s*=/, 'the detail must never be interpolated as HTML');
});

test('Linux tray does not ship a click handler that cannot fire', () => {
  const tray = read('TokenTrackerLinux/src-tauri/src/tray.rs');

  // tray-icon's GTK/libappindicator backend never emits TrayIconEvent, so a
  // left-click handler would compile and look functional while never running.
  // Match the builder call, not the comment explaining its absence.
  assert.doesNotMatch(tray, /\.on_tray_icon_event\(/);
  assert.doesNotMatch(tray, /MouseButton::/);
  // The menu is the only affordance, so it must still open the dashboard.
  assert.match(tray, /Open Dashboard/);
  assert.match(tray, /Linux/, 'the platform limitation should be documented in place');
});

test('GitHub CI validates synchronized platform versions', () => {
  const workflow = read('.github/workflows/ci.yml');
  assert.match(workflow, /npm run validate:versions/);
});
