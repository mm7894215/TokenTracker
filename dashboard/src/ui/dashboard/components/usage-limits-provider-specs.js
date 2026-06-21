import { copy } from "../../../lib/copy";

/** Window + optional extra metadata for UsageLimitsPanel (no JSX — keeps hardcode scan clean). */

export const PROVIDER_LIMIT_SPECS = {
  claude: {
    windows(data) {
      return [
        { key: "5h", labelKey: "limits.label.claude_5h", window: data.five_hour, pctField: "utilization", resetField: "resets_at", windowSeconds: 5 * 3600 },
        { key: "7d", labelKey: "limits.label.claude_7d", window: data.seven_day, pctField: "utilization", resetField: "resets_at", windowSeconds: 7 * 86400 },
        { key: "opus", labelKey: "limits.label.claude_opus", window: data.seven_day_opus, pctField: "utilization", resetField: "resets_at", windowSeconds: 7 * 86400 },
      ];
    },
  },
  codex: {
    extra: "codex_reset_bank",
    windows(data) {
      return [
        { key: "5h", labelKey: "limits.label.codex_5h", window: data.primary_window, windowSecondsField: "limit_window_seconds" },
        { key: "7d", labelKey: "limits.label.codex_7d", window: data.secondary_window, windowSecondsField: "limit_window_seconds" },
        { key: "spark-5h", labelKey: "limits.label.codex_spark_5h", window: data.spark_primary_window, windowSecondsField: "limit_window_seconds" },
        { key: "spark-7d", labelKey: "limits.label.codex_spark_7d", window: data.spark_secondary_window, windowSecondsField: "limit_window_seconds" },
      ];
    },
  },
  cursor: {
    windows(data) {
      return [
        { key: "plan", labelKey: "limits.label.cursor_plan", window: data.primary_window },
        { key: "auto", labelKey: "limits.label.cursor_auto", window: data.secondary_window },
        { key: "api", labelKey: "limits.label.cursor_api", window: data.tertiary_window },
      ];
    },
  },
  gemini: {
    windows(data) {
      return [
        { key: "pro", labelKey: "limits.label.gemini_pro", window: data.primary_window },
        { key: "flash", labelKey: "limits.label.gemini_flash", window: data.secondary_window },
        { key: "lite", labelKey: "limits.label.gemini_lite", window: data.tertiary_window },
      ];
    },
  },
  kimi: {
    extra: "kimi_parallel",
    windows(data) {
      return [
        { key: "weekly", labelKey: "limits.label.kimi_weekly", window: data.primary_window, windowSeconds: 7 * 86400 },
        { key: "5h", labelKey: "limits.label.kimi_5h", window: data.secondary_window, windowSeconds: 5 * 3600 },
        { key: "total", labelKey: "limits.label.kimi_total", window: data.tertiary_window },
      ];
    },
  },
  kiro: {
    windows(data) {
      return [
        { key: "month", labelKey: "limits.label.kiro_month", window: data.primary_window },
        { key: "bonus", labelKey: "limits.label.kiro_bonus", window: data.secondary_window },
      ];
    },
  },
  grok: {
    windows(data) {
      return [
        { key: "month", labelKey: "limits.label.grok_month", window: data.primary_window },
        { key: "ondemand", labelKey: "limits.label.grok_ondemand", window: data.secondary_window },
      ];
    },
  },
  antigravity: {
    windows(data) {
      return [
        { key: "claude", labelKey: "limits.label.antigravity_claude", window: data.primary_window },
        { key: "gpro", labelKey: "limits.label.antigravity_gpro", window: data.secondary_window },
        { key: "flash", labelKey: "limits.label.antigravity_flash", window: data.tertiary_window },
      ];
    },
  },
  copilot: {
    extra: "copilot_otel",
    windows(data) {
      return [
        { key: "premium", labelKey: "limits.label.copilot_premium", window: data.primary_window },
        { key: "chat", labelKey: "limits.label.copilot_chat", window: data.secondary_window },
      ];
    },
  },
};

/** Static copy() anchors for validate:copy — labels resolve at runtime via spec.labelKey. */
export function usageLimitsLabelCopyAnchor() {
  return [
    copy("limits.label.claude_5h"),
    copy("limits.label.claude_7d"),
    copy("limits.label.claude_opus"),
    copy("limits.label.codex_5h"),
    copy("limits.label.codex_7d"),
    copy("limits.label.codex_spark_5h"),
    copy("limits.label.codex_spark_7d"),
    copy("limits.codex_reset_bank.count_only"),
    copy("limits.label.cursor_plan"),
    copy("limits.label.cursor_auto"),
    copy("limits.label.cursor_api"),
    copy("limits.label.gemini_pro"),
    copy("limits.label.gemini_flash"),
    copy("limits.label.gemini_lite"),
    copy("limits.label.kimi_weekly"),
    copy("limits.label.kimi_5h"),
    copy("limits.label.kimi_total"),
    copy("limits.label.kiro_month"),
    copy("limits.label.kiro_bonus"),
    copy("limits.label.grok_month"),
    copy("limits.label.grok_ondemand"),
    copy("limits.label.antigravity_claude"),
    copy("limits.label.antigravity_gpro"),
    copy("limits.label.antigravity_flash"),
    copy("limits.label.copilot_premium"),
    copy("limits.label.copilot_chat"),
  ];
}
