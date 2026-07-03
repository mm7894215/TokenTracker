const assert = require("node:assert/strict");
const { test } = require("node:test");

const { shouldServeSpaFallback } = require("../src/commands/serve");

function request({ method = "GET", accept = "text/html" } = {}) {
  return { method, headers: { accept } };
}

function localUrl(pathname) {
  return new URL(pathname, "http://127.0.0.1:7680");
}

test("serve only falls back to the SPA document for page navigations", () => {
  assert.equal(shouldServeSpaFallback(request(), localUrl("/settings?app=1")), true);
  assert.equal(shouldServeSpaFallback(request(), localUrl("/u/user-without-static-extension")), true);
});

test("serve does not return index.html for missing Vite chunks or static assets", () => {
  assert.equal(shouldServeSpaFallback(request({ accept: "*/*" }), localUrl("/assets/SettingsPage-old.js")), false);
  assert.equal(shouldServeSpaFallback(request({ accept: "*/*" }), localUrl("/assets/main-old.css")), false);
  assert.equal(shouldServeSpaFallback(request({ accept: "image/svg+xml" }), localUrl("/icon.svg")), false);
  assert.equal(shouldServeSpaFallback(request({ accept: "application/json" }), localUrl("/manifest.webmanifest")), false);
});

test("serve does not fall back to index.html for unknown API routes or mutations", () => {
  assert.equal(shouldServeSpaFallback(request({ accept: "*/*" }), localUrl("/functions/missing")), false);
  assert.equal(shouldServeSpaFallback(request({ accept: "application/json" }), localUrl("/api/missing")), false);
  assert.equal(shouldServeSpaFallback(request({ method: "POST", accept: "text/html" }), localUrl("/settings")), false);
});
