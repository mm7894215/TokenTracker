import XCTest

@MainActor
final class QueueActivityMonitorTests: XCTestCase {

    func testAppendPublishesOneSettledActivityAfterBurst() throws {
        let fixture = try makeFixture()
        let monitor = QueueActivityMonitor(queueURL: fixture.queueURL, settleDelay: 0.05)
        let settled = expectation(description: "queue append settled")
        var settledCount = 0
        monitor.onSettledActivity = {
            settledCount += 1
            settled.fulfill()
        }
        defer {
            monitor.stop()
            try? FileManager.default.removeItem(at: fixture.directoryURL)
        }
        monitor.start()

        let handle = try FileHandle(forWritingTo: fixture.queueURL)
        try handle.seekToEnd()
        try handle.write(contentsOf: Data("one\n".utf8))
        try handle.write(contentsOf: Data("two\n".utf8))
        try handle.close()

        wait(for: [settled], timeout: 3)
        RunLoop.main.run(until: Date().addingTimeInterval(0.15))
        XCTAssertEqual(settledCount, 1)
    }

    func testAtomicReplacementPublishesSettledActivityAndRearmsWatcher() throws {
        let fixture = try makeFixture()
        let monitor = QueueActivityMonitor(queueURL: fixture.queueURL, settleDelay: 0.05)
        let replacements = expectation(description: "queue replacements settled")
        replacements.expectedFulfillmentCount = 2
        monitor.onSettledActivity = { replacements.fulfill() }
        defer {
            monitor.stop()
            try? FileManager.default.removeItem(at: fixture.directoryURL)
        }
        monitor.start()

        try replaceQueue(in: fixture, contents: "replacement-one\n")
        RunLoop.main.run(until: Date().addingTimeInterval(0.15))
        try replaceQueue(in: fixture, contents: "replacement-two\n")

        wait(for: [replacements], timeout: 3)
    }

    func testFileCreatedAfterStartPublishesWhenWatcherArms() throws {
        let directoryURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("QueueActivityMonitorTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)
        let queueURL = directoryURL.appendingPathComponent("queue.state.json")
        let monitor = QueueActivityMonitor(
            queueURL: queueURL,
            settleDelay: 0.02,
            retryDelay: 60
        )
        let settled = expectation(description: "new state file published")
        monitor.onSettledActivity = { settled.fulfill() }
        defer {
            monitor.stop()
            try? FileManager.default.removeItem(at: directoryURL)
        }

        monitor.start()
        try Data("{}\n".utf8).write(to: queueURL)

        wait(for: [settled], timeout: 2)
    }

    func testExistingFilePublishesWhenInitialStateIsRequested() throws {
        let fixture = try makeFixture()
        let monitor = QueueActivityMonitor(
            queueURL: fixture.queueURL,
            settleDelay: 0.02,
            publishInitialState: true
        )
        let settled = expectation(description: "existing state published")
        monitor.onSettledActivity = { settled.fulfill() }
        defer {
            monitor.stop()
            try? FileManager.default.removeItem(at: fixture.directoryURL)
        }

        monitor.start()

        wait(for: [settled], timeout: 2)
    }

    private func makeFixture() throws -> (directoryURL: URL, queueURL: URL) {
        let directoryURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("QueueActivityMonitorTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)
        let queueURL = directoryURL.appendingPathComponent("queue.jsonl")
        try Data("initial\n".utf8).write(to: queueURL)
        return (directoryURL, queueURL)
    }

    private func replaceQueue(
        in fixture: (directoryURL: URL, queueURL: URL),
        contents: String
    ) throws {
        let replacementURL = fixture.directoryURL.appendingPathComponent(UUID().uuidString)
        try Data(contents.utf8).write(to: replacementURL)
        _ = try FileManager.default.replaceItemAt(fixture.queueURL, withItemAt: replacementURL)
    }
}
