import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Info, Loader2 } from "lucide-react";
import { Dialog } from "@base-ui/react/dialog";
import { copy } from "../../../lib/copy";
import { formatCompactNumber } from "../../../lib/format";
import { getUsageCategoryBreakdown } from "../../../lib/api";
import { getBrowserTimeZone, getBrowserTimeZoneOffsetMinutes } from "../../../lib/timezone";

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

const CODEX_DISPLAY_GROUPS = [
  { key: "system_prompt", color: "#64748b" },
  { key: "messages", color: "#3b82f6" },
  { key: "tool_calls", color: "#8b5cf6" },
  { key: "reasoning", color: "#06b6d4" },
];

const TOOL_TABLE_GRID =
  "grid grid-cols-[132px_minmax(220px,1fr)_64px_82px_82px_82px_82px] gap-3";
const MESSAGE_TABLE_GRID =
  "grid grid-cols-[minmax(190px,1fr)_82px_82px_82px_82px] gap-3";
const EXEC_DETAIL_TABS = [
  ["by_type", "dashboard.context_breakdown.exec_details.group_by_type"],
  ["by_executable", "dashboard.context_breakdown.exec_details.group_by_executable"],
  ["by_command", "dashboard.context_breakdown.exec_details.group_by_command"],
  ["by_duration", "dashboard.context_breakdown.exec_details.group_by_duration"],
  ["by_output", "dashboard.context_breakdown.exec_details.group_by_output"],
  ["by_exit", "dashboard.context_breakdown.exec_details.group_by_exit"],
];

function toPositiveNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function scaleTotals(totals, scale) {
  const out = {};
  for (const key of [
    "input_tokens",
    "cached_input_tokens",
    "cache_creation_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
  ]) {
    out[key] = Math.round(Number(totals?.[key] || 0) * scale);
  }
  return out;
}

function normalizeDisplayGroups(groups, referenceTotalTokens = null) {
  const rawGrand = groups.reduce((a, g) => a + Number(g.totals.total_tokens || 0), 0);
  const referenceGrand = toPositiveNumber(referenceTotalTokens);
  const displayGrand = referenceGrand || rawGrand;
  const scale = referenceGrand && rawGrand > 0 ? referenceGrand / rawGrand : 1;

  return groups
    .map((g) => {
      const totals = scale === 1 ? g.totals : scaleTotals(g.totals, scale);
      return {
        ...g,
        totals,
        percent: displayGrand > 0 ? Number(((totals.total_tokens / displayGrand) * 100).toFixed(2)) : 0,
      };
    })
    .sort((a, b) => b.totals.total_tokens - a.totals.total_tokens);
}

function buildDisplayCategories(rawCategories, referenceTotalTokens = null) {
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
  return normalizeDisplayGroups(groups, referenceTotalTokens);
}

function buildCodexDisplayCategories(data, referenceTotalTokens = null) {
  const totals = data?.totals || {};
  const reasoning = Number(totals.reasoning_output_tokens || 0);
  const rawToolTokens = (data?.tool_calls_breakdown?.categories || []).reduce(
    (acc, cat) => {
      if (cat?.name === "Text Response") return acc;
      return acc + Number(cat?.totals?.total_tokens || 0);
    },
    0,
  );
  const total = Number(totals.total_tokens || 0);
  const toolCalls = Math.min(Math.max(0, rawToolTokens), Math.max(0, total - reasoning));
  const messages = Math.max(0, total - reasoning - toolCalls);

  const groups = [
    {
      key: "messages",
      color: CODEX_DISPLAY_GROUPS[1].color,
      totals: { total_tokens: messages },
    },
    {
      key: "tool_calls",
      color: CODEX_DISPLAY_GROUPS[2].color,
      totals: { total_tokens: toolCalls },
    },
    {
      key: "reasoning",
      color: CODEX_DISPLAY_GROUPS[3].color,
      totals: { total_tokens: reasoning },
    },
  ];
  return normalizeDisplayGroups(groups, referenceTotalTokens);
}

function categoryLabel(key) {
  return copy(`dashboard.context_breakdown.category.${key}`);
}

function formatTokens(n) {
  if (!Number.isFinite(Number(n)) || Number(n) <= 0) return "0";
  return formatCompactNumber(Number(n), { decimals: 1 });
}

function formatToolDisplayName(name) {
  if (typeof name !== "string") return "";
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    return parts.slice(2).join("__") || name;
  }
  if (name.includes("/")) {
    const shortName = name.split("/").pop();
    return shortName || name;
  }
  return name;
}

function normalizeToolRows(toolRows) {
  return (Array.isArray(toolRows) ? toolRows : [])
    .map((row) => {
      const totals = row?.totals || null;
      const inputTokens = totals ? Number(totals.input_tokens || 0) : Number(row?.input_tokens || 0);
      const outputTokens = totals ? Number(totals.output_tokens || 0) : Number(row?.output_tokens || 0);
      const cacheRead = totals ? Number(totals.cached_input_tokens || 0) : Number(row?.cache_read || 0);
      const cacheCreation = totals
        ? Number(totals.cache_creation_input_tokens || 0)
        : Number(row?.cache_creation || 0);
      const totalTokens = totals
        ? Number(totals.total_tokens || inputTokens + outputTokens)
        : Number(row?.total_tokens || outputTokens);
      return {
        name: formatToolDisplayName(row?.name ? String(row.name) : ""),
        calls: totals ? Number(row?.calls || 0) : Number(row?.calls || 0),
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read: cacheRead,
        cache_creation: cacheCreation,
        total_tokens: Number(totalTokens || 0),
      };
    })
    .filter((r) => r.name)
    .sort((a, b) => (b.total_tokens || 0) - (a.total_tokens || 0));
}

function normalizeCategoryRows(categoryRows) {
  return (Array.isArray(categoryRows) ? categoryRows : [])
    .map((cat) => {
      const totals = cat?.totals || {};
      const tools = Array.isArray(cat?.tools) ? cat.tools : [];
      const inputTokens = Number(totals.input_tokens || 0);
      const outputTokens = Number(totals.output_tokens || 0);
      const cachedInputTokens = Number(totals.cached_input_tokens || 0);
      const cacheCreationInputTokens = Number(totals.cache_creation_input_tokens || 0);
      return {
        name: cat?.name ? String(cat.name) : "",
        calls: Number(cat?.calls || 0),
        totals: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cached_input_tokens: cachedInputTokens,
          cache_creation_input_tokens: cacheCreationInputTokens,
          total_tokens: Number(totals.total_tokens || inputTokens + outputTokens),
        },
        tools: normalizeToolRows(tools),
        toolCount: tools.length,
      };
    })
    .filter((c) => c.name)
    .sort((a, b) => (b.totals.total_tokens || 0) - (a.totals.total_tokens || 0));
}

function normalizeMessageRows(messageRows) {
  return (Array.isArray(messageRows) ? messageRows : [])
    .map((row) => {
      const totals = row?.totals || {};
      const inputTokens = Number(totals.input_tokens || 0);
      const outputTokens = Number(totals.output_tokens || 0);
      const cachedInputTokens = Number(totals.cached_input_tokens || 0);
      const cacheCreationInputTokens = Number(totals.cache_creation_input_tokens || 0);
      return {
        key: row?.key ? String(row.key) : "",
        name: row?.name ? String(row.name) : "",
        totals: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cached_input_tokens: cachedInputTokens,
          cache_creation_input_tokens: cacheCreationInputTokens,
          total_tokens: Number(totals.total_tokens || inputTokens + outputTokens + cachedInputTokens + cacheCreationInputTokens),
        },
      };
    })
    .filter((row) => row.key || row.name)
    .sort((a, b) => (b.totals.total_tokens || 0) - (a.totals.total_tokens || 0));
}

function normalizeSkillRows(skillRows) {
  return (Array.isArray(skillRows) ? skillRows : [])
    .map((row) => {
      const totals = row?.totals || {};
      return {
        name: row?.name ? String(row.name) : "",
        calls: Number(row?.calls || 0),
        total_tokens: Number(totals.total_tokens || 0),
      };
    })
    .filter((row) => row.name)
    .sort((a, b) => Number(b.total_tokens || 0) - Number(a.total_tokens || 0));
}

function messageLabel(row) {
  if (row?.key) {
    const label = copy(`dashboard.context_breakdown.message_details.${row.key}`);
    if (label && !label.includes("dashboard.context_breakdown")) return label;
  }
  return row?.name || "";
}

function normalizeExecRows(execRows) {
  return (Array.isArray(execRows) ? execRows : [])
    .map((row) => {
      const totals = row?.totals || {};
      const inputTokens = Number(totals.input_tokens || 0);
      const outputTokens = Number(totals.output_tokens || 0);
      const cachedInputTokens = Number(totals.cached_input_tokens || 0);
      const cacheCreationInputTokens = Number(totals.cache_creation_input_tokens || 0);
      return {
        name: row?.name ? String(row.name) : "",
        calls: Number(row?.calls || 0),
        failures: Number(row?.failures || 0),
        duration_ms: Number(row?.duration_ms || 0),
        max_duration_ms: Number(row?.max_duration_ms || 0),
        output_chars: Number(row?.output_chars || 0),
        output_lines: Number(row?.output_lines || 0),
        totals: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cached_input_tokens: cachedInputTokens,
          cache_creation_input_tokens: cacheCreationInputTokens,
          total_tokens: Number(totals.total_tokens || inputTokens + outputTokens),
        },
      };
    })
    .filter((r) => r.name)
    .sort((a, b) => Number(b.totals.total_tokens || 0) - Number(a.totals.total_tokens || 0));
}

function formatDuration(ms) {
  const n = Number(ms || 0);
  if (!Number.isFinite(n) || n <= 0) return "0ms";
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)}s`;
  return `${Math.round(n / 1000)}s`;
}

function selectedExecRows(execDetails, selectedExecKey) {
  if (!execDetails) return [];
  if (selectedExecKey === "by_executable") return execDetails.by_executable || [];
  if (selectedExecKey === "by_command") return execDetails.by_command || [];
  if (selectedExecKey === "by_duration") return execDetails.by_duration || [];
  if (selectedExecKey === "by_output") return execDetails.by_output || [];
  if (selectedExecKey === "by_exit") return execDetails.by_exit || [];
  return execDetails.by_type || [];
}

function isExecToolName(name) {
  return name === "exec_command" || name === "Bash";
}

function sourceEmptyCopyKey(source) {
  return source === "codex" ? "dashboard.context_breakdown.empty_codex" : "dashboard.context_breakdown.empty";
}

function sourceErrorCopyKey(source) {
  return source === "codex" ? "dashboard.context_breakdown.error_codex" : "dashboard.context_breakdown.error";
}

function sourceFootnoteCopyKey(source) {
  return source === "codex" ? "dashboard.context_breakdown.footnote_codex" : "dashboard.context_breakdown.footnote";
}

// Inline Context Breakdown for Claude Code only. Renders bare (no Card
// wrapper) so it can drop into the UsageOverview expanded provider section.
export function ContextBreakdownPanel({ from, to, source = "claude", referenceTotalTokens = null }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedToolKey, setSelectedToolKey] = useState(null); // "tool_calls" | "subagents"
  const [selectedExecKey, setSelectedExecKey] = useState(null); // "by_type" | "by_exit"
  const [messageDetailsOpen, setMessageDetailsOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getUsageCategoryBreakdown({
      from,
      to,
      source,
      timeZone: getBrowserTimeZone(),
      tzOffsetMinutes: getBrowserTimeZoneOffsetMinutes(),
    })
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
  }, [from, to, source]);

  const title = copy("dashboard.context_breakdown.title");
  const sourceLabel = copy(`dashboard.context_breakdown.source_label.${source}`);

  const Header = (
    <div className="flex items-center gap-2 mb-3">
      <h4 className="text-sm font-medium text-oai-black dark:text-oai-white">{title}</h4>
      <span className="text-[10px] px-1.5 py-0.5 rounded-md border border-oai-gray-200 dark:border-oai-gray-700 text-oai-gray-500 dark:text-oai-gray-400 uppercase tracking-wide">
        {sourceLabel}
      </span>
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
          {copy(sourceErrorCopyKey(source))}
        </p>
      </div>
    );
  }

  if (!data || data.scope !== "supported" || !data.totals?.total_tokens) {
    return (
      <div>
        {Header}
        <p className="text-xs text-oai-gray-500 dark:text-oai-gray-400">
          {copy(sourceEmptyCopyKey(source))}
        </p>
      </div>
    );
  }

  const categories =
    source === "claude"
      ? buildDisplayCategories(data.categories || [], referenceTotalTokens)
      : buildCodexDisplayCategories(data, referenceTotalTokens);
  const toolDetails = data.tool_calls_breakdown || null;
  const skillsDetails = data.skills_breakdown || null;
  const messageDetails = data.message_breakdown || null;
  const configuredResources = data.configured_resources || null;
  const execDetails = data.exec_command_breakdown || null;
  const skillRows = normalizeSkillRows(skillsDetails?.skills || []);

  const selectedToolSet =
    selectedToolKey === "tool_calls"
      ? toolDetails?.tool_calls || toolDetails
      : selectedToolKey === "subagents"
      ? toolDetails?.subagents
      : null;
  const codexQueueFallback = source === "codex" && (data?.breakdown_status === "queue_fallback" || data?.fallback === "queue_totals");
  const selectedToolCategories = normalizeCategoryRows(selectedToolSet?.categories || []);
  const messageRows = normalizeMessageRows(messageDetails?.categories || []);
  const toolDetailsRows = [];
  for (const cat of selectedToolCategories) {
    const toolCount = cat.toolCount || 0;
    const isExecCategory = selectedToolKey === "tool_calls" && cat.name === "Execution" && execDetails;
    const hasExecToolRow =
      isExecCategory && (cat.tools || []).some((t) => {
        return isExecToolName(t?.name);
      });

    toolDetailsRows.push(
      <div
        key={`${cat.name}::cat`}
        role="row"
        className={`${TOOL_TABLE_GRID} py-2`}
        title={cat.name}
      >
        <span role="cell" className="min-w-0 text-body-sm font-medium text-oai-black dark:text-oai-white truncate">
          {cat.name}
        </span>
        <span role="cell" className="min-w-0 text-body-sm text-oai-gray-500 dark:text-oai-gray-400 truncate">
          {toolCount === 1
            ? cat.tools?.[0]?.name || ""
            : copy("dashboard.context_breakdown.tool_details.tools_count_parens", { count: toolCount })}
        </span>
        <span role="cell" className="text-right text-body-sm tabular-nums text-oai-gray-700 dark:text-oai-gray-300">
          {formatCompactNumber(cat.calls || 0)}
        </span>
        <span role="cell" className="text-right text-body-sm tabular-nums text-oai-gray-700 dark:text-oai-gray-300">
          {formatTokens(cat.totals.input_tokens || 0)}
        </span>
        <span role="cell" className="text-right text-body-sm tabular-nums text-oai-gray-700 dark:text-oai-gray-300">
          {formatTokens(cat.totals.output_tokens || 0)}
        </span>
        <span role="cell" className="text-right text-body-sm tabular-nums text-oai-gray-700 dark:text-oai-gray-300">
          {formatTokens(
            Number(cat.totals.cached_input_tokens || 0) +
              Number(cat.totals.cache_creation_input_tokens || 0),
          )}
        </span>
        <span role="cell" className="text-right text-body-sm tabular-nums text-oai-gray-700 dark:text-oai-gray-300">
          {formatTokens(cat.totals.total_tokens || 0)}
        </span>
      </div>,
    );

    if (toolCount > 0) {
      for (const row of cat.tools) {
        const isExecTool = isExecCategory && isExecToolName(row.name);
        toolDetailsRows.push(
          <div
            key={`${cat.name}::${row.name}`}
            role="row"
            className={`${TOOL_TABLE_GRID} py-2`}
            title={row.name}
          >
            <span role="cell" />
            <span role="cell" className="min-w-0 text-body-sm font-medium text-oai-black dark:text-oai-white truncate">
              {isExecTool ? (
                <button
                  type="button"
                  onClick={() => setSelectedExecKey("by_type")}
                  className="text-left text-oai-brand hover:text-oai-brand/80 underline decoration-oai-brand/30 underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand/40 rounded-sm truncate"
                >
                  {"└─ "}
                  {row.name}
                </button>
              ) : (
                <>
                  {"└─ "}
                  {row.name}
                </>
              )}
            </span>
            <span role="cell" className="text-right text-body-sm tabular-nums text-oai-gray-700 dark:text-oai-gray-300">
              {formatCompactNumber(row.calls || 0)}
            </span>
            <span role="cell" className="text-right text-body-sm tabular-nums text-oai-gray-700 dark:text-oai-gray-300">
              {formatTokens(row.input_tokens || 0)}
            </span>
            <span role="cell" className="text-right text-body-sm tabular-nums text-oai-gray-700 dark:text-oai-gray-300">
              {formatTokens(row.output_tokens || 0)}
            </span>
            <span role="cell" className="text-right text-body-sm tabular-nums text-oai-gray-700 dark:text-oai-gray-300">
              {formatTokens((row.cache_read || 0) + (row.cache_creation || 0))}
            </span>
            <span role="cell" className="text-right text-body-sm tabular-nums text-oai-gray-700 dark:text-oai-gray-300">
              {formatTokens(row.total_tokens || 0)}
            </span>
          </div>,
        );
      }
    }

    if (isExecCategory && !hasExecToolRow) {
      toolDetailsRows.push(
        <div key={`${cat.name}::exec-link`} className="mt-2 mb-1">
          <button
            type="button"
            onClick={() => setSelectedExecKey("by_type")}
            className="text-xs font-medium text-oai-brand hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand/40 rounded-sm"
          >
            {copy("dashboard.context_breakdown.exec_details.open")}
          </button>
        </div>,
      );
    }
  }

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <h4 className="text-sm font-medium text-oai-black dark:text-oai-white">{title}</h4>
          <span className="text-[10px] px-1.5 py-0.5 rounded-md border border-oai-gray-200 dark:border-oai-gray-700 text-oai-gray-500 dark:text-oai-gray-400 uppercase tracking-wide shrink-0">
            {sourceLabel}
          </span>
        </div>
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
          const isClickable = cat.key === "messages" || cat.key === "tool_calls" || cat.key === "custom_agents";
          return (
            <li
              key={cat.key}
              className="flex items-center justify-between gap-2 text-xs min-w-0"
            >
              <button
                type="button"
                onClick={() => {
                  if (!isClickable) return;
                  if (cat.key === "messages") {
                    setMessageDetailsOpen(true);
                    return;
                  }
                  setSelectedToolKey(cat.key === "tool_calls" ? "tool_calls" : "subagents");
                }}
                className={
                  "flex items-center gap-1.5 min-w-0 text-left group " +
                  (isClickable
                    ? "cursor-pointer hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand/40 rounded-sm"
                    : "cursor-default")
                }
                aria-label={
                  cat.key === "messages"
                    ? copy("dashboard.context_breakdown.message_details.title")
                    : isClickable
                    ? copy("dashboard.context_breakdown.tool_details.title")
                    : undefined
                }
              >
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
              </button>
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
        {copy(sourceFootnoteCopyKey(source))}
      </p>
      {codexQueueFallback ? (
        <p className="mt-2 text-[11px] text-oai-gray-500 dark:text-oai-gray-400">
          {copy("dashboard.context_breakdown.tool_details.unavailable_codex")}
        </p>
      ) : null}

      <Dialog.Root
        open={messageDetailsOpen}
        onOpenChange={(open) => {
          setMessageDetailsOpen(open);
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-[102] bg-black/40 backdrop-blur-[1px]" />
          <Dialog.Viewport className="fixed inset-0 z-[103] flex items-center justify-center p-4">
            <Dialog.Popup className="relative w-full max-w-[min(94vw,760px)] max-h-[calc(100vh-2rem)] rounded-2xl bg-oai-white dark:bg-oai-gray-950 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.25)] dark:shadow-[0_20px_60px_-10px_rgba(0,0,0,0.65)] ring-1 ring-oai-gray-200 dark:ring-oai-gray-800 overflow-hidden">
              <Dialog.Title render={<h2 className="sr-only" />}>
                {copy("dashboard.context_breakdown.message_details.title")}
              </Dialog.Title>

              <div className="px-4 py-3 border-b border-oai-gray-200 dark:border-oai-gray-800 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-oai-black dark:text-oai-white truncate">
                    {copy("dashboard.context_breakdown.message_details.title")}
                  </p>
                  <p className="text-[11px] text-oai-gray-500 dark:text-oai-gray-400 tabular-nums">
                    {copy("dashboard.context_breakdown.message_details.note")}
                  </p>
                </div>
                <Dialog.Close
                  type="button"
                  className="shrink-0 h-9 px-3 rounded-md text-xs font-medium text-oai-gray-700 dark:text-oai-gray-200 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand/40 transition-colors"
                  aria-label={copy("dashboard.context_breakdown.tool_details.close")}
                >
                  {copy("dashboard.context_breakdown.tool_details.close")}
                </Dialog.Close>
              </div>

              <div className="px-4 py-3 max-h-[calc(100vh-9rem)] overflow-y-auto oai-scrollbar">
                {messageRows.length === 0 ? (
                  <p className="text-xs text-oai-gray-500 dark:text-oai-gray-400">
                    {copy(sourceEmptyCopyKey(source))}
                  </p>
                ) : (
                  <div className="overflow-x-auto oai-scrollbar">
                    <div role="table" aria-label={copy("dashboard.context_breakdown.message_details.title")} className="min-w-[640px]">
                      <div
                        role="row"
                        className={`${MESSAGE_TABLE_GRID} py-2 mb-2 border-b border-oai-gray-200 dark:border-oai-gray-800 text-label uppercase text-oai-gray-500 dark:text-oai-gray-400`}
                      >
                        <span role="columnheader">{copy("dashboard.context_breakdown.message_details.category_column")}</span>
                        <span role="columnheader" className="text-right">
                          {copy("dashboard.context_breakdown.tool_details.input_column")}
                        </span>
                        <span role="columnheader" className="text-right">
                          {copy("dashboard.context_breakdown.tool_details.output_tokens")}
                        </span>
                        <span role="columnheader" className="text-right">
                          {copy("dashboard.context_breakdown.tool_details.cache_column")}
                        </span>
                        <span role="columnheader" className="text-right">
                          {copy("dashboard.context_breakdown.tool_details.total_column")}
                        </span>
                      </div>
                      {messageRows.map((row) => (
                          <div
                            key={row.key || row.name}
                            role="row"
                            className={`${MESSAGE_TABLE_GRID} py-2`}
                            title={messageLabel(row)}
                          >
                            <span role="cell" className="min-w-0 text-body-sm font-medium text-oai-black dark:text-oai-white truncate">
                              {messageLabel(row)}
                            </span>
                            <span role="cell" className="text-right text-body-sm tabular-nums text-oai-gray-700 dark:text-oai-gray-300">
                              {formatTokens(row.totals.input_tokens || 0)}
                            </span>
                            <span role="cell" className="text-right text-body-sm tabular-nums text-oai-gray-700 dark:text-oai-gray-300">
                              {formatTokens(row.totals.output_tokens || 0)}
                            </span>
                            <span role="cell" className="text-right text-body-sm tabular-nums text-oai-gray-700 dark:text-oai-gray-300">
                              {formatTokens(
                                Number(row.totals.cached_input_tokens || 0) +
                                  Number(row.totals.cache_creation_input_tokens || 0),
                              )}
                            </span>
                            <span role="cell" className="text-right text-body-sm tabular-nums text-oai-gray-700 dark:text-oai-gray-300">
                              {formatTokens(row.totals.total_tokens || 0)}
                            </span>
                          </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </Dialog.Popup>
          </Dialog.Viewport>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={Boolean(selectedToolKey)}
        onOpenChange={(open) => {
          if (!open) setSelectedToolKey(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-[102] bg-black/40 backdrop-blur-[1px]" />
          <Dialog.Viewport className="fixed inset-0 z-[103] flex items-center justify-center p-4">
            <Dialog.Popup className="relative w-full max-w-[min(96vw,980px)] max-h-[calc(100vh-2rem)] rounded-2xl bg-oai-white dark:bg-oai-gray-950 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.25)] dark:shadow-[0_20px_60px_-10px_rgba(0,0,0,0.65)] ring-1 ring-oai-gray-200 dark:ring-oai-gray-800 overflow-hidden">
              <Dialog.Title render={<h2 className="sr-only" />}>
                {copy("dashboard.context_breakdown.tool_details.title")}
              </Dialog.Title>

              <div className="px-4 py-3 border-b border-oai-gray-200 dark:border-oai-gray-800 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-oai-black dark:text-oai-white truncate">
                    {copy("dashboard.context_breakdown.tool_details.title")}
                  </p>
                  <p className="text-[11px] text-oai-gray-500 dark:text-oai-gray-400 tabular-nums">
                    {copy("dashboard.context_breakdown.tool_details.total_calls", {
                      calls: selectedToolSet?.total_calls || 0,
                    })}
                  </p>
                </div>
                <Dialog.Close
                  type="button"
                  className="shrink-0 h-9 px-3 rounded-md text-xs font-medium text-oai-gray-700 dark:text-oai-gray-200 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand/40 transition-colors"
                  aria-label={copy("dashboard.context_breakdown.tool_details.close")}
                >
                  {copy("dashboard.context_breakdown.tool_details.close")}
                </Dialog.Close>
              </div>

              <div className="px-4 py-3 max-h-[calc(100vh-9rem)] overflow-y-auto oai-scrollbar">
                {selectedToolCategories.length === 0 ? (
                  <p className="text-xs text-oai-gray-500 dark:text-oai-gray-400">
                    {source === "codex" && codexQueueFallback
                      ? copy("dashboard.context_breakdown.tool_details.unavailable_codex")
                      : copy(sourceEmptyCopyKey(source))}
                  </p>
                ) : (
                  <div className="overflow-x-auto oai-scrollbar">
                  <div role="table" aria-label={copy("dashboard.context_breakdown.tool_details.title")} className="min-w-[720px]">
                    <div
                      role="row"
                      className={`${TOOL_TABLE_GRID} py-2 mb-2 border-b border-oai-gray-200 dark:border-oai-gray-800 text-label uppercase text-oai-gray-500 dark:text-oai-gray-400`}
                    >
                      <span role="columnheader">{copy("dashboard.context_breakdown.tool_details.category_column")}</span>
                      <span role="columnheader">{copy("dashboard.context_breakdown.tool_details.tool_column")}</span>
                      <span role="columnheader" className="text-right">
                        {copy("dashboard.context_breakdown.tool_details.calls_column")}
                      </span>
                      <span role="columnheader" className="text-right">
                        {copy("dashboard.context_breakdown.tool_details.input_column")}
                      </span>
                      <span role="columnheader" className="text-right">
                        {copy("dashboard.context_breakdown.tool_details.output_tokens")}
                      </span>
                      <span role="columnheader" className="text-right">
                        {copy("dashboard.context_breakdown.tool_details.cache_column")}
                      </span>
                      <span role="columnheader" className="text-right">
                        {copy("dashboard.context_breakdown.tool_details.total_column")}
                      </span>
                    </div>
                    {toolDetailsRows}
                  </div>
                  </div>
                )}

                {skillRows.length ? (
                  <div className="mt-4 pt-3 border-t border-oai-gray-200 dark:border-oai-gray-800">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-[11px] font-medium uppercase text-oai-gray-500 dark:text-oai-gray-400">
                        {copy("dashboard.context_breakdown.skills_details.title")}
                      </p>
                      <p className="text-[11px] text-oai-gray-500 dark:text-oai-gray-400 tabular-nums">
                        {copy("dashboard.context_breakdown.skills_details.total_calls", {
                          calls: skillsDetails?.total_calls || skillRows.length,
                        })}
                      </p>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {skillRows.slice(0, 12).map((skill) => (
                        <span
                          key={skill.name}
                          className="inline-flex max-w-full items-center gap-1 rounded-md border border-oai-gray-200 dark:border-oai-gray-800 px-2 py-1 text-[11px] text-oai-gray-700 dark:text-oai-gray-200"
                          title={skill.name}
                        >
                          <span className="truncate max-w-[180px]">{skill.name}</span>
                          <span className="text-oai-gray-400 dark:text-oai-gray-500 tabular-nums">
                            {formatTokens(skill.total_tokens)}
                          </span>
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}

                {configuredResources ? (
                  <div className="mt-4 pt-3 border-t border-oai-gray-200 dark:border-oai-gray-800">
                    <p className="text-[11px] text-oai-gray-500 dark:text-oai-gray-400">
                      {formatCompactNumber(configuredResources.skills_count || 0)} skills ·{" "}
                      {formatCompactNumber(configuredResources.mcp_servers_count || 0)} MCP servers ·{" "}
                      {formatCompactNumber(configuredResources.custom_agents_count || 0)} agents ·{" "}
                      {formatCompactNumber(configuredResources.memory_files_count || 0)} memory files
                    </p>
                  </div>
                ) : null}
              </div>
            </Dialog.Popup>
          </Dialog.Viewport>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={Boolean(selectedExecKey)}
        onOpenChange={(open) => {
          if (!open) setSelectedExecKey(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-[104] bg-black/40 backdrop-blur-[1px]" />
          <Dialog.Viewport className="fixed inset-0 z-[105] flex items-center justify-center p-4">
            <Dialog.Popup className="relative w-full max-w-[720px] max-h-[calc(100vh-2rem)] rounded-2xl bg-oai-white dark:bg-oai-gray-950 shadow-lg dark:shadow-2xl ring-1 ring-oai-gray-200 dark:ring-oai-gray-800 overflow-hidden">
              <Dialog.Title render={<h2 className="sr-only" />}>
                {copy("dashboard.context_breakdown.exec_details.title")}
              </Dialog.Title>

              <div className="px-4 py-3 border-b border-oai-gray-200 dark:border-oai-gray-800 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-oai-black dark:text-oai-white truncate">
                    {copy("dashboard.context_breakdown.exec_details.title")}
                  </p>
                  <p className="text-[11px] text-oai-gray-500 dark:text-oai-gray-400 tabular-nums">
                    {copy("dashboard.context_breakdown.exec_details.note")}
                  </p>
                </div>
                {execDetails ? (
                  <div className="flex max-w-[min(62vw,560px)] flex-wrap items-center gap-1 rounded-md bg-oai-gray-100 dark:bg-oai-gray-900 p-1">
                    {EXEC_DETAIL_TABS.map(([key, labelKey]) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setSelectedExecKey(key)}
                        className={
                          "h-8 px-2.5 rounded-md text-xs font-medium transition-colors " +
                          (selectedExecKey === key
                            ? "bg-oai-white dark:bg-oai-gray-800 text-oai-black dark:text-oai-white shadow-sm"
                            : "text-oai-gray-600 dark:text-oai-gray-300 hover:bg-oai-white/70 dark:hover:bg-oai-gray-800/70")
                        }
                      >
                        {copy(labelKey)}
                      </button>
                    ))}
                  </div>
                ) : null}
                <Dialog.Close
                  type="button"
                  className="shrink-0 h-9 px-3 rounded-md text-xs font-medium text-oai-gray-700 dark:text-oai-gray-200 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand/40 transition-colors"
                  aria-label={copy("dashboard.context_breakdown.tool_details.close")}
                >
                  {copy("dashboard.context_breakdown.tool_details.close")}
                </Dialog.Close>
              </div>

              <div className="px-4 py-3 max-h-[calc(100vh-9rem)] overflow-y-auto oai-scrollbar">
                {!execDetails ? (
                  <p className="text-xs text-oai-gray-500 dark:text-oai-gray-400">
                    {copy(sourceEmptyCopyKey(source))}
                  </p>
                ) : (
                  <div role="table" aria-label={copy("dashboard.context_breakdown.exec_details.title")}>
                    <div
                      role="row"
                      className="grid grid-cols-[minmax(0,1fr)_64px_64px_96px_96px_88px_88px] gap-3 py-2 mb-2 border-b border-oai-gray-200 dark:border-oai-gray-800 text-label uppercase text-oai-gray-500 dark:text-oai-gray-400"
                    >
                      <span role="columnheader">{copy("dashboard.context_breakdown.exec_details.kind_column")}</span>
                      <span role="columnheader" className="text-right">
                        {copy("dashboard.context_breakdown.exec_details.calls_column")}
                      </span>
                      <span role="columnheader" className="text-right">
                        {copy("dashboard.context_breakdown.exec_details.failures_column")}
                      </span>
                      <span role="columnheader" className="text-right">
                        {copy("dashboard.context_breakdown.exec_details.duration_column")}
                      </span>
                      <span role="columnheader" className="text-right">
                        {copy("dashboard.context_breakdown.exec_details.max_duration_column")}
                      </span>
                      <span role="columnheader" className="text-right">
                        {copy("dashboard.context_breakdown.tool_details.total_column")}
                      </span>
                      <span role="columnheader" className="text-right">
                        {copy("dashboard.context_breakdown.exec_details.output_column")}
                      </span>
                    </div>

                    {normalizeExecRows(selectedExecRows(execDetails, selectedExecKey)).map((row) => (
                      <div
                        key={row.name}
                        role="row"
                        className="grid grid-cols-[minmax(0,1fr)_64px_64px_96px_96px_88px_88px] gap-3 py-2"
                        title={row.name}
                      >
                        <span role="cell" className="min-w-0 text-body-sm font-medium text-oai-black dark:text-oai-white truncate">
                          {row.name}
                        </span>
                        <span role="cell" className="text-right text-body-sm tabular-nums text-oai-gray-700 dark:text-oai-gray-300">
                          {formatCompactNumber(row.calls || 0)}
                        </span>
                        <span role="cell" className="text-right text-body-sm tabular-nums text-oai-gray-700 dark:text-oai-gray-300">
                          {formatCompactNumber(row.failures || 0)}
                        </span>
                        <span role="cell" className="text-right text-body-sm tabular-nums text-oai-gray-700 dark:text-oai-gray-300">
                          {formatDuration(row.duration_ms || 0)}
                        </span>
                        <span role="cell" className="text-right text-body-sm tabular-nums text-oai-gray-700 dark:text-oai-gray-300">
                          {formatDuration(row.max_duration_ms || 0)}
                        </span>
                        <span role="cell" className="text-right text-body-sm tabular-nums text-oai-gray-700 dark:text-oai-gray-300">
                          {formatTokens(row.totals.total_tokens || 0)}
                        </span>
                        <span role="cell" className="text-right text-body-sm tabular-nums text-oai-gray-700 dark:text-oai-gray-300">
                          {formatCompactNumber(row.output_lines || 0)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Dialog.Popup>
          </Dialog.Viewport>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
