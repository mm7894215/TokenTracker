const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { purgeProjectUsage } = require("../src/lib/project-usage-purge");

test("purgeProjectUsage preserves queue offset after removing lines", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-purge-"));
  const queuePath = path.join(tmp, "project.queue.jsonl");
  const statePath = path.join(tmp, "project.queue.state.json");

  const line1 = JSON.stringify({
    project_key: "blocked",
    project_ref: "repo1",
    hour_start: "2026-01-01T00:00:00Z",
    source: "codex",
  });
  const line2 = JSON.stringify({
    project_key: "keep",
    project_ref: "repo2",
    hour_start: "2026-01-01T00:00:00Z",
    source: "codex",
  });
  const line3 = JSON.stringify({
    project_key: "keep",
    project_ref: "repo2",
    hour_start: "2026-01-01T01:00:00Z",
    source: "codex",
  });
  const contents = `${line1}\n${line2}\n${line3}\n`;
  await fs.writeFile(queuePath, contents, "utf8");

  const oldOffset = Buffer.byteLength(`${line1}\n${line2}\n`, "utf8");
  await fs.writeFile(statePath, JSON.stringify({ offset: oldOffset }), "utf8");

  const projectState = {
    buckets: {
      "blocked|codex|2026-01-01T00:00:00Z": { totals: { input_tokens: 1 } },
      "keep|codex|2026-01-01T00:00:00Z": { totals: { input_tokens: 2 } },
    },
  };

  const res = await purgeProjectUsage({
    projectKey: "blocked",
    projectQueuePath: queuePath,
    projectQueueStatePath: statePath,
    projectState,
  });

  assert.equal(res.removed, 1);
  assert.equal(res.kept, 2);

  const after = await fs.readFile(queuePath, "utf8");
  assert.ok(!after.includes('"project_key":"blocked"'));

  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  const expectedOffset = Buffer.byteLength(`${line2}\n`, "utf8");
  assert.equal(state.offset, expectedOffset);
});
