use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Manager};

const OPEN_ID: &str = "open-dashboard";
const QUIT_ID: &str = "quit";
const FALLBACK_TRAY_ICON: &[u8] = include_bytes!("../icons/icon.png");

fn fallback_tray_icon() -> tauri::Result<Image<'static>> {
    Image::from_bytes(FALLBACK_TRAY_ICON)
}

pub fn install(app: &App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, OPEN_ID, "Open Dashboard", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, QUIT_ID, "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;

    let icon = app
        .default_window_icon()
        .cloned()
        .unwrap_or(fallback_tray_icon()?);

    TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("TokenTracker")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            OPEN_ID => show_main_window(app),
            QUIT_ID => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::fallback_tray_icon;

    #[test]
    fn embedded_fallback_icon_has_non_zero_dimensions() {
        let icon = fallback_tray_icon().expect("embedded fallback icon must decode");

        assert!(icon.width() > 0);
        assert!(icon.height() > 0);
    }
}
