import React from "react";
import { motion } from "motion/react";
import { Shell, Card, Button } from "../../components";
import { CostAnalysisModal } from "../components/CostAnalysisModal.jsx";
import { DataDetails } from "../components/DataDetails.jsx";
import { StatsPanel } from "../components/StatsPanel.jsx";
import { UsageOverview } from "../components/UsageOverview.jsx";
import { TrendMonitor } from "../components/TrendMonitor.jsx";
import { FadeIn } from "../../foundation/FadeIn.jsx";
import { MacAppBanner } from "../components/MacAppBanner.jsx";
import { WidgetOnboardingCard } from "../components/WidgetOnboardingCard.jsx";
import { LoginCard } from "../../../components/LoginCard.jsx";
import { DashboardSkeleton } from "../../../components/DashboardSkeleton.jsx";
import { cn } from "../../../lib/cn";
import { LogoCarousel } from "../../marketing/LogoCarousel.jsx";
import { AGENT_LOGOS } from "../../marketing/agent-logos.js";

// Curated subset of the canonical agent list for the gate carousel.
const GATE_LOGOS = AGENT_LOGOS.slice(0, 10);

function FullPageGateLayout({ title, subtitle, desc, loginCard, copy }) {
  return (
    <div className="min-h-[85vh] w-full flex items-center justify-center text-oai-black dark:text-white relative overflow-hidden px-4 md:px-8 py-8 md:py-16 transition-colors duration-200 bg-[linear-gradient(to_right,#80808007_1px,transparent_1px),linear-gradient(to_bottom,#80808007_1px,transparent_1px)] bg-[size:40px_40px]">
      {/* 科技感背景微光 */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(59,130,246,0.03),transparent_50%)] dark:bg-[radial-gradient(circle_at_50%_0%,rgba(99,102,241,0.05),transparent_50%)] pointer-events-none" />

      <div className="w-full max-w-5xl grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-16 items-start relative z-10">
        
        {/* 左侧品牌与价值 */}
        <div className="lg:col-span-7 flex flex-col justify-center space-y-8 text-left pr-0 lg:pr-6">
          
          {/* Logo 区域：使用精致的圆角矩形，还原精致的 Mac 圆角方形外观，移除多余剪裁 */}
          <div className="flex items-center gap-2.5">
            <img 
              src="/app-icon.png" 
              alt="" 
              width={32} 
              height={32} 
              className="rounded-md shadow-md border border-oai-gray-200/50 dark:border-oai-gray-800 shadow-black/10 dark:shadow-black/30" 
            />
            <span className="text-xl font-bold tracking-tight bg-gradient-to-r from-oai-black to-oai-gray-600 dark:from-white dark:to-oai-gray-400 bg-clip-text text-transparent font-oai">
              {copy("shared.app_name")}
            </span>
          </div>

          {/* 极具视觉张力的 Hero 主标题与简介 */}
          <div className="space-y-5">
            <div className="space-y-4">
              <h1 className="text-3xl md:text-4xl lg:text-4.5xl font-black tracking-tight leading-[1.15] text-oai-black dark:text-white">
                {title}
              </h1>
              <p className="text-oai-gray-500 dark:text-oai-gray-400 text-sm md:text-base max-w-xl leading-relaxed">
                {desc}
              </p>
            </div>

            {/* Logo 跑马灯组件：无限滑动滚动，呼吸感极致平衡 */}
            <div className="w-full max-w-[280px] sm:max-w-md opacity-85 hover:opacity-100 transition-opacity duration-200">
              <div className="flex justify-start">
                <LogoCarousel logos={GATE_LOGOS} columnCount={6} />
              </div>
            </div>
          </div>
        </div>

        {/* 右侧表单 */}
        <div className="lg:col-span-5 flex justify-center">
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.3 }}
            className="w-full max-w-[400px] rounded-2xl border border-oai-gray-200/80 dark:border-oai-gray-800 bg-white/70 dark:bg-oai-gray-950/40 backdrop-blur-md shadow-2xl p-1 relative overflow-hidden"
          >
            {/* 表单内部高光 */}
            <div className="absolute -inset-px bg-gradient-to-b from-white/10 dark:from-white/5 to-transparent pointer-events-none rounded-2xl" />
            {loginCard}
          </motion.div>
        </div>

      </div>
    </div>
  );
}

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
    initialDashboardLoading,
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
        {showAuthGate && (
          <FullPageGateLayout
            title={copy("dashboard.auth_gate.hero_title")}
            desc={copy("dashboard.auth_gate.desc")}
            copy={copy}
            loginCard={
              <LoginCard
                title={copy("dashboard.auth_gate.title")}
                subtitle={copy("dashboard.auth_gate.subtitle")}
                hideLogo={true}
                className="bg-transparent rounded-xl"
              />
            }
          />
        )}
        {showExpiredGate && (
          <FullPageGateLayout
            title={copy("dashboard.expired_gate.hero_title")}
            desc={copy("dashboard.expired_gate.desc")}
            copy={copy}
            loginCard={
              <LoginCard
                title={copy("dashboard.expired_gate.title")}
                subtitle={copy("dashboard.expired_gate.subtitle")}
                hideLogo={true}
                className="bg-transparent rounded-xl"
              />
            }
          />
        )}
        {!showAuthGate && !showExpiredGate && initialDashboardLoading && (
          <DashboardSkeleton />
        )}
        {!showAuthGate && !showExpiredGate && !initialDashboardLoading && (
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
                    from={usageFrom}
                    to={usageTo}
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
