import AppKit
import ServiceManagement
import WebKit
import WidgetKit

extension Notification.Name {
    /// Posted whenever native UI settings or locale change via the bridge.
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
                if name == "saveImageToDownloads" {
                    saveImageToDownloads(payload: dict)
                } else if name == "copyImageToClipboard" {
                    copyImageToClipboard(payload: dict)
                } else if name == "openURL", let urlStr = dict["value"] as? String,
                          let url = URL(string: urlStr) {
                    NSWorkspace.shared.open(url)
                } else {
                    runAction(name)
                }
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
            "locale": NativeLocalization.currentPreference,
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
        case "locale":
            LocalizationObserver.shared.storePreference(value)
            NotificationCenter.default.post(name: .nativeSettingsChanged, object: nil)
            WidgetCenter.shared.reloadAllTimelines()
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
                alert.messageText = Strings.addWidgetsTitle
                alert.informativeText = Strings.addWidgetsMessage
                alert.alertStyle = .informational
                alert.addButton(withTitle: Strings.gotItButton)
                alert.runModal()
            }
        case "quit":
            NSApp.terminate(nil)
        default:
            break
        }
    }

    // MARK: - Clipboard image copy

    private func copyImageToClipboard(payload: [String: Any]) {
        let requestId = (payload["requestId"] as? String) ?? ""
        guard let dataUrl = payload["dataUrl"] as? String else {
            postCopyImageResult(requestId: requestId, ok: false, error: "missing dataUrl")
            return
        }
        guard let commaIdx = dataUrl.firstIndex(of: ",") else {
            postCopyImageResult(requestId: requestId, ok: false, error: "invalid data URL")
            return
        }
        let base64 = String(dataUrl[dataUrl.index(after: commaIdx)...])
        guard let imageData = Data(base64Encoded: base64, options: .ignoreUnknownCharacters),
              let image = NSImage(data: imageData) else {
            postCopyImageResult(requestId: requestId, ok: false, error: "decode failed")
            return
        }
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.writeObjects([image])
        postCopyImageResult(requestId: requestId, ok: true, error: nil)
    }

    private func postCopyImageResult(requestId: String, ok: Bool, error: String?) {
        var detail: [String: Any] = [
            "requestId": requestId,
            "ok": ok,
        ]
        if let error { detail["error"] = error }
        guard
            let data = try? JSONSerialization.data(withJSONObject: detail, options: []),
            let json = String(data: data, encoding: .utf8)
        else { return }
        let js = "window.dispatchEvent(new CustomEvent('native:copyImageResult', { detail: \(json) }));"
        webView?.evaluateJavaScript(js, completionHandler: nil)
    }

    // MARK: - Image saving

    private func saveImageToDownloads(payload: [String: Any]) {
        let requestId = (payload["requestId"] as? String) ?? ""
        guard let dataUrl = payload["dataUrl"] as? String else {
            postSaveImageResult(requestId: requestId, ok: false, path: nil, error: "missing dataUrl")
            return
        }
        let rawName = (payload["filename"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            ?? "tokentracker-share-\(Int(Date().timeIntervalSince1970)).png"
        let filename = sanitizeFilename(rawName)

        guard let commaIdx = dataUrl.firstIndex(of: ",") else {
            postSaveImageResult(requestId: requestId, ok: false, path: nil, error: "invalid data URL")
            return
        }
        let base64 = String(dataUrl[dataUrl.index(after: commaIdx)...])
        guard let imageData = Data(base64Encoded: base64, options: .ignoreUnknownCharacters) else {
            postSaveImageResult(requestId: requestId, ok: false, path: nil, error: "base64 decode failed")
            return
        }

        let downloadsDir: URL
        do {
            downloadsDir = try FileManager.default.url(
                for: .downloadsDirectory,
                in: .userDomainMask,
                appropriateFor: nil,
                create: true
            )
        } catch {
            postSaveImageResult(requestId: requestId, ok: false, path: nil, error: error.localizedDescription)
            return
        }

        let target = uniqueFileURL(base: downloadsDir.appendingPathComponent(filename))
        do {
            try imageData.write(to: target, options: .atomic)
        } catch {
            postSaveImageResult(requestId: requestId, ok: false, path: nil, error: error.localizedDescription)
            return
        }

        NSWorkspace.shared.activateFileViewerSelecting([target])
        postSaveImageResult(requestId: requestId, ok: true, path: target.path, error: nil)
    }

    private func sanitizeFilename(_ raw: String) -> String {
        let invalidChars = CharacterSet(charactersIn: "/\\:*?\"<>|")
        let cleaned = raw.components(separatedBy: invalidChars).joined()
        let trimmed = cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "tokentracker-share.png" : trimmed
    }

    private func uniqueFileURL(base: URL) -> URL {
        var candidate = base
        var index = 1
        let fileManager = FileManager.default
        let directory = base.deletingLastPathComponent()
        let stem = base.deletingPathExtension().lastPathComponent
        let ext = base.pathExtension
        while fileManager.fileExists(atPath: candidate.path) {
            let nextName = ext.isEmpty ? "\(stem)-\(index)" : "\(stem)-\(index).\(ext)"
            candidate = directory.appendingPathComponent(nextName)
            index += 1
        }
        return candidate
    }

    private func postSaveImageResult(requestId: String, ok: Bool, path: String?, error: String?) {
        var detail: [String: Any] = [
            "requestId": requestId,
            "ok": ok,
        ]
        if let path { detail["path"] = path }
        if let error { detail["error"] = error }
        guard
            let data = try? JSONSerialization.data(withJSONObject: detail, options: []),
            let json = String(data: data, encoding: .utf8)
        else { return }
        let js = "window.dispatchEvent(new CustomEvent('native:saveImageResult', { detail: \(json) }));"
        webView?.evaluateJavaScript(js, completionHandler: nil)
    }
}
