#!/usr/bin/env node
/* eslint-disable no-console */

const { run } = require('../src/cli');
const { stripDebugFlag } = require('../src/lib/debug-flags');
const { relaunchWithProxyEnvIfNeeded } = require('../src/lib/proxy-env');

const { argv, debug } = stripDebugFlag(process.argv.slice(2));
if (debug) process.env.TOKENTRACKER_DEBUG = '1';

const relaunch = relaunchWithProxyEnvIfNeeded({
  argv,
  originalArgv: process.argv.slice(1),
});
if (relaunch) {
  if (typeof relaunch.status === 'number') process.exit(relaunch.status);
  if (relaunch.error) {
    console.error(relaunch.error?.stack || String(relaunch.error));
    process.exit(1);
  }
  process.exit(0);
}

run(argv).catch((err) => {
  console.error(err?.stack || String(err));
  if (debug) {
    if (typeof err?.status === 'number') {
      console.error(`Status: ${err.status}`);
    }
    if (typeof err?.code === 'string' && err.code.trim()) {
      console.error(`Code: ${err.code.trim()}`);
    }
    const original = err?.originalMessage;
    if (original && original !== err?.message) {
      console.error(`Original error: ${original}`);
    }
    if (typeof err?.nextActions === 'string' && err.nextActions.trim()) {
      console.error(`Next actions: ${err.nextActions.trim()}`);
    }
  }
  process.exitCode = 1;
});
