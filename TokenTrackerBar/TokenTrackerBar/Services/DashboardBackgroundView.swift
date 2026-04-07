import AppKit

/// 仪表盘窗口底层：macOS 26+ 使用 Liquid Glass（`NSGlassEffectView`）；旧系统用 `NSVisualEffectView`。`NSGlassEffectView` 仅在 Tahoe 运行时存在，故用 `NSClassFromString` 创建，以便 Xcode 16 / 无 macOS 26 SDK 仍可编译。
@MainActor
enum DashboardBackgroundView {

    /// 铺满 contentView 的底层材质（透明 WKWebView 叠在上面）。
    static func makeFullWindowBackground() -> NSView {
        if #available(macOS 26, *) {
            if let glass = makeLiquidGlassBackgroundView() {
                return glass
            }
        }
        return makeClassicVisualEffectBackground()
    }

    // MARK: - macOS 13–25（及 26 上类不可用时）

    private static func makeClassicVisualEffectBackground() -> NSView {
        let visualEffectBackground = NSVisualEffectView()
        visualEffectBackground.translatesAutoresizingMaskIntoConstraints = false
        visualEffectBackground.material = .sidebar
        visualEffectBackground.blendingMode = .withinWindow
        visualEffectBackground.state = .active
        return visualEffectBackground
    }

    // MARK: - macOS 26+ Liquid Glass（运行时类查找，避免链接 26-only 符号）

    private static func makeLiquidGlassBackgroundView() -> NSView? {
        guard let glassClass = NSClassFromString("NSGlassEffectView") as? NSView.Type else {
            return nil
        }
        let glass = glassClass.init(frame: .zero)
        glass.translatesAutoresizingMaskIntoConstraints = false
        if glass.responds(to: NSSelectorFromString("setCornerRadius:")) {
            glass.setValue(NSNumber(value: 0.0), forKey: "cornerRadius")
        }

        let inner = NSView()
        inner.translatesAutoresizingMaskIntoConstraints = false
        inner.wantsLayer = true
        inner.layer?.backgroundColor = NSColor.clear.cgColor
        guard glass.responds(to: NSSelectorFromString("setContentView:")) else { return nil }
        glass.setValue(inner, forKey: "contentView")

        NSLayoutConstraint.activate([
            inner.leadingAnchor.constraint(equalTo: glass.leadingAnchor),
            inner.trailingAnchor.constraint(equalTo: glass.trailingAnchor),
            inner.topAnchor.constraint(equalTo: glass.topAnchor),
            inner.bottomAnchor.constraint(equalTo: glass.bottomAnchor),
        ])
        return glass
    }
}
