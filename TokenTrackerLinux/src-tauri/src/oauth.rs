use std::sync::Mutex;

use tauri::{AppHandle, Manager, Url};

#[derive(Default)]
pub struct PendingAuthCode(Mutex<Option<String>>);

#[derive(Default)]
pub struct DashboardBaseUrl(Mutex<Option<String>>);

impl DashboardBaseUrl {
    pub fn store(&self, url: String) {
        if let Ok(mut dashboard_url) = self.0.lock() {
            *dashboard_url = Some(url);
        }
    }

    fn get(&self) -> Option<String> {
        self.0.lock().ok()?.clone()
    }
}

impl PendingAuthCode {
    pub fn store(&self, code: String) {
        if let Ok(mut pending) = self.0.lock() {
            *pending = Some(code);
        }
    }

    pub fn take(&self) -> Option<String> {
        self.0.lock().ok()?.take()
    }
}

pub fn parse_auth_callback(raw: &str) -> Option<String> {
    let url = Url::parse(raw).ok()?;
    if url.scheme() != "tokentracker"
        || url.host_str() != Some("auth")
        || url.path() != "/callback"
        || url.fragment().is_some()
    {
        return None;
    }

    let mut codes = url
        .query_pairs()
        .filter(|(key, _)| key == "insforge_code")
        .map(|(_, value)| value.into_owned());
    let code = codes.next()?;
    if code.is_empty() || codes.next().is_some() {
        return None;
    }
    Some(code)
}

pub fn is_allowed_oauth_url(raw: &str) -> bool {
    Url::parse(raw)
        .map(|url| url.scheme() == "https" && url.host_str().is_some())
        .unwrap_or(false)
}

pub fn callback_url(base: &str, code: &str) -> Option<String> {
    let mut url = Url::parse(base).ok()?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }

    url.set_path("/auth/callback");
    url.query_pairs_mut()
        .append_pair("insforge_code", code)
        .append_pair("app", "1");
    Some(url.into())
}

pub fn handle_callback(app: &AppHandle, raw: &str) -> bool {
    let Some(code) = parse_auth_callback(raw) else {
        return false;
    };

    let pending = app.state::<PendingAuthCode>();
    pending.store(code);
    deliver_pending_callback(app)
}

pub fn deliver_pending_callback(app: &AppHandle) -> bool {
    let pending = app.state::<PendingAuthCode>();
    let Some(code) = pending.take() else {
        return false;
    };
    let Some(window) = app.get_webview_window("main") else {
        pending.store(code);
        return false;
    };
    let dashboard_url = app.state::<DashboardBaseUrl>();
    let Some(base) = dashboard_url.get() else {
        pending.store(code);
        return false;
    };
    let Some(url) = callback_url(&base, &code).and_then(|value| Url::parse(&value).ok()) else {
        pending.store(code);
        return false;
    };

    if window.navigate(url).is_err() {
        pending.store(code);
        return false;
    }
    let _ = window.show();
    let _ = window.set_focus();
    true
}

#[tauri::command]
pub fn open_oauth(url: String) -> Result<(), String> {
    if !is_allowed_oauth_url(&url) {
        return Err("OAuth URL must be an absolute HTTPS URL".to_string());
    }

    std::process::Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("failed to open the system browser: {error}"))
}
