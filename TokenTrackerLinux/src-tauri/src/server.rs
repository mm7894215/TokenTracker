use std::ffi::OsString;
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::paths::RuntimePaths;

const READINESS_PATH: &str = "/functions/tokentracker-user-status";

/// How often the health monitor probes the server.
pub const HEALTH_CHECK_INTERVAL: Duration = Duration::from_secs(15);

/// How long to wait for a freshly spawned server to answer its readiness probe,
/// used for both the initial start and health-monitor restarts.
pub const READY_TIMEOUT: Duration = Duration::from_secs(20);

/// Consecutive failures before triggering a restart.
pub const FAILURE_THRESHOLD: u32 = 3;

/// Maximum consecutive restart attempts before the monitor backs off.
pub const MAX_RESTARTS: u32 = 3;

/// Back-off after exhausting `MAX_RESTARTS` before retrying.
pub const RESTART_BACKOFF: Duration = Duration::from_secs(300);

/// Match the five-minute native background refresh cadence on macOS and Windows.
pub const BACKGROUND_SYNC_INTERVAL: Duration = Duration::from_secs(300);

#[derive(Debug)]
struct BackgroundSync {
    cancelled: Arc<AtomicBool>,
    child: Arc<Mutex<Option<Child>>>,
    worker: Option<JoinHandle<()>>,
}

impl BackgroundSync {
    fn start(paths: RuntimePaths) -> Self {
        let cancelled = Arc::new(AtomicBool::new(false));
        let child = Arc::new(Mutex::new(None));
        let worker_cancelled = Arc::clone(&cancelled);
        let worker_child = Arc::clone(&child);
        let worker = thread::spawn(move || loop {
            if worker_cancelled.load(Ordering::Acquire) {
                break;
            }

            run_background_sync(&paths, &worker_child);

            let deadline = Instant::now() + BACKGROUND_SYNC_INTERVAL;
            while Instant::now() < deadline {
                if worker_cancelled.load(Ordering::Acquire) {
                    return;
                }
                thread::sleep(Duration::from_millis(250));
            }
        });

        Self {
            cancelled,
            child,
            worker: Some(worker),
        }
    }

    fn stop(&mut self) {
        self.cancelled.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        if let Ok(mut child) = self.child.lock() {
            stop_child(child.as_mut());
            *child = None;
        }
    }
}

#[derive(Debug)]
pub struct TokenTrackerServer {
    child: Child,
    url: String,
    port: u16,
    paths: RuntimePaths,
    background_sync: BackgroundSync,
}

impl TokenTrackerServer {
    pub fn start(paths: RuntimePaths) -> Result<Self, String> {
        let port = pick_available_port()?;
        let url = dashboard_url(port);

        let args = serve_args(&paths.tracker, port);
        let mut child = Command::new(&paths.node)
            .args(&args)
            .stdout(Stdio::null())
            .stderr(server_log_stdio())
            .spawn()
            .map_err(|error| format!("failed to start TokenTracker server: {error}"))?;

        wait_for_server_ready(port, READY_TIMEOUT).inspect_err(|_| {
            let _ = child.kill();
            let _ = child.wait();
        })?;

        let background_sync = BackgroundSync::start(paths.clone());

        Ok(Self {
            child,
            url,
            port,
            paths,
            background_sync,
        })
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Returns `true` if the child process has not exited yet.
    ///
    /// Deliberately separate from the HTTP readiness probe: the health monitor
    /// calls this under the global server mutex but runs [`probe_server_http`]
    /// after releasing it, so a hung socket never blocks app shutdown.
    pub fn is_process_alive(&mut self) -> bool {
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

        let log_file = open_server_log().map(|mut file| {
            let _ = writeln!(file, "\n--- server restart ---");
            file
        });

        let args = serve_args(&self.paths.tracker, self.port);
        self.child = Command::new(&self.paths.node)
            .args(&args)
            .stdout(Stdio::null())
            .stderr(log_file.map_or_else(Stdio::null, Stdio::from))
            .spawn()
            .map_err(|error| format!("failed to restart server: {error}"))?;

        Ok(())
    }

    pub fn stop(&mut self) {
        self.background_sync.stop();
        stop_child(Some(&mut self.child));
    }
}

impl Drop for TokenTrackerServer {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Rotate the server log once it exceeds this size, keeping a single previous
/// generation. The log is append-only otherwise, so without this it grows
/// without bound for the lifetime of the install.
pub const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

/// Candidate log paths in preference order: `$XDG_STATE_HOME/tokentracker/`,
/// then `$HOME/.local/state/tokentracker/`, then `/tmp`.
pub fn server_log_paths(xdg_state_home: Option<PathBuf>, home: Option<PathBuf>) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(state_home) = xdg_state_home {
        paths.push(state_home.join("tokentracker").join("server.log"));
    }
    if let Some(home) = home {
        let path = home
            .join(".local")
            .join("state")
            .join("tokentracker")
            .join("server.log");
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
    paths.push(PathBuf::from("/tmp").join("tokentracker-server.log"));
    paths
}

/// Move an oversized log aside so the live file restarts empty.
///
/// Returns `true` when rotation happened. Keeping one `.1` generation bounds
/// total on-disk usage at roughly `2 * max_bytes`. If the rename fails (for
/// example a read-only directory) the live file is truncated instead, so size
/// stays bounded either way.
pub fn rotate_log_if_oversized(path: &Path, max_bytes: u64) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if metadata.len() <= max_bytes {
        return false;
    }

    let rotated = path.with_extension("log.1");
    if std::fs::rename(path, &rotated).is_ok() {
        return true;
    }

    OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(path)
        .is_ok()
}

/// Open (or create) a log file for the Node server's stderr output.
///
/// Returns `None` when no candidate path is writable; callers fall back to
/// discarding output rather than aborting the app, because losing diagnostics
/// is not a reason to refuse to start.
fn open_server_log() -> Option<std::fs::File> {
    let xdg_state_home = std::env::var_os("XDG_STATE_HOME").map(PathBuf::from);
    let home = std::env::var_os("HOME").map(PathBuf::from);

    for path in server_log_paths(xdg_state_home, home) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        rotate_log_if_oversized(&path, MAX_LOG_BYTES);
        if let Ok(file) = OpenOptions::new().create(true).append(true).open(&path) {
            return Some(file);
        }
    }

    None
}

/// Stderr sink for spawned Node processes, degrading to `/dev/null` when no log
/// file can be opened.
fn server_log_stdio() -> Stdio {
    match open_server_log() {
        Some(file) => Stdio::from(file),
        None => Stdio::null(),
    }
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

pub fn sync_args(tracker: &Path) -> Vec<OsString> {
    vec![
        tracker.as_os_str().to_os_string(),
        OsString::from("sync"),
        OsString::from("--auto"),
        OsString::from("--background"),
        OsString::from("--all-local-sources"),
    ]
}

fn run_background_sync(paths: &RuntimePaths, child_slot: &Mutex<Option<Child>>) {
    let mut child = match child_slot.lock() {
        Ok(child) => child,
        Err(_) => return,
    };

    if let Some(current) = child.as_mut() {
        match current.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    eprintln!("[TokenTracker] background sync exited with {status}");
                }
                *child = None;
            }
            Ok(None) => return,
            Err(error) => {
                eprintln!("[TokenTracker] failed to inspect background sync: {error}");
                stop_child(Some(current));
                *child = None;
            }
        }
    }

    let args = sync_args(&paths.tracker);
    match Command::new(&paths.node)
        .args(args)
        .stdout(Stdio::null())
        .stderr(server_log_stdio())
        .spawn()
    {
        Ok(process) => *child = Some(process),
        Err(error) => eprintln!("[TokenTracker] failed to start background sync: {error}"),
    }
}

fn stop_child(child: Option<&mut Child>) {
    let Some(child) = child else {
        return;
    };
    match child.try_wait() {
        Ok(Some(_)) => {}
        Ok(None) | Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
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

/// Single-shot readiness probe. Public so the health monitor can run it
/// *outside* the global server mutex.
pub fn probe_server_http(port: u16) -> Result<(), String> {
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
