mod paths;
mod server;
mod tray;

use std::sync::Mutex;

use once_cell::sync::Lazy;
use server::TokenTrackerServer;
use tauri::{Manager, WindowEvent};

static SERVER: Lazy<Mutex<Option<TokenTrackerServer>>> = Lazy::new(|| Mutex::new(None));

fn stop_server() {
    if let Ok(mut guard) = SERVER.lock() {
        if let Some(mut server) = guard.take() {
            server.stop();
        }
    }
}

/// WebKitGTK on some Linux setups cannot make HTTPS requests (TLS handshake
/// failure).  This initialization script intercepts all `fetch()` calls and
/// rewrites external HTTPS URLs to go through the local Node server's proxy
/// endpoint (`/api/native-https-proxy`), which has no TLS issues.
///
/// Using `initialization_script` (not `eval`) ensures the shim persists across
/// navigations — `window.navigate()` creates a new JS context, so an `eval`-
/// injected override would be lost.
const HTTPS_PROXY_SHIM: &str = r#"
(function() {
  var _origFetch = window.fetch;
  window.fetch = function() {
    var input = arguments[0];
    var url = (typeof input === 'string') ? input : (input?.url || String(input));
    if (url.indexOf('https://') === 0) {
      var proxied = '/api/native-https-proxy?url=' + encodeURIComponent(url);
      if (typeof input === 'string') {
        arguments[0] = proxied;
      } else if (input instanceof Request) {
        arguments[0] = new Request(proxied, input);
      }
    }
    return _origFetch.apply(this, arguments);
  };
})();
"#;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            tray::show_main_window(app);
        }))
        .setup(|app| {
            tray::install(app)?;

            let runtime_paths = paths::resolve_runtime_paths()?;
            let server = TokenTrackerServer::start(runtime_paths)?;
            let dashboard_url = server.url().to_string();

            if let Ok(mut guard) = SERVER.lock() {
                *guard = Some(server);
            }

            // Create the window programmatically so we can attach the HTTPS
            // proxy initialization script.  The script runs before any page JS
            // on every navigation (including the navigate() below).
            let _window = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("TokenTracker")
            .inner_size(1180.0, 820.0)
            .min_inner_size(960.0, 640.0)
            .initialization_script(HTTPS_PROXY_SHIM)
            .build()?;

            if let Some(window) = app.get_webview_window("main") {
                window.navigate(
                    dashboard_url
                        .parse::<tauri::Url>()
                        .map_err(|error| error.to_string())?,
                )?;
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build TokenTracker Linux client")
        .run(|_app, event| {
            if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
                stop_server();
            }
        });
}
