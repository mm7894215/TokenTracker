import AppKit
import Foundation

@MainActor
final class UpdateChecker {

    static let shared = UpdateChecker()

    private let repo = "mm7894215/TokenTracker"
    private let releaseURL: String = "https://github.com/mm7894215/TokenTracker/releases/latest"

    /// Observable status for menu item display
    private(set) var statusText: String? = nil {
        didSet { postStatusDidChangeNotification() }
    }

    private(set) var isBusy = false {
        didSet { postStatusDidChangeNotification() }
    }

    /// Retain delegate until download completes (URLSession holds weak ref only)
    private var activeDownloadDelegate: DownloadProgressDelegate?

    /// Cached app icon for alerts (capture before activationPolicy changes)
    private lazy var appIcon: NSImage? = NSApp.applicationIconImage

    private func postStatusDidChangeNotification() {
        NotificationCenter.default.post(name: .updateCheckerStatusDidChange, object: self)
    }

    // MARK: - Public

    func check(silent: Bool = false) {
        guard !isBusy else { return }
        isBusy = true
        statusText = Strings.updateChecking

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
                if silent, let dmg = release.dmgAsset {
                    // Loop guard: if we just silently installed this exact release but
                    // the app still reports itself as older, the downloaded DMG's
                    // Info.plist is out of sync with the git tag (issue #34 / 0.5.77).
                    // Reinstalling would copy the same broken DMG on every relaunch
                    // forever — skip instead and surface the problem via statusText.
                    if isRecentlyInstalled(release.tagVersion) {
                        finishUpdate()
                        statusText = Strings.updateSkipped(target: release.tagVersion, current: current)
                        Swift.print("[UpdateChecker] Silent install loop averted: target=\(release.tagVersion), current=\(current)")
                        return
                    }
                    // Silent auto-update: download and install without prompting
                    startDownloadAndInstall(dmg, targetVersion: release.tagVersion)
                } else {
                    promptUpdate(release: release, currentVersion: current)
                }
            } else {
                finishUpdate()
                if !silent {
                    showAlert(title: Strings.upToDateTitle, message: Strings.upToDateMessage(current), style: .informational)
                }
            }
        case .failure(let error):
            finishUpdate()
            if !silent {
                showAlert(
                    title: Strings.updateCheckFailedTitle,
                    message: "\(error.localizedDescription)\n\n\(Strings.manualCheckHint)",
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

    // MARK: - Loop Protection

    /// Persisted identity of the most recent DMG that `mountCopyRelaunch` finished
    /// copying into `/Applications`. The silent `check()` path consults this to
    /// detect an install loop: if the tag it just fetched matches what we freshly
    /// installed *and* the app still reports an older `CFBundleShortVersionString`,
    /// the DMG's Info.plist MARKETING_VERSION is out of sync with the git tag
    /// (root cause of issue #34 / 0.5.77) and reinstalling would loop forever.
    private static let lastInstalledVersionKey = "UpdateChecker.lastInstalledVersion"
    private static let lastInstalledAtKey = "UpdateChecker.lastInstalledAt"

    /// How long after a successful install we treat "please install the same
    /// version again" as a loop rather than a legitimate reinstall request.
    /// Long enough to survive the next launch's silent check, short enough that
    /// a deliberate reinstall hours later still goes through.
    private let loopGuardWindow: TimeInterval = 10 * 60

    private func recordInstalledVersion(_ version: String) {
        let d = UserDefaults.standard
        d.set(version, forKey: Self.lastInstalledVersionKey)
        d.set(Date().timeIntervalSince1970, forKey: Self.lastInstalledAtKey)
    }

    private func isRecentlyInstalled(_ version: String) -> Bool {
        let d = UserDefaults.standard
        guard let last = d.string(forKey: Self.lastInstalledVersionKey), last == version else {
            return false
        }
        let at = d.double(forKey: Self.lastInstalledAtKey)
        guard at > 0 else { return false }
        return (Date().timeIntervalSince1970 - at) < loopGuardWindow
    }

    // MARK: - UI

    private func promptUpdate(release: GitHubRelease, currentVersion: String) {
        isBusy = false
        statusText = nil

        let alert = NSAlert()
        alert.messageText = Strings.newVersionTitle(release.tagVersion)
        alert.informativeText = buildUpdateMessage(release: release, currentVersion: currentVersion)
        alert.alertStyle = .informational
        alert.icon = appIcon
        alert.addButton(withTitle: release.dmgAsset != nil ? Strings.downloadInstallButton : Strings.viewOnGitHubButton)
        alert.addButton(withTitle: Strings.laterButton)

        presentAlert(alert) { response in
            if response == .alertFirstButtonReturn {
                if let dmg = release.dmgAsset {
                    self.startDownloadAndInstall(dmg, targetVersion: release.tagVersion)
                } else if let url = URL(string: release.html_url) {
                    NSWorkspace.shared.open(url)
                }
            }
        }
    }

    private func buildUpdateMessage(release: GitHubRelease, currentVersion: String) -> String {
        var lines = [Strings.updateCurrentLine(current: currentVersion, target: release.tagVersion)]
        if let body = release.body, !body.isEmpty {
            lines.append("\n\(Strings.releaseNotesTitle)\n\(body.prefix(300))")
            if body.count > 300 { lines.append("…") }
        }
        if let dmg = release.dmgAsset {
            lines.append("\n\(Strings.updateSize(String(format: "%.1f", Double(dmg.size) / 1_048_576)))")
        }
        return lines.joined()
    }

    // MARK: - Download + Install (URLSession for proxy support)

    private func startDownloadAndInstall(_ asset: GitHubRelease.Asset, targetVersion: String) {
        isBusy = true
        let totalSize = Int64(asset.size)
        let totalMB = Double(totalSize) / 1_048_576
        statusText = Strings.downloadingPercent(0)

        // Download into the app's own data directory rather than ~/Downloads/.
        // Downloads is TCC-protected on macOS, so writing there triggers a
        // "TokenTrackerBar wants to access files in your Downloads folder"
        // prompt every time silent auto-update fires — particularly noisy
        // for ad-hoc-signed builds where TCC grants don't persist across
        // re-installs. Application Support is owned by the user and not
        // gated by TCC, so the silent updater stays silent.
        let supportDir = (try? FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        ))?.appendingPathComponent("TokenTrackerBar/updates", isDirectory: true)
            ?? FileManager.default.temporaryDirectory
        if !FileManager.default.fileExists(atPath: supportDir.path) {
            try? FileManager.default.createDirectory(at: supportDir, withIntermediateDirectories: true)
        }
        let destURL = supportDir.appendingPathComponent(asset.name)

        if FileManager.default.fileExists(atPath: destURL.path) {
            try? FileManager.default.removeItem(at: destURL)
        }

        guard let url = URL(string: asset.browser_download_url) else {
            finishUpdate()
            showAlert(
                title: Strings.downloadFailedTitle,
                message: Strings.invalidDownloadURL,
                style: .warning,
                showReleasePage: true
            )
            return
        }

        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 60
        config.timeoutIntervalForResource = 900

        let delegate = DownloadProgressDelegate(
            destURL: destURL,
            onProgress: { [weak self] received, expected in
                guard let self else { return }
                let denom = expected > 0 ? expected : totalSize
                guard denom > 0 else {
                    self.statusText = Strings.downloadingUnknown
                    return
                }
                let pct = min(Int(Double(received) / Double(denom) * 100), 99)
                let receivedMB = Double(received) / 1_048_576
                self.statusText = Strings.downloadingProgress(
                    pct: pct,
                    receivedMB: String(format: "%.0f", receivedMB),
                    totalMB: String(format: "%.0f", totalMB)
                )
            },
            onComplete: { [weak self] result in
                guard let self else { return }
                self.activeDownloadDelegate = nil
                switch result {
                case .success(let dmgURL):
                    self.statusText = Strings.installing
                    self.performInstallAsync(dmgURL, targetVersion: targetVersion)
                case .failure(let error):
                    self.finishUpdate()
                    self.showAlert(
                        title: Strings.downloadFailedTitle,
                        message: "\(error.localizedDescription)\n\n\(Strings.manualDownloadHint)",
                        style: .warning,
                        showReleasePage: true
                    )
                }
            }
        )
        activeDownloadDelegate = delegate

        let session = URLSession(configuration: config, delegate: delegate, delegateQueue: OperationQueue.main)
        delegate.startDownload(session: session, url: url)
    }

    private func performInstallAsync(_ dmgURL: URL, targetVersion: String) {
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
                    self.recordInstalledVersion(targetVersion)
                    self.statusText = Strings.restarting
                    self.relaunch(appURL: appURL)
                case .failure(let error):
                    self.finishUpdate()
                    if FileManager.default.fileExists(atPath: dmgPath) {
                        NSWorkspace.shared.open(dmgURL)
                    }
                    self.showAlert(
                        title: Strings.installationFailedTitle,
                        message: "\(error.localizedDescription)\n\n\(Strings.manualInstallHint)",
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
            showAlert(title: Strings.updateCompleteTitle, message: Strings.updateCompleteMessage, style: .informational)
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
            alert.addButton(withTitle: Strings.openReleasesPageButton)
            alert.addButton(withTitle: Strings.okButton)
        } else {
            alert.addButton(withTitle: Strings.okButton)
        }
        presentAlert(alert) { response in
            if showReleasePage && response == .alertFirstButtonReturn {
                if let url = URL(string: self.releaseURL) {
                    NSWorkspace.shared.open(url)
                }
            }
        }
    }

    /// 更新提示必须压过菜单栏 Popover（NSPanel）和仪表盘；仅用 sheet 仍可能被 Popover 挡住，故统一 `runModal` 并把模态窗提到高层级。
    private func presentAlert(_ alert: NSAlert, completion: @escaping (NSApplication.ModalResponse) -> Void) {
        NSApp.setActivationPolicy(.regular)
        StatusBarController.prepareForSystemAlert()
        NSRunningApplication.current.activate(options: [.activateIgnoringOtherApps, .activateAllWindows])
        NSApp.activate(ignoringOtherApps: true)
        NSApp.unhide(nil)

        if let dash = DashboardWindowController.shared.windowForSheet {
            dash.makeKeyAndOrderFront(nil)
        }

        var bumpTimer: Timer?
        let bumpAttempts = BumpAttempts()
        bumpTimer = Timer(timeInterval: 0.02, repeats: true) { t in
            bumpAttempts.count += 1
            if bumpAttempts.count > 250 {
                t.invalidate()
                return
            }
            guard let modal = NSApp.modalWindow else { return }
            modal.level = .popUpMenu
            modal.orderFrontRegardless()
            t.invalidate()
        }
        if let timer = bumpTimer {
            RunLoop.current.add(timer, forMode: .common)
            RunLoop.current.add(timer, forMode: .modalPanel)
        }

        let response = alert.runModal()
        bumpTimer?.invalidate()
        NSApp.setActivationPolicy(.accessory)
        completion(response)
    }

    private final class BumpAttempts {
        var count = 0
    }

    /// Uses `URLSessionDownloadDelegate` so progress reflects bytes written to the temp file.
    /// The previous implementation polled the final destination path, but `URLSession.download`
    /// only writes there after completion, so the percentage stayed at 0%.
    private final class DownloadProgressDelegate: NSObject, URLSessionDownloadDelegate {
        private let destURL: URL
        private let onProgress: (Int64, Int64) -> Void
        private let onComplete: (Result<URL, Error>) -> Void
        private var session: URLSession?
        private var completionCalled = false

        init(
            destURL: URL,
            onProgress: @escaping (Int64, Int64) -> Void,
            onComplete: @escaping (Result<URL, Error>) -> Void
        ) {
            self.destURL = destURL
            self.onProgress = onProgress
            self.onComplete = onComplete
        }

        func startDownload(session: URLSession, url: URL) {
            self.session = session
            session.downloadTask(with: url).resume()
        }

        func urlSession(
            _ session: URLSession,
            downloadTask: URLSessionDownloadTask,
            didWriteData bytesWritten: Int64,
            totalBytesWritten: Int64,
            totalBytesExpectedToWrite: Int64
        ) {
            onProgress(totalBytesWritten, totalBytesExpectedToWrite)
        }

        func urlSession(
            _ session: URLSession,
            downloadTask: URLSessionDownloadTask,
            didFinishDownloadingTo location: URL
        ) {
            guard let http = downloadTask.response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                completeOnce(.failure(UpdateError.downloadFailed))
                return
            }
            do {
                if FileManager.default.fileExists(atPath: destURL.path) {
                    try FileManager.default.removeItem(at: destURL)
                }
                try FileManager.default.moveItem(at: location, to: destURL)
                completeOnce(.success(destURL))
            } catch {
                completeOnce(.failure(error))
            }
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            if let error {
                if !completionCalled {
                    completeOnce(.failure(error))
                }
            }
        }

        private func completeOnce(_ result: Result<URL, Error>) {
            guard !completionCalled else { return }
            completionCalled = true
            session?.finishTasksAndInvalidate()
            session = nil
            onComplete(result)
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
            case .curlFailed(let code): return Strings.networkRequestFailed(code: code)
            case .emptyResponse: return Strings.emptyServerResponse
            case .downloadFailed: return Strings.fileDownloadFailed
            case .installFailed(let reason): return Strings.installFailed(reason)
            case .noRelease: return Strings.noReleaseAvailable
            }
        }
    }
}

extension Notification.Name {
    /// Posted when `UpdateChecker.shared.statusText` or `isBusy` changes (menu bar can refresh without polling).
    static let updateCheckerStatusDidChange = Notification.Name("UpdateCheckerStatusDidChange")
}
