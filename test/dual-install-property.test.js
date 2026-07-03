const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const { multiInstallParse } = require("../src/lib/multi-install-parser");

const BUCKET_KEY_RE = /^[a-z0-9_-]+\|[a-z0-9_.-]+\|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function xorshift32(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

function randomInt(rng, min, max) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function randomString(rng, len) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789-_";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(rng() * chars.length)];
  return s;
}

test("property: multiInstallParse invariants hold across random inputs", async (t) => {
  const rng = xorshift32(42);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-prop-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const queuePath = path.join(tmpDir, "queue.jsonl");

  for (let iter = 0; iter < 100; iter++) {
    const numInstalls = randomInt(rng, 1, 2);
    const numBuckets = randomInt(rng, 0, 10);
    const hasPrefer = rng() > 0.5;
    const preferVal = hasPrefer ? (rng() > 0.5 ? "native" : "wsl") : null;
    const installKeys = numInstalls === 2 ? { native: "/a", wsl: "/b" } : { native: "/a", wsl: null };

    const cursors = { hourly: { buckets: {} } };
    const env = preferVal ? { TOKENTRACKER_WSL_PREFER: preferVal } : {};

    const result = await multiInstallParse({
      paths: installKeys,
      parserFn: async ({ cursors: c }) => {
        for (let b = 0; b < numBuckets; b++) {
          const source = randomString(rng, 6);
          const model = randomString(rng, 8);
          const hourStart = `2026-01-01T${String(randomInt(rng, 0, 23)).padStart(2, "0")}:00:00.000Z`;
          const key = `${source}|${model}|${hourStart}`;
          const existing = c.hourly.buckets[key];
          const prevIn = existing?.totals?.input_tokens || 0;
          const prevOut = existing?.totals?.output_tokens || 0;
          c.hourly.buckets[key] = {
            totals: {
              input_tokens: prevIn + randomInt(rng, 0, 10000),
              output_tokens: prevOut + randomInt(rng, 0, 10000),
            },
          };
        }
        return {
          recordsProcessed: randomInt(rng, 0, 100),
          eventsAggregated: randomInt(rng, 0, 100),
          bucketsQueued: numBuckets,
        };
      },
      providerName: "test",
      cursors,
      env,
      getParams: (p) => ({ path: p }),
      queuePath,
    });

    assert.ok(Number.isFinite(result.recordsProcessed) && result.recordsProcessed >= 0,
      `iter ${iter}: recordsProcessed=${result.recordsProcessed}`);
    assert.ok(Number.isFinite(result.eventsAggregated) && result.eventsAggregated >= 0,
      `iter ${iter}: eventsAggregated=${result.eventsAggregated}`);
    assert.ok(Number.isFinite(result.bucketsQueued) && result.bucketsQueued >= 0,
      `iter ${iter}: bucketsQueued=${result.bucketsQueued}`);

    if (cursors.hourly?.buckets) {
      for (const [key, val] of Object.entries(cursors.hourly.buckets)) {
        assert.ok(BUCKET_KEY_RE.test(key), `iter ${iter}: invalid bucket key "${key}"`);
        const t = val.totals;
        for (const field of ["input_tokens", "output_tokens"]) {
          assert.ok(Number.isFinite(t[field]) && t[field] >= 0,
            `iter ${iter}: ${field}=${t[field]} in key "${key}"`);
        }
      }
    }
  }
});
