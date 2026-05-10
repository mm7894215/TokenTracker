import React, { useMemo } from "react";
import { useLocation } from "react-router-dom";
import { Analytics } from "@vercel/analytics/react";
import { SpeedInsights } from "@vercel/speed-insights/react";
import { ErrorBoundary } from "./components/ErrorBoundary.jsx";
import { useLocale } from "./hooks/useLocale.js";
import { ThemeProvider } from "./ui/foundation/ThemeProvider.jsx";
import { useInsforgeAuth } from "./contexts/InsforgeAuthContext.jsx";
import { LoginModalProvider } from "./contexts/LoginModalContext.jsx";
import { LoginModal } from "./components/LoginModal.jsx";
import { getBackendBaseUrl } from "./lib/config";
import { isMockEnabled } from "./lib/mock-data";
import { isScreenshotModeEnabled } from "./lib/screenshot-mode";
import { useCloudUsageSync } from "./hooks/use-cloud-usage-sync";
import { DashboardPage } from "./pages/DashboardPage.jsx";
import IpCheckPage from "./pages/IpCheckPage.jsx";
import { LandingPage } from "./pages/LandingPage.jsx";
import { LeaderboardPage } from "./pages/LeaderboardPage.jsx";
import { LeaderboardProfilePage } from "./pages/LeaderboardProfilePage.jsx";
import { LimitsPage } from "./pages/LimitsPage.jsx";
import { LoginPage } from "./pages/LoginPage.jsx";
import { NativeAuthCallbackPage } from "./pages/NativeAuthCallbackPage.jsx";
import { SettingsPage } from "./pages/SettingsPage.jsx";
import { SkillsPage } from "./pages/SkillsPage.jsx";
import { AppLayout } from "./ui/components/Sidebar.jsx";
import { WidgetsPage } from "./pages/WidgetsPage.jsx";

export default function App() {
  // Subscribing to locale here makes App rerender on language switch, which
  // rebuilds every child element reference and triggers copy() re-evaluation
  // across the tree — without unmounting lazy-loaded pages.
  const { resolvedLocale } = useLocale();
  const location = useLocation();
  const insforge = useInsforgeAuth();
  useCloudUsageSync();
  const mockEnabled = isMockEnabled();
  const screenshotMode = useMemo(() => {
    if (typeof window === "undefined") return false;
    return isScreenshotModeEnabled(window.location.search);
  }, []);
  const pathname = location?.pathname || "/";
  const pageUrl = new URL(window.location.href);
  const sharePathname = pageUrl.pathname.replace(/\/+$/, "") || "/";
  const shareMatch = sharePathname.match(/^\/share\/([^/?#]+)$/i);
  const tokenFromPath = shareMatch?.[1] || null;
  const tokenFromQuery = pageUrl.searchParams.get("token") || null;
  const publicToken = tokenFromPath || tokenFromQuery;
  const publicMode =
    sharePathname === "/share" ||
    sharePathname === "/share.html" ||
    sharePathname.startsWith("/share/");

  const isLocalMode =
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");

  const normalizedPath = pathname.replace(/\/+$/, "") || "/";
  const leaderboardProfileMatch = normalizedPath.match(/^\/leaderboard\/u\/([^/]+)$/i);
  const leaderboardProfileUserId = leaderboardProfileMatch ? leaderboardProfileMatch[1] : null;
  const isLeaderboardPath = normalizedPath === "/leaderboard" || Boolean(leaderboardProfileUserId);

  const cloudAuthSignedIn = Boolean(insforge.enabled && insforge.signedIn);
  const signedIn = isLocalMode || cloudAuthSignedIn;
  const sessionSoftExpired = false;
  const baseUrl = getBackendBaseUrl();

  const authObject = useMemo(() => {
    if (!insforge.enabled || !cloudAuthSignedIn) return null;
    return {
      getAccessToken: () => insforge.getAccessToken(),
      name: insforge.displayName || "",
      userId: insforge.user?.id || null,
    };
  }, [cloudAuthSignedIn, insforge]);

  let gate = isLocalMode || mockEnabled || screenshotMode ? "dashboard" : "landing";
  if (normalizedPath === "/landing") gate = "landing";
  if (normalizedPath === "/dashboard") gate = "dashboard";
  if (isLeaderboardPath) gate = "dashboard";

  const isLimitsPath = normalizedPath === "/limits";
  const isSettingsPath = normalizedPath === "/settings";
  const isSkillsPath = normalizedPath === "/skills";
  const isWidgetsPath = normalizedPath === "/widgets";
  const isIpCheckPath = normalizedPath === "/ip-check";
  if (isLimitsPath || isSettingsPath || isSkillsPath || isWidgetsPath || isIpCheckPath) gate = "dashboard";

  let PageComponent = DashboardPage;
  if (leaderboardProfileUserId) {
    PageComponent = LeaderboardProfilePage;
  } else if (normalizedPath === "/leaderboard") {
    PageComponent = LeaderboardPage;
  } else if (isLimitsPath) {
    PageComponent = LimitsPage;
  } else if (isSettingsPath) {
    PageComponent = SettingsPage;
  } else if (isSkillsPath) {
    PageComponent = SkillsPage;
  } else if (isWidgetsPath) {
    PageComponent = WidgetsPage;
  } else if (isIpCheckPath) {
    PageComponent = IpCheckPage;
  }

  // /leaderboard/u/:id (LeaderboardProfilePage) still ships its own
  // min-h-screen + sticky header/footer chrome, so it must NOT be wrapped
  // in AppLayout — that would double-stack the nav and break scrolling.
  // Only the index /leaderboard route is migrated to AppLayout for now.
  const isLeaderboardIndexPath = normalizedPath === "/leaderboard";
  const showSidebar =
    !publicMode &&
    (normalizedPath === "/dashboard" ||
      normalizedPath === "/" ||
      isLeaderboardIndexPath ||
      isLimitsPath ||
      isSettingsPath ||
      isSkillsPath ||
      isWidgetsPath ||
      isIpCheckPath);

  let content = null;
  if (normalizedPath === "/auth/callback" || normalizedPath === "/auth/native-callback") {
    content = <NativeAuthCallbackPage />;
  } else if (normalizedPath === "/login") {
    content = <LoginPage />;
  } else if (gate === "landing") {
    content = <LandingPage signInUrl="/login" signUpUrl="/login" />;
  } else {
    const pageNode = (
      <PageComponent
        key={resolvedLocale}
        baseUrl={baseUrl}
        auth={authObject}
        signedIn={signedIn}
        sessionSoftExpired={sessionSoftExpired}
        signOut={() => (insforge.enabled ? insforge.signOut() : Promise.resolve())}
        publicMode={publicMode}
        publicToken={publicToken}
        userId={leaderboardProfileUserId}
        signInUrl="/login"
        signUpUrl="/login"
      />
    );
    if (showSidebar) {
      content = <AppLayout>{pageNode}</AppLayout>;
    } else {
      content = pageNode;
    }
  }

  return (
    <ErrorBoundary>
      <ThemeProvider>
        <LoginModalProvider>
          {content}
          <LoginModal />
          <Analytics />
          <SpeedInsights />
        </LoginModalProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
