import SwiftUI

@main
struct TokenTrackerBarApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        Settings { EmptyView() }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {

    private var statusBarController: StatusBarController?
    private let viewModel = DashboardViewModel()
    private let serverManager = ServerManager()
    private let launchAtLoginManager = LaunchAtLoginManager()

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusBarController = StatusBarController(
            viewModel: viewModel,
            serverManager: serverManager,
            launchAtLoginManager: launchAtLoginManager
        )

        NativeBridge.shared.configure(
            viewModel: viewModel,
            launchAtLoginManager: launchAtLoginManager
        )

        Task { @MainActor in
            await serverManager.ensureServerRunning()
            if serverManager.isServerRunning {
                await viewModel.syncThenLoad()
                viewModel.startAutoRefresh()
            }

            UpdateChecker.shared.check(silent: true)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        serverManager.stopServer()
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            guard url.scheme == "tokentracker" else { continue }
            if url.host == "auth" && url.path.hasPrefix("/done") {
                DashboardWindowController.shared.handleAuthDone()
            } else if url.host == "auth" && url.path.hasPrefix("/callback") {
                // Browser relays OAuth code back via tokentracker://auth/callback?insforge_code=xxx
                let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
                let code = components?.queryItems?.first(where: { $0.name == "insforge_code" })?.value
                if let code {
                    DashboardWindowController.shared.handleAuthCallback(code: code)
                }
            }
        }
    }
}
