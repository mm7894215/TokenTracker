import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronRight, Info } from "lucide-react";
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

const EXEC_DETAIL_TABS = [
  ["by_type", "dashboard.context_breakdown.exec_details.group_by_type"],
  ["by_executable", "dashboard.context_breakdown.exec_details.group_by_executable"],
  ["by_command", "dashboard.context_breakdown.exec_details.group_by_command"],
  ["by_duration", "dashboard.context_breakdown.exec_details.group_by_duration"],
  ["by_output", "dashboard.context_breakdown.exec_details.group_by_output"],
  ["by_exit", "dashboard.context_breakdown.exec_details.group_by_exit"],
];

// Shared animation config for all disclosure panels
const DISCLOSURE_TRANSITION = { duration: 0.18, ease: [0.4, 0, 0.2, 1] };
const DISCLOSURE_INITIAL = { height: 0, opacity: 0 };
const DISCLOSURE_ANIMATE = { height: "auto", opacity: 1 };
const DISCLOSURE_EXIT = { height: 0, opacity: 0 };

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

function selectedExecRows(execDetails, selectedExecTab) {
  if (!execDetails) return [];
  if (selectedExecTab === "by_executable") return execDetails.by_executable || [];
  if (selectedExecTab === "by_command") return execDetails.by_command || [];
  if (selectedExecTab === "by_duration") return execDetails.by_duration || [];
  if (selectedExecTab === "by_output") return execDetails.by_output || [];
  if (selectedExecTab === "by_exit") return execDetails.by_exit || [];
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

// Row — unified grid-aligned row primitive used at every level of the panel.
// Three columns: [label area | tokens (right-aligned) | percent (right-aligned)].
// All rows left-align to the same X — the leading icon slot (color square /
// transparent spacer) is fixed-width so labels at every depth line up. Depth
// is communicated by colorSquare presence and font weight, not indentation.
const ICON_SLOT_PX = 10; // 8px square + 2px breathing room before label gap

function Row({
  level = 0, // kept for legacy callers; visual depth comes from colorSquare/tone, not padding
  colorSquare = null,
  label,
  labelSuffix = null,
  labelTone = "default",
  hasChevron = false,
  open = false,
  onToggle,
  tokens,
  percent = null,
  children,
}) {
  const labelClass =
    labelTone === "accent"
      ? "text-oai-brand truncate"
      : labelTone === "muted"
      ? "text-oai-gray-500 dark:text-oai-gray-400 truncate"
      : labelTone === "strong"
      ? "font-medium text-oai-black dark:text-oai-white truncate"
      : "text-oai-gray-700 dark:text-oai-gray-300 truncate";

  // Icon slot is always the same width — colorSquare or a transparent spacer.
  const iconSlot = (
    <span
      className="shrink-0 flex items-center justify-start"
      style={{ width: ICON_SLOT_PX }}
      aria-hidden={!colorSquare}
    >
      {colorSquare}
    </span>
  );

  const labelInner = (
    <>
      {iconSlot}
      <span className={labelClass}>{label}</span>
      {labelSuffix}
      {hasChevron && (
        <motion.span
          animate={{ rotate: open ? 90 : 0 }}
          transition={{ duration: 0.15 }}
          className="shrink-0 text-oai-gray-400 dark:text-oai-gray-500 flex items-center"
          aria-hidden="true"
        >
          <ChevronRight size={11} />
        </motion.span>
      )}
    </>
  );

  return (
    <li className="min-w-0">
      <div className="grid grid-cols-[minmax(0,1fr)_64px_48px] items-center gap-2 text-xs py-0.5">
        {hasChevron ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className="flex items-center gap-1.5 min-w-0 text-left cursor-pointer hover:opacity-90 focus-visible:outline-none focus-visible:ring-inset focus-visible:ring-2 focus-visible:ring-oai-brand/40 rounded-sm"
          >
            {labelInner}
          </button>
        ) : (
          <div className="flex items-center gap-1.5 min-w-0">{labelInner}</div>
        )}
        <span className="text-right tabular-nums text-oai-gray-500 dark:text-oai-gray-400">
          {tokens || ""}
        </span>
        <span className="text-right tabular-nums text-oai-black dark:text-oai-white font-medium">
          {percent || ""}
        </span>
      </div>
      {hasChevron && children ? (
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              key="content"
              initial={DISCLOSURE_INITIAL}
              animate={DISCLOSURE_ANIMATE}
              exit={DISCLOSURE_EXIT}
              transition={DISCLOSURE_TRANSITION}
              style={{ overflow: "hidden" }}
            >
              {children}
            </motion.div>
          )}
        </AnimatePresence>
      ) : null}
    </li>
  );
}

// Inline exec command drill-down — tab strip + table, no modal.
// Claude's logs only carry the dispatched command text — exit code, duration,
// and output size live on the Codex side. We hide those columns when
// `source === "claude"` so the user doesn't see five "0"s for every row.
function ExecDrillDown({ execDetails, source = "claude" }) {
  const [activeTab, setActiveTab] = useState("by_type");
  const rows = normalizeExecRows(selectedExecRows(execDetails, activeTab));
  const showRuntime = source === "codex";
  const gridCols = showRuntime
    ? "grid-cols-[minmax(0,1fr)_48px_48px_72px_72px_60px_60px]"
    : "grid-cols-[minmax(0,1fr)_56px_60px]";

  return (
    <div className="mt-2 ml-4">
      {/* Tab strip */}
      <div className="flex flex-wrap items-center gap-1 rounded-md bg-oai-gray-100 dark:bg-oai-gray-900 p-1 w-fit max-w-full">
        {EXEC_DETAIL_TABS.map(([key, labelKey]) => (
          <button
            key={key}
            type="button"
            onClick={() => setActiveTab(key)}
            className={
              "h-7 px-2 rounded-md text-[10px] font-medium transition-colors " +
              (activeTab === key
                ? "bg-oai-white dark:bg-oai-gray-800 text-oai-black dark:text-oai-white shadow-sm"
                : "text-oai-gray-600 dark:text-oai-gray-300 hover:bg-oai-white/70 dark:hover:bg-oai-gray-800/70")
            }
          >
            {copy(labelKey)}
          </button>
        ))}
      </div>

      {/* Table */}
      {rows.length === 0 ? (
        <p className="mt-2 text-[10px] text-oai-gray-400 dark:text-oai-gray-500">—</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <div
            role="table"
            aria-label={copy("dashboard.context_breakdown.exec_details.title")}
            className={showRuntime ? "min-w-[420px]" : "min-w-[260px]"}
          >
            <div
              role="row"
              className={`grid ${gridCols} gap-2 py-1.5 mb-1 border-b border-oai-gray-200 dark:border-oai-gray-800 text-label uppercase text-oai-gray-500 dark:text-oai-gray-400`}
            >
              <span role="columnheader">{copy("dashboard.context_breakdown.exec_details.kind_column")}</span>
              <span role="columnheader" className="text-right">{copy("dashboard.context_breakdown.exec_details.calls_column")}</span>
              {showRuntime && (
                <>
                  <span role="columnheader" className="text-right">{copy("dashboard.context_breakdown.exec_details.failures_column")}</span>
                  <span role="columnheader" className="text-right">{copy("dashboard.context_breakdown.exec_details.duration_column")}</span>
                  <span role="columnheader" className="text-right">{copy("dashboard.context_breakdown.exec_details.max_duration_column")}</span>
                </>
              )}
              <span role="columnheader" className="text-right">{copy("dashboard.context_breakdown.tool_details.total_column")}</span>
              {showRuntime && (
                <span role="columnheader" className="text-right">{copy("dashboard.context_breakdown.exec_details.output_column")}</span>
              )}
            </div>
            {rows.map((row, idx) => (
              <motion.div
                key={row.name}
                role="row"
                className={`grid ${gridCols} gap-2 py-1.5`}
                title={row.name}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.18, delay: idx * 0.02 }}
              >
                <span role="cell" className="min-w-0 text-body-sm font-medium text-oai-black dark:text-oai-white truncate">{row.name}</span>
                <span role="cell" className="text-right text-body-sm tabular-nums text-oai-gray-700 dark:text-oai-gray-300">{formatCompactNumber(row.calls || 0)}</span>
                {showRuntime && (
                  <>
                    <span role="cell" className="text-right text-body-sm tabular-nums text-oai-gray-700 dark:text-oai-gray-300">{formatCompactNumber(row.failures || 0)}</span>
                    <span role="cell" className="text-right text-body-sm tabular-nums text-oai-gray-700 dark:text-oai-gray-300">{formatDuration(row.duration_ms || 0)}</span>
                    <span role="cell" className="text-right text-body-sm tabular-nums text-oai-gray-700 dark:text-oai-gray-300">{formatDuration(row.max_duration_ms || 0)}</span>
                  </>
                )}
                <span role="cell" className="text-right text-body-sm tabular-nums text-oai-gray-700 dark:text-oai-gray-300">{formatTokens(row.totals.total_tokens || 0)}</span>
                {showRuntime && (
                  <span role="cell" className="text-right text-body-sm tabular-nums text-oai-gray-700 dark:text-oai-gray-300">{formatCompactNumber(row.output_lines || 0)}</span>
                )}
              </motion.div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Tool calls expanded content. Renders category rows and per-tool sub-rows
// using the shared Row primitive. All rows left-align to the same X — the
// label-area's leading icon slot (chevron / square / spacer) keeps every
// row's label starting on the same column regardless of depth.
function ToolCallsExpanded({ toolSet, execDetails, source, codexQueueFallback }) {
  const [openCats, setOpenCats] = useState({});
  const [openExec, setOpenExec] = useState(false);
  const categories = normalizeCategoryRows(toolSet?.categories || []);

  function toggleCat(name) {
    setOpenCats((prev) => ({ ...prev, [name]: !prev[name] }));
  }

  if (categories.length === 0) {
    return (
      <p className="text-[11px] text-oai-gray-400 dark:text-oai-gray-500 py-0.5">
        {source === "codex" && codexQueueFallback
          ? copy("dashboard.context_breakdown.tool_details.unavailable_codex")
          : copy(sourceEmptyCopyKey(source))}
      </p>
    );
  }

  return (
    <ul className="mt-0.5 mb-0.5 space-y-0.5">
      {categories.map((cat) => {
        const hasTools = cat.toolCount > 0;
        const isExecCategory = cat.name === "Execution" && execDetails;
        const hasExecTool = isExecCategory && cat.tools.some((t) => isExecToolName(t.name));
        const catOpen = Boolean(openCats[cat.name]);

        return (
          <Row
            key={cat.name}
            level={1}
            label={cat.name}
            labelTone="strong"
            hasChevron={hasTools || (isExecCategory && !hasExecTool)}
            open={catOpen || (isExecCategory && !hasExecTool && openExec)}
            onToggle={() => {
              if (hasTools) toggleCat(cat.name);
              else if (isExecCategory && !hasExecTool) setOpenExec((v) => !v);
            }}
            tokens={formatTokens(cat.totals.total_tokens || 0)}
            percent={null}
          >
            {hasTools && (
              <ul className="space-y-0.5">
                {cat.tools.map((tool) => {
                  const isExec = isExecCategory && isExecToolName(tool.name);
                  return (
                    <Row
                      key={tool.name}
                      level={2}
                      label={tool.name}
                      labelTone={isExec ? "accent" : "default"}
                      hasChevron={isExec}
                      open={openExec}
                      onToggle={() => setOpenExec((v) => !v)}
                      tokens={formatTokens(tool.total_tokens || 0)}
                      percent={null}
                    >
                      {isExec && <ExecDrillDown execDetails={execDetails} source={source} />}
                    </Row>
                  );
                })}
              </ul>
            )}

            {isExecCategory && !hasExecTool && <ExecDrillDown execDetails={execDetails} source={source} />}
          </Row>
        );
      })}
    </ul>
  );
}

// Inline Context Breakdown for Claude Code only. Renders bare (no Card
// wrapper) so it can drop into the UsageOverview expanded provider section.
export function ContextBreakdownPanel({ from, to, source = "claude", referenceTotalTokens = null, onLoadingChange = null }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  // Track which top-level disclosure rows are open
  const [openRows, setOpenRows] = useState({});

  function toggleRow(key) {
    setOpenRows((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    onLoadingChange?.(true);
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
        if (!cancelled) {
          setLoading(false);
          onLoadingChange?.(false);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, source]);

  // No internal header — the parent (UsageOverview) renders the title and
  // receives loading state via onLoadingChange so the spinner sits inline
  // next to the title instead of taking its own row.

  if (loading && !data) {
    return (
      <div>
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
      <p className="text-xs text-oai-gray-500 dark:text-oai-gray-400">
        {copy(sourceErrorCopyKey(source))}
      </p>
    );
  }

  if (!data || data.scope !== "supported" || !data.totals?.total_tokens) {
    return (
      <p className="text-xs text-oai-gray-500 dark:text-oai-gray-400">
        {copy(sourceEmptyCopyKey(source))}
      </p>
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
  const messageRows = normalizeMessageRows(messageDetails?.categories || []);
  const codexQueueFallback = source === "codex" && (data?.breakdown_status === "queue_fallback" || data?.fallback === "queue_totals");

  // The tool set for the top-level "tool_calls" row
  const toolCallsSet = source === "claude"
    ? toolDetails?.tool_calls || null
    : toolDetails || null;
  // The tool set for the "custom_agents" row
  const subagentsSet = source === "claude"
    ? toolDetails?.subagents || null
    : null;

  const hasCustomAgents =
    (subagentsSet?.categories?.length > 0) ||
    ((configuredResources?.custom_agents_count || 0) > 0);

  // Sort top-level rows by total_tokens descending (matches Claude /context
  // visual rhythm: largest buckets float to the top).
  const orderedCats = [...categories].sort(
    (a, b) => (b.totals?.total_tokens || 0) - (a.totals?.total_tokens || 0),
  );

  return (
    <div>
      {/* Segmented progress bar */}
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
          return (
            <motion.div
              key={cat.key}
              initial={{ width: 0 }}
              animate={{ width: `${cat.percent}%` }}
              transition={{ duration: 0.5, delay: 0.1 + idx * 0.04, ease: [0.16, 1, 0.3, 1] }}
              className="h-full"
              style={{ backgroundColor: cat.color }}
              title={`${categoryLabel(cat.key)}: ${cat.percent}%`}
            />
          );
        })}
      </div>

      {/* Inline category list with disclosures */}
      <ul className="mt-3 space-y-1">
        {orderedCats.map((cat) => {
          const isSystemPrefix = cat.key === "system_prompt";
          const isMessages = cat.key === "messages";
          const isToolCalls = cat.key === "tool_calls";
          const isCustomAgents = cat.key === "custom_agents";
          const isReasoning = cat.key === "reasoning";

          const hasChevron =
            (isMessages && messageRows.length > 0) ||
            (isToolCalls && (toolCallsSet?.categories?.length > 0 || codexQueueFallback)) ||
            (isCustomAgents && hasCustomAgents && subagentsSet);

          const rowOpen = Boolean(openRows[cat.key]);

          const colorSquare = (
            <span
              className="h-2 w-2 rounded-sm shrink-0"
              style={{ backgroundColor: cat.color }}
              aria-hidden="true"
            />
          );

          const labelSuffix = isSystemPrefix ? (
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
          ) : null;

          const percentStr = cat.percent > 0
            ? `${cat.percent.toFixed(cat.percent < 0.1 && cat.percent > 0 ? 2 : 1)}%`
            : "0.0%";

          return (
            <Row
              key={cat.key}
              level={0}
              colorSquare={colorSquare}
              label={categoryLabel(cat.key)}
              labelSuffix={labelSuffix}
              tokens={formatTokens(cat.totals?.total_tokens || 0)}
              percent={percentStr}
              hasChevron={hasChevron}
              open={rowOpen}
              onToggle={() => toggleRow(cat.key)}
            >
              {/* Messages disclosure content */}
              {isMessages && (
                <ul className="space-y-0.5">
                  {messageRows.map((row) => (
                    <Row
                      key={row.key || row.name}
                      level={1}
                      label={messageLabel(row)}
                      tokens={formatTokens(row.totals.total_tokens || 0)}
                      percent={null}
                    />
                  ))}
                </ul>
              )}

              {/* Tool calls disclosure content */}
              {isToolCalls && toolCallsSet && (
                <ToolCallsExpanded
                  toolSet={toolCallsSet}
                  execDetails={execDetails}
                  source={source}
                  codexQueueFallback={codexQueueFallback}
                />
              )}
              {isToolCalls && codexQueueFallback && !toolCallsSet && (
                <p className="text-[11px] text-oai-gray-400 dark:text-oai-gray-500 py-0.5">
                  {copy("dashboard.context_breakdown.tool_details.unavailable_codex")}
                </p>
              )}

              {/* Custom agents disclosure content */}
              {isCustomAgents && subagentsSet && (
                <ToolCallsExpanded
                  toolSet={subagentsSet}
                  execDetails={null}
                  source={source}
                  codexQueueFallback={false}
                />
              )}
            </Row>
          );
        })}

        {/* Skills row — shown separately (not in DISPLAY_GROUPS, no token total in bar) */}
        {skillRows.length > 0 && (
          <Row
            level={0}
            colorSquare={
              <span className="h-2 w-2 rounded-sm shrink-0 bg-oai-gray-300 dark:bg-oai-gray-600" aria-hidden="true" />
            }
            label={copy("dashboard.context_breakdown.category.skills")}
            tokens={formatTokens(skillRows.reduce((a, r) => a + (r.total_tokens || 0), 0))}
            percent={null}
            hasChevron={true}
            open={Boolean(openRows["skills"])}
            onToggle={() => toggleRow("skills")}
          >
            <ul className="space-y-0.5">
              {skillRows.slice(0, 12).map((skill) => (
                <Row
                  key={skill.name}
                  level={1}
                  label={skill.name}
                  tokens={formatTokens(skill.total_tokens)}
                  percent={null}
                />
              ))}
            </ul>
          </Row>
        )}

      </ul>

      {/* Footnote */}
      <p className="mt-2 text-[10px] text-oai-gray-400 dark:text-oai-gray-500">
        {copy(sourceFootnoteCopyKey(source))}
      </p>
      {codexQueueFallback ? (
        <p className="mt-2 text-[11px] text-oai-gray-500 dark:text-oai-gray-400">
          {copy("dashboard.context_breakdown.tool_details.unavailable_codex")}
        </p>
      ) : null}

      {/* Configured resources footer */}
      {configuredResources ? (
        <p className="mt-2 text-[10px] text-oai-gray-400 dark:text-oai-gray-500">
          {formatCompactNumber(configuredResources.skills_count || 0)} skills ·{" "}
          {formatCompactNumber(configuredResources.mcp_servers_count || 0)} MCP servers ·{" "}
          {formatCompactNumber(configuredResources.custom_agents_count || 0)} agents ·{" "}
          {formatCompactNumber(configuredResources.memory_files_count || 0)} memory files
        </p>
      ) : null}
    </div>
  );
}
