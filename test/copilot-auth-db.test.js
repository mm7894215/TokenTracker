const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  readCopilotOauthToken,
  readCopilotAuthDbToken,
  decryptCopilotAuthDbToken,
} = require("../src/lib/usage-limits");

// Mirror copilot-language-server's auth.db scheme: AES-256-GCM with the
// ciphertext laid out as iv(12) ‖ ciphertext ‖ authTag(16), key base64-encoded.
function encryptToken(token, keyBuf) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyBuf, iv);
  const enc = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, enc, tag]);
}

function makeAuthDbFixture(token, { authority = "github.com" } = {}) {
  const keyBuf = crypto.randomBytes(32);
  const blob = encryptToken(token, keyBuf);
  return {
    keyBase64: keyBuf.toString("base64"),
    tokenHex: blob.toString("hex"),
    authority,
  };
}

describe("decryptCopilotAuthDbToken", () => {
  it("round-trips an AES-256-GCM token", () => {
    const { keyBase64, tokenHex } = makeAuthDbFixture("ghu_decrypted_example_token");
    assert.equal(decryptCopilotAuthDbToken(keyBase64, tokenHex), "ghu_decrypted_example_token");
  });

  it("returns null when the key is the wrong length (not AES-256)", () => {
    const { tokenHex } = makeAuthDbFixture("ghu_token");
    const shortKey = crypto.randomBytes(16).toString("base64");
    assert.equal(decryptCopilotAuthDbToken(shortKey, tokenHex), null);
  });

  it("returns null when the auth tag does not verify (tampered ciphertext)", () => {
    const { keyBase64, tokenHex } = makeAuthDbFixture("ghu_token");
    const tampered = Buffer.from(tokenHex, "hex");
    tampered[tampered.length - 1] ^= 0xff; // flip a tag byte
    assert.equal(decryptCopilotAuthDbToken(keyBase64, tampered.toString("hex")), null);
  });

  it("returns null on non-string input", () => {
    assert.equal(decryptCopilotAuthDbToken(null, null), null);
    assert.equal(decryptCopilotAuthDbToken(undefined, "00"), null);
  });
});

describe("readCopilotAuthDbToken", () => {
  const okRunner = (keyBase64) => () => ({ status: 0, stdout: keyBase64 });

  it("decrypts the token from auth.db via the keychain key (macOS)", () => {
    const { keyBase64, tokenHex } = makeAuthDbFixture("ghu_authdb_token");
    const token = readCopilotAuthDbToken({
      home: "/home/test",
      platform: "darwin",
      securityRunner: okRunner(keyBase64),
      sqliteReader: () => [{ auth_authority: "github.com", token_hex: tokenHex }],
    });
    assert.equal(token, "ghu_authdb_token");
  });

  it("prefers the public github.com row over a composite/enterprise row", () => {
    const enterprise = makeAuthDbFixture("ghu_enterprise", { authority: "github.example.com" });
    const publicHost = makeAuthDbFixture("ghu_public", { authority: "github.com" });
    // Both rows decrypt with their own key; the keychain returns the public one's key.
    const token = readCopilotAuthDbToken({
      home: "/home/test",
      platform: "darwin",
      securityRunner: okRunner(publicHost.keyBase64),
      sqliteReader: () => [
        { auth_authority: "github.example.com", token_hex: enterprise.tokenHex },
        { auth_authority: "github.com", token_hex: publicHost.tokenHex },
      ],
    });
    assert.equal(token, "ghu_public");
  });

  it("returns null on non-darwin platforms (no keychain reader yet)", () => {
    const { keyBase64, tokenHex } = makeAuthDbFixture("ghu_token");
    let readerCalled = false;
    const token = readCopilotAuthDbToken({
      home: "/home/test",
      platform: "linux",
      securityRunner: okRunner(keyBase64),
      sqliteReader: () => {
        readerCalled = true;
        return [{ auth_authority: "github.com", token_hex: tokenHex }];
      },
    });
    assert.equal(token, null);
    assert.equal(readerCalled, false);
  });

  it("returns null when the keychain key is unavailable", () => {
    const { tokenHex } = makeAuthDbFixture("ghu_token");
    const token = readCopilotAuthDbToken({
      home: "/home/test",
      platform: "darwin",
      securityRunner: () => ({ status: 1, stdout: "" }),
      sqliteReader: () => [{ auth_authority: "github.com", token_hex: tokenHex }],
    });
    assert.equal(token, null);
  });

  it("returns null when auth.db has no token rows", () => {
    const token = readCopilotAuthDbToken({
      home: "/home/test",
      platform: "darwin",
      securityRunner: okRunner("AAAA"),
      sqliteReader: () => [],
    });
    assert.equal(token, null);
  });
});

describe("readCopilotOauthToken precedence", () => {
  it("returns the plaintext apps.json token without consulting auth.db", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-copilot-"));
    try {
      const dir = path.join(tmp, ".config", "github-copilot");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "apps.json"),
        JSON.stringify({
          "github.com:Iv1.b507a08c87ecfe98": { user: "octocat", oauth_token: "ghu_plaintext_token" },
        }),
      );
      const token = readCopilotOauthToken({
        home: tmp,
        platform: "darwin",
        // Would throw if the encrypted fallback were consulted.
        securityRunner: () => {
          throw new Error("keychain should not be read when plaintext exists");
        },
        sqliteReader: () => {
          throw new Error("auth.db should not be read when plaintext exists");
        },
      });
      assert.equal(token, "ghu_plaintext_token");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("falls back to the encrypted auth.db when no plaintext token exists", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-copilot-"));
    try {
      const { keyBase64, tokenHex } = makeAuthDbFixture("ghu_fallback_token");
      const token = readCopilotOauthToken({
        home: tmp, // no apps.json / hosts.json present
        platform: "darwin",
        securityRunner: () => ({ status: 0, stdout: keyBase64 }),
        sqliteReader: () => [{ auth_authority: "github.com", token_hex: tokenHex }],
      });
      assert.equal(token, "ghu_fallback_token");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns null when there is neither a plaintext nor an encrypted token", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-copilot-"));
    try {
      const token = readCopilotOauthToken({
        home: tmp,
        platform: "linux",
        securityRunner: () => ({ status: 1, stdout: "" }),
        sqliteReader: () => [],
      });
      assert.equal(token, null);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
