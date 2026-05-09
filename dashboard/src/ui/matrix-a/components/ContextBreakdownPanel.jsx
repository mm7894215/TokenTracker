import React, { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Info, Loader2 } from "lucide-react";
import { copy } from "../../../lib/copy";
import { formatCompactNumber } from "../../../lib/format";
import { getUsageCategoryBreakdown } from "../../../lib/api";

// We collapse the 7 raw categories from the API into 5 display groups that
// mirror Claude Code's in-CLI /context vocabulary (System prompt / Messages
// / Tool calls / Custom agents / Reasoning). User input, conversation
// history, and assistant replies are all "Messages" in /context — keeping
// them separate here would just be noise.
const DISPLAY_GROUPS = [
  { key: "system_prompt", color: "#64748b", from: ["system_prefix"] },
  { key: "messages", color: "#3b82f6", from: ["user_input", "conversation_history", "assistant_response"] },
  { key: "tool_calls", color: "#8b5cf6", from: ["tool_calls"] },
  { key: "custom_agents", color: "#ec4899", from: ["subagents"] },
  { key: "reasoning", color: "#06b6d4", from: ["reasoning"] },
];

function buildDisplayCategories(rawCategories) {
  const byKey = new Map();
  for (const c of rawCategories || []) byKey.set(c.key, c);
  const groups = DISPLAY_GROUPS.map((g) => {
    const merged = {
      input_tokens: 0,
      cached_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 0,
    };
    for (const src of g.from) {
      const cat = byKey.get(src);
      if (!cat) continue;
      const t = cat.totals || {};
      merged.input_tokens += t.input_tokens || 0;
      merged.cached_input_tokens += t.cached_input_tokens || 0;
      merged.cache_creation_input_tokens += t.cache_creation_input_tokens || 0;
      merged.output_tokens += t.output_tokens || 0;
      merged.reasoning_output_tokens += t.reasoning_output_tokens || 0;
      merged.total_tokens += t.total_tokens || 0;
    }
    return { key: g.key, color: g.color, totals: merged };
  });
  const grand = groups.reduce((a, g) => a + g.totals.total_tokens, 0);
  return groups
    .map((g) => ({
      ...g,
      percent: grand > 0 ? Number(((g.totals.total_tokens / grand) * 100).toFixed(2)) : 0,
    }))
    .sort((a, b) => b.totals.total_tokens - a.totals.total_tokens);
}

function categoryLabel(key) {
  return copy(`dashboard.context_breakdown.category.${key}`);
}

function formatTokens(n) {
  if (!Number.isFinite(Number(n)) || Number(n) <= 0) return "0";
  return formatCompactNumber(Number(n), { decimals: 1 });
}

// Inline Context Breakdown for Claude Code only. Renders bare (no Card
// wrapper) so it can drop into the UsageOverview expanded provider section.
export function ContextBreakdownPanel({ from, to }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getUsageCategoryBreakdown({ from, to, source: "claude" })
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((e) => {
        if (!cancelled) setError(e?.message || String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [from, to]);

  const title = copy("dashboard.context_breakdown.title");

  const Header = (
    <div className="flex items-center gap-2 mb-3">
      <h4 className="text-sm font-medium text-oai-black dark:text-oai-white">{title}</h4>
      {loading ? (
        <Loader2
          size={12}
          className="text-oai-gray-400 dark:text-oai-gray-500 animate-spin"
          aria-label={copy("dashboard.context_breakdown.loading_aria")}
        />
      ) : null}
    </div>
  );

  if (loading && !data) {
    return (
      <div>
        {Header}
        <div className="h-1 w-full bg-oai-gray-100 dark:bg-oai-gray-800 rounded-full overflow-hidden animate-pulse" />
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="h-3 rounded bg-oai-gray-100 dark:bg-oai-gray-800 animate-pulse"
              style={{ animationDelay: `${i * 80}ms` }}
            />
          ))}
        </div>
        <p className="mt-3 text-[11px] text-oai-gray-500 dark:text-oai-gray-400">
          {copy("dashboard.context_breakdown.loading_hint")}
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        {Header}
        <p className="text-xs text-oai-gray-500 dark:text-oai-gray-400">
          {copy("dashboard.context_breakdown.error")}
        </p>
      </div>
    );
  }

  if (!data || data.scope !== "supported" || !data.totals?.total_tokens) {
    return (
      <div>
        {Header}
        <p className="text-xs text-oai-gray-500 dark:text-oai-gray-400">
          {copy("dashboard.context_breakdown.empty")}
        </p>
      </div>
    );
  }

  const total = data.totals.total_tokens;
  const categories = buildDisplayCategories(data.categories || []);

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h4 className="text-sm font-medium text-oai-black dark:text-oai-white">{title}</h4>
        <div className="text-[11px] text-oai-gray-400 dark:text-oai-gray-500 tabular-nums shrink-0">
          {copy("dashboard.context_breakdown.session_count", {
            sessions: data.session_count || 0,
            messages: data.message_count || 0,
          })}
        </div>
      </div>

      <div
        role="img"
        aria-label={copy("dashboard.context_breakdown.bar_aria", {
          summary: categories
            .filter((c) => c.percent > 0)
            .map((c) => `${categoryLabel(c.key)} ${c.percent}%`)
            .join("，"),
        })}
        className="h-1 w-full bg-oai-gray-100 dark:bg-oai-gray-800 rounded-full overflow-hidden flex"
      >
        {categories.map((cat, idx) => {
          if (!cat.percent || cat.percent <= 0) return null;
          const color = cat.color;
          return (
            <motion.div
              key={cat.key}
              initial={{ width: 0 }}
              animate={{ width: `${cat.percent}%` }}
              transition={{ duration: 0.5, delay: 0.1 + idx * 0.04, ease: [0.16, 1, 0.3, 1] }}
              className="h-full"
              style={{ backgroundColor: color }}
              title={`${categoryLabel(cat.key)}: ${cat.percent}%`}
            />
          );
        })}
      </div>

      <ul className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5">
        {categories.map((cat) => {
          const color = cat.color;
          const isSystemPrefix = cat.key === "system_prompt";
          return (
            <li
              key={cat.key}
              className="flex items-center justify-between gap-2 text-xs min-w-0"
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <span
                  className="h-2 w-2 rounded-sm shrink-0"
                  style={{ backgroundColor: color }}
                  aria-hidden="true"
                />
                <span className="text-oai-gray-700 dark:text-oai-gray-300 truncate">
                  {categoryLabel(cat.key)}
                </span>
                {isSystemPrefix ? (
                  <span className="relative inline-flex shrink-0 group">
                    <Info
                      size={11}
                      className="text-oai-gray-400 dark:text-oai-gray-500 cursor-help"
                      aria-hidden="true"
                    />
                    <span
                      role="tooltip"
                      className="pointer-events-none absolute left-1/2 bottom-full z-20 mb-1.5 -translate-x-1/2 w-64 rounded-md border border-oai-gray-200 dark:border-oai-gray-700 bg-oai-white dark:bg-oai-gray-900 px-2.5 py-1.5 text-[11px] leading-snug text-oai-gray-700 dark:text-oai-gray-200 shadow-md opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      {copy("dashboard.context_breakdown.system_prefix_tooltip")}
                    </span>
                  </span>
                ) : null}
              </div>
              <div className="flex items-baseline gap-1.5 tabular-nums shrink-0">
                <span className="text-oai-gray-500 dark:text-oai-gray-400">
                  {formatTokens(cat.totals?.total_tokens || 0)}
                </span>
                <span className="text-oai-black dark:text-oai-white font-medium w-10 text-right">
                  {cat.percent.toFixed(cat.percent < 0.1 && cat.percent > 0 ? 2 : 1)}%
                </span>
              </div>
            </li>
          );
        })}
      </ul>

      <p className="mt-2 text-[10px] text-oai-gray-400 dark:text-oai-gray-500">
        {copy("dashboard.context_breakdown.footnote")}
      </p>
    </div>
  );
}
