import React from "react";
import { copy } from "../lib/copy";
import { cn } from "../lib/cn";
import { formatCompactNumber } from "../lib/format";
import { inferModelProvider } from "../lib/model-provider";
import { useTokenFormat } from "../hooks/useTokenFormat.js";
import { ProviderIcon } from "../ui/dashboard/components/ProviderIcon.jsx";
import { LeaderboardProviderColumnHeader } from "./LeaderboardProviderColumnHeader.jsx";
import {
  LB_STICKY_TH_RANK,
  LB_STICKY_TH_USER,
  lbStickyTdRank,
  lbStickyTdUser,
} from "../lib/leaderboard-columns.js";

const MEDAL_CLASS = {
  1: "bg-amber-50 text-amber-600 dark:bg-amber-900/20 dark:text-amber-400",
  2: "bg-gray-50 text-gray-500 dark:bg-gray-800/40 dark:text-gray-300",
  3: "bg-orange-50 text-orange-700 dark:bg-orange-900/20 dark:text-orange-400",
};

function Rank({ value }) {
  const medal = MEDAL_CLASS[value];
  return (
    <span
      className={cn(
        "inline-flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold tabular-nums",
        medal || "text-oai-gray-500 dark:text-oai-gray-400",
      )}
    >
      {value ?? copy("shared.placeholder.short")}
    </span>
  );
}

function providerNameFromColumn(column) {
  if (column?.key === "gpt_tokens") return "CODEX";
  if (column?.key === "claude_tokens") return "CLAUDE";
  const fileName = column?.icon?.split("/").pop() || "";
  return fileName.replace(/\.svg$/i, "").toUpperCase() || "OTHER";
}

function ProviderCells({ entry, orderedColumns }) {
  const { formatTokens, formatTokensTooltip } = useTokenFormat();
  return orderedColumns.map((column) => (
    <td
      key={column.key}
      data-column-key={column.key}
      title={formatTokensTooltip(entry?.[column.key])}
      className="hidden whitespace-nowrap bg-white px-3 py-4 text-right tabular-nums text-oai-gray-500 group-hover:bg-oai-gray-50 dark:bg-oai-gray-950 dark:text-oai-gray-400 dark:group-hover:bg-oai-gray-900 sm:table-cell sm:px-4"
    >
      {formatTokens(entry?.[column.key])}
    </td>
  ));
}

function MobileProviderPills({ entry, orderedColumns }) {
  const { formatTokens, formatTokensTooltip } = useTokenFormat();
  const active = orderedColumns.filter(function hasTokens(column) {
    return Boolean(Number(entry?.[column.key]));
  });
  if (!active.length) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-oai-gray-100/70 pt-3 dark:border-oai-gray-800/60">
      {active.map((column) => (
        <span
          key={column.key}
          title={`${copy(column.copyKey)}: ${formatTokensTooltip(entry?.[column.key])}`}
          className="inline-flex items-center gap-1 rounded-full border border-oai-gray-100/80 bg-oai-gray-50/80 px-2 py-0.5 text-[10px] font-medium text-oai-gray-600 dark:border-oai-gray-800/40 dark:bg-oai-gray-900/60 dark:text-oai-gray-300"
        >
          <ProviderIcon provider={providerNameFromColumn(column)} size={12} />
          <span className="tabular-nums">{formatTokens(entry?.[column.key])}</span>
        </span>
      ))}
    </div>
  );
}

function MobileModelRow({ entry, orderedColumns, currency, rate, formatCost }) {
  const { formatTokens, formatTokensTooltip } = useTokenFormat();
  const model = String(entry?.model || copy("shared.placeholder.short"));
  return (
    <article
      data-model-leaderboard-row
      className="mx-0 my-1 rounded-xl border border-oai-gray-100 bg-white px-3.5 py-3 shadow-sm dark:border-oai-gray-800/60 dark:bg-oai-gray-950"
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex w-6 shrink-0 justify-center"><Rank value={entry?.rank} /></span>
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-oai-gray-50 text-oai-gray-700 ring-1 ring-oai-gray-100 dark:bg-oai-gray-900 dark:text-oai-gray-200 dark:ring-oai-gray-800">
          <ProviderIcon provider={inferModelProvider(model)} size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-oai-gray-800 dark:text-oai-gray-200" title={model}>{model}</h2>
          <p className="mt-1 text-[11px] text-oai-gray-400 dark:text-oai-gray-500">
            {copy("leaderboard.community.modal.developer_count", {
              count: formatCompactNumber(Number(entry?.developer_count) || 0),
            })}
            <span aria-hidden="true"> · </span>
            {formatCost(entry?.estimated_cost_usd, currency, rate)}
          </p>
        </div>
        <div className="shrink-0 text-right" title={formatTokensTooltip(entry?.total_tokens)}>
          <div className="text-[9px] font-semibold uppercase tracking-[0.08em] text-oai-gray-400 dark:text-oai-gray-500">
            {copy("leaderboard.column.total")}
          </div>
          <div className="mt-0.5 text-sm font-semibold tabular-nums text-oai-gray-800 dark:text-oai-gray-200">
            {formatTokens(entry?.total_tokens)}
          </div>
        </div>
      </div>
      <MobileProviderPills entry={entry} orderedColumns={orderedColumns} />
    </article>
  );
}

export function ModelLeaderboardList({ entries, orderedColumns, currency, rate, formatCost }) {
  const { formatTokens, formatTokensTooltip } = useTokenFormat();
  return (
    <>
      <div className="hidden w-full overflow-x-auto sm:block">
        <table className="min-w-max w-full text-left text-sm">
          <thead className="border-b border-oai-gray-200 dark:border-oai-gray-800">
            <tr>
              <th className={cn(LB_STICKY_TH_RANK, "text-[11px] font-semibold uppercase tracking-wider text-oai-gray-400 dark:text-oai-gray-500")}>
                {copy("leaderboard.column.rank")}
              </th>
              <th className={cn(LB_STICKY_TH_USER, "text-[11px] font-semibold uppercase tracking-wider text-oai-gray-400 dark:text-oai-gray-500")}>
                {copy("leaderboard.column.model")}
              </th>
              <th className="whitespace-nowrap px-4 py-4 text-right text-[11px] font-semibold uppercase tracking-wider text-oai-gray-400 dark:text-oai-gray-500">
                {copy("leaderboard.column.total")}
              </th>
              <th className="whitespace-nowrap px-4 py-4 text-right text-[11px] font-semibold uppercase tracking-wider text-oai-gray-400 dark:text-oai-gray-500">
                {copy("leaderboard.column.est_cost")}
              </th>
              <th className="whitespace-nowrap px-4 py-4 text-right text-[11px] font-semibold uppercase tracking-wider text-oai-gray-400 dark:text-oai-gray-500">
                {copy("leaderboard.column.developers")}
              </th>
              {orderedColumns.map((column) => (
                <th key={column.key} className="px-3 py-4 text-right align-middle sm:px-4">
                  <LeaderboardProviderColumnHeader
                    iconSrc={column.icon}
                    label={copy(column.copyKey)}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-oai-gray-100 dark:divide-oai-gray-800/50">
            {entries.map((entry) => {
              const model = String(entry?.model || copy("shared.placeholder.short"));
              return (
                <tr key={`${entry?.rank}-${model}`} data-model-leaderboard-row className="group">
                  <td className={lbStickyTdRank(false)}><Rank value={entry?.rank} /></td>
                  <td className={lbStickyTdUser(false)}>
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-oai-gray-50 text-oai-gray-700 ring-1 ring-oai-gray-100 dark:bg-oai-gray-900 dark:text-oai-gray-200 dark:ring-oai-gray-800">
                        <ProviderIcon provider={inferModelProvider(model)} size={17} />
                      </span>
                      <span className="truncate font-medium text-oai-gray-800 dark:text-oai-gray-200" title={model}>{model}</span>
                    </div>
                  </td>
                  <td className="whitespace-nowrap bg-white px-4 py-4 text-right font-semibold tabular-nums text-oai-gray-800 group-hover:bg-oai-gray-50 dark:bg-oai-gray-950 dark:text-oai-gray-200 dark:group-hover:bg-oai-gray-900" title={formatTokensTooltip(entry?.total_tokens)}>
                    {formatTokens(entry?.total_tokens)}
                  </td>
                  <td className="whitespace-nowrap bg-white px-4 py-4 text-right tabular-nums text-oai-gray-500 group-hover:bg-oai-gray-50 dark:bg-oai-gray-950 dark:text-oai-gray-400 dark:group-hover:bg-oai-gray-900">
                    {formatCost(entry?.estimated_cost_usd, currency, rate)}
                  </td>
                  <td className="whitespace-nowrap bg-white px-4 py-4 text-right tabular-nums text-oai-gray-500 group-hover:bg-oai-gray-50 dark:bg-oai-gray-950 dark:text-oai-gray-400 dark:group-hover:bg-oai-gray-900">
                    {(Number(entry?.developer_count) || 0).toLocaleString()}
                  </td>
                  <ProviderCells entry={entry} orderedColumns={orderedColumns} />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-col py-1 sm:hidden">
        {entries.map((entry) => (
          <MobileModelRow
            key={`${entry?.rank}-${entry?.model}`}
            entry={entry}
            orderedColumns={orderedColumns}
            currency={currency}
            rate={rate}
            formatCost={formatCost}
          />
        ))}
      </div>
    </>
  );
}
