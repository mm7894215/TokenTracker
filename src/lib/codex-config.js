const fs = require("node:fs/promises");
const path = require("node:path");

const { ensureDir, readJson, writeJson } = require("./fs");

async function upsertNotify({
  configPath,
  notifyCmd,
  notifyOriginalPath,
  configLabel,
  captureOriginal = true,
  replaceOriginal = false,
}) {
  const originalText = await fs.readFile(configPath, "utf8").catch(() => null);
  if (originalText == null) {
    const label =
      typeof configLabel === "string" && configLabel.length > 0 ? configLabel : "Config";
    throw new Error(`${label} not found: ${configPath}`);
  }

  const existingNotify = extractNotify(originalText);
  const already = arraysEqual(existingNotify, notifyCmd);

  if (!already) {
    // Persist original notify once (for uninstall + chaining). When a caller
    // asks to replace the stored original and the config has no notify, record
    // that absence so uninstall does not resurrect a stale backup.
    const hasExistingNotify = Array.isArray(existingNotify);
    if (captureOriginal && (hasExistingNotify || replaceOriginal)) {
      await ensureDir(path.dirname(notifyOriginalPath));
      const existing = await readJson(notifyOriginalPath);
      if (replaceOriginal || !existing) {
        await writeJson(notifyOriginalPath, {
          notify: hasExistingNotify ? existingNotify : null,
          capturedAt: new Date().toISOString(),
        });
      }
    }

    const updated = setNotify(originalText, notifyCmd);
    const backupPath = `${configPath}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await fs.copyFile(configPath, backupPath);
    await fs.writeFile(configPath, updated, "utf8");
    return { changed: true, backupPath };
  }

  return { changed: false, backupPath: null };
}

async function restoreNotify({ configPath, notifyOriginalPath, expectedNotify }) {
  const text = await fs.readFile(configPath, "utf8").catch(() => null);
  if (text == null) return { restored: false, skippedReason: "config-missing" };

  const original = await readJson(notifyOriginalPath);
  const originalNotify = Array.isArray(original?.notify) ? original.notify : null;
  const currentNotify = extractNotify(text);

  if (expectedNotify && !arraysEqual(currentNotify, expectedNotify)) {
    return { restored: false, skippedReason: "current-not-managed" };
  }

  if (!originalNotify && expectedNotify && !arraysEqual(currentNotify, expectedNotify)) {
    return { restored: false, skippedReason: "no-backup-not-installed" };
  }

  const updated = originalNotify ? setNotify(text, originalNotify) : removeNotify(text);
  if (updated === text) return { restored: false, skippedReason: "no-change" };

  const backupPath = `${configPath}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`;
  await fs.copyFile(configPath, backupPath).catch(() => {});
  await fs.writeFile(configPath, updated, "utf8");
  return { restored: true, skippedReason: null };
}

async function loadNotifyOriginal(notifyOriginalPath) {
  const original = await readJson(notifyOriginalPath);
  return Array.isArray(original?.notify) ? original.notify : null;
}

async function readNotify(configPath) {
  const text = await fs.readFile(configPath, "utf8").catch(() => null);
  if (text == null) return null;
  return extractNotify(text);
}

async function upsertCodexNotify({
  codexConfigPath,
  notifyCmd,
  notifyOriginalPath,
  captureOriginal = true,
  replaceOriginal = false,
}) {
  return upsertNotify({
    configPath: codexConfigPath,
    notifyCmd,
    notifyOriginalPath,
    configLabel: "Codex config",
    captureOriginal,
    replaceOriginal,
  });
}

async function restoreCodexNotify({ codexConfigPath, notifyOriginalPath, notifyCmd }) {
  return restoreNotify({
    configPath: codexConfigPath,
    notifyOriginalPath,
    expectedNotify: notifyCmd,
  });
}

async function loadCodexNotifyOriginal(notifyOriginalPath) {
  return loadNotifyOriginal(notifyOriginalPath);
}

async function readCodexNotify(codexConfigPath) {
  return readNotify(codexConfigPath);
}

async function upsertEveryCodeNotify({
  codeConfigPath,
  notifyCmd,
  notifyOriginalPath,
  captureOriginal = true,
  replaceOriginal = false,
}) {
  return upsertNotify({
    configPath: codeConfigPath,
    notifyCmd,
    notifyOriginalPath,
    configLabel: "Every Code config",
    captureOriginal,
    replaceOriginal,
  });
}

async function restoreEveryCodeNotify({ codeConfigPath, notifyOriginalPath, notifyCmd }) {
  return restoreNotify({
    configPath: codeConfigPath,
    notifyOriginalPath,
    expectedNotify: notifyCmd,
  });
}

async function loadEveryCodeNotifyOriginal(notifyOriginalPath) {
  return loadNotifyOriginal(notifyOriginalPath);
}

async function readEveryCodeNotify(codeConfigPath) {
  return readNotify(codeConfigPath);
}

function extractNotify(text) {
  // Heuristic parse: find a line that starts with "notify =".
  // Supports single-line arrays:
  // - notify = ["a", "b"]
  // And multi-line arrays:
  // - notify = [
  //     "a",
  //     "b"
  //   ]
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^\s*notify\s*=\s*(.*)\s*$/);
    if (!m) continue;

    const rhs = (m[1] || "").trim();
    const literal = readTomlArrayLiteral(lines, i, rhs);
    if (!literal) continue;

    const parsed = parseTomlStringArray(literal);
    if (parsed) return parsed;
  }
  return null;
}

function setNotify(text, notifyCmd) {
  const lines = text.split(/\r?\n/);
  const notifyLine = `notify = ${formatTomlStringArray(notifyCmd)}`;

  const out = [];
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^\s*notify\s*=\s*(.*)\s*$/);
    if (m) {
      if (!replaced) {
        out.push(notifyLine);
        replaced = true;
      }

      const rhs = (m[1] || "").trim();
      i = findTomlArrayBlockEnd(lines, i, rhs);
      continue;
    }
    out.push(line);
  }

  if (!replaced) {
    // Insert at top-level, before the first table header.
    const firstTableIdx = out.findIndex((l) => /^\s*\[/.test(l));
    const headerIdx = firstTableIdx === -1 ? out.length : firstTableIdx;
    out.splice(headerIdx, 0, notifyLine);
  }

  return out.join("\n").replace(/\n+$/, "\n");
}

function removeNotify(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^\s*notify\s*=\s*(.*)\s*$/);
    if (m) {
      const rhs = (m[1] || "").trim();
      i = findTomlArrayBlockEnd(lines, i, rhs);
      continue;
    }
    out.push(line);
  }
  return out.join("\n").replace(/\n+$/, "\n");
}

function parseTomlStringArray(rhs) {
  // Minimal parser for TOML basic/literal string arrays.
  if (!rhs.startsWith("[") || !rhs.endsWith("]")) return null;
  const inner = rhs.slice(1, -1).trim();
  if (!inner) return [];

  const parts = [];
  let current = "";
  let inString = false;
  let quote = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (!inString) {
      if (ch === '"' || ch === "'") {
        inString = true;
        quote = ch;
        current = "";
      }
      continue;
    }
    if (ch === quote) {
      parts.push(current);
      inString = false;
      quote = null;
      continue;
    }
    if (quote === '"' && ch === "\\") {
      if (i + 1 >= inner.length) return null;
      const next = inner[++i];
      if (next === "b") current += "\b";
      else if (next === "t") current += "\t";
      else if (next === "n") current += "\n";
      else if (next === "f") current += "\f";
      else if (next === "r") current += "\r";
      else if (next === '"' || next === "\\" || next === "/") current += next;
      else return null;
      continue;
    }
    current += ch;
  }

  return parts.length > 0 ? parts : null;
}

function formatTomlStringArray(arr) {
  return `[${arr.map((s) => JSON.stringify(String(s))).join(", ")}]`;
}

function readTomlArrayLiteral(lines, startIndex, rhs) {
  const first = rhs.trim();
  if (!first.startsWith("[")) return null;

  let inString = false;
  let quote = null;
  let depth = 0;
  let sawOpen = false;

  function scanChunk(chunk) {
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];
      if (!inString) {
        if (ch === '"' || ch === "'") {
          inString = true;
          quote = ch;
          continue;
        }
        if (ch === "[") {
          depth += 1;
          sawOpen = true;
          continue;
        }
        if (ch === "]") {
          depth -= 1;
          if (sawOpen && depth === 0) return i;
        }
        continue;
      }
      if (ch === quote) {
        inString = false;
        quote = null;
        continue;
      }
      if (quote === '"' && ch === "\\") {
        i += 1;
      }
    }
    return -1;
  }

  const parts = [first];
  let endPos = scanChunk(first);
  if (endPos !== -1) return first.slice(0, endPos + 1).trim();

  for (let j = startIndex + 1; j < lines.length; j++) {
    const line = lines[j];
    endPos = scanChunk(line);
    if (endPos !== -1) {
      parts.push(line.slice(0, endPos + 1));
      return parts.join("\n").trim();
    }
    parts.push(line);
  }

  return null;
}

function findTomlArrayBlockEnd(lines, startIndex, rhs) {
  const first = rhs.trim();
  if (!first.startsWith("[")) return startIndex;

  let inString = false;
  let quote = null;
  let depth = 0;
  let sawOpen = false;

  function scanChunk(chunk) {
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];
      if (!inString) {
        if (ch === '"' || ch === "'") {
          inString = true;
          quote = ch;
          continue;
        }
        if (ch === "[") {
          depth += 1;
          sawOpen = true;
          continue;
        }
        if (ch === "]") {
          depth -= 1;
          if (sawOpen && depth === 0) return true;
        }
        continue;
      }
      if (ch === quote) {
        inString = false;
        quote = null;
        continue;
      }
      if (quote === '"' && ch === "\\") {
        i += 1;
      }
    }
    return false;
  }

  if (scanChunk(first)) return startIndex;
  for (let j = startIndex + 1; j < lines.length; j++) {
    if (scanChunk(lines[j])) return j;
  }
  return startIndex;
}

function arraysEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

module.exports = {
  upsertNotify,
  restoreNotify,
  loadNotifyOriginal,
  readNotify,
  upsertCodexNotify,
  restoreCodexNotify,
  loadCodexNotifyOriginal,
  readCodexNotify,
  upsertEveryCodeNotify,
  restoreEveryCodeNotify,
  loadEveryCodeNotifyOriginal,
  readEveryCodeNotify,
};
