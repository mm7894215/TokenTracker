const fs = require("node:fs/promises");
const path = require("node:path");

const { ensureDir, readJson, writeJson } = require("./fs");

const DEFAULT_EVENT = "SessionEnd";

async function upsertClaudeHook({ settingsPath, hookCommand, event = DEFAULT_EVENT }) {
  const existing = await readJson(settingsPath);
  const settings = normalizeSettings(existing);
  const hooks = normalizeHooks(settings.hooks);
  const entries = normalizeEntries(hooks[event]);

  const normalized = normalizeEntriesForCommand(entries, hookCommand);
  if (normalized.changed) {
    const nextHooks = { ...hooks, [event]: normalized.entries };
    const nextSettings = { ...settings, hooks: nextHooks };
    const backupPath = await writeClaudeSettings({ settingsPath, settings: nextSettings });
    return { changed: true, backupPath };
  }

  if (hasHook(entries, hookCommand)) {
    return { changed: false, backupPath: null };
  }

  const nextEntries = entries.concat([{ hooks: [{ type: "command", command: hookCommand }] }]);
  const nextHooks = { ...hooks, [event]: nextEntries };
  const nextSettings = { ...settings, hooks: nextHooks };

  const backupPath = await writeClaudeSettings({ settingsPath, settings: nextSettings });
  return { changed: true, backupPath };
}

async function removeClaudeHook({ settingsPath, hookCommand, event = DEFAULT_EVENT }) {
  const existing = await readJson(settingsPath);
  if (!existing) return { removed: false, skippedReason: "settings-missing" };

  const settings = normalizeSettings(existing);
  const hooks = normalizeHooks(settings.hooks);
  const entries = normalizeEntries(hooks[event]);
  if (entries.length === 0) return { removed: false, skippedReason: "hook-missing" };

  let removed = false;
  const nextEntries = [];
  for (const entry of entries) {
    const res = stripHookFromEntry(entry, hookCommand);
    if (res.removed) removed = true;
    if (res.entry) nextEntries.push(res.entry);
  }

  if (!removed) return { removed: false, skippedReason: "hook-missing" };

  const nextHooks = { ...hooks };
  if (nextEntries.length > 0) nextHooks[event] = nextEntries;
  else delete nextHooks[event];

  const nextSettings = { ...settings };
  if (Object.keys(nextHooks).length > 0) nextSettings.hooks = nextHooks;
  else delete nextSettings.hooks;

  const backupPath = await writeClaudeSettings({ settingsPath, settings: nextSettings });
  return { removed: true, skippedReason: null, backupPath };
}

async function isClaudeHookConfigured({ settingsPath, hookCommand, event = DEFAULT_EVENT }) {
  const settings = await readJson(settingsPath);
  if (!settings || typeof settings !== "object") return false;
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== "object") return false;
  const entries = normalizeEntries(hooks[event]);
  return hasHook(entries, hookCommand);
}

// Generic Session-hook command builder. CodeBuddy CLI is a Claude-Code fork
// and uses the exact same settings.json hook schema, so this function works
// for any source that accepts the `node notify.cjs --source=<name>` contract.
function buildHookCommand(notifyPath, source) {
  const cmd = typeof notifyPath === "string" ? notifyPath : "";
  const src = typeof source === "string" && source ? source : "claude";
  return `/usr/bin/env node ${quoteArg(cmd)} --source=${src}`;
}

function buildClaudeHookCommand(notifyPath) {
  return buildHookCommand(notifyPath, "claude");
}

function normalizeSettings(raw) {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

function normalizeHooks(raw) {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

function normalizeEntries(raw) {
  return Array.isArray(raw) ? raw.slice() : [];
}

function normalizeCommand(cmd) {
  if (Array.isArray(cmd)) return cmd.map((v) => String(v)).join("\u0000");
  if (typeof cmd === "string") return cmd.trim();
  return null;
}

function hasHook(entries, hookCommand) {
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.command && commandsEqual(entry.command, hookCommand)) return true;
    const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
    for (const hook of hooks) {
      if (hook && commandsEqual(hook.command, hookCommand)) return true;
    }
  }
  return false;
}

function stripHookFromEntry(entry, hookCommand) {
  if (!entry || typeof entry !== "object") return { entry, removed: false };

  if (entry.command) {
    if (commandsEqual(entry.command, hookCommand)) return { entry: null, removed: true };
    return { entry, removed: false };
  }

  const hooks = Array.isArray(entry.hooks) ? entry.hooks : null;
  if (!hooks) return { entry, removed: false };

  const nextHooks = hooks.filter((hook) => !commandsEqual(hook?.command, hookCommand));
  if (nextHooks.length === hooks.length) return { entry, removed: false };
  if (nextHooks.length === 0) return { entry: null, removed: true };

  return { entry: { ...entry, hooks: nextHooks }, removed: true };
}

function normalizeEntriesForCommand(entries, hookCommand) {
  let changed = false;
  const nextEntries = entries.map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    if (entry.command && commandsEqual(entry.command, hookCommand)) {
      if (entry.type !== "command") {
        changed = true;
        return { ...entry, type: "command" };
      }
      return entry;
    }
    if (!Array.isArray(entry.hooks)) return entry;
    let hooksChanged = false;
    const nextHooks = entry.hooks.map((hook) => {
      if (hook && commandsEqual(hook.command, hookCommand)) {
        if (hook.type !== "command") {
          hooksChanged = true;
          return { ...hook, type: "command" };
        }
      }
      return hook;
    });
    if (!hooksChanged) return entry;
    changed = true;
    return { ...entry, hooks: nextHooks };
  });
  return { entries: nextEntries, changed };
}

function commandsEqual(a, b) {
  const left = normalizeCommand(a);
  const right = normalizeCommand(b);
  return Boolean(left && right && left === right);
}

function quoteArg(value) {
  const v = typeof value === "string" ? value : "";
  if (!v) return '""';
  if (/^[A-Za-z0-9_\-./:@]+$/.test(v)) return v;
  return `"${v.replace(/"/g, '\\"')}"`;
}

async function writeClaudeSettings({ settingsPath, settings }) {
  await ensureDir(path.dirname(settingsPath));
  let backupPath = null;
  try {
    const st = await fs.stat(settingsPath);
    if (st && st.isFile()) {
      backupPath = `${settingsPath}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`;
      await fs.copyFile(settingsPath, backupPath);
    }
  } catch (_e) {
    // Ignore missing file.
  }
  await writeJson(settingsPath, settings);
  return backupPath;
}

module.exports = {
  upsertClaudeHook,
  removeClaudeHook,
  isClaudeHookConfigured,
  buildClaudeHookCommand,
  buildHookCommand,
  // Aliases for callers that want a name unbiased toward Claude (the schema
  // applies equally to CodeBuddy and any future Claude-Code fork).
  upsertSessionHook: upsertClaudeHook,
  removeSessionHook: removeClaudeHook,
  isSessionHookConfigured: isClaudeHookConfigured,
};
