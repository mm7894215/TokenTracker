import React from "react";
import { Shell, Button } from "../../components";
import { CostAnalysisModal } from "../components/CostAnalysisModal.jsx";
import { DataDetails } from "../components/DataDetails.jsx";
import { StatsPanel } from "../components/StatsPanel.jsx";
import { UsageOverview } from "../components/UsageOverview.jsx";
import { TrendMonitor } from "../components/TrendMonitor.jsx";
import { FadeIn } from "../../foundation/FadeIn.jsx";
import { WidgetOnboardingCard } from "../components/WidgetOnboardingCard.jsx";

export function DashboardView(props) {

  const {
    copy,
    onOpenShare,
    screenshotMode,
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
    isLocalMode,
    trendRowsForDisplay,
    trendFromForDisplay,
    trendToForDisplay,
    trendZoomConfig,
    usageFrom,
    usageTo,
    period,
    trendTimeZoneLabel,
    activityHeatmapBlock,
    isCapturing,
    handleShareToX,
    screenshotTwitterButton,
    screenshotTwitterHint,
    periodsForDisplay,
    setSelectedPeriod,
    autoRefreshOptions,
    autoRefreshIntervalMs,
    onAutoRefreshIntervalChange,
    customFrom,
    customTo,
    onCustomRangeApply,
    customRangeOpen,
    onCustomRangeOpenChange,
    summaryLabel,
    summaryValue,
    summaryUpdatedAtLabel,
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
    dataHealthMessage,
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
                      zoomConfig={trendZoomConfig}
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
                    autoRefreshOptions={autoRefreshOptions}
                    autoRefreshIntervalMs={autoRefreshIntervalMs}
                    onAutoRefreshIntervalChange={onAutoRefreshIntervalChange}
                    summaryLabel={summaryLabel}
                    summaryValue={summaryValue}
                    summaryUpdatedAtLabel={summaryUpdatedAtLabel}
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
                    from={usageFrom}
                    to={usageTo}
                  />
                </FadeIn>

                {!screenshotMode ? (
                  dataHealthMessage ? (
                    <FadeIn delay={D_USAGE_OVERVIEW + 0.03}>
                      <div className="rounded-lg border border-oai-gray-200 bg-oai-gray-50 px-4 py-3 text-sm text-oai-gray-700 dark:border-oai-gray-800 dark:bg-oai-gray-900/70 dark:text-oai-gray-300">
                        {dataHealthMessage}
                      </div>
                    </FadeIn>
                  ) : null
                ) : null}

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
      </Shell>
      <CostAnalysisModal isOpen={costModalOpen} onClose={closeCostModal} fleetData={fleetData} />
    </>
  );
}
