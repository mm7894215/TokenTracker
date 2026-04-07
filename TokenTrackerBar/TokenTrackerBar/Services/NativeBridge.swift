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
        let payload: [String: Any] = [
            "showStats": UserDefaults.standard.object(forKey: "MenuBarShowStats") as? Bool ?? true,
            "animatedIcon": UserDefaults.standard.object(forKey: "MenuBarAnimationEnabled") as? Bool ?? true,
            "launchAtLogin": SMAppService.mainApp.status == .enabled,
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
        case "quit":
            NSApp.terminate(nil)
        default:
            break
        }
    }
}
