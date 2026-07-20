import React, { useEffect, useId, useMemo, useState } from "react";
import { Card } from "../../components";
import { copy } from "../../../lib/copy";
import { getContextHealth, getSessionInsights } from "../../../lib/api";
import { useSessionEfficiencyPref } from "../../../hooks/use-session-efficiency-pref.js";
import { useTokenFormat } from "../../../hooks/useTokenFormat.js";
import { TOKEN_FORMAT_MODES } from "../../../lib/token-format.js";

const PLACEHOLDER_MODELS = new Set(["unknown", "synthetic", "openai"]);

function pct(value) {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

function money(value) {
  if (value == null) return "—";
  return value < 1 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) ? new Intl.NumberFormat().format(Math.round(number)) : "0";
}

function isDisplayModel(row) {
  const model = String(row?.model || "").trim().toLowerCase();
  const normalized = model.replace(/^<|>$/g, "");
  return Boolean(normalized)
    && !PLACEHOLDER_MODELS.has(normalized)
    && Number(row?.edit_turns || 0) > 0;
}

function SessionCardHeader() {
  return (
    <div className="mb-3">
      <div>
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium text-oai-black dark:text-white">{copy("sessions.card.title")}</h3>
          <span className="rounded bg-oai-gray-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-oai-gray-500 dark:bg-oai-gray-800/80 dark:text-oai-gray-400">
            {copy("qpd.card.badge")}
          </span>
        </div>
        <p className="mt-1 text-xs text-oai-gray-500 dark:text-oai-gray-400">{copy("sessions.card.subtitle")}</p>
      </div>
    </div>
  );
}

export function SessionInsightsCard({ from, to }) {
  const [state, setState] = useState({ loading: true, sessions: null, context: null });
  const methodologyId = useId();
  const { enabled } = useSessionEfficiencyPref();
  const { formatTokens } = useTokenFormat();
  const formatCompactTokens = (value) => formatTokens(value, { mode: TOKEN_FORMAT_MODES.COMPACT });
  useEffect(() => {
    if (!enabled) {
      setState({ loading: false, sessions: null, context: null });
      return undefined;
    }
    let cancelled = false;
    setState((previous) => ({ ...previous, loading: true }));
    Promise.all([getSessionInsights({ from, to }), getContextHealth()])
      .then(([sessions, context]) => {
        if (!cancelled) setState({ loading: false, sessions, context });
      })
      .catch(() => {
        if (!cancelled) setState({ loading: false, sessions: null, context: null });
      });
    return () => { cancelled = true; };
  }, [enabled, from, to]);

  const models = useMemo(
    () => (state.sessions?.by_model || []).filter(isDisplayModel).slice(0, 5),
    [state.sessions],
  );
  const subagents = useMemo(() => (state.sessions?.subagents || []).slice(0, 3), [state.sessions]);
  if (!enabled) return null;
  if (!state.loading && !state.sessions?.available && !state.context?.estimated_fixed_tokens) return null;
  const summary = state.sessions?.summary || {};
  const editSessionRate = summary.edit_session_rate ?? summary.productive_rate;
  const firstPassRate = summary.first_pass_rate ?? summary.one_shot_rate;
  const editSessions = summary.edit_sessions ?? summary.productive_sessions ?? 0;
  const sessionCount = summary.sessions ?? state.sessions?.session_count ?? 0;
  const editTurns = summary.edit_turns ?? 0;
  if (state.loading && !state.sessions && !state.context) {
    return (
      <Card>
        <SessionCardHeader />
        <div
          role="status"
          className="flex h-24 items-center justify-center rounded-lg bg-oai-gray-50 text-xs text-oai-gray-400 dark:bg-oai-gray-800/50 dark:text-oai-gray-500"
        >
          {copy("sessions.card.loading")}
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <SessionCardHeader />

      <div className="grid grid-cols-3 gap-2 mb-3">
        <Metric
          label={copy("sessions.card.edit_sessions")}
          value={pct(editSessionRate)}
          detail={copy("sessions.card.edit_session_value", {
            edits: count(editSessions),
            sessions: count(sessionCount),
          })}
        />
        <Metric
          label={copy("sessions.card.first_pass")}
          value={pct(firstPassRate)}
          detail={copy("sessions.card.edit_session_value", {
            edits: count(summary.first_pass_sessions ?? summary.one_shot_sessions ?? 0),
            sessions: count(editSessions),
          })}
        />
        <Metric
          label={copy("sessions.card.cost_edit")}
          value={money(summary.cost_per_edit)}
          detail={copy("sessions.card.edit_turn_count", { count: count(editTurns) })}
        />
      </div>

      <div className="mb-3 flex items-center justify-between gap-3 text-[10px] text-oai-gray-400 dark:text-oai-gray-500">
        <span>{copy("sessions.card.sample", { sessions: count(sessionCount), edits: count(editTurns) })}</span>
        <span className="group relative inline-flex shrink-0">
          <button
            type="button"
            aria-describedby={methodologyId}
            className="cursor-help rounded-sm underline decoration-dotted underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand/40"
          >
            {copy("sessions.card.methodology_label")}
          </button>
          <span
            id={methodologyId}
            role="tooltip"
            className="pointer-events-none absolute right-0 top-full z-20 mt-2 w-64 rounded-xl border border-oai-gray-200/60 bg-white/95 px-3 py-2 text-left text-[10.5px] font-normal leading-relaxed text-oai-gray-700 opacity-0 shadow-xl backdrop-blur-md transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 dark:border-oai-gray-700/70 dark:bg-oai-gray-900/95 dark:text-oai-gray-200"
          >
            {copy("sessions.card.methodology")}
          </span>
        </span>
      </div>

      {Boolean(models.length) && (
        <div className="overflow-x-auto oai-scrollbar">
          <table className="w-full min-w-[440px] text-xs">
            <thead className="text-[10px] uppercase tracking-wide text-oai-gray-400">
              <tr>
                <th className="pb-1.5 text-left font-medium">{copy("sessions.card.model")}</th>
                <th className="pb-1.5 text-right font-medium">{copy("sessions.card.edit_sessions")}</th>
                <th className="pb-1.5 text-right font-medium">{copy("sessions.card.first_pass")}</th>
                <th className="pb-1.5 text-right font-medium">{copy("sessions.card.tokens_edit")}</th>
              </tr>
            </thead>
            <tbody>
              {models.map((row) => (
                <tr key={row.model} className="border-t border-oai-gray-100 dark:border-oai-gray-800/60">
                  <td className="py-2 pr-2 font-mono text-[11px] truncate max-w-[150px]" title={row.model}>{row.model}</td>
                  <td className="py-2 pl-2 text-right tabular-nums">
                    {copy("sessions.card.edit_session_value", {
                      edits: count(row.edit_sessions ?? row.productive_sessions ?? 0),
                      sessions: count(row.sessions),
                    })}
                  </td>
                  <td className="py-2 pl-2 text-right tabular-nums">{pct(row.first_pass_rate ?? row.one_shot_rate)}</td>
                  <td className="py-2 text-right tabular-nums">{formatCompactTokens(row.tokens_per_edit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {state.context ? (
        <div className="mt-3 pt-2.5 border-t border-oai-gray-200 dark:border-oai-gray-800 flex items-center justify-between gap-3 text-[11px] text-oai-gray-500 dark:text-oai-gray-400">
          <span>{copy("sessions.card.context")}</span>
          <span className="tabular-nums" title={copy("sessions.card.context_tooltip")}>{formatCompactTokens(state.context.estimated_fixed_tokens)}</span>
        </div>
      ) : null}
      {Boolean(subagents.length) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-oai-gray-500 dark:text-oai-gray-400">
          <span>{copy("sessions.card.subagents")}</span>
          {subagents.map((row) => (
            <span key={row.name} className="rounded-full bg-oai-gray-100 dark:bg-oai-gray-800 px-1.5 py-0.5">
              {copy("sessions.card.subagent_item", { name: row.name, calls: Math.round(row.calls) })}
            </span>
          ))}
        </div>
      )}
      <p className="mt-2 text-[10px] text-oai-gray-400 dark:text-oai-gray-500">{copy("sessions.card.privacy")}</p>
    </Card>
  );
}

function Metric({ label, value, detail }) {
  return (
    <div className="rounded-lg bg-oai-gray-50 dark:bg-oai-gray-800/50 px-2.5 py-2">
      <div className="text-[10px] text-oai-gray-500 dark:text-oai-gray-400 truncate">{label}</div>
      <div className="mt-0.5 text-sm font-semibold tabular-nums text-oai-black dark:text-white">{value}</div>
      <div className="mt-0.5 text-[9px] tabular-nums text-oai-gray-400 dark:text-oai-gray-500 truncate">{detail}</div>
    </div>
  );
}
