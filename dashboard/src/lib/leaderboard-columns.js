import { cn } from "./cn";

/**
 * Leaderboard token columns: one column per provider (no aggregated "Other").
 * `key` matches API / mock field names on each entry.
 */
export const LEADERBOARD_TOKEN_COLUMNS = [
  { key: "gpt_tokens", copyKey: "leaderboard.column.codex", icon: "/brand-logos/codex.svg" },
  { key: "claude_tokens", copyKey: "leaderboard.column.claude", icon: "/brand-logos/claude-code.svg" },
  { key: "gemini_tokens", copyKey: "leaderboard.column.gemini", icon: "/brand-logos/gemini.svg" },
  { key: "cursor_tokens", copyKey: "leaderboard.column.cursor", icon: "/brand-logos/cursor.svg" },
  { key: "kiro_tokens", copyKey: "leaderboard.column.kiro", icon: "/brand-logos/kiro.svg" },
  { key: "copilot_tokens", copyKey: "leaderboard.column.copilot", icon: "/brand-logos/copilot.svg" },
  { key: "kimi_tokens", copyKey: "leaderboard.column.kimi", icon: "/brand-logos/kimi.svg" },
  { key: "opencode_tokens", copyKey: "leaderboard.column.opencode", icon: "/brand-logos/opencode.svg" },
  { key: "openclaw_tokens", copyKey: "leaderboard.column.openclaw", icon: "/brand-logos/openclaw.svg" },
  { key: "hermes_tokens", copyKey: "leaderboard.column.hermes", icon: null },
  { key: "other_tokens", copyKey: "leaderboard.column.supplemental", icon: null },
];

/** Rank column width matches `left` offset of the second sticky column */
export const LEADERBOARD_STICKY_RANK_PX = 72;

// Divider between the two sticky columns lives on the SECOND cell's left
// edge (not the first cell's right edge), and that cell is shifted 1px
// left (`left-[71px]`) so it overlaps the rank column by a pixel. Without
// the overlap, sub-pixel rendering on retina displays can leak a 1px gap
// between the cells where the scrolling background shows through.
export const LB_STICKY_TH_RANK =
  "sticky left-0 z-40 w-[72px] min-w-[72px] max-w-[72px] bg-white dark:bg-oai-gray-950 px-4 py-4 align-middle";

export const LB_STICKY_TH_USER =
  "sticky left-[71px] z-40 min-w-[200px] max-w-[min(260px,45vw)] border-l border-r border-oai-gray-200 dark:border-oai-gray-800 bg-white dark:bg-oai-gray-950 px-4 py-4 align-middle";

/** Second sticky column on profile page (Rank + Total; no User column in table) */
export const LB_STICKY_TH_TOTAL =
  "sticky left-[71px] z-40 min-w-[6rem] border-l border-r border-oai-gray-200 dark:border-oai-gray-800 bg-white dark:bg-oai-gray-950 px-4 py-4";

export function lbStickyTdRank(isMe) {
  return cn(
    "sticky left-0 z-30 w-[72px] min-w-[72px] max-w-[72px] px-4 py-4 whitespace-nowrap",
    isMe
      ? "bg-oai-brand-50 dark:bg-emerald-950"
      : "bg-white dark:bg-oai-gray-950 group-hover:bg-oai-gray-50 dark:group-hover:bg-oai-gray-900/60",
  );
}

export function lbStickyTdUser(isMe) {
  // hover:z-50 lifts the cell above the sticky <th> (z-40) so the GitHub
  // tooltip — confined to this td's stacking context — can paint over the
  // table header on row 1.
  return cn(
    "sticky left-[71px] z-30 hover:z-50 min-w-[200px] max-w-[min(260px,45vw)] border-l border-r border-oai-gray-200 dark:border-oai-gray-800 px-4 py-4 min-w-0",
    isMe
      ? "bg-oai-brand-50 dark:bg-emerald-950"
      : "bg-white dark:bg-oai-gray-950 group-hover:bg-oai-gray-50 dark:group-hover:bg-oai-gray-900/60",
  );
}

/** Second sticky body cell when the column is Total (profile table) */
export function lbStickyTdTotalOnly(isMe) {
  return cn(
    "sticky left-[71px] z-30 min-w-[6rem] border-l border-r border-oai-gray-200 dark:border-oai-gray-800 px-4 py-4 whitespace-nowrap",
    isMe
      ? "bg-oai-brand-50 dark:bg-emerald-950"
      : "bg-white dark:bg-oai-gray-950",
  );
}
