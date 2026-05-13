const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it } = require("node:test");

const {
  parseCursorCsv,
  isCursorBillableKind,
  normalizeCursorUsage,
  isCursorInstalled,
  readCursorAccessTokenFromStateDb,
  extractCursorSessionToken,
  resolveCursorPaths,
} = require("../src/lib/cursor-config");

function makeCursorJwt(userId = "user_TEST123") {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: `auth0|${userId}` })).toString("base64url");
  return `${header}.${payload}.sig`;
}

// ── parseCursorCsv — new format ──

describe("parseCursorCsv — new format", () => {
  const csvText = `Date,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost
"2026-03-20T06:56:12.521Z","Included","composer-2-fast","No","160000","159990","578207","2055","740252","0.49"
"2026-03-19T10:00:00.000Z","Included","claude-4.6-sonnet-medium-thinking","Yes","50000","40000","10000","3000","103000","0.32"`;

  it("returns 2 records", () => {
    const records = parseCursorCsv(csvText);
    assert.equal(records.length, 2);
  });

  it("extracts fields correctly for the first record", () => {
    const records = parseCursorCsv(csvText);
    const r = records[0];
    assert.equal(r.date, "2026-03-20T06:56:12.521Z");
    assert.equal(r.model, "composer-2-fast");
    assert.equal(r.kind, "Included");
    assert.equal(r.maxMode, "No");
    assert.equal(r.inputTokens, 159990);
    assert.equal(r.cacheWriteTokens, 10); // 160000 - 159990
    assert.equal(r.cacheReadTokens, 578207);
    assert.equal(r.outputTokens, 2055);
    assert.equal(r.totalTokens, 740252);
    assert.equal(r.cost, 0.49);
  });

  it("extracts fields correctly for the second record", () => {
    const records = parseCursorCsv(csvText);
    const r = records[1];
    assert.equal(r.date, "2026-03-19T10:00:00.000Z");
    assert.equal(r.model, "claude-4.6-sonnet-medium-thinking");
    assert.equal(r.maxMode, "Yes");
    assert.equal(r.inputTokens, 40000);
    assert.equal(r.cacheWriteTokens, 10000); // 50000 - 40000
    assert.equal(r.cacheReadTokens, 10000);
    assert.equal(r.outputTokens, 3000);
    assert.equal(r.totalTokens, 103000);
    assert.equal(r.cost, 0.32);
  });
});

// ── parseCursorCsv — newest format with Cloud Agent ID / Automation ID ──

describe("parseCursorCsv — with Cloud Agent ID columns", () => {
  const csvText = `Date,Cloud Agent ID,Automation ID,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost
"2026-04-16T03:32:33.284Z","","","On-Demand","composer-2-fast","No","0","3189","194368","1815","199372","0.11"
"2026-04-15T03:39:53.013Z","","","On-Demand","auto","No","0","132586","93728","2303","228617","0.20"`;

  it("resolves model by header name, not fixed index", () => {
    const records = parseCursorCsv(csvText);
    assert.equal(records.length, 2);
    assert.equal(records[0].model, "composer-2-fast");
    assert.equal(records[0].kind, "On-Demand");
    assert.equal(records[0].inputTokens, 3189);
    assert.equal(records[0].cacheReadTokens, 194368);
    assert.equal(records[0].outputTokens, 1815);
    assert.equal(records[0].totalTokens, 199372);
    assert.equal(records[0].sourceScope, "account");
    assert.equal(records[0].billableKind, "billable");
    assert.equal(records[1].model, "auto");
  });
});

describe("Cursor billing kind classification", () => {
  it("treats included and on-demand usage as billable-ish", () => {
    assert.equal(isCursorBillableKind("Included"), true);
    assert.equal(isCursorBillableKind("On-Demand"), true);
  });

  it("treats free and no-charge errored usage as non-billable", () => {
    assert.equal(isCursorBillableKind("Free"), false);
    assert.equal(isCursorBillableKind("Errored, No Charge"), false);
  });
});

// ── parseCursorCsv — old format ──

describe("parseCursorCsv — old format", () => {
  const csvText = `Date,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost,Cost to you
2025-02-01,gpt-4o,1000,500,200,300,2000,$0.10,$0.10`;

  it("parses old format correctly", () => {
    const records = parseCursorCsv(csvText);
    assert.equal(records.length, 1);
    const r = records[0];
    assert.equal(r.date, "2025-02-01");
    assert.equal(r.model, "gpt-4o");
    assert.equal(r.kind, "unknown");
    assert.equal(r.maxMode, "No");
    assert.equal(r.inputTokens, 500);
    assert.equal(r.cacheWriteTokens, 500); // 1000 - 500
    assert.equal(r.cacheReadTokens, 200);
    assert.equal(r.outputTokens, 300);
    assert.equal(r.totalTokens, 2000);
    assert.equal(r.cost, 0.1);
  });
});

// ── parseCursorCsv — empty/invalid ──

describe("parseCursorCsv — empty/invalid", () => {
  it("returns [] for empty string", () => {
    assert.deepStrictEqual(parseCursorCsv(""), []);
  });

  it("returns [] for header only", () => {
    const csv = "Date,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost";
    assert.deepStrictEqual(parseCursorCsv(csv), []);
  });
});

// ── normalizeCursorUsage ──

describe("normalizeCursorUsage", () => {
  it("produces standard format output", () => {
    const record = {
      inputTokens: 1000,
      cacheWriteTokens: 200,
      cacheReadTokens: 300,
      outputTokens: 500,
    };
    const norm = normalizeCursorUsage(record);
    assert.equal(norm.input_tokens, 1000);
    assert.equal(norm.cached_input_tokens, 300);
    assert.equal(norm.cache_creation_input_tokens, 200);
    assert.equal(norm.output_tokens, 500);
    assert.equal(norm.reasoning_output_tokens, 0);
    // total = input + output + cacheWrite + cacheRead = 1000 + 500 + 200 + 300
    assert.equal(norm.total_tokens, 2000);
  });
});

// ── normalizeCursorUsage — edge cases ──

describe("normalizeCursorUsage — edge cases", () => {
  it("all zeros produce all zeros", () => {
    const norm = normalizeCursorUsage({
      inputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
    });
    assert.equal(norm.input_tokens, 0);
    assert.equal(norm.cached_input_tokens, 0);
    assert.equal(norm.cache_creation_input_tokens, 0);
    assert.equal(norm.output_tokens, 0);
    assert.equal(norm.total_tokens, 0);
  });

  it("missing fields default to 0", () => {
    const norm = normalizeCursorUsage({});
    assert.equal(norm.input_tokens, 0);
    assert.equal(norm.cached_input_tokens, 0);
    assert.equal(norm.cache_creation_input_tokens, 0);
    assert.equal(norm.output_tokens, 0);
    assert.equal(norm.total_tokens, 0);
  });

  it("negative values are clamped to 0", () => {
    const norm = normalizeCursorUsage({
      inputTokens: -100,
      cacheWriteTokens: -50,
      cacheReadTokens: -30,
      outputTokens: -10,
    });
    assert.equal(norm.input_tokens, 0);
    assert.equal(norm.cached_input_tokens, 0);
    assert.equal(norm.cache_creation_input_tokens, 0);
    assert.equal(norm.output_tokens, 0);
    assert.equal(norm.total_tokens, 0);
  });
});

// ── resolveCursorPaths ──

describe("resolveCursorPaths", () => {
  it("uses ~/Library/Application Support/Cursor on macOS", () => {
    const { appDir, stateDbPath } = resolveCursorPaths({
      home: "/Users/alice",
      platform: "darwin",
      env: {},
    });
    assert.equal(appDir, "/Users/alice/Library/Application Support/Cursor");
    assert.equal(
      stateDbPath,
      "/Users/alice/Library/Application Support/Cursor/User/globalStorage/state.vscdb",
    );
  });

  it("uses %APPDATA%\\Cursor on Windows when APPDATA is set", () => {
    const { appDir } = resolveCursorPaths({
      home: "C:\\Users\\alice",
      platform: "win32",
      env: { APPDATA: "C:\\Users\\alice\\AppData\\Roaming" },
    });
    // path.join uses the host separator; just check the suffix
    assert.ok(
      appDir.endsWith("Cursor"),
      `expected appDir to end with Cursor, got ${appDir}`,
    );
    assert.ok(
      appDir.includes("AppData") && appDir.includes("Roaming"),
      `expected AppData/Roaming in path, got ${appDir}`,
    );
  });

  it("falls back to <home>/AppData/Roaming/Cursor on Windows when APPDATA is missing", () => {
    const { appDir } = resolveCursorPaths({
      home: "C:\\Users\\alice",
      platform: "win32",
      env: {},
    });
    assert.ok(
      appDir.includes("AppData") && appDir.includes("Roaming") && appDir.endsWith("Cursor"),
      `expected fallback AppData/Roaming/Cursor, got ${appDir}`,
    );
  });

  it("uses XDG_CONFIG_HOME on Linux when set", () => {
    const { appDir } = resolveCursorPaths({
      home: "/home/alice",
      platform: "linux",
      env: { XDG_CONFIG_HOME: "/home/alice/.cfg" },
    });
    assert.equal(appDir, "/home/alice/.cfg/Cursor");
  });

  it("falls back to ~/.config/Cursor on Linux", () => {
    const { appDir } = resolveCursorPaths({
      home: "/home/alice",
      platform: "linux",
      env: {},
    });
    assert.equal(appDir, "/home/alice/.config/Cursor");
  });

  it("keeps cliConfigPath at ~/.cursor/cli-config.json on every platform", () => {
    for (const platform of ["darwin", "win32", "linux"]) {
      const { cliConfigPath } = resolveCursorPaths({
        home: "/h",
        platform,
        env: { APPDATA: "C:\\AppData" },
      });
      assert.ok(
        cliConfigPath.endsWith("cli-config.json") && cliConfigPath.includes(".cursor"),
        `[${platform}] expected ~/.cursor/cli-config.json, got ${cliConfigPath}`,
      );
    }
  });
});

// ── isCursorInstalled ──

describe("isCursorInstalled", () => {
  it("returns a boolean", () => {
    const result = isCursorInstalled();
    assert.equal(typeof result, "boolean");
  });

  it("returns false when the resolved appDir does not exist (Windows)", () => {
    const result = isCursorInstalled({
      home: "/tmp/nonexistent-cursor-windows-home",
      platform: "win32",
      env: { APPDATA: "/tmp/nonexistent-cursor-appdata" },
    });
    assert.equal(result, false);
  });

  it("returns false when the resolved appDir does not exist (Linux)", () => {
    const result = isCursorInstalled({
      home: "/tmp/nonexistent-cursor-linux-home",
      platform: "linux",
      env: {},
    });
    assert.equal(result, false);
  });
});

// ── extractCursorSessionToken ──

describe("extractCursorSessionToken", () => {
  it("returns null for non-existent home dir", () => {
    const result = extractCursorSessionToken({ home: "/tmp/nonexistent-cursor-test-home" });
    assert.equal(result, null);
  });

  it("reads the Cursor access token via sqlite3 CLI", () => {
    const jwt = makeCursorJwt();
    const token = readCursorAccessTokenFromStateDb("/tmp/state.vscdb", {
      execFileSync: (cmd, args, opts) => {
        assert.equal(cmd, "sqlite3");
        assert.deepEqual(args, [
          "/tmp/state.vscdb",
          "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken';",
        ]);
        assert.equal(opts.encoding, "utf8");
        return `${jwt}\n`;
      },
      requireFn: () => {
        throw new Error("node:sqlite should not be used when sqlite3 works");
      },
      env: {},
    });

    assert.equal(token, jwt);
  });

  it("falls back to node:sqlite when sqlite3 CLI is unavailable", () => {
    const jwt = makeCursorJwt();
    let closed = false;
    const token = readCursorAccessTokenFromStateDb("C:\\Users\\alice\\state.vscdb", {
      execFileSync: () => {
        throw new Error("spawn sqlite3 ENOENT");
      },
      requireFn: (name) => {
        assert.equal(name, "node:sqlite");
        return {
          DatabaseSync: class FakeDatabaseSync {
            constructor(dbPath, options) {
              assert.equal(dbPath, "C:\\Users\\alice\\state.vscdb");
              assert.deepEqual(options, { readOnly: true });
            }

            prepare(sql) {
              assert.equal(sql, "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken';");
              return {
                get() {
                  return { value: ` ${jwt}\n` };
                },
              };
            }

            close() {
              closed = true;
            }
          },
        };
      },
      env: {},
    });

    assert.equal(token, jwt);
    assert.equal(closed, true);
  });

  it("returns null when neither sqlite reader can read the token", () => {
    const token = readCursorAccessTokenFromStateDb("/tmp/state.vscdb", {
      execFileSync: () => {
        throw new Error("spawn sqlite3 ENOENT");
      },
      requireFn: () => {
        throw new Error("No such built-in module: node:sqlite");
      },
      env: {},
    });

    assert.equal(token, null);
  });

  it("builds the Cursor cookie when token reading falls back to node:sqlite", () => {
    const jwt = makeCursorJwt("user_FALLBACK");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-cursor-home-"));
    const { stateDbPath } = resolveCursorPaths({ home });
    fs.mkdirSync(path.dirname(stateDbPath), { recursive: true });
    fs.writeFileSync(stateDbPath, "", "utf8");
    const result = extractCursorSessionToken({
      home,
      deps: {
        execFileSync: () => {
          throw new Error("spawn sqlite3 ENOENT");
        },
        requireFn: () => ({
          DatabaseSync: class FakeDatabaseSync {
            prepare() {
              return {
                get() {
                  return { value: jwt };
                },
              };
            }

            close() {}
          },
        }),
        env: {},
      },
    });

    assert.deepEqual(result, {
      cookie: `WorkosCursorSessionToken=user_FALLBACK%3A%3A${jwt}`,
      userId: "user_FALLBACK",
    });
  });
});
