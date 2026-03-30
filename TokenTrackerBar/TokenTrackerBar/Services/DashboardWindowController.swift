import AppKit
import WebKit

@MainActor
final class DashboardWindowController: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {

    static let shared = DashboardWindowController()

    private var window: NSWindow?
    private var webView: WKWebView?
    private var loadingOverlay: NSView?
    /// OAuth 流程进行中时放行所有导航，回到 localhost 后自动复位
    private var oauthInProgress = false
    /// OAuth 超时保护（30s）
    private var oauthTimeoutTask: DispatchWorkItem?
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
            return
        }

        // Create WKWebView with persistent data store and shared process pool
        let contentController = WKUserContentController()
        contentController.add(self, name: "nativeOAuth")
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

        // Container view holds webView + drag bar + loading overlay
        let container = NSView()
        container.wantsLayer = true
        webView.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(webView)

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
            dragBar.heightAnchor.constraint(equalToConstant: 56),
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
        // Match system appearance for loading background
        window.backgroundColor = NSColor.windowBackgroundColor
        self.window = window

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

    // MARK: - Loading Overlay

    private func makeLoadingOverlay() -> NSView {
        let overlay = NSView()
        overlay.wantsLayer = true
        overlay.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor

        let spinner = NSProgressIndicator()
        spinner.style = .spinning
        spinner.controlSize = .regular
        spinner.translatesAutoresizingMaskIntoConstraints = false
        spinner.startAnimation(nil)
        overlay.addSubview(spinner)

        let label = NSTextField(labelWithString: "Loading Dashboard…")
        label.font = .systemFont(ofSize: 13)
        label.textColor = .secondaryLabelColor
        label.translatesAutoresizingMaskIntoConstraints = false
        overlay.addSubview(label)

        NSLayoutConstraint.activate([
            spinner.centerXAnchor.constraint(equalTo: overlay.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: overlay.centerYAnchor, constant: -12),
            label.centerXAnchor.constraint(equalTo: overlay.centerXAnchor),
            label.topAnchor.constraint(equalTo: spinner.bottomAnchor, constant: 12),
        ])
        return overlay
    }

    private func dismissLoadingOverlay() {
        guard let overlay = loadingOverlay else { return }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.3
            overlay.animator().alphaValue = 0
        } completionHandler: { [weak self] in
            overlay.removeFromSuperview()
            self?.loadingOverlay = nil
            self?.webView?.setValue(true, forKey: "drawsBackground")
        }
    }

    // MARK: - NSWindowDelegate

    func windowWillClose(_ notification: Notification) {
        // Keep webView and window alive so cookies/login state persist.
        // Only reset transient OAuth state.
        cancelOAuthTimeout()
        oauthInProgress = false
        DispatchQueue.main.async {
            let hasVisibleWindows = NSApp.windows.contains { $0.isVisible && !$0.isKind(of: NSPanel.self) }
            if !hasVisibleWindows {
                NSApp.setActivationPolicy(.accessory)
            }
        }
    }

    // MARK: - OAuth Timeout

    private func startOAuthTimeout() {
        cancelOAuthTimeout()
        let task = DispatchWorkItem { [weak self] in
            guard let self, self.oauthInProgress else { return }
            self.oauthInProgress = false
        }
        oauthTimeoutTask = task
        DispatchQueue.main.asyncAfter(deadline: .now() + 30, execute: task)
    }

    private func cancelOAuthTimeout() {
        oauthTimeoutTask?.cancel()
        oauthTimeoutTask = nil
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
        guard name == "nativeOAuth",
              let urlString = body as? String,
              let url = URL(string: urlString) else { return }
        oauthInProgress = true
        startOAuthTimeout()
        webView?.load(URLRequest(url: url))
    }

    // MARK: - WKUIDelegate

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url {
            if oauthInProgress {
                // OAuth 流程中 target="_blank" 仍在当前 WebView 加载
                webView.load(URLRequest(url: url))
            } else {
                NSWorkspace.shared.open(url)
            }
        }
        return nil
    }

    // MARK: - WKNavigationDelegate

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        // Allow local dashboard navigation; OAuth 完成回到 localhost 时复位标记
        if url.host == "localhost" || url.host == "127.0.0.1" {
            if oauthInProgress {
                oauthInProgress = false
                cancelOAuthTimeout()
            }
            decisionHandler(.allow)
            return
        }
        // OAuth 流程进行中 — 放行 OAuth 提供商的重定向链
        if oauthInProgress {
            decisionHandler(.allow)
            return
        }
        // External links → open in system browser
        if url.scheme == "http" || url.scheme == "https" {
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
        dismissLoadingOverlay()
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
