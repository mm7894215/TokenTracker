import React from "react";
import { ArrowRight } from "lucide-react";
import { copy } from "../lib/copy";
import { cn } from "../lib/cn";
import { LeaderboardAvatar } from "./LeaderboardAvatar.jsx";

function computePercentile(rank, total) {
  const r = Number(rank);
  const t = Number(total);
  if (!Number.isFinite(r) || r < 1) return null;
  if (!Number.isFinite(t) || t < 1) return null;
  return Math.min(100, Math.max(1, Math.ceil((r / t) * 100)));
}

function trimName(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isAnon(value) {
  const v = trimName(value);
  if (!v) return true;
  return v.toLowerCase() === "anonymous";
}

/**
 * Compact identity pill that lives in the page header next to the period
 * toggle. Click → jumps to the user's row when not already on that page.
 */
export function LeaderboardMeChip({
  me,
  totalEntries,
  meLabel,
  onJumpToMe,
  canJump,
}) {
  const rank = me && typeof me.rank === "number" ? me.rank : null;
  if (!rank) return null;

  const total = Number(totalEntries) || 0;
  const percentile = computePercentile(rank, total);

  const rawName = trimName(me?.display_name);
  const headlineName = !rawName || isAnon(rawName) ? meLabel || "You" : rawName;
  const avatarSeed = me?.user_id || headlineName;

  const interactive = Boolean(canJump) && typeof onJumpToMe === "function";
  const Tag = interactive ? "button" : "div";
  const interactiveProps = interactive
    ? {
        type: "button",
        onClick: onJumpToMe,
        "aria-label": copy("leaderboard.summary.jump_to_me"),
      }
    : {};

  return (
    <Tag
      {...interactiveProps}
      className={cn(
        "group inline-flex h-9 items-center gap-2.5 rounded-full border pl-1 pr-3.5 transition-all duration-300 select-none shadow-[0_1px_2px_rgba(0,0,0,0.03)]",
        interactive
          ? "border-oai-gray-200 hover:border-oai-brand-400 dark:border-oai-gray-800 dark:hover:border-oai-brand-500/80 bg-oai-gray-50/50 dark:bg-white/[0.02] backdrop-blur-md hover:bg-oai-brand-50/40 dark:hover:bg-oai-brand-950/20 active:scale-[0.97] hover:shadow-[0_4px_12px_rgba(0,0,0,0.05)] dark:hover:shadow-[0_4px_20px_rgba(0,0,0,0.25)] dark:ring-1 dark:ring-white/[0.04] dark:hover:ring-white/[0.08]"
          : "border-oai-gray-100 dark:border-oai-gray-800/60 bg-oai-gray-50/20 dark:bg-white/[0.01] backdrop-blur-sm dark:ring-1 dark:ring-white/[0.02]",
      )}
    >
      <LeaderboardAvatar
        size="sm"
        avatarUrl={me?.avatar_url}
        displayName={headlineName}
        seed={avatarSeed}
      />
      <span className="max-w-[120px] truncate text-xs font-semibold text-oai-black dark:text-oai-gray-200 group-hover:text-oai-brand-600 dark:group-hover:text-oai-brand-400 transition-colors">
        {headlineName}
      </span>
      <span className="text-xs font-bold tabular-nums text-oai-gray-800 dark:text-white">
        #{rank.toLocaleString()}
      </span>
      {percentile != null && (
        <span
          className={cn(
            "inline-flex items-center rounded-full px-2 py-0.5 text-[9px] font-extrabold tracking-wider tabular-nums uppercase transition-colors duration-300 ring-1",
            percentile <= 10
              ? "bg-amber-500/10 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400 ring-amber-500/20"
              : "bg-oai-brand-100/50 text-oai-brand-700 dark:bg-oai-brand-500/10 dark:text-oai-brand-400 ring-oai-brand-500/10"
          )}
        >
          {copy("leaderboard.summary.percentile", { p: String(percentile) })}
        </span>
      )}
      {interactive ? (
        <ArrowRight
          aria-hidden
          className="size-3 text-oai-gray-400 transition-all duration-300 group-hover:text-oai-brand-500 dark:text-oai-gray-500 group-hover:translate-x-0.5 group-hover:scale-110"
        />
      ) : (
        <span
          className="relative flex h-1.5 w-1.5 shrink-0 items-center justify-center ml-1"
          title="You are here"
        >
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75 duration-1000"></span>
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
        </span>
      )}
    </Tag>
  );
}
