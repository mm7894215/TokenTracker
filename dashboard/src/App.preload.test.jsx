import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.jsx";
import {
  markDashboardMainContentVisible,
  preloadDashboardPageResources,
  preloadLeaderboardDefaultState,
} from "./lib/dashboard-preload.js";

const TEXT = {
  dashboard: "Dashboard page",
  device: "Device page",
  ipCheck: "IP check",
  landing: "Landing page",
  leaderboard: "Leaderboard page",
  limits: "Limits page",
  limitsNav: "Limits nav",
  login: "Login page",
  nativeCallback: "Native callback",
  profile: "Profile page",
  reveal: "reveal main content",
  settings: "Settings page",
  skills: "Skills page",
  widgets: "Widgets page",
  wrapped: "Wrapped page",
};

const insforgeMock = vi.hoisted(() => ({
  enabled: true,
  signedIn: true,
  loading: false,
  user: { id: "user-1" },
  displayName: "Ada",
  getAccessToken: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("./lib/dashboard-preload.js", () => ({
  getLeaderboardPreloadContextKey: vi.fn((options = {}) =>
    [
      options.accessMode || "",
      options.baseUrl || "",
      String(Boolean(options.mockEnabled)),
      String(Boolean(options.signedIn)),
      String(Boolean(options.authLoading)),
      options.userId || "null",
    ].join("|"),
  ),
  markDashboardMainContentVisible: vi.fn(),
  preloadDashboardPageResources: vi.fn(() => Promise.resolve([])),
  preloadLeaderboardDefaultState: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("./hooks/useLocale.js", () => ({
  useLocale: () => ({ resolvedLocale: "en" }),
}));

vi.mock("./contexts/InsforgeAuthContext.jsx", () => ({
  useInsforgeAuth: () => insforgeMock,
}));

vi.mock("./hooks/use-cloud-usage-sync", () => ({
  useCloudUsageSync: vi.fn(),
}));

vi.mock("./lib/mock-data", () => ({
  isMockEnabled: () => false,
}));

vi.mock("./lib/config", () => ({
  getBackendBaseUrl: () => "",
  getLeaderboardBaseUrl: () => "https://edge.example",
}));

vi.mock("./lib/screenshot-mode", () => ({
  isScreenshotModeEnabled: () => false,
}));

vi.mock("./components/ErrorBoundary.jsx", () => ({
  ErrorBoundary: ({ children }) => <>{children}</>,
}));

vi.mock("./ui/foundation/ThemeProvider.jsx", () => ({
  ThemeProvider: ({ children }) => <>{children}</>,
}));

vi.mock("./contexts/LoginModalContext.jsx", () => ({
  LoginModalProvider: ({ children }) => <>{children}</>,
}));

vi.mock("./components/LoginModal.jsx", () => ({
  LoginModal: () => null,
}));

vi.mock("@vercel/analytics/react", () => ({
  Analytics: () => null,
}));

vi.mock("@vercel/speed-insights/react", () => ({
  SpeedInsights: () => null,
}));

vi.mock("./ui/components/Sidebar.jsx", () => ({
  AppLayout: ({ children }) => (
    <div>
      <a href="/limits" onClick={(event) => event.preventDefault()}>
        {TEXT.limitsNav}
      </a>
      {children}
    </div>
  ),
}));

vi.mock("./ui/dashboard/components/CommandPalette.jsx", () => ({
  CommandPalette: () => null,
}));

vi.mock("./pages/DashboardPage.jsx", () => ({
  DashboardPage: ({ onMainContentVisible }) => (
    <main>
      <h1>{TEXT.dashboard}</h1>
      <button type="button" onClick={onMainContentVisible}>
        {TEXT.reveal}
      </button>
    </main>
  ),
}));

vi.mock("./pages/LimitsPage.jsx", () => ({
  LimitsPage: ({ onMainContentVisible }) => {
    React.useEffect(() => {
      onMainContentVisible?.();
    }, [onMainContentVisible]);
    return <main>{TEXT.limits}</main>;
  },
}));

vi.mock("./pages/LeaderboardPage.jsx", () => ({
  LeaderboardPage: ({ onMainContentVisible }) => {
    React.useEffect(() => {
      onMainContentVisible?.();
    }, [onMainContentVisible]);
    return <main>{TEXT.leaderboard}</main>;
  },
}));

vi.mock("./pages/NativeAuthCallbackPage.jsx", () => ({
  NativeAuthCallbackPage: () => <main>{TEXT.nativeCallback}</main>,
}));

vi.mock("./pages/IpCheckPage.jsx", () => ({ default: () => <main>{TEXT.ipCheck}</main> }));
vi.mock("./pages/LandingPage.jsx", () => ({ LandingPage: () => <main>{TEXT.landing}</main> }));
vi.mock("./pages/LeaderboardProfilePage.jsx", () => ({ LeaderboardProfilePage: () => <main>{TEXT.profile}</main> }));
vi.mock("./pages/LoginPage.jsx", () => ({ LoginPage: () => <main>{TEXT.login}</main> }));
vi.mock("./pages/DevicePage.jsx", () => ({ default: () => <main>{TEXT.device}</main> }));
vi.mock("./pages/WrappedPage.jsx", () => ({ default: () => <main>{TEXT.wrapped}</main> }));
vi.mock("./pages/SettingsPage.jsx", () => ({ SettingsPage: () => <main>{TEXT.settings}</main> }));
vi.mock("./pages/SkillsPage.jsx", () => ({ SkillsPage: () => <main>{TEXT.skills}</main> }));
vi.mock("./pages/WidgetsPage.jsx", () => ({ WidgetsPage: () => <main>{TEXT.widgets}</main> }));

function renderApp(initialPath = "/dashboard") {
  window.history.pushState({}, "", initialPath);
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <App />
    </MemoryRouter>,
  );
}

describe("App deferred dashboard preload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insforgeMock.enabled = true;
    insforgeMock.signedIn = true;
    insforgeMock.loading = false;
    insforgeMock.user = { id: "user-1" };
    insforgeMock.displayName = "Ada";
    window.history.pushState({}, "", "/");
  });

  it("does not start target preload before the dashboard main content is visible", async () => {
    const user = userEvent.setup();
    renderApp("/dashboard");

    expect(await screen.findByText(TEXT.dashboard)).toBeInTheDocument();
    expect(preloadDashboardPageResources).not.toHaveBeenCalled();
    expect(preloadLeaderboardDefaultState).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: TEXT.reveal }));

    await waitFor(() => {
      expect(markDashboardMainContentVisible).toHaveBeenCalledTimes(1);
      expect(preloadDashboardPageResources).toHaveBeenCalledTimes(1);
      expect(preloadLeaderboardDefaultState).toHaveBeenCalledWith({
        accessMode: "cloud",
        baseUrl: "https://edge.example",
        mockEnabled: false,
        signedIn: true,
        authLoading: false,
        userId: "user-1",
      });
    });
  });

  it.each([
    ["/limits", TEXT.limits],
    ["/leaderboard", TEXT.leaderboard],
  ])("does not start dashboard preload for deep-linked %s", async (path, pageText) => {
    renderApp(path);

    expect(await screen.findByText(pageText)).toBeInTheDocument();

    await waitFor(() => {
      expect(markDashboardMainContentVisible).not.toHaveBeenCalled();
      expect(preloadDashboardPageResources).not.toHaveBeenCalled();
      expect(preloadLeaderboardDefaultState).not.toHaveBeenCalled();
    });
  });

  it("uses local dashboard access for leaderboard state preload eligibility", async () => {
    const user = userEvent.setup();
    insforgeMock.signedIn = false;
    insforgeMock.user = null;

    renderApp("/dashboard");

    expect(await screen.findByText(TEXT.dashboard)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: TEXT.reveal }));

    await waitFor(() => {
      expect(preloadDashboardPageResources).toHaveBeenCalledTimes(1);
      expect(preloadLeaderboardDefaultState).toHaveBeenCalledWith({
        accessMode: "local",
        baseUrl: "https://edge.example",
        mockEnabled: false,
        signedIn: true,
        authLoading: false,
        userId: null,
      });
    });
  });

  it("preloads again when the leaderboard auth context changes", async () => {
    const user = userEvent.setup();
    insforgeMock.signedIn = false;
    insforgeMock.user = null;
    const view = renderApp("/dashboard");

    expect(await screen.findByText(TEXT.dashboard)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: TEXT.reveal }));

    await waitFor(() => {
      expect(preloadLeaderboardDefaultState).toHaveBeenCalledTimes(1);
      expect(preloadLeaderboardDefaultState).toHaveBeenLastCalledWith({
        accessMode: "local",
        baseUrl: "https://edge.example",
        mockEnabled: false,
        signedIn: true,
        authLoading: false,
        userId: null,
      });
    });

    insforgeMock.signedIn = true;
    insforgeMock.user = { id: "user-cloud" };
    view.rerender(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <App />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(preloadLeaderboardDefaultState).toHaveBeenCalledTimes(2);
      expect(preloadLeaderboardDefaultState).toHaveBeenLastCalledWith({
        accessMode: "cloud",
        baseUrl: "https://edge.example",
        mockEnabled: false,
        signedIn: true,
        authLoading: false,
        userId: "user-cloud",
      });
    });
  });

  it("waits for cloud auth to settle before preloading leaderboard default state", async () => {
    const user = userEvent.setup();
    insforgeMock.loading = true;
    insforgeMock.signedIn = false;
    insforgeMock.user = null;
    const view = renderApp("/dashboard");

    expect(await screen.findByText(TEXT.dashboard)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: TEXT.reveal }));

    await waitFor(() => {
      expect(preloadDashboardPageResources).toHaveBeenCalledTimes(1);
      expect(preloadLeaderboardDefaultState).not.toHaveBeenCalled();
    });

    insforgeMock.loading = false;
    insforgeMock.signedIn = true;
    insforgeMock.user = { id: "user-late" };
    view.rerender(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <App />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(preloadLeaderboardDefaultState).toHaveBeenCalledTimes(1);
      expect(preloadLeaderboardDefaultState).toHaveBeenCalledWith({
        accessMode: "cloud",
        baseUrl: "https://edge.example",
        mockEnabled: false,
        signedIn: true,
        authLoading: false,
        userId: "user-late",
      });
    });
  });
});
