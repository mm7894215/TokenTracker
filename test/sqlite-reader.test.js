const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  readSqliteFirstValue,
  readSqliteJsonRows,
  resetSqliteReaderWarningsForTests,
} = require("../src/lib/sqlite-reader");

function tempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-sqlite-reader-"));
  const dbPath = path.join(dir, "state.db");
  fs.writeFileSync(dbPath, "", "utf8");
  return dbPath;
}

test("readSqliteJsonRows uses sqlite3 CLI first", () => {
  const dbPath = tempDbPath();
  const rows = readSqliteJsonRows(dbPath, "SELECT 1 AS n", {
    execFileSync(cmd, args) {
      assert.equal(cmd, "sqlite3");
      assert.deepEqual(args, ["-json", dbPath, "SELECT 1 AS n"]);
      return JSON.stringify([{ n: 1 }]);
    },
    requireFn() {
      throw new Error("node:sqlite should not be used");
    },
  });

  assert.deepEqual(rows, [{ n: 1 }]);
});

test("readSqliteJsonRows falls back to node:sqlite when sqlite3 CLI fails", () => {
  const dbPath = tempDbPath();
  let closed = false;
  const rows = readSqliteJsonRows(dbPath, "SELECT 2 AS n", {
    execFileSync() {
      throw new Error("spawn sqlite3 ENOENT");
    },
    requireFn(name) {
      assert.equal(name, "node:sqlite");
      return {
        DatabaseSync: class FakeDatabaseSync {
          constructor(actualDbPath, options) {
            assert.equal(actualDbPath, dbPath);
            assert.deepEqual(options, { readOnly: true });
          }

          prepare(sql) {
            assert.equal(sql, "SELECT 2 AS n");
            return {
              all() {
                return [{ n: 2 }];
              },
            };
          }

          close() {
            closed = true;
          }
        },
      };
    },
  });

  assert.deepEqual(rows, [{ n: 2 }]);
  assert.equal(closed, true);
});

test("readSqliteJsonRows warns once when no sqlite reader works", () => {
  resetSqliteReaderWarningsForTests();
  const dbPath = tempDbPath();
  let stderr = "";
  const options = {
    label: "OpenCode",
    env: {},
    stderr: { write(chunk) { stderr += chunk; } },
    execFileSync() {
      throw new Error("spawn sqlite3 ENOENT");
    },
    requireFn() {
      throw new Error("No such built-in module: node:sqlite");
    },
  };

  assert.deepEqual(readSqliteJsonRows(dbPath, "SELECT 1", options), []);
  assert.deepEqual(readSqliteJsonRows(dbPath, "SELECT 1", options), []);

  const matches = stderr.match(/Cannot read OpenCode SQLite database/g) || [];
  assert.equal(matches.length, 1);
  assert.match(stderr, /Install sqlite3 CLI/);
  assert.match(stderr, /Node\.js 22\+/);
});

test("readSqliteJsonRows includes low-level errors in debug mode", () => {
  resetSqliteReaderWarningsForTests();
  const dbPath = tempDbPath();
  let stderr = "";

  readSqliteJsonRows(dbPath, "SELECT 1", {
    label: "Kiro CLI",
    env: { TOKENTRACKER_DEBUG: "1" },
    stderr: { write(chunk) { stderr += chunk; } },
    execFileSync() {
      throw new Error("spawn sqlite3 ENOENT");
    },
    requireFn() {
      throw new Error("No such built-in module: node:sqlite");
    },
  });

  assert.match(stderr, /sqlite3 CLI failed: spawn sqlite3 ENOENT/);
  assert.match(stderr, /node:sqlite failed: No such built-in module: node:sqlite/);
});

test("readSqliteJsonRows stays quiet for query/schema failures", () => {
  resetSqliteReaderWarningsForTests();
  const dbPath = tempDbPath();
  let stderr = "";

  const rows = readSqliteJsonRows(dbPath, "SELECT value FROM MissingTable", {
    label: "Cursor",
    env: { TOKENTRACKER_DEBUG: "1" },
    stderr: { write(chunk) { stderr += chunk; } },
    execFileSync() {
      throw new Error("Parse error: no such table: MissingTable");
    },
    requireFn() {
      throw new Error("no such table: MissingTable");
    },
  });

  assert.deepEqual(rows, []);
  assert.equal(stderr, "");
});

test("readSqliteFirstValue trims string values and closes node:sqlite DB", () => {
  const dbPath = tempDbPath();
  let closed = false;
  const value = readSqliteFirstValue(dbPath, "SELECT value FROM ItemTable", "value", {
    execFileSync() {
      throw new Error("spawn sqlite3 ENOENT");
    },
    requireFn() {
      return {
        DatabaseSync: class FakeDatabaseSync {
          prepare() {
            return {
              all() {
                return [{ value: " token\n" }];
              },
            };
          }

          close() {
            closed = true;
          }
        },
      };
    },
  });

  assert.equal(value, "token");
  assert.equal(closed, true);
});
