import React, { Suspense, useMemo } from "react";
import { useLocation } from "react-router-dom";
import { Analytics } from "@vercel/analytics/react";
import { SpeedInsights } from "@vercel/speed-insights/react";
import { ErrorBoundary } from "./components/ErrorBoundary.jsx";
import { LocaleProvider } from "./ui/foundation/LocaleProvider.jsx";
import { ThemeProvider } from "./ui/foundation/ThemeProvider.jsx";
import { useInsforgeAuth } from "./contexts/InsforgeAuthContext.jsx";
import { LoginModalProvider } from "./contexts/LoginModalContext.jsx";
import { LoginModal } from "./components/LoginModal.jsx";
import { getBackendBaseUrl } from "./lib/config";
import { isMockEnabled } from "./lib/mock-data";
import { isScreenshotModeEnabled } from "./lib/screenshot-mode";
import { useCloudUsageSync } from "./hooks/use-cloud-usage-sync";
import { LandingPage } from "./pages/LandingPage.jsx";
import { LoginPage } from "./pages/LoginPage.jsx";
import { NativeAuthCallbackPage } from "./pages/NativeAuthCallbackPage.jsx";
import { AppLayout } from "./ui/openai/components/Sidebar.jsx";

const DashboardPage = React.lazy(() =>
  import("./pages/DashboardPage.jsx").then((mod) => ({ default: mod.DashboardPage })),
);
const LeaderboardPage = React.lazy(() =>
  import("./pages/LeaderboardPage.jsx").then((mod) => ({ default: mod.LeaderboardPage })),
);
const LeaderboardProfilePage = React.lazy(() =>
  import("./pages/LeaderboardProfilePage.jsx").then((mod) => ({ default: mod.LeaderboardProfilePage })),
);
const LimitsPage = React.lazy(() =>
  import("./pages/LimitsPage.jsx").then((mod) => ({ default: mod.LimitsPage })),
);
const SettingsPage = React.lazy(() =>
  import("./pages/SettingsPage.jsx").then((mod) => ({ default: mod.SettingsPage })),
);
const WidgetsPage = React.lazy(() =>
  import("./pages/WidgetsPage.jsx").then((mod) => ({ default: mod.WidgetsPage })),
);
const IpCheckPage = React.lazy(() => import("./pages/IpCheckPage.jsx"));

export default function App() {
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
  const isWidgetsPath = normalizedPath === "/widgets";
  const isIpCheckPath = normalizedPath === "/ip-check";
  if (isLimitsPath || isSettingsPath || isWidgetsPath || isIpCheckPath) gate = "dashboard";

  const PageComponent = leaderboardProfileUserId
    ? LeaderboardProfilePage
    : normalizedPath === "/leaderboard"
      ? LeaderboardPage
      : isLimitsPath
        ? LimitsPage
        : isSettingsPath
          ? SettingsPage
          : isWidgetsPath
            ? WidgetsPage
            : isIpCheckPath
              ? IpCheckPage
              : DashboardPage;

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
      isWidgetsPath ||
      isIpCheckPath);

  const loadingShell = <div className="min-h-screen bg-oai-white dark:bg-[#050505]" />;

  let content = null;
  if (normalizedPath === "/auth/callback" || normalizedPath === "/auth/native-callback") {
    content = <NativeAuthCallbackPage />;
  } else if (normalizedPath === "/login") {
    content = <LoginPage />;
  } else if (gate === "landing") {
    content = <LandingPage signInUrl="/login" signUpUrl="/login" />;
  } else {
    const pageNode = (
      <Suspense fallback={loadingShell}>
        <PageComponent
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
      </Suspense>
    );
    content = showSidebar ? <AppLayout>{pageNode}</AppLayout> : pageNode;
  }

  return (
    <ErrorBoundary>
      <LocaleProvider>
        <ThemeProvider>
          <LoginModalProvider>
            {content}
            <LoginModal />
            <Analytics />
            <SpeedInsights />
          </LoginModalProvider>
        </ThemeProvider>
      </LocaleProvider>
    </ErrorBoundary>
  );
}
