const assert = require("node:assert/strict");
const { test } = require("node:test");

const { run } = require("../src/cli");

test("help output uses TokenTracker identifiers", async () => {
  const prevWrite = process.stdout.write;
  let out = "";

  try {
    process.stdout.write = (chunk) => {
      out += String(chunk || "");
      return true;
    };

    await run(["-h"]);
  } finally {
    process.stdout.write = prevWrite;
  }

  assert.match(out, /tokentracker/);
  assert.ok(!out.includes("vibe"));
  assert.match(out, /doctor/);
});
