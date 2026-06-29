mod paths;
mod server;
mod tray;

use std::sync::Mutex;

use once_cell::sync::Lazy;
use server::TokenTrackerServer;
use tauri::{Manager, WindowEvent};

static SERVER: Lazy<Mutex<Option<TokenTrackerServer>>> = Lazy::new(|| Mutex::new(None));

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn stop_server() {
    if let Ok(mut guard) = SERVER.lock() {
        if let Some(mut server) = guard.take() {
            server.stop();
        }
    }
}

fn main() {
    // WebKitGTK on some Arch setups cannot find the system CA bundle for TLS.
    // Set the GIO TLS database path before any WebView is created so
    // libsoup/glib-networking picks up the correct certificates.
    if std::env::var("GIO_TLS_CA_FILE").is_err() {
        let ca = "/etc/ssl/certs/ca-certificates.crt";
        if std::path::Path::new(ca).exists() {
            std::env::set_var("GIO_TLS_CA_FILE", ca);
        }
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }))
        .setup(|app| {
            tray::install(app)?;

            let runtime_paths = paths::resolve_runtime_paths()?;
            let server = TokenTrackerServer::start(runtime_paths)?;
            let dashboard_url = server.url().to_string();

            if let Ok(mut guard) = SERVER.lock() {
                *guard = Some(server);
            }

            // WebKitGTK on some Linux setups cannot make HTTPS requests (TLS
            // handshake failure).  Intercept all fetch() calls and rewrite
            // external HTTPS URLs to go through the local Node server's proxy
            // endpoint, which has no TLS issues.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.eval(r#"
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
                "#);
            }

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
