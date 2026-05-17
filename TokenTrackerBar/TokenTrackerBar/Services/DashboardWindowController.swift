import AppKit
import SwiftUI
import WebKit

@MainActor
final class DashboardWindowController: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {

    /// 与 `dashboard` 里 `AppLayout` 主内容区 `lg:pr-3 lg:pb-3`（12pt）一致，用于主卡圆角与窗口圆角同心近似。
    private enum DashboardChromeMetrics {
        /// 系统未公开窗口外圆角；取 28pt 使「28 − 12pt 留白 = 16px」与原先 `rounded-2xl` 一致（同心圆角近似）。
        static let approxWindowOuterCornerRadius: CGFloat = 28
        static let mainGutterPoints: CGFloat = 12
        static var mainCardCornerRadiusPixels: Int {
            Int(max(8, approxWindowOuterCornerRadius - mainGutterPoints))
        }
    }

    static let shared = DashboardWindowController()

    /// 供 `NSAlert` 等以 sheet 附着，避免 `runModal` 浮层被仪表盘或其它窗口压在下面。
    var windowForSheet: NSWindow? { window }

    private var window: NSWindow?
    /// `theme === "system"` 时为 true：窗口 `appearance` 置 nil，随系统切换；否则固定亮/暗。
    private var chromeFollowsSystem = false
    private var effectiveAppearanceObservation: NSKeyValueObservation?
    private var webView: WKWebView?
    private var loadingOverlay: NSView?
    private var loadingHostingController: NSHostingController<AnyView>?
    /// 加载失败重试计数
    private var retryCount = 0
    private let maxRetries = 5

    /// Shared process pool — ensures cookies are consistent across webView recreations
    private static let sharedProcessPool = WKProcessPool()

    private override init() {
        super.init()
    }

    // MARK: - Public

    func showWindow() {
        // 关闭 menu bar popover
        for window in NSApp.windows where window.className.contains("Popover") {
            window.close()
        }

        // Reuse existing window if possible
        if let window {
            NSApp.setActivationPolicy(.regular)
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            syncChromeAppearanceFromWebView()
            injectMainCardCornerRadius()
            return
        }

        // Create WKWebView with persistent data store and shared process pool
        let contentController = WKUserContentController()
        contentController.add(self, name: "nativeOAuth")
        contentController.add(self, name: "nativeBridge")
        // Earliest paint: transparent root so NSVisualEffectView is visible (index.html also sets native-app via nativeBridge).
        let transparencyBootstrap = """
        (function(){
          document.documentElement.classList.add('native-app');
          var s=document.createElement('style');
          s.textContent='html,html.dark{background:transparent!important}body{background:transparent!important}';
          (document.head||document.documentElement).appendChild(s);
        })();
        """
        let bootstrapScript = WKUserScript(
            source: transparencyBootstrap,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        contentController.addUserScript(bootstrapScript)
        let webConfig = WKWebViewConfiguration()
        webConfig.userContentController = contentController
        webConfig.processPool = Self.sharedProcessPool
        webConfig.websiteDataStore = WKWebsiteDataStore.default()
        let webView = WKWebView(frame: .zero, configuration: webConfig)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.setValue(false, forKey: "drawsBackground")
        self.webView = webView

        // Container: Liquid Glass (macOS 26+) or NSVisualEffectView under a transparent WKWebView (sidebar + chrome see through).
        let container = NSView()
        container.wantsLayer = true
        container.layer?.backgroundColor = NSColor.clear.cgColor

        let dashboardBackground = DashboardBackgroundView.makeFullWindowBackground()
        container.addSubview(dashboardBackground)

        webView.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(webView)

        NSLayoutConstraint.activate([
            dashboardBackground.topAnchor.constraint(equalTo: container.topAnchor),
            dashboardBackground.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            dashboardBackground.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            dashboardBackground.trailingAnchor.constraint(equalTo: container.trailingAnchor),
        ])

        // Titlebar drag area — transparent, sits above webView so window is draggable
        let dragBar = TitlebarDragView()
        dragBar.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(dragBar)

        // Loading overlay with spinner
        let overlay = makeLoadingOverlay()
        overlay.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(overlay)
        self.loadingOverlay = overlay

        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: container.topAnchor),
            webView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            dragBar.topAnchor.constraint(equalTo: container.topAnchor),
            dragBar.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            dragBar.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            // 必须与 dashboard `AppLayout` 顶部 `h-7`（28pt）拖拽条对齐；设过高会盖住 sidebar 顶部的 Sign in 按钮，mouseDown 被 performDrag 吃掉。
            dragBar.heightAnchor.constraint(equalToConstant: 28),
            overlay.topAnchor.constraint(equalTo: container.topAnchor),
            overlay.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            overlay.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            overlay.trailingAnchor.constraint(equalTo: container.trailingAnchor),
        ])

        // Create window
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1200, height: 1000),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.minSize = NSSize(width: 800, height: 600)
        window.title = "TokenTracker"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        let toolbar = NSToolbar(identifier: "DashboardToolbar")
        toolbar.showsBaselineSeparator = false
        window.toolbar = toolbar
        window.toolbarStyle = .unifiedCompact
        window.contentView = container
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("DashboardWindow")
        window.center()
        // Clear window so native glass / vibrancy + transparent WKWebView show material (not an opaque gray sheet).
        window.isOpaque = false
        window.backgroundColor = .clear
        self.window = window

        // Wire bridge so SettingsPage can read/write menu-bar prefs
        NativeBridge.shared.webView = webView

        // 始终注册 NSApp.effectiveAppearance 观察，前端模块级缓存即可一直保持最新，
        // 避免「light → system」切换时还要等异步 round-trip 才知道当前系统亮暗。
        registerEffectiveAppearanceObserverIfNeeded()

        // Load dashboard
        retryCount = 0
        if let url = URL(string: Constants.serverBaseURL + "?app=1") {
            webView.load(URLRequest(url: url))
        }

        // Switch to regular app (shows dock icon), then show window
        NSApp.setActivationPolicy(.regular)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func reload() {
        retryCount = 0
        webView?.reload()
    }

    /// Match dashboard light/dark so native glass / `NSVisualEffectView` + window chrome follow the web theme.
    /// - `theme`: `"system"` | `"light"` | `"dark"`（与 `localStorage` 中 `tokentracker-theme` 一致）。
    func applyChromeAppearance(theme: String, resolvedIsDark: Bool) {
        switch theme {
        case "system":
            chromeFollowsSystem = true
            window?.appearance = nil
        case "light":
            chromeFollowsSystem = false
            window?.appearance = NSAppearance(named: .aqua)
        case "dark":
            chromeFollowsSystem = false
            window?.appearance = NSAppearance(named: .darkAqua)
        default:
            chromeFollowsSystem = false
            window?.appearance = NSAppearance(named: resolvedIsDark ? .darkAqua : .aqua)
        }
        registerEffectiveAppearanceObserverIfNeeded()
        // 切到 system 时立即把当前系统外观推给前端（KVO 只在外观变化时触发，
        // 用户从 light/dark 切回 system 但系统外观未变 → KVO 不会响应）。
        if chromeFollowsSystem {
            DispatchQueue.main.async { [weak self] in
                self?.pushCurrentSystemAppearanceToWeb()
            }
        }
    }

    /// 把当前系统外观推给前端。无论 chromeFollowsSystem 状态如何都推送，
    /// 让前端模块级缓存（`getCachedNativeSystemDark`）始终保持最新。
    func pushCurrentSystemAppearanceToWeb() {
        let isDark = NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        pushSystemAppearanceToWeb(isDark: isDark)
    }

    /// 始终注册一次 KVO（不与 chromeFollowsSystem 绑定）：
    /// - 用户在手动 light/dark 时改变系统外观，前端缓存仍然能更新；
    /// - 切回 system 时前端立即拥有正确的系统外观值，无需等异步 round-trip。
    private func registerEffectiveAppearanceObserverIfNeeded() {
        guard effectiveAppearanceObservation == nil else { return }
        // `NSApp.effectiveAppearance` 在 NSApp.appearance 为 nil 时跟随系统；
        // AppKit 文档建议对它做 KVO 监听亮暗变化。
        effectiveAppearanceObservation = NSApp.observe(\.effectiveAppearance, options: [.new]) { [weak self] _, _ in
            DispatchQueue.main.async {
                self?.pushCurrentSystemAppearanceToWeb()
            }
        }
    }

    private func pushSystemAppearanceToWeb(isDark: Bool) {
        let js = """
        (function(){
          var d = \(isDark ? "true" : "false");
          if (d) { document.documentElement.classList.add('dark'); } else { document.documentElement.classList.remove('dark'); }
          window.dispatchEvent(new CustomEvent('native:systemAppearanceChanged', { detail: { isDark: d } }));
        })();
        """
        webView?.evaluateJavaScript(js, completionHandler: nil)
    }

    private func syncChromeAppearanceFromWebView() {
        let js = """
        (function(){
          try {
            var t = localStorage.getItem('tokentracker-theme') || 'system';
            var d = document.documentElement.classList.contains('dark');
            return JSON.stringify({ theme: t, isDark: d });
          } catch (e) {
            return JSON.stringify({ theme: 'system', isDark: false });
          }
        })()
        """
        webView?.evaluateJavaScript(js) { [weak self] result, _ in
            guard let self,
                  let json = result as? String,
                  let data = json.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let theme = obj["theme"] as? String,
                  let isDark = obj["isDark"] as? Bool else { return }
            applyChromeAppearance(theme: theme, resolvedIsDark: isDark)
        }
    }

    /// 主内容白卡圆角：与窗口可视圆角同心近似（外圆角 − 与窗口边的留白），写入 `--tt-main-card-radius`。
    private func injectMainCardCornerRadius() {
        let px = DashboardChromeMetrics.mainCardCornerRadiusPixels
        let js = "document.documentElement.style.setProperty('--tt-main-card-radius', '\(px)px');"
        webView?.evaluateJavaScript(js, completionHandler: nil)
    }

    // MARK: - Loading Overlay

    private func makeLoadingOverlay() -> NSView {
        let overlay = NSView()
        overlay.wantsLayer = true
        overlay.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor

        // 基底约 60×64pt，1.2× 放大 ≈ 72×76.8
        let hosting = NSHostingController(
            rootView: AnyView(
                ClawdCompanionView.LoadingMascotView()
                    .scaleEffect(1.2)
                    .frame(width: 72, height: 76.8)
            )
        )
        self.loadingHostingController = hosting
        hosting.view.translatesAutoresizingMaskIntoConstraints = false
        hosting.view.wantsLayer = true
        hosting.view.layer?.contentsScale = NSScreen.main?.backingScaleFactor ?? 2.0
        overlay.addSubview(hosting.view)

        let label = NSTextField(labelWithString: "Loading Dashboard…")
        label.font = .systemFont(ofSize: 13)
        label.textColor = .secondaryLabelColor
        label.translatesAutoresizingMaskIntoConstraints = false
        overlay.addSubview(label)

        NSLayoutConstraint.activate([
            hosting.view.centerXAnchor.constraint(equalTo: overlay.centerXAnchor),
            hosting.view.centerYAnchor.constraint(equalTo: overlay.centerYAnchor, constant: -12),
            hosting.view.widthAnchor.constraint(equalToConstant: 72),
            hosting.view.heightAnchor.constraint(equalToConstant: 76.8),
            label.centerXAnchor.constraint(equalTo: overlay.centerXAnchor),
            label.topAnchor.constraint(equalTo: hosting.view.bottomAnchor, constant: 8),
        ])
        return overlay
    }

    private func dismissLoadingOverlay() {
        guard let overlay = loadingOverlay else { return }
        // Keep drawsBackground false so native glass / vibrancy shows through non-painted areas (sidebar + window chrome).
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.3
            overlay.animator().alphaValue = 0
        } completionHandler: { [weak self] in
            overlay.removeFromSuperview()
            self?.loadingOverlay = nil
            self?.loadingHostingController = nil
        }
    }

    func closeWindow() {
        window?.close()
    }

    // MARK: - NSWindowDelegate

    func windowWillClose(_ notification: Notification) {
        // Keep webView and window alive so cookies/login state persist.
        DispatchQueue.main.async { [weak self] in
            let closingWindow = self?.window
            let hasOtherVisibleWindows = NSApp.windows.contains {
                $0.isVisible
                && !$0.isKind(of: NSPanel.self)
                && $0 != closingWindow
            }
            if !hasOtherVisibleWindows {
                NSApp.setActivationPolicy(.accessory)
                NSApp.hide(nil)
            }
        }
    }

    // MARK: - WKScriptMessageHandler

    nonisolated func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        let name = message.name
        let body = message.body
        Task { @MainActor [weak self] in
            self?.handleScriptMessage(name: name, body: body)
        }
    }

    private func handleScriptMessage(name: String, body: Any) {
        if name == "nativeBridge" {
            NativeBridge.shared.handle(message: body)
            return
        }
        guard name == "nativeOAuth",
              let urlString = body as? String,
              let url = URL(string: urlString) else { return }
        // Open OAuth in system browser where user has saved Google/GitHub sessions
        NSWorkspace.shared.open(url)
    }

    /// Open the dashboard and navigate directly to the Settings page.
    func showSettings() {
        showWindow()
        if let url = URL(string: Constants.serverBaseURL + "/settings?app=1") {
            webView?.load(URLRequest(url: url))
        }
    }

    /// Called when `tokentracker://auth/done` deep link is received after browser login.
    func handleAuthDone() {
        showWindow()
        // Reload dashboard so InsForge SDK picks up session from server-side cookie relay
        if let url = URL(string: Constants.serverBaseURL + "?app=1") {
            webView?.load(URLRequest(url: url))
        }
    }

    /// Called when browser relays OAuth code back via `tokentracker://auth/callback?insforge_code=xxx`.
    /// Loads the callback page in the WebView so the SDK can exchange the code using the
    /// PKCE verifier that's already in WebView's sessionStorage.
    func handleAuthCallback(code: String) {
        showWindow()
        let encoded = code.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? code
        let callbackUrl = Constants.serverBaseURL + "/auth/callback?insforge_code=\(encoded)"
        if let url = URL(string: callbackUrl) {
            webView?.load(URLRequest(url: url))
        }
    }

    // MARK: - WKUIDelegate

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    // MARK: - WKNavigationDelegate

    private func isLocalDashboardURL(_ url: URL) -> Bool {
        url.host == "localhost" || url.host == "127.0.0.1"
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        // Allow local dashboard navigation
        if isLocalDashboardURL(url) {
            decisionHandler(.allow)
            return
        }

        let isMainFrameNavigation = navigationAction.targetFrame?.isMainFrame ?? true
        // Only promote top-level user clicks to the system browser. Subframe
        // clicks (e.g. the Cloud IP Check iframe) should stay inside the
        // iframe so embedded tools can navigate normally.
        if (url.scheme == "http" || url.scheme == "https"),
           navigationAction.navigationType == .linkActivated,
           isMainFrameNavigation {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        retryCount = 0
        // 禁用文本选中 + 为透明标题栏留出顶部间距
        let css = """
            * { -webkit-user-select: none !important; } \
            input, textarea { -webkit-user-select: text !important; } \
            .native-app header { padding-top: 36px !important; } \
            ::-webkit-scrollbar { display: none !important; }
            """
        let escapedCSS = css
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
            .replacingOccurrences(of: "\n", with: " ")
        let js = "document.documentElement.classList.add('native-app');var s=document.createElement('style');s.textContent='\(escapedCSS)';document.head.appendChild(s);"
        webView.evaluateJavaScript(js)

        // Wait for next animation frame so the page has actually painted before dismissing overlay
        let waitForPaint = "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))).then(() => 'ready')"
        webView.evaluateJavaScript(waitForPaint) { [weak self] _, _ in
            DispatchQueue.main.async {
                self?.syncChromeAppearanceFromWebView()
                // 页面就绪后立即把当前系统外观推到模块级缓存，确保后续切到 system 时
                // 前端无需等异步 round-trip 即可读取正确值。
                self?.pushCurrentSystemAppearanceToWeb()
                self?.injectMainCardCornerRadius()
                self?.dismissLoadingOverlay()
            }
        }
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        retryCount += 1
        guard retryCount <= maxRetries else { return }
        let delay = min(Double(retryCount) * 2, 10)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, let url = URL(string: Constants.serverBaseURL + "?app=1") else { return }
            self.webView?.load(URLRequest(url: url))
        }
    }
}

// MARK: - Titlebar Drag View

/// Transparent view overlaying the titlebar area to enable window dragging
/// while WKWebView is fullSizeContentView.
private final class TitlebarDragView: NSView {
    override var mouseDownCanMoveWindow: Bool { true }

    override func mouseDown(with event: NSEvent) {
        window?.performDrag(with: event)
    }
}
