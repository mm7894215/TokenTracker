"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");

const README_EXPECTATIONS = [
  ["README.md", /29 AI coding tools/, /\|\s+\*\*AI tools supported\*\*\s+\|\s+\*\*29\*\*/],
  ["README.zh-CN.md", /29 款 AI 编码工具/, /\|\s+\*\*支持的 AI 工具数\*\*\s+\|\s+\*\*29\*\*/],
  ["README.ja.md", /29 種類の AI コーディングツール/, /\|\s+\*\*対応 AI ツール数\*\*\s+\|\s+\*\*29\*\*/],
  ["README.ko.md", /29개의 AI 코딩 도구/, /\|\s+\*\*지원 AI 도구\*\*\s+\|\s+\*\*29\*\*/],
  ["README.de.md", /29 KI-Coding-Tools/, /\|\s+\*\*Unterstützte KI-Tools\*\*\s+\|\s+\*\*29\*\*/],
];

test("public discovery surfaces describe all 29 supported tools", () => {
  for (const [file, countPattern, comparisonPattern] of README_EXPECTATIONS) {
    const source = read(file);
    assert.match(source, countPattern, `${file} has the current provider count`);
    assert.match(source, comparisonPattern, `${file} comparison table has the current provider count`);
    assert.match(source, /Droid/, `${file} lists Droid`);
    assert.match(source, /AnythingLLM Desktop/, `${file} lists AnythingLLM Desktop`);
    assert.match(source, /Qoder/, `${file} lists Qoder`);
    assert.match(source, /12/, `${file} carries the current usage-limits provider count`);
  }

  const index = read("dashboard/index.html");
  assert.doesNotMatch(index, /13 AI coding/);
  assert.match(index, /Supported AI coding tools \(29\)/);
  assert.match(index, /Desktop pet/);
  assert.match(index, /Four desktop widgets/);
  assert.match(index, /Achievements/);
  assert.match(index, /Service Status page/);
  assert.match(index, /usage limits for 12 providers/i);

  const llms = read("dashboard/public/llms.txt");
  assert.match(llms, /Supported AI coding tools \(29\)/);
  assert.match(llms, /desktop pet/i);
  assert.match(llms, /four desktop widgets/i);
  assert.match(llms, /achievements/i);
});

test("marketing logo wall includes the same 29 product integrations", () => {
  const source = read("dashboard/src/ui/marketing/agent-logos.js");
  const providers = [...source.matchAll(/provider:\s*"([^"]+)"/g)].map((match) => match[1]);
  assert.equal(providers.length, 29);
  assert.equal(new Set(providers).size, 29);

  for (const provider of ["every-code", "kilocode", "roocode", "zed", "goose", "droid", "qoder", "anythingllm"]) {
    assert.ok(providers.includes(provider), `logo wall includes ${provider}`);
  }
});

test("CLI onboarding advertises the same 29 supported integrations", () => {
  const source = read("src/commands/init.js");
  const block = source.match(/const SUPPORTED_PROVIDERS = \[([\s\S]*?)\];/);
  assert.ok(block, "init defines SUPPORTED_PROVIDERS");

  const providers = [...block[1].matchAll(/^\s*"([^"]+)",?$/gm)].map((match) => match[1]);
  assert.equal(providers.length, 29);
  assert.equal(new Set(providers).size, 29);
  assert.ok(providers.includes("Droid"));
  assert.ok(providers.includes("AnythingLLM Desktop"));
  assert.ok(providers.includes("Qoder"));
});

test("npm metadata carries the current product hook", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.match(pkg.description, /29 tools/);
  assert.match(pkg.description, /desktop pet/);
  assert.ok(pkg.keywords.includes("desktop-widget"));
  assert.ok(pkg.keywords.includes("ai-coding-tools"));
});
