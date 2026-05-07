import React from "react";
import { motion } from "motion/react";
import { Shell, Card, Button } from "../../openai/components";
import { CostAnalysisModal } from "../components/CostAnalysisModal.jsx";
import { DataDetails } from "../components/DataDetails.jsx";
import { StatsPanel } from "../components/StatsPanel.jsx";
import { UsageOverview } from "../components/UsageOverview.jsx";
import { TrendMonitor } from "../components/TrendMonitor.jsx";
import { FadeIn } from "../../foundation/FadeIn.jsx";
import { MacAppBanner } from "../components/MacAppBanner.jsx";
import { WidgetOnboardingCard } from "../components/WidgetOnboardingCard.jsx";

export function DashboardView(props) {
  const {
    copy,
    onOpenShare,
    screenshotMode,
    showExpiredGate,
    showAuthGate,
    screenshotTitleLine1,
    screenshotTitleLine2,
    identityDisplayName,
    identityStartDate,
    activeDays,
    identitySubscriptions,
    identityScrambleDurationMs,
    projectUsageEntries,
    projectUsageLimit,
    setProjectUsageLimit,
    topModels,
    signedIn,
    publicMode,
    isLocalMode,
    shouldShowInstall,
    installPrompt,
    handleCopyInstall,
    installCopied,
    installInitCmdDisplay,
    trendRowsForDisplay,
    trendFromForDisplay,
    trendToForDisplay,
    period,
    trendTimeZoneLabel,
    activityHeatmapBlock,
    isCapturing,
    handleShareToX,
    screenshotTwitterButton,
    screenshotTwitterHint,
    periodsForDisplay,
    setSelectedPeriod,
    customFrom,
    customTo,
    onCustomRangeApply,
    customRangeOpen,
    onCustomRangeOpenChange,
    summaryLabel,
    summaryValue,
    summaryTotalTokensRaw,
    summaryCostValue,
    summaryConversationsValue,
    rollingUsage,
    costInfoEnabled,
    openCostModal,
    costModalOpen,
    closeCostModal,
    allowBreakdownToggle,
    refreshAll,
    usageLoadingState,
    fleetData,
    hasDetailsActual,
    dailyEmptyPrefix,
    installSyncCmd,
    dailyEmptySuffix,
    detailsColumns,
    ariaSortFor,
    toggleSort,
    sortIconFor,
    pagedDetails,
    dailyBreakdownRows,
    dailyBreakdownColumns,
    dailyBreakdownAriaSortFor,
    dailyBreakdownSortIconFor,
    dailyBreakdownDateKey,
    detailsDateKey,
    renderDetailDate,
    renderDailyBreakdownDate,
    renderDetailCell,
    DETAILS_PAGED_PERIODS,
    detailsPageCount,
    detailsPage,
    setDetailsPage,
  } = props;

  // Header 和 Footer 已简化
  const header = null;
  const footer = null;

  // 入场瀑布：右列主卡先到，左列依序跟进
  const STEP = 0.06;
  const D_USAGE_OVERVIEW = 0.05;
  const D_LEFT_BASE = 0.11;
  let leftIdx = 0;
  const nextLeft = () => D_LEFT_BASE + STEP * leftIdx++;
  const D_DATA_DETAILS = D_LEFT_BASE + STEP * 5; // 留给右列底部

  return (
    <>
      <Shell
        bare={!screenshotMode}
        hideHeader={screenshotMode}
        header={header}
        footer={!screenshotMode ? footer : null}
        className={screenshotMode ? "screenshot-mode" : ""}
      >
        {(showExpiredGate || showAuthGate) ? null : (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
              <div className="lg:col-span-4 flex flex-col gap-4 min-w-0 order-2 lg:order-1">
                {screenshotMode ? (
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex flex-col gap-1">
                      <span className="text-3xl md:text-4xl font-semibold text-oai-black dark:text-oai-white tracking-tight leading-none">
                        {screenshotTitleLine1}
                      </span>
                      <span className="text-2xl md:text-3xl font-semibold text-oai-black dark:text-oai-white tracking-tight leading-none">
                        {screenshotTitleLine2}
                      </span>
                    </div>
                  </div>
                ) : null}
                {isLocalMode ? (
                  <MacAppBanner
                    todayTokens={summaryTotalTokensRaw}
                    isSyncing={usageLoadingState}
                    enterDelay={nextLeft()}
                  />
                ) : null}

                <FadeIn delay={nextLeft()}>
                  <StatsPanel
                    title={copy("dashboard.identity.title")}
                    subtitle={copy("dashboard.identity.subtitle")}
                    period={period}
                    rankLabel={identityStartDate ?? copy("identity_card.rank_placeholder")}
                    streakDays={activeDays}
                    subscriptions={identitySubscriptions}
                    periodConversations={summaryConversationsValue}
                    rolling={rollingUsage}
                    topModels={topModels}
                  />
                </FadeIn>

                {isLocalMode ? <WidgetOnboardingCard enterDelay={nextLeft()} /> : null}

                {shouldShowInstall ? (
                  <FadeIn delay={nextLeft()}>
                    <div className="rounded-xl border border-oai-gray-200 dark:border-oai-gray-800 bg-white dark:bg-oai-gray-900 p-3">
                      <div className="text-xs text-oai-gray-500 dark:text-oai-gray-300 mb-1.5">{installPrompt}</div>
                      <motion.button
                        onClick={handleCopyInstall}
                        whileHover={{ scale: 1.01 }}
                        whileTap={{ scale: 0.99 }}
                        className="w-full flex items-center justify-between px-3 py-2 bg-oai-gray-50 dark:bg-oai-gray-800 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-700 rounded-lg transition-colors"
                      >
                        <code className="text-xs font-mono text-oai-gray-700 dark:text-oai-gray-300">{installInitCmdDisplay}</code>
                        <motion.span
                          key={installCopied ? "copied" : "copy"}
                          initial={{ opacity: 0, y: -5 }}
                          animate={{ opacity: 1, y: 0 }}
                          className="text-xs text-oai-brand"
                        >
                          {installCopied ? "Copied ✓" : "Copy"}
                        </motion.span>
                      </motion.button>
                    </div>
                  </FadeIn>
                ) : null}

                {activityHeatmapBlock && (
                  <FadeIn delay={nextLeft()}>
                    {activityHeatmapBlock}
                  </FadeIn>
                )}

                {!screenshotMode ? (
                  <FadeIn delay={nextLeft()}>
                    <TrendMonitor
                      rows={trendRowsForDisplay}
                      from={trendFromForDisplay}
                      to={trendToForDisplay}
                      period={period}
                      timeZoneLabel={trendTimeZoneLabel}
                      showTimeZoneLabel={false}
                    />
                  </FadeIn>
                ) : null}
                {screenshotMode ? (
                  <div
                    className="mt-4 flex flex-col items-center gap-2"
                    data-screenshot-exclude="true"
                    style={isCapturing ? { display: "none" } : undefined}
                  >
                    <Button
                      type="button"
                      onClick={handleShareToX}
                      variant="primary"
                      size="lg"
                      disabled={isCapturing}
                    >
                      {screenshotTwitterButton}
                    </Button>
                    <span className="text-sm text-oai-gray-500 dark:text-oai-gray-300">
                      {screenshotTwitterHint}
                    </span>
                  </div>
                ) : null}
              </div>

              <div className="lg:col-span-8 flex flex-col gap-4 min-w-0 order-1 lg:order-2">
                <FadeIn delay={D_USAGE_OVERVIEW}>
                  <UsageOverview
                    period={period}
                    periods={periodsForDisplay}
                    onPeriodChange={setSelectedPeriod}
                    summaryLabel={summaryLabel}
                    summaryValue={summaryValue}
                    summaryCostValue={summaryCostValue}
                    onCostInfo={costInfoEnabled ? openCostModal : null}
                    fleetData={fleetData}
                    onRefresh={screenshotMode ? null : refreshAll}
                    loading={usageLoadingState}
                    onOpenShare={screenshotMode ? null : onOpenShare}
                    customFrom={customFrom}
                    customTo={customTo}
                    onCustomRangeApply={onCustomRangeApply}
                    customRangeOpen={customRangeOpen}
                    onCustomRangeOpenChange={onCustomRangeOpenChange}
                  />
                </FadeIn>

                {!screenshotMode ? (
                  <FadeIn delay={D_DATA_DETAILS}>
                    <DataDetails
                      projectEntries={projectUsageEntries}
                      projectLimit={projectUsageLimit}
                      onProjectLimitChange={setProjectUsageLimit}
                      copy={copy}
                      hasDetailsActual={hasDetailsActual}
                      dailyEmptyPrefix={dailyEmptyPrefix}
                      installSyncCmd={installSyncCmd}
                      dailyEmptySuffix={dailyEmptySuffix}
                      detailsColumns={detailsColumns}
                      ariaSortFor={ariaSortFor}
                      toggleSort={toggleSort}
                      sortIconFor={sortIconFor}
                      pagedDetails={pagedDetails}
                      dailyBreakdownRows={dailyBreakdownRows}
                      dailyBreakdownColumns={dailyBreakdownColumns}
                      dailyBreakdownAriaSortFor={dailyBreakdownAriaSortFor}
                      dailyBreakdownSortIconFor={dailyBreakdownSortIconFor}
                      dailyBreakdownDateKey={dailyBreakdownDateKey}
                      detailsDateKey={detailsDateKey}
                      renderDetailDate={renderDetailDate}
                      renderDailyBreakdownDate={renderDailyBreakdownDate}
                      renderDetailCell={renderDetailCell}
                      DETAILS_PAGED_PERIODS={DETAILS_PAGED_PERIODS}
                      period={period}
                      detailsPageCount={detailsPageCount}
                      detailsPage={detailsPage}
                      setDetailsPage={setDetailsPage}
                    />
                  </FadeIn>
                ) : null}
              </div>
          </div>
        )}
      </Shell>
      <CostAnalysisModal isOpen={costModalOpen} onClose={closeCostModal} fleetData={fleetData} />
    </>
  );
}
