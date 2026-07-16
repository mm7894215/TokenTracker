import Foundation

/// Watches `~/.tokentracker/tracker/queue.jsonl` for appends. Every AI CLI turn
/// ends with a hook that appends usage rows to the queue, so a write event is a
/// real-time "the AI just did work" signal — this is what makes the menu bar
/// runner sprint the moment tokens are burned, instead of waiting for the next
/// 300s background refresh.
@MainActor
final class QueueActivityMonitor {

    /// Fired on the main actor whenever the queue file grows or is rewritten.
    var onActivity: (() -> Void)?

    private var source: DispatchSourceFileSystemObject?
    private var retryTimer: Timer?
    private let queueURL: URL

    init(queueURL: URL? = nil) {
        self.queueURL = queueURL ?? FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".tokentracker/tracker/queue.jsonl")
    }

    func start() {
        guard source == nil, retryTimer == nil else { return }
        openAndWatch()
    }

    func stop() {
        source?.cancel()
        source = nil
        retryTimer?.invalidate()
        retryTimer = nil
    }

    private func openAndWatch() {
        let fd = open(queueURL.path, O_EVTONLY)
        guard fd >= 0 else {
            scheduleRetry()
            return
        }

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
                self.stop()
                self.openAndWatch()
            } else {
                self.onActivity?()
            }
        }
        source.setCancelHandler { close(fd) }
        source.resume()
        self.source = source
    }

    /// The queue may not exist yet on a fresh install; keep trying until it does.
    private func scheduleRetry() {
        retryTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: false) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.retryTimer = nil
                self.openAndWatch()
            }
        }
    }
}
