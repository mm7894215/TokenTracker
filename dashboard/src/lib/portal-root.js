// Returns the app's `#root` element for portaling overlays into — or `undefined`
// (SSR / not found), which leaves the portal at its library default.
//
// Portal overlays into `#root`, NOT `document.body`: under the Windows tray
// app's transparent WebView2 composition surface, overlays portaled directly
// under `<body>` (outside `#root`) mount and composite in the renderer but are
// NOT presented on-screen — the popup looks like it never opened. Staying inside
// `#root` paints correctly there while still escaping ancestor `overflow`
// clipping. macOS WKWebView / browsers are unaffected either way.
//
// Same rationale that makes the modals render inline (see
// TrendMonitorZoomModal.jsx) and the screenshot root prefer `#root`
// (DashboardPage.jsx). See memory: windows-webview2-body-portal-gotcha.
export function getPortalRoot() {
  if (typeof document === "undefined") return undefined;
  return document.getElementById("root") || undefined;
}
