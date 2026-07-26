import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Calendar, Loader2, RefreshCw, Search, Terminal, X as XIcon } from "lucide-react";
import { Input } from "../ui/components";
import { SegmentedControl } from "../ui/components/SegmentedControl.jsx";
import { SearchableSelect } from "../ui/components/SearchableSelect.jsx";
import { ProviderIcon } from "../ui/dashboard/components/ProviderIcon.jsx";
import { HoverTooltip } from "../ui/components/HoverTooltip.jsx";
import { showToast } from "../ui/components/Toast.jsx";
import { LocalOnlyNotice } from "../components/LocalOnlyNotice.jsx";
import { copy } from "../lib/copy";
import { cn } from "../lib/cn";
import { getSessions } from "../lib/sessions-api";
import { formatCompactNumber, formatUsdCurrency } from "../lib/format";
import { useCurrency } from "../hooks/useCurrency";
import { useLocale } from "../hooks/useLocale";
import { isLocalDashboardHost } from "../lib/host-mode";
import { isMockEnabled } from "../lib/mock-data";

const IS_LOCAL_HOST = isLocalDashboardHost();

// Stable empty array so the memos below don't recompute on every render while
// there is no data yet.
const NO_SESSIONS = [];

// How many rows to put in the DOM at once. The whole (already fetched) list is
// filtered in memory; only the rendered slice grows as the user scrolls, so a
// few thousand sessions stay responsive without a virtualization dependency.
const PAGE_SIZE = 100;

const SOURCE_FILTERS = [
  { id: "all", label: () => copy("sessions.filter.source_all") },
  { id: "claude", label: () => "Claude Code" },
  { id: "codex", label: () => "Codex" },
  { id: "grok", label: () => "Grok" },
];

const DATE_RANGES = [
  { id: "all", days: 0, label: () => copy("sessions.filter.range_all") },
  { id: "7d", days: 7, label: () => copy("sessions.filter.range_7d") },
  { id: "30d", days: 30, label: () => copy("sessions.filter.range_30d") },
  { id: "90d", days: 90, label: () => copy("sessions.filter.range_90d") },
];

// Earliest timestamp a range chip admits, as epoch ms in the *viewer's* time
// zone. The whole list is fetched once and filtered here, so the range chips
// never re-query: switching them is instant and cannot drop rows the way a
// server-side day-string comparison did (a UTC-sliced day boundary put a
// UTC+8 user's early-morning sessions on the wrong calendar day).
function rangeStartMs(rangeId) {
  const days = DATE_RANGES.find((range) => range.id === rangeId)?.days || 0;
  if (!days) return 0;
  const start = new Date();
  // Inclusive range: "7d" is today plus the previous six local calendar days.
  start.setDate(start.getDate() - (days - 1));
  start.setHours(0, 0, 0, 0);
  return start.getTime();
}

// A session counts as inside the window when it *overlaps* it: one that started
// earlier but ran into the window is still relevant, and it is also the row
// sorted to the top (the list is ordered by ended_at).
function overlapsRange(session, startMs) {
  if (!startMs) return true;
  const ended = Date.parse(session.ended_at || session.started_at || "");
  return Number.isFinite(ended) ? ended >= startMs : true;
}

function formatWhen(value, locale) {
  if (!value) return "—";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "—";
  try {
    return new Date(ms).toLocaleString(locale || undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  }
}

function formatDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const totalMinutes = Math.round(n / 60000);
  if (totalMinutes < 60) return copy("sessions.duration.minutes", { minutes: totalMinutes });
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return copy("sessions.duration.hours", { hours, minutes });
}

async function copyToClipboard(text) {
  if (navigator?.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  // Fallback for insecure contexts / older browsers.
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(area);
  return ok;
}

const SessionRow = React.memo(function SessionRow({ session, locale }) {
  const { currency, rate } = useCurrency();
  const provider = String(session.source || "").toUpperCase();
  const duration = formatDuration(session.duration_ms);
  const command = session.resume_command;
  const projectLabel = session.project_key || copy("sessions.project.unknown");
  const title = session.title || projectLabel;
  const showProjectInMeta = Boolean(session.title && session.project_key);

  // The resume command only works from the session's own directory, so the full
  // local path has to stay reachable. Hover reveals it, click copies it — that
  // keeps a long absolute path out of every row while still being one click
  // away from `cd`.
  const pathTooltip = session.project_ref
    ? `${session.project_ref}\n${copy("sessions.project.copy_hint")}`
    : undefined;

  const handleCopyPath = async () => {
    if (!session.project_ref) return;
    try {
      const ok = await copyToClipboard(session.project_ref);
      if (ok) showToast({ title: copy("sessions.project.copied") });
      else showToast({ title: copy("sessions.project.copy_failed") });
    } catch {
      showToast({ title: copy("sessions.project.copy_failed") });
    }
  };

  // The hover wrapper must NOT carry `truncate`: that sets overflow:hidden,
  // which clips the tooltip (it is absolutely positioned above the label).
  // Wrapper owns `group relative`; the inner button owns the truncation.
  const projectLabelNode = (extraClass) => (
    <span className="group relative inline-flex min-w-0 max-w-full">
      <HoverTooltip text={pathTooltip} placement="bottom" />
      <button
        type="button"
        onClick={handleCopyPath}
        aria-label={copy("sessions.project.copy_aria", { project: projectLabel })}
        className={cn(
          "max-w-full truncate rounded text-left underline decoration-dotted decoration-oai-gray-300 underline-offset-4 hover:decoration-oai-gray-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:decoration-oai-gray-600 dark:hover:decoration-oai-gray-400",
          extraClass,
        )}
      >
        {projectLabel}
      </button>
    </span>
  );

  const handleCopy = async () => {
    if (!command) return;
    try {
      // The insecure-context fallback reports failure by returning false
      // instead of throwing, so the return value decides the toast — otherwise
      // we claim success with an empty clipboard.
      const ok = await copyToClipboard(command);
      // Literal copy() keys so the copy-registry validator can see both.
      if (ok) showToast({ title: copy("sessions.resume.copied") });
      else showToast({ title: copy("sessions.resume.copy_failed") });
    } catch {
      showToast({ title: copy("sessions.resume.copy_failed") });
    }
  };

  return (
    <li className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start">
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        <span className="mt-0.5 shrink-0 text-oai-gray-400 dark:text-oai-gray-500">
          <ProviderIcon provider={provider} size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {/* With no agent-authored title the heading *is* the project name,
                so the copy affordance moves there rather than duplicating it. */}
            {!session.title && session.project_ref ? (
              projectLabelNode("font-medium text-oai-black dark:text-white")
            ) : (
              <span className="truncate font-medium text-oai-black dark:text-white">
                {title}
              </span>
            )}
            {session.first_pass ? (
              <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
                {copy("sessions.badge.first_pass")}
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-oai-gray-500 dark:text-oai-gray-400">
            {showProjectInMeta ? (
              <>
                {session.project_ref ? (
                  projectLabelNode("hover:text-oai-black dark:hover:text-white")
                ) : (
                  <span className="truncate">{projectLabel}</span>
                )}
                <span aria-hidden>·</span>
              </>
            ) : null}
            <span className="truncate">{session.model || copy("sessions.model.unknown")}</span>
            <span aria-hidden>·</span>
            <span className="tabular-nums">{formatWhen(session.started_at, locale)}</span>
            {duration ? (
              <>
                <span aria-hidden>·</span>
                <span className="tabular-nums">{duration}</span>
              </>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex items-start gap-5 pl-[30px] sm:pl-0">
        <dl className="flex items-start gap-6 text-right">
          <div className="flex w-16 flex-col-reverse">
            <dt className="text-[11px] text-oai-gray-400 dark:text-oai-gray-500">{copy("sessions.col.tokens")}</dt>
            <dd className="tabular-nums text-sm font-medium text-oai-black dark:text-white">{formatCompactNumber(session.total_tokens)}</dd>
          </div>
          <div className="flex w-16 flex-col-reverse">
            <dt className="text-[11px] text-oai-gray-400 dark:text-oai-gray-500">{copy("sessions.col.cost")}</dt>
            <dd className="tabular-nums text-sm font-medium text-oai-black dark:text-white">{formatUsdCurrency(session.cost_usd, { currency, rate })}</dd>
          </div>
          <div className="hidden w-10 flex-col-reverse sm:flex">
            <dt className="text-[11px] text-oai-gray-400 dark:text-oai-gray-500">{copy("sessions.col.turns")}</dt>
            <dd className="tabular-nums text-sm font-medium text-oai-black dark:text-white">{formatCompactNumber(session.turns)}</dd>
          </div>
          <div className="hidden w-10 flex-col-reverse sm:flex">
            <dt className="text-[11px] text-oai-gray-400 dark:text-oai-gray-500">{copy("sessions.col.edits")}</dt>
            <dd className="tabular-nums text-sm font-medium text-oai-black dark:text-white">{formatCompactNumber(session.edit_turns)}</dd>
          </div>
        </dl>

        <button
          type="button"
          onClick={handleCopy}
          disabled={!command}
          title={command || copy("sessions.resume.unavailable")}
          aria-label={command ? copy("sessions.resume.copy_aria", { command }) : copy("sessions.resume.unavailable")}
          className={cn(
            "-mt-0.5 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500",
            command
              ? "text-oai-gray-500 hover:bg-oai-gray-100 hover:text-oai-black dark:text-oai-gray-400 dark:hover:bg-oai-gray-800 dark:hover:text-white"
              : "cursor-not-allowed text-oai-gray-300 dark:text-oai-gray-600",
          )}
        >
          <Terminal className="h-3.5 w-3.5" aria-hidden />
          <span className="hidden sm:inline">{copy("sessions.resume.copy")}</span>
        </button>
      </div>
    </li>
  );
});

export function SessionsPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sourceFilter, setSourceFilter] = useState("all");
  const [rangeFilter, setRangeFilter] = useState("all");
  const [projectFilter, setProjectFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const requestIdRef = useRef(0);
  const { resolvedLocale } = useLocale();

  // Fetch the whole list once. The payload is metadata only (~0.5KB/session)
  // over loopback, and the server builds every session regardless of the date
  // range anyway, so a server-side window would cost a round trip without
  // saving any work — and it would make the source/project/search filters mean
  // "within the fetched page" instead of "within your sessions".
  const load = useCallback(async (refresh = false) => {
    const requestId = ++requestIdRef.current;
    if (refresh) setRefreshing(true);
    else setIsLoading(true);
    setError(null);
    try {
      const result = await getSessions({ refresh });
      // A cold scan can take several seconds; never let an older response
      // overwrite a newer one.
      if (requestId === requestIdRef.current) setData(result);
    } catch (err) {
      if (requestId === requestIdRef.current) setError(err?.message || String(err));
    } finally {
      if (requestId === requestIdRef.current) {
        setIsLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    if (IS_LOCAL_HOST || isMockEnabled()) void load(false);
    else setIsLoading(false);
  }, [load]);

  const allSessions = data?.sessions || NO_SESSIONS;
  // Distinct project names present in the loaded sessions, for the project
  // filter dropdown. Keyed by project_key (what the row filter matches on).
  const projectOptions = useMemo(() => {
    const seen = new Set();
    const options = [];
    for (const row of allSessions) {
      const key = row.project_key;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      options.push({ value: key, label: key });
    }
    return options.sort((a, b) => a.label.localeCompare(b.label));
  }, [allSessions]);

  // Typing stays responsive on long lists: the filter runs against a deferred
  // copy of the query, so keystrokes paint before the list re-filters.
  const deferredQuery = useDeferredValue(searchQuery);

  const filtered = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    const startMs = rangeStartMs(rangeFilter);
    return allSessions.filter((row) => {
      if (sourceFilter !== "all" && row.source !== sourceFilter) return false;
      if (projectFilter !== "all" && row.project_key !== projectFilter) return false;
      if (!overlapsRange(row, startMs)) return false;
      if (!q) return true;
      const haystack = `${row.title || ""} ${row.project_key || ""} ${row.model || ""} ${row.project_ref || ""} ${row.session_id || ""}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [allSessions, sourceFilter, projectFilter, rangeFilter, deferredQuery]);

  const anyFilter = sourceFilter !== "all" || rangeFilter !== "all" || projectFilter !== "all" || searchQuery.trim() !== "";

  // Restart the rendered window whenever the result set changes, so a narrower
  // filter doesn't leave the user scrolled into a stale slice.
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [sourceFilter, projectFilter, rangeFilter, deferredQuery, allSessions]);

  const visible = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount]);
  const hasMore = filtered.length > visible.length;
  const showMore = useCallback(() => setVisibleCount((n) => n + PAGE_SIZE), []);

  // Auto-extend the window when the sentinel below the list scrolls into view.
  // The button inside it stays functional (and keyboard-reachable) when
  // IntersectionObserver is unavailable.
  const sentinelRef = useRef(null);
  useEffect(() => {
    if (!hasMore || typeof IntersectionObserver === "undefined") return undefined;
    const node = sentinelRef.current;
    if (!node) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) showMore();
      },
      { rootMargin: "400px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, showMore]);

  const sourceOptions = useMemo(
    () => SOURCE_FILTERS.map((option) => ({ id: option.id, label: option.label() })),
    [resolvedLocale],
  );
  const rangeOptions = useMemo(
    () => DATE_RANGES.map((option) => ({ id: option.id, label: option.label() })),
    [resolvedLocale],
  );

  const truncated = Number(data?.session_count) > Number(data?.returned_count);

  // Sessions read local Claude/Codex/Grok logs from the machine running the CLI;
  // there is no cloud source. On the deployed web app, surface the local-only
  // notice instead of an empty list.
  if (!IS_LOCAL_HOST && !isMockEnabled()) {
    return (
      <div className="flex flex-col flex-1 text-oai-black dark:text-oai-white font-oai antialiased">
        <LocalOnlyNotice />
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 text-oai-black dark:text-oai-white font-oai antialiased">
      <main className="flex-1 pt-8 sm:pt-10 pb-12 sm:pb-16">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="mb-8 flex flex-row items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="mb-3 text-3xl font-semibold tracking-tight text-oai-black dark:text-white sm:text-4xl">
                {copy("nav.sessions")}
              </h1>
              <p className="text-sm text-oai-gray-500 dark:text-oai-gray-400 sm:text-base">
                {copy("sessions.page.subtitle")}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void load(true)}
              disabled={refreshing || isLoading}
              aria-label={copy("sessions.page.refresh")}
              title={copy("sessions.page.refresh")}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-oai-gray-200 text-oai-gray-600 transition-colors hover:bg-oai-gray-100 hover:text-oai-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 disabled:opacity-50 dark:border-oai-gray-800 dark:text-oai-gray-400 dark:hover:bg-oai-gray-800 dark:hover:text-white"
            >
              <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} aria-hidden />
            </button>
          </div>

          <div className="mb-2 flex flex-wrap items-center gap-2 pt-1 text-xs text-oai-gray-600 dark:text-oai-gray-300">
            <SegmentedControl
              ariaLabel={copy("sessions.filter.source_aria")}
              options={sourceOptions}
              value={sourceFilter}
              onChange={setSourceFilter}
            />

            <SegmentedControl
              className="pl-2"
              ariaLabel={copy("sessions.filter.range_aria")}
              leading={<Calendar className="h-3.5 w-3.5 shrink-0 text-oai-gray-400" aria-hidden />}
              options={rangeOptions}
              value={rangeFilter}
              onChange={setRangeFilter}
            />

            <SearchableSelect
              options={projectOptions}
              value={projectFilter}
              onChange={setProjectFilter}
              allLabel={copy("sessions.filter.project_all")}
              searchPlaceholder={copy("sessions.filter.project_search")}
              emptyLabel={copy("sessions.filter.project_empty")}
              ariaLabel={copy("sessions.filter.project_aria")}
            />

            <div className="relative w-72 max-w-full">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-oai-gray-400" aria-hidden />
              <Input
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && searchQuery) {
                    event.preventDefault();
                    setSearchQuery("");
                  }
                }}
                aria-label={copy("sessions.action.search_aria")}
                placeholder={copy("sessions.search.placeholder")}
                className="h-8 pl-9 pr-8 !border-oai-gray-200 dark:!border-oai-gray-800 focus:!border-oai-gray-400 focus:!ring-oai-gray-400/20 dark:focus:!border-oai-gray-500 dark:focus:!ring-oai-gray-500/20 [&::-webkit-search-cancel-button]:appearance-none"
              />
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setSearchQuery("")}
                aria-label={copy("sessions.action.search_clear")}
                aria-hidden={!searchQuery}
                tabIndex={searchQuery ? 0 : -1}
                className={cn(
                  "absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-oai-gray-400 transition duration-150 ease-out hover:bg-oai-gray-100 hover:text-oai-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-gray-400/40 dark:hover:bg-oai-gray-800 dark:hover:text-oai-gray-200",
                  searchQuery ? "scale-100 opacity-100" : "pointer-events-none scale-90 opacity-0",
                )}
              >
                <XIcon className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>

            <span className="ml-auto shrink-0 tabular-nums text-oai-gray-500 dark:text-oai-gray-400">
              {copy("sessions.filter.result_count", { filtered: filtered.length, total: allSessions.length })}
            </span>
          </div>

          {truncated ? (
            <p className="mb-4 text-xs text-oai-gray-500 dark:text-oai-gray-400">
              {copy("sessions.truncated", { shown: data.returned_count, total: data.session_count })}
            </p>
          ) : null}

          {error && !data ? (
            <div className="rounded-xl border border-dashed border-red-300 py-16 text-center dark:border-red-500/40">
              <p className="text-sm font-medium text-oai-black dark:text-white">{copy("sessions.error.title")}</p>
              <p className="mt-1 text-sm text-oai-gray-500 dark:text-oai-gray-400">{error}</p>
              <button
                type="button"
                onClick={() => void load(false)}
                className="mt-4 inline-flex h-8 items-center rounded-md border border-oai-gray-200 px-3 text-xs font-medium text-oai-gray-700 transition-colors hover:bg-oai-gray-100 hover:text-oai-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:border-oai-gray-800 dark:text-oai-gray-200 dark:hover:bg-oai-gray-800 dark:hover:text-white"
              >
                {copy("sessions.error.retry")}
              </button>
            </div>
          ) : isLoading ? (
            <div className="flex items-center gap-2 py-16 text-sm text-oai-gray-500 dark:text-oai-gray-400">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              {copy("sessions.loading")}
            </div>
          ) : filtered.length === 0 ? (
            <div className="rounded-xl border border-dashed border-oai-gray-200 py-16 text-center dark:border-oai-gray-800">
              <p className="text-sm font-medium text-oai-black dark:text-white">
                {anyFilter ? copy("sessions.empty.filtered_title") : copy("sessions.empty.title")}
              </p>
              <p className="mt-1 text-sm text-oai-gray-500 dark:text-oai-gray-400">
                {anyFilter ? copy("sessions.empty.filtered_body") : copy("sessions.empty.body")}
              </p>
            </div>
          ) : (
            <>
              {error ? (
                <p className="mb-4 text-sm text-red-500 dark:text-red-400">{copy("shared.error.prefix", { error })}</p>
              ) : null}
              <ul className="divide-y divide-oai-gray-200/70 dark:divide-oai-gray-800/70">
                {visible.map((session) => (
                  <SessionRow key={session.session_hash} session={session} locale={resolvedLocale} />
                ))}
              </ul>
              {hasMore ? (
                <div ref={sentinelRef} className="flex justify-center pt-6">
                  <button
                    type="button"
                    onClick={showMore}
                    className="inline-flex h-8 items-center rounded-md border border-oai-gray-200 px-3 text-xs font-medium text-oai-gray-600 transition-colors hover:bg-oai-gray-100 hover:text-oai-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:border-oai-gray-800 dark:text-oai-gray-300 dark:hover:bg-oai-gray-800 dark:hover:text-white"
                  >
                    {copy("sessions.action.load_more")}
                  </button>
                </div>
              ) : null}
            </>
          )}

          <p className="mt-6 text-xs text-oai-gray-400 dark:text-oai-gray-500">
            {copy("sessions.privacy")}
          </p>
        </div>
      </main>
    </div>
  );
}
