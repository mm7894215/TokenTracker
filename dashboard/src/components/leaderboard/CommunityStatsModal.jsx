import { Dialog } from "@base-ui/react/dialog";
import { motion } from "motion/react";
import { useMemo, useState } from "react";
import { Terminal, TrendingDown, TrendingUp, X } from "lucide-react";
import { AppleIcon, WindowsIcon } from "../../ui/marketing/v3/icons.jsx";
import { copy } from "../../lib/copy";
import { useTokenFormat } from "../../hooks/useTokenFormat.js";
import { formatCompactNumber } from "../../lib/format";
import { ProviderIcon } from "../../ui/dashboard/components/ProviderIcon";
import { TrendMonitor } from "../../ui/dashboard/components/TrendMonitor";
import {
  TOKEN_FORMAT_MODES,
  TokenFormatModeOverride,
} from "../../ui/foundation/TokenFormatProvider.jsx";

const TOP_ROWS_LIMIT = 10;

const TOKEN_MIX_COLORS = {
  input: "var(--community-token-input)",
  cache_read: "var(--community-token-cache-read)",
  cache_write: "var(--community-token-cache-write)",
  output: "var(--community-token-output)",
  reasoning: "var(--community-token-reasoning)",
};

// Provider mark → bar fill color. Mirrors the --community-* design-system
// palette (styles.css) so distribution bars carry each provider's brand color,
// matching PROVIDER_COLORS in UsageOverview.
const PROVIDER_BAR_COLORS = {
  CLAUDE: "var(--community-claude)",
  CODEX: "var(--community-codex)",
  GEMINI: "var(--community-gemini)",
  CURSOR: "var(--community-cursor)",
  OPENCODE: "var(--community-opencode)",
  HERMES: "var(--community-hermes)",
  KIMI: "var(--community-kimi)",
  MIMO: "var(--community-mimo)",
  COPILOT: "var(--community-copilot)",
  KIRO: "var(--community-kiro)",
  GROK: "var(--community-grok)",
  DEEPSEEK: "var(--community-deepseek)",
  ZCODE: "var(--community-zcode)",
  WORKBUDDY: "var(--community-workbuddy)",
  MINIMAX: "var(--community-minimax)",
  DROID: "var(--community-droid)",
};

function providerBarColor(provider) {
  return PROVIDER_BAR_COLORS[String(provider || "").toUpperCase()] || "var(--community-muted)";
}

// Model name → provider mark. Icons render through ProviderIcon, which
// prefers the official multi-color logo and falls back to a mono glyph in
// the text color — never a synthetic tint.
const MODEL_PROVIDERS = [
  [/claude|fable|opus|sonnet|haiku/, "CLAUDE"],
  [/gpt|codex|o3|o4/, "CODEX"],
  [/gemini/, "GEMINI"],
  [/composer|cursor/, "CURSOR"],
  [/kimi/, "KIMI"],
  [/mimo/, "MIMO"],
  [/copilot/, "COPILOT"],
  [/kiro/, "KIRO"],
  [/grok/, "GROK"],
  [/deepseek/, "DEEPSEEK"],
  [/glm/, "ZCODE"],
  [/hy3/, "WORKBUDDY"],
  [/minimax/, "MINIMAX"],
];

const TABS = ["overview", "providers", "community", "models"];

function modelProvider(name) {
  const normalized = String(name || "").toLowerCase();
  const hit = MODEL_PROVIDERS.find(([pattern]) => pattern.test(normalized));
  return hit ? hit[1] : "";
}

function percent(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${parsed.toFixed(1)}%` : "—";
}

function compactCount(value) {
  return formatCompactNumber(Number(value) || 0);
}

function dayLabel(value) {
  if (!value) return "";
  return new Date(`${value}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function EmptyState() {
  return (
    <div className="flex h-full min-h-40 items-center justify-center text-xs text-oai-gray-400">
      {copy("leaderboard.community.modal.no_data")}
    </div>
  );
}

function SectionLabel({ children, detail }) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-4">
      <h3 className="text-xs font-medium uppercase tracking-wide text-oai-gray-500 dark:text-oai-gray-400">
        {children}
      </h3>
      {detail ? <span className="text-xs text-oai-gray-400">{detail}</span> : null}
    </div>
  );
}

function Delta({ value, label }) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const positive = Math.sign(parsed) !== -1;
  const Icon = positive ? TrendingUp : TrendingDown;
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs font-medium tabular-nums ${
        positive
          ? "text-emerald-600 dark:text-emerald-400"
          : "text-rose-600 dark:text-rose-400"
      }`}
      title={label}
    >
      <Icon className="size-3" aria-hidden="true" />
      {positive ? "+" : ""}{parsed.toFixed(1)}%
    </span>
  );
}

function Metric({ label, value, title, delta, deltaLabel }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-xs font-medium text-oai-gray-500 dark:text-oai-gray-400">
        {label}
      </div>
      <div className="mt-1 flex min-w-0 items-baseline gap-2">
        <span className="truncate text-xl font-semibold leading-none tracking-tight text-oai-black tabular-nums dark:text-white" title={title}>
          {value}
        </span>
        <Delta value={delta} label={deltaLabel} />
      </div>
    </div>
  );
}

// Every list in this modal shares one row grammar: the row itself is the
// progress bar (a translucent fill scaled to `fillWidth`, tinted with the
// row's brand `color`), with identity on the left and numbers on the right.
// Fills are square-cornered by design — no rounding on tracks or fills.
function FillRow({ fillWidth, share, color = "var(--oai-blue)", ariaLabel, dataAttrs, children }) {
  return (
    <div
      {...dataAttrs}
      className="group relative grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 overflow-hidden px-2.5 transition-colors hover:bg-oai-gray-50 dark:hover:bg-oai-gray-900/60"
    >
      <div
        className="pointer-events-none absolute inset-y-0 left-0 opacity-[0.15] transition-opacity group-hover:opacity-[0.22] dark:opacity-[0.24] dark:group-hover:opacity-[0.32]"
        style={{ width: `${fillWidth}%`, backgroundColor: color }}
        role="progressbar"
        aria-label={ariaLabel}
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={Number(share) || 0}
      />
      {children}
    </div>
  );
}

function RankedRow({ rank, provider, name, fillWidth, share, tokens, tokensTitle, dataAttrs }) {
  return (
    <FillRow
      fillWidth={fillWidth}
      share={share}
      color={providerBarColor(provider)}
      ariaLabel={`${name} ${percent(share)}`}
      dataAttrs={dataAttrs}
    >
      <div className="relative flex min-w-0 items-center gap-2.5">
        <span className={`w-5 shrink-0 text-xs tabular-nums ${rank <= 3 ? "font-semibold text-oai-gray-700 dark:text-oai-gray-200" : "text-oai-gray-400"}`}>
          {rank}
        </span>
        <span className="grid size-6 shrink-0 place-items-center text-oai-gray-700 dark:text-oai-gray-200">
          <ProviderIcon provider={provider} size={15} />
        </span>
        <span className="truncate text-xs font-medium text-oai-gray-700 dark:text-oai-gray-200" title={name}>
          {name}
        </span>
      </div>
      <div className="relative min-w-[4.5rem] text-right">
        <div className="text-xs font-semibold text-oai-black tabular-nums dark:text-white" title={tokensTitle}>
          {tokens}
        </div>
        <div className="text-xs text-oai-gray-500 tabular-nums dark:text-oai-gray-400">{percent(share)}</div>
      </div>
    </FillRow>
  );
}

function TokenMix({ rows, formatTokensTooltip }) {
  if (!rows.length) return null;
  return (
    <div className="mt-7">
      <SectionLabel>{copy("leaderboard.community.modal.token_mix")}</SectionLabel>
      <div className="flex h-1.5 overflow-hidden bg-oai-gray-100 dark:bg-oai-gray-800">
        {rows.map((row) => (
          <div
            key={row.key}
            style={{ width: `${Math.max(Number(row.share) || 0, 0)}%`, backgroundColor: TOKEN_MIX_COLORS[row.key] || "var(--community-muted)" }}
            title={`${copy(`leaderboard.community.modal.token_mix.${row.key}`)} · ${percent(row.share)}`}
          />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5">
        {rows.map((row) => (
          <span
            key={row.key}
            className="inline-flex items-center gap-1.5 text-xs text-oai-gray-500 dark:text-oai-gray-400"
            title={formatTokensTooltip(row.tokens)}
          >
            <span className="size-2" style={{ backgroundColor: TOKEN_MIX_COLORS[row.key] || "var(--community-muted)" }} />
            {copy(`leaderboard.community.modal.token_mix.${row.key}`)}
            <span className="tabular-nums text-oai-gray-700 dark:text-oai-gray-200">{percent(row.share)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function BandStat({ label, value, title, delta, deltaLabel, className = "" }) {
  return (
    <div className={`min-w-0 ${className}`}>
      <div className="truncate text-xs text-oai-gray-500 dark:text-oai-gray-400">{label}</div>
      <div className="mt-1 flex min-w-0 items-baseline gap-2">
        <span className="truncate text-base font-semibold leading-none tracking-tight tabular-nums text-oai-black dark:text-white" title={title}>
          {value}
        </span>
        <Delta value={delta} label={deltaLabel} />
      </div>
    </div>
  );
}

// A quiet hairline band under the chart: the three facts the daily series
// distills to (steady-state volume, the busiest day, and 30d reach).
function ActivityDigest({ trendRows, activeDevelopers30d, developerGrowthPct, formatTokens, formatTokensTooltip }) {
  if (!trendRows.length) return null;
  const total = trendRows.reduce((sum, row) => sum + row.value, 0);
  const peak = trendRows.reduce((max, row) => (max.value < row.value ? row : max), trendRows[0]);
  const average = total / trendRows.length;
  return (
    <div className="mt-5 grid grid-cols-3 divide-x divide-oai-gray-100 border-y border-oai-gray-100 py-3.5 dark:divide-oai-gray-800/80 dark:border-oai-gray-800/80">
      <BandStat
        className="pr-4"
        label={copy("leaderboard.community.modal.daily_average")}
        value={formatTokens(average)}
        title={formatTokensTooltip(average)}
      />
      <BandStat
        className="px-4"
        label={`${copy("leaderboard.community.modal.peak_day")} · ${peak.day}`}
        value={formatTokens(peak.value)}
        title={formatTokensTooltip(peak.value)}
      />
      <BandStat
        className="pl-4"
        label={copy("leaderboard.community.modal.active_30d")}
        value={compactCount(activeDevelopers30d)}
        title={Number(activeDevelopers30d).toLocaleString()}
        delta={developerGrowthPct}
        deltaLabel={copy("leaderboard.community.modal.vs_previous_week")}
      />
    </div>
  );
}

function OverviewView({ trendRows, mix, activeDevelopers30d, developerGrowthPct, formatTokens, formatTokensTooltip }) {
  if (!trendRows.length && !mix.length) return <EmptyState />;
  return (
    <div>
      <SectionLabel detail={copy("leaderboard.community.modal.utc_note")}>
        {copy("leaderboard.community.modal.community_activity")}
      </SectionLabel>
      <TrendMonitor
        embedded
        rows={trendRows}
        from={trendRows[0]?.day}
        to={trendRows.at(-1)?.day}
        chartHeightClass="h-44"
      />
      <ActivityDigest
        trendRows={trendRows}
        activeDevelopers30d={activeDevelopers30d}
        developerGrowthPct={developerGrowthPct}
        formatTokens={formatTokens}
        formatTokensTooltip={formatTokensTooltip}
      />
      <TokenMix rows={mix} formatTokensTooltip={formatTokensTooltip} />
    </div>
  );
}

function ProvidersView({ rows, maxShare, formatTokens, formatTokensTooltip }) {
  if (!rows.length) return <EmptyState />;
  return (
    <div className="space-y-0.5">
      {rows.map((provider, index) => (
        <RankedRow
          key={provider.name}
          rank={index + 1}
          dataAttrs={{ "data-provider-rank": index + 1, "data-provider-name": provider.name }}
          provider={String(provider.name).toUpperCase()}
          name={provider.name}
          fillWidth={Math.max(((Number(provider.share) || 0) / maxShare) * 100, 2)}
          share={provider.share}
          tokens={formatTokens(provider.tokens)}
          tokensTitle={formatTokensTooltip(provider.tokens)}
        />
      ))}
    </div>
  );
}

function ModelsView({ rows, maxShare, formatTokens, formatTokensTooltip }) {
  if (!rows.length) return <EmptyState />;
  return (
    <div className="space-y-0.5">
      {rows.map((model, index) => {
        const share = Number(model.share) || 0;
        return (
          <RankedRow
            key={model.name}
            rank={index + 1}
            dataAttrs={{ "data-model-rank": index + 1, "data-model-name": model.name }}
            provider={modelProvider(model.name)}
            name={model.name}
            fillWidth={Math.max((share / maxShare) * 100, 2)}
            share={share}
            tokens={formatTokens(model.tokens)}
            tokensTitle={formatTokensTooltip(model.tokens)}
          />
        );
      })}
    </div>
  );
}

// Platform marks reuse the app's existing logo set (marketing download
// buttons) so macOS/Windows read with the same glyphs everywhere.
function PlatformIcon({ name }) {
  const normalized = String(name || "").toLowerCase();
  if (normalized === "darwin") return <AppleIcon className="size-3.5" />;
  if (normalized === "win32") return <WindowsIcon className="size-3.5" />;
  return <Terminal className="size-4" aria-hidden="true" />;
}

// Ordinal ramp for the usage histogram: heavier lifetime bands render in a
// deeper brand tone, so the column chart encodes "heavier users" twice
// (height and intensity) without needing a legend.
const BAND_OPACITY_STEP = 0.175;
const BAND_OPACITY_FLOOR = 0.3;

function UsageBandHistogram({ bands, formatTokensTooltip }) {
  const maxShare = bands.reduce((max, band) => Math.max(max, Number(band.developer_share) || 0), 0) || 1;
  const bandTitle = (band) => `${copy(`leaderboard.community.modal.band.${band.key}`)} · ${copy("leaderboard.community.modal.developer_count", { count: compactCount(band.developers) })} (${formatTokensTooltip(band.tokens)})`;
  return (
    <div>
      <div className="flex gap-2 border-b border-oai-gray-200 dark:border-oai-gray-800">
        {bands.map((band, index) => {
          const share = Number(band.developer_share) || 0;
          // Cap the tallest column at 80% of the track so the value label
          // riding on the column top always stays inside the chart area.
          const height = Math.max((share / maxShare) * 80, 2);
          return (
            <div key={band.key} className="relative h-32 min-w-0 flex-1" title={bandTitle(band)}>
              <div
                role="progressbar"
                aria-label={copy("leaderboard.community.modal.developer_share_title", { share: percent(share) })}
                aria-valuemin="0"
                aria-valuemax="100"
                aria-valuenow={share}
                className="absolute inset-x-0 bottom-0"
                style={{
                  height: `${height}%`,
                  backgroundColor: "var(--oai-blue)",
                  opacity: BAND_OPACITY_FLOOR + index * BAND_OPACITY_STEP,
                }}
              />
              <div
                className="absolute inset-x-0 text-center text-xs font-medium tabular-nums text-oai-gray-700 dark:text-oai-gray-200"
                style={{ bottom: `calc(${height}% + 4px)` }}
              >
                {percent(share)}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex gap-2">
        {bands.map((band) => (
          <div key={band.key} className="min-w-0 flex-1 text-center" title={bandTitle(band)}>
            <div className="truncate text-xs font-medium text-oai-gray-700 dark:text-oai-gray-200">
              {copy(`leaderboard.community.modal.band.${band.key}`)}
            </div>
            <div className="truncate text-xs tabular-nums text-oai-gray-500 dark:text-oai-gray-400">
              {compactCount(band.developers)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CommunityView({ bands, platforms, formatTokensTooltip }) {
  if (!bands.length && !platforms.length) return <EmptyState />;
  return (
    <div className="space-y-8">
      {bands.length ? (
        <div>
          <SectionLabel>{copy("leaderboard.community.modal.usage_distribution")}</SectionLabel>
          <UsageBandHistogram bands={bands} formatTokensTooltip={formatTokensTooltip} />
        </div>
      ) : null}
      {platforms.length ? (
        <div>
          <SectionLabel>{copy("leaderboard.community.modal.platforms")}</SectionLabel>
          <div className="space-y-0.5">
            {platforms.map((platform) => (
              <FillRow
                key={platform.name}
                fillWidth={Math.max(Number(platform.share) || 0, 1)}
                share={platform.share}
                ariaLabel={`${copy(`leaderboard.community.modal.platform.${platform.name}`)} ${percent(platform.share)}`}
              >
                <div className="relative flex min-w-0 items-center gap-2.5">
                  <span className="grid size-6 shrink-0 place-items-center text-oai-gray-700 dark:text-oai-gray-200">
                    <PlatformIcon name={platform.name} />
                  </span>
                  <span className="truncate text-xs font-medium text-oai-gray-700 dark:text-oai-gray-200">
                    {copy(`leaderboard.community.modal.platform.${platform.name}`)}
                  </span>
                </div>
                <div className="relative min-w-[4.5rem] text-right">
                  <div className="text-xs font-semibold text-oai-black tabular-nums dark:text-white">{percent(platform.share)}</div>
                  <div className="text-xs text-oai-gray-500 tabular-nums dark:text-oai-gray-400" title={Number(platform.machines || 0).toLocaleString()}>
                    {copy("leaderboard.community.modal.machine_count", { count: compactCount(platform.machines) })}
                  </div>
                </div>
              </FillRow>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function CommunityStatsModalContent({ isOpen, onClose, communityStats }) {
  const { formatTokens, formatTokensTooltip } = useTokenFormat();
  const [activeTab, setActiveTab] = useState("overview");

  const ready = communityStats?.status === "ready";
  // One normalization pass: cap rankings, map the daily series into the shape
  // TrendMonitor consumes, and precompute max shares for the relative fills.
  const view = useMemo(() => {
    if (!ready) return null;
    const providers = (Array.isArray(communityStats.providers) ? communityStats.providers : [])
      .slice(0, TOP_ROWS_LIMIT);
    const models = (Array.isArray(communityStats.topModels) ? communityStats.topModels : [])
      .slice(0, TOP_ROWS_LIMIT);
    const maxShare = (rows) => rows.reduce((max, row) => Math.max(max, Number(row.share) || 0), 0) || 1;
    return {
      providers,
      models,
      providersMaxShare: maxShare(providers),
      modelsMaxShare: maxShare(models),
      trendRows: (Array.isArray(communityStats.dailyGrowth) ? communityStats.dailyGrowth : [])
        .map((row) => ({ day: dayLabel(row.day), value: Number(row.tokens) || 0 })),
      mix: Array.isArray(communityStats.tokenMix) ? communityStats.tokenMix : [],
      bands: Array.isArray(communityStats.userDistribution) ? communityStats.userDistribution : [],
      platforms: Array.isArray(communityStats.platforms) ? communityStats.platforms : [],
    };
  }, [ready, communityStats]);

  if (!view) return null;

  const totalTokens = Number(communityStats.tokenFloor) || 0;
  const developersTotal = Number(communityStats.activeDevelopersTotal)
    || Number(communityStats.totalEntries)
    || 0;
  const tokens30d = Number(communityStats.tokens30d) || 0;

  const onTablistKeyDown = (event) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const delta = event.key === "ArrowRight" ? 1 : -1;
    const next = TABS[(TABS.indexOf(activeTab) + delta + TABS.length) % TABS.length];
    setActiveTab(next);
    event.currentTarget.querySelector(`[data-tab-id="${next}"]`)?.focus();
  };

  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-[3px] transition-opacity duration-200 ease-out data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Viewport className="fixed inset-0 z-[101] flex items-center justify-center p-2 sm:p-5">
          <Dialog.Popup className="relative flex h-[min(42rem,92vh)] w-full max-w-xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-black/10 transition-[opacity,transform] duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] data-[ending-style]:translate-y-3 data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:translate-y-3 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0 dark:bg-oai-gray-950 dark:ring-white/10">
            <header data-testid="community-metrics-header" className="shrink-0 px-5 pt-5 sm:px-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <Dialog.Title className="text-lg font-semibold tracking-[-0.02em] text-oai-black dark:text-white">
                    {copy("leaderboard.community.modal.title")}
                  </Dialog.Title>
                  <Dialog.Description className="sr-only">{copy("leaderboard.community.modal.description")}</Dialog.Description>
                </div>
                <Dialog.Close className="-mr-1 -mt-1 grid size-8 place-items-center rounded-full text-oai-gray-400 transition-colors hover:bg-black/5 hover:text-oai-black dark:hover:bg-white/10 dark:hover:text-white" aria-label={copy("shared.dialog.close")}>
                  <X className="size-4" />
                </Dialog.Close>
              </div>

              <div className="mt-4 grid grid-cols-3 gap-x-5">
                <Metric label={copy("leaderboard.community.modal.total_tokens")} value={formatTokens(totalTokens)} title={formatTokensTooltip(totalTokens)} />
                <Metric label={copy("leaderboard.community.modal.tokens_30d")} value={formatTokens(tokens30d)} title={formatTokensTooltip(tokens30d)} delta={communityStats.tokenGrowthPct} deltaLabel={copy("leaderboard.community.modal.vs_previous_week")} />
                <Metric label={copy("leaderboard.community.modal.contributors")} value={compactCount(developersTotal)} title={developersTotal.toLocaleString()} />
              </div>

              <div
                className="mt-4 flex items-end overflow-x-auto border-b border-oai-gray-100 dark:border-oai-gray-900"
                role="tablist"
                aria-label={copy("leaderboard.community.modal.views")}
                onKeyDown={onTablistKeyDown}
              >
                {TABS.map((tab) => {
                  const selected = activeTab === tab;
                  return (
                    <button
                      key={tab}
                      type="button"
                      role="tab"
                      data-tab-id={tab}
                      aria-selected={selected}
                      tabIndex={selected ? 0 : -1}
                      onClick={() => setActiveTab(tab)}
                      className={`relative mr-5 h-10 shrink-0 text-sm font-medium transition-colors last:mr-0 ${selected ? "text-oai-black dark:text-white" : "text-oai-gray-500 hover:text-oai-gray-700 dark:text-oai-gray-400 dark:hover:text-oai-gray-200"}`}
                    >
                      {copy(`leaderboard.community.modal.tab.${tab}`)}
                      {selected ? (
                        <motion.span
                          layoutId="community-metrics-tab-underline"
                          className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-oai-black dark:bg-white"
                          transition={{ type: "spring", stiffness: 420, damping: 34 }}
                        />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </header>

            <div data-testid="community-metrics-content" className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
              <motion.div
                key={activeTab}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                className="h-full"
              >
                {activeTab === "overview" ? <OverviewView trendRows={view.trendRows} mix={view.mix} activeDevelopers30d={Number(communityStats.activeDevelopers30d) || 0} developerGrowthPct={communityStats.developerGrowthPct} formatTokens={formatTokens} formatTokensTooltip={formatTokensTooltip} /> : null}
                {activeTab === "providers" ? <ProvidersView rows={view.providers} maxShare={view.providersMaxShare} formatTokens={formatTokens} formatTokensTooltip={formatTokensTooltip} /> : null}
                {activeTab === "community" ? <CommunityView bands={view.bands} platforms={view.platforms} formatTokensTooltip={formatTokensTooltip} /> : null}
                {activeTab === "models" ? <ModelsView rows={view.models} maxShare={view.modelsMaxShare} formatTokens={formatTokens} formatTokensTooltip={formatTokensTooltip} /> : null}
              </motion.div>
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function CommunityStatsModal(props) {
  return (
    <TokenFormatModeOverride mode={TOKEN_FORMAT_MODES.COMPACT}>
      <CommunityStatsModalContent {...props} />
    </TokenFormatModeOverride>
  );
}
