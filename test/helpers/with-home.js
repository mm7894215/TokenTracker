"use strict";

// Redirect os.homedir() to an isolated directory for the duration of a test.
//
// os.homedir() honors $HOME on POSIX but reads %USERPROFILE% on Windows and
// ignores HOME. A test that swaps only HOME therefore still resolves to the
// developer's real home on Windows, so commands under test write into the real
// ~/.tokentracker — which is how `npm test` on Windows silently rewrote
// config.baseUrl to a test value and broke cloud upload. Swap BOTH vars.
//
// Returns a restore() to call from the test's finally block.
function withHome(dir) {
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  return function restoreHome() {
    for (const key of ["HOME", "USERPROFILE"]) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  };
}

module.exports = { withHome };
