"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  STAR_CTA_STATE_FILE,
  isInteractiveCli,
  maybeShowStarCta,
} = require("../src/lib/star-cta");

function captureStdout({ isTTY = true } = {}) {
  let output = "";
  return {
    stream: {
      isTTY,
      write(chunk) {
        output += String(chunk || "");
        return true;
      },
    },
    output: () => output,
  };
}

test("star CTA is shown once after an interactive CLI launch", async () => {
  const trackerDir = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-star-cta-"));
  const first = captureStdout();
  const second = captureStdout();

  try {
    const firstResult = await maybeShowStarCta({
      trackerDir,
      stdout: first.stream,
      env: {},
      nowMs: Date.UTC(2026, 6, 15),
      version: "0.79.7",
    });
    assert.deepEqual(firstResult, { shown: true, reason: "shown" });
    assert.match(first.output(), /GitHub Star/);
    assert.match(first.output(), /github\.com\/xiufengsun\/TokenTracker/);

    const state = JSON.parse(
      await fs.readFile(path.join(trackerDir, STAR_CTA_STATE_FILE), "utf8"),
    );
    assert.equal(state.shown_at, "2026-07-15T00:00:00.000Z");
    assert.equal(state.version, "0.79.7");

    const secondResult = await maybeShowStarCta({
      trackerDir,
      stdout: second.stream,
      env: {},
    });
    assert.deepEqual(secondResult, { shown: false, reason: "already-shown" });
    assert.equal(second.output(), "");
  } finally {
    await fs.rm(trackerDir, { recursive: true, force: true });
  }
});

test("star CTA stays silent for automation, native shells, and opt-out", async () => {
  const tty = captureStdout().stream;
  const pipe = captureStdout({ isTTY: false }).stream;

  assert.equal(isInteractiveCli({ stdout: pipe, env: {} }), false);
  assert.equal(isInteractiveCli({ stdout: tty, env: { CI: "true" } }), false);
  assert.equal(isInteractiveCli({ stdout: tty, env: { NODE_TEST_CONTEXT: "child-v8" } }), false);
  assert.equal(isInteractiveCli({ stdout: tty, env: { TOKENTRACKER_APP_SHELL: "macos" } }), false);
  assert.equal(isInteractiveCli({ stdout: tty, env: { TOKENTRACKER_APP_SHELL: "windows" } }), false);
  assert.equal(isInteractiveCli({ stdout: tty, env: { TOKENTRACKER_NO_STAR_PROMPT: "1" } }), false);
  assert.equal(isInteractiveCli({ stdout: tty, env: { TOKENTRACKER_APP_SHELL: "cli" } }), true);
});

test("star CTA stays silent when its state cannot be persisted", async () => {
  const output = captureStdout();
  const result = await maybeShowStarCta({
    trackerDir: "/read-only",
    stdout: output.stream,
    env: {},
    readJsonFn: async () => null,
    writeJsonFn: async () => {
      throw new Error("read only");
    },
  });

  assert.deepEqual(result, { shown: false, reason: "state-write-failed" });
  assert.equal(output.output(), "");
});
