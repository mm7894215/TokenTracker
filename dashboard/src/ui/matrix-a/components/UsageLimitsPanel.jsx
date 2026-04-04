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

export function UsageLimitsPanel({ claude, codex, cursor, gemini, kiro, antigravity }) {
  const ok = (p) => p?.configured && !p.error;

  const groups = [];

  if (ok(claude)) {
    groups.push(
      <ToolGroup key="claude" name="Claude" icon="/brand-logos/claude-code.svg">
        {claude.five_hour ? <LimitBar label="5h" pct={claude.five_hour.utilization} reset={formatReset(claude.five_hour.resets_at)} /> : null}
        {claude.seven_day ? <LimitBar label="7d" pct={claude.seven_day.utilization} reset={formatReset(claude.seven_day.resets_at)} /> : null}
        {claude.seven_day_opus ? <LimitBar label="Opus" pct={claude.seven_day_opus.utilization} reset={formatReset(claude.seven_day_opus.resets_at)} /> : null}
      </ToolGroup>
    );
  }
  if (ok(codex)) {
    groups.push(
      <ToolGroup key="codex" name="Codex" icon="/brand-logos/codex.svg">
        {codex.primary_window ? <LimitBar label="5h" pct={codex.primary_window.used_percent} reset={formatReset(codex.primary_window.reset_at)} /> : null}
        {codex.secondary_window ? <LimitBar label="7d" pct={codex.secondary_window.used_percent} reset={formatReset(codex.secondary_window.reset_at)} /> : null}
      </ToolGroup>
    );
  }
  if (ok(cursor)) {
    groups.push(
      <ToolGroup key="cursor" name="Cursor" icon="/brand-logos/cursor.svg">
        {cursor.primary_window ? <LimitBar label="Plan" pct={cursor.primary_window.used_percent} reset={formatReset(cursor.primary_window.reset_at)} /> : null}
        {cursor.secondary_window ? <LimitBar label="Auto" pct={cursor.secondary_window.used_percent} reset={formatReset(cursor.secondary_window.reset_at)} /> : null}
        {cursor.tertiary_window ? <LimitBar label="API" pct={cursor.tertiary_window.used_percent} reset={formatReset(cursor.tertiary_window.reset_at)} /> : null}
      </ToolGroup>
    );
  }
  if (ok(gemini)) {
    groups.push(
      <ToolGroup key="gemini" name="Gemini" icon="/brand-logos/gemini.svg">
        {gemini.primary_window ? <LimitBar label="Pro" pct={gemini.primary_window.used_percent} reset={formatReset(gemini.primary_window.reset_at)} /> : null}
        {gemini.secondary_window ? <LimitBar label="Flash" pct={gemini.secondary_window.used_percent} reset={formatReset(gemini.secondary_window.reset_at)} /> : null}
        {gemini.tertiary_window ? <LimitBar label="Lite" pct={gemini.tertiary_window.used_percent} reset={formatReset(gemini.tertiary_window.reset_at)} /> : null}
      </ToolGroup>
    );
  }
  if (ok(kiro)) {
    groups.push(
      <ToolGroup key="kiro" name="Kiro" icon="/brand-logos/kiro.svg">
        {kiro.primary_window ? <LimitBar label="Month" pct={kiro.primary_window.used_percent} reset={formatReset(kiro.primary_window.reset_at)} /> : null}
        {kiro.secondary_window ? <LimitBar label="Bonus" pct={kiro.secondary_window.used_percent} reset={formatReset(kiro.secondary_window.reset_at)} /> : null}
      </ToolGroup>
    );
  }
  if (ok(antigravity)) {
    groups.push(
      <ToolGroup key="antigravity" name="Antigravity" icon="/brand-logos/antigravity.svg">
        {antigravity.primary_window ? <LimitBar label="Claude" pct={antigravity.primary_window.used_percent} reset={formatReset(antigravity.primary_window.reset_at)} /> : null}
        {antigravity.secondary_window ? <LimitBar label="G Pro" pct={antigravity.secondary_window.used_percent} reset={formatReset(antigravity.secondary_window.reset_at)} /> : null}
        {antigravity.tertiary_window ? <LimitBar label="Flash" pct={antigravity.tertiary_window.used_percent} reset={formatReset(antigravity.tertiary_window.reset_at)} /> : null}
      </ToolGroup>
    );
  }

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
