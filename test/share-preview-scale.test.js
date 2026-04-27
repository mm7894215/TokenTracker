const test = require("node:test");
const assert = require("node:assert/strict");
const { loadDashboardModule } = require("./helpers/load-dashboard-module");

let mod;

test.before(async () => {
  mod = await loadDashboardModule("dashboard/src/ui/share/get-share-preview-scale.ts");
});

test("getSharePreviewScale keeps the card inside the live preview bounds", () => {
  const scale = mod.getSharePreviewScale({
    cardWidth: 1280,
    cardHeight: 860,
    maxWidth: 672,
    maxHeight: 692,
  });
  assert.equal(scale, 0.525);
});

test("getSharePreviewScale never enlarges beyond full size", () => {
  const scale = mod.getSharePreviewScale({
    cardWidth: 1280,
    cardHeight: 860,
    maxWidth: 1600,
    maxHeight: 1200,
  });
  assert.equal(scale, 1);
});
