import React, { useEffect, useRef } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Checkbox } from "@base-ui/react/checkbox";
import { ArrowUpCircle, Check, ExternalLink, Info, Loader2, MonitorSmartphone, Trash2, X } from "lucide-react";
import { ProviderIcon } from "../ui/dashboard/components/ProviderIcon.jsx";
import { copy } from "../lib/copy";
import { cn } from "../lib/cn";
import { formatUsdCurrency, toDisplayNumber } from "../lib/format";
import { useCurrency } from "../hooks/useCurrency.js";

function targetBusyKey(skillId, targetId) {
  return `target:${skillId}:${targetId}`;
}

function removeBusyKey(skill) {
  return `remove:${skill.id || skill.directory}`;
}

function daysSince(iso) {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  return Math.floor((Date.now() - then) / 86400000);
}

function relativeLastUsed(iso) {
  const days = daysSince(iso);
  if (days == null) return null;
  if (days <= 0) return copy("skills.usage.today");
  if (days < 30) return copy("skills.usage.days_ago", { days });
  const months = Math.max(1, Math.floor(days / 30));
  return copy("skills.usage.months_ago", { months });
}

// Recency tone for the last-used dot: fresh (≤7d) green, fading (≤30d) amber,
// stale / never gray. Meaningful color, not decorative — at-a-glance "do I still
// use this".
function freshnessTone(iso) {
  const days = daysSince(iso);
  if (days == null) return "bg-oai-gray-300 dark:bg-oai-gray-600";
  if (days <= 7) return "bg-emerald-500";
  if (days <= 30) return "bg-amber-500";
  return "bg-oai-gray-300 dark:bg-oai-gray-600";
}

// One properties row: muted label left, value right. Detail-panel convention,
// not a metrics dashboard.
function PropRow({ label, children }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 text-sm">
      <dt className="flex items-center gap-1 text-oai-gray-500 dark:text-oai-gray-400">{label}</dt>
      <dd className="text-right font-medium tabular-nums text-oai-black dark:text-white">{children}</dd>
    </div>
  );
}

export function SkillDetailPanel({
  skill,
  targets,
  busyKey,
  usage,
  hasUpdate,
  updating,
  onUpdate,
  onClose,
  onToggleTarget,
  onRemove,
}) {
  return (
    <AnimatePresence>
      {skill ? (
        <SkillDetailPanelInner
          key={skill.id || skill.directory}
          skill={skill}
          targets={targets}
          busyKey={busyKey}
          usage={usage}
          hasUpdate={hasUpdate}
          updating={updating}
          onUpdate={onUpdate}
          onClose={onClose}
          onToggleTarget={onToggleTarget}
          onRemove={onRemove}
        />
      ) : null}
    </AnimatePresence>
  );
}

function SkillDetailPanelInner({
  skill,
  targets,
  busyKey,
  usage,
  hasUpdate,
  updating,
  onUpdate,
  onClose,
  onToggleTarget,
  onRemove,
}) {
  const reduceMotion = useReducedMotion();
  const { currency, rate } = useCurrency();
  const panelRef = useRef(null);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose?.();
      }
    };
    const onPointerDown = (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      // Clicks inside the panel keep it open.
      if (panelRef.current?.contains(target)) return;
      // Clicks on a skill row are handled by the row (select / toggle) — don't
      // pre-empt by closing here, otherwise the panel flickers shut/open.
      if (target.closest('[data-skill-row="1"]')) return;
      onClose?.();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [onClose]);

  const title = skill.name || skill.directory;
  const hasRepo = Boolean(skill.repoOwner && skill.repoName);
  const repoUrl = hasRepo
    ? `https://github.com/${skill.repoOwner}/${skill.repoName}`
    : null;
  const activeTargetIds = new Set(skill.targets || []);
  const readOnly = Boolean(skill.readOnly || skill.remote);
  const remote = Boolean(skill.remote);
  const deviceSources = Array.isArray(skill.deviceSources) ? skill.deviceSources : [];
  const showUsage = !remote && (!readOnly || activeTargetIds.has("claude"));
  const removing = busyKey === removeBusyKey(skill);
  const lastUsed = relativeLastUsed(usage?.lastUsedAt);
  const hasUsage = Boolean(usage && usage.invocations > 0);

  const transition = reduceMotion
    ? { duration: 0 }
    : { type: "spring", stiffness: 320, damping: 30, mass: 0.7 };

  return (
    <>
      {/* Mobile-only backdrop — desktop overlays the rail without dimming the list. */}
      <motion.div
        className="fixed inset-0 z-20 bg-oai-black/30 backdrop-blur-[2px] lg:hidden"
        initial={reduceMotion ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: reduceMotion ? 0 : 0.15 }}
        onClick={onClose}
        aria-hidden
      />
      <motion.aside
        ref={panelRef}
        role="complementary"
        aria-label={title}
        initial={
          reduceMotion ? false : { opacity: 0, x: 24, scale: 0.98 }
        }
        animate={{ opacity: 1, x: 0, scale: 1 }}
        exit={
          reduceMotion ? { opacity: 0 } : { opacity: 0, x: 24, scale: 0.98 }
        }
        transition={transition}
        className={
          // Mobile: bottom sheet; Desktop: fixed right rail with breathing room.
          // Frosted glass: semi-transparent fill + backdrop-blur + subtle inset ring.
          "fixed inset-x-3 bottom-3 top-20 z-30 flex flex-col overflow-hidden rounded-2xl border border-white/40 bg-white/75 shadow-[0_24px_60px_-20px_rgba(15,23,42,0.25)] backdrop-blur-xl backdrop-saturate-150 supports-[backdrop-filter]:bg-white/65 dark:border-white/10 dark:bg-oai-gray-950/70 dark:shadow-[0_24px_60px_-20px_rgba(0,0,0,0.7)] dark:supports-[backdrop-filter]:bg-oai-gray-950/55 " +
          "lg:inset-auto lg:right-6 lg:top-24 lg:bottom-6 lg:w-[22rem] lg:max-h-[calc(100vh-7.5rem)]"
        }
      >
        {/* Sticky header — title + source link + close X */}
        <header className="flex items-center gap-3 border-b border-white/40 bg-gradient-to-b from-white/30 to-transparent px-5 pb-4 pt-5 dark:border-white/10 dark:from-white/[0.04]">
          <div className="min-w-0 flex-1">
            <h2
              className="truncate text-base font-semibold text-oai-black dark:text-white"
              title={title}
            >
              {title}
            </h2>
            {hasRepo ? (
              <a
                href={repoUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="mt-1 inline-flex max-w-full items-center gap-1 truncate text-xs text-oai-gray-500 transition-colors hover:text-oai-black hover:underline dark:text-oai-gray-400 dark:hover:text-white"
                title={repoUrl}
              >
                <span className="truncate">
                  {skill.repoOwner}/{skill.repoName}
                </span>
                <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
              </a>
            ) : skill.directory && skill.directory !== title ? (
              <div
                className="mt-1 truncate text-xs text-oai-gray-500 dark:text-oai-gray-400"
                title={skill.directory}
              >
                {skill.directory}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={copy("skills.detail.close")}
            className="-mr-1 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-oai-gray-500 transition hover:bg-oai-gray-100 hover:text-oai-black focus:outline-none focus:ring-2 focus:ring-oai-gray-400/30 dark:text-oai-gray-400 dark:hover:bg-oai-gray-800 dark:hover:text-white"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </header>

        {/* Scrollable body — update banner + description + usage + sync targets */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          {hasUpdate ? (
            <div className="mb-4 flex items-center gap-3 rounded-xl bg-sky-50/80 px-3 py-2.5 ring-1 ring-sky-200 dark:bg-sky-950/30 dark:ring-sky-800/60">
              <ArrowUpCircle className="h-4 w-4 shrink-0 text-sky-600 dark:text-sky-300" aria-hidden />
              <span className="min-w-0 flex-1 text-xs text-sky-800 dark:text-sky-200">
                {copy("skills.update.available")}
              </span>
              <button
                type="button"
                onClick={() => onUpdate?.(skill)}
                disabled={updating}
                className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md bg-sky-600 px-2.5 text-xs font-semibold text-white transition hover:bg-sky-700 focus:outline-none focus:ring-2 focus:ring-sky-400/40 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-sky-500 dark:hover:bg-sky-400"
              >
                {updating ? (
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                ) : null}
                {copy("skills.update.action")}
              </button>
            </div>
          ) : null}
          {skill.description ? (
            <p className="text-sm leading-6 text-oai-gray-600 dark:text-oai-gray-300">
              {skill.description}
            </p>
          ) : null}
          {readOnly ? (
            <div className="mt-4 rounded-xl bg-oai-gray-50 px-3 py-2.5 text-xs leading-5 text-oai-gray-600 ring-1 ring-oai-gray-200 dark:bg-oai-gray-900/60 dark:text-oai-gray-300 dark:ring-oai-gray-800">
              {copy(remote ? "skills.inventory.read_only_remote" : "skills.inventory.read_only_managed")}
            </div>
          ) : null}
          {skill.sourceName ? (
            <div className="mt-3 text-xs text-oai-gray-500 dark:text-oai-gray-400">
              {copy("skills.inventory.source", { source: skill.sourceName })}
            </div>
          ) : null}
          {deviceSources.length ? (
            <section className="mt-5">
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-oai-gray-500 dark:text-oai-gray-400">
                {copy("skills.inventory.devices_title")}
              </h3>
              <div className="flex flex-wrap gap-2">
                {deviceSources.map((device) => (
                  <span
                    key={device.id}
                    className="inline-flex min-w-0 items-center gap-1.5 rounded-full bg-oai-gray-100 px-2.5 py-1 text-xs text-oai-gray-700 ring-1 ring-oai-gray-200 dark:bg-oai-gray-800 dark:text-oai-gray-200 dark:ring-oai-gray-700"
                  >
                    <MonitorSmartphone className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span className="max-w-52 truncate">{device.name}</span>
                  </span>
                ))}
              </div>
            </section>
          ) : null}

          {/* Activity — properties list (NOT a metrics dashboard). Surfaced near
              the top because "do I use this / what does it cost" is the keep-or-cut
              decision and the angle only a token tracker can show. */}
          {showUsage ? <section className="mt-6">
            <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-oai-gray-500 dark:text-oai-gray-400">
              {copy("skills.usage.section_title")}
            </h3>
            <dl className="divide-y divide-oai-gray-200/60 dark:divide-white/[0.06]">
              <PropRow label={copy("skills.usage.invocations")}>
                {toDisplayNumber(usage?.invocations || 0)}
              </PropRow>
              <PropRow label={copy("skills.usage.last_used")}>
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className={cn("h-1.5 w-1.5 rounded-full", freshnessTone(usage?.lastUsedAt))}
                    aria-hidden
                  />
                  {hasUsage ? lastUsed || copy("skills.usage.unknown") : copy("skills.usage.never")}
                </span>
              </PropRow>
              <PropRow
                label={
                  <>
                    {copy("skills.usage.cost")}
                    <span
                      title={copy("skills.usage.disclaimer")}
                      className="inline-flex cursor-help text-oai-gray-400 dark:text-oai-gray-500"
                    >
                      <Info className="h-3 w-3" aria-label={copy("skills.usage.disclaimer")} />
                    </span>
                  </>
                }
              >
                {formatUsdCurrency(usage?.cost || 0, { currency, rate })}
              </PropRow>
            </dl>
            {!hasUsage ? (
              <p className="mt-2 text-[11px] leading-4 text-oai-gray-400 dark:text-oai-gray-500">
                {copy("skills.usage.unused")}
              </p>
            ) : null}
          </section> : null}

          {!readOnly ? <section className="mt-6">
            <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-oai-gray-500 dark:text-oai-gray-400">
              {copy("skills.detail.sync_section_title")}
            </h3>
            {/* Boxless rows: content flush-left with the heading (the -mx-2/px-2
                keeps the hover highlight padded without indenting the checkbox).
                No outer ring box — that was a nested card and pushed the column in. */}
            <div>
              {(targets || []).filter((target) => target.manageable !== false).map((target) => {
                const checked = activeTargetIds.has(target.id);
                const busy = busyKey === targetBusyKey(skill.id || skill.directory, target.id);
                const rowId = `skill-detail-sync-${skill.id || skill.directory}-${target.id}`;
                return (
                  <label
                    key={target.id}
                    htmlFor={rowId}
                    className="-mx-2 flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-sm text-oai-black transition-colors hover:bg-oai-gray-100/70 dark:text-white dark:hover:bg-white/[0.05]"
                  >
                    <Checkbox.Root
                      id={rowId}
                      checked={checked}
                      disabled={busy}
                      onCheckedChange={(next) =>
                        onToggleTarget?.(skill, target.id, Boolean(next))
                      }
                      className="peer flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border border-oai-gray-300/80 bg-white/80 shadow-sm transition-colors hover:border-oai-gray-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-gray-400/40 focus-visible:ring-offset-1 focus-visible:ring-offset-transparent disabled:cursor-not-allowed disabled:opacity-50 data-[checked]:border-oai-black data-[checked]:bg-oai-black dark:border-oai-gray-500/60 dark:bg-oai-gray-900/60 dark:hover:border-oai-gray-400 dark:data-[checked]:border-white dark:data-[checked]:bg-white"
                    >
                      <Checkbox.Indicator className="flex items-center justify-center text-white dark:text-oai-black">
                        <Check
                          className="h-3 w-3"
                          strokeWidth={3.5}
                          aria-hidden
                        />
                      </Checkbox.Indicator>
                    </Checkbox.Root>
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center" aria-hidden>
                      <ProviderIcon provider={target.id} size={16} />
                    </span>
                    <span className="flex-1">{target.label}</span>
                    {busy ? (
                      <Loader2
                        className="h-3.5 w-3.5 animate-spin text-oai-gray-400"
                        aria-hidden
                      />
                    ) : null}
                  </label>
                );
              })}
            </div>
          </section> : null}
        </div>

        {/* Footer — destructive remove */}
        {!readOnly ? <footer className="border-t border-white/40 bg-white/30 px-5 py-4 dark:border-white/10 dark:bg-white/[0.02]">
          <button
            type="button"
            onClick={() => onRemove?.(skill)}
            disabled={removing}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-red-200/70 bg-white px-3 py-2 text-sm font-medium text-red-600 transition hover:border-red-300 hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-red-400/30 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-900/60 dark:bg-oai-gray-950 dark:text-red-300 dark:hover:border-red-800 dark:hover:bg-red-950/30"
          >
            {removing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
            )}
            {copy("skills.detail.remove_button")}
          </button>
          <p className="mt-2 text-center text-[11px] text-oai-gray-500 dark:text-oai-gray-400">
            {copy("skills.detail.remove_confirm_hint")}
          </p>
        </footer> : null}
      </motion.aside>
    </>
  );
}
