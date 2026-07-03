const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const { multiInstallParse } = require("../src/lib/multi-install-parser");

function makeWireFile(dir, filename, events) {
  const content = events.map(e => JSON.stringify(e)).join("\n") + "\n";
  fs.writeFileSync(path.join(dir, filename), content);
}

test("integration: dual-parse with Kimi Code wire files", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-int-kimi-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const nativeDir = path.join(tmpDir, "native", "sessions", "agent-a");
  const wslDir = path.join(tmpDir, "wsl", "sessions", "agent-b");
  fs.mkdirSync(nativeDir, { recursive: true });
  fs.mkdirSync(wslDir, { recursive: true });

  const t1 = new Date("2026-01-01T10:15:00.000Z").getTime();
  const t2 = new Date("2026-01-01T10:45:00.000Z").getTime();
  const t3 = new Date("2026-01-01T11:15:00.000Z").getTime();

  makeWireFile(nativeDir, "wire.jsonl", [
    { type: "step.end", uuid: "nat-1", usage: { input_tokens: 100, output_tokens: 50 }, time: t1, model: "gpt-4" },
    { type: "step.end", uuid: "nat-2", usage: { input_tokens: 200, output_tokens: 100 }, time: t2, model: "gpt-4" },
  ]);

  makeWireFile(wslDir, "wire.jsonl", [
    { type: "step.end", uuid: "wsl-1", usage: { input_tokens: 50, output_tokens: 25 }, time: t3, model: "gpt-4" },
  ]);

  const { parseKimiCodeIncremental } = require("../src/lib/rollout");

  const queuePath = path.join(tmpDir, "queue.jsonl");
  const cursors = { hourly: { buckets: {} }, files: {} };
  const installPaths = { native: nativeDir, wsl: wslDir };

  const result = await multiInstallParse({
    paths: installPaths,
    parserFn: parseKimiCodeIncremental,
    providerName: "kimi-code",
    cursors,
    getParams: (installPath) => ({ wireFiles: [path.join(installPath, "wire.jsonl")] }),
    queuePath,
    env: process.env,
  });

  assert.ok(result.recordsProcessed > 0, "should process records from both installs");
  assert.ok(result.eventsAggregated > 0);
  assert.ok(result.bucketsQueued > 0, "should queue buckets");
  assert.equal(result.recordsProcessed, 3, "3 total wire events from both installs");

  // Verify queue file has rows from both installs merged by (source, model, hour_start)
  const queueContent = fs.readFileSync(queuePath, "utf8").trim().split("\n").filter(Boolean);
  const queueBuckets = queueContent.map(line => JSON.parse(line));

  // Native 10:15 and 10:45 → bucket at 10:00 and 10:30
  // WSL 11:15 → bucket at 11:00
  assert.ok(queueBuckets.length >= 2, `should have at least 2 bucket rows, got ${queueBuckets.length}`);
  const sources = new Set(queueBuckets.map(r => r.source));
  assert.ok(sources.has("kimi"), `queue source should be kimi, got ${[...sources].join(", ")}`);

  const pendingBytes = queueContent.reduce((sum, l) => sum + Buffer.byteLength(l, "utf8") + 1, 0);
  assert.ok(pendingBytes > 100, `queue should have meaningful content (${pendingBytes} bytes)`);
});
