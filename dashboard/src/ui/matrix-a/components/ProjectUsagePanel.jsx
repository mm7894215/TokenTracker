import React, { useEffect, useMemo, useState } from "react";
import { Select } from "@base-ui/react/select";

import { copy } from "../../../lib/copy";
import { formatCompactNumber, toDisplayNumber, toFiniteNumber } from "../../../lib/format";
import { shouldFetchGithubStars } from "../util/should-fetch-github-stars.js";

const LIMIT_OPTIONS = [3, 6, 10];
const REPO_META_CACHE = new Map();

function splitRepoKey(value) {
  if (typeof value !== "string") return { owner: "", repo: "" };
  const [owner, repo] = value.split("/");
  return { owner: owner || "", repo: repo || "" };
}

function normalizeStars(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.round(value));
}

function resolveTokens(entry) {
  if (!entry) return null;
  const total = entry.total_tokens ?? null;
  const billable = entry.billable_total_tokens ?? null;
  const billableValue = toFiniteNumber(billable);
  const totalValue = toFiniteNumber(total);
  if (billableValue === 0 && totalValue != null && totalValue > 0) {
    return total;
  }
  return billable ?? total ?? null;
}

function resolveRepoMeta(repoId) {
  if (!repoId) return null;
  return REPO_META_CACHE.get(repoId) || null;
}

function cacheRepoMeta(repoId, meta) {
  if (!repoId || !meta) return;
  REPO_META_CACHE.set(repoId, meta);
}

function useGithubRepoMeta(repoId) {
  const [state, setState] = useState(() => resolveRepoMeta(repoId) || null);

  useEffect(() => {
    if (!repoId) return;
    const cached = resolveRepoMeta(repoId);
    if (cached) {
      setState(cached);
      return;
    }

    if (typeof window === "undefined") return;
    const prefersReducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const screenshotCapture =
      typeof document !== "undefined" &&
      (document.documentElement?.classList.contains("screenshot-capture") ||
        document.body?.classList.contains("screenshot-capture"));
    if (!shouldFetchGithubStars({ prefersReducedMotion, screenshotCapture })) {
      return;
    }

    let active = true;
    fetch(`https://api.github.com/repos/${repoId}`)
      .then((res) => res.json())
      .then((data) => {
        if (!active) return;
        const meta = {
          stars: normalizeStars(data?.stargazers_count),
          avatarUrl: typeof data?.owner?.avatar_url === "string" ? data.owner.avatar_url : null,
        };
        cacheRepoMeta(repoId, meta);
        setState(meta);
      })
      .catch(() => {
        if (!active) return;
        const meta = { stars: null, avatarUrl: null };
        cacheRepoMeta(repoId, meta);
        setState(meta);
      });

    return () => {
      active = false;
    };
  }, [repoId]);

  return state;
}

export function ProjectUsagePanel({
  entries = [],
  limit = 3,
  onLimitChange,
  onSelectEntry,
  loading = false,
  error = null,
  className = "",
}) {
  const placeholder = copy("shared.placeholder.short");
  const tokensLabel = copy("dashboard.projects.tokens_label");
  const starsLabel = copy("dashboard.projects.stars_label");
  const emptyLabel = copy("dashboard.projects.empty");
  const limitLabel = copy("dashboard.projects.limit_label");
  const limitAria = copy("dashboard.projects.limit_aria");
  const optionLabels = {
    3: copy("dashboard.projects.limit_top_3"),
    6: copy("dashboard.projects.limit_top_6"),
    10: copy("dashboard.projects.limit_top_10"),
  };
  const resolvedLimit = LIMIT_OPTIONS.includes(limit) ? limit : LIMIT_OPTIONS[0];

  const sortedEntries = useMemo(() => {
    const list = Array.isArray(entries) ? entries.slice() : [];
    return list.sort((a, b) => {
      const aValue = toFiniteNumber(resolveTokens(a)) ?? 0;
      const bValue = toFiniteNumber(resolveTokens(b)) ?? 0;
      return bValue - aValue;
    });
  }, [entries]);

  const displayEntries = sortedEntries.slice(0, Math.max(1, limit));

  const tokenFormatOptions = {
    thousandSuffix: copy("shared.unit.thousand_abbrev"),
    millionSuffix: copy("shared.unit.million_abbrev"),
    billionSuffix: copy("shared.unit.billion_abbrev"),
    decimals: 1,
  };

  return (
    <div className={`rounded-xl border border-oai-gray-200 dark:border-oai-gray-800 bg-white dark:bg-oai-gray-900 p-5 ${className}`}>
      <div className="flex items-center justify-between gap-3 mb-4">
        <h3 className="text-sm font-medium text-oai-gray-500 dark:text-oai-gray-300 uppercase tracking-wide">
          {copy("dashboard.projects.title")}
        </h3>
        <Select.Root
          value={resolvedLimit}
          items={LIMIT_OPTIONS.map((value) => ({
            value,
            label: optionLabels[value],
          }))}
          onValueChange={(value) => {
            if (typeof onLimitChange === "function" && value != null) {
              onLimitChange(value);
            }
          }}
        >
          <Select.Trigger
            aria-label={limitAria}
            className="px-2 py-1 text-xs text-oai-gray-600 dark:text-oai-gray-300 bg-white dark:bg-oai-gray-900 border border-oai-gray-200 dark:border-oai-gray-700 rounded hover:border-oai-gray-300 dark:hover:border-oai-gray-600"
          >
            <Select.Value />
          </Select.Trigger>
          <Select.Portal>
            <Select.Positioner align="end" side="bottom" sideOffset={4} className="z-50">
              <Select.Popup className="w-32 border border-oai-gray-200 dark:border-oai-gray-700 bg-white dark:bg-oai-gray-900 rounded-lg shadow-lg">
                <Select.List aria-label={limitAria} role="listbox">
                  {LIMIT_OPTIONS.map((value) => (
                    <Select.Item
                      key={value}
                      value={value}
                      className={({ selected }) =>
                        `w-full text-left px-3 py-2 text-xs ${
                          selected
                            ? "bg-oai-gray-100 dark:bg-oai-gray-800 text-oai-black dark:text-oai-white"
                            : "text-oai-gray-600 dark:text-oai-gray-300 hover:bg-oai-gray-50 dark:hover:bg-oai-gray-800"
                        }`
                      }
                    >
                      <Select.ItemText>{optionLabels[value]}</Select.ItemText>
                    </Select.Item>
                  ))}
                </Select.List>
              </Select.Popup>
            </Select.Positioner>
          </Select.Portal>
        </Select.Root>
      </div>

      {displayEntries.length === 0 ? (
        <div className="text-sm text-oai-gray-400 dark:text-oai-gray-400">{emptyLabel}</div>
      ) : (
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
          {displayEntries.map((entry) => (
            <ProjectUsageCard
              key={`${entry?.project_key || "repo"}-${entry?.project_ref || ""}`}
              entry={entry}
              onSelectEntry={onSelectEntry}
              placeholder={placeholder}
              tokensLabel={tokensLabel}
              starsLabel={starsLabel}
              tokenFormatOptions={tokenFormatOptions}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectUsageCard({
  entry,
  onSelectEntry,
  placeholder,
  tokensLabel,
  starsLabel,
  tokenFormatOptions,
}) {
  const repoKey = typeof entry?.project_key === "string" ? entry.project_key : "";
  const projectRef = typeof entry?.project_ref === "string" ? entry.project_ref : "";
  const { owner, repo } = splitRepoKey(
    repoKey || projectRef.replace("https://github.com/", "")
  );
  const repoId = owner && repo ? `${owner}/${repo}` : repoKey;
  const meta = useGithubRepoMeta(repoId);
  const avatarUrl =
    meta?.avatarUrl || (owner ? `https://github.com/${owner}.png?size=80` : "");
  const starsRaw = meta?.stars;
  const starsFull =
    starsRaw == null ? placeholder : toDisplayNumber(starsRaw);
  const starsCompact =
    starsRaw == null
      ? placeholder
      : formatCompactNumber(starsRaw, tokenFormatOptions);
  const tokensRaw = resolveTokens(entry);
  const tokensFull =
    tokensRaw == null ? placeholder : toDisplayNumber(tokensRaw);
  const tokensCompact =
    tokensRaw == null
      ? placeholder
      : formatCompactNumber(tokensRaw, tokenFormatOptions);

  return (
    <button
      type="button"
      data-project-card="true"
      onClick={() => onSelectEntry?.(entry)}
      className="w-full text-left flex items-center gap-3 p-3 rounded-lg border border-oai-gray-200 dark:border-oai-gray-700 hover:border-oai-gray-300 dark:hover:border-oai-gray-600 transition-colors"
    >
      {avatarUrl ? (
        <img src={avatarUrl} alt="" className="w-10 h-10 rounded bg-oai-gray-100 dark:bg-oai-gray-800 object-cover" />
      ) : (
        <div className="w-10 h-10 rounded bg-oai-gray-100 dark:bg-oai-gray-800" />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-oai-black dark:text-oai-white truncate">
          {repo || repoKey || placeholder}
        </div>
        <div className="flex items-center gap-3 text-xs text-oai-gray-400 dark:text-oai-gray-400 mt-0.5">
          <span>★ {starsCompact}</span>
          <span>{tokensCompact}</span>
        </div>
      </div>
    </button>
  );
}
