const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  readConfig,
  parseWindowUsage,
  parseDataSlotFormat,
  parseHumanReadableTime,
  buildWindow,
  extractWindows,
  fetchOpencodeGoLimits,
} = require("../src/lib/opencode-go-limits");

// Real SolidStart hydration snippet shape captured from
// https://opencode.ai/workspace/<id>/go (slkiser/opencode-quota PR #41).
function ssrHtml() {
  return `
    <html><body>
    <script>self.__next_f.push([1,"rollingUsage:$R[3]={usagePercent:42,resetInSec:12345}"])</script>
    <script>self.__next_f.push([1,"weeklyUsage:$R[4]={usagePercent:18,resetInSec:678901}"])</script>
    <script>self.__next_f.push([1,"monthlyUsage:$R[5]={usagePercent:7,resetInSec:2592000}"])</script>
    </body></html>
  `;
}

// Reset-first field order — solid hydration order can vary per build.
function ssrHtmlResetFirst() {
  return `
    <html><body>
    <script>self.__next_f.push([1,"monthlyUsage:$R[5]={resetInSec:2592000,usagePercent:7}"])</script>
    </body></html>
  `;
}

// Newer HTML format that uses data-slot attrs (no SSR hydration output).
function dataSlotHtml() {
  return `
    <html><body>
    <div data-slot="usage-item">
      <span data-slot="usage-label">Rolling Usage</span>
      <span data-slot="usage-value">42%</span>
      <span data-slot="reset-time">Resets in 3 hours 25 minutes</span>
    </div>
    <div data-slot="usage-item">
      <span data-slot="usage-label">Weekly Usage</span>
      <span data-slot="usage-value">18%</span>
      <span data-slot="reset-time">Resets in 2 days 4 hours</span>
    </div>
    <div data-slot="usage-item">
      <span data-slot="usage-label">Monthly Usage</span>
      <span data-slot="usage-value">7%</span>
      <span data-slot="reset-now"></span>
    </div>
    </body></html>
  `;
}

describe("readConfig", () => {
  it("returns null when env is missing one of the two vars", () => {
    assert.equal(readConfig({ OPENCODE_GO_WORKSPACE_ID: "wrk_1" }), null);
    assert.equal(readConfig({ OPENCODE_GO_AUTH_COOKIE: "cookie" }), null);
    assert.equal(readConfig({}), null);
    assert.equal(readConfig(null), null);
  });
  it("returns the trimmed values when both vars are present", () => {
    const out = readConfig({
      OPENCODE_GO_WORKSPACE_ID: "  wrk_1  ",
      OPENCODE_GO_AUTH_COOKIE: "  cookie  ",
    });
    assert.deepEqual(out, { workspaceId: "wrk_1", authCookie: "cookie" });
  });
  it("ignores non-string values", () => {
    assert.equal(
      readConfig({ OPENCODE_GO_WORKSPACE_ID: 123, OPENCODE_GO_AUTH_COOKIE: "c" }),
      null,
    );
  });
});

describe("parseHumanReadableTime", () => {
  it("parses day/hour/minute/second combinations", () => {
    assert.equal(parseHumanReadableTime("3 hours 25 minutes"), 3 * 3600 + 25 * 60);
    assert.equal(parseHumanReadableTime("2 days 4 hours"), 2 * 86400 + 4 * 3600);
    assert.equal(parseHumanReadableTime("45 seconds"), 45);
    assert.equal(parseHumanReadableTime("1 day 2 hours 3 minutes 4 seconds"), 86400 + 7200 + 180 + 4);
  });
  it("returns 0 for reset-now aliases", () => {
    assert.equal(parseHumanReadableTime("now"), 0);
    assert.equal(parseHumanReadableTime("Reset now"), 0);
    assert.equal(parseHumanReadableTime("reset-now"), 0);
  });
  it("returns null when no duration is present", () => {
    assert.equal(parseHumanReadableTime(""), null);
    assert.equal(parseHumanReadableTime("hello world"), null);
    assert.equal(parseHumanReadableTime(null), null);
  });
});

describe("parseWindowUsage", () => {
  const reRolling = /rollingUsage:\$R\[\d+\]=\{[^}]*usagePercent:(-?\d+(?:\.\d+)?)[^}]*resetInSec:(-?\d+(?:\.\d+)?)[^}]*\}/;
  const reResetFirst = /rollingUsage:\$R\[\d+\]=\{[^}]*resetInSec:(-?\d+(?:\.\d+)?)[^}]*usagePercent:(-?\d+(?:\.\d+)?)[^}]*\}/;
  // Pct-first + reset-first pair for monthly (used to test the reset-first fixture).
  const reMonthlyPctFirst = /monthlyUsage:\$R\[\d+\]=\{[^}]*usagePercent:(-?\d+(?:\.\d+)?)[^}]*resetInSec:(-?\d+(?:\.\d+)?)[^}]*\}/;
  const reMonthlyResetFirst = /monthlyUsage:\$R\[\d+\]=\{[^}]*resetInSec:(-?\d+(?:\.\d+)?)[^}]*usagePercent:(-?\d+(?:\.\d+)?)[^}]*\}/;
  it("extracts usage + reset from the pct-first ordering", () => {
    const out = parseWindowUsage(ssrHtml(), reRolling, reResetFirst);
    assert.deepEqual(out, { usagePercent: 42, resetInSec: 12345 });
  });
  it("extracts usage + reset from the reset-first ordering", () => {
    const out = parseWindowUsage(ssrHtmlResetFirst(), reMonthlyPctFirst, reMonthlyResetFirst);
    assert.deepEqual(out, { usagePercent: 7, resetInSec: 2592000 });
  });
  it("returns null when neither ordering is present", () => {
    const out = parseWindowUsage("<html>nope</html>", reRolling, reResetFirst);
    assert.equal(out, null);
  });
});

describe("buildWindow", () => {
  it("clamps usage_percent to [0, 100] and emits an ISO reset_at", () => {
    const nowMs = 1_700_000_000_000;
    assert.deepEqual(buildWindow({ usagePercent: 42, resetInSec: 60, nowMs }), {
      used_percent: 42,
      reset_at: new Date(nowMs + 60_000).toISOString(),
    });
    assert.deepEqual(buildWindow({ usagePercent: -5, resetInSec: 0, nowMs }), {
      used_percent: 0,
      reset_at: new Date(nowMs).toISOString(),
    });
    assert.deepEqual(buildWindow({ usagePercent: 250, resetInSec: 0, nowMs }), {
      used_percent: 100,
      reset_at: new Date(nowMs).toISOString(),
    });
  });
  it("returns null for invalid percent or resetInSec", () => {
    assert.equal(buildWindow({ usagePercent: null, resetInSec: 1, nowMs: 0 }), null);
    assert.equal(buildWindow({ usagePercent: 1, resetInSec: -1, nowMs: 0 }), null);
    assert.equal(buildWindow({ usagePercent: 1, resetInSec: NaN, nowMs: 0 }), null);
  });
});

describe("parseDataSlotFormat", () => {
  it("extracts three windows from the data-slot HTML fallback", () => {
    const out = parseDataSlotFormat(dataSlotHtml());
    assert.equal(out.rolling?.usagePercent, 42);
    assert.equal(out.rolling?.resetInSec, 3 * 3600 + 25 * 60);
    assert.equal(out.weekly?.usagePercent, 18);
    assert.equal(out.monthly?.usagePercent, 7);
    assert.equal(out.monthly?.resetInSec, 0);
  });
  it("returns an empty object when no usage-items are present", () => {
    assert.deepEqual(parseDataSlotFormat("<html></html>"), {});
  });
});

describe("extractWindows", () => {
  it("prefers SSR hydration output and builds three ISO windows", () => {
    const nowMs = 1_700_000_000_000;
    const out = extractWindows(ssrHtml(), nowMs);
    assert.equal(out.rolling?.used_percent, 42);
    assert.equal(out.weekly?.used_percent, 18);
    assert.equal(out.monthly?.used_percent, 7);
    assert.equal(out.rolling?.reset_at, new Date(nowMs + 12345_000).toISOString());
    assert.equal(out.monthly?.reset_at, new Date(nowMs + 2592000_000).toISOString());
  });
  it("falls back to data-slot parsing when SSR is absent", () => {
    const nowMs = 1_700_000_000_000;
    const out = extractWindows(dataSlotHtml(), nowMs);
    assert.equal(out.rolling?.used_percent, 42);
    assert.equal(out.weekly?.used_percent, 18);
    assert.equal(out.monthly?.used_percent, 7);
  });
  it("returns three nulls when neither parser matches", () => {
    const out = extractWindows("<html>nope</html>", 0);
    assert.equal(out.rolling, null);
    assert.equal(out.weekly, null);
    assert.equal(out.monthly, null);
  });
  it("returns only the windows that successfully parse", () => {
    const partial = `<script>self.__next_f.push([1,"rollingUsage:$R[3]={usagePercent:42,resetInSec:60}"])</script>`;
    const out = extractWindows(partial, 0);
    assert.equal(out.rolling?.used_percent, 42);
    assert.equal(out.weekly, null);
    assert.equal(out.monthly, null);
  });
});

describe("fetchOpencodeGoLimits", () => {
  const cfg = { OPENCODE_GO_WORKSPACE_ID: "wrk_01", OPENCODE_GO_AUTH_COOKIE: "cookie" };

  function jsonResponse(status, body) {
    return {
      status,
      ok: status >= 200 && status < 300,
      async text() {
        return typeof body === "string" ? body : JSON.stringify(body);
      },
    };
  }

  it("returns { configured: false } when env is missing", async () => {
    const out = await fetchOpencodeGoLimits({ env: {}, fetchImpl: async () => jsonResponse(200, "") });
    assert.deepEqual(out, { configured: false });
  });

  it("returns the three windows on a 200 SSR-hydration response", async () => {
    let capturedUrl = null;
    let capturedInit = null;
    const fetchImpl = async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return jsonResponse(200, ssrHtml());
    };
    const out = await fetchOpencodeGoLimits({ env: cfg, fetchImpl, nowMs: 1_700_000_000_000 });
    assert.equal(out.configured, true);
    assert.equal(out.error, null);
    assert.equal(out.plan_label, undefined, "no plan_label — the brand 'OpenCode Go' is the row title");
    assert.equal(out.primary_window?.used_percent, 42);
    assert.equal(out.secondary_window?.used_percent, 18);
    assert.equal(out.tertiary_window?.used_percent, 7);
    assert.equal(
      capturedUrl,
      "https://opencode.ai/workspace/wrk_01/go",
      "URL must be the public Go dashboard",
    );
    assert.equal(
      capturedInit.headers.Cookie,
      "auth=cookie",
      "Cookie is sent verbatim as `auth=<value>` per slkiser/opencode-quota#41",
    );
    assert.match(capturedInit.headers["User-Agent"], /Mozilla/);
  });

  it("falls back to data-slot HTML when SSR hydration is absent", async () => {
    const fetchImpl = async () => jsonResponse(200, dataSlotHtml());
    const out = await fetchOpencodeGoLimits({ env: cfg, fetchImpl, nowMs: 1_700_000_000_000 });
    assert.equal(out.configured, true);
    assert.equal(out.error, null);
    assert.equal(out.primary_window?.used_percent, 42);
    assert.equal(out.tertiary_window?.used_percent, 7);
  });

  it("fills each missing window from the HTML fallback (per-window, not all-or-nothing)", async () => {
    // SSR exposes rolling + weekly but drops monthly; the rendered HTML still
    // carries all three data-slot items. The fallback must recover monthly
    // without clobbering the two SSR values.
    const partial = `
      <html><body>
      <script>self.__next_f.push([1,"rollingUsage:$R[3]={usagePercent:42,resetInSec:60}"])</script>
      <script>self.__next_f.push([1,"weeklyUsage:$R[4]={usagePercent:18,resetInSec:600}"])</script>
      <div data-slot="usage-item">
        <span data-slot="usage-label">Rolling Usage</span>
        <span data-slot="usage-value">99%</span>
        <span data-slot="reset-time">Resets in 1 hours</span>
      </div>
      <div data-slot="usage-item">
        <span data-slot="usage-label">Weekly Usage</span>
        <span data-slot="usage-value">99%</span>
        <span data-slot="reset-time">Resets in 1 hours</span>
      </div>
      <div data-slot="usage-item">
        <span data-slot="usage-label">Monthly Usage</span>
        <span data-slot="usage-value">77%</span>
        <span data-slot="reset-time">Resets in 1 hours</span>
      </div>
      </body></html>
    `;
    const fetchImpl = async () => jsonResponse(200, partial);
    const out = await fetchOpencodeGoLimits({ env: cfg, fetchImpl, nowMs: 1_700_000_000_000 });
    assert.equal(out.configured, true);
    // SSR values preserved (42, 18) even though the data-slot block would say 99%.
    assert.equal(out.primary_window?.used_percent, 42);
    assert.equal(out.secondary_window?.used_percent, 18);
    // Monthly recovered from the HTML fallback.
    assert.equal(out.tertiary_window?.used_percent, 77);
  });

  it("surfaces 401/403 as a re-auth error", async () => {
    const fetchImpl = async () => jsonResponse(401, "login");
    const out = await fetchOpencodeGoLimits({ env: cfg, fetchImpl });
    assert.equal(out.configured, true);
    assert.match(out.error, /Not signed in to OpenCode Go/);
  });

  it("surfaces 5xx as a generic error", async () => {
    const fetchImpl = async () => jsonResponse(503, "down");
    const out = await fetchOpencodeGoLimits({ env: cfg, fetchImpl });
    assert.equal(out.configured, true);
    assert.match(out.error, /503/);
  });

  it("surfaces a parse error when the dashboard HTML has no known windows", async () => {
    const fetchImpl = async () => jsonResponse(200, "<html>oops totally different</html>");
    const out = await fetchOpencodeGoLimits({ env: cfg, fetchImpl });
    assert.equal(out.configured, true);
    assert.match(out.error, /Could not parse any known OpenCode Go dashboard usage windows/);
  });

  it("surfaces network errors as a configured error", async () => {
    const fetchImpl = async () => {
      throw new Error("ECONNRESET boom");
    };
    const out = await fetchOpencodeGoLimits({ env: cfg, fetchImpl });
    assert.equal(out.configured, true);
    assert.match(out.error, /ECONNRESET/);
  });
});
