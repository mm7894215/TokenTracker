import React from "react";
import { Card } from "../../openai/components";
import { FadeIn } from "../../foundation/FadeIn.jsx";

function formatReset(isoOrUnix) {
  if (!isoOrUnix) return null;
  const ts = typeof isoOrUnix === "number" ? isoOrUnix * 1000 : Date.parse(isoOrUnix);
  if (!Number.isFinite(ts)) return null;
  const diff = ts - Date.now();
  if (diff <= 0) return "now";
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function barColor(pct) {
  if (pct >= 90) return "bg-red-500";
  if (pct >= 70) return "bg-amber-500";
  return "bg-emerald-500";
}

function LimitBar({ label, pct, reset }) {
  const v = Math.max(0, Math.min(100, Math.round(pct)));
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-oai-gray-500 dark:text-oai-gray-400 w-12 shrink-0">{label}</span>
      <div className="flex-1 bg-oai-gray-100 dark:bg-oai-gray-700/50 rounded-full h-1.5 overflow-hidden">
        <div
          className={`${barColor(v)} rounded-full h-full transition-[width] duration-500 ease-out`}
          style={{ width: `${v}%`, minWidth: v > 0 ? "3px" : 0 }}
        />
      </div>
      <span className="text-[11px] tabular-nums text-oai-gray-500 dark:text-oai-gray-400 w-[30px] text-right shrink-0">
        {v}%
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
  const needsInvert = icon === "/brand-logos/cursor.svg" || icon === "/brand-logos/kiro.svg";
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

const DEFAULT_ORDER = ["claude", "codex", "cursor", "gemini", "kiro", "antigravity"];

function renderProviderGroup(id, data) {
  const ok = (p) => p?.configured && !p.error;
  if (!ok(data)) return null;
  switch (id) {
    case "claude":
      return (
        <ToolGroup key="claude" name="Claude" icon="/brand-logos/claude-code.svg">
          {data.five_hour ? <LimitBar label="5h" pct={data.five_hour.utilization} reset={formatReset(data.five_hour.resets_at)} /> : null}
          {data.seven_day ? <LimitBar label="7d" pct={data.seven_day.utilization} reset={formatReset(data.seven_day.resets_at)} /> : null}
          {data.seven_day_opus ? <LimitBar label="Opus" pct={data.seven_day_opus.utilization} reset={formatReset(data.seven_day_opus.resets_at)} /> : null}
        </ToolGroup>
      );
    case "codex":
      return (
        <ToolGroup key="codex" name="Codex" icon="/brand-logos/codex.svg">
          {data.primary_window ? <LimitBar label="5h" pct={data.primary_window.used_percent} reset={formatReset(data.primary_window.reset_at)} /> : null}
          {data.secondary_window ? <LimitBar label="7d" pct={data.secondary_window.used_percent} reset={formatReset(data.secondary_window.reset_at)} /> : null}
        </ToolGroup>
      );
    case "cursor":
      return (
        <ToolGroup key="cursor" name="Cursor" icon="/brand-logos/cursor.svg">
          {data.primary_window ? <LimitBar label="Plan" pct={data.primary_window.used_percent} reset={formatReset(data.primary_window.reset_at)} /> : null}
          {data.secondary_window ? <LimitBar label="Auto" pct={data.secondary_window.used_percent} reset={formatReset(data.secondary_window.reset_at)} /> : null}
          {data.tertiary_window ? <LimitBar label="API" pct={data.tertiary_window.used_percent} reset={formatReset(data.tertiary_window.reset_at)} /> : null}
        </ToolGroup>
      );
    case "gemini":
      return (
        <ToolGroup key="gemini" name="Gemini" icon="/brand-logos/gemini.svg">
          {data.primary_window ? <LimitBar label="Pro" pct={data.primary_window.used_percent} reset={formatReset(data.primary_window.reset_at)} /> : null}
          {data.secondary_window ? <LimitBar label="Flash" pct={data.secondary_window.used_percent} reset={formatReset(data.secondary_window.reset_at)} /> : null}
          {data.tertiary_window ? <LimitBar label="Lite" pct={data.tertiary_window.used_percent} reset={formatReset(data.tertiary_window.reset_at)} /> : null}
        </ToolGroup>
      );
    case "kiro":
      return (
        <ToolGroup key="kiro" name="Kiro" icon="/brand-logos/kiro.svg">
          {data.primary_window ? <LimitBar label="Month" pct={data.primary_window.used_percent} reset={formatReset(data.primary_window.reset_at)} /> : null}
          {data.secondary_window ? <LimitBar label="Bonus" pct={data.secondary_window.used_percent} reset={formatReset(data.secondary_window.reset_at)} /> : null}
        </ToolGroup>
      );
    case "antigravity":
      return (
        <ToolGroup key="antigravity" name="Antigravity" icon="/brand-logos/antigravity.svg">
          {data.primary_window ? <LimitBar label="Claude" pct={data.primary_window.used_percent} reset={formatReset(data.primary_window.reset_at)} /> : null}
          {data.secondary_window ? <LimitBar label="G Pro" pct={data.secondary_window.used_percent} reset={formatReset(data.secondary_window.reset_at)} /> : null}
          {data.tertiary_window ? <LimitBar label="Flash" pct={data.tertiary_window.used_percent} reset={formatReset(data.tertiary_window.reset_at)} /> : null}
        </ToolGroup>
      );
    default:
      return null;
  }
}

export function UsageLimitsPanel({ claude, codex, cursor, gemini, kiro, antigravity, order, visibility }) {
  const dataById = { claude, codex, cursor, gemini, kiro, antigravity };
  const effectiveOrder = Array.isArray(order) && order.length > 0 ? order : DEFAULT_ORDER;

  const groups = effectiveOrder
    .filter((id) => !visibility || visibility[id] !== false)
    .map((id) => renderProviderGroup(id, dataById[id]))
    .filter(Boolean);

  if (groups.length === 0) return null;

  return (
    <FadeIn delay={0.15}>
      <Card>
        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-medium text-oai-gray-500 dark:text-oai-gray-300 uppercase tracking-wide">Usage Limits</h3>
          {groups}
        </div>
      </Card>
    </FadeIn>
  );
}
