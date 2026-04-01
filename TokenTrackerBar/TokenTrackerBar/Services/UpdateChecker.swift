import AppKit
import Foundation

@MainActor
final class UpdateChecker {

    static let shared = UpdateChecker()

    private let repo = "mm7894215/TokenTracker"
    private let releaseURL: String = "https://github.com/mm7894215/TokenTracker/releases/latest"

    /// Observable status for menu item display
    private(set) var statusText: String? = nil
    private(set) var isBusy = false

    /// Download progress tracking
    private var progressTimer: Timer?

    /// Cached app icon for alerts (capture before activationPolicy changes)
    private lazy var appIcon: NSImage? = NSApp.applicationIconImage

    // MARK: - Public

    func check(silent: Bool = false) {
        guard !isBusy else { return }
        isBusy = true
        statusText = "Checking for updates..."

        Task.detached { [self] in
            let result: Result<GitHubRelease, Error>
            do {
                result = .success(try await self.fetchLatestRelease())
            } catch {
                result = .failure(error)
            }

            await MainActor.run {
                self.handleResult(result, silent: silent)
            }
        }
    }

    // MARK: - GitHub API (URLSession — respects system proxy)

    private struct GitHubRelease: Decodable {
        let tag_name: String
        let name: String?
        let body: String?
        let html_url: String
        let assets: [Asset]

        struct Asset: Decodable {
            let name: String
            let browser_download_url: String
            let size: Int
        }

        var tagVersion: String {
            tag_name.hasPrefix("v") ? String(tag_name.dropFirst()) : tag_name
        }

        var dmgAsset: Asset? {
            let isArm64: Bool = {
                var sysinfo = utsname()
                uname(&sysinfo)
                let machine = withUnsafePointer(to: &sysinfo.machine) {
                    $0.withMemoryRebound(to: CChar.self, capacity: 1) { String(cString: $0) }
                }
                return machine == "arm64"
            }()
            let suffix = isArm64 ? "arm64.dmg" : "x64.dmg"
            // Prefer arch-specific DMG, fall back to any .dmg
            return assets.first { $0.name.hasSuffix(suffix) }
                ?? assets.first { $0.name.hasSuffix(".dmg") }
        }
    }

    nonisolated private func fetchLatestRelease() async throws -> GitHubRelease {
        let urlString = "https://api.github.com/repos/\(repo)/releases/latest"
        guard let url = URL(string: urlString) else { throw UpdateError.emptyResponse }

        var request = URLRequest(url: url, timeoutInterval: 15)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw UpdateError.curlFailed((response as? HTTPURLResponse)?.statusCode ?? -1)
        }
        guard !data.isEmpty else { throw UpdateError.emptyResponse }
        return try JSONDecoder().decode(GitHubRelease.self, from: data)
    }

    // MARK: - Result Handling

    private func handleResult(_ result: Result<GitHubRelease, Error>, silent: Bool) {
        switch result {
        case .success(let release):
            let current = currentVersion()
            if compareVersions(current, release.tagVersion) == .orderedAscending {
                promptUpdate(release: release, currentVersion: current)
            } else {
                finishUpdate()
                if !silent {
                    showAlert(title: "You're Up to Date", message: "Version \(current) is the latest version.", style: .informational)
                }
            }
        case .failure(let error):
            finishUpdate()
            if !silent {
                showAlert(
                    title: "Update Check Failed",
                    message: "\(error.localizedDescription)\n\nYou can also check manually:",
                    style: .warning,
                    showReleasePage: true
                )
            }
        }
    }

    private func finishUpdate() {
        isBusy = false
        statusText = nil
    }

    // MARK: - Version

    func currentVersion() -> String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
    }

    private func compareVersions(_ a: String, _ b: String) -> ComparisonResult {
        let pa = a.split(separator: ".").compactMap { Int($0) }
        let pb = b.split(separator: ".").compactMap { Int($0) }
        let count = max(pa.count, pb.count)
        for i in 0..<count {
            let va = i < pa.count ? pa[i] : 0
            let vb = i < pb.count ? pb[i] : 0
            if va < vb { return .orderedAscending }
            if va > vb { return .orderedDescending }
        }
        return .orderedSame
    }

    // MARK: - UI

    private func promptUpdate(release: GitHubRelease, currentVersion: String) {
        isBusy = false
        statusText = nil

        let alert = NSAlert()
        alert.messageText = "New Version Available — \(release.tagVersion)"
        alert.informativeText = buildUpdateMessage(release: release, currentVersion: currentVersion)
        alert.alertStyle = .informational
        alert.icon = appIcon
        alert.addButton(withTitle: release.dmgAsset != nil ? "Download & Install" : "View on GitHub")
        alert.addButton(withTitle: "Later")

        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        let response = alert.runModal()
        NSApp.setActivationPolicy(.accessory)

        if response == .alertFirstButtonReturn {
            if let dmg = release.dmgAsset {
                startDownloadAndInstall(dmg)
            } else if let url = URL(string: release.html_url) {
                NSWorkspace.shared.open(url)
            }
        }
    }

    private func buildUpdateMessage(release: GitHubRelease, currentVersion: String) -> String {
        var lines = ["Current: \(currentVersion) → \(release.tagVersion)"]
        if let body = release.body, !body.isEmpty {
            lines.append("\nRelease Notes:\n\(body.prefix(300))")
            if body.count > 300 { lines.append("…") }
        }
        if let dmg = release.dmgAsset {
            lines.append("\nSize: \(String(format: "%.1f", Double(dmg.size) / 1_048_576)) MB")
        }
        return lines.joined()
    }

    // MARK: - Download + Install (URLSession for proxy support)

    private func startDownloadAndInstall(_ asset: GitHubRelease.Asset) {
        isBusy = true
        let totalSize = Int64(asset.size)
        let totalMB = Double(totalSize) / 1_048_576
        statusText = "Downloading 0%..."

        let downloadsDir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        let destPath = downloadsDir.appendingPathComponent(asset.name).path

        // Start polling file size for progress
        progressTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                let attrs = try? FileManager.default.attributesOfItem(atPath: destPath)
                let received = (attrs?[.size] as? Int64) ?? 0
                if totalSize > 0 {
                    let pct = min(Int(Double(received) / Double(totalSize) * 100), 99)
                    let receivedMB = Double(received) / 1_048_576
                    self.statusText = "Downloading \(pct)% (\(String(format: "%.0f", receivedMB))/\(String(format: "%.0f", totalMB)) MB)"
                }
            }
        }

        Task.detached { [self] in
            let result: Result<URL, Error>
            do {
                result = .success(try await self.downloadViaURLSession(from: asset.browser_download_url, fileName: asset.name))
            } catch {
                result = .failure(error)
            }

            await MainActor.run {
                self.progressTimer?.invalidate()
                self.progressTimer = nil

                switch result {
                case .success(let dmgURL):
                    self.statusText = "Installing..."
                    self.performInstallAsync(dmgURL)
                case .failure(let error):
                    self.finishUpdate()
                    self.showAlert(
                        title: "Download Failed",
                        message: "\(error.localizedDescription)\n\nYou can download manually from the Releases page.",
                        style: .warning,
                        showReleasePage: true
                    )
                }
            }
        }
    }

    nonisolated private func downloadViaURLSession(from urlString: String, fileName: String) async throws -> URL {
        guard let url = URL(string: urlString) else { throw UpdateError.downloadFailed }

        let downloadsDir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        let destURL = downloadsDir.appendingPathComponent(fileName)

        if FileManager.default.fileExists(atPath: destURL.path) {
            try FileManager.default.removeItem(at: destURL)
        }

        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 60
        config.timeoutIntervalForResource = 900
        let session = URLSession(configuration: config)

        let (tempURL, response) = try await session.download(from: url)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw UpdateError.downloadFailed
        }

        try FileManager.default.moveItem(at: tempURL, to: destURL)
        return destURL
    }

    private func performInstallAsync(_ dmgURL: URL) {
        let dmgPath = dmgURL.path
        Task.detached { [self] in
            let result: Result<URL, Error>
            do {
                result = .success(try self.mountCopyRelaunch(dmgPath: dmgPath))
            } catch {
                result = .failure(error)
            }

            await MainActor.run {
                switch result {
                case .success(let appURL):
                    self.statusText = "Restarting..."
                    self.relaunch(appURL: appURL)
                case .failure(let error):
                    self.finishUpdate()
                    if FileManager.default.fileExists(atPath: dmgPath) {
                        NSWorkspace.shared.open(dmgURL)
                    }
                    self.showAlert(
                        title: "Installation Failed",
                        message: "\(error.localizedDescription)\n\nPlease drag TokenTrackerBar into Applications manually.",
                        style: .warning
                    )
                }
            }
        }
    }

    // MARK: - Install Logic

    nonisolated private func mountCopyRelaunch(dmgPath: String) throws -> URL {
        // 1. Mount
        let mount = Process()
        mount.executableURL = URL(fileURLWithPath: "/usr/bin/hdiutil")
        mount.arguments = ["attach", dmgPath, "-nobrowse", "-mountrandom", "/tmp"]
        let mountPipe = Pipe()
        mount.standardOutput = mountPipe
        mount.standardError = Pipe()
        try mount.run()
        mount.waitUntilExit()
        guard mount.terminationStatus == 0 else { throw UpdateError.installFailed("Failed to mount DMG") }

        let mountOutput = String(data: mountPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let mountPoint = mountOutput.split(separator: "\n").last?.split(separator: "\t").last?.trimmingCharacters(in: .whitespaces) ?? ""
        guard !mountPoint.isEmpty, FileManager.default.fileExists(atPath: mountPoint) else {
            throw UpdateError.installFailed("Mount point not found")
        }

        defer {
            let detach = Process()
            detach.executableURL = URL(fileURLWithPath: "/usr/bin/hdiutil")
            detach.arguments = ["detach", mountPoint, "-quiet", "-force"]
            detach.standardOutput = Pipe()
            detach.standardError = Pipe()
            try? detach.run()
            detach.waitUntilExit()
        }

        // 2. Find .app
        let fm = FileManager.default
        let contents = try fm.contentsOfDirectory(atPath: mountPoint)
        guard let appName = contents.first(where: { $0.hasSuffix(".app") }) else {
            throw UpdateError.installFailed("No .app found in DMG")
        }

        let sourceApp = URL(fileURLWithPath: mountPoint).appendingPathComponent(appName)
        let destApp = URL(fileURLWithPath: "/Applications").appendingPathComponent(appName)

        // 3. Replace
        if fm.fileExists(atPath: destApp.path) { try fm.removeItem(at: destApp) }
        try fm.copyItem(at: sourceApp, to: destApp)

        // 4. Cleanup DMG
        try? fm.removeItem(atPath: dmgPath)

        return destApp
    }

    private func relaunch(appURL: URL) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        process.arguments = ["-n", appURL.path]
        process.standardOutput = Pipe()
        process.standardError = Pipe()
        do {
            try process.run()
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { NSApp.terminate(nil) }
        } catch {
            finishUpdate()
            showAlert(title: "Update Complete", message: "New version installed to /Applications. Please restart manually.", style: .informational)
        }
    }

    // MARK: - Helpers

    private func showAlert(title: String, message: String, style: NSAlert.Style, showReleasePage: Bool = false) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = style
        alert.icon = appIcon
        if showReleasePage {
            alert.addButton(withTitle: "Open Releases Page")
            alert.addButton(withTitle: "OK")
        } else {
            alert.addButton(withTitle: "OK")
        }
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        let response = alert.runModal()
        NSApp.setActivationPolicy(.accessory)

        if showReleasePage && response == .alertFirstButtonReturn {
            if let url = URL(string: releaseURL) {
                NSWorkspace.shared.open(url)
            }
        }
    }

    private enum UpdateError: LocalizedError {
        case curlFailed(Int)
        case emptyResponse
        case downloadFailed
        case installFailed(String)
        case noRelease

        var errorDescription: String? {
            switch self {
            case .curlFailed(let code): return "Network request failed (HTTP \(code)). Check your connection or proxy settings."
            case .emptyResponse: return "Server returned an empty response."
            case .downloadFailed: return "File download failed. This may be a network issue."
            case .installFailed(let reason): return "Installation failed: \(reason)"
            case .noRelease: return "No release available."
            }
        }
    }
}
