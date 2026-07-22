use std::ffi::OsString;
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use crate::paths::RuntimePaths;

const READINESS_PATH: &str = "/functions/tokentracker-user-status";

/// How often the health monitor probes the server.
pub const HEALTH_CHECK_INTERVAL: Duration = Duration::from_secs(15);

/// Consecutive failures before triggering a restart.
pub const FAILURE_THRESHOLD: u32 = 3;

/// Maximum consecutive restart attempts before the monitor backs off.
pub const MAX_RESTARTS: u32 = 3;

/// Back-off after exhausting `MAX_RESTARTS` before retrying.
pub const RESTART_BACKOFF: Duration = Duration::from_secs(300);

#[derive(Debug)]
pub struct TokenTrackerServer {
    child: Child,
    url: String,
    port: u16,
    paths: RuntimePaths,
}

impl TokenTrackerServer {
    pub fn start(paths: RuntimePaths) -> Result<Self, String> {
        let port = pick_available_port()?;
        let url = dashboard_url(port);

        let log_file = open_server_log();
        let args = serve_args(&paths.tracker, port);
        let mut child = Command::new(&paths.node)
            .args(&args)
            .stdout(Stdio::null())
            .stderr(Stdio::from(log_file))
            .spawn()
            .map_err(|error| format!("failed to start TokenTracker server: {error}"))?;

        wait_for_server_ready(port, Duration::from_secs(20)).map_err(|error| {
            let _ = child.kill();
            let _ = child.wait();
            error
        })?;

        Ok(Self {
            child,
            url,
            port,
            paths,
        })
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Returns `true` if the child process is still alive AND the HTTP
    /// endpoint responds to a readiness probe.
    pub fn check_health(&mut self) -> bool {
        if !self.is_process_alive() {
            return false;
        }
        probe_server_http(self.port).is_ok()
    }

    /// Returns `true` if the child process has not exited yet.
    fn is_process_alive(&mut self) -> bool {
        match self.child.try_wait() {
            Ok(Some(_)) => false,
            Ok(None) => true,
            Err(_) => false,
        }
    }

    /// Kill the current server process and start a new one on the same port.
    ///
    /// Returns after spawning the replacement process. Readiness polling is
    /// handled by the health monitor after it releases the global server mutex,
    /// so app shutdown never waits for the full readiness timeout.
    pub fn restart_process(&mut self) -> Result<(), String> {
        let _ = self.child.kill();
        let _ = self.child.wait();

        // Brief pause for the OS to release the port.
        thread::sleep(Duration::from_millis(500));

        let mut log_file = open_server_log();
        let _ = writeln!(log_file, "\n--- server restart ---");

        let args = serve_args(&self.paths.tracker, self.port);
        self.child = Command::new(&self.paths.node)
            .args(&args)
            .stdout(Stdio::null())
            .stderr(Stdio::from(log_file))
            .spawn()
            .map_err(|error| format!("failed to restart server: {error}"))?;

        Ok(())
    }

    pub fn stop(&mut self) {
        match self.child.try_wait() {
            Ok(Some(_status)) => {}
            Ok(None) => {
                let _ = self.child.kill();
                let _ = self.child.wait();
            }
            Err(_error) => {
                let _ = self.child.kill();
                let _ = self.child.wait();
            }
        }
    }
}

impl Drop for TokenTrackerServer {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Open (or create) a log file for the Node server's stderr output.
///
/// Prefers `$XDG_STATE_HOME/tokentracker/server.log`; falls back to
/// `$HOME/.local/state/tokentracker/server.log`; ultimate fallback `/tmp`.
fn open_server_log() -> std::fs::File {
    let log_dir = std::env::var("XDG_STATE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
            PathBuf::from(home).join(".local").join("state")
        })
        .join("tokentracker");
    let _ = std::fs::create_dir_all(&log_dir);
    let log_path = log_dir.join("server.log");
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .or_else(|_| {
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(PathBuf::from("/tmp").join("tokentracker-server.log"))
        })
        .expect("cannot open any server log file")
}

pub fn dashboard_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// OAuth (Google/GitHub) redirects to `http://127.0.0.1:<port>/auth/callback`,
/// which must be in InsForge's allowed-redirect-URL list.  Prefer a fixed port
/// registered alongside the macOS (:7680) and Windows (:17680) apps.  Falls
/// back to an OS-assigned free port if the preferred one is already in use
/// (email login still works; OAuth needs the fixed port).
const PREFERRED_PORT: u16 = 17680;

pub fn pick_available_port() -> Result<u16, String> {
    if let Ok(listener) = TcpListener::bind(("127.0.0.1", PREFERRED_PORT)) {
        let port = listener
            .local_addr()
            .map_err(|error| format!("failed to read reserved local port: {error}"))?
            .port();
        drop(listener);
        return Ok(port);
    }

    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("failed to reserve local port: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("failed to read reserved local port: {error}"))?
        .port();
    drop(listener);
    Ok(port)
}

pub fn serve_args(tracker: &Path, port: u16) -> Vec<OsString> {
    vec![
        tracker.as_os_str().to_os_string(),
        OsString::from("serve"),
        OsString::from("--port"),
        OsString::from(port.to_string()),
        OsString::from("--no-open"),
        OsString::from("--no-sync"),
    ]
}

pub fn wait_for_server_ready(port: u16, timeout: Duration) -> Result<(), String> {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if probe_server_http(port).is_ok() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err(format!(
        "TokenTracker server did not become ready on port {port} within {timeout:?}"
    ))
}

fn probe_server_http(port: u16) -> Result<(), String> {
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .map_err(|error| format!("connect failed: {error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(1)))
        .map_err(|error| format!("failed to set read timeout: {error}"))?;
    stream
        .set_write_timeout(Some(Duration::from_secs(1)))
        .map_err(|error| format!("failed to set write timeout: {error}"))?;

    let request = format!(
        "GET {READINESS_PATH} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("request failed: {error}"))?;
    let _ = stream.shutdown(Shutdown::Write);

    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|error| format!("read failed: {error}"))?;

    let status_line = response.lines().next().unwrap_or_default();
    if status_line.starts_with("HTTP/1.1 200") || status_line.starts_with("HTTP/1.0 200") {
        Ok(())
    } else {
        Err(format!(
            "unexpected readiness response: {}",
            if status_line.is_empty() {
                "<empty>"
            } else {
                status_line
            }
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dashboard_url_uses_loopback_http() {
        assert_eq!(dashboard_url(45678), "http://127.0.0.1:45678");
    }

    #[test]
    fn serve_args_disable_browser_and_startup_sync() {
        let args = serve_args(Path::new("/opt/tokentracker/bin/tracker.js"), 34567);
        assert_eq!(
            args,
            vec![
                OsString::from("/opt/tokentracker/bin/tracker.js"),
                OsString::from("serve"),
                OsString::from("--port"),
                OsString::from("34567"),
                OsString::from("--no-open"),
                OsString::from("--no-sync"),
            ],
        );
    }

    #[test]
    fn pick_available_port_returns_bindable_port() {
        let port = pick_available_port().expect("port should be available");
        assert!(port > 0);
        TcpListener::bind(("127.0.0.1", port))
            .expect("returned port should be bindable immediately");
    }

    #[test]
    fn probe_server_http_accepts_http_200() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("listener should bind");
        let port = listener.local_addr().expect("listener addr").port();

        let handle = thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("connection should be accepted");
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request);
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
                .expect("response should write");
        });

        probe_server_http(port).expect("200 response should be ready");
        handle.join().expect("server thread should join");
    }
}
