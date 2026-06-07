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

      {/* Right column — period chips + main breakdown table */}
      <div className="lg:col-span-8 flex flex-col gap-4 min-w-0 order-1 lg:order-2">
        <div className="flex items-center gap-2">
          {Array.from({ length: 5 }, (_, i) => (
            <Bone key={i} className="h-7 w-16 rounded-full" />
          ))}
        </div>
        <Card>
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-4">
              <Bone className="h-4 w-32" />
              <Bone className="h-4 w-20" />
            </div>
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Bone className="h-[14px] w-[14px] rounded shrink-0" />
                <Bone className="h-3.5 flex-1 min-w-0" />
                <Bone className="h-3.5 w-16 shrink-0" />
                <Bone className="h-3.5 w-12 shrink-0" />
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
