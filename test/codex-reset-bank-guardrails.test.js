const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, "..", relPath), "utf8");
}

const resetBankSurfacePattern =
  /resetCredits?|resetCreditCount|reset[_-](?:credit|credits|bank)|Reset\s+(?:Bank|Credit|Credits)|codexResetBank|rate-limit-reset-credits|consume|redeem|claim/i;

const resetBankPrivateFieldPattern =
  /credit[\s_-]?id|reset[\s_-]?credit[\s_-]?id|account[\s_-]?id|user[\s_-]?id|profile(?:[\s_-]?id)?|profileEmail|email|avatar(?:[\s_-]?url)?|access[\s_-]?token|refresh[\s_-]?token|auth[\s_-]?token|\btoken\b/i;

const plausibleSurfaceLeaks = [
  "resetCredit",
  "resetCredits",
  "resetCreditCount",
  "reset_credit",
  "reset_credits",
  "reset_bank",
  "Reset Bank",
  "Reset Credit",
  "Reset Credits",
  "codexResetBank",
  "rate-limit-reset-credits",
  "consume",
  "redeem",
  "claim",
];

const privateFieldLeaks = [
  "creditId",
  "credit_id",
  "reset_credit_id",
  "accountId",
  "account_id",
  "Account ID",
  "userId",
  "profile",
  "profileEmail",
  "email",
  "avatar_url",
  "accessToken",
  "refresh_token",
  "auth_token",
  "token",
];

function assertPatternCatchesExamples(pattern, examples, label) {
  for (const example of examples) {
    assert.match(example, pattern, `${label} pattern should catch ${example}`);
  }
}

function assertNoResetBankSurface(source, label) {
  assertPatternCatchesExamples(resetBankSurfacePattern, plausibleSurfaceLeaks, label);
  assert.doesNotMatch(source, resetBankSurfacePattern, `${label} must not expose Reset Bank surface names`);
}

function collectKeys(value, out = []) {
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    out.push(key);
    collectKeys(child, out);
  }
  return out;
}

test("Codex reset bank native rows supersede the old macOS footnote path", () => {
  const resetBankFixtureMicrosecondExpiry = "2026-07-12T02:13:21.590541Z";
  const representativeApiOutput = {
    codex: {
      reset_credits: {
        available_count: 1,
        total_earned_count: 1,
        credits: [
          {
            status: "available",
            reset_type: "codex_rate_limits",
            granted_at: "2026-06-21T02:13:21.590541Z",
            expires_at: resetBankFixtureMicrosecondExpiry,
          },
        ],
      },
    },
  };
  const strings = read("TokenTrackerBar/TokenTrackerBar/Utilities/Strings.swift");
  const usageLimitsView = read("TokenTrackerBar/TokenTrackerBar/Views/UsageLimitsView.swift");

  assertPatternCatchesExamples(resetBankPrivateFieldPattern, privateFieldLeaks, "private field");
  assert.doesNotMatch(
    collectKeys(representativeApiOutput).join("\n"),
    resetBankPrivateFieldPattern,
    "representative Reset Bank API output must contain only sanitized count/status/type/timestamp fields",
  );
  assert.ok(strings.includes("codexResetBankSectionTitle"));
  assert.ok(strings.includes("codexResetBankLabel"));
  assert.ok(strings.includes("codexResetBankPassiveStatus"));
  assert.ok(strings.includes("codexResetBankCountOnly"));
  assert.ok(strings.includes("codexResetBankExpiryDateTime"));
  assert.ok(strings.includes("resetCreditAccessibility"));
  assert.doesNotMatch(strings, /codexResetBankFootnote|codexResetBankWithDates|codexResetBankMoreDates/);
  assert.match(strings, /static func codexResetBankExpiryDateTime\(_ date: Date\) -> String \{[\s\S]*?setLocalizedDateFormatFromTemplate\("MdHm"\)/);
  assert.doesNotMatch(strings, /codexResetBankExpiryDateTime\(_ date: Date\)[\s\S]*?dateStyle/s);

  assert.match(
    resetBankFixtureMicrosecondExpiry,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/,
  );
  assert.ok(usageLimitsView.includes('case "codex" where limits.codex.configured && limits.codex.error == nil'));
  assert.ok(usageLimitsView.includes("let resetState = codexResetBankViewData(limits.codex.resetCredits)"));
  assert.ok(usageLimitsView.includes("resetRows: resetState.rows, resetStatus: resetState.statusText"));
  assert.ok(usageLimitsView.includes("resetSection(rows: resetRows, status: resetStatus)"));
  assert.ok(usageLimitsView.includes("Text(Strings.codexResetBankSectionTitle)"));
  assert.ok(usageLimitsView.includes("ForEach(rows) { row in"));
  assert.ok(usageLimitsView.includes("resetRow(row)"));
  assert.ok(usageLimitsView.includes("private static var resetExpiryColumnWidth"));
  assert.ok(usageLimitsView.includes(".frame(width: Self.resetExpiryColumnWidth, alignment: .trailing)"));
  assert.ok(usageLimitsView.includes(".monospacedDigit()"));
  assert.ok(usageLimitsView.includes("Strings.codexResetBankLabel(index + 1)"));
  assert.ok(usageLimitsView.includes("Strings.codexResetBankExpiryDateTime(expiresAt)"));
  assert.ok(usageLimitsView.includes("resetLifetimeRemainingPercent("));
  assert.ok(usageLimitsView.includes("Strings.resetCreditAccessibility(label: label, expiry: expiry)"));
  assert.ok(usageLimitsView.includes("LimitsExplainContent(providerName: title, specs: specs"));
  assert.doesNotMatch(usageLimitsView, /footnote:\s*codexResetBankFootnote|Strings\.codexResetBankFootnote/);
});

test("Codex reset bank scope guard freezes widget menu bar and native bridge surfaces", () => {
  const model = read("TokenTrackerBar/TokenTrackerBar/Models/UsageLimits.swift");
  const usageLimitsView = read("TokenTrackerBar/TokenTrackerBar/Views/UsageLimitsView.swift");
  const widgetSnapshotWriter = read("TokenTrackerBar/TokenTrackerBar/Services/WidgetSnapshotWriter.swift");
  const usageLimitsWidget = read("TokenTrackerBar/TokenTrackerWidget/Widgets/UsageLimitsWidget.swift");
  const menuBarDisplayPreferences = read("TokenTrackerBar/TokenTrackerBar/Models/MenuBarDisplayPreferences.swift");
  const nativeBridge = read("TokenTrackerBar/TokenTrackerBar/Services/NativeBridge.swift");

  assert.ok(
    model.includes('case resetCredits = "reset_credits"'),
    "control: reset_credits is allowed in the decoded Codex model",
  );
  assert.ok(
    usageLimitsView.includes("resetSection(rows: resetRows, status: resetStatus)"),
    "control: reset credits may render only inside the native Codex rows subsection",
  );
  assert.doesNotMatch(
    usageLimitsView,
    /footnote:\s*codexResetBankFootnote|Strings\.codexResetBankFootnote/,
    "Reset Banking must not fall back to the old native footnote-only path",
  );
  assert.doesNotMatch(
    usageLimitsView,
    /reset[-_ ]?(?:bank|credit)[\s\S]{0,120}(?:consume|redeem|claim|action|Button\()/i,
    "Native Reset Bank rows must stay passive, with no consume/redeem action surface",
  );

  const menuBarMetricEnum = menuBarDisplayPreferences.match(
    /enum MenuBarDisplayMetric: String, CaseIterable \{[\s\S]*?\n\}\n\nprivate extension/,
  );
  assert.ok(menuBarMetricEnum, "MenuBarDisplayMetric enum should be present");
  assertNoResetBankSurface(menuBarMetricEnum[0], "menu-bar metric enum");
  assert.doesNotMatch(
    menuBarDisplayPreferences,
    /(?:reset|credit)[\s\S]{0,80}(?:account|profile|email|avatar|token|id)|(?:account|profile|email|avatar|token|id)[\s\S]{0,80}(?:reset|credit)/i,
    "Menu-bar display preferences must not learn Reset Bank identity fields",
  );

  const limitProviders = widgetSnapshotWriter.match(
    /private static func limitProviders\(from limits: UsageLimitsResponse\?\) -> \[LimitProvider\] \{[\s\S]*?return out\.filter \{ !hiddenProviders\.contains\(\$0\.source\) \}\n    \}/,
  );
  assert.ok(limitProviders, "WidgetSnapshotWriter.limitProviders should be present");
  assert.match(limitProviders[0], /LimitProvider\(source: "codex", label: "Codex · 5h"/);
  assert.match(limitProviders[0], /LimitProvider\(source: "codex", label: "Codex · Spark 7d"/);
  assertNoResetBankSurface(limitProviders[0], "WidgetSnapshotWriter provider rows");
  assert.ok(usageLimitsWidget.includes("entry.snapshot.limits"));
  assert.ok(usageLimitsWidget.includes("ForEach(trimmed)"));
  assertNoResetBankSurface(usageLimitsWidget, "UsageLimitsWidget");

  const nativeSettingsPayload = nativeBridge.match(
    /let payload: \[String: Any\] = \[[\s\S]*?\n        \]/,
  );
  assert.ok(nativeSettingsPayload, "NativeBridge.pushSettings payload should be present");
  assert.ok(nativeSettingsPayload[0].includes('"limitsPreferences": limitsSettings.limitsPreferencesPayload'));
  assertNoResetBankSurface(nativeSettingsPayload[0], "NativeBridge settings payload");
  assert.doesNotMatch(
    nativeSettingsPayload[0],
    /(?:reset|credit)[\s\S]{0,80}(?:account|profile|email|avatar|token|id)|(?:account|profile|email|avatar|token|id)[\s\S]{0,80}(?:reset|credit)/i,
    "NativeBridge settings payload must not publish Reset Bank identity fields",
  );
});
