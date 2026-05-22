const cp = require("node:child_process");
const fssync = require("node:fs");

const warnedSqliteReadFailures = new Set();

function isDebugEnabled(env = process.env) {
  const value = String((env && env.TOKENTRACKER_DEBUG) || "").toLowerCase();
  return value === "1" || value === "true";
}

function formatError(err) {
  if (!err) return "unknown error";
  return err && err.message ? err.message : String(err);
}

function warnSqliteUnavailable({ dbPath, label, cliError, nodeSqliteError, env, stderr }) {
  const key = `${label || "SQLite"}:${dbPath || ""}`;
  if (warnedSqliteReadFailures.has(key)) return;
  warnedSqliteReadFailures.add(key);

  const out = stderr && typeof stderr.write === "function" ? stderr : process.stderr;
  const displayLabel = label || "local";
  out.write(
    `[tokentracker] Cannot read ${displayLabel} SQLite database. Install sqlite3 CLI and add it to PATH, or use Node.js 22+ with node:sqlite support. Path: ${dbPath}\n`,
  );
  if (isDebugEnabled(env)) {
    out.write(`[tokentracker] sqlite3 CLI failed: ${formatError(cliError)}\n`);
    out.write(`[tokentracker] node:sqlite failed: ${formatError(nodeSqliteError)}\n`);
  }
}

function readSqliteRowsWithCli(dbPath, sql, { execFileSync, timeout, maxBuffer }) {
  const raw = execFileSync("sqlite3", ["-json", dbPath, sql], {
    encoding: "utf8",
    maxBuffer,
    timeout,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (!raw || !raw.trim()) return [];
  const rows = JSON.parse(raw);
  return Array.isArray(rows) ? rows : [];
}

function isSqliteCliUnavailable(err) {
  const message = formatError(err).toLowerCase();
  return (
    err?.code === "ENOENT" ||
    message.includes("spawn sqlite3 enoent") ||
    message.includes("sqlite3 enoent") ||
    message.includes("not recognized as an internal or external command")
  );
}

function isNodeSqliteUnavailable(err) {
  const message = formatError(err).toLowerCase();
  return (
    message.includes("no such built-in module") ||
    message.includes("cannot find module 'node:sqlite'") ||
    message.includes('cannot find module "node:sqlite"') ||
    message.includes("node:sqlite databasesync is unavailable")
  );
}

function readSqliteRowsWithNode(dbPath, sql, { requireFn }) {
  const { DatabaseSync } = requireFn("node:sqlite");
  if (typeof DatabaseSync !== "function") {
    throw new Error("node:sqlite DatabaseSync is unavailable");
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare(sql).all();
    return Array.isArray(rows) ? rows : [];
  } finally {
    db.close();
  }
}

function readSqliteJsonRows(dbPath, sql, options = {}) {
  if (!dbPath || !sql) return [];
  try {
    if (!fssync.existsSync(dbPath)) return [];
  } catch (_e) {
    return [];
  }
  const execFileSync = options.execFileSync || cp.execFileSync;
  const requireFn = options.requireFn || require;
  const env = options.env || process.env;
  const timeout = Number.isFinite(options.timeout) ? options.timeout : 30_000;
  const maxBuffer = Number.isFinite(options.maxBuffer) ? options.maxBuffer : 50 * 1024 * 1024;
  const label = options.label || "local";

  let cliError = null;
  try {
    return readSqliteRowsWithCli(dbPath, sql, { execFileSync, timeout, maxBuffer });
  } catch (err) {
    cliError = err;
  }

  let nodeSqliteError = null;
  try {
    return readSqliteRowsWithNode(dbPath, sql, { requireFn });
  } catch (err) {
    nodeSqliteError = err;
  }

  if (isSqliteCliUnavailable(cliError) && isNodeSqliteUnavailable(nodeSqliteError)) {
    warnSqliteUnavailable({
      dbPath,
      label,
      cliError,
      nodeSqliteError,
      env,
      stderr: options.stderr,
    });
  }
  return [];
}

function readSqliteFirstValue(dbPath, sql, column, options = {}) {
  const rows = readSqliteJsonRows(dbPath, sql, options);
  const row = rows[0];
  if (!row || typeof row !== "object") return null;
  const key = typeof column === "string" && column.length > 0 ? column : Object.keys(row)[0];
  const value = row[key];
  return typeof value === "string" ? value.trim() : value == null ? null : String(value).trim();
}

function resetSqliteReaderWarningsForTests() {
  warnedSqliteReadFailures.clear();
}

module.exports = {
  readSqliteJsonRows,
  readSqliteFirstValue,
  resetSqliteReaderWarningsForTests,
};
