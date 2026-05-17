const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const modulePath = pathToFileURL(
  path.resolve("dashboard/src/ui/dashboard/util/should-fetch-github-stars.js"),
).href;

test("shouldFetchGithubStars skips in reduced motion or screenshot capture", async () => {
  const { shouldFetchGithubStars } = await import(modulePath);

  assert.equal(
    shouldFetchGithubStars({
      prefersReducedMotion: true,
      screenshotCapture: false,
    }),
    false,
  );

  assert.equal(
    shouldFetchGithubStars({
      prefersReducedMotion: false,
      screenshotCapture: true,
    }),
    false,
  );

  assert.equal(
    shouldFetchGithubStars({
      prefersReducedMotion: false,
      screenshotCapture: false,
    }),
    true,
  );
});
