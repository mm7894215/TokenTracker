import Foundation

/// Watches a TokenTracker state file (queue.jsonl by default) for writes and
/// atomic replacements. Queue writes drive real-time activity; a second
/// instance watches queue.state.json to publish completed account uploads.
@MainActor
final class QueueActivityMonitor {

    /// Fired immediately for latency-sensitive visuals.
    var onActivity: (() -> Void)?
    /// Fired once after a burst of queue writes settles.
    var onSettledActivity: (() -> Void)?

    private var source: DispatchSourceFileSystemObject?
    private var directorySource: DispatchSourceFileSystemObject?
    private var retryTimer: Timer?
    private var settleTask: Task<Void, Never>?
    private var waitingForFile = false
    private var hasArmed = false
    private let queueURL: URL
    private let settleDelayNanoseconds: UInt64
    private let retryDelay: TimeInterval
    private let publishInitialState: Bool

    init(
        queueURL: URL? = nil,
        settleDelay: TimeInterval = 1,
        retryDelay: TimeInterval = 60,
        publishInitialState: Bool = false
    ) {
        self.queueURL = queueURL ?? FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".tokentracker/tracker/queue.jsonl")
        settleDelayNanoseconds = UInt64(max(0, settleDelay) * 1_000_000_000)
        self.retryDelay = max(0, retryDelay)
        self.publishInitialState = publishInitialState
    }

    func start() {
        guard source == nil, directorySource == nil, retryTimer == nil else { return }
        openAndWatch()
    }

    func stop() {
        source?.cancel()
        source = nil
        directorySource?.cancel()
        directorySource = nil
        retryTimer?.invalidate()
        retryTimer = nil
        settleTask?.cancel()
        settleTask = nil
        waitingForFile = false
        hasArmed = false
    }

    private func openAndWatch() {
        let fd = open(queueURL.path, O_EVTONLY)
        guard fd >= 0 else {
            waitingForFile = true
            watchParentDirectoryOrRetry()
            return
        }
        directorySource?.cancel()
        directorySource = nil
        retryTimer?.invalidate()
        retryTimer = nil
        let shouldPublishInitialState =
            waitingForFile || (!hasArmed && publishInitialState)
        waitingForFile = false
        hasArmed = true

        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd,
            eventMask: [.write, .extend, .delete, .rename],
            queue: .main
        )
        source.setEventHandler { [weak self] in
            guard let self, let source = self.source else { return }
            let event = source.data
            if event.contains(.delete) || event.contains(.rename) {
                // sync occasionally rewrites the queue (repairs/migrations);
                // the old fd now points at a dead inode — re-arm on the new file.
                source.cancel()
                self.source = nil
                self.openAndWatch()
            }
            self.noteActivity()
        }
        source.setCancelHandler { close(fd) }
        source.resume()
        self.source = source
        if shouldPublishInitialState {
            noteActivity()
        }
    }

    /// A fresh install may not have created queue.state.json yet. Watching its
    /// parent directory avoids waking the app on a fixed polling cadence while
    /// still reacting immediately when the file is created or atomically moved
    /// into place.
    private func watchParentDirectoryOrRetry() {
        guard directorySource == nil, retryTimer == nil else { return }
        let directoryURL = queueURL.deletingLastPathComponent()
        let fd = open(directoryURL.path, O_EVTONLY)
        guard fd >= 0 else {
            scheduleRetry()
            return
        }

        let directorySource = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd,
            eventMask: [.write, .extend, .attrib, .delete, .rename],
            queue: .main
        )
        directorySource.setEventHandler { [weak self] in
            guard let self, let activeSource = self.directorySource else { return }
            let event = activeSource.data
            if event.contains(.delete) || event.contains(.rename) {
                activeSource.cancel()
                self.directorySource = nil
                self.scheduleRetry()
                return
            }
            self.openAndWatch()
        }
        directorySource.setCancelHandler { close(fd) }
        directorySource.resume()
        self.directorySource = directorySource
    }

    private func noteActivity() {
        onActivity?()
        settleTask?.cancel()
        settleTask = Task { @MainActor [weak self] in
            guard let self else { return }
            try? await Task.sleep(nanoseconds: settleDelayNanoseconds)
            guard !Task.isCancelled else { return }
            settleTask = nil
            onSettledActivity?()
        }
    }

    /// Only used when even the parent directory is absent. Once the directory
    /// exists, filesystem events replace this low-frequency fallback.
    private func scheduleRetry() {
        guard retryTimer == nil else { return }
        retryTimer = Timer.scheduledTimer(withTimeInterval: retryDelay, repeats: false) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.retryTimer = nil
                self.openAndWatch()
            }
        }
    }
}
