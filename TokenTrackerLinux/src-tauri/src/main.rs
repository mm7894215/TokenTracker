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

            if let Some(window) = app.get_webview_window("main") {
                window.navigate(dashboard_url.parse::<tauri::Url>().map_err(|error| error.to_string())?)?;
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
