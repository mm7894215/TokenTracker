"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");

const README_EXPECTATIONS = [
  ["README.md", /27 AI coding tools/],
  ["README.zh-CN.md", /27 款 AI 编码工具/],
  ["README.ja.md", /27 種類の AI コーディングツール/],
  ["README.ko.md", /27개의 AI 코딩 도구/],
  ["README.de.md", /27 KI-Coding-Tools/],
];

test("public discovery surfaces describe all 27 supported tools", () => {
  for (const [file, countPattern] of README_EXPECTATIONS) {
    const source = read(file);
    assert.match(source, countPattern, `${file} has the current provider count`);
    assert.match(source, /Droid/, `${file} lists Droid`);
    assert.match(source, /AnythingLLM Desktop/, `${file} lists AnythingLLM Desktop`);
  }

  const index = read("dashboard/index.html");
  assert.doesNotMatch(index, /13 AI coding/);
  assert.match(index, /Supported AI coding tools \(27\)/);
  assert.match(index, /Desktop pet/);
  assert.match(index, /Four desktop widgets/);
  assert.match(index, /Achievements/);

  const llms = read("dashboard/public/llms.txt");
  assert.match(llms, /Supported AI coding tools \(27\)/);
  assert.match(llms, /desktop pet/i);
  assert.match(llms, /four desktop widgets/i);
  assert.match(llms, /achievements/i);
});

test("marketing logo wall includes the same 27 product integrations", () => {
  const source = read("dashboard/src/ui/marketing/agent-logos.js");
  const providers = [...source.matchAll(/provider:\s*"([^"]+)"/g)].map((match) => match[1]);
  assert.equal(providers.length, 27);
  assert.equal(new Set(providers).size, 27);

  for (const provider of ["every-code", "kilocode", "roocode", "zed", "goose", "droid", "anythingllm"]) {
    assert.ok(providers.includes(provider), `logo wall includes ${provider}`);
  }
});

test("npm metadata carries the current product hook", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.match(pkg.description, /27 tools/);
  assert.match(pkg.description, /desktop pet/);
  assert.ok(pkg.keywords.includes("desktop-widget"));
  assert.ok(pkg.keywords.includes("ai-coding-tools"));
});
