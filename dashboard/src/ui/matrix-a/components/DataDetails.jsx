import React, { useState } from "react";
import { Card } from "../../openai/components";

export function DataDetails({
  // Project props
  projectEntries = [],
  projectLimit = 3,
  onProjectLimitChange,
  // Daily breakdown props
  copy,
  hasDetailsActual,
  dailyEmptyPrefix,
  installSyncCmd,
  dailyEmptySuffix,
  detailsColumns,
  ariaSortFor,
  toggleSort,
  sortIconFor,
  pagedDetails,
  dailyBreakdownRows = [],
  dailyBreakdownColumns = [],
  dailyBreakdownAriaSortFor,
  dailyBreakdownSortIconFor,
  dailyBreakdownDateKey = "day",
  detailsDateKey,
  renderDetailDate,
  renderDailyBreakdownDate,
  renderDetailCell,
  DETAILS_PAGED_PERIODS,
  period,
  detailsPageCount,
  detailsPage,
  setDetailsPage,
}) {
  const [activeTab, setActiveTab] = useState("daily");

  return (
    <Card>
      {/* Tab Switcher + Controls */}
      <div className="flex items-center justify-between gap-3 mb-4">
        <div role="tablist" aria-label="Data view" className="flex gap-1">
          <button
            role="tab"
            aria-selected={activeTab === "daily"}
            type="button"
            onClick={() => setActiveTab("daily")}
            className={`text-xs font-medium px-3 py-1.5 rounded transition-colors ${
              activeTab === "daily"
                ? "text-oai-black dark:text-oai-white bg-oai-gray-100 dark:bg-oai-gray-800"
                : "text-oai-gray-500 dark:text-oai-gray-300 hover:text-oai-black dark:hover:text-oai-white hover:bg-oai-gray-50 dark:hover:bg-oai-gray-800/50"
            }`}
          >
            {copy("dashboard.daily.title")}
          </button>
          <button
            role="tab"
            aria-selected={activeTab === "projects"}
            type="button"
            onClick={() => setActiveTab("projects")}
            className={`text-xs font-medium px-3 py-1.5 rounded transition-colors ${
              activeTab === "projects"
                ? "text-oai-black dark:text-oai-white bg-oai-gray-100 dark:bg-oai-gray-800"
                : "text-oai-gray-500 dark:text-oai-gray-300 hover:text-oai-black dark:hover:text-oai-white hover:bg-oai-gray-50 dark:hover:bg-oai-gray-800/50"
            }`}
          >
            {copy("dashboard.projects.title")}
          </button>
        </div>
        {activeTab === "projects" && (
          <select
            aria-label="Number of projects to display"
            value={projectLimit}
            onChange={(e) => onProjectLimitChange?.(Number(e.target.value))}
            className="text-xs text-oai-gray-600 dark:text-oai-gray-300 bg-white dark:bg-oai-gray-900 border border-oai-gray-200 dark:border-oai-gray-700 rounded px-2 py-1 hover:border-oai-gray-300 dark:hover:border-oai-gray-600 focus:border-oai-brand dark:focus:border-oai-brand focus:outline-none transition-colors"
          >
            <option value={3}>{copy("dashboard.projects.limit_top_3")}</option>
            <option value={6}>{copy("dashboard.projects.limit_top_6")}</option>
            <option value={10}>{copy("dashboard.projects.limit_top_10")}</option>
          </select>
        )}
      </div>

      {/* Projects Tab */}
      {activeTab === "projects" && (
        <div className="space-y-1">
          {projectEntries.slice(0, projectLimit).map((entry) => (
            <a
              key={entry?.project_key || entry?.project_ref}
              href={entry?.project_ref || "#"}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 p-2 rounded-lg hover:oai-bg-elevated transition-colors"
            >
              <div className="w-8 h-8 rounded-md oai-bg-elevated flex items-center justify-center oai-text-caption font-medium text-oai-gray-500 dark:text-oai-gray-300">
                {(entry?.project_key?.[0] || "?").toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="oai-text-body-sm font-medium text-oai-black dark:text-oai-white truncate">
                  {entry?.project_key || entry?.project_ref?.split("/")?.pop() || "—"}
                </div>
              </div>
              <div className="oai-text-body-sm font-medium text-oai-black dark:text-oai-white tabular-nums">
                {entry?.billable_total_tokens?.toLocaleString?.() ||
                  entry?.total_tokens?.toLocaleString?.() ||
                  "—"}
              </div>
            </a>
          ))}
        </div>
      )}

      {/* Daily Tab */}
      {activeTab === "daily" && (
        <div>
          {dailyBreakdownRows?.length === 0 ? (
            <div className="oai-text-body-sm text-oai-gray-500 dark:text-oai-gray-300 mb-4">
              {dailyEmptyPrefix}
              <code className="mx-1 rounded border border-oai-gray-300 dark:border-oai-gray-700 oai-bg-elevated px-1.5 py-0.5 font-mono oai-text-caption">
                {installSyncCmd}
              </code>
              {dailyEmptySuffix}
            </div>
          ) : (
          <div className="overflow-auto max-h-[384px] -mx-4 oai-scrollbar">
            <table className="w-full border-collapse">
              <thead className="sticky top-0 z-10">
                <tr className="border-b border-oai-gray-200 dark:border-oai-gray-700">
                  {dailyBreakdownColumns.map((column) => (
                    <th
                      key={column.key}
                      aria-sort={dailyBreakdownAriaSortFor?.(column.key) || "none"}
                      className="text-left p-0 bg-white dark:bg-oai-gray-900"
                    >
                      <button
                        type="button"
                        onClick={() => toggleSort(column.key)}
                        className="flex w-full items-center justify-start px-4 py-2 text-left oai-text-caption font-semibold text-oai-gray-600 dark:text-oai-gray-300 hover:text-oai-black dark:hover:text-oai-white transition-colors"
                      >
                        <span className="inline-flex items-center gap-1">
                          <span>{column.label}</span>
                          <span className="text-oai-gray-400 dark:text-oai-gray-400">
                            {dailyBreakdownSortIconFor?.(column.key) || ""}
                          </span>
                        </span>
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {dailyBreakdownRows.map((row) => (
                  <tr
                    key={String(
                      row?.[dailyBreakdownDateKey] || row?.day || row?.hour || row?.month || "",
                    )}
                    className={`border-b border-oai-gray-100 dark:border-oai-gray-800 last:border-b-0 hover:bg-oai-gray-50/50 dark:hover:bg-oai-gray-800/50 transition-colors ${
                      row.missing ? "text-oai-gray-400 dark:text-oai-gray-400" : row.future ? "text-oai-gray-300 dark:text-oai-gray-600" : "text-oai-black dark:text-oai-white"
                    }`}
                  >
                    <td className="px-4 py-2 oai-text-body-sm text-oai-gray-500 dark:text-oai-gray-300">
                      {renderDailyBreakdownDate ? renderDailyBreakdownDate(row) : renderDetailDate(row)}
                    </td>
                    <td className="px-4 py-2 oai-text-body-sm font-medium text-oai-black dark:text-oai-white tabular-nums">
                      {renderDetailCell(row, "total_tokens")}
                    </td>
                    <td className="px-4 py-2 oai-text-body-sm text-oai-gray-600 dark:text-oai-gray-300 tabular-nums">
                      {renderDetailCell(row, "input_tokens")}
                    </td>
                    <td className="px-4 py-2 oai-text-body-sm text-oai-gray-600 dark:text-oai-gray-300 tabular-nums">
                      {renderDetailCell(row, "output_tokens")}
                    </td>
                    <td className="px-4 py-2 oai-text-body-sm text-oai-gray-600 dark:text-oai-gray-300 tabular-nums">
                      {renderDetailCell(row, "cached_input_tokens")}
                    </td>
                    <td className="px-4 py-2 oai-text-body-sm text-oai-gray-600 dark:text-oai-gray-300 tabular-nums">
                      {renderDetailCell(row, "reasoning_output_tokens")}
                    </td>
                    <td className="px-4 py-2 oai-text-body-sm text-oai-gray-600 dark:text-oai-gray-300 tabular-nums">
                      {renderDetailCell(row, "conversation_count")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}

          {/* Pagination - 使用 design system typography，Daily Breakdown 不需要分页 */}
          {activeTab !== "daily" && DETAILS_PAGED_PERIODS.has(period) && detailsPageCount > 1 ? (
            <div className="mt-3 flex items-center justify-between oai-text-caption">
              <button
                type="button"
                onClick={() => setDetailsPage((prev) => Math.max(0, prev - 1))}
                disabled={detailsPage === 0}
                className="px-3 py-1.5 text-oai-gray-600 dark:text-oai-gray-300 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 rounded-md disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {copy("details.pagination.prev")}
              </button>
              <span className="oai-text-muted">
                {detailsPage + 1} / {detailsPageCount}
              </span>
              <button
                type="button"
                onClick={() => setDetailsPage((prev) => Math.min(detailsPageCount - 1, prev + 1))}
                disabled={detailsPage + 1 >= detailsPageCount}
                className="px-3 py-1.5 text-oai-gray-600 dark:text-oai-gray-300 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 rounded-md disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {copy("details.pagination.next")}
              </button>
            </div>
          ) : null}
        </div>
      )}
    </Card>
  );
}
