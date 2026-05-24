const assert = require("node:assert/strict");
const { test } = require("node:test");

const { parseArgs, normalizeAllowedHosts, serveDashboardConfig } = require("../src/commands/serve");

test("serve parses comma-separated and repeated --allowed-hosts values", () => {
  const opts = parseArgs([
    "--no-open",
    "--allowed-hosts",
    "agents.internal.test, https://preview.internal.test:443/path",
    "--allowed-hosts=workstation.internal.test",
  ]);

  assert.deepEqual(opts.allowedHosts, [
    "agents.internal.test",
    "preview.internal.test",
    "workstation.internal.test",
  ]);
});

test("allowed host normalization rejects wildcards and non-host values", () => {
  assert.deepEqual(
    normalizeAllowedHosts([
      "localhost",
      "*.example.com",
      "https://ok.example.com/dashboard",
      "not a host",
      "127.0.0.1",
    ]),
    ["localhost", "ok.example.com", "127.0.0.1"],
  );
});

test("dashboard config route exposes normalized allowed hosts", () => {
  const chunks = [];
  const res = {
    status: null,
    headers: null,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    },
  };

  serveDashboardConfig(res, { allowedHosts: ["Example.COM", "https://preview.example/path"] });

  assert.equal(res.status, 200);
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString("utf8")), {
    allowedHosts: ["example.com", "preview.example"],
  });
});
