import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { Select } from "@base-ui/react/select";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X as XIcon,
} from "lucide-react";
import { Button, Card, ConfirmModal, DismissibleHint, Input } from "../ui/components";
import { ProviderIcon } from "../ui/dashboard/components/ProviderIcon.jsx";
import { SkillDetailPanel } from "./SkillDetailPanel.jsx";
import { copy } from "../lib/copy";
import { cn } from "../lib/cn";
import {
  addSkillRepo,
  deleteLocalSkill,
  discoverSkills,
  getInstalledSkills,
  getSkillRepos,
  importLocalSkill,
  installSkill,
  removeSkillRepo,
  restoreSkill,
  searchSkills,
  setSkillTargets,
  uninstallSkill,
} from "../lib/skills-api";

const DEFAULT_TARGETS = ["claude", "codex"];
const TARGET_CHIP_ICON_CLASSES = {
  claude: "text-orange-500 dark:text-orange-300",
  codex: "text-emerald-600 dark:text-emerald-300",
  gemini: "text-sky-600 dark:text-sky-300",
  opencode: "text-amber-600 dark:text-amber-300",
  hermes: "text-indigo-500 dark:text-indigo-300",
};
const SOURCE_ALL = "all";
const SOURCE_SKILLSSH = "skillssh";

function getSkillKey(skill) {
  return `${skill.repoOwner || "local"}/${skill.repoName || "local"}:${skill.directory}`;
}

function installBusyKey(skill) {
  return `install:${getSkillKey(skill)}`;
}

function removeBusyKey(skill) {
  return `remove:${skill.id || skill.directory}`;
}

function targetBusyKey(skillId, targetId) {
  return `target:${skillId}:${targetId}`;
}

function TargetChip({ target }) {
  return (
    <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-oai-gray-100 px-2 text-[11px] font-medium text-oai-gray-700 ring-1 ring-oai-gray-200/70 dark:bg-oai-gray-800/70 dark:text-oai-gray-200 dark:ring-oai-gray-700/70">
      <span className={cn("flex h-3.5 w-3.5 items-center justify-center", TARGET_CHIP_ICON_CLASSES[target.id])} aria-hidden>
        <ProviderIcon provider={target.id} size={14} />
      </span>
      {target.label}
    </span>
  );
}

function TargetChipRow({ skill, targets }) {
  const activeIds = new Set(skill.targets || []);
  const synced = targets.filter((t) => activeIds.has(t.id));
  if (!synced.length) {
    return (
      <span className="text-xs italic text-oai-gray-500 dark:text-oai-gray-400">
        {copy("skills.target.synced_none")}
      </span>
    );
  }
  const summary = synced.map((t) => t.label).join(", ");
  return (
    <div className="flex flex-wrap gap-1" aria-label={copy("skills.target.synced_summary", { targets: summary })}>
      {synced.map((target) => (
        <TargetChip key={target.id} target={target} />
      ))}
    </div>
  );
}

function SkillRow({ skill, targets, selected, onSelect }) {
  const sourceLabel =
    skill.repoOwner && skill.repoName ? `${skill.repoOwner}/${skill.repoName}` : null;
  const titleAttr = sourceLabel ? `${skill.directory} · ${sourceLabel}` : skill.directory;

  const handleKeyDown = (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect?.(skill);
    }
  };

  return (
    <div
      data-skill-row="1"
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={copy("skills.row.open_details", { name: skill.name || skill.directory })}
      onClick={() => onSelect?.(skill)}
      onKeyDown={handleKeyDown}
      className={cn(
        "flex cursor-pointer flex-col gap-3 rounded-md px-3 py-3 transition focus:outline-none focus:ring-2 focus:ring-oai-gray-400/30 lg:flex-row lg:items-center lg:gap-4",
        selected
          ? "bg-oai-gray-100 ring-1 ring-oai-gray-200 dark:bg-oai-gray-800/60 dark:ring-oai-gray-800"
          : "hover:bg-oai-gray-50 dark:hover:bg-oai-gray-900/40",
      )}
    >
      <div className="min-w-0 flex-1" title={titleAttr}>
        <h2 className="truncate text-sm font-semibold text-oai-black dark:text-white">
          {skill.name || skill.directory}
        </h2>
        {skill.description ? (
          <p className="mt-0.5 line-clamp-2 text-xs text-oai-gray-500 dark:text-oai-gray-400">
            {skill.description}
          </p>
        ) : null}
      </div>

      <div className="flex items-center gap-2 lg:gap-3">
        <TargetChipRow skill={skill} targets={targets} />
      </div>

      <ChevronRight
        className={cn(
          "hidden h-4 w-4 shrink-0 text-oai-gray-300 transition-colors dark:text-oai-gray-600 lg:block",
          selected && "text-oai-gray-500 dark:text-oai-gray-300",
        )}
        aria-hidden
      />
    </div>
  );
}

function FilterToolbar({
  agentFilter,
  agentOptions,
  onAgentFilter,
  filteredCount,
  totalCount,
  anyFilter,
  onClearFilters,
}) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 px-1 pt-1 text-xs text-oai-gray-600 dark:text-oai-gray-300">
      <Select.Root value={agentFilter} onValueChange={onAgentFilter}>
        <Select.Trigger
          aria-label={copy("skills.filter.agent_label")}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-oai-gray-200 bg-oai-white px-2.5 text-xs font-medium text-oai-gray-700 transition hover:border-oai-gray-300 focus:outline-none focus:ring-2 focus:ring-oai-gray-400/30 data-[popup-open]:border-oai-gray-300 dark:border-oai-gray-800 dark:bg-oai-gray-900 dark:text-oai-gray-200 dark:hover:border-oai-gray-700"
        >
          <span className="text-oai-gray-500 dark:text-oai-gray-400">
            {copy("skills.filter.agent_label")}:
          </span>
          <Select.Value>
            {(value) =>
              value === "all"
                ? copy("skills.filter.agent_all")
                : agentOptions.find((t) => t.id === value)?.label || value
            }
          </Select.Value>
          <Select.Icon className="text-oai-gray-400">
            <ChevronDown className="h-3.5 w-3.5" aria-hidden />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Positioner sideOffset={4} alignItemWithTrigger={false} className="z-[60]">
            <Select.Popup className="min-w-[var(--anchor-width)] overflow-hidden rounded-md border border-oai-gray-200 bg-white p-1 shadow-[0_12px_32px_-12px_rgba(0,0,0,0.18)] outline-none dark:border-oai-gray-800 dark:bg-oai-gray-950 dark:shadow-[0_12px_32px_-12px_rgba(0,0,0,0.6)]">
              <Select.Item
                value="all"
                className="flex cursor-default select-none items-center justify-between gap-2 rounded px-3 py-1.5 text-sm text-oai-black outline-none data-[highlighted]:bg-oai-gray-100 dark:text-white dark:data-[highlighted]:bg-oai-gray-800"
              >
                <Select.ItemText>{copy("skills.filter.agent_all")}</Select.ItemText>
                <Select.ItemIndicator>
                  <Check className="h-3.5 w-3.5" aria-hidden />
                </Select.ItemIndicator>
              </Select.Item>
              {agentOptions.map((target) => (
                <Select.Item
                  key={target.id}
                  value={target.id}
                  className="flex cursor-default select-none items-center justify-between gap-2 rounded px-3 py-1.5 text-sm text-oai-black outline-none data-[highlighted]:bg-oai-gray-100 dark:text-white dark:data-[highlighted]:bg-oai-gray-800"
                >
                  <div className="flex items-center gap-2">
                    <ProviderIcon provider={target.id} size={14} />
                    <Select.ItemText>{target.label}</Select.ItemText>
                  </div>
                  <Select.ItemIndicator>
                    <Check className="h-3.5 w-3.5" aria-hidden />
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.Popup>
          </Select.Positioner>
        </Select.Portal>
      </Select.Root>

      <span className="text-oai-gray-500 dark:text-oai-gray-400">
        {copy("skills.filter.result_count", { filtered: filteredCount, total: totalCount })}
      </span>

      {anyFilter ? (
        <button
          type="button"
          onClick={onClearFilters}
          className="ml-auto inline-flex h-7 items-center gap-1 rounded-full bg-oai-gray-100 px-2.5 text-[11px] font-medium text-oai-gray-700 transition hover:bg-oai-gray-200 focus:outline-none focus:ring-2 focus:ring-oai-gray-400/30 dark:bg-oai-gray-800/70 dark:text-oai-gray-200 dark:hover:bg-oai-gray-700"
        >
          <XIcon className="h-3 w-3" aria-hidden />
          {copy("skills.filter.clear")}
        </button>
      ) : null}
    </div>
  );
}

function MySkillsView({
  items,
  totalCount,
  targets,
  agentOptions,
  agentFilter,
  onAgentFilter,
  anyFilter,
  onClearFilters,
  selectedId,
  onSelect,
}) {
  return (
    <div>
      <FilterToolbar
        agentFilter={agentFilter}
        agentOptions={agentOptions}
        onAgentFilter={onAgentFilter}
        filteredCount={items.length}
        totalCount={totalCount}
        anyFilter={anyFilter}
        onClearFilters={onClearFilters}
      />
      {items.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-oai-gray-200 px-4 py-10 text-center text-sm text-oai-gray-500 dark:border-oai-gray-800 dark:text-oai-gray-400">
          <p>{copy("skills.empty.no_match")}</p>
          <Button type="button" variant="secondary" size="sm" onClick={onClearFilters}>
            {copy("skills.filter.clear")}
          </Button>
        </div>
      ) : (
        <div className="divide-y divide-oai-gray-200/70 dark:divide-oai-gray-800/70">
          {items.map((skill) => (
            <SkillRow
              key={skill.id || skill.key}
              skill={skill}
              targets={targets}
              selected={selectedId === (skill.id || skill.directory)}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const BROWSE_CARD_STYLE = {
  contentVisibility: "auto",
  containIntrinsicSize: "0 240px",
};

const BrowseCard = React.memo(function BrowseCard({ skill, installed, installing, allTargets, defaultTargets, onInstall }) {
  const [selectedTargets, setSelectedTargets] = useState(() =>
    (defaultTargets || []).filter((id) => allTargets.some((t) => t.id === id)),
  );

  const toggleTarget = (id) => {
    setSelectedTargets((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id],
    );
  };

  const sourceLabel = skill.repoOwner && skill.repoName ? `${skill.repoOwner}/${skill.repoName}` : null;
  const sourceHref = sourceLabel ? `https://github.com/${skill.repoOwner}/${skill.repoName}` : null;
  const installsLabel = skill.installs != null
    ? copy("skills.card.installs", { count: Number(skill.installs || 0).toLocaleString() })
    : null;
  const targetSummary = selectedTargets.length
    ? selectedTargets
        .map((id) => allTargets.find((t) => t.id === id)?.label || id)
        .join(", ")
    : copy("skills.action.choose_targets");

  return (
    <Card
      className="h-full rounded-lg"
      bodyClassName="flex h-full flex-col"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {skill.readmeUrl ? (
            <a
              href={skill.readmeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="group inline-flex max-w-full items-center gap-1 truncate text-base font-semibold text-oai-black hover:underline dark:text-white"
              title={skill.readmeUrl}
            >
              <span className="truncate">{skill.name || skill.directory}</span>
              <ExternalLink className="h-3.5 w-3.5 shrink-0 text-oai-gray-400 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
            </a>
          ) : (
            <h2 className="truncate text-base font-semibold text-oai-black dark:text-white">
              {skill.name || skill.directory}
            </h2>
          )}
          {(sourceLabel || installsLabel) ? (
            <div className="mt-1 flex flex-wrap items-center gap-x-1.5 truncate text-xs text-oai-gray-500 dark:text-oai-gray-400">
              {sourceHref ? (
                <a
                  href={sourceHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => event.stopPropagation()}
                  className="inline-flex items-center gap-1 truncate rounded text-oai-gray-500 hover:text-oai-black hover:underline focus:outline-none focus:ring-2 focus:ring-oai-gray-400/30 dark:text-oai-gray-400 dark:hover:text-white"
                  title={sourceHref}
                >
                  <span className="truncate">{sourceLabel}</span>
                  <ExternalLink className="h-2.5 w-2.5 shrink-0" aria-hidden />
                </a>
              ) : null}
              {sourceLabel && installsLabel ? <span aria-hidden>·</span> : null}
              {installsLabel ? <span className="truncate">{installsLabel}</span> : null}
            </div>
          ) : null}
        </div>
        {installed ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-oai-black/[0.06] px-2 py-1 text-xs font-medium text-oai-gray-700 ring-1 ring-oai-black/10 dark:bg-white/[0.08] dark:text-oai-gray-200 dark:ring-white/10">
            <Check className="h-3 w-3" aria-hidden />
            {copy("skills.card.installed")}
          </span>
        ) : null}
      </div>

      {skill.description ? (
        <p className="mt-3 line-clamp-3 text-sm leading-6 text-oai-gray-600 dark:text-oai-gray-300">
          {skill.description}
        </p>
      ) : null}

      <div className="mt-auto pt-5">
        {installed ? (
          <div className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-md bg-oai-black/[0.04] text-sm font-medium text-oai-gray-700 ring-1 ring-inset ring-oai-black/[0.08] dark:bg-white/[0.05] dark:text-oai-gray-200 dark:ring-white/[0.08]">
            <Check className="h-3.5 w-3.5" aria-hidden />
            {copy("skills.card.installed")}
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-oai-gray-600 dark:text-oai-gray-300">
              <span className="text-oai-gray-500 dark:text-oai-gray-400">
                {copy("skills.card.targets_prefix")}
              </span>
              <span className="min-w-0 truncate font-medium text-oai-black dark:text-white">
                {selectedTargets.length ? targetSummary : copy("skills.target.none")}
              </span>
              <Popover.Root>
                <Popover.Trigger
                  disabled={installing}
                  aria-label={copy("skills.action.choose_targets")}
                  className="rounded text-xs font-medium text-oai-gray-500 underline decoration-oai-gray-300 decoration-dotted underline-offset-2 transition hover:text-oai-black hover:decoration-oai-gray-500 focus:outline-none focus:ring-2 focus:ring-oai-gray-400/30 disabled:cursor-not-allowed disabled:opacity-60 dark:text-oai-gray-400 dark:decoration-oai-gray-600 dark:hover:text-white dark:hover:decoration-oai-gray-400"
                >
                  {copy("skills.card.targets_change")}
                </Popover.Trigger>
                <Popover.Portal>
                  <Popover.Positioner sideOffset={6} side="bottom" align="end" className="!z-[80]">
                    <Popover.Popup className="min-w-[220px] rounded-lg bg-white p-1.5 shadow-lg ring-1 ring-oai-gray-200 dark:bg-oai-gray-950 dark:ring-oai-gray-800">
                      <div className="px-2 pb-1 pt-0.5 text-[11px] font-medium uppercase tracking-wide text-oai-gray-500 dark:text-oai-gray-400">
                        {copy("skills.target.menu_label")}
                      </div>
                      {allTargets.map((target) => {
                        const checked = selectedTargets.includes(target.id);
                        return (
                          <label
                            key={target.id}
                            className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-oai-black hover:bg-oai-gray-100 dark:text-white dark:hover:bg-oai-gray-800"
                          >
                            <input
                              type="checkbox"
                              className="h-4 w-4 shrink-0 rounded border-oai-gray-300 text-oai-black focus:ring-oai-gray-400 dark:border-oai-gray-600 dark:bg-oai-gray-900 dark:text-white"
                              checked={checked}
                              onChange={() => toggleTarget(target.id)}
                            />
                            <ProviderIcon provider={target.id} size={16} />
                            <span className="flex-1 text-left">{target.label}</span>
                          </label>
                        );
                      })}
                    </Popover.Popup>
                  </Popover.Positioner>
                </Popover.Portal>
              </Popover.Root>
            </div>
            <Button
              type="button"
              size="sm"
              onClick={() => onInstall(skill, selectedTargets)}
              disabled={installing || selectedTargets.length === 0}
              className="w-full"
            >
              {installing ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              )}
              {copy("skills.action.install")}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
});

function RepoManager({ repos, repoInput, onRepoInput, busyKey, onAdd, onRemove }) {
  return (
    <div className="rounded-lg border border-oai-gray-200 bg-white p-4 dark:border-oai-gray-800 dark:bg-oai-gray-950">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          value={repoInput}
          onChange={(event) => onRepoInput(event.target.value)}
          placeholder={copy("skills.repo.placeholder")}
          className="min-w-0 flex-1"
        />
        <Button
          type="button"
          variant="secondary"
          size="md"
          onClick={onAdd}
          disabled={busyKey === "repo:add"}
          className="shrink-0 whitespace-nowrap"
        >
          {busyKey === "repo:add" ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Plus className="mr-1.5 h-4 w-4" aria-hidden />
          )}
          {copy("skills.repo.add")}
        </Button>
      </div>
      {repos.length ? (
        <div className="mt-3 divide-y divide-oai-gray-200/70 dark:divide-oai-gray-800/70">
          {repos.map((repo) => {
            const removing = busyKey === `repo:${repo.owner}/${repo.name}`;
            return (
              <div key={`${repo.owner}/${repo.name}`} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-oai-black dark:text-white">
                    {repo.owner}/{repo.name}
                  </div>
                  <div className="text-xs text-oai-gray-500 dark:text-oai-gray-400">{repo.branch}</div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={removing}
                  onClick={() => onRemove(repo)}
                  className="shrink-0"
                >
                  {removing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  )}
                  <span className="sr-only">{copy("skills.repo.remove")}</span>
                </Button>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function readTabFromUrl() {
  if (typeof window === "undefined") return "my";
  const params = new URLSearchParams(window.location.search);
  return params.get("tab") === "browse" ? "browse" : "my";
}

export function SkillsPage() {
  const [tab, setTab] = useState(readTabFromUrl);
  const [installedData, setInstalledData] = useState({ skills: [], targets: [] });
  const [discoverData, setDiscoverData] = useState([]);
  const [searchData, setSearchData] = useState([]);
  const [repos, setRepos] = useState([]);
  const [source, setSource] = useState(SOURCE_ALL);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [repoInput, setRepoInput] = useState("");
  const [manageOpen, setManageOpen] = useState(false);
  const [agentFilter, setAgentFilter] = useState("all");
  const [selectedSkillId, setSelectedSkillId] = useState(null);
  const [busyKey, setBusyKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [error, setError] = useState("");
  const [pendingRemove, setPendingRemove] = useState(null);
  const [toast, setToast] = useState(null); // { message, undo, key }

  const installedKeys = useMemo(() => {
    const keys = new Set();
    for (const skill of installedData.skills || []) {
      keys.add(getSkillKey(skill).toLowerCase());
      if (skill.repoOwner && skill.repoName) {
        keys.add(`${skill.repoOwner}/${skill.repoName}:${skill.sourceDirectory || skill.directory}`.toLowerCase());
      }
      // Directory-name fallback so unmanaged installs (no repoOwner recorded
      // — e.g. CLI-installed skills physically placed under ~/.claude/skills/)
      // still match browse entries from skills.sh or GitHub by skill folder name.
      const tail = String(skill.directory || "").split(/[\\/]/).pop().toLowerCase();
      if (tail) keys.add(`dir:${tail}`);
    }
    return keys;
  }, [installedData.skills]);

  const loadInstalled = useCallback(async () => {
    const data = await getInstalledSkills();
    setInstalledData({ skills: data.skills || [], targets: data.targets || [] });
  }, []);

  const loadRepos = useCallback(async () => {
    const data = await getSkillRepos();
    setRepos(data.repos || []);
  }, []);

  const loadDiscover = useCallback(async ({ force = false } = {}) => {
    setBrowseLoading(true);
    try {
      const data = await discoverSkills({ force });
      setDiscoverData(data.skills || []);
    } finally {
      setBrowseLoading(false);
    }
  }, []);

  const loadInitial = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      await Promise.all([loadInstalled(), loadRepos()]);
    } catch (err) {
      setError(err?.message || copy("skills.error.generic"));
    } finally {
      setLoading(false);
    }
  }, [loadInstalled, loadRepos]);

  const handleRefresh = useCallback(async () => {
    await loadInitial();
    if (tab === "browse" && source !== SOURCE_SKILLSSH) {
      loadDiscover({ force: true }).catch((err) =>
        setError(err?.message || copy("skills.error.generic")),
      );
    }
  }, [loadDiscover, loadInitial, source, tab]);

  useEffect(() => {
    loadInitial();
  }, [loadInitial]);

  useEffect(() => {
    if (tab !== "browse") return;
    if (source === SOURCE_SKILLSSH) return;
    if (discoverData.length === 0) {
      loadDiscover().catch((err) => setError(err?.message || copy("skills.error.generic")));
    }
  }, [discoverData.length, loadDiscover, source, tab]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast((current) => (current?.key === toast.key ? null : current)), toast.ttlMs || 5000);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 200);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const current = params.get("tab");
    if (tab === "my") {
      if (!current) return;
      params.delete("tab");
    } else {
      if (current === tab) return;
      params.set("tab", tab);
    }
    const search = params.toString();
    const next = `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`;
    window.history.replaceState({}, "", next);
  }, [tab]);

  const runMutation = async (key, task) => {
    setBusyKey(key);
    setError("");
    try {
      await task();
      await loadInstalled();
    } catch (err) {
      setError(err?.message || copy("skills.error.generic"));
    } finally {
      setBusyKey("");
    }
  };

  const handleInstall = (skill, targets) => {
    const finalTargets = (targets && targets.length ? targets : DEFAULT_TARGETS).filter(
      (id) => (installedData.targets || []).some((t) => t.id === id),
    );
    runMutation(installBusyKey(skill), async () => {
      await installSkill(skill, finalTargets);
      const labels = finalTargets
        .map((id) => (installedData.targets || []).find((t) => t.id === id)?.label || id)
        .join(", ");
      setToast({
        key: `${Date.now()}:install:${getSkillKey(skill)}`,
        message: copy("skills.toast.installed", {
          name: skill.name || skill.directory,
          targets: labels || copy("skills.target.none"),
        }),
        ttlMs: 4000,
      });
    });
  };

  const handleRemove = (skill) => {
    setPendingRemove(skill);
  };

  const confirmRemove = () => {
    const skill = pendingRemove;
    if (!skill) return;
    setPendingRemove(null);
    runMutation(removeBusyKey(skill), async () => {
      let result = null;
      if (skill.managed) {
        result = await uninstallSkill(skill.id);
      } else {
        await deleteLocalSkill(skill.directory, skill.targets || []);
      }
      const canUndo = Boolean(result?.trashed && skill.managed && skill.id);
      setToast({
        key: `${Date.now()}:${skill.id || skill.directory}`,
        message: copy("skills.toast.removed", { name: skill.name || skill.directory }),
        undo: canUndo
          ? async () => {
              try {
                await restoreSkill(skill.id);
                await loadInstalled();
                setToast(null);
              } catch (err) {
                setError(err?.message || copy("skills.error.generic"));
              }
            }
          : null,
        ttlMs: 5000,
      });
    });
  };

  const handleToggleTarget = (skill, targetId, enabled) =>
    runMutation(targetBusyKey(skill.id, targetId), async () => {
      const next = new Set(skill.targets || []);
      if (enabled) next.add(targetId);
      else next.delete(targetId);
      if (skill.managed) {
        await setSkillTargets(skill.id, Array.from(next));
      } else {
        // Unmanaged → promote to managed via importLocalSkill so toggling any
        // target updates registry + SSOT uniformly.
        await importLocalSkill(skill.directory, Array.from(next));
      }
    });

  const handleSearch = async () => {
    const trimmed = query.trim();
    if (trimmed.length < 2) return;
    setBusyKey("search");
    setError("");
    try {
      const data = await searchSkills(trimmed);
      setSearchData(data.skills || []);
    } catch (err) {
      setError(err?.message || copy("skills.error.generic"));
    } finally {
      setBusyKey("");
    }
  };

  const handleAddRepo = async () => {
    const raw = repoInput.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
    const [owner, name] = raw.split("/");
    if (!owner || !name) {
      setError(copy("skills.repo.invalid"));
      return;
    }
    await runMutation("repo:add", async () => {
      await addSkillRepo({ owner, name, branch: "main", enabled: true });
      setRepoInput("");
      await loadRepos();
      await loadDiscover();
    });
  };

  const handleRemoveRepo = async (repo) => {
    await runMutation(`repo:${repo.owner}/${repo.name}`, async () => {
      await removeSkillRepo(repo.owner, repo.name);
      await loadRepos();
      await loadDiscover();
    });
  };

  const targets = installedData.targets || [];
  const mySkills = installedData.skills || [];

  const filteredMySkills = useMemo(() => {
    if (agentFilter === "all") return mySkills;
    return mySkills.filter((skill) => (skill.targets || []).includes(agentFilter));
  }, [mySkills, agentFilter]);

  const myAnyFilter = agentFilter !== "all";

  const selectedSkill = useMemo(() => {
    if (!selectedSkillId) return null;
    return mySkills.find((s) => (s.id || s.directory) === selectedSkillId) || null;
  }, [mySkills, selectedSkillId]);

  const handleClearMyFilters = useCallback(() => {
    setAgentFilter("all");
  }, []);

  const handleSelectSkill = useCallback((skill) => {
    setSelectedSkillId((prev) => {
      const next = skill?.id || skill?.directory || null;
      return prev === next ? null : next;
    });
  }, []);

  const handleCloseDetail = useCallback(() => setSelectedSkillId(null), []);

  // Close detail panel when leaving My tab or when skill no longer present.
  useEffect(() => {
    if (tab !== "my" && selectedSkillId) setSelectedSkillId(null);
  }, [tab, selectedSkillId]);
  useEffect(() => {
    if (selectedSkillId && !selectedSkill) setSelectedSkillId(null);
  }, [selectedSkill, selectedSkillId]);

  const browseItems = useMemo(() => {
    const pool = source === SOURCE_SKILLSSH ? searchData : discoverData;
    const filtered = source === SOURCE_SKILLSSH || source === SOURCE_ALL
      ? pool
      : pool.filter((skill) => `${skill.repoOwner}/${skill.repoName}` === source);
    const q = debouncedQuery.trim().toLowerCase();
    const matched = source === SOURCE_SKILLSSH || !q
      ? filtered
      : filtered.filter((skill) =>
          (skill.name || "").toLowerCase().includes(q) ||
          (skill.directory || "").toLowerCase().includes(q) ||
          (skill.description || "").toLowerCase().includes(q));
    return matched.map((skill) => {
      const fullKey = getSkillKey(skill).toLowerCase();
      const tail = String(skill.directory || "").split(/[\\/]/).pop().toLowerCase();
      const dirKey = tail ? `dir:${tail}` : "";
      return {
        ...skill,
        installed: installedKeys.has(fullKey) || (dirKey && installedKeys.has(dirKey)),
      };
    });
  }, [debouncedQuery, discoverData, installedKeys, searchData, source]);

  const loadingNode = (
    <div className="flex h-64 items-center justify-center">
      <Loader2 className="h-8 w-8 animate-spin text-oai-gray-400" aria-hidden />
    </div>
  );
  const browseLoadingNode = (
    <div className="flex h-64 flex-col items-center justify-center gap-3 px-6 text-center">
      <Loader2 className="h-8 w-8 animate-spin text-oai-gray-400" aria-hidden />
      <p className="max-w-md text-xs text-oai-gray-500 dark:text-oai-gray-400">
        {copy("skills.browse.loading_hint")}
      </p>
    </div>
  );
  const emptyNode = (key, action = null) => (
    <div className="flex flex-col items-center gap-4 rounded-lg border border-dashed border-oai-gray-200 px-4 py-10 text-center text-sm text-oai-gray-500 dark:border-oai-gray-800 dark:text-oai-gray-400">
      <p>{copy(key)}</p>
      {action}
    </div>
  );

  let contentNode;
  if (loading) {
    contentNode = loadingNode;
  } else if (tab === "my") {
    contentNode = mySkills.length ? (
      <MySkillsView
        items={filteredMySkills}
        totalCount={mySkills.length}
        targets={targets}
        agentOptions={targets}
        agentFilter={agentFilter}
        onAgentFilter={setAgentFilter}
        anyFilter={myAnyFilter}
        onClearFilters={handleClearMyFilters}
        selectedId={selectedSkillId}
        onSelect={handleSelectSkill}
      />
    ) : (
      <div className="flex flex-col items-center gap-4 rounded-lg border border-dashed border-oai-gray-200 px-4 py-10 text-center dark:border-oai-gray-800">
        {targets.length > 0 ? (
          <div className="relative h-11 w-80 overflow-hidden" aria-hidden>
            {/* Blurred icons — masked to mid-edge transition zones (skips center) */}
            <div
              className="pointer-events-none absolute inset-0"
              style={{
                maskImage:
                  "linear-gradient(to right, transparent 8%, black 20%, black 32%, transparent 44%, transparent 56%, black 68%, black 80%, transparent 92%)",
                WebkitMaskImage:
                  "linear-gradient(to right, transparent 8%, black 20%, black 32%, transparent 44%, transparent 56%, black 68%, black 80%, transparent 92%)",
              }}
            >
              <div
                className="absolute inset-y-0 left-0 flex w-max items-center animate-marquee-x"
                style={{ filter: "blur(2.5px)" }}
              >
                {[...targets, ...targets].map((target, i) => (
                  <span key={`b-${i}`} className="shrink-0 px-3">
                    <ProviderIcon provider={target.id} size={30} />
                  </span>
                ))}
              </div>
            </div>
            {/* Clear icons — masked to center */}
            <div
              className="pointer-events-none absolute inset-0"
              style={{
                maskImage:
                  "linear-gradient(to right, transparent 28%, black 42%, black 58%, transparent 72%)",
                WebkitMaskImage:
                  "linear-gradient(to right, transparent 28%, black 42%, black 58%, transparent 72%)",
              }}
            >
              <div className="absolute inset-y-0 left-0 flex w-max items-center animate-marquee-x">
                {[...targets, ...targets].map((target, i) => (
                  <span key={`c-${i}`} className="shrink-0 px-3">
                    <ProviderIcon provider={target.id} size={30} />
                  </span>
                ))}
              </div>
            </div>
            {/* Background color fade — left edge */}
            <div
              className="pointer-events-none absolute inset-y-0 left-0 w-20 bg-gradient-to-r from-oai-white to-transparent dark:from-oai-gray-900"
            />
            {/* Background color fade — right edge */}
            <div
              className="pointer-events-none absolute inset-y-0 right-0 w-20 bg-gradient-to-l from-oai-white to-transparent dark:from-oai-gray-900"
            />
          </div>
        ) : null}
        <p className="text-sm text-oai-gray-500 dark:text-oai-gray-400">
          {copy("skills.empty.my")}
        </p>
        <Button type="button" size="sm" onClick={() => setTab("browse")}>
          {copy("skills.empty.my_cta")}
        </Button>
      </div>
    );
  } else {
    // Browse
    const isSkillsSh = source === SOURCE_SKILLSSH;
    const noSources = repos.length === 0 && !isSkillsSh;
    const browseAnyFilter = !isSkillsSh && (debouncedQuery.trim() !== "" || source !== SOURCE_ALL);
    const handleClearBrowseFilters = () => {
      setQuery("");
      setSource(SOURCE_ALL);
    };

    const countNode =
      !noSources && !browseLoading && (browseItems.length > 0 || browseAnyFilter) ? (
        <div className="mb-2 flex flex-wrap items-center gap-2 px-1 text-xs text-oai-gray-500 dark:text-oai-gray-400">
          <span>
            {copy("skills.filter.result_count_browse", { count: browseItems.length })}
          </span>
          {browseAnyFilter ? (
            <button
              type="button"
              onClick={handleClearBrowseFilters}
              className="ml-auto inline-flex h-7 items-center gap-1 rounded-full bg-oai-gray-100 px-2.5 text-[11px] font-medium text-oai-gray-700 transition hover:bg-oai-gray-200 focus:outline-none focus:ring-2 focus:ring-oai-gray-400/30 dark:bg-oai-gray-800/70 dark:text-oai-gray-200 dark:hover:bg-oai-gray-700"
            >
              <XIcon className="h-3 w-3" aria-hidden />
              {copy("skills.filter.clear")}
            </button>
          ) : null}
        </div>
      ) : null;

    let resultNode;
    if (noSources) {
      resultNode = (
        <div className="rounded-lg border border-dashed border-oai-gray-200 p-6 text-center dark:border-oai-gray-800">
          <p className="text-sm text-oai-gray-600 dark:text-oai-gray-300">
            {copy("skills.browse.empty_sources")}
          </p>
        </div>
      );
    } else if (browseLoading && !isSkillsSh) {
      resultNode = browseLoadingNode;
    } else if (isSkillsSh && query.trim().length < 2) {
      resultNode = (
        <div className="rounded-lg border border-dashed border-oai-gray-200 px-4 py-6 text-center text-sm text-oai-gray-500 dark:border-oai-gray-800 dark:text-oai-gray-400">
          {copy("skills.browse.hint_skillssh")}
        </div>
      );
    } else if (browseItems.length) {
      resultNode = (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {browseItems.map((skill) => (
            <div key={skill.id || skill.key} style={BROWSE_CARD_STYLE}>
              <BrowseCard
                skill={skill}
                installed={Boolean(skill.installed)}
                installing={busyKey === installBusyKey(skill)}
                allTargets={targets}
                defaultTargets={DEFAULT_TARGETS}
                onInstall={handleInstall}
              />
            </div>
          ))}
        </div>
      );
    } else if (browseAnyFilter) {
      resultNode = emptyNode(
        "skills.empty.no_match",
        <Button type="button" variant="secondary" size="sm" onClick={handleClearBrowseFilters}>
          {copy("skills.filter.clear")}
        </Button>,
      );
    } else if (isSkillsSh) {
      resultNode = emptyNode("skills.empty.search");
    } else {
      resultNode = emptyNode("skills.empty.browse");
    }

    const manageNode = noSources || manageOpen ? (
      <div className="mb-5">
        <RepoManager
          repos={repos}
          repoInput={repoInput}
          onRepoInput={setRepoInput}
          busyKey={busyKey}
          onAdd={handleAddRepo}
          onRemove={handleRemoveRepo}
        />
      </div>
    ) : null;

    const hintNode =
      !manageOpen && !isSkillsSh && repos.length <= 1 && browseItems.length > 0 ? (
        <DismissibleHint id="skills-browse-intro" className="mt-6">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>{copy("skills.browse.add_repo_hint")}</span>
            <button
              type="button"
              onClick={() => setManageOpen(true)}
              className="rounded font-medium text-oai-gray-700 underline decoration-dotted underline-offset-2 transition hover:text-oai-black focus:outline-none focus:ring-2 focus:ring-oai-gray-400/30 dark:text-oai-gray-200 dark:hover:text-white"
            >
              {copy("skills.browse.manage_sources")}
            </button>
          </div>
        </DismissibleHint>
      ) : null;

    contentNode = (
      <>
        {manageNode}
        {countNode}
        {resultNode}
        {hintNode}
      </>
    );
  }

  return (
    <div className="flex flex-1 flex-col font-oai text-oai-black antialiased dark:text-oai-white">
      <main className="flex-1 pb-12 pt-8 sm:pb-16 sm:pt-10">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="mb-6 flex items-end justify-between gap-4">
            <h1 className="text-3xl font-semibold tracking-tight text-oai-black dark:text-white sm:text-4xl">
              {copy("skills.page.title")}
            </h1>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={handleRefresh}
              disabled={loading || browseLoading}
            >
              <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", (loading || browseLoading) && "animate-spin")} aria-hidden />
              {copy("skills.action.refresh")}
            </Button>
          </div>

          <div className="mb-5 flex gap-6 border-b border-oai-gray-200 dark:border-oai-gray-800">
            {[
              ["my", copy("skills.tab.my")],
              ["browse", copy("skills.tab.browse")],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={tab === value}
                onClick={() => setTab(value)}
                className={cn(
                  "-mb-px border-b-2 pb-2 text-sm font-medium transition-colors",
                  tab === value
                    ? "border-oai-black text-oai-black dark:border-white dark:text-white"
                    : "border-transparent text-oai-gray-500 hover:text-oai-black dark:text-oai-gray-400 dark:hover:text-white",
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {error ? (
            <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">
              {error}
            </div>
          ) : null}

          {tab === "browse" ? (
            <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center">
              <div
                role="tablist"
                aria-label={copy("skills.source.label")}
                className="inline-flex h-10 shrink-0 items-center rounded-md border border-oai-gray-200 bg-oai-white p-1 dark:border-oai-gray-800 dark:bg-oai-gray-900"
              >
                {[
                  ["repo", copy("skills.mode.repo")],
                  ["skillssh", copy("skills.mode.skillssh")],
                ].map(([value, label]) => {
                  const active = (value === "skillssh") === (source === SOURCE_SKILLSSH);
                  return (
                    <button
                      key={value}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => {
                        if (value === "skillssh") setSource(SOURCE_SKILLSSH);
                        else if (source === SOURCE_SKILLSSH) setSource(SOURCE_ALL);
                      }}
                      className={cn(
                        "rounded px-3 py-1 text-sm font-medium transition-colors",
                        active
                          ? "bg-oai-gray-100 text-oai-black dark:bg-oai-gray-700 dark:text-white"
                          : "text-oai-gray-500 hover:text-oai-gray-800 dark:text-oai-gray-400 dark:hover:text-oai-gray-200",
                      )}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              {source !== SOURCE_SKILLSSH ? (
                <Select.Root value={source} onValueChange={setSource}>
                  <Select.Trigger
                    aria-label={copy("skills.source.label")}
                    className="inline-flex h-10 w-44 shrink-0 items-center justify-between gap-2 rounded-md border border-oai-gray-200 bg-oai-white px-3 text-sm text-oai-black focus:outline-none data-[popup-open]:border-oai-gray-300 dark:border-oai-gray-800 dark:bg-oai-gray-900 dark:text-white dark:data-[popup-open]:border-oai-gray-700"
                  >
                    <Select.Value>
                      {(value) => (value === SOURCE_ALL ? copy("skills.source.all") : value)}
                    </Select.Value>
                    <Select.Icon className="text-oai-gray-400">
                      <ChevronDown className="h-4 w-4" aria-hidden />
                    </Select.Icon>
                  </Select.Trigger>
                  <Select.Portal>
                    <Select.Positioner sideOffset={4} alignItemWithTrigger={false} className="z-[60]">
                      <Select.Popup className="min-w-[var(--anchor-width)] overflow-hidden rounded-md border border-oai-gray-200 bg-white p-1 shadow-[0_12px_32px_-12px_rgba(0,0,0,0.18)] outline-none transition-[opacity,transform] duration-150 ease-out data-[ending-style]:scale-[0.97] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0 dark:border-oai-gray-800 dark:bg-oai-gray-950 dark:shadow-[0_12px_32px_-12px_rgba(0,0,0,0.6)]">
                        <Select.Item
                          value={SOURCE_ALL}
                          className="flex cursor-default select-none items-center justify-between gap-2 rounded px-3 py-1.5 text-sm text-oai-black outline-none data-[highlighted]:bg-oai-gray-100 dark:text-white dark:data-[highlighted]:bg-oai-gray-800"
                        >
                          <Select.ItemText>{copy("skills.source.all")}</Select.ItemText>
                          <Select.ItemIndicator>
                            <Check className="h-3.5 w-3.5" aria-hidden />
                          </Select.ItemIndicator>
                        </Select.Item>
                        {repos.map((repo) => {
                          const value = `${repo.owner}/${repo.name}`;
                          return (
                            <Select.Item
                              key={value}
                              value={value}
                              className="flex cursor-default select-none items-center justify-between gap-2 rounded px-3 py-1.5 text-sm text-oai-black outline-none data-[highlighted]:bg-oai-gray-100 dark:text-white dark:data-[highlighted]:bg-oai-gray-800"
                            >
                              <Select.ItemText>{value}</Select.ItemText>
                              <Select.ItemIndicator>
                                <Check className="h-3.5 w-3.5" aria-hidden />
                              </Select.ItemIndicator>
                            </Select.Item>
                          );
                        })}
                      </Select.Popup>
                    </Select.Positioner>
                  </Select.Portal>
                </Select.Root>
              ) : null}
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-oai-gray-400" aria-hidden />
                <Input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && source === SOURCE_SKILLSSH) handleSearch();
                  }}
                  aria-label={copy("skills.action.search_aria")}
                  placeholder={
                    source === SOURCE_SKILLSSH
                      ? copy("skills.browse.placeholder_skillssh")
                      : source === SOURCE_ALL
                        ? copy("skills.browse.placeholder_all")
                        : copy("skills.browse.placeholder_repo", { repo: source })
                  }
                  className="pl-9 !border-oai-gray-200 dark:!border-oai-gray-800 focus:!border-oai-gray-400 focus:!ring-oai-gray-400/20 dark:focus:!border-oai-gray-500 dark:focus:!ring-oai-gray-500/20"
                />
              </div>
              {source === SOURCE_SKILLSSH ? (
                <Button
                  type="button"
                  onClick={handleSearch}
                  disabled={query.trim().length < 2 || busyKey === "search"}
                  className="focus:!ring-oai-gray-400/30"
                >
                  {busyKey === "search" ? (
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <Search className="mr-1.5 h-4 w-4" aria-hidden />
                  )}
                  {copy("skills.action.search")}
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setManageOpen((prev) => !prev)}
                  aria-expanded={manageOpen}
                  className="!h-10 shrink-0 whitespace-nowrap !border-oai-gray-200 dark:!border-oai-gray-800 hover:!border-oai-gray-300 dark:hover:!border-oai-gray-700 hover:!text-oai-black dark:hover:!text-white focus:!ring-oai-gray-400/30"
                >
                  <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                  {copy("skills.browse.manage_sources")}
                  <span className="ml-1.5 rounded bg-oai-gray-100 px-1.5 py-0.5 text-xs font-medium text-oai-gray-600 dark:bg-oai-gray-800 dark:text-oai-gray-300">
                    {repos.length}
                  </span>
                </Button>
              )}
            </div>
          ) : null}

          {contentNode}
          <SkillDetailPanel
            skill={selectedSkill}
            targets={targets}
            busyKey={busyKey}
            onClose={handleCloseDetail}
            onToggleTarget={handleToggleTarget}
            onRemove={handleRemove}
          />
        </div>
      </main>

      <ConfirmModal
        open={Boolean(pendingRemove)}
        title={copy("skills.confirm.remove_title", {
          name: pendingRemove?.name || pendingRemove?.directory || "",
        })}
        description={
          pendingRemove
            ? pendingRemove.managed
              ? copy("skills.confirm.remove_managed")
              : copy("skills.confirm.remove_local")
            : ""
        }
        confirmLabel={copy("skills.action.remove")}
        cancelLabel={copy("shared.action.cancel")}
        destructive
        busy={busyKey === removeBusyKey(pendingRemove || {})}
        onCancel={() => setPendingRemove(null)}
        onConfirm={confirmRemove}
      />

      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="pointer-events-none fixed inset-x-0 bottom-6 z-[90] flex justify-center px-4"
      >
        {toast ? (
          <div className="pointer-events-auto flex max-w-md items-center gap-3 rounded-full bg-oai-black px-4 py-2 text-sm text-white shadow-lg dark:bg-white dark:text-oai-black">
            <span>{toast.message}</span>
            {toast.undo ? (
              <button
                type="button"
                onClick={toast.undo}
                className="rounded-full px-2 py-0.5 text-xs font-semibold uppercase tracking-wide hover:bg-white/10 dark:hover:bg-oai-black/10"
              >
                {copy("shared.action.undo")}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
