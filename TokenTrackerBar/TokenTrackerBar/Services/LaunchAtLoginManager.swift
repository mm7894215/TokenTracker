import Foundation
import ServiceManagement

@MainActor
final class LaunchAtLoginManager: ObservableObject {

    @Published var isEnabled: Bool = false

    /// Whether the current macOS version supports SMAppService (macOS 13+).
    /// When false, the "Launch at Login" UI should be hidden entirely.
    var isSupported: Bool {
        if #available(macOS 13, *) { return true }
        return false
    }

    private static let didAutoEnableKey = "LaunchAtLoginAutoEnabled"

    init() {
        guard #available(macOS 13, *) else { return }

        isEnabled = SMAppService.mainApp.status == .enabled

        // Auto-enable on first launch
        if !UserDefaults.standard.bool(forKey: Self.didAutoEnableKey) {
            UserDefaults.standard.set(true, forKey: Self.didAutoEnableKey)
            if !isEnabled {
                try? SMAppService.mainApp.register()
                isEnabled = SMAppService.mainApp.status == .enabled
            }
        }
    }

    func toggle() {
        guard #available(macOS 13, *) else { return }

        do {
            if isEnabled {
                try SMAppService.mainApp.unregister()
            } else {
                try SMAppService.mainApp.register()
            }
        } catch {
            // Registration failed — revert the UI state
        }
        isEnabled = SMAppService.mainApp.status == .enabled
    }

    /// Re-read the SMAppService status. Useful when an external code path
    /// (e.g. NativeBridge) toggles registration directly.
    func refresh() {
        guard #available(macOS 13, *) else { return }
        isEnabled = SMAppService.mainApp.status == .enabled
    }
}
