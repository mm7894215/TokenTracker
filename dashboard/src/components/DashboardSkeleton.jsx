import React from "react";
import { Card } from "../ui/components";
import { cn } from "../lib/cn";

/**
 * Loading placeholder for the main dashboard, shown only on the *initial*
 * cloud (account-view) load — `accountViewResolving || (accountView &&
 * usageLoadingState && !hasDetailsActual)`. A subsequent refresh keeps the
 * already-rendered data (no skeleton, no flash). Mirrors DashboardView's
 * 12-col grid so the swap to real content doesn't shift layout. Reuses the
 * `Bone` animate-pulse idiom from LimitsPageSkeleton.
 */
function Bone({ className }) {
  return (
    <div
      className={cn(
        "rounded bg-oai-gray-200/70 dark:bg-oai-gray-800/70 animate-pulse",
        className,
      )}
    />
  );
}

function HeatmapBones() {
  return (
    <div className="flex gap-1 overflow-hidden">
      {Array.from({ length: 20 }, (_, w) => (
        <div key={w} className="flex flex-col gap-1">
          {Array.from({ length: 7 }, (_, d) => (
            <Bone key={d} className="h-2.5 w-2.5 rounded-[2px]" />
          ))}
        </div>
      ))}
    </div>
  );
}

export function DashboardSkeleton() {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
      {/* Left column — totals, stats, heatmap, trend */}
      <div className="lg:col-span-4 flex flex-col gap-4 min-w-0 order-2 lg:order-1">
        <div className="flex flex-col gap-2">
          <Bone className="h-9 w-40" />
          <Bone className="h-7 w-28" />
        </div>
        <Card>
          <div className="flex flex-col gap-3">
            <Bone className="h-3.5 w-24" />
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="flex items-center justify-between gap-2">
                <Bone className="h-3 w-20" />
                <Bone className="h-3 w-12" />
              </div>
            ))}
          </div>
        </Card>
        <Card>
          <div className="flex flex-col gap-3">
            <Bone className="h-3.5 w-20" />
            <HeatmapBones />
          </div>
        </Card>
        <Card>
          <div className="flex flex-col gap-3">
            <Bone className="h-3.5 w-28" />
            <Bone className="h-32 w-full" />
          </div>
        </Card>
      </div>

      {/* Right column — usage overview (period tabs + big summary + provider
          distribution) on top, data-details table below. Mirrors DashboardView:
          UsageOverview card then DataDetails card. */}
      <div className="lg:col-span-8 flex flex-col gap-4 min-w-0 order-1 lg:order-2">
        {/* UsageOverview card */}
        <Card>
          {/* Period tabs (left, horizontal strip) + actions (right) */}
          <div className="flex items-center gap-2 mb-6">
            <div className="flex flex-1 min-w-0 gap-1">
              {Array.from({ length: 5 }, (_, i) => (
                <Bone key={i} className="h-7 w-14 rounded-md shrink-0" />
              ))}
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <Bone className="h-8 w-20 rounded-md" />
              <Bone className="h-8 w-8 rounded-md" />
            </div>
          </div>
          {/* Centered summary: label, big total, cost */}
          <div className="flex flex-col items-center gap-4 mb-8">
            <Bone className="h-3 w-28" />
            <Bone className="h-14 w-3/5 max-w-xs" />
            <Bone className="h-6 w-24" />
          </div>
          {/* Provider distribution bar + per-provider cards */}
          <div className="flex flex-col gap-6">
            <Bone className="h-1.5 w-full rounded-full" />
            <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-3">
              {Array.from({ length: 5 }, (_, i) => (
                <div
                  key={i}
                  className="flex flex-col gap-2 rounded-lg border border-oai-gray-200 dark:border-oai-gray-700 p-3"
                >
                  <div className="flex items-center gap-1.5">
                    <Bone className="h-[15px] w-[15px] rounded-sm shrink-0" />
                    <Bone className="h-3 w-12" />
                  </div>
                  <Bone className="h-5 w-10" />
                  <Bone className="h-2.5 w-14" />
                </div>
              ))}
            </div>
          </div>
        </Card>

        {/* DataDetails card — tab switcher + breakdown table */}
        <Card>
          <div className="flex items-center gap-1 mb-4">
            <Bone className="h-7 w-16 rounded" />
            <Bone className="h-7 w-20 rounded" />
          </div>
          {/* Table header */}
          <div className="flex items-center gap-3 border-b border-oai-gray-200 dark:border-oai-gray-700 pb-2">
            <Bone className="h-3 w-20 shrink-0" />
            {Array.from({ length: 5 }, (_, i) => (
              <Bone key={i} className="h-3 flex-1" />
            ))}
          </div>
          {/* Table rows */}
          <div className="flex flex-col">
            {Array.from({ length: 8 }, (_, i) => (
              <div
                key={i}
                className="flex items-center gap-3 border-b border-oai-gray-100 dark:border-oai-gray-800 py-2.5 last:border-b-0"
              >
                <Bone className="h-3.5 w-20 shrink-0" />
                {Array.from({ length: 5 }, (_, j) => (
                  <Bone key={j} className="h-3.5 flex-1" />
                ))}
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
