import React, { useState } from "react";
import { Card } from "../../components";
import { FadeIn } from "../../foundation/FadeIn.jsx";
import { copy } from "../../../lib/copy";
import { LIMIT_DISPLAY_MODES } from "../../../hooks/use-limits-display-prefs.js";

function formatReset(isoOrUnix) {
  if (!isoOrUnix) return null;
  const ts = typeof isoOrUnix === "number" ? isoOrUnix * 1000 : Date.parse(isoOrUnix);
  if (!Number.isFinite(ts)) return null;
  const diff = ts - Date.now();
  if (diff <= 0) return copy("shared.time.now");
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * In "used" mode a high percentage is bad (lots of quota burned).
 * In "remaining" mode a high percentage is good (lots of quota left), so the
 * red/amber thresholds are mirrored: low remaining = red.
 */
function barColor(displayPct, mode) {
  const pct = mode === LIMIT_DISPLAY_MODES.REMAINING ? 100 - displayPct : displayPct;
  if (pct >= 90) return "bg-red-500";
  if (pct >= 70) return "bg-amber-500";
  return "bg-emerald-500";
}

function LimitBar({ label, pct, reset, mode = LIMIT_DISPLAY_MODES.USED }) {
  const rawUsed = Math.max(0, Math.min(100, Number(pct) || 0));
  const displayPct = mode === LIMIT_DISPLAY_MODES.REMAINING ? 100 - rawUsed : rawUsed;
  const rounded = Math.round(displayPct);
  // Sub-1% still matters (e.g. team pool); keep bar/text from collapsing to 0%.
  const widthPct = displayPct > 0 && rounded === 0 ? Math.max(displayPct, 0.35) : displayPct;
  const labelPct =
    displayPct > 0 && rounded === 0 ? "<1" : String(rounded);
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-oai-gray-500 dark:text-oai-gray-400 w-12 shrink-0">{label}</span>
      <div className="flex-1 bg-oai-gray-100 dark:bg-oai-gray-700/50 rounded-full h-1.5 overflow-hidden">
        <div
          className={`${barColor(displayPct, mode)} rounded-full h-full transition-[width] duration-500 ease-out`}
          style={{ width: `${widthPct}%`, minWidth: displayPct > 0 ? "3px" : 0 }}
        />
      </div>
      <span className="text-[11px] tabular-nums text-oai-gray-500 dark:text-oai-gray-400 w-9 text-right shrink-0 whitespace-nowrap">
        {labelPct}%
      </span>
      {reset ? (
        <span className="text-[10px] text-oai-gray-400 dark:text-oai-gray-500 w-6 text-right shrink-0">
          {reset}
        </span>
      ) : null}
    </div>
  );
}

function ToolGroup({ name, icon, children }) {
  const needsInvert =
    icon === "/brand-logos/cursor.svg" ||
    icon === "/brand-logos/kiro.svg" ||
    icon === "/brand-logos/copilot.svg" ||
    icon === "/brand-logos/kimi.svg";
  const iconClass = needsInvert ? "w-[14px] h-[14px] dark:invert" : "w-[14px] h-[14px]";

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        {icon ? <img src={icon} alt="" className={iconClass} /> : null}
        <span className="text-sm font-medium text-oai-black dark:text-oai-white">{name}</span>
      </div>
      {children}
    </div>
  );
}

const DEFAULT_ORDER = ["claude", "codex", "cursor", "gemini", "kimi", "kiro", "grok", "copilot", "antigravity"];

const PROVIDER_META = {
  claude: { name: "Claude", icon: "/brand-logos/claude-code.svg" },
  codex: { name: "Codex", icon: "/brand-logos/codex.svg" },
  cursor: { name: "Cursor", icon: "/brand-logos/cursor.svg" },
  gemini: { name: "Gemini", icon: "/brand-logos/gemini.svg" },
  kimi: { name: "Kimi", icon: "/brand-logos/kimi.svg" },
  kiro: { name: "Kiro", icon: "/brand-logos/kiro.svg" },
  grok: { name: "Grok Build", icon: "/brand-logos/grok.svg" },
  copilot: { name: "GitHub Copilot", icon: "/brand-logos/copilot.svg" },
  antigravity: { name: "Antigravity", icon: "/brand-logos/antigravity.svg" },
};

function StatusLine({ children, tone = "neutral" }) {
  const color =
    tone === "error"
      ? "text-red-600 dark:text-red-400"
      : "text-oai-gray-500 dark:text-oai-gray-400";
  return <div className={`text-[11px] leading-snug ${color}`}>{children}</div>;
}

function renderProviderGroup(id, data, mode) {
  const meta = PROVIDER_META[id];
  if (!meta) return null;
  if (!data?.configured) {
    return (
      <ToolGroup key={id} name={meta.name} icon={meta.icon}>
        <StatusLine>{copy("limits.status.not_connected")}</StatusLine>
      </ToolGroup>
    );
  }
  if (data.error) {
    return (
      <ToolGroup key={id} name={meta.name} icon={meta.icon}>
        <StatusLine tone="error">{copy("shared.error.prefix", { error: data.error })}</StatusLine>
      </ToolGroup>
    );
  }

  const title = data.plan_label ? `${meta.name} ${data.plan_label}` : meta.name;

  switch (id) {
    case "claude":
      return (
        <ToolGroup key="claude" name={title} icon={meta.icon}>
          {data.five_hour ? <LimitBar label="5h" pct={data.five_hour.utilization} reset={formatReset(data.five_hour.resets_at)} mode={mode} /> : null}
          {data.seven_day ? <LimitBar label="7d" pct={data.seven_day.utilization} reset={formatReset(data.seven_day.resets_at)} mode={mode} /> : null}
          {data.seven_day_opus ? <LimitBar label="Opus" pct={data.seven_day_opus.utilization} reset={formatReset(data.seven_day_opus.resets_at)} mode={mode} /> : null}
          {!data.five_hour && !data.seven_day && !data.seven_day_opus ? <StatusLine>{copy("limits.status.no_data")}</StatusLine> : null}
        </ToolGroup>
      );
    case "codex":
      return (
        <ToolGroup key="codex" name={title} icon={meta.icon}>
          {data.primary_window ? <LimitBar label="5h" pct={data.primary_window.used_percent} reset={formatReset(data.primary_window.reset_at)} mode={mode} /> : null}
          {data.secondary_window ? <LimitBar label="7d" pct={data.secondary_window.used_percent} reset={formatReset(data.secondary_window.reset_at)} mode={mode} /> : null}
          {!data.primary_window && !data.secondary_window ? <StatusLine>{copy("limits.status.no_data")}</StatusLine> : null}
        </ToolGroup>
      );
    case "cursor":
      return (
        <ToolGroup key="cursor" name={title} icon={meta.icon}>
          {data.primary_window ? <LimitBar label={copy("limits.label.cursor_plan")} pct={data.primary_window.used_percent} reset={formatReset(data.primary_window.reset_at)} mode={mode} /> : null}
          {data.secondary_window ? <LimitBar label={copy("limits.label.cursor_auto")} pct={data.secondary_window.used_percent} reset={formatReset(data.secondary_window.reset_at)} mode={mode} /> : null}
          {data.tertiary_window ? <LimitBar label={copy("limits.label.cursor_api")} pct={data.tertiary_window.used_percent} reset={formatReset(data.tertiary_window.reset_at)} mode={mode} /> : null}
          {!data.primary_window && !data.secondary_window && !data.tertiary_window ? <StatusLine>{copy("limits.status.no_data")}</StatusLine> : null}
        </ToolGroup>
      );
    case "gemini":
      return (
        <ToolGroup key="gemini" name={title} icon={meta.icon}>
          {data.primary_window ? <LimitBar label="Pro" pct={data.primary_window.used_percent} reset={formatReset(data.primary_window.reset_at)} mode={mode} /> : null}
          {data.secondary_window ? <LimitBar label="Flash" pct={data.secondary_window.used_percent} reset={formatReset(data.secondary_window.reset_at)} mode={mode} /> : null}
          {data.tertiary_window ? <LimitBar label="Lite" pct={data.tertiary_window.used_percent} reset={formatReset(data.tertiary_window.reset_at)} mode={mode} /> : null}
          {!data.primary_window && !data.secondary_window && !data.tertiary_window ? <StatusLine>{copy("limits.status.no_data")}</StatusLine> : null}
        </ToolGroup>
      );
    case "kimi":
      return (
        <ToolGroup key="kimi" name={title} icon={meta.icon}>
          {data.primary_window ? <LimitBar label={copy("limits.label.kimi_weekly")} pct={data.primary_window.used_percent} reset={formatReset(data.primary_window.reset_at)} mode={mode} /> : null}
          {data.secondary_window ? <LimitBar label={copy("limits.label.kimi_5h")} pct={data.secondary_window.used_percent} reset={formatReset(data.secondary_window.reset_at)} mode={mode} /> : null}
          {data.tertiary_window ? <LimitBar label={copy("limits.label.kimi_total")} pct={data.tertiary_window.used_percent} reset={formatReset(data.tertiary_window.reset_at)} mode={mode} /> : null}
          {data.parallel_limit ? <StatusLine>{copy("limits.label.kimi_parallel", { count: data.parallel_limit })}</StatusLine> : null}
          {!data.primary_window && !data.secondary_window && !data.tertiary_window ? <StatusLine>{copy("limits.status.no_data")}</StatusLine> : null}
        </ToolGroup>
      );
    case "kiro":
      return (
        <ToolGroup key="kiro" name={title} icon={meta.icon}>
          {data.primary_window ? <LimitBar label={copy("limits.label.kiro_month")} pct={data.primary_window.used_percent} reset={formatReset(data.primary_window.reset_at)} mode={mode} /> : null}
          {data.secondary_window ? <LimitBar label={copy("limits.label.kiro_bonus")} pct={data.secondary_window.used_percent} reset={formatReset(data.secondary_window.reset_at)} mode={mode} /> : null}
          {!data.primary_window && !data.secondary_window ? <StatusLine>{copy("limits.status.no_data")}</StatusLine> : null}
        </ToolGroup>
      );
    case "grok":
      return (
        <ToolGroup key="grok" name={title} icon={meta.icon}>
          {data.primary_window ? <LimitBar label={copy("limits.label.grok_month")} pct={data.primary_window.used_percent} reset={formatReset(data.primary_window.reset_at)} mode={mode} /> : null}
          {data.secondary_window ? <LimitBar label={copy("limits.label.grok_ondemand")} pct={data.secondary_window.used_percent} reset={formatReset(data.secondary_window.reset_at)} mode={mode} /> : null}
          {!data.primary_window && !data.secondary_window ? <StatusLine>{copy("limits.status.no_data")}</StatusLine> : null}
        </ToolGroup>
      );
    case "antigravity":
      return (
        <ToolGroup key="antigravity" name={title} icon={meta.icon}>
          {data.primary_window ? <LimitBar label="Claude" pct={data.primary_window.used_percent} reset={formatReset(data.primary_window.reset_at)} mode={mode} /> : null}
          {data.secondary_window ? <LimitBar label="G Pro" pct={data.secondary_window.used_percent} reset={formatReset(data.secondary_window.reset_at)} mode={mode} /> : null}
          {data.tertiary_window ? <LimitBar label="Flash" pct={data.tertiary_window.used_percent} reset={formatReset(data.tertiary_window.reset_at)} mode={mode} /> : null}
          {!data.primary_window && !data.secondary_window && !data.tertiary_window ? <StatusLine>{copy("limits.status.no_data")}</StatusLine> : null}
        </ToolGroup>
      );
    case "copilot":
      return (
        <ToolGroup key="copilot" name={title} icon={meta.icon}>
          {data.primary_window ? <LimitBar label={copy("limits.label.copilot_premium")} pct={data.primary_window.used_percent} reset={formatReset(data.primary_window.reset_at)} mode={mode} /> : null}
          {data.secondary_window ? <LimitBar label={copy("limits.label.copilot_chat")} pct={data.secondary_window.used_percent} reset={formatReset(data.secondary_window.reset_at)} mode={mode} /> : null}
          {!data.primary_window && !data.secondary_window ? <StatusLine>{copy("limits.status.no_data")}</StatusLine> : null}
          {data.otel_has_files || data.otel_enabled ? null : <CopilotOtelHint defaultDir={data.otel_default_dir} />}
        </ToolGroup>
      );
    default:
      return null;
  }
}

function CopilotOtelHint({ defaultDir }) {
  const [copied, setCopied] = useState(false);
  const dir = defaultDir || "$HOME/.copilot/otel";
  const snippet = [
    "export COPILOT_OTEL_ENABLED=true",
    "export COPILOT_OTEL_EXPORTER_TYPE=file",
    `export COPILOT_OTEL_FILE_EXPORTER_PATH="${dir}/copilot-otel-$(date +%Y%m%d).jsonl"`,
  ].join("\n");

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch (_e) {
      // Clipboard can be unavailable in embedded or restricted contexts.
    }
  };

  return (
    <div className="mt-1 rounded-md border border-amber-300/60 dark:border-amber-700/40 bg-amber-50/50 dark:bg-amber-900/10 px-2.5 py-2 text-[11px] text-oai-gray-600 dark:text-oai-gray-300">
      <div className="font-medium text-oai-gray-700 dark:text-oai-gray-200">{copy("limits.copilot.otelHint.title")}</div>
      <div className="mt-0.5 leading-snug">{copy("limits.copilot.otelHint.body")}</div>
      <pre className="mt-1.5 overflow-x-auto rounded bg-oai-gray-100 dark:bg-oai-gray-900/60 px-2 py-1.5 font-mono text-[10.5px] leading-tight whitespace-pre">{snippet}</pre>
      <button
        type="button"
        onClick={onCopy}
        className="mt-1 inline-flex items-center gap-1 rounded border border-oai-gray-300 dark:border-oai-gray-700 px-1.5 py-0.5 text-[10.5px] text-oai-gray-700 dark:text-oai-gray-200 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 transition-colors"
      >
        {copied ? copy("limits.copilot.otelHint.copied") : copy("limits.copilot.otelHint.copy")}
      </button>
    </div>
  );
}

export function UsageLimitsPanel({ claude, codex, cursor, gemini, kimi, kiro, grok, antigravity, copilot, order, visibility, displayMode }) {
  const dataById = { claude, codex, cursor, gemini, kimi, kiro, grok, antigravity, copilot };
  const effectiveOrder = Array.isArray(order) && order.length > 0 ? order : DEFAULT_ORDER;
  const effectiveMode = displayMode === LIMIT_DISPLAY_MODES.REMAINING
    ? LIMIT_DISPLAY_MODES.REMAINING
    : LIMIT_DISPLAY_MODES.USED;
  const modeLabel = effectiveMode === LIMIT_DISPLAY_MODES.REMAINING
    ? copy("limits.settings.display_mode_remaining")
    : copy("limits.settings.display_mode_used");

  const groups = effectiveOrder
    .filter((id) => !visibility || visibility[id] !== false)
    .map((id) => renderProviderGroup(id, dataById[id], effectiveMode))
    .filter(Boolean);

  return (
    <FadeIn delay={0.15}>
      <Card>
        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-medium text-oai-gray-500 dark:text-oai-gray-300 uppercase tracking-wide">
            {copy("limits.panel.title")}{copy("limits.panel.mode_separator")}{modeLabel}
          </h3>
          {groups.length > 0 ? groups : <StatusLine>{copy("limits.status.all_hidden")}</StatusLine>}
        </div>
      </Card>
    </FadeIn>
  );
}
