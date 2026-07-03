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
    private var lastWakeCatchUpAttemptAt: Date?
    private let viewModel = DashboardViewModel()
    private let serverManager = ServerManager()
    private let launchAtLoginManager = LaunchAtLoginManager()
    private lazy var desktopPetController = DesktopPetWindowController(viewModel: viewModel)
    private static var userInitiatedQuit = false
    private static let wakeCatchUpDebounceInterval: TimeInterval = 60

    /// Real quit path: popover/Footer Quit buttons, NativeBridge "quit", UpdateChecker relaunch.
    /// Cmd+Q from the dashboard window goes through `applicationShouldTerminate` and is downgraded
    /// to a window-close so the menu bar item stays alive.
    static func requestQuit() {
        userInitiatedQuit = true
        NSApp.terminate(nil)
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if Self.userInitiatedQuit { return .terminateNow }
        // Switch to accessory BEFORE closing the window so the Dock icon drops
        // immediately; otherwise AppKit delays the update until focus changes.
        NSApp.setActivationPolicy(.accessory)
        DashboardWindowController.shared.closeWindow()
        // Hide after the close animation completes (next runloop).
        DispatchQueue.main.async { NSApp.hide(nil) }
        return .terminateCancel
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusBarController = StatusBarController(
            viewModel: viewModel,
            serverManager: serverManager,
            launchAtLoginManager: launchAtLoginManager,
            desktopPetController: desktopPetController
        )

        // Bring the desktop pet back if it was showing when the app last quit.
        desktopPetController.restoreIfNeeded()

        NativeBridge.shared.configure(
            viewModel: viewModel,
            launchAtLoginManager: launchAtLoginManager
        )
        registerWakeCatchUpObservers()

        Task { @MainActor in
            await serverManager.ensureServerRunning()
            let serverHealthy = await APIClient.shared.checkServerHealth()
            let isOnline = serverManager.isServerRunning || serverHealthy
            if isOnline {
                await viewModel.syncThenLoad()
            }
            viewModel.startAutoRefresh()

            UpdateChecker.shared.check(silent: true)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        NSWorkspace.shared.notificationCenter.removeObserver(self)
        serverManager.stopServer()
    }

    private func registerWakeCatchUpObservers() {
        let notificationCenter = NSWorkspace.shared.notificationCenter
        notificationCenter.addObserver(
            self,
            selector: #selector(scheduleWakeCatchUp(_:)),
            name: NSWorkspace.didWakeNotification,
            object: nil
        )
        notificationCenter.addObserver(
            self,
            selector: #selector(scheduleWakeCatchUp(_:)),
            name: NSWorkspace.sessionDidBecomeActiveNotification,
            object: nil
        )
    }

    @objc private func scheduleWakeCatchUp(_ notification: Notification) {
        let now = Date()
        if let lastWakeCatchUpAttemptAt,
           now.timeIntervalSince(lastWakeCatchUpAttemptAt) < Self.wakeCatchUpDebounceInterval {
            return
        }
        lastWakeCatchUpAttemptAt = now

        Task { @MainActor in
            await serverManager.ensureServerRunning()
            await viewModel.catchUpAfterWakeOrSessionActive(now: now)
        }
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
            } else if url.host == "open" || url.host == "dashboard" {
                // The web app's local-only pages (Limits / Skills on
                // tokentracker.cc) deep-link here via tokentracker://open to
                // surface the local dashboard window.
                DashboardWindowController.shared.showWindow()
            }
        }
    }
}
