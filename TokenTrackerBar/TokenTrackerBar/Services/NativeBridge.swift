import AppKit
import ServiceManagement
import WebKit

extension Notification.Name {
    /// Posted whenever a menu-bar setting (showStats / animatedIcon) changes via the bridge.
    /// StatusBarController listens to refresh its display.
    static let nativeSettingsChanged = Notification.Name("NativeSettingsChanged")
}

/// Bridges menu-bar app preferences and actions to the embedded dashboard WebView.
///
/// The dashboard SettingsPage posts JSON messages via `window.webkit.messageHandlers.nativeBridge.postMessage(...)`.
/// We dispatch `getSettings` / `setSetting` / `action` and push current state back to JS by
/// firing a `native:settings` CustomEvent on the page's window.
@MainActor
final class NativeBridge {

    static let shared = NativeBridge()

    weak var webView: WKWebView?
    private weak var viewModel: DashboardViewModel?
    private weak var launchAtLoginManager: LaunchAtLoginManager?

    private init() {}

    func configure(viewModel: DashboardViewModel, launchAtLoginManager: LaunchAtLoginManager) {
        self.viewModel = viewModel
        self.launchAtLoginManager = launchAtLoginManager
    }

    // MARK: - Message dispatch

    func handle(message: Any) {
        guard let dict = message as? [String: Any],
              let type = dict["type"] as? String else { return }

        switch type {
        case "getSettings":
            pushSettings()
        case "getSystemAppearance":
            DashboardWindowController.shared.pushCurrentSystemAppearanceToWeb()
        case "setChromeAppearance":
            if let theme = dict["theme"] as? String {
                let isDark = dict["isDark"] as? Bool ?? false
                DashboardWindowController.shared.applyChromeAppearance(theme: theme, resolvedIsDark: isDark)
            } else if let isDark = dict["isDark"] as? Bool {
                DashboardWindowController.shared.applyChromeAppearance(theme: isDark ? "dark" : "light", resolvedIsDark: isDark)
            }
        case "setSetting":
            if let key = dict["key"] as? String {
                applySetting(key: key, value: dict["value"])
            }
        case "action":
            if let name = dict["name"] as? String {
                runAction(name)
            }
        default:
            break
        }
    }

    // MARK: - State push

    func pushSettings() {
        let launchAtLoginValue: Bool
        let launchAtLoginSupported: Bool
        if #available(macOS 13, *) {
            launchAtLoginValue = SMAppService.mainApp.status == .enabled
            launchAtLoginSupported = true
        } else {
            launchAtLoginValue = false
            launchAtLoginSupported = false
        }
        let payload: [String: Any] = [
            "showStats": UserDefaults.standard.object(forKey: "MenuBarShowStats") as? Bool ?? true,
            "animatedIcon": UserDefaults.standard.object(forKey: "MenuBarAnimationEnabled") as? Bool ?? true,
            "launchAtLogin": launchAtLoginValue,
            "launchAtLoginSupported": launchAtLoginSupported,
            "version": UpdateChecker.shared.currentVersion(),
            "updateStatus": UpdateChecker.shared.statusText ?? NSNull(),
            "updateBusy": UpdateChecker.shared.isBusy,
            "isSyncing": viewModel?.isSyncing ?? false,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
              let json = String(data: data, encoding: .utf8) else { return }
        let js = "window.dispatchEvent(new CustomEvent('native:settings', { detail: \(json) }));"
        webView?.evaluateJavaScript(js, completionHandler: nil)
    }

    // MARK: - Setters

    private func applySetting(key: String, value: Any?) {
        switch key {
        case "showStats":
            if let bool = value as? Bool {
                UserDefaults.standard.set(bool, forKey: "MenuBarShowStats")
                NotificationCenter.default.post(name: .nativeSettingsChanged, object: nil)
            }
        case "animatedIcon":
            if let bool = value as? Bool {
                UserDefaults.standard.set(bool, forKey: "MenuBarAnimationEnabled")
                NotificationCenter.default.post(name: .nativeSettingsChanged, object: nil)
            }
        case "launchAtLogin":
            if let bool = value as? Bool {
                setLaunchAtLogin(bool)
            }
        default:
            break
        }
        pushSettings()
    }

    private func setLaunchAtLogin(_ enabled: Bool) {
        guard #available(macOS 13, *) else { return }
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            // Registration failed — keep previous state
        }
        // Refresh manager so popover menu reflects the new state
        launchAtLoginManager?.refresh()
    }

    // MARK: - Actions

    private func runAction(_ name: String) {
        switch name {
        case "syncNow":
            if let viewModel {
                Task { await viewModel.triggerSync() }
            }
        case "checkForUpdates":
            UpdateChecker.shared.check(silent: false)
            // UpdateChecker mutates statusText synchronously; push a follow-up snapshot
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
                self?.pushSettings()
            }
        case "openAbout":
            if let url = URL(string: "https://github.com/mm7894215/TokenTracker") {
                NSWorkspace.shared.open(url)
            }
        case "openWidgetGallery":
            // There is no public macOS API to open the Edit Widgets UI
            // directly — neither NSWorkspace URL schemes nor AppKit expose
            // the widget picker. The most honest + reliable response is a
            // native alert that explains the two-step flow (right-click
            // desktop → Edit Widgets → search TokenTracker).
            DispatchQueue.main.async {
                let alert = NSAlert()
                alert.messageText = "Add TokenTracker widgets"
                alert.informativeText = "Right-click an empty area of your desktop, choose \"Edit Widgets\", then search for \"TokenTracker\" in the gallery."
                alert.alertStyle = .informational
                alert.addButton(withTitle: "Got it")
                alert.runModal()
            }
        case "quit":
            NSApp.terminate(nil)
        default:
            break
        }
    }
}
