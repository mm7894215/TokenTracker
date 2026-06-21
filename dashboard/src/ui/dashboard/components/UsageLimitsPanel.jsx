import React, { useLayoutEffect, useRef, useState } from "react";
import { Card } from "../../components";
import { FadeIn } from "../../foundation/FadeIn.jsx";
import { copy } from "../../../lib/copy";
import { LIMIT_DISPLAY_MODES } from "../../../hooks/use-limits-display-prefs.js";
import {
  LIMIT_PROVIDER_IDS,
  limitProviderIconKey,
  limitProviderName,
} from "../../../lib/limits-providers.js";
import { computePace, resetToMs, resolveWindowSeconds } from "../../../lib/limit-pace.js";
import { ProviderIcon } from "./ProviderIcon.jsx";
import { buildResetBankRows } from "./usage-limits-reset-bank.js";
import { PROVIDER_LIMIT_SPECS } from "./usage-limits-provider-specs.js";

const LIMITS_PROVIDER_ICON_CLASS = "shrink-0 text-oai-black dark:text-oai-white";

function formatReset(isoOrUnix) {
  const ts = resetToMs(isoOrUnix);
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

function readWindowPct(window, field = "used_percent") {
  if (!window) return null;
  if (field === "utilization") return window.utilization;
  return window.used_percent;
}

function readWindowReset(window, field = "reset_at") {
  if (!window) return null;
  if (field === "resets_at") return window.resets_at;
  return window.reset_at;
}

/** Pace + projection for one window spec, in the active display mode. */
function paceForSpec(spec, mode) {
  return computePace({
    usedPercent: readWindowPct(spec.window, spec.pctField),
    windowSeconds: resolveWindowSeconds(spec, spec.window),
    resetMs: resetToMs(readWindowReset(spec.window, spec.resetField)),
    mode,
  });
}

function LimitBar({ label, pct, reset, mode = LIMIT_DISPLAY_MODES.USED, pacePercent = null, paceOver = false }) {
  const rawUsed = Math.max(0, Math.min(100, Number(pct) || 0));
  const displayPct = mode === LIMIT_DISPLAY_MODES.REMAINING ? 100 - rawUsed : rawUsed;
  const rounded = Math.round(displayPct);
  // Sub-1% still matters (e.g. team pool); keep bar/text from collapsing to 0%.
  const widthPct = displayPct > 0 && rounded === 0 ? Math.max(displayPct, 0.35) : displayPct;
  let labelPct = String(rounded);
  if (displayPct > 0 && rounded === 0) {
    labelPct = copy("limits.bar.sub_one_percent");
  }
  const paceX = pacePercent == null ? null : Math.max(0, Math.min(100, pacePercent));
  return (
    <div className="flex items-center gap-2">
      <span
        data-limit-label=""
        className="text-[11px] text-oai-gray-500 dark:text-oai-gray-400 shrink-0 whitespace-nowrap"
        style={{ width: "var(--tt-limits-label-w)" }}
      >
        {label}
      </span>
      <div className="relative flex-1 bg-oai-gray-100 dark:bg-oai-gray-700/50 rounded-full h-1.5 overflow-hidden">
        <div
          className={`${barColor(displayPct, mode)} rounded-full h-full transition-[width] duration-500 ease-out`}
          style={{ width: `${widthPct}%`, minWidth: displayPct > 0 ? "3px" : 0 }}
        />
        {paceX != null && (
          <>
            {/* Notch: a slice of bare track that "cuts" the fill, so the mark reads
                as a marker and stays visible even over a same-colored fill. */}
            <div
              className="absolute top-0 h-full bg-oai-gray-100 dark:bg-oai-gray-700/50"
              style={{ left: `calc(${paceX}% - 3px)`, width: "6px" }}
            />
            <div
              className={`absolute top-0 h-full ${paceOver ? "bg-red-500" : "bg-emerald-500"}`}
              style={{ left: `calc(${paceX}% - 1px)`, width: "2px" }}
            />
          </>
        )}
      </div>
      <span className="text-[11px] tabular-nums text-oai-gray-500 dark:text-oai-gray-400 w-9 text-right shrink-0 whitespace-nowrap">
        {labelPct}%
      </span>
      {reset && (
        <span className="text-[10px] text-oai-gray-400 dark:text-oai-gray-500 w-6 text-right shrink-0">{reset}</span>
      )}
    </div>
  );
}

/**
 * One window's explanation line. Adds only what the bar doesn't already show:
 * pace status + a current-rate projection. Used %, reset time live on the bar.
 */
function explainLineFor(spec, pace, mode) {
  const label = copy(spec.labelKey);
  const remaining = mode === LIMIT_DISPLAY_MODES.REMAINING;
  // In remaining mode every percentage flips to "how much is left".
  const projection = (usedPct) => (remaining ? 100 - usedPct : usedPct);
  // No trusted window length (monthly / billing cycle): just the usage.
  if (pace.expectedPercent == null) {
    const used = Math.round(Math.max(0, Math.min(100, Number(readWindowPct(spec.window, spec.pctField)) || 0)));
    return remaining
      ? copy("limits.explain.remaining", { label, used: projection(used) })
      : copy("limits.explain.used", { label, used });
  }
  if (pace.paceOver) {
    if (pace.runsOutEta) return copy("limits.explain.ahead_eta", { label, eta: pace.runsOutEta });
    const pct = projection(pace.projectedEnd ?? 100);
    return copy(remaining ? "limits.explain.ahead_pct_remaining" : "limits.explain.ahead_pct", { label, pct });
  }
  const used = Math.round(Math.max(0, Math.min(100, Number(readWindowPct(spec.window, spec.pctField)) || 0)));
  const pct = projection(pace.projectedEnd ?? used);
  return copy(remaining ? "limits.explain.on_track_remaining" : "limits.explain.on_track", { label, pct });
}

function LimitDetail({ rows, mode }) {
  if (rows.length === 0) return null;
  const remaining = mode === LIMIT_DISPLAY_MODES.REMAINING;
  // No own background or extra horizontal padding: it sits on the expanded
  // group's tint and lines up flush-left with the bars above.
  return (
    <div className="mt-1 flex flex-col gap-1">
      {rows.map(({ spec, pace }) => (
        <div key={spec.key} className="text-[11px] leading-snug text-oai-gray-600 dark:text-oai-gray-300">
          {explainLineFor(spec, pace, mode)}
        </div>
      ))}
      <div className="mt-1 pt-1.5 border-t border-oai-gray-200/70 dark:border-oai-gray-700/50 text-[10.5px] leading-snug text-oai-gray-400 dark:text-oai-gray-500">
        {copy(remaining ? "limits.explain.body_remaining" : "limits.explain.body")}
      </div>
    </div>
  );
}

function ToolGroup({ name, providerId, children, expandable = false, expanded = false, onToggle }) {
  const providerKey = limitProviderIconKey(providerId);
  const header = (
    <div className="flex items-center gap-1.5">
      {providerKey ? (
        <ProviderIcon provider={providerKey} size={14} className={LIMITS_PROVIDER_ICON_CLASS} />
      ) : null}
      <span className="text-sm font-medium text-oai-black dark:text-oai-white">{name}</span>
    </div>
  );

  if (!expandable) {
    return (
      <div className="flex flex-col gap-1.5">
        {header}
        {children}
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle?.();
        }
      }}
      className="flex flex-col gap-1.5 -mx-1.5 px-1.5 py-1 rounded-lg cursor-pointer transition-colors hover:bg-oai-gray-50 dark:hover:bg-oai-gray-800/40 aria-expanded:bg-oai-gray-50 dark:aria-expanded:bg-oai-gray-800/40"
    >
      {header}
      {children}
    </div>
  );
}

const DEFAULT_ORDER = LIMIT_PROVIDER_IDS;

function StatusLine({ children, tone = "neutral" }) {
  const color =
    tone === "error"
      ? "text-red-600 dark:text-red-400"
      : "text-oai-gray-500 dark:text-oai-gray-400";
  return <div className={`text-[11px] leading-snug ${color}`}>{children}</div>;
}

function LimitWindowSection({ rows, mode, extra = null }) {
  const showEmpty = rows.length === 0 && !extra;
  return (
    <>
      {rows.map(({ spec, pace }) => (
        <LimitBar
          key={spec.key}
          label={copy(spec.labelKey)}
          pct={readWindowPct(spec.window, spec.pctField)}
          reset={formatReset(readWindowReset(spec.window, spec.resetField))}
          mode={mode}
          pacePercent={pace.pacePercent}
          paceOver={pace.paceOver}
        />
      ))}
      {showEmpty ? <StatusLine>{copy("limits.status.no_data")}</StatusLine> : null}
      {extra}
    </>
  );
}

function ResetBankRow({ row }) {
  const widthPct = Math.max(0, Math.min(100, Number(row.percent) || 0));
  return (
    <div className="flex items-center gap-2" data-reset-bank-row="">
      <span
        data-limit-label=""
        className="text-[11px] text-oai-gray-500 dark:text-oai-gray-400 shrink-0 whitespace-nowrap"
        style={{ width: "var(--tt-limits-label-w)" }}
      >
        {row.label}
      </span>
      <div className="relative flex-1 bg-oai-gray-100 dark:bg-oai-gray-700/50 rounded-full h-1.5 overflow-hidden">
        <div
          className="bg-oai-gray-400 dark:bg-oai-gray-500 rounded-full h-full transition-[width] duration-500 ease-out"
          style={{ width: `${widthPct}%`, minWidth: widthPct > 0 ? "3px" : 0 }}
        />
      </div>
      <span className="text-[10px] tabular-nums text-oai-gray-400 dark:text-oai-gray-500 w-[4.25rem] text-right shrink-0 whitespace-nowrap">
        {row.expiresAt}
      </span>
    </div>
  );
}

function ResetBankSection({ model }) {
  const passiveText = model.kind === "count_only"
    ? copy("limits.codex_reset_bank.count_only", { count: model.availableCount })
    : null;

  return (
    <div className="mt-1 flex flex-col gap-1" data-reset-bank-section={model.kind}>
      <div className="text-[10.5px] font-medium uppercase tracking-wide text-oai-gray-400 dark:text-oai-gray-500">
        {copy("limits.codex_reset_bank.title")}
      </div>
      {passiveText ? (
        <div className="text-[11px] leading-snug text-oai-gray-500 dark:text-oai-gray-400">{passiveText}</div>
      ) : (
        model.rows.map((row) => <ResetBankRow key={row.key} row={row} />)
      )}
    </div>
  );
}

function renderProviderExtra(kind, data) {
  if (kind === "codex_reset_bank") {
    const model = buildResetBankRows(data.reset_credits);
    return model ? <ResetBankSection model={model} /> : null;
  }
  if (kind === "kimi_parallel" && data.parallel_limit) {
    return <StatusLine>{copy("limits.label.kimi_parallel", { count: data.parallel_limit })}</StatusLine>;
  }
  if (kind === "copilot_otel" && !data.otel_has_files && !data.otel_enabled) {
    return <CopilotOtelHint defaultDir={data.otel_default_dir} />;
  }
  return null;
}

function renderConfiguredProvider(id, data, title, mode, expanded, onToggle) {
  const spec = PROVIDER_LIMIT_SPECS[id];
  if (!spec) return null;
  // Pace is computed once per window here and shared by the bar + the detail.
  const rows = spec
    .windows(data)
    .filter((s) => s.window)
    .map((s) => ({ spec: s, pace: paceForSpec(s, mode) }));
  const extra = renderProviderExtra(spec.extra, data);
  return (
    <ToolGroup key={id} name={title} providerId={id} expandable={rows.length > 0} expanded={expanded} onToggle={onToggle}>
      <LimitWindowSection mode={mode} rows={rows} extra={extra} />
      {expanded ? <LimitDetail rows={rows} mode={mode} /> : null}
    </ToolGroup>
  );
}

function renderProviderGroup(id, data, mode, expanded, onToggle) {
  if (!PROVIDER_LIMIT_SPECS[id]) return null;
  if (!data?.configured) {
    return (
      <ToolGroup key={id} name={limitProviderName(id)} providerId={id}>
        <StatusLine>{copy("limits.status.not_connected")}</StatusLine>
      </ToolGroup>
    );
  }
  if (data.error) {
    return (
      <ToolGroup key={id} name={limitProviderName(id)} providerId={id}>
        <StatusLine tone="error">{copy("shared.error.prefix", { error: data.error })}</StatusLine>
      </ToolGroup>
    );
  }

  const baseName = limitProviderName(id);
  const title = data.plan_label ? `${baseName} ${data.plan_label}` : baseName;
  return renderConfiguredProvider(id, data, title, mode, expanded, onToggle);
}

function CopilotOtelHint({ defaultDir }) {
  const [copied, setCopied] = useState(false);
  const dir = defaultDir || "$HOME/.copilot/otel";
  const snippet = [
    "export COPILOT_OTEL_ENABLED=true",
    "export COPILOT_OTEL_EXPORTER_TYPE=file",
    `export COPILOT_OTEL_FILE_EXPORTER_PATH="${dir}/copilot-otel-$(date +%Y%m%d).jsonl"`,
  ].join("\n");

  const onCopy = async (e) => {
    e.stopPropagation();
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

/**
 * Width of the widest rendered row label, so every label column matches it.
 * Mirrors the macOS popover behavior: bars stay aligned without reserving
 * space for labels that aren't on screen, and longer labels (Spark,
 * localized strings) still fit without truncation.
 */
function useWidestLabelWidth(containerRef) {
  const [labelWidth, setLabelWidth] = useState(0);
  useLayoutEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const labels = root.querySelectorAll("[data-limit-label]");
    let max = 0;
    let ctx = null;
    if (labels.length > 0) {
      try {
        ctx = document.createElement("canvas").getContext("2d");
      } catch (_e) {
        ctx = null;
      }
    }
    if (ctx) {
      const style = window.getComputedStyle(labels[0]);
      ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      for (const el of labels) {
        max = Math.max(max, ctx.measureText(el.textContent).width);
      }
    }
    const next = Math.ceil(max);
    setLabelWidth((prev) => (prev === next ? prev : next));
  });
  return labelWidth;
}

export function UsageLimitsPanel({ claude, codex, cursor, gemini, kimi, kiro, grok, antigravity, copilot, order, visibility, displayMode }) {
  const dataById = { claude, codex, cursor, gemini, kimi, kiro, grok, antigravity, copilot };
  const containerRef = useRef(null);
  const labelWidth = useWidestLabelWidth(containerRef);
  const [expandedId, setExpandedId] = useState(null);
  const effectiveOrder = Array.isArray(order) && order.length > 0 ? order : DEFAULT_ORDER;
  const effectiveMode = displayMode === LIMIT_DISPLAY_MODES.REMAINING
    ? LIMIT_DISPLAY_MODES.REMAINING
    : LIMIT_DISPLAY_MODES.USED;
  const modeLabel = effectiveMode === LIMIT_DISPLAY_MODES.REMAINING
    ? copy("limits.settings.display_mode_remaining")
    : copy("limits.settings.display_mode_used");

  const groups = effectiveOrder
    .filter((id) => !visibility || visibility[id] !== false)
    .map((id) =>
      renderProviderGroup(
        id,
        dataById[id],
        effectiveMode,
        expandedId === id,
        () => setExpandedId((prev) => (prev === id ? null : id)),
      ),
    )
    .filter(Boolean);

  return (
    <FadeIn delay={0.15}>
      <Card>
        <div
          ref={containerRef}
          className="flex flex-col gap-3"
          style={labelWidth > 0 ? { "--tt-limits-label-w": `${labelWidth}px` } : undefined}
        >
          <h3 className="text-sm font-medium text-oai-gray-500 dark:text-oai-gray-300 uppercase tracking-wide">
            {copy("limits.panel.title")}{copy("limits.panel.mode_separator")}{modeLabel}
          </h3>
          {groups.length > 0 ? groups : <StatusLine>{copy("limits.status.all_hidden")}</StatusLine>}
        </div>
      </Card>
    </FadeIn>
  );
}
