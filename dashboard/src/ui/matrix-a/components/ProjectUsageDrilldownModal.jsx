import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import React from "react";
import { copy } from "../../../lib/copy";
import { formatCompactNumber } from "../../../lib/format";

function formatTokens(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return copy("shared.placeholder.short");
  return formatCompactNumber(n, { decimals: 1 });
}

export function ProjectUsageDrilldownModal({ open, onClose, data, loading, error }) {
  const sources = data?.current?.sources || [];
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose?.(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[100] bg-black/40" />
        <Dialog.Viewport className="fixed inset-0 z-[101] flex items-center justify-center p-4">
          <Dialog.Popup className="relative w-full max-w-2xl rounded-2xl border border-oai-gray-200 dark:border-oai-gray-800 bg-white dark:bg-oai-gray-950 p-6 shadow-xl">
            <Dialog.Title render={<h2 className="text-lg font-semibold text-oai-black dark:text-white pr-10" />}>
              {data?.project_key || copy("dashboard.projects.drilldown.title")}
            </Dialog.Title>

            <Dialog.Close
              type="button"
              className="absolute top-3 right-3 flex h-9 w-9 items-center justify-center rounded-md text-oai-gray-500 dark:text-oai-gray-400 hover:text-oai-gray-800 dark:hover:text-oai-gray-100 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand/50 transition-colors z-10"
              aria-label={copy("dashboard.projects.drilldown.close")}
            >
              <X size={16} strokeWidth={2} aria-hidden />
            </Dialog.Close>

            <div className="mt-4 grid grid-cols-2 gap-4">
              <SummaryBlock
                label={copy("dashboard.projects.drilldown.current")}
                total={loading || error ? copy("shared.placeholder.short") : formatTokens(data?.current?.totals?.billable_total_tokens)}
                range={loading || error ? "—" : `${data?.current?.from || "—"} → ${data?.current?.to || "—"}`}
              />
              <SummaryBlock
                label={copy("dashboard.projects.drilldown.previous")}
                total={loading || error ? copy("shared.placeholder.short") : formatTokens(data?.previous?.totals?.billable_total_tokens)}
                range={loading || error ? "—" : `${data?.previous?.from || "—"} → ${data?.previous?.to || "—"}`}
              />
            </div>

            <div className="mt-6">
              <div className="mb-2 text-xs uppercase tracking-wide text-oai-gray-500 dark:text-oai-gray-400">
                {copy("dashboard.projects.drilldown.breakdown")}
              </div>
              <BreakdownContent loading={loading} error={error} sources={sources} />
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function BreakdownContent({ loading, error, sources }) {
  if (loading) {
    return (
      <div className="text-sm text-oai-gray-500 dark:text-oai-gray-400">
        {copy("dashboard.projects.drilldown.loading")}
      </div>
    );
  }
  if (error) {
    return (
      <div className="text-sm text-red-500 dark:text-red-400" role="alert">
        {copy("dashboard.projects.drilldown.error")}
      </div>
    );
  }
  if (!sources.length) {
    return (
      <div className="text-sm text-oai-gray-500 dark:text-oai-gray-400">
        {copy("dashboard.projects.drilldown.breakdown_empty")}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {sources.map((entry) => (
        <div
          key={entry.source}
          className="flex items-center justify-between rounded-lg border border-oai-gray-100 dark:border-oai-gray-800 px-3 py-2"
        >
          <span className="text-sm text-oai-black dark:text-white">{entry.source}</span>
          <span className="text-sm font-medium text-oai-black dark:text-white">
            {formatTokens(entry.billable_total_tokens)}
          </span>
        </div>
      ))}
    </div>
  );
}

function SummaryBlock({ label, total, range }) {
  return (
    <div className="rounded-xl border border-oai-gray-200 dark:border-oai-gray-800 px-4 py-4">
      <div className="text-xs uppercase tracking-wide text-oai-gray-500 dark:text-oai-gray-400">{label}</div>
      <div className="mt-1 text-lg font-semibold text-oai-black dark:text-white">{total}</div>
      <div className="mt-1 text-xs text-oai-gray-500 dark:text-oai-gray-400">{range}</div>
    </div>
  );
}
