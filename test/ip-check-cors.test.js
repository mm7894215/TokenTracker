const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

test("IP check page avoids direct browser probes to CORS-blocked China IP endpoints", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "dashboard", "src", "pages", "IpCheckPage.jsx"),
    "utf8",
  );

  assert.doesNotMatch(source, /fetch\(\s*["']https:\/\/2026\.ip138\.com\//);
  assert.doesNotMatch(source, /fetch\(\s*["']https:\/\/my\.ip\.cn\//);
});
