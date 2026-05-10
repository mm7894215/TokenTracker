import React from "react";
import { Card } from "../ui/components";
import { cn } from "../lib/cn";

/** 与 UsageLimitsPanel 的 DEFAULT_ORDER 及每组最多条数一致 */
const PROVIDER_BAR_COUNTS = [3, 2, 3, 3, 2, 2, 3];

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

/** 对齐 LimitBar 一行：label w-12 + 圆条 + 百分比 w-[30px] + reset w-6 */
function SkeletonBarRow() {
  return (
    <div className="flex items-center gap-2">
      <Bone className="h-3 w-12 shrink-0" />
      <Bone className="flex-1 h-1.5 rounded-full min-w-0" />
      <Bone className="h-3 w-[30px] shrink-0" />
      <Bone className="h-3 w-6 shrink-0" />
    </div>
  );
}

/** 对齐 ToolGroup：图标 14px + 名称行 */
function SkeletonProvider({ bars, index }) {
  const nameW = index % 3 === 0 ? "w-24" : index % 3 === 1 ? "w-20" : "w-[4.5rem]";
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <Bone className="h-[14px] w-[14px] rounded shrink-0" />
        <Bone className={cn("h-4", nameW)} />
      </div>
      {Array.from({ length: bars }, (_, i) => (
        <SkeletonBarRow key={i} />
      ))}
    </div>
  );
}

/** 结构贴合有数据时的 UsageLimitsPanel（Card + 标题 + 各工具组与进度行） */
export function LimitsPageSkeleton() {
  return (
    <Card>
      <div className="flex flex-col gap-3">
        <Bone className="h-3.5 w-28" />
        {PROVIDER_BAR_COUNTS.map((bars, i) => (
          <SkeletonProvider key={i} bars={bars} index={i} />
        ))}
      </div>
    </Card>
  );
}
