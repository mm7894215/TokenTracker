const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { runRetroValidation, parseFrontmatter } = require("../scripts/validate-retros.cjs");

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

test("parseFrontmatter parses scalar and list values", () => {
  const text = `---\nrepo: tokentracker\nlayer: backend\nreusable_for:\n  - ingest\n  - sync\n---\n\n# Title\n`;
  const fm = parseFrontmatter(text);
  assert.equal(fm.repo, "tokentracker");
  assert.equal(fm.layer, "backend");
  assert.deepEqual(fm.reusable_for, ["ingest", "sync"]);
});

test("runRetroValidation passes for repo-scoped retrospective with index references", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retro-ok-"));
  const retroRoot = path.join(root, "docs", "retrospective");

  write(
    path.join(retroRoot, "_index.md"),
    `# idx\n- path: \`tokentracker/2026-02-14-openclaw-ingest-gap.md\`\n`,
  );
  write(
    path.join(retroRoot, "tokentracker", "_index.md"),
    `# repo idx\n- file: \`2026-02-14-openclaw-ingest-gap.md\`\n`,
  );
  write(
    path.join(retroRoot, "tokentracker", "2026-02-14-openclaw-ingest-gap.md"),
    `---\nrepo: tokentracker\nlayer: backend\nmodule: openclaw-sync\nseverity: S1\ndesign_mismatch: yes\ndetection_gap: yes\n---\n\n# OK\n`,
  );

  const { errors } = runRetroValidation({ root });
  assert.deepEqual(errors, []);
});

test("runRetroValidation fails when global index reference is missing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retro-fail-"));
  const retroRoot = path.join(root, "docs", "retrospective");

  write(path.join(retroRoot, "_index.md"), "# idx\n");
  write(
    path.join(retroRoot, "tokentracker", "_index.md"),
    `# repo idx\n- file: \`2026-02-14-openclaw-ingest-gap.md\`\n`,
  );
  write(
    path.join(retroRoot, "tokentracker", "2026-02-14-openclaw-ingest-gap.md"),
    `---\nrepo: tokentracker\nlayer: backend\nmodule: openclaw-sync\nseverity: S1\ndesign_mismatch: yes\ndetection_gap: yes\n---\n\n# Missing global index ref\n`,
  );

  const { errors } = runRetroValidation({ root });
  assert.ok(errors.some((e) => e.includes("not referenced in docs/retrospective/_index.md")));
});
