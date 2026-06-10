import AppKit

/// Floating native progress panel for interactive update downloads.
/// Shown only when the user explicitly confirms an update from the prompt —
/// silent auto-updates keep their menu-item statusText-only feedback.
/// Uses `orderFrontRegardless()` so it stays visible without activating the
/// app or touching the dashboard window.
@MainActor
final class UpdateProgressPanelController {

    private var panel: NSPanel?
    private let titleLabel = NSTextField(labelWithString: "")
    private let detailLabel = NSTextField(labelWithString: "")
    private let bar = NSProgressIndicator()

    func show(title: String) {
        titleLabel.stringValue = title
        detailLabel.stringValue = ""
        bar.isIndeterminate = false
        bar.doubleValue = 0
        if panel == nil {
            panel = makePanel()
        }
        panel?.center()
        panel?.orderFrontRegardless()
    }

    func setProgress(percent: Double, detail: String) {
        if bar.isIndeterminate {
            bar.stopAnimation(nil)
            bar.isIndeterminate = false
        }
        bar.doubleValue = min(max(percent, 0), 100)
        detailLabel.stringValue = detail
    }

    func setIndeterminate(detail: String) {
        if !bar.isIndeterminate {
            bar.isIndeterminate = true
            bar.startAnimation(nil)
        }
        detailLabel.stringValue = detail
    }

    func close() {
        bar.stopAnimation(nil)
        panel?.orderOut(nil)
        panel = nil
    }

    // MARK: - Layout

    private func makePanel() -> NSPanel {
        let icon = NSImageView()
        icon.image = NSApp.applicationIconImage
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.widthAnchor.constraint(equalToConstant: 48).isActive = true
        icon.heightAnchor.constraint(equalToConstant: 48).isActive = true

        titleLabel.font = .boldSystemFont(ofSize: 13)
        titleLabel.lineBreakMode = .byTruncatingTail
        detailLabel.font = .systemFont(ofSize: 11)
        detailLabel.textColor = .secondaryLabelColor
        detailLabel.lineBreakMode = .byTruncatingTail

        bar.style = .bar
        bar.minValue = 0
        bar.maxValue = 100
        bar.isIndeterminate = false
        bar.translatesAutoresizingMaskIntoConstraints = false
        bar.widthAnchor.constraint(equalToConstant: 300).isActive = true

        // Progress text changes every tick — cap label width so the window never resizes.
        for label in [titleLabel, detailLabel] {
            label.translatesAutoresizingMaskIntoConstraints = false
            label.widthAnchor.constraint(lessThanOrEqualToConstant: 300).isActive = true
            label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        }

        let textStack = NSStackView(views: [titleLabel, bar, detailLabel])
        textStack.orientation = .vertical
        textStack.alignment = .leading
        textStack.spacing = 6

        let root = NSStackView(views: [icon, textStack])
        root.orientation = .horizontal
        root.alignment = .centerY
        root.spacing = 12
        root.edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)

        // No .fullSizeContentView — content would extend under the titlebar and
        // the title label becomes illegible behind the titlebar material.
        // .closable lets the user dismiss the panel; the download keeps running
        // and stays visible via the menu-item status text.
        let panel = NSPanel(
            contentRect: .zero,
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        panel.title = Strings.appTitle
        panel.isReleasedWhenClosed = false
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.isMovableByWindowBackground = true
        panel.contentView = root
        panel.setContentSize(root.fittingSize)
        return panel
    }
}
